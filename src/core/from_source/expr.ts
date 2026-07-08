import type { FrontExpr, Stmt } from "../../frontend/ast.ts";
import type { CoreExpr, CoreField, CoreParam, CoreTypeField } from "../ast.ts";
import {
  type CoreFromSourceCtx,
  fork_core_from_source_ctx,
  resolve_core_name,
} from "./context.ts";
import { core_stmt } from "./stmt.ts";

export function core_expr(expr: FrontExpr, ctx: CoreFromSourceCtx): CoreExpr {
  switch (expr.tag) {
    case "num":
      return { tag: "num", type: expr.type, value: expr.value };

    case "text":
      return { tag: "text", value: expr.value };

    case "type_name":
      return { tag: "type_name", name: expr.name };

    case "var":
      const resolved = resolve_core_name(ctx, expr.name);
      if (ctx.namedRecs.has(resolved) || ctx.namedRecs.has(expr.name)) {
        return { tag: "rec_ref", name: resolved };
      }
      return { tag: "var", name: resolved };

    case "rec_ref":
      return { tag: "rec_ref", name: resolve_core_name(ctx, expr.name) };

    case "linear":
      return { tag: "linear", name: resolve_core_name(ctx, expr.name) };

    case "prim":
      return {
        tag: "prim",
        prim: expr.prim,
        args: [core_expr(expr.left, ctx), core_expr(expr.right, ctx)],
      };

    case "lam": {
      const body_ctx = fork_core_from_source_ctx(ctx);

      for (const param of expr.params) {
        body_ctx.aliases.set(param.name, param.name);
        if (param.is_linear) {
          body_ctx.linear_names.add(param.name);
        } else {
          body_ctx.linear_names.delete(param.name);
        }
      }

      return {
        tag: "lam",
        params: expr.params.map(core_param),
        body: core_expr(expr.body, body_ctx),
      };
    }

    case "rec": {
      const body_ctx = fork_core_from_source_ctx(ctx);

      for (const param of expr.params) {
        body_ctx.aliases.set(param.name, param.name);
        if (param.is_linear) {
          body_ctx.linear_names.add(param.name);
        } else {
          body_ctx.linear_names.delete(param.name);
        }
      }

      return {
        tag: "rec",
        params: expr.params.map(core_param),
        body: core_expr(expr.body, body_ctx),
      };
    }

    case "app": {
      const host_method = core_host_import_method_app(expr, ctx);

      if (host_method) {
        return host_method;
      }

      return {
        tag: "app",
        func: core_expr(expr.func, ctx),
        args: expr.args.map((arg) => core_expr(arg, ctx)),
      };
    }

    case "block": {
      const block_ctx = fork_core_from_source_ctx(ctx);
      return {
        tag: "block",
        statements: expr.statements.map((stmt) => core_stmt(stmt, block_ctx)),
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

    case "field":
      return {
        tag: "field",
        object: core_expr(expr.object, ctx),
        name: expr.name,
      };

    case "index":
      return {
        tag: "index",
        object: core_expr(expr.object, ctx),
        index: core_expr(expr.index, ctx),
      };

    case "union_case": {
      let value: CoreExpr | undefined;
      let type_expr: CoreExpr | undefined;

      if (expr.value) {
        value = core_expr(expr.value, ctx);
      }

      if (expr.type_expr) {
        type_expr = core_expr(expr.type_expr, ctx);
      }

      return {
        tag: "union_case",
        name: expr.name,
        value,
        type_expr,
      };
    }

    case "unsupported":
      return {
        tag: "unsupported",
        feature: expr.feature,
        text: expr.text,
      };
  }
}

export function core_param(param: {
  name: string;
  is_const: boolean;
  is_linear: boolean;
  annotation: string | undefined;
}): CoreParam {
  return {
    name: param.name,
    is_const: param.is_const,
    is_linear: param.is_linear,
    annotation: param.annotation,
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
  field: { name: string; type_name: string },
): CoreTypeField {
  return { name: field.name, type_name: field.type_name };
}

export function block_body(expr: FrontExpr): Stmt[] | undefined {
  if (expr.tag !== "block") {
    return undefined;
  }

  return expr.statements;
}
