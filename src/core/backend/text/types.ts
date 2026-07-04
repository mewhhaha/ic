import type { ValType } from "../../../op.ts";
import type { Wat } from "../../../wat.ts";
import type {
  Core as CoreNode,
  CoreExpr,
  CoreField,
  CoreFnType,
  CoreStmt,
} from "../../ast.ts";
import type { CoreEmitCtx } from "../../emit_ctx.ts";
import type { DynamicUnionIf } from "../../if_let.ts";
import type { CoreCtx, StaticCtx } from "../../local_collect.ts";
import type {
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "../../runtime_union.ts";
import type { TextLayout } from "../../text_layout.ts";
import type { RuntimeTextEq } from "../../text_facts.ts";

export type CoreBackendTextApi = {
  core_binding_value: (
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    ctx: StaticCtx,
  ) => CoreExpr;
  core_type_const_value: (
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    value: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  check_closure_call_args: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: StaticCtx,
  ) => void;
  bind_core_if_let_payload_fact: (
    value_name: string | undefined,
    union_case: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: StaticCtx,
  ) => void;
  bind_dynamic_if_let_payload: (
    case_name: string,
    value_name: string | undefined,
    target: DynamicUnionIf,
    ctx: StaticCtx,
  ) => void;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreFnType | undefined;
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => DynamicUnionIf | undefined;
  runtime_union_match_info: (
    case_name: string,
    target: RuntimeUnionTarget,
    ctx: StaticCtx,
  ) => RuntimeUnionMatchInfo;
  runtime_union_target: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => RuntimeUnionTarget | undefined;
  emit_expr: (expr: CoreExpr, ctx: CoreEmitCtx) => Wat;
  expr_type: (expr: CoreExpr, ctx: StaticCtx) => ValType;
  static_runtime_union_match_branch_ctx: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: StaticCtx,
  ) => StaticCtx;
  static_collection_fields: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreField[] | undefined;
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
  static_union_case: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};

export type CoreBackendText = {
  build_text_layout: (core: CoreNode, core_ctx: CoreCtx) => TextLayout;
  check_core_text_concat_operand_visibility: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: StaticCtx,
  ) => void;
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
  emit_runtime_text_byte_index: (
    collection: CoreExpr,
    index: CoreExpr,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_runtime_text_append: (
    left: CoreExpr,
    right: CoreExpr,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_runtime_text_concat: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_runtime_text_eq: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_runtime_text_index_assign: (
    stmt: Extract<CoreStmt, { tag: "index_assign" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_runtime_text_len: (collection: CoreExpr, ctx: CoreEmitCtx) => Wat;
  emit_runtime_text_slice: (
    text: CoreExpr,
    start: CoreExpr,
    end: CoreExpr,
    ctx: CoreEmitCtx,
  ) => Wat;
  static_text_byte_index_expr: (
    expr: Extract<CoreExpr, { tag: "index" }>,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_text_if_branches: (
    expr: Extract<CoreExpr, { tag: "if" }>,
    ctx: StaticCtx,
  ) =>
    | {
      then_text: CoreExpr;
      else_text: CoreExpr;
    }
    | undefined;
  text_byte_index_expr: (text: CoreExpr, index: CoreExpr) => CoreExpr;
  static_text_length_expr: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_text_value: (expr: CoreExpr, ctx: StaticCtx) => CoreExpr | undefined;
};
