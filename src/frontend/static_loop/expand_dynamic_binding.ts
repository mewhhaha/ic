import { expect } from "../../expect.ts";
import type { Env, FrontType, Stmt } from "../ast.ts";
import { structured_core_route } from "../diagnostic.ts";
import { lookup } from "../env.ts";
import { same_type } from "../types.ts";
import {
  type DynamicLoopState,
  stmt_value_contains_loop_control,
} from "./dynamic_control.ts";
import {
  dynamic_loop_control_binding_fallback,
  dynamic_loop_control_binding_type,
  dynamic_loop_control_function_value,
  dynamic_loop_control_guarded_binding_value,
  dynamic_loop_control_value_with_implicit_fallback,
} from "./fallback.ts";
import type { StaticLoopHooks } from "./types.ts";

export function dynamic_loop_control_binding(
  stmt: Extract<Stmt, { tag: "bind" }>,
  env: Env,
  hooks: StaticLoopHooks,
  state: DynamicLoopState,
): Extract<Stmt, { tag: "bind" }> {
  if (
    (stmt.kind !== "let" && stmt.kind !== "const") ||
    stmt.is_linear ||
    stmt_value_contains_loop_control(stmt)
  ) {
    throw new Error(
      "Cannot lower local binding after dynamic loop control yet: " +
        stmt.name +
        structured_core_route,
    );
  }

  const binding_type = dynamic_loop_control_binding_type(stmt, env, hooks);
  let value = dynamic_loop_control_value_with_implicit_fallback(
    stmt.value,
    binding_type,
    env,
    hooks,
  );

  if (binding_type.tag === "fn") {
    value = dynamic_loop_control_function_value(value, env, hooks);
  }

  if (binding_type.tag === "unknown") {
    return {
      ...stmt,
      kind: "let",
      value: {
        tag: "if",
        cond: { tag: "var", name: state.step_name },
        then_branch: value,
        else_branch: { tag: "num", type: "i32", value: 0 },
        implicit_else: true,
      },
    };
  }

  const guarded_value = dynamic_loop_control_guarded_binding_value(
    stmt.name,
    binding_type,
    value,
    env,
    hooks,
    state,
  );

  if (guarded_value) {
    return {
      ...stmt,
      kind: "let",
      value: guarded_value,
    };
  }

  const fallback = dynamic_loop_control_binding_fallback(
    stmt.name,
    binding_type,
    value,
    env,
    hooks,
  );

  return {
    ...stmt,
    kind: "let",
    value: {
      tag: "if",
      cond: { tag: "var", name: state.step_name },
      then_branch: value,
      else_branch: fallback,
    },
  };
}

export function dynamic_loop_control_assignment(
  stmt: Extract<Stmt, { tag: "assign" }>,
  env: Env,
  hooks: StaticLoopHooks,
  state: DynamicLoopState,
): Extract<Stmt, { tag: "assign" }> | undefined {
  const previous = lookup(env, stmt.name);
  expect(previous, "Cannot assign unbound name: " + stmt.name);
  const assignment_type = dynamic_loop_control_assignment_type(
    stmt,
    previous.type,
    env,
    hooks,
  );

  if (assignment_type.tag !== "union_value") {
    return undefined;
  }

  if (
    !dynamic_loop_control_assignment_keeps_type(
      stmt,
      previous.type,
      assignment_type,
      env,
      hooks,
    ) ||
    stmt_value_contains_loop_control(stmt)
  ) {
    throw new Error(
      "Cannot lower local assignment after dynamic loop control yet: " +
        stmt.name +
        structured_core_route,
    );
  }

  const value = dynamic_loop_control_value_with_implicit_fallback(
    stmt.value,
    assignment_type,
    env,
    hooks,
  );

  return {
    ...stmt,
    value: {
      tag: "if",
      cond: { tag: "var", name: state.step_name },
      then_branch: value,
      else_branch: { tag: "var", name: stmt.name },
    },
  };
}

function dynamic_loop_control_assignment_keeps_type(
  stmt: Extract<Stmt, { tag: "assign" }>,
  previous_type: FrontType,
  assignment_type: FrontType,
  env: Env,
  hooks: StaticLoopHooks,
): boolean {
  if (stmt.mode === "same") {
    return true;
  }

  if (previous_type.tag === "unknown") {
    return false;
  }

  const inferred = hooks.infer_expr(stmt.value, env);

  if (
    previous_type.tag === "union_value" && inferred.tag === "union_value" &&
    inferred.cases.every((inferred_case) =>
      previous_type.cases.some((previous_case) =>
        previous_case.name === inferred_case.name &&
        (inferred_case.type_name === "unknown" ||
          previous_case.type_name === inferred_case.type_name)
      )
    )
  ) {
    return true;
  }

  if (!same_type(previous_type, assignment_type)) {
    return false;
  }

  if (inferred.tag !== "unknown") {
    return same_type(previous_type, inferred);
  }

  const cases = hooks.infer_union_cases(stmt.value, env);

  if (cases) {
    return same_type(previous_type, { tag: "union_value", cases });
  }

  return false;
}

function dynamic_loop_control_assignment_type(
  stmt: Extract<Stmt, { tag: "assign" }>,
  previous_type: FrontType,
  env: Env,
  hooks: StaticLoopHooks,
): FrontType {
  const inferred = hooks.infer_expr(stmt.value, env);

  if (previous_type.tag !== "unknown") {
    if (
      previous_type.tag === "union_value" && inferred.tag === "union" &&
      previous_type.cases.some((item) => item.name === inferred.case_name)
    ) {
      return previous_type;
    }

    if (
      previous_type.tag === "union_value" && inferred.tag === "union_value" &&
      inferred.cases.every((inferred_case) =>
        previous_type.cases.some((previous_case) =>
          previous_case.name === inferred_case.name &&
          (inferred_case.type_name === "unknown" ||
            previous_case.type_name === inferred_case.type_name)
        )
      )
    ) {
      return previous_type;
    }

    if (inferred.tag !== "unknown" && !same_type(previous_type, inferred)) {
      throw new Error("Assignment changes type for " + stmt.name);
    }

    return previous_type;
  }

  const cases = hooks.infer_union_cases(stmt.value, env);

  if (cases) {
    return { tag: "union_value", cases };
  }

  return inferred;
}
