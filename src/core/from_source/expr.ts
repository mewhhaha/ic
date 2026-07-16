import type { FrontExpr, Param, Stmt } from "../../frontend/ast.ts";
import { contains_reserved_linear_effect } from "../../frontend/linear.ts";
import type { CoreExpr, CoreField, CoreParam, CoreTypeField } from "../ast.ts";
import {
  type CoreFromSourceCtx,
  fork_core_from_source_ctx,
  resolve_bound_core_value_name,
  resolve_core_annotation,
  resolve_core_name,
} from "./context.ts";
import { atom_i32 } from "../../frontend/atom.ts";
import { record_optional_core_source_origin } from "../source_origin.ts";
import {
  elaborate_array_repeat_expr,
  elaborate_fixed_array_expr,
  elaborate_product_as_expr,
  elaborate_product_expr,
} from "../../frontend/aggregate.ts";
import { numeric_builtin_call } from "../../frontend/numeric.ts";
import { Callable } from "../../trait.ts";
import { Prim } from "../../op.ts";
import { expect } from "../../expect.ts";
import { f32x4_builtin_call } from "../../frontend/f32x4.ts";
import { compiler_builtin_args } from "../../frontend/call_args.ts";

export function core_expr(expr: FrontExpr, ctx: CoreFromSourceCtx): CoreExpr {
  return record_optional_core_source_origin(
    core_expr_untracked(expr, ctx),
    expr,
  );
}

