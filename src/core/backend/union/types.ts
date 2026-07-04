import type { ValType } from "../../../op.ts";
import type { Wat } from "../../../wat.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "../../ast.ts";
import type { CoreEmitCtx } from "../../emit_ctx.ts";
import type { DynamicUnionIf } from "../../if_let.ts";
import type { CoreCtx, StaticCtx } from "../../local_collect.ts";
import type {
  RuntimeUnionInfo,
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "../../runtime_union.ts";
import type { RuntimeUnionPayloadEmitBinding } from "../../runtime_union_emit.ts";

export type CoreBackendUnionApi = {
  block_ctx: (ctx: StaticCtx) => StaticCtx;
  check_closure_call_args: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: StaticCtx,
  ) => void;
  check_core_value_type_name: (
    label: string,
    expected_name: string,
    value: CoreExpr,
    ctx: StaticCtx,
  ) => void;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreFnType | undefined;
  collect_expr_locals: (expr: CoreExpr, ctx: CoreCtx) => void;
  collect_stmt_locals: (stmt: CoreStmt, ctx: StaticCtx) => void;
  core_expr_is_text: (expr: CoreExpr, ctx: StaticCtx) => boolean;
  emit_expr: (expr: CoreExpr, ctx: CoreEmitCtx) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: CoreEmitCtx, is_final: boolean) => Wat;
  expr_type: (expr: CoreExpr, ctx: StaticCtx) => ValType;
  match_branch_ctx: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: CoreEmitCtx,
  ) => RuntimeUnionPayloadEmitBinding<CoreEmitCtx>;
  merge_if_else_static_assignments: (
    stmt: CoreStmt,
    cond: CoreExpr,
    then_statics: Map<string, CoreExpr>,
    else_statics: Map<string, CoreExpr>,
    ctx: CoreEmitCtx,
    emit_ctx: CoreEmitCtx,
  ) => Wat;
  runtime_aggregate_type_expr: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  same_runtime_aggregate_type_expr: (
    left: CoreExpr,
    right: CoreExpr,
    ctx: StaticCtx,
  ) => boolean;
  scoped_static_core_call_value: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: StaticCtx,
  ) => { value: CoreExpr; ctx: StaticCtx };
  static_core_call_requires_scope: (
    target: Extract<CoreExpr, { tag: "lam" }>,
  ) => boolean;
  static_core_call_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_core_call_target: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_type_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
};

export type CoreBackendUnion = {
  bind_dynamic_if_let_payload: (
    case_name: string,
    value_name: string | undefined,
    target: DynamicUnionIf,
    ctx: StaticCtx,
  ) => void;
  collect_runtime_union_value_locals: (
    expr: CoreExpr,
    ctx: CoreCtx,
  ) => boolean;
  core_runtime_union_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => DynamicUnionIf | undefined;
  emit_runtime_union_if_let_expr: (
    expr: Extract<CoreExpr, { tag: "if_let" }>,
    target: RuntimeUnionTarget,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_runtime_union_if_let_stmt: (
    stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
    target: RuntimeUnionTarget,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_runtime_union_value: (expr: CoreExpr, ctx: CoreEmitCtx) => Wat;
  runtime_union_case_info: (
    value: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: StaticCtx,
  ) => RuntimeUnionInfo;
  runtime_union_match_info: (
    case_name: string,
    target: RuntimeUnionTarget,
    ctx: StaticCtx,
  ) => RuntimeUnionMatchInfo;
  runtime_union_target: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => RuntimeUnionTarget | undefined;
  runtime_union_type_expr: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  runtime_union_value_type: (value: CoreExpr, ctx: StaticCtx) => ValType;
  static_runtime_union_match_branch_ctx: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: StaticCtx,
  ) => StaticCtx;
  static_union_case: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};
