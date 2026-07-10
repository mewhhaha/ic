import type { CoreExpr, CoreField, CoreFnType } from "../ast.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import type {
  RuntimeUnionPayload,
  RuntimeUnionPayloadHooks,
} from "../runtime_union_payload.ts";
import type { TypeStaticCtx } from "../type_static.ts";
import type { CoreHostImportCtx } from "../host_import.ts";

export type RuntimeUnionCtx = TypeStaticCtx & CoreHostImportCtx & {
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
};

export type RuntimeUnionHooks<ctx extends RuntimeUnionCtx> =
  & RuntimeUnionPayloadHooks<ctx>
  & {
    check_closure_call_args: (
      expr: Extract<CoreExpr, { tag: "app" }>,
      fn_type: CoreFnType,
      ctx: ctx,
    ) => void;
    closure_fn_type: (expr: CoreExpr, ctx: ctx) => CoreFnType | undefined;
    dynamic_union_if: (expr: CoreExpr, ctx: ctx) => DynamicUnionIf | undefined;
    static_collection_fields: (
      expr: CoreExpr,
      ctx: ctx,
    ) => CoreField[] | undefined;
    static_union_case: (
      expr: CoreExpr,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
  };

export type RuntimeUnionInfo = {
  tag_value: number;
  size: number;
  payload: RuntimeUnionPayload;
};

export type RuntimeUnionTarget = {
  target: CoreExpr;
  type_expr: CoreExpr;
  type_value: Extract<CoreExpr, { tag: "union_type" }>;
};

export type RuntimeUnionMatchInfo = {
  case_name: string;
  tag_value: number;
  payload: RuntimeUnionPayload;
};
