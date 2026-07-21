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
    bind_core_assignment_struct_type: (
      name: string,
      value: CoreExpr,
      mode: "same" | "change",
      ctx: ctx,
    ) => void;
    bind_core_assignment_union_type: (
      name: string,
      value: CoreExpr,
      mode: "same" | "change",
      ctx: ctx,
    ) => void;
    bind_core_fn_type: (name: string, value: CoreExpr, ctx: ctx) => void;
    bind_core_struct_type: (
      name: string,
      value: CoreExpr,
      annotation: string | undefined,
      ctx: ctx,
    ) => void;
    bind_core_union_type: (
      name: string,
      value: CoreExpr,
      annotation: string | undefined,
      ctx: ctx,
    ) => void;
    expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
    core_binding_value: (
      stmt: Extract<CoreStmt, { tag: "bind" }>,
      ctx: ctx,
    ) => CoreExpr;
    core_assignment_value: (
      stmt: Extract<CoreStmt, { tag: "assign" }>,
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
