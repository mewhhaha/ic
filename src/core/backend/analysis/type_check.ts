import type { TypePattern } from "../../../type_syntax.ts";
import type { CoreExpr, CoreParam, CoreStmt } from "../../ast.ts";
import type { StaticCtx } from "../../local_collect.ts";
import {
  apply_core_parameter_annotation as apply_core_parameter_annotation_with_hooks,
  check_core_type_pattern as check_core_type_pattern_with_hooks,
  check_core_value_type_name as check_core_value_type_name_with_hooks,
  core_assignment_value as core_assignment_value_with_hooks,
  core_binding_value as core_binding_value_with_hooks,
  core_type_const_value as core_type_const_value_with_hooks,
  static_annotation_type_value as static_annotation_type_value_with_hooks,
} from "../../type_check.ts";
import { create_core_backend_type_check_hooks } from "./type_check/hooks.ts";
import type {
  CoreBackendTypeCheck,
  CoreBackendTypeCheckApi,
} from "./type_check/types.ts";

export type {
  CoreBackendTypeCheck,
  CoreBackendTypeCheckApi,
} from "./type_check/types.ts";

export function create_core_backend_type_check(
  api: CoreBackendTypeCheckApi,
): CoreBackendTypeCheck {
  const type_check_hooks = create_core_backend_type_check_hooks(api);

  function core_assignment_value(
    stmt: Extract<CoreStmt, { tag: "assign" }>,
    ctx: StaticCtx,
  ): CoreExpr {
    return core_assignment_value_with_hooks(stmt, ctx, type_check_hooks);
  }

  function apply_core_parameter_annotation(
    param: CoreParam,
    value: CoreExpr,
    ctx: StaticCtx,
  ): CoreExpr {
    return apply_core_parameter_annotation_with_hooks(
      param,
      value,
      ctx,
      type_check_hooks,
    );
  }

  function check_core_type_pattern(
    pattern: TypePattern,
    target: CoreExpr,
    ctx: StaticCtx,
  ): void {
    check_core_type_pattern_with_hooks(
      pattern,
      target,
      ctx,
      type_check_hooks,
    );
  }

  function check_core_value_type_name(
    label: string,
    expected_type_name: string,
    value: CoreExpr,
    ctx: StaticCtx,
  ): void {
    check_core_value_type_name_with_hooks(
      label,
      expected_type_name,
      value,
      ctx,
      type_check_hooks,
    );
  }

  function core_binding_value(
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    ctx: StaticCtx,
  ): CoreExpr {
    return core_binding_value_with_hooks(stmt, ctx, type_check_hooks);
  }

  function core_type_const_value(
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    value: CoreExpr,
    ctx: StaticCtx,
  ): CoreExpr | undefined {
    return core_type_const_value_with_hooks(
      stmt,
      value,
      ctx,
      type_check_hooks,
    );
  }

  function static_annotation_type_value(
    annotation: string,
    ctx: StaticCtx,
  ): CoreExpr | undefined {
    return static_annotation_type_value_with_hooks(
      annotation,
      ctx,
      type_check_hooks,
    );
  }

  return {
    apply_core_parameter_annotation,
    check_core_type_pattern,
    check_core_value_type_name,
    core_assignment_value,
    core_binding_value,
    core_type_const_value,
    static_annotation_type_value,
  };
}
