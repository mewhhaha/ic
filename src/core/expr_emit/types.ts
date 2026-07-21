import type { Prim as PrimNode, ValType } from "../../op.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr, CoreField, CoreFnType, CoreStmt } from "../ast.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import type { CoreScratchHeap } from "../scratch.ts";
import type { RuntimeTextEq } from "../text_facts.ts";
import type {
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "../runtime_union.ts";

export type CoreExprEmitCtx = {
  allocation_permits:
    import("../allocation_emission.ts").CoreAllocationPermitState;
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  static_capture_values?: Map<string, CoreExpr>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  borrowed_locals?: Set<string>;
  frozen_locals?: Set<string>;
  heap: {
    needed: boolean;
  };
  scratch: CoreScratchHeap;
  scratch_loop_resets: string[];
  scratch_return_resets: string[];
  scratch_depth?: number;
  next_loop: number;
  next_temp: number;
  break_label: string | undefined;
  break_value_type: ValType | undefined;
  continue_label: string | undefined;
  text_layout: {
    offsets: Map<string, number>;
  };
};

export type CoreExprEmitHooks<ctx extends CoreExprEmitCtx> = {
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
  check_core_text_concat_operand_visibility: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => void;
  check_closure_call_args: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: ctx,
  ) => void;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreFnType | undefined;
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  collect_stmt_locals: (stmt: CoreStmt, ctx: ctx) => void;
  core_typed_prim: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => PrimNode;
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: ctx,
  ) => DynamicUnionIf | undefined;
  emit_core_app: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    ctx: ctx,
  ) => Wat;
  emit_core_if_let_expr: (
    expr: Extract<CoreExpr, { tag: "if_let" }>,
    ctx: ctx,
  ) => Wat;
  emit_dynamic_index_expr: (
    fields: CoreField[],
    index: CoreExpr,
    ctx: ctx,
  ) => Wat;
  emit_runtime_closure: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: ctx,
  ) => Wat;
  emit_runtime_text_byte_index: (
    object: CoreExpr,
    index: CoreExpr,
    ctx: ctx,
  ) => Wat;
  emit_runtime_text_concat: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => Wat;
  emit_runtime_text_eq: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => Wat;
  emit_runtime_union_value: (expr: CoreExpr, ctx: ctx) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  is_runtime_text_concat: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => boolean;
  runtime_text_eq_operands: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => RuntimeTextEq | undefined;
  runtime_aggregate_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  same_runtime_aggregate_type_expr: (
    left: CoreExpr | undefined,
    right: CoreExpr | undefined,
    ctx: ctx,
  ) => boolean;
  runtime_union_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  runtime_union_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
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
  same_runtime_union_type_expr: (
    left: CoreExpr,
    right: CoreExpr,
    ctx: ctx,
  ) => boolean;
  static_collection_fields: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreField[] | undefined;
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
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_runtime_union_match_branch_ctx: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: ctx,
  ) => ctx;
  static_union_case: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
  static_text_byte_index_expr: (
    expr: Extract<CoreExpr, { tag: "index" }>,
    ctx: ctx,
  ) => CoreExpr | undefined;
  static_text_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
};
