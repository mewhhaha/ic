import { expect } from "../expect.ts";
import { Ic, type Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, Stmt } from "./ast.ts";
import { text_byte_length } from "./text.ts";
import { lower_expr_as_front_type } from "./typed_lower.ts";
import { front_type_from_type_name, is_builtin_type_name } from "./types.ts";
import type { TextLowerHooks } from "./text_lower_types.ts";
import {
  check_text_concat_operand_visibility,
  visible_text_value,
} from "./text_visible.ts";
import { lower_text_app_result } from "./text_lower/app_result.ts";

export {
  lower_runtime_text_byte_index,
  lower_static_text_byte_index,
} from "./text_lower/byte_index.ts";

export function lower_text_len(
  expr: FrontExpr,
  env: Env,
  seen: Set<string>,
  hooks: TextLowerHooks,
): IcNode | undefined {
  if (expr.tag === "captured") {
    return lower_text_len(expr.expr, expr.env, seen, hooks);
  }

  if (expr.tag === "text") {
    return {
      tag: "num",
      type: "i32",
      value: text_byte_length(expr.value),
    };
  }

  if (expr.tag === "comptime") {
    return lower_text_len(expr.expr, env, seen, hooks);
  }

  if (expr.tag === "prim" && expr.prim === "i32.add") {
    const text_value = visible_text_value(expr, env, seen, hooks);

    if (!text_value) {
      check_text_concat_operand_visibility(expr, env, hooks);
      return undefined;
    }

    return lower_text_len(text_value, env, seen, hooks);
  }

  if (expr.tag === "var") {
    if (seen.has(expr.name)) {
      return undefined;
    }

    const binding = hooks.lookup(env, expr.name);

    if (!binding) {
      return undefined;
    }

    if (binding.value) {
      let value_env = env;

      if (binding.value_env) {
        value_env = binding.value_env;
      }

      const next_seen = new Set(seen);
      next_seen.add(expr.name);
      const text_value = visible_text_value(
        binding.value,
        value_env,
        next_seen,
        hooks,
      );

      if (text_value) {
        return lower_text_len(text_value, value_env, next_seen, hooks);
      }

      const value_len = lower_text_len(
        binding.value,
        value_env,
        next_seen,
        hooks,
      );

      if (value_len) {
        return value_len;
      }

      if (binding.is_deferred) {
        return {
          tag: "prim",
          prim: "i32.load",
          args: [
            lower_expr_as_front_type(
              binding.value,
              { tag: "text" },
              value_env,
              hooks,
            ),
          ],
        };
      }
    }

    if (binding.type.tag === "text") {
      return {
        tag: "prim",
        prim: "i32.load",
        args: [hooks.lower_expr(expr, env)],
      };
    }

    return undefined;
  }

  if (expr.tag === "if") {
    const then_len = lower_text_len(expr.then_branch, env, seen, hooks);

    if (!then_len) {
      return undefined;
    }

    let else_len: IcNode | undefined;

    if (expr.implicit_else) {
      else_len = { tag: "num", type: "i32", value: 0 };
    } else {
      else_len = lower_text_len(expr.else_branch, env, seen, hooks);
    }

    if (!else_len) {
      return undefined;
    }

    const cond = Ic.reduce(hooks.lower_expr(expr.cond, env));

    if (cond.tag === "num") {
      expect(cond.type === "i32", "Text len if condition must lower to i32");
      const value = cond.value;
      expect(typeof value === "number", "Expected i32 text len condition");

      if (value !== 0) {
        return then_len;
      }

      return else_len;
    }

    return {
      tag: "prim",
      prim: "i32.select",
      args: [then_len, else_len, cond],
    };
  }

  if (expr.tag === "block") {
    const alias_len = lower_simple_text_alias_block_len(
      expr,
      env,
      seen,
      hooks,
    );

    if (alias_len) {
      return alias_len;
    }

    const value = hooks.eval_simple_front_block(expr, env);

    if (value) {
      return lower_text_len(value, env, seen, hooks);
    }

    const final_stmt = expr.statements[expr.statements.length - 1];

    if (!final_stmt) {
      return undefined;
    }

    if (expr.statements.length !== 1) {
      return undefined;
    }

    if (final_stmt.tag === "expr") {
      return lower_text_len(final_stmt.expr, env, seen, hooks);
    }

    if (final_stmt.tag === "return") {
      return lower_text_len(final_stmt.value, env, seen, hooks);
    }

    return undefined;
  }

  if (expr.tag === "app") {
    const text_value = visible_text_value(expr, env, seen, hooks);

    if (text_value) {
      return lower_text_len(text_value, env, seen, hooks);
    }

    const typed_app = lower_text_app_result(expr, env, hooks);

    if (typed_app) {
      return {
        tag: "prim",
        prim: "i32.load",
        args: [typed_app],
      };
    }

    const value = hooks.try_eval_all_const_call(expr, env);

    if (!value) {
      return undefined;
    }

    return lower_text_len(value, env, seen, hooks);
  }

  if (expr.tag === "field") {
    const field = hooks.resolve_struct_field_expr(expr, env);

    if (!field) {
      return undefined;
    }

    return lower_text_len(field.expr, field.env, seen, hooks);
  }

  if (expr.tag === "index") {
    const static_index = hooks.resolve_static_i32_expr(expr.index, env);

    if (static_index === undefined) {
      return lower_dynamic_text_index_len(expr, env, seen, hooks);
    }

    const item = hooks.resolve_index_expr(expr, env);

    if (item) {
      return lower_text_len(item.expr, item.env, seen, hooks);
    }

    return undefined;
  }

  return undefined;
}

