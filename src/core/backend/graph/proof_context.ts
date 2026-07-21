import type { CoreExpr, CoreStmt } from "../../ast.ts";
import type { CoreBorrowClosureCtx } from "../../borrow.ts";
import type { CoreHostBoundaryClosureCtx } from "../../host_boundary.ts";
import type { CoreCtx } from "../../local_collect.ts";
import { closure_param_info } from "../../closure_type/param.ts";
import { runtime_union_match_info } from "../../runtime_union.ts";
import type { RuntimeUnionMatchInfo } from "../../runtime_union.ts";
import { bind_runtime_union_match_payload_temps } from "../../runtime_union_match.ts";
import {
  core_val_type_from_type_name,
  static_type_value,
} from "../../type_static.ts";
import { create_child_core_ctx } from "./context.ts";
import { core_probe_index_assign_error } from "./proof_unsupported.ts";
import type { CoreBackendGraph } from "./types.ts";

export function core_borrow_closure_body_ctx(
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: CoreCtx,
): CoreBorrowClosureCtx<CoreCtx> {
  const closure_ctx = create_child_core_ctx(ctx);

  for (const param of expr.params) {
    if (param.is_const) {
      return {
        tag: "skip",
        reason: "Cannot analyze closure-body borrows before const parameter " +
          "specialization: " + param.name,
      };
    }

    if (!param.annotation) {
      return {
        tag: "skip",
        reason: "Cannot analyze closure-body borrows without parameter " +
          "annotation: " + param.name,
      };
    }

    const info = closure_param_info(param, ctx, {
      static_annotation_type_value: (annotation, annotation_ctx) =>
        static_type_value(
          { tag: "var", name: annotation },
          annotation_ctx,
        ),
    });

    if (!info) {
      return {
        tag: "skip",
        reason: "Cannot analyze closure-body borrows for parameter " +
          "annotation: " + param.annotation,
      };
    }

    closure_ctx.locals.set(param.name, info.type);

    if (info.fn_type) {
      closure_ctx.fn_types.set(param.name, info.fn_type);
    } else {
      closure_ctx.fn_types.delete(param.name);
    }

    if (info.is_text) {
      closure_ctx.text_locals.add(param.name);
    } else {
      closure_ctx.text_locals.delete(param.name);
    }

    if (info.struct_type) {
      closure_ctx.struct_locals.set(param.name, info.struct_type);
    } else {
      closure_ctx.struct_locals.delete(param.name);
    }

    if (info.union_type) {
      closure_ctx.union_locals.set(param.name, info.union_type);
    } else {
      closure_ctx.union_locals.delete(param.name);
    }

    if (closure_ctx.frozen_locals) {
      closure_ctx.frozen_locals.delete(param.name);
    }
  }

  return {
    tag: "scan",
    ctx: closure_ctx,
  };
}

export function core_host_boundary_closure_body_ctx(
  backend: CoreBackendGraph,
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: CoreCtx,
): CoreHostBoundaryClosureCtx<CoreCtx> {
  let closure_ctx: CoreCtx | undefined;

  try {
    closure_ctx = core_drop_closure_body_ctx(backend, expr, ctx);
  } catch (error) {
    if (core_probe_index_assign_error(error)) {
      return { tag: "skip" };
    }

    throw error;
  }

  if (!closure_ctx) {
    return { tag: "skip" };
  }

  return {
    tag: "scan",
    ctx: closure_ctx,
  };
}

