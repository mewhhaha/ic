import type { CoreExpr, CoreField, CoreFnType, CoreStmt } from "../ast.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import type { RuntimeUnionPayloadHooks } from "../runtime_union_payload.ts";
import type { TypeStaticCtx } from "../type_static.ts";
import type { CoreHostImportCtx } from "../host_import.ts";
import type { StaticCoreCallCtx } from "../static_call.ts";
export type {
  RuntimeUnionInfo,
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "../model/runtime_union.ts";

export type RuntimeUnionCtx =
  & TypeStaticCtx
  & CoreHostImportCtx
  & StaticCoreCallCtx;

export type RuntimeUnionHooks<ctx extends RuntimeUnionCtx> =
  & RuntimeUnionPayloadHooks<ctx>
  & {
    block_ctx: (ctx: ctx) => ctx;
    check_closure_call_args: (
      expr: Extract<CoreExpr, { tag: "app" }>,
      fn_type: CoreFnType,
      ctx: ctx,
    ) => void;
    closure_fn_type: (expr: CoreExpr, ctx: ctx) => CoreFnType | undefined;
    collect_stmt_locals: (stmt: CoreStmt, ctx: ctx) => void;
    dynamic_union_if: (expr: CoreExpr, ctx: ctx) => DynamicUnionIf | undefined;
    scoped_static_core_call_value: (
      expr: Extract<CoreExpr, { tag: "app" }>,
      target: Extract<CoreExpr, { tag: "lam" }>,
      ctx: ctx,
    ) => { value: CoreExpr; ctx: ctx };
    static_core_call_requires_scope: (
      target: Extract<CoreExpr, { tag: "lam" }>,
    ) => boolean;
    static_core_call_target: (
      expr: CoreExpr,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
    static_core_call_value: (
      expr: CoreExpr,
      ctx: ctx,
    ) => CoreExpr | undefined;
    static_collection_fields: (
      expr: CoreExpr,
      ctx: ctx,
    ) => CoreField[] | undefined;
    static_union_case: (
      expr: CoreExpr,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
  };
