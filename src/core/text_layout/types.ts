import type { DataSegment } from "../../mod.ts";
import type { CoreExpr, CoreStmt } from "../ast.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import type {
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "../runtime_union.ts";
import type { StaticTextCtx, StaticTextHooks } from "../text_static.ts";

export type TextLayout = {
  offsets: Map<string, number>;
  data: DataSegment[];
  heap_start: number;
};

export type CoreTextLayoutHooks = {
  bind_core_if_let_payload_fact: (
    value_name: string | undefined,
    union_case: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: StaticTextCtx,
  ) => void;
  bind_dynamic_if_let_payload: (
    case_name: string,
    value_name: string | undefined,
    target: DynamicUnionIf,
    ctx: StaticTextCtx,
  ) => void;
  core_binding_value: (
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    ctx: StaticTextCtx,
  ) => CoreExpr;
  core_type_const_value: (
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    value: CoreExpr,
    ctx: StaticTextCtx,
  ) => CoreExpr | undefined;
  dynamic_union_if: NonNullable<StaticTextHooks["dynamic_union_if"]>;
  expr_type: StaticTextHooks["expr_type"];
  runtime_union_match_info: (
    case_name: string,
    target: RuntimeUnionTarget,
    ctx: StaticTextCtx,
  ) => RuntimeUnionMatchInfo;
  runtime_union_target: (
    expr: CoreExpr,
    ctx: StaticTextCtx,
  ) => RuntimeUnionTarget | undefined;
  static_collection_fields: StaticTextHooks["static_collection_fields"];
  static_core_call_value: (
    expr: CoreExpr,
    ctx: StaticTextCtx,
  ) => CoreExpr | undefined;
  static_core_call_target: (
    expr: CoreExpr,
    ctx: StaticTextCtx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: StaticTextCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_runtime_union_match_branch_ctx: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: StaticTextCtx,
  ) => StaticTextCtx;
  static_union_case: NonNullable<StaticTextHooks["static_union_case"]>;
};
