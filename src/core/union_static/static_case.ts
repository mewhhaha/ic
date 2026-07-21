import { expect } from "../../expect.ts";
import type { CoreExpr, CoreStmt } from "../ast.ts";
import { find_core_field } from "../analysis/field.ts";
import { static_core_call_branch_app } from "../static_call.ts";
import { record_core_expr_provenance } from "../subject_provenance.ts";
import { find_core_type_field } from "./field.ts";
import { scoped_union_static_call_value } from "./static_call.ts";
import type { CoreUnionCtx, CoreUnionHooks } from "./types.ts";

export function static_union_case<ctx extends CoreUnionCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): Extract<CoreExpr, { tag: "union_case" }> | undefined {
  if (expr.tag === "union_case") {
    return expr;
  }
  if (expr.tag === "rec_ref") {
    return undefined;
  }

  const constructor_case = static_union_constructor_case(expr, ctx, hooks);

  if (constructor_case) {
    return constructor_case;
  }

  const block_case = static_union_block_case(expr, ctx, hooks);

  if (block_case) {
    return block_case;
  }

  if (expr.tag === "block") {
    return undefined;
  }

  if (expr.tag === "field") {
    const object = hooks.static_struct_value(expr.object, ctx);
    if (!object) {
      return undefined;
    }

    const field = find_core_field(object.fields, expr.name);
    expect(field, "Missing static core field: " + expr.name);
    return static_union_case(field.value, ctx, hooks);
  }

  const inlined = hooks.static_core_call_value(expr, ctx);

  if (inlined) {
    return static_union_case(inlined, ctx, hooks);
  }

  const scoped = scoped_union_static_call_value(expr, ctx, hooks);

  if (scoped) {
    return static_union_case(scoped.value, scoped.ctx, hooks);
  }

  if (expr.tag === "app") {
    const branch_static_call = static_core_call_branch_app(expr, ctx, hooks);

    if (branch_static_call) {
      return static_union_case(branch_static_call, ctx, hooks);
    }
  }

  if (expr.tag === "var") {
    const value = ctx.statics.get(expr.name);

    if (value && value.tag === "union_case") {
      return value;
    }
  }

  return undefined;
}

function static_union_block_case<ctx extends CoreUnionCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): Extract<CoreExpr, { tag: "union_case" }> | undefined {
  if (expr.tag !== "block") {
    return undefined;
  }

  if (expr.statements.length !== 1) {
    return undefined;
  }

  const stmt = expr.statements[0];

  if (!stmt) {
    return undefined;
  }

  return static_union_final_stmt_case(stmt, ctx, hooks);
}

function static_union_final_stmt_case<ctx extends CoreUnionCtx>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): Extract<CoreExpr, { tag: "union_case" }> | undefined {
  if (stmt.tag === "expr") {
    return static_union_case(stmt.expr, ctx, hooks);
  }

  if (stmt.tag === "return") {
    return static_union_case(stmt.value, ctx, hooks);
  }

  return undefined;
}

function static_union_constructor_case<ctx extends CoreUnionCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): Extract<CoreExpr, { tag: "union_case" }> | undefined {
  if (expr.tag !== "app") {
    return undefined;
  }

  if (expr.func.tag !== "field") {
    return undefined;
  }

  const union_type = static_union_type(expr.func.object, ctx, hooks);

  if (!union_type) {
    return undefined;
  }

  const declared = find_core_type_field(union_type.cases, expr.func.name);
  expect(declared, "Missing union case: " + expr.func.name);
  let value: CoreExpr | undefined;

  if (declared.type_name === "Unit") {
    expect(
      expr.args.length === 0,
      "Core union case " + expr.func.name + " expects no payload",
    );
  } else {
    expect(
      expr.args.length === 1,
      "Core union case " + expr.func.name + " expects 1 payload",
    );
    value = expr.args[0];
    expect(value, "Missing core union case payload");
    hooks.check_core_value_type_name(
      "Core union case " + expr.func.name,
      declared.type_name,
      value,
      ctx,
    );
  }

  const result: Extract<CoreExpr, { tag: "union_case" }> = {
    tag: "union_case",
    name: expr.func.name,
    value,
    type_expr: expr.func.object,
  };

  if (expr.resume_payload) {
    result.resume_payload = true;
  }

  return record_core_expr_provenance(result, expr);
}

function static_union_type<ctx extends CoreUnionCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: CoreUnionHooks<ctx>,
): Extract<CoreExpr, { tag: "union_type" }> | undefined {
  const value = hooks.static_type_value(expr, ctx);

  if (value && value.tag === "union_type") {
    return value;
  }

  return undefined;
}
