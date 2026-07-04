import { expect } from "../expect.ts";
import { Prim, type ValType } from "../op.ts";
import { Callable } from "../trait.ts";
import type {
  CoreExpr,
  CoreField,
  CoreFnType,
  CoreHostImport,
  CoreStmt,
} from "./ast.ts";
import {
  find_core_field,
  maybe_static_i32,
  set_local,
  static_indexed_field,
} from "./backend/util.ts";
import { core_host_import_result_ownership } from "./host_import.ts";
import type { DynamicUnionIf } from "./if_let.ts";
import type {
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "./runtime_union.ts";
import { dynamic_if_let_can_match } from "./union_static.ts";
import {
  runtime_aggregate_field_info,
  type RuntimeAggregateTypeHooks,
} from "./runtime_aggregate.ts";

export type CoreTextFactCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  host_imports?: Map<string, CoreHostImport>;
};

export type CoreTextFactHooks<ctx extends CoreTextFactCtx> =
  & RuntimeAggregateTypeHooks<ctx>
  & {
    expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
    bind_core_if_let_payload_fact: (
      value_name: string | undefined,
      union_case: Extract<CoreExpr, { tag: "union_case" }>,
      ctx: ctx,
    ) => void;
    bind_dynamic_if_let_payload: (
      case_name: string,
      value_name: string | undefined,
      target: DynamicUnionIf,
      ctx: ctx,
    ) => void;
    dynamic_union_if: (
      expr: CoreExpr,
      ctx: ctx,
    ) => DynamicUnionIf | undefined;
    runtime_union_match_info: (
      case_name: string,
      target: RuntimeUnionTarget,
      ctx: ctx,
    ) => RuntimeUnionMatchInfo;
    runtime_union_target: (
      expr: CoreExpr,
      ctx: ctx,
    ) => RuntimeUnionTarget | undefined;
    if_let_branch_ctx: (ctx: ctx) => ctx;
    static_struct_value: (
      expr: CoreExpr,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
    static_collection_fields: (
      expr: CoreExpr,
      ctx: ctx,
    ) => CoreField[] | undefined;
    static_core_call_value: (
      expr: CoreExpr,
      ctx: ctx,
    ) => CoreExpr | undefined;
    static_text_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
    static_runtime_union_match_branch_ctx: (
      value_name: string | undefined,
      info: RuntimeUnionMatchInfo,
      ctx: ctx,
    ) => ctx;
    static_union_case: (
      expr: CoreExpr,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
  };

export type RuntimeTextEq = {
  left: CoreExpr;
  right: CoreExpr;
  prim: "i32.eq" | "i32.ne";
};

export function core_expr_is_text<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): boolean {
  if (hooks.static_text_value(value, ctx)) {
    return true;
  }

  if (value.tag === "var") {
    return ctx.text_locals.has(value.name);
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    return core_expr_is_text(value.value, ctx, hooks);
  }

  if (value.tag === "scratch") {
    return core_expr_is_text(value.body, ctx, hooks);
  }

  const block_text = core_text_block_fact(
    value,
    ctx,
    hooks,
    core_expr_is_text,
  );

  if (block_text !== undefined) {
    return block_text;
  }

  if (value.tag === "if") {
    const cond_type = hooks.expr_type(value.cond, ctx);
    expect(cond_type === "i32", "Core text if condition must be i32");

    if (value.implicit_else) {
      return core_expr_is_text(value.then_branch, ctx, hooks);
    }

    return core_expr_is_text(value.then_branch, ctx, hooks) &&
      core_expr_is_text(value.else_branch, ctx, hooks);
  }

  if (value.tag === "if_let") {
    const if_let_text = core_if_let_text_fact(
      value,
      ctx,
      hooks,
      core_expr_is_text,
    );

    if (if_let_text !== undefined) {
      return if_let_text;
    }
  }

  if (value.tag === "field") {
    const struct_value = hooks.static_struct_value(value.object, ctx);

    if (!struct_value) {
      const field_info = runtime_aggregate_field_info(
        value.object,
        value.name,
        ctx,
        hooks,
      );

      if (field_info && field_info.tag === "value") {
        return field_info.text;
      }

      return false;
    }

    const field = find_core_field(struct_value.fields, value.name);
    expect(field, "Missing static core field: " + value.name);
    return core_expr_is_text(field.value, ctx, hooks);
  }

  if (value.tag === "index") {
    return core_collection_index_is_text(
      value.object,
      value.index,
      ctx,
      hooks,
    );
  }

  if (core_runtime_text_concat_operands(value, ctx, hooks)) {
    return true;
  }

  if (core_runtime_text_slice_args(value, ctx, hooks)) {
    return true;
  }

  if (core_append_app_args(value, ctx, hooks)) {
    return true;
  }

  if (core_get_app_is_text(value, ctx, hooks)) {
    return true;
  }

  if (core_host_import_result_is_text(value, ctx)) {
    return true;
  }

  const inlined = hooks.static_core_call_value(value, ctx);

  if (inlined) {
    return core_expr_is_text(inlined, ctx, hooks);
  }

  if (value.tag === "app") {
    const fn_type = core_text_app_fn_type(value, ctx, hooks);

    if (fn_type) {
      hooks.check_closure_call_args(value, fn_type, ctx);
      return fn_type.result_text;
    }
  }

  return false;
}

export function core_expr_has_runtime_text_fact<
  ctx extends CoreTextFactCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): boolean {
  if (value.tag === "var") {
    return ctx.text_locals.has(value.name);
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    return core_expr_has_runtime_text_fact(value.value, ctx, hooks);
  }

  if (value.tag === "scratch") {
    return core_expr_has_runtime_text_fact(value.body, ctx, hooks);
  }

  const block_text = core_text_block_fact(
    value,
    ctx,
    hooks,
    core_expr_has_runtime_text_fact,
  );

  if (block_text !== undefined) {
    return block_text;
  }

  if (value.tag === "if") {
    const cond_type = hooks.expr_type(value.cond, ctx);
    expect(cond_type === "i32", "Core text if condition must be i32");

    if (value.implicit_else) {
      return core_expr_has_runtime_text_fact(value.then_branch, ctx, hooks);
    }

    return core_expr_has_runtime_text_fact(value.then_branch, ctx, hooks) &&
      core_expr_has_runtime_text_fact(value.else_branch, ctx, hooks);
  }

  if (value.tag === "if_let") {
    const if_let_text = core_if_let_text_fact(
      value,
      ctx,
      hooks,
      core_expr_has_runtime_text_fact,
    );

    if (if_let_text !== undefined) {
      return if_let_text;
    }
  }

  if (value.tag === "field") {
    const struct_value = hooks.static_struct_value(value.object, ctx);

    if (!struct_value) {
      const field_info = runtime_aggregate_field_info(
        value.object,
        value.name,
        ctx,
        hooks,
      );

      if (field_info && field_info.tag === "value") {
        return field_info.text;
      }

      return false;
    }

    const field = find_core_field(struct_value.fields, value.name);
    expect(field, "Missing static core field: " + value.name);
    return core_expr_has_runtime_text_fact(field.value, ctx, hooks);
  }

  if (value.tag === "index") {
    return core_collection_index_has_runtime_text_fact(
      value.object,
      value.index,
      ctx,
      hooks,
    );
  }

  if (core_runtime_text_concat_operands(value, ctx, hooks)) {
    return true;
  }

  if (core_runtime_text_slice_args(value, ctx, hooks)) {
    return true;
  }

  if (core_append_app_args(value, ctx, hooks)) {
    return true;
  }

  if (core_get_app_has_runtime_text_fact(value, ctx, hooks)) {
    return true;
  }

  if (core_host_import_result_is_unique_text(value, ctx)) {
    return true;
  }

  const inlined = hooks.static_core_call_value(value, ctx);

  if (inlined) {
    return core_expr_has_runtime_text_fact(inlined, ctx, hooks);
  }

  if (value.tag === "app") {
    const fn_type = core_text_app_fn_type(value, ctx, hooks);

    if (fn_type) {
      hooks.check_closure_call_args(value, fn_type, ctx);
      return fn_type.result_text;
    }
  }

  return false;
}