export function core_drop_closure_body_ctx(
  backend: CoreBackendGraph,
  expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: CoreCtx,
): CoreCtx | undefined {
  const closure_ctx = create_child_core_ctx(ctx);
  let has_const_param = false;

  for (const param of expr.params) {
    if (param.is_const) {
      has_const_param = true;
      continue;
    }

    const annotation = param.annotation;

    if (!annotation) {
      return undefined;
    }

    if (annotation.startsWith("&") || annotation.startsWith("^")) {
      const member = annotation.slice(1);
      const type_expr = { tag: "var", name: member } as const;
      const type_value = static_type_value(type_expr, ctx);
      const value_type = core_val_type_from_type_name(member);
      closure_ctx.locals.set(param.name, value_type || "i32");
      closure_ctx.fn_types.delete(param.name);

      if (member === "Text" || member === "Bytes") {
        closure_ctx.text_locals.add(param.name);
      } else {
        closure_ctx.text_locals.delete(param.name);
      }

      if (type_value?.tag === "struct_type") {
        closure_ctx.struct_locals.set(param.name, type_expr);
      } else {
        closure_ctx.struct_locals.delete(param.name);
      }

      if (type_value?.tag === "union_type") {
        closure_ctx.union_locals.set(param.name, type_expr);
      } else {
        closure_ctx.union_locals.delete(param.name);
      }

      if (closure_ctx.frozen_locals) {
        if (annotation.startsWith("^")) {
          closure_ctx.frozen_locals.add(param.name);
        } else {
          closure_ctx.frozen_locals.delete(param.name);
        }
      }

      if (closure_ctx.borrowed_locals) {
        if (annotation.startsWith("&")) {
          closure_ctx.borrowed_locals.add(param.name);
        } else {
          closure_ctx.borrowed_locals.delete(param.name);
        }
      }

      continue;
    }

    const info = closure_param_info(param, ctx, {
      static_annotation_type_value: (type_annotation, annotation_ctx) =>
        static_type_value(
          { tag: "var", name: type_annotation },
          annotation_ctx,
        ),
    });

    if (!info) {
      return undefined;
    }

    closure_ctx.locals.set(param.name, info.type);

    if (info.fn_type) {
      closure_ctx.fn_types.set(param.name, info.fn_type);
    } else {
      closure_ctx.fn_types.delete(param.name);
    }

    if (info.is_text) {
      closure_ctx.text_locals.add(param.name);
    } else {
      closure_ctx.text_locals.delete(param.name);
    }

    if (info.struct_type) {
      closure_ctx.struct_locals.set(param.name, info.struct_type);
    } else {
      closure_ctx.struct_locals.delete(param.name);
    }

    if (info.union_type) {
      closure_ctx.union_locals.set(param.name, info.union_type);
    } else {
      closure_ctx.union_locals.delete(param.name);
    }

    if (closure_ctx.frozen_locals) {
      closure_ctx.frozen_locals.delete(param.name);
    }

    if (closure_ctx.borrowed_locals) {
      closure_ctx.borrowed_locals.delete(param.name);
    }
  }

  if (has_const_param) {
    return closure_ctx;
  }

  backend.local_collect.collect_expr_locals(expr.body, closure_ctx);

  return closure_ctx;
}

export function core_drop_collection_loop_body_ctx(
  backend: CoreBackendGraph,
  stmt: Extract<CoreStmt, { tag: "collection_loop" }>,
  ctx: CoreCtx,
): { tag: "scan"; ctx: CoreCtx } | { tag: "skip" } {
  const fields = backend.struct.static_collection_fields(
    stmt.collection,
    ctx,
  );

  if (!fields) {
    const text = backend.text.static_text_value(stmt.collection, ctx);

    if (!text && !backend.text.core_expr_is_text(stmt.collection, ctx)) {
      return { tag: "skip" };
    }
  }

  const loop_ctx = create_child_core_ctx(ctx);
  backend.local_collect.collect_stmt_locals(stmt, loop_ctx);
  return { tag: "scan", ctx: loop_ctx };
}

export function create_core_runtime_union_match_child_ctx(
  value_name: string | undefined,
  info: RuntimeUnionMatchInfo,
  ctx: CoreCtx,
): CoreCtx {
  const branch_ctx = create_child_core_ctx(ctx);
  bind_runtime_union_match_payload_temps(value_name, info, branch_ctx);
  return branch_ctx;
}

export function core_drop_if_let_branch_ctx(
  backend: CoreBackendGraph,
  case_name: string,
  value_name: string | undefined,
  target: CoreExpr,
  ctx: CoreCtx,
):
  | { tag: "scan"; ctx: CoreCtx }
  | { tag: "skip" }
  | { tag: "unknown" } {
  const union_case = backend.union.static_union_case(target, ctx);

  if (union_case) {
    if (union_case.name !== case_name) {
      return { tag: "skip" };
    }

    const branch_ctx = create_child_core_ctx(ctx);
    backend.control_flow.bind_core_if_let_payload_fact(
      value_name,
      union_case,
      branch_ctx,
    );
    return { tag: "scan", ctx: branch_ctx };
  }

  const dynamic_target = backend.union.dynamic_union_if(target, ctx);

  if (dynamic_target) {
    if (
      dynamic_target.then_case.name !== case_name &&
      dynamic_target.else_case.name !== case_name
    ) {
      return { tag: "skip" };
    }

    const branch_ctx = create_child_core_ctx(ctx);
    backend.union.bind_dynamic_if_let_payload(
      case_name,
      value_name,
      dynamic_target,
      branch_ctx,
    );
    return { tag: "scan", ctx: branch_ctx };
  }

  const runtime_target = backend.union.runtime_union_target(target, ctx);

  if (runtime_target) {
    const info = runtime_union_match_info(
      case_name,
      runtime_target,
      ctx,
    );
    const branch_ctx = create_core_runtime_union_match_child_ctx(
      value_name,
      info,
      create_child_core_ctx(ctx),
    );
    return { tag: "scan", ctx: branch_ctx };
  }

  return { tag: "unknown" };
}
