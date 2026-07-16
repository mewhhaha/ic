import type { CoreExpr, CoreStmt } from "../../ast.ts";
import type { CoreCtx } from "../../local_collect.ts";
import {
  core_val_type_from_type_name,
  static_type_value,
} from "../../type_static.ts";
import { set_local } from "../../emit/local.ts";
import type { CoreBackendGraph } from "./types.ts";

export function core_unsafe_scratch_return_probe_error(
  error: unknown,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error.message.startsWith(
      "Cannot type core scratch block with unsafe scratch return ",
    )
  ) {
    return true;
  }

  return error.message.startsWith(
    "Cannot type core scratch block with non-scalar ",
  );
}

export function bind_unsafe_scratch_return_for_proof(
  backend: CoreBackendGraph,
  stmt: CoreStmt,
  ctx: CoreCtx,
): boolean {
  if (stmt.tag !== "bind") {
    return false;
  }

  const annotation = stmt.annotation;

  if (!annotation) {
    return false;
  }

  ctx.statics.delete(stmt.name);
  backend.local_facts.clear_core_local_facts(stmt.name, ctx);

  const scalar_type = core_val_type_from_type_name(annotation);

  if (scalar_type) {
    set_local(ctx.locals, stmt.name, scalar_type);

    if (annotation === "Text" || annotation === "Bytes") {
      ctx.text_locals.add(stmt.name);
    }

    return true;
  }

  const annotation_expr: CoreExpr = { tag: "var", name: annotation };
  const type_value = static_type_value(annotation_expr, ctx);

  if (!type_value) {
    return false;
  }

  if (type_value.tag === "struct_type") {
    set_local(ctx.locals, stmt.name, "i32");
    ctx.struct_locals.set(stmt.name, annotation_expr);
    return true;
  }

  if (type_value.tag === "union_type") {
    set_local(ctx.locals, stmt.name, "i32");
    ctx.union_locals.set(stmt.name, annotation_expr);
    return true;
  }

  return false;
}
