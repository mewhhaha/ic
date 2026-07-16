import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr } from "./ast.ts";
import {
  resolve_comptime_type,
  resolve_comptime_value,
} from "./comptime_value.ts";
import { call_message } from "./fields.ts";
import { lookup_field } from "./fields.ts";
import { fixed_array_length } from "./fixed_array_type.ts";
import { lower_text_builtin_call } from "./builtin_call/text.ts";
import { fresh } from "./env.ts";
import { numeric_builtin_call } from "./numeric.ts";
import { Callable } from "../trait.ts";
import { Prim } from "../op.ts";
import { expect } from "../expect.ts";
import { f32x4_builtin_call } from "./f32x4.ts";
import { structured_core_route } from "./diagnostic.ts";
import type { BuiltinCallHooks } from "./builtin_call/hooks.ts";

export type { BuiltinCallHooks } from "./builtin_call/hooks.ts";

export function lower_builtin_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: BuiltinCallHooks,
): IcNode | undefined {
  if (expr.func.tag !== "var") {
    return undefined;
  }

  const f32x4_call = f32x4_builtin_call(expr);

  if (f32x4_call && !hooks.lookup(env, expr.func.name)) {
    const expected = Callable.arity(Prim, f32x4_call.prim);

    if (f32x4_call.args.length !== expected) {
      throw new Error(
        expr.func.name + " expects " + expected + " arguments, got " +
          f32x4_call.args.length,
      );
    }

    return {
      tag: "prim",
      prim: f32x4_call.prim,
      args: f32x4_call.args.map((arg) => hooks.lower_expr(arg, env)),
    };
  }

  const numeric_call = numeric_builtin_call(expr);

  if (numeric_call && !hooks.lookup(env, expr.func.name)) {
    const expected = Callable.arity(Prim, numeric_call.prim);

    if (numeric_call.args.length !== expected) {
      throw new Error(
        expr.func.name + " expects " + expected + " arguments, got " +
          numeric_call.args.length,
      );
    }

    if (expected === 2) {
      const left = numeric_call.args[0];
      const right = numeric_call.args[1];
      expect(left, "Missing " + expr.func.name + " argument 0");
      expect(right, "Missing " + expr.func.name + " argument 1");
      return hooks.lower_expr(
        { tag: "prim", prim: numeric_call.prim, left, right },
        env,
      );
    }

    const arg = numeric_call.args[0];
    expect(arg, "Missing " + expr.func.name + " argument 0");
    return {
      tag: "prim",
      prim: numeric_call.prim,
      args: [hooks.lower_expr(arg, env)],
    };
  }

  if (expr.func.name === "fail") {
    throw new Error("fail: " + call_message(expr.args));
  }

  if (expr.func.name === "panic") {
    call_message(expr.args);
    return { tag: "prim", prim: "i32.trap", args: [] };
  }

  if (expr.func.name === "project") {
    if (expr.args.length !== 2) {
      throw new Error(
        "project expects a value and one compile-time field descriptor",
      );
    }

    const value = expr.args[0];
    const descriptor_expr = expr.args[1];
    if (!value || !descriptor_expr) {
      throw new Error("project is missing its value or field descriptor");
    }

    const descriptor = resolve_comptime_value(descriptor_expr, env, {
      resolve_const_expr_with_env: hooks.resolve_const_expr_with_env,
    });

    if (!descriptor || descriptor.tag !== "record") {
      throw new Error("project requires a compile-time field descriptor");
    }

    const kind_field = descriptor.fields.find((field) => {
      return field.name === "kind";
    });
    const descriptor_kind = kind_field?.value;

    const name_field = descriptor.fields.find((field) => {
      return field.name === "name";
    });
    const index_field = descriptor.fields.find((field) => {
      return field.name === "index";
    });

    if (
      descriptor_kind?.tag === "scalar" &&
      descriptor_kind.value.tag === "atom" &&
      descriptor_kind.value.name === "case"
    ) {
      if (
        !name_field || name_field.value.tag !== "scalar" ||
        name_field.value.value.tag !== "text" ||
        name_field.value.value.value.length === 0
      ) {
        throw new Error("case descriptor is missing its case name");
      }

      const case_name = name_field.value.value.value;
      const payload_name = fresh(env, "case_payload_" + case_name);
      const message: FrontExpr = {
        tag: "text",
        value: "project expected union case " + case_name,
      };
      return hooks.lower_expr(
        {
          tag: "if_let",
          case_name,
          value_name: payload_name,
          target: value,
          then_branch: { tag: "var", name: payload_name },
          else_branch: {
            tag: "app",
            func: { tag: "var", name: "panic" },
            arg: message,
            args: [message],
          },
        },
        env,
      );
    }

    if (
      name_field && name_field.value.tag === "scalar" &&
      name_field.value.value.tag === "text" &&
      name_field.value.value.value.length > 0
    ) {
      return hooks.lower_expr(
        {
          tag: "field",
          object: value,
          name: name_field.value.value.value,
        },
        env,
      );
    }

    if (
      !index_field || index_field.value.tag !== "scalar" ||
      index_field.value.value.tag !== "num" ||
      typeof index_field.value.value.value !== "number"
    ) {
      throw new Error("project descriptor is missing a numeric index");
    }

    return hooks.lower_expr(
      {
        tag: "index",
        object: value,
        index: {
          tag: "num",
          type: "i32",
          value: index_field.value.value.value,
        },
      },
      env,
    );
  }

  if (expr.func.name === "is_case") {
    if (expr.args.length !== 2) {
      throw new Error(
        "is_case expects a union value and one compile-time case descriptor",
      );
    }

    const value = expr.args[0];
    const descriptor_expr = expr.args[1];
    if (!value || !descriptor_expr) {
      throw new Error("is_case is missing its value or case descriptor");
    }

    const descriptor = resolve_comptime_value(descriptor_expr, env, {
      resolve_const_expr_with_env: hooks.resolve_const_expr_with_env,
    });

    if (!descriptor || descriptor.tag !== "record") {
      throw new Error("is_case requires a compile-time case descriptor");
    }

    const kind_field = descriptor.fields.find((field) => {
      return field.name === "kind";
    });
    const name_field = descriptor.fields.find((field) => {
      return field.name === "name";
    });

    if (
      !kind_field || kind_field.value.tag !== "scalar" ||
      kind_field.value.value.tag !== "atom" ||
      kind_field.value.value.name !== "case" || !name_field ||
      name_field.value.tag !== "scalar" ||
      name_field.value.value.tag !== "text" ||
      name_field.value.value.value.length === 0
    ) {
      throw new Error("is_case requires a compile-time case descriptor");
    }

    return hooks.lower_expr(
      {
        tag: "if_let",
        case_name: name_field.value.value.value,
        value_name: undefined,
        target: value,
        then_branch: { tag: "bool", value: true },
        else_branch: { tag: "bool", value: false },
      },
      env,
    );
  }

  if (expr.func.name === "construct") {
    if (expr.args.length !== 2) {
      throw new Error(
        "construct expects a compile-time type and one aggregate value",
      );
    }

    const type_expr = expr.args[0];
    const values = expr.args[1];
    if (!type_expr || !values) {
      throw new Error("construct is missing its type or aggregate value");
    }

    const descriptor = resolve_comptime_value(type_expr, env, {
      resolve_const_expr_with_env: hooks.resolve_const_expr_with_env,
    });

    if (descriptor?.tag === "record") {
      const kind_field = descriptor.fields.find((field) => {
        return field.name === "kind";
      });

      if (
        kind_field?.value.tag === "scalar" &&
        kind_field.value.value.tag === "atom" &&
        kind_field.value.value.name === "case"
      ) {
        const name_field = descriptor.fields.find((field) => {
          return field.name === "name";
        });
        const owner_field = descriptor.fields.find((field) => {
          return field.name === "owner";
        });

        if (
          !name_field || name_field.value.tag !== "scalar" ||
          name_field.value.value.tag !== "text" ||
          name_field.value.value.value.length === 0 || !owner_field ||
          owner_field.value.tag !== "type"
        ) {
          throw new Error("construct case descriptor is incomplete");
        }

        return hooks.lower_expr(
          {
            tag: "union_case",
            name: name_field.value.value.value,
            value: values,
            type_expr: owner_field.value.type.source,
          },
          env,
        );
      }
    }

    const type = resolve_comptime_type(type_expr, env, {
      resolve_const_expr_with_env: hooks.resolve_const_expr_with_env,
    });

    if (!type) {
      throw new Error("construct requires a compile-time type value");
    }

    if (type.tag === "record") {
      const fields = type.fields.map((field, index) => {
        if (field.name === undefined) {
          throw new Error(
            "construct record field " + index.toString() + " has no name",
          );
        }

        let value: FrontExpr;

        if (values.tag === "struct_value") {
          const source = lookup_field(values.fields, field.name);

          if (!source) {
            throw new Error("construct is missing field " + field.name);
          }

          value = source.value;
        } else if (values.tag === "product") {
          const source = values.entries[index];

          if (!source) {
            throw new Error(
              "construct is missing field index " + index.toString(),
            );
          }

          value = source.value;
        } else {
          value = { tag: "field", object: values, name: field.name };
        }

        return { name: field.name, value };
      });

      return hooks.lower_expr(
        { tag: "struct_value", type_expr, fields },
        env,
      );
    }

    if (type.tag === "product" || type.tag === "tuple") {
      let entries: import("./comptime_value.ts").ComptimeTypeField[];

      if (type.tag === "product") {
        entries = type.entries;
      } else {
        entries = type.items.map((item) => ({
          name: undefined,
          type: item,
          source: item.source,
        }));
      }
      const result: Extract<FrontExpr, { tag: "product" }>[
        "entries"
      ] = [];

      for (let index = 0; index < entries.length; index += 1) {
        const target = entries[index];
        if (!target) {
          throw new Error("Missing construct product type entry " + index);
        }

        let value: FrontExpr;

        if (values.tag === "product") {
          const source = values.entries[index];
          if (!source) {
            throw new Error("construct is missing product entry " + index);
          }
          value = source.value;
        } else {
          value = {
            tag: "index",
            object: values,
            index: { tag: "num", type: "i32", value: index },
          };
        }

        const entry: typeof result[number] = { value };

        if (target.name !== undefined) {
          entry.label = target.name;
        }

        result.push(entry);
      }

      return hooks.lower_expr({ tag: "product", entries: result }, env);
    }

    if (type.tag === "array") {
      if (values.tag !== "array" || values.rest !== undefined) {
        throw new Error("construct fixed array requires an array value");
      }

      const length = fixed_array_length(type.length);

      if (values.items.length !== length) {
        throw new Error(
          "construct fixed array expects " + length.toString() +
            " values, got " + values.items.length.toString(),
        );
      }

      return hooks.lower_expr(values, env);
    }

    throw new Error("construct does not support type kind " + type.tag);
  }

  const text_builtin = lower_text_builtin_call(expr, env, hooks);

  if (text_builtin) {
    return text_builtin;
  }

  if (
    expr.func.name === "Utf8.encode" || expr.func.name === "Utf8.decode" ||
    expr.func.name === "format_i32" || expr.func.name === "format_i64" ||
    expr.func.name === "format_f32"
  ) {
    throw new Error(
      expr.func.name + " requires structured Core/Wasm lowering" +
        structured_core_route,
    );
  }

  const value = hooks.eval_const_builtin(expr, env);

  if (!value) {
    return undefined;
  }

  return hooks.lower_expr(value, env);
}

export function lower_method_app(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: BuiltinCallHooks,
): IcNode | undefined {
  if (expr.func.tag !== "field") {
    return undefined;
  }

  if (expr.func.object.tag !== "var" && expr.func.object.tag !== "linear") {
    return undefined;
  }

  const receiver_binding = hooks.lookup(env, expr.func.object.name);

  if (
    !receiver_binding || receiver_binding.is_const ||
    receiver_binding.is_linear !== true
  ) {
    return undefined;
  }

  const method = hooks.resolve_struct_field_expr(expr.func, env);

  if (!method) {
    return undefined;
  }

  if (method.expr.tag !== "lam") {
    return undefined;
  }

  const receiver_name = expr.func.object.name;
  const args: FrontExpr[] = [{ tag: "linear", name: receiver_name }];

  for (const arg of expr.args) {
    args.push(arg);
  }

  return hooks.lower_expr(
    {
      tag: "app",
      func: hooks.capture_expr(method.expr, method.env),
      args,
    },
    env,
  );
}