function lower_simple_text_alias_block_len(
  expr: Extract<FrontExpr, { tag: "block" }>,
  env: Env,
  seen: Set<string>,
  hooks: TextLowerHooks,
): IcNode | undefined {
  if (expr.statements.length !== 2) {
    return undefined;
  }

  const bind = expr.statements[0];
  const result = expr.statements[1];
  expect(bind, "Missing text alias block binding");
  expect(result, "Missing text alias block result");

  if (bind.tag !== "bind") {
    return undefined;
  }

  if (bind.kind !== "let") {
    return undefined;
  }

  if (bind.is_linear) {
    return undefined;
  }

  const result_expr = text_block_result_expr(result);

  if (!result_expr) {
    return undefined;
  }

  if (result_expr.tag !== "var" || result_expr.name !== bind.name) {
    return undefined;
  }

  if (bind.annotation && !annotation_is_text(bind.annotation, env, hooks)) {
    return undefined;
  }

  const direct_len = lower_text_len(bind.value, env, seen, hooks);

  if (direct_len) {
    return direct_len;
  }

  return {
    tag: "prim",
    prim: "i32.load",
    args: [
      lower_expr_as_front_type(bind.value, { tag: "text" }, env, hooks),
    ],
  };
}

function text_block_result_expr(stmt: Stmt): FrontExpr | undefined {
  if (stmt.tag === "expr") {
    return stmt.expr;
  }

  if (stmt.tag === "return") {
    return stmt.value;
  }

  return undefined;
}

function annotation_is_text(
  annotation: string,
  env: Env,
  hooks: TextLowerHooks,
): boolean {
  const resolved = hooks.resolve_annotation_type(annotation, env);

  if (resolved && resolved.tag !== "unknown") {
    return resolved.tag === "text";
  }

  if (!is_builtin_type_name(annotation)) {
    return false;
  }

  const builtin = front_type_from_type_name(annotation);
  return builtin.tag === "text";
}

function lower_dynamic_text_index_len(
  expr: Extract<FrontExpr, { tag: "index" }>,
  env: Env,
  seen: Set<string>,
  hooks: TextLowerHooks,
): IcNode | undefined {
  const target = hooks.resolve_struct_value(expr.object, env);

  if (!target) {
    return undefined;
  }

  const lengths: IcNode[] = [];

  for (const field of target.expr.fields) {
    const length = lower_text_len(field.value, target.env, seen, hooks);

    if (!length) {
      return undefined;
    }

    lengths.push(length);
  }

  let result: IcNode = { tag: "prim", prim: "i32.trap", args: [] };

  for (let index = lengths.length - 1; index >= 0; index -= 1) {
    const length = lengths[index];
    expect(length, "Missing visible text field length " + index.toString());
    result = {
      tag: "prim",
      prim: "i32.select",
      args: [
        length,
        result,
        {
          tag: "prim",
          prim: "i32.eq",
          args: [
            hooks.lower_expr(expr.index, env),
            { tag: "num", type: "i32", value: index },
          ],
        },
      ],
    };
  }

  return result;
}
