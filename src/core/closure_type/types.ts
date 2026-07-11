import type { ValType } from "../../op.ts";
import type {
  CoreExpr,
  CoreFnType,
  CoreHostImport,
  CoreParam,
  CoreStmt,
} from "../ast.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import type {
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "../runtime_union.ts";

export type CoreClosureTypeCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  host_imports?: Map<string, CoreHostImport>;
};

export type CoreClosureTypeBlockCtx = CoreClosureTypeCtx & {
  next_loop: number;
  next_temp: number;
};

export type CoreClosureTypeHooks = {
  apply_core_parameter_annotation: (
    param: CoreParam,
    value: CoreExpr,
    ctx: CoreClosureTypeCtx,
  ) => CoreExpr;
  clear_core_local_facts: (name: string, ctx: CoreClosureTypeCtx) => void;
  collect_stmt_locals: (stmt: CoreStmt, ctx: CoreClosureTypeBlockCtx) => void;
  core_expr_is_text: (expr: CoreExpr, ctx: CoreClosureTypeCtx) => boolean;
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: CoreClosureTypeCtx,
  ) => DynamicUnionIf | undefined;
  core_lam_capture_names: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    ctx: CoreClosureTypeCtx,
  ) => string[] | undefined;
  expr_type: (expr: CoreExpr, ctx: CoreClosureTypeCtx) => ValType;
  runtime_union_type_expr: (
    expr: CoreExpr,
    ctx: CoreClosureTypeCtx,
  ) => CoreExpr | undefined;
  runtime_union_match_info: (
    case_name: string,
    target: RuntimeUnionTarget,
    ctx: CoreClosureTypeCtx,
  ) => RuntimeUnionMatchInfo;
  runtime_union_target: (
    expr: CoreExpr,
    ctx: CoreClosureTypeCtx,
  ) => RuntimeUnionTarget | undefined;
  scoped_static_core_call_fn_type: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: CoreClosureTypeCtx,
  ) => CoreFnType | undefined;
  static_annotation_type_value: (
    annotation: string,
    ctx: CoreClosureTypeCtx,
  ) => CoreExpr | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: CoreClosureTypeCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_core_call_requires_scope: (
    target: Extract<CoreExpr, { tag: "lam" }>,
  ) => boolean;
  static_core_call_target: (
    expr: CoreExpr,
    ctx: CoreClosureTypeCtx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_core_call_value: (
    expr: CoreExpr,
    ctx: CoreClosureTypeCtx,
  ) => CoreExpr | undefined;
  static_runtime_union_match_branch_ctx: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: CoreClosureTypeCtx,
  ) => CoreClosureTypeCtx;
  static_union_case: (
    expr: CoreExpr,
    ctx: CoreClosureTypeCtx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};

export type ClosureParamInfo = {
  type: ValType;
  is_text: boolean;
  constraint?: string;
  struct_type?: CoreExpr;
  union_type?: CoreExpr;
};
