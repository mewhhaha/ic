import type { ValType } from "../../op.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "../ast.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import type { StaticStructIfBranches } from "../struct_static.ts";
import type { StaticTextIfBranches } from "../text_static.ts";
import type { ScratchFreeStaticValueHooks } from "./scratch_free.ts";

export type StaticValueCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  frozen_locals?: Set<string>;
  scratch_depth?: number;
  next_temp: number;
};

export type StaticValueHooks<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
> = ScratchFreeStaticValueHooks<ctx> & {
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: ctx,
  ) => DynamicUnionIf | undefined;
  collect_expr_locals: (expr: CoreExpr, ctx: ctx) => void;
  collect_stmt_locals: (stmt: CoreStmt, ctx: ctx) => void;
  emit_expr: (expr: CoreExpr, ctx: emit_ctx) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: emit_ctx, is_final: boolean) => Wat;
  is_stable_static_expr: (expr: CoreExpr) => boolean;
  static_struct_if_branches: (
    expr: Extract<CoreExpr, { tag: "if" }>,
    ctx: ctx,
  ) => StaticStructIfBranches | undefined;
  static_struct_update_value: (
    expr: Extract<CoreExpr, { tag: "struct_update" }>,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_text_if_branches: (
    expr: Extract<CoreExpr, { tag: "if" }>,
    ctx: ctx,
  ) => StaticTextIfBranches | undefined;
};

export type StaticValueRecognitionHooks<ctx> = ScratchFreeStaticValueHooks<ctx>;

export type StaticValuePlan = {
  value: CoreExpr;
  setup: Wat;
};