function core_expr_untracked(
  expr: FrontExpr,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  switch (expr.tag) {
    case "bool": {
      let value = 0;

      if (expr.value) {
        value = 1;
      }

      return { tag: "num", type: "i32", value };
    }

    case "atom":
      return {
        tag: "num",
        type: "i32",
        value: atom_i32(expr.name),
        atom_name: expr.name,
      };

    case "num":
      return { tag: "num", type: expr.type, value: expr.value };

    case "unit":
      return { tag: "num", type: "i32", value: 0 };

    case "text":
      return { tag: "text", value: expr.value };

    case "type_name":
      return { tag: "type_name", name: expr.name };

    case "set_type":
      throw new Error(
        "Compile-time set type cannot be emitted as a Core result",
      );

    case "is":
      throw new Error(
        "`is` expression must be elaborated before Core lowering",
      );

    case "as":
      return core_expr(elaborate_product_as_expr(expr), ctx);

    case "match":
      throw new Error(
        "Match expression must be elaborated before Core lowering",
      );

    case "var": {
      const resolved = resolve_bound_core_value_name(ctx, expr.name);
      const named_rec = ctx.namedRecs.get(resolved) ||
        ctx.namedRecs.get(expr.name);

      if (named_rec) {
        return { tag: "rec_ref", name: resolved, params: named_rec.params };
      }

      if (expr.resume_signature) {
        return {
          tag: "var",
          name: resolved,
          resume_signature: expr.resume_signature,
        };
      }

      return { tag: "var", name: resolved };
    }

    case "linear": {
      const name = resolve_core_name(ctx, expr.name);

      if (expr.resume_signature) {
        return {
          tag: "linear",
          name,
          resume_signature: expr.resume_signature,
        };
      }

      return { tag: "linear", name };
    }

    case "prim":
      return {
        tag: "prim",
        prim: expr.prim,
        args: [core_expr(expr.left, ctx), core_expr(expr.right, ctx)],
      };

    case "lam": {
      const body_ctx = fork_core_from_source_ctx(ctx);
      const flattened = flattened_product_function(expr);
      let params = expr.params;
      let body = expr.body;

      if (flattened !== undefined) {
        params = flattened.params;
        body = flattened.body;
      }

      for (const param of params) {
        body_ctx.aliases.set(param.name, param.name);
        if (param.is_linear) {
          body_ctx.linear_names.add(param.name);
        } else {
          body_ctx.linear_names.delete(param.name);
        }
      }

      const value: CoreExpr = {
        tag: "lam",
        params: params.map((param) => core_param(param, ctx)),
        body: core_expr(body, body_ctx),
      };
      if (contains_reserved_linear_effect(body, body_ctx.linear_names)) {
        value.is_linear_closure = true;
      }
      return value;
    }

    case "rec": {
      const body_ctx = fork_core_from_source_ctx(ctx);
      const flattened = flattened_product_function(expr);
      let params = expr.params;
      let body = expr.body;

      if (flattened !== undefined) {
        params = flattened.params;
        body = flattened.body;
      }

      for (const param of params) {
        body_ctx.aliases.set(param.name, param.name);
        if (param.is_linear) {
          body_ctx.linear_names.add(param.name);
        } else {
          body_ctx.linear_names.delete(param.name);
        }
      }

      return {
        tag: "rec",
        params: params.map((param) => core_param(param, ctx)),
        body: core_expr(body, body_ctx),
      };
    }

    case "app": {
      const f32x4_call = f32x4_builtin_call(expr);

      if (f32x4_call) {
        expect(expr.func.tag === "var", "F32x4 builtin requires a name");

        if (!ctx.aliases.has(expr.func.name)) {
          const expected = Callable.arity(Prim, f32x4_call.prim);
          expect(
            f32x4_call.args.length === expected,
            expr.func.name + " expects " + expected + " arguments, got " +
              f32x4_call.args.length,
          );
          return {
            tag: "prim",
            prim: f32x4_call.prim,
            args: f32x4_call.args.map((arg) => core_expr(arg, ctx)),
          };
        }
      }

      const numeric_call = numeric_builtin_call(expr);

      if (numeric_call) {
        expect(expr.func.tag === "var", "Numeric builtin requires a name");

        if (!ctx.aliases.has(expr.func.name)) {
          const expected = Callable.arity(Prim, numeric_call.prim);
          expect(
            numeric_call.args.length === expected,
            expr.func.name + " expects " + expected + " arguments, got " +
              numeric_call.args.length,
          );
          return {
            tag: "prim",
            prim: numeric_call.prim,
            args: numeric_call.args.map((arg) => core_expr(arg, ctx)),
          };
        }
      }

      const host_method = core_host_import_method_app(expr, ctx);

      if (host_method) {
        return host_method;
      }

      let args = expr.args;

      if (
        expr.func.tag === "var" &&
        !ctx.aliases.has(expr.func.name) &&
        core_product_builtin_names.has(expr.func.name)
      ) {
        args = compiler_builtin_args(expr);
      }

      const app: Extract<CoreExpr, { tag: "app" }> = {
        tag: "app",
        func: core_expr(expr.func, ctx),
        args: args.map((arg) => core_expr(arg, ctx)),
      };

      if (expr.resume_payload) {
        app.resume_payload = true;
      }

      return app;
    }

    case "product":
      return core_expr(elaborate_product_expr(expr), ctx);

    case "shape":
      throw new Error("Compile-time shape cannot be emitted as a Core result");

    case "array":
      return core_expr(elaborate_fixed_array_expr(expr), ctx);

    case "array_repeat": {
      const value_name = "_array_repeat#" + ctx.fresh.next.toString();
      ctx.fresh.next += 1;
      return core_expr(
        elaborate_array_repeat_expr(expr, value_name),
        ctx,
      );
    }

    case "import":
      throw new Error(
        "Expression import must be resolved before Core lowering: " +
          expr.path,
      );

    case "block": {
      const block_ctx = fork_core_from_source_ctx(ctx);
      return {
        tag: "block",
        statements: expr.statements.map((stmt) => {
          return ctx.lower_stmt(stmt, block_ctx);
        }),
      };
    }

    case "loop": {
      const loop_ctx = fork_core_from_source_ctx(ctx);
      return {
        tag: "loop",
        body: expr.body.map((stmt) => {
          return ctx.lower_stmt(stmt, loop_ctx);
        }),
      };
    }

    case "comptime":
      return { tag: "comptime", expr: core_expr(expr.expr, ctx) };

    case "borrow":
      return { tag: "borrow", value: core_expr(expr.value, ctx) };

    case "freeze":
      return { tag: "freeze", value: core_expr(expr.value, ctx) };

    case "scratch":
      return { tag: "scratch", body: core_expr(expr.body, ctx) };

    case "captured":
      return core_expr(expr.expr, ctx);

    case "handler":
      throw new Error(
        "Handler expression must be elaborated before Core lowering",
      );

    case "try_with":
      throw new Error(
        "Try-with expression must be elaborated before Core lowering",
      );

    case "with":
      return {
        tag: "with",
        base: core_expr(expr.base, ctx),
        fields: expr.fields.map((field) => core_field(field, ctx)),
      };

    case "struct_type":
      return {
        tag: "struct_type",
        fields: expr.fields.map(core_type_field),
      };

    case "struct_value":
      return {
        tag: "struct_value",
        type_expr: core_expr(expr.type_expr, ctx),
        fields: expr.fields.map((field) => core_field(field, ctx)),
      };

    case "struct_update":
      return {
        tag: "struct_update",
        base: core_expr(expr.base, ctx),
        fields: expr.fields.map((field) => core_field(field, ctx)),
      };

    case "type_with":
      throw new Error(
        "Computed type members must be elaborated before Core lowering",
      );

    case "union_type":
      return {
        tag: "union_type",
        cases: expr.cases.map(core_type_field),
      };

    case "if":
      return {
        tag: "if",
        cond: core_expr(expr.cond, ctx),
        then_branch: core_expr(
          expr.then_branch,
          fork_core_from_source_ctx(ctx),
        ),
        else_branch: core_expr(
          expr.else_branch,
          fork_core_from_source_ctx(ctx),
        ),
        implicit_else: expr.implicit_else,
      };

    case "if_let": {
      const then_ctx = fork_core_from_source_ctx(ctx);

      if (expr.value_name) {
        then_ctx.aliases.set(expr.value_name, expr.value_name);
      }

      return {
        tag: "if_let",
        case_name: expr.case_name,
        value_name: expr.value_name,
        target: core_expr(expr.target, ctx),
        then_branch: core_expr(expr.then_branch, then_ctx),
        else_branch: core_expr(
          expr.else_branch,
          fork_core_from_source_ctx(ctx),
        ),
        implicit_else: expr.implicit_else,
      };
    }

    case "field": {
      let object = core_expr(expr.object, ctx);

      if (expr.resume_signature && object.tag === "linear") {
        object = { tag: "var", name: object.name };
      }

      if (expr.resume_signature) {
        return {
          tag: "field",
          object,
          name: expr.name,
          resume_signature: expr.resume_signature,
        };
      }

      return { tag: "field", object, name: expr.name };
    }

    case "index":
      return {
        tag: "index",
        object: core_expr(expr.object, ctx),
        index: core_expr(expr.index, ctx),
      };

    case "union_case": {
      let payload: CoreExpr | undefined;
      let type_expr: CoreExpr | undefined;

      if (expr.value) {
        payload = core_expr(expr.value, ctx);
      }

      if (expr.type_expr) {
        type_expr = core_expr(expr.type_expr, ctx);
      }

      const value: Extract<CoreExpr, { tag: "union_case" }> = {
        tag: "union_case",
        name: expr.name,
        value: payload,
        type_expr,
      };

      if (expr.resume_payload) {
        value.resume_payload = true;
      }

      return value;
    }

    case "unsupported":
      return {
        tag: "unsupported",
        feature: expr.feature,
        text: expr.text,
      };
  }
}