function core_host_import_result_is_text<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
): boolean {
  const ownership = core_host_import_result_ownership(value, ctx);

  if (!ownership) {
    return false;
  }

  if (ownership.tag === "unique_heap" && ownership.reason === "text") {
    return true;
  }

  if (ownership.tag === "frozen_shareable" && ownership.reason === "text") {
    return true;
  }

  return false;
}

function core_host_import_result_is_unique_text<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
): boolean {
  const ownership = core_host_import_result_ownership(value, ctx);

  if (!ownership) {
    return false;
  }

  if (ownership.tag !== "unique_heap") {
    return false;
  }

  return ownership.reason === "text";
}

function core_text_block_fact<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: (
    value: CoreExpr,
    ctx: ctx,
    hooks: CoreTextFactHooks<ctx>,
  ) => boolean,
): boolean | undefined {
  if (value.tag !== "block") {
    return undefined;
  }

  const final_stmt = value.statements[value.statements.length - 1];

  if (!final_stmt) {
    return false;
  }

  const block_ctx = clone_core_text_fact_ctx(ctx);

  for (let index = 0; index + 1 < value.statements.length; index += 1) {
    const stmt = value.statements[index];
    expect(stmt, "Missing core text block statement " + index.toString());
    bind_core_text_block_stmt(stmt, block_ctx, hooks, check_text);
  }

  if (final_stmt.tag === "expr") {
    return check_text(final_stmt.expr, block_ctx, hooks);
  }

  if (final_stmt.tag === "return") {
    return check_text(final_stmt.value, block_ctx, hooks);
  }

  return false;
}

