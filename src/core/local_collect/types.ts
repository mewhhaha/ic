import type { ValType } from "../../op.ts";
import type { Wat } from "../../wat.ts";
import type {
  CoreExpr,
  CoreField,
  CoreFnType,
  CoreHostImport,
  CoreStmt,
} from "../ast.ts";
import type { CoreLamCapturePlan } from "../closure_capture.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import type { StaticIndexAssignPlan } from "../index_assign.ts";
import type { RuntimeUnionTarget } from "../runtime_union.ts";
import type { StaticValuePlan } from "../static_values.ts";
import type { RuntimeTextEq } from "../text_facts.ts";
import type { RuntimeAggregateIndexAssignPlan } from "../index_assign.ts";

export type StaticCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  frozen_locals?: Set<string>;
  host_imports?: Map<string, CoreHostImport>;
  scratch_depth?: number;
};

export type TempCtx = StaticCtx & {
  next_temp: number;
};

export type CoreCtx = TempCtx & {
  next_loop: number;
};

export type CoreLocalCollectHooks = {
  bind_core_assignment_union_type: (
    name: string,
    value: CoreExpr,
    mode: "same" | "change",
    ctx: StaticCtx,
  ) => void;
  bind_core_assignment_struct_type: (
    name: string,
    value: CoreExpr,
    mode: "same" | "change",
    ctx: StaticCtx,
  ) => void;
  bind_core_fn_type: (
    name: string,
    value: CoreExpr,
    ctx: StaticCtx,
  ) => void;
  bind_core_struct_type: (
    name: string,
    value: CoreExpr,
    annotation: string | undefined,
    ctx: StaticCtx,
  ) => void;
  bind_core_if_let_payload_fact: (
    value_name: string | undefined,
    union_case: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: StaticCtx,
  ) => void;
  bind_core_union_type: (
    name: string,
    value: CoreExpr,
    annotation: string | undefined,
    ctx: StaticCtx,
  ) => void;
  bind_dynamic_if_let_payload: (
    case_name: string,
    value_name: string | undefined,
    target: DynamicUnionIf,
    ctx: StaticCtx,
  ) => void;
  bind_rec_initial_params: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "rec" }>,
    ctx: StaticCtx,
  ) => void;
  check_closure_call_args: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: StaticCtx,
  ) => void;
  check_core_type_pattern: (
    pattern: Extract<CoreStmt, { tag: "type_check" }>["pattern"],
    target: CoreExpr,
    ctx: StaticCtx,
  ) => void;
  check_rec_tail_call_args: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "rec" }>,
    ctx: StaticCtx,
  ) => void;
  clear_core_local_facts: (name: string, ctx: StaticCtx) => void;
  clear_optional_core_union_local: (
    name: string | undefined,
    ctx: StaticCtx,
  ) => void;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreFnType | undefined;
  closure_fn_type_with_expected: (
    expr: CoreExpr,
    expected: CoreFnType,
    ctx: StaticCtx,
  ) => CoreFnType | undefined;
  collect_runtime_union_value_locals: (
    expr: CoreExpr,
    ctx: CoreCtx,
  ) => boolean;
  collect_scoped_static_core_call_locals: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: CoreCtx,
  ) => void;
  core_binding_value: (
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    ctx: StaticCtx,
  ) => CoreExpr;
  core_expr_has_runtime_text_fact: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => boolean;
  core_expr_is_text: (value: CoreExpr, ctx: StaticCtx) => boolean;
  core_runtime_text_concat_operands: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => [CoreExpr, CoreExpr] | undefined;
  core_runtime_text_eq_operands: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => RuntimeTextEq | undefined;
  core_type_const_value: (
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    value: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => DynamicUnionIf | undefined;
  expr_type: (expr: CoreExpr, ctx: StaticCtx) => ValType;
  is_core_rec_tail_call: (
    expr: CoreExpr,
  ) => expr is Extract<CoreExpr, { tag: "app" }>;
  is_static_value_expr: (expr: CoreExpr, ctx: StaticCtx) => boolean;
  merge_if_else_static_assignments: (
    stmt: CoreStmt,
    cond: CoreExpr,
    then_statics: Map<string, CoreExpr>,
    else_statics: Map<string, CoreExpr>,
    ctx: TempCtx,
    emit_ctx: undefined,
  ) => Wat;
  plan_core_lam_capture: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: CoreCtx,
    emit_setup: boolean,
  ) => CoreLamCapturePlan | undefined;
  plan_core_static_index_assign: (
    target: Extract<CoreExpr, { tag: "struct_value" }>,
    index: CoreExpr,
    value: CoreExpr,
    ctx: CoreCtx,
    emit_ctx: undefined,
  ) => StaticIndexAssignPlan;
  plan_core_runtime_aggregate_index_assign: (
    type_expr: CoreExpr,
    stmt: Extract<CoreStmt, { tag: "index_assign" }>,
    ctx: CoreCtx,
  ) => RuntimeAggregateIndexAssignPlan;
  plan_static_capture_expr: (
    prefix: string,
    value: CoreExpr,
    ctx: TempCtx,
    emit_ctx: undefined,
  ) => StaticValuePlan;
  plan_static_value_expr: (
    value: CoreExpr,
    ctx: CoreCtx,
    emit_ctx: undefined,
  ) => StaticValuePlan;
  runtime_union_target: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => RuntimeUnionTarget | undefined;
  same_core_fn_type: (left: CoreFnType, right: CoreFnType) => boolean;
  static_collection_fields: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreField[] | undefined;
  static_collection_item_type: (
    fields: CoreField[],
    ctx: StaticCtx,
  ) => ValType | undefined;
  static_core_call_target: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_core_call_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_struct_binding: (
    name: string,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_text_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_union_case: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};