const core_product_builtin_names = new Set([
  "append",
  "Bytes.generate",
  "get",
  "runtime_i32_slice",
  "runtime_text_slice",
  "slice",
]);

function flattened_product_function(
  expr: Extract<FrontExpr, { tag: "lam" | "rec" }>,
): { params: Param[]; body: FrontExpr } | undefined {
  const pattern = expr.pattern;
  const packed_param = expr.params[0];

  if (pattern?.tag !== "product") {
    return undefined;
  }

  let body = expr.body;

  if (
    expr.params.length === 1 && packed_param !== undefined &&
    packed_param.name.startsWith("_pattern#param")
  ) {
    if (expr.body.tag !== "block") {
      return undefined;
    }

    const final_stmt = expr.body.statements[expr.body.statements.length - 1];

    if (!final_stmt || final_stmt.tag !== "expr") {
      return undefined;
    }

    body = final_stmt.expr;
  }

  const params: Param[] = [];

  for (let index = 0; index < pattern.entries.length; index += 1) {
    const entry = pattern.entries[index];

    if (!entry) {
      throw new Error("Missing product function pattern entry " + index);
    }

    if (entry.pattern.tag === "binding") {
      params.push({
        name: entry.pattern.name,
        is_const: entry.pattern.mode === "const",
        is_linear: entry.pattern.mode === "linear",
        annotation: entry.pattern.annotation,
        type_annotation: entry.pattern.type_annotation,
      });
      continue;
    }

    if (entry.pattern.tag === "wildcard") {
      params.push({
        name: "_pattern#ignored" + index.toString(),
        is_const: entry.pattern.mode === "const",
        is_linear: false,
        annotation: undefined,
      });
      continue;
    }

    return undefined;
  }

  return { params, body };
}