function bind_core_text_block_stmt<ctx extends CoreTextFactCtx>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: (
    value: CoreExpr,
    ctx: ctx,
    hooks: CoreTextFactHooks<ctx>,
  ) => boolean,
): void {
  if (stmt.tag === "bind") {
    bind_core_text_block_value(
      stmt.name,
      stmt.value,
      ctx,
      hooks,
      check_text,
    );
    return;
  }

  if (stmt.tag === "assign") {
    bind_core_text_block_value(
      stmt.name,
      stmt.value,
      ctx,
      hooks,
      check_text,
    );
  }
}

function bind_core_text_block_value<ctx extends CoreTextFactCtx>(
  name: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: (
    value: CoreExpr,
    ctx: ctx,
    hooks: CoreTextFactHooks<ctx>,
  ) => boolean,
): void {
  const text_value = hooks.static_text_value(value, ctx);

  if (text_value) {
    ctx.locals.delete(name);
    ctx.statics.set(name, text_value);
    ctx.text_locals.delete(name);
    return;
  }

  ctx.statics.delete(name);

  if (check_text(value, ctx, hooks)) {
    set_local(ctx.locals, name, "i32");
    ctx.text_locals.add(name);
    return;
  }

  if (value.tag === "num") {
    set_local(ctx.locals, name, value.type);
  }

  ctx.text_locals.delete(name);
}

function clone_core_text_fact_ctx<ctx extends CoreTextFactCtx>(ctx: ctx): ctx {
  return {
    ...ctx,
    locals: new Map(ctx.locals),
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
  };
}

function core_if_let_text_fact<ctx extends CoreTextFactCtx>(
  value: Extract<CoreExpr, { tag: "if_let" }>,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: (
    value: CoreExpr,
    ctx: ctx,
    hooks: CoreTextFactHooks<ctx>,
  ) => boolean,
): boolean | undefined {
  const union_case = hooks.static_union_case(value.target, ctx);

  if (union_case) {
    return core_if_let_case_text_fact(
      value,
      union_case,
      ctx,
      hooks,
      check_text,
    );
  }

  const dynamic_target = hooks.dynamic_union_if(value.target, ctx);

  if (dynamic_target) {
    const cond_type = hooks.expr_type(dynamic_target.cond, ctx);
    expect(cond_type === "i32", "Core text if let condition must be i32");

    if (!dynamic_if_let_can_match(value.case_name, dynamic_target)) {
      if (value.implicit_else) {
        return false;
      }

      return check_text(value.else_branch, ctx, hooks);
    }

    let then_text = core_if_let_dynamic_case_text_fact(
      value,
      dynamic_target.then_case,
      dynamic_target,
      ctx,
      hooks,
      check_text,
    );
    let else_text = core_if_let_dynamic_case_text_fact(
      value,
      dynamic_target.else_case,
      dynamic_target,
      ctx,
      hooks,
      check_text,
    );

    if (
      value.implicit_else &&
      then_text &&
      !else_text &&
      dynamic_target.else_case.name !== value.case_name
    ) {
      else_text = true;
    }

    if (
      value.implicit_else &&
      else_text &&
      !then_text &&
      dynamic_target.then_case.name !== value.case_name
    ) {
      then_text = true;
    }

    return then_text && else_text;
  }

  const runtime_target = hooks.runtime_union_target(value.target, ctx);

  if (!runtime_target) {
    return undefined;
  }

  const info = hooks.runtime_union_match_info(
    value.case_name,
    runtime_target,
    ctx,
  );
  const branch_ctx = hooks.static_runtime_union_match_branch_ctx(
    value.value_name,
    info,
    ctx,
  );

  const then_text = check_text(value.then_branch, branch_ctx, hooks);

  if (value.implicit_else) {
    return then_text;
  }

  return then_text && check_text(value.else_branch, ctx, hooks);
}

