import type { ValType } from "../../../../op.ts";
import type { CoreExpr, CoreField } from "../../../ast.ts";
import type { StaticCtx } from "../../../local_collect.ts";
import type { StaticStructIfBranches } from "../../../struct_static.ts";

export type CoreBackendStructApi = {
  expr_type: (expr: CoreExpr, ctx: StaticCtx) => ValType;
  runtime_aggregate_type_expr: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_core_call_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreExpr | undefined;
  static_core_call_target: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
};

export type CoreBackendStruct = {
  static_collection_fields: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => CoreField[] | undefined;
  static_struct_binding: (
    name: string,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_struct_if_branches: (
    expr: Extract<CoreExpr, { tag: "if" }>,
    ctx: StaticCtx,
  ) => StaticStructIfBranches | undefined;
  static_struct_update_value: (
    expr: Extract<CoreExpr, { tag: "struct_update" }>,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: StaticCtx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
};
