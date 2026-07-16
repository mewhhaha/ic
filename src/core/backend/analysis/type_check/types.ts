import type { ValType } from "../../../../op.ts";
import type { TypePattern } from "../../../../type_syntax.ts";
import type { CoreExpr, CoreParam, CoreStmt } from "../../../ast.ts";
import type { DynamicUnionIf } from "../../../if_let.ts";
import type { StaticCtx } from "../../../local_collect.ts";

type CoreTypeValue = Extract<
  CoreExpr,
  { tag: "struct_type" | "union_type" }
>;

export type CoreBackendTypeCheckApi = {
  core_expr_is_text: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => boolean;
  core_expr_has_runtime_text_fact: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => boolean;
  core_runtime_text_concat_operands: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => [CoreExpr, CoreExpr] | undefined;
  dynamic_union_if: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => DynamicUnionIf | undefined;
  expr_type: (value: CoreExpr, ctx: StaticCtx) => ValType;
  runtime_union_type_expr: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  runtime_aggregate_type_expr: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  same_runtime_aggregate_type_expr: (
    left: CoreExpr,
    right: CoreExpr,
    ctx: StaticCtx,
  ) => boolean;
  static_struct_value: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_text_value: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_type_level_value: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_type_name: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_type_value: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => CoreTypeValue | undefined;
  static_union_case: (
    value: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};

export type CoreBackendTypeCheck = {
  apply_core_parameter_annotation: (
    param: CoreParam,
    value: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr;
  core_assignment_value: (
    stmt: Extract<CoreStmt, { tag: "assign" }>,
    ctx: StaticCtx,
  ) => CoreExpr;
  check_core_type_pattern: (
    pattern: TypePattern,
    target: CoreExpr,
    ctx: StaticCtx,
  ) => void;
  check_core_value_type_name: (
    label: string,
    expected_type_name: string,
    value: CoreExpr,
    ctx: StaticCtx,
  ) => void;
  core_binding_value: (
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    ctx: StaticCtx,
  ) => CoreExpr;
  core_type_const_value: (
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    value: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_annotation_type_value: (
    annotation: string,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
};
