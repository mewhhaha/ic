import type { Func } from "../../../mod.ts";
import type { ValType } from "../../../op.ts";
import type { Wat } from "../../../wat.ts";
import type { CoreExpr, CoreFnType, CoreParam, CoreStmt } from "../../ast.ts";
import type {
  CoreCaptureInfo,
  CoreLamCapturePlan,
} from "../../closure_capture.ts";
import type {
  ClosureEmitCtx,
  CoreClosureLiftedBodyInput,
} from "../../closure_emit.ts";
import type { CoreEmitCtx } from "../../emit_ctx.ts";
import type { DynamicUnionIf } from "../../if_let.ts";
import type { CoreCtx, StaticCtx, TempCtx } from "../../local_collect.ts";
import type {
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "../../runtime_union.ts";
import type { RuntimeUnionPayloadEmitBinding } from "../../runtime_union_emit.ts";
import type { RuntimeTextHeap } from "../../runtime_text.ts";
import type { CoreScratchHeap } from "../../scratch.ts";
import type { TextLayout } from "../../text_layout.ts";

export type CoreBackendClosureApi = {
  apply_core_parameter_annotation: (
    param: CoreParam,
    value: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr;
  branch_payload_ctx: (ctx: CoreEmitCtx) => CoreEmitCtx;
  clear_core_local_facts: (name: string, ctx: StaticCtx) => void;
  collect_expr_locals: (expr: CoreExpr, ctx: CoreEmitCtx) => void;
  collect_stmt_locals: (stmt: CoreStmt, ctx: CoreCtx) => void;
  core_expr_is_text: (expr: CoreExpr, ctx: StaticCtx) => boolean;
  create_lifted_body_ctx: (input: CoreClosureLiftedBodyInput) => CoreEmitCtx;
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => DynamicUnionIf | undefined;
  emit_expr: (expr: CoreExpr, ctx: CoreEmitCtx) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: CoreEmitCtx, is_final: boolean) => Wat;
  expr_type: (expr: CoreExpr, ctx: StaticCtx) => ValType;
  match_branch_ctx: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: CoreEmitCtx,
  ) => RuntimeUnionPayloadEmitBinding<CoreEmitCtx>;
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
  scoped_static_core_call_fn_type: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: StaticCtx,
  ) => CoreFnType | undefined;
  static_annotation_type_value: (
    annotation: string,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_core_call_requires_scope: (
    target: Extract<CoreExpr, { tag: "lam" }>,
  ) => boolean;
  static_core_call_target: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_core_call_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_runtime_union_match_branch_ctx: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: StaticCtx,
  ) => StaticCtx;
  static_struct_binding: (name: string, ctx: StaticCtx) => CoreExpr | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_union_case: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};

export type CoreBackendClosure = {
  check_closure_call_args: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
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
  core_lam_capture_info: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: StaticCtx,
  ) => CoreCaptureInfo;
  core_lam_capture_names: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: StaticCtx,
  ) => string[] | undefined;
  emit_core_closure_if_expr: (
    expr: Extract<CoreExpr, { tag: "if" }>,
    fn_type: CoreFnType,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_core_closure_if_let_expr: (
    expr: Extract<CoreExpr, { tag: "if_let" }>,
    fn_type: CoreFnType,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_dynamic_closure_call: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_lifted_closure_funcs: (
    text_layout: TextLayout,
    closures: ClosureEmitCtx,
    heap: RuntimeTextHeap,
    scratch: CoreScratchHeap,
  ) => Func[];
  emit_runtime_closure: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: CoreEmitCtx,
  ) => Wat;
  emit_runtime_closure_with_type: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    fn_type: CoreFnType,
    ctx: CoreEmitCtx,
  ) => Wat;
  plan_core_lam_capture: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: TempCtx,
    emit_setup: boolean,
  ) => CoreLamCapturePlan | undefined;
};