export function core_param(param: {
  name: string;
  is_const: boolean;
  is_linear: boolean;
  annotation: string | undefined;
}, ctx: CoreFromSourceCtx): CoreParam {
  return {
    name: param.name,
    is_const: param.is_const,
    is_linear: param.is_linear,
    annotation: resolve_core_annotation(ctx, param.annotation),
  };
}

function core_host_import_method_app(
  expr: Extract<FrontExpr, { tag: "app" }>,
  ctx: CoreFromSourceCtx,
): CoreExpr | undefined {
  if (expr.func.tag !== "field") {
    return undefined;
  }

  const object = expr.func.object;

  if (object.tag !== "var" && object.tag !== "linear") {
    return undefined;
  }

  const receiver_name = resolve_core_name(ctx, object.name);
  resolve_bound_core_value_name(ctx, object.name);
  const method_table = ctx.capability_methods.get(receiver_name);

  if (method_table) {
    const host_import = method_table.get(expr.func.name);

    if (!host_import) {
      return {
        tag: "unsupported",
        feature: "missing_capability_method",
        text: receiver_name + "." + expr.func.name,
      };
    }

    return {
      tag: "app",
      func: { tag: "var", name: host_import },
      args: expr.args.map((arg) => core_expr(arg, ctx)),
    };
  }

  if (!ctx.host_import_names.has(expr.func.name)) {
    if (ctx.linear_names.has(receiver_name)) {
      return {
        tag: "unsupported",
        feature: "missing_capability_method",
        text: receiver_name + "." + expr.func.name,
      };
    }

    return undefined;
  }

  const args: CoreExpr[] = [{ tag: "linear", name: receiver_name }];

  for (const arg of expr.args) {
    args.push(core_expr(arg, ctx));
  }

  return {
    tag: "app",
    func: { tag: "var", name: expr.func.name },
    args,
  };
}

function core_field(
  field: { name: string; value: FrontExpr },
  ctx: CoreFromSourceCtx,
): CoreField {
  return { name: field.name, value: core_expr(field.value, ctx) };
}

function core_type_field(
  field: {
    name: string;
    type_name: string;
    set_member?: import("../../frontend/ast.ts").TypeExpr;
  },
): CoreTypeField {
  const result: CoreTypeField = {
    name: field.name,
    type_name: field.type_name,
  };

  if (field.set_member) {
    result.set_member = field.set_member;
  }

  return result;
}

export function block_body(expr: FrontExpr): Stmt[] | undefined {
  if (expr.tag !== "block") {
    return undefined;
  }

  return expr.statements;
}
