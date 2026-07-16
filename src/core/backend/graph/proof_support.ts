import type { CoreExpr, CoreStmt } from "../../ast.ts";
import type { CoreCtx } from "../../local_collect.ts";
import type { CoreUnsupportedCodegenIssue } from "../../proof.ts";
import { runtime_aggregate_field_info } from "../../runtime_aggregate.ts";
import { static_type_level_value } from "../../type_static.ts";
import { find_core_field } from "../../analysis/field.ts";
import type { CoreBackendGraph } from "./types.ts";
import { core_runtime_slice_fact } from "../../runtime_slice.ts";
import {
  core_probe_index_assign_error,
  core_unsupported_codegen_issue_from_analysis_error,
} from "./proof_unsupported.ts";

export function core_collection_loop_supported(
  backend: CoreBackendGraph,
  stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  ctx: CoreCtx,
): boolean {
  if (core_runtime_slice_fact(stmt.collection)) {
    return true;
  }
  const fields = backend.struct.static_collection_fields(
    stmt.collection,
    ctx,
  );

  if (fields) {
    return true;
  }

  const text = backend.text.static_text_value(stmt.collection, ctx);

  if (text) {
    return true;
  }

  return backend.text.core_expr_is_text(stmt.collection, ctx);
}

export function core_index_assign_supported(
  backend: CoreBackendGraph,
  stmt: Extract<CoreStmt, { tag: "index_assign" }>,
  ctx: CoreCtx,
): boolean {
  const static_target = backend.struct.static_struct_binding(
    stmt.name,
    ctx,
  );

  if (static_target) {
    return true;
  }

  if (ctx.text_locals.has(stmt.name)) {
    return true;
  }

  return ctx.struct_locals.has(stmt.name);
}

export function core_unsupported_final_expr_issue(
  backend: CoreBackendGraph,
  expr: CoreExpr,
  ctx: CoreCtx,
): CoreUnsupportedCodegenIssue | undefined {
  if (core_type_value_expr(expr, ctx)) {
    return {
      tag: "unsupported_codegen",
      node: "expr",
      feature: "type_value",
      message: "Cannot emit core type value expression yet",
    };
  }

  if (expr.tag === "app") {
    const app_issue = core_app_expr_unsupported_codegen_issue(
      backend,
      expr,
      ctx,
    );

    if (app_issue) {
      return app_issue;
    }
  }

  if (expr.tag === "field" && !core_field_expr_supported(backend, expr, ctx)) {
    return {
      tag: "unsupported_codegen",
      node: "expr",
      feature: "field",
      message: "Cannot emit core field expression yet",
    };
  }

  return undefined;
}

export function core_type_value_expr(
  expr: CoreExpr,
  ctx: CoreCtx,
): boolean {
  if (
    expr.tag === "type_name" ||
    expr.tag === "struct_type" ||
    expr.tag === "union_type"
  ) {
    return true;
  }

  if (expr.tag !== "var") {
    const type_value = maybe_core_static_type_level_value(expr, ctx);

    if (!type_value) {
      return false;
    }

    return core_static_value_is_type_value(type_value);
  }

  const type_value = maybe_core_static_type_level_value(expr, ctx);

  if (!type_value) {
    return false;
  }

  return core_static_value_is_type_value(type_value);
}

export function core_index_expr_supported(
  backend: CoreBackendGraph,
  expr: Extract<CoreExpr, { tag: "index" }>,
  ctx: CoreCtx,
): boolean {
  const fields = backend.struct.static_collection_fields(
    expr.object,
    ctx,
  );

  if (fields) {
    return true;
  }

  const text_byte = backend.text.static_text_byte_index_expr(expr, ctx);

  if (text_byte) {
    return true;
  }

  return backend.text.core_expr_is_text(expr.object, ctx);
}

export function core_if_let_target_supported(
  backend: CoreBackendGraph,
  target: CoreExpr,
  ctx: CoreCtx,
): boolean {
  const static_case = backend.union.static_union_case(target, ctx);

  if (static_case) {
    return true;
  }

  const dynamic_case = backend.union.dynamic_union_if(target, ctx);

  if (dynamic_case) {
    return true;
  }

  const runtime_target = backend.union.runtime_union_target(target, ctx);

  if (runtime_target) {
    return true;
  }

  return false;
}

function core_static_value_is_type_value(expr: CoreExpr): boolean {
  return expr.tag === "type_name" ||
    expr.tag === "struct_type" ||
    expr.tag === "union_type";
}

function maybe_core_static_type_level_value(
  expr: CoreExpr,
  ctx: CoreCtx,
): CoreExpr | undefined {
  try {
    return static_type_level_value(expr, ctx);
  } catch (error) {
    if (core_static_type_value_probe_error(error)) {
      return undefined;
    }

    throw error;
  }
}

function core_static_type_value_probe_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.message.startsWith("Core type constructor ")) {
    return true;
  }

  if (error.message.startsWith("Missing core type constructor ")) {
    return true;
  }

  return false;
}

function core_app_expr_unsupported_codegen_issue(
  backend: CoreBackendGraph,
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: CoreCtx,
): CoreUnsupportedCodegenIssue | undefined {
  const runtime_union_value = backend.union.core_runtime_union_value(
    expr,
    ctx,
  );

  if (runtime_union_value) {
    return undefined;
  }

  try {
    backend.app.app_type(expr, ctx);
    return undefined;
  } catch (error) {
    if (core_app_type_probe_error(error)) {
      return undefined;
    }

    const builtin_issue = core_unsupported_codegen_issue_from_analysis_error(
      error,
    );

    if (builtin_issue) {
      return builtin_issue;
    }

    if (core_generic_app_unsupported_type_error(error)) {
      return {
        tag: "unsupported_codegen",
        node: "expr",
        feature: "app",
        message: "Cannot emit core app expression yet",
      };
    }

    throw error;
  }
}

function core_app_type_probe_error(error: unknown): boolean {
  return core_probe_index_assign_error(error);
}

function core_generic_app_unsupported_type_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message === "Cannot type core app expression yet";
}

function core_field_expr_supported(
  backend: CoreBackendGraph,
  expr: Extract<CoreExpr, { tag: "field" }>,
  ctx: CoreCtx,
): boolean {
  const struct_value = backend.struct.static_struct_value(
    expr.object,
    ctx,
  );

  if (struct_value) {
    return find_core_field(struct_value.fields, expr.name) !== undefined;
  }

  const field_info = runtime_aggregate_field_info(expr.object, expr.name, ctx, {
    check_closure_call_args: backend.closure.check_closure_call_args,
    closure_fn_type: backend.closure.closure_fn_type,
  });

  return field_info !== undefined;
}