function core_if_let_dynamic_case_text_fact<ctx extends CoreTextFactCtx>(
  value: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  target: DynamicUnionIf,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: (
    value: CoreExpr,
    ctx: ctx,
    hooks: CoreTextFactHooks<ctx>,
  ) => boolean,
): boolean {
  if (union_case.name !== value.case_name) {
    if (value.implicit_else) {
      return false;
    }

    return check_text(value.else_branch, ctx, hooks);
  }

  const branch_ctx = hooks.if_let_branch_ctx(ctx);
  hooks.bind_dynamic_if_let_payload(
    value.case_name,
    value.value_name,
    target,
    branch_ctx,
  );
  return check_text(value.then_branch, branch_ctx, hooks);
}

function core_if_let_case_text_fact<ctx extends CoreTextFactCtx>(
  value: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: (
    value: CoreExpr,
    ctx: ctx,
    hooks: CoreTextFactHooks<ctx>,
  ) => boolean,
): boolean {
  if (union_case.name !== value.case_name) {
    if (value.implicit_else) {
      return false;
    }

    return check_text(value.else_branch, ctx, hooks);
  }

  const branch_ctx = hooks.if_let_branch_ctx(ctx);
  hooks.bind_core_if_let_payload_fact(
    value.value_name,
    union_case,
    branch_ctx,
  );

  const then_text = check_text(value.then_branch, branch_ctx, hooks);

  if (value.implicit_else) {
    return then_text;
  }

  return then_text && check_text(value.else_branch, ctx, hooks);
}

function core_get_app_is_text<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): boolean {
  if (value.tag !== "app") {
    return false;
  }

  if (value.func.tag !== "var" || value.func.name !== "get") {
    return false;
  }

  expect(value.args.length === 2, "Core get expects 2 arguments");
  const collection = value.args[0];
  const index = value.args[1];
  expect(collection, "Missing core get collection");
  expect(index, "Missing core get index");
  return core_collection_index_is_text(collection, index, ctx, hooks);
}

function core_get_app_has_runtime_text_fact<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): boolean {
  if (value.tag !== "app") {
    return false;
  }

  if (value.func.tag !== "var" || value.func.name !== "get") {
    return false;
  }

  expect(value.args.length === 2, "Core get expects 2 arguments");
  const collection = value.args[0];
  const index = value.args[1];
  expect(collection, "Missing core get collection");
  expect(index, "Missing core get index");
  return core_collection_index_has_runtime_text_fact(
    collection,
    index,
    ctx,
    hooks,
  );
}

function core_collection_index_is_text<ctx extends CoreTextFactCtx>(
  collection: CoreExpr,
  index: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): boolean {
  const fields = hooks.static_collection_fields(collection, ctx);

  if (!fields) {
    return false;
  }

  const index_type = hooks.expr_type(index, ctx);
  expect(index_type === "i32", "Core collection text index must be i32");
  const static_index = maybe_static_i32(index);

  if (static_index !== undefined) {
    const field = static_indexed_field(fields, static_index);
    return core_expr_is_text(field.value, ctx, hooks);
  }

  return core_collection_fields_are_text(fields, ctx, hooks);
}

function core_collection_index_has_runtime_text_fact<
  ctx extends CoreTextFactCtx,
>(
  collection: CoreExpr,
  index: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): boolean {
  const fields = hooks.static_collection_fields(collection, ctx);

  if (!fields) {
    return false;
  }

  const index_type = hooks.expr_type(index, ctx);
  expect(index_type === "i32", "Core collection text index must be i32");
  const static_index = maybe_static_i32(index);

  if (static_index !== undefined) {
    const field = static_indexed_field(fields, static_index);
    return core_expr_has_runtime_text_fact(field.value, ctx, hooks);
  }

  return core_collection_fields_have_runtime_text_fact(fields, ctx, hooks);
}

function core_collection_fields_are_text<ctx extends CoreTextFactCtx>(
  fields: CoreField[],
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): boolean {
  let result: boolean | undefined;

  for (const field of fields) {
    const is_text = core_expr_is_text(field.value, ctx, hooks);

    if (result === undefined) {
      result = is_text;
    } else {
      expect(
        result === is_text,
        "Core collection item text fact mismatch",
      );
    }
  }

  return result === true;
}

