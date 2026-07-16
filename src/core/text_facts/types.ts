import type {
  CoreExpr,
  CoreField,
  CoreFnType,
  CoreHostImport,
  CoreStmt,
} from "../ast.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import type { RuntimeAggregateTypeHooks } from "../runtime_aggregate.ts";
import type {
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "../runtime_union.ts";
import type { ValType } from "../../op.ts";
export type { RuntimeTextEq } from "../runtime_text/types.ts";

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
    core_binding_value: (
      stmt: Extract<CoreStmt, { tag: "bind" }>,
      ctx: ctx,
    ) => CoreExpr;
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
