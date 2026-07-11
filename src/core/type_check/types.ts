import type { ValType } from "../../op.ts";
import type { CoreExpr } from "../ast.ts";
import type { DynamicUnionIf } from "../if_let.ts";

export type CoreTypeValue = Extract<
  CoreExpr,
  { tag: "struct_type" | "union_type" }
>;

export type CoreTypeCheckCtx = {
  statics: Map<string, CoreExpr>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
};

export type CoreTypeCheckHooks<ctx extends CoreTypeCheckCtx> = {
  core_expr_is_text: (
    value: CoreExpr,
    ctx: ctx,
  ) => boolean;
  core_expr_has_runtime_text_fact: (
    value: CoreExpr,
    ctx: ctx,
  ) => boolean;
  core_runtime_text_concat_operands: (
    value: CoreExpr,
    ctx: ctx,
  ) => [CoreExpr, CoreExpr] | undefined;
  dynamic_union_if: (value: CoreExpr, ctx: ctx) => DynamicUnionIf | undefined;
  expr_type: (value: CoreExpr, ctx: ctx) => ValType;
  static_struct_value: (
    value: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_text_value: (value: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  static_type_level_value: (value: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  static_type_name: (value: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  static_type_value: (
    value: CoreExpr,
    ctx: ctx,
  ) => CoreTypeValue | undefined;
  static_union_case: (
    value: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
  runtime_union_type_expr: (
    value: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  runtime_aggregate_type_expr: (
    value: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  same_runtime_aggregate_type_expr: (
    left: CoreExpr,
    right: CoreExpr,
    ctx: ctx,
  ) => boolean;
};