function core_collection_fields_have_runtime_text_fact<
  ctx extends CoreTextFactCtx,
>(
  fields: CoreField[],
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): boolean {
  let result: boolean | undefined;

  for (const field of fields) {
    const is_text = core_expr_has_runtime_text_fact(field.value, ctx, hooks);

    if (result === undefined) {
      result = is_text;
    } else {
      expect(
        result === is_text,
        "Core collection item text fact mismatch",
      );
    }
  }

  return result === true;
}

function core_text_app_fn_type<ctx extends CoreTextFactCtx>(
  value: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): CoreFnType | undefined {
  if (value.func.tag === "var") {
    const fn_type = ctx.fn_types.get(value.func.name);

    if (fn_type) {
      return fn_type;
    }
  }

  try {
    return hooks.closure_fn_type(value.func, ctx);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(
        "Core first-class closure parameter must use a scalar annotation:",
      )
    ) {
      return undefined;
    }

    throw error;
  }
}

function core_append_app_args<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): [CoreExpr, CoreExpr] | undefined {
  if (value.tag !== "app") {
    return undefined;
  }

  if (value.func.tag !== "var" || value.func.name !== "append") {
    return undefined;
  }

  if (ctx.statics.has(value.func.name) || ctx.fn_types.has(value.func.name)) {
    return undefined;
  }

  if (value.args.length !== 2) {
    return undefined;
  }

  const left = value.args[0];
  const right = value.args[1];
  expect(left, "Missing core append left operand");
  expect(right, "Missing core append right operand");

  if (!core_expr_is_text(left, ctx, hooks)) {
    return undefined;
  }

  if (!core_expr_is_text(right, ctx, hooks)) {
    return undefined;
  }

  return [left, right];
}

export function core_runtime_text_concat_operands<
  ctx extends CoreTextFactCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): [CoreExpr, CoreExpr] | undefined {
  if (value.tag !== "prim" || value.prim !== "i32.add") {
    return undefined;
  }

  if (hooks.static_text_value(value, ctx)) {
    return undefined;
  }

  const expected = Callable.arity(Prim, value.prim);
  expect(
    value.args.length === expected,
    "Primitive " + value.prim + " expects " + expected + " arguments",
  );
  const left = value.args[0];
  const right = value.args[1];
  expect(left, "Missing core text concat left operand");
  expect(right, "Missing core text concat right operand");

  if (!core_expr_is_text(left, ctx, hooks)) {
    return undefined;
  }

  if (!core_expr_is_text(right, ctx, hooks)) {
    return undefined;
  }

  return [left, right];
}

export function core_runtime_text_eq_operands<
  ctx extends CoreTextFactCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): RuntimeTextEq | undefined {
  if (value.tag !== "prim") {
    return undefined;
  }

  if (value.prim !== "i32.eq" && value.prim !== "i32.ne") {
    return undefined;
  }

  const expected = Callable.arity(Prim, value.prim);
  expect(
    value.args.length === expected,
    "Primitive " + value.prim + " expects " + expected + " arguments",
  );
  const left = value.args[0];
  const right = value.args[1];
  expect(left, "Missing core text equality left operand");
  expect(right, "Missing core text equality right operand");

  if (!core_expr_is_text(left, ctx, hooks)) {
    return undefined;
  }

  if (!core_expr_is_text(right, ctx, hooks)) {
    return undefined;
  }

  return { left, right, prim: value.prim };
}

function core_runtime_text_slice_args<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
): [CoreExpr, CoreExpr, CoreExpr] | undefined {
  if (value.tag !== "app") {
    return undefined;
  }

  if (value.func.tag !== "var" || value.func.name !== "slice") {
    return undefined;
  }

  expect(value.args.length === 3, "Core slice expects 3 arguments");
  const text = value.args[0];
  const start = value.args[1];
  const end = value.args[2];
  expect(text, "Missing core slice text argument");
  expect(start, "Missing core slice start argument");
  expect(end, "Missing core slice end argument");

  if (!core_expr_is_text(text, ctx, hooks)) {
    return undefined;
  }

  const start_type = hooks.expr_type(start, ctx);
  const end_type = hooks.expr_type(end, ctx);
  expect(start_type === "i32", "Core slice start must be i32");
  expect(end_type === "i32", "Core slice end must be i32");
  return [text, start, end];
}
