import { expect } from "../../expect.ts";
import type { Env, FrontExpr, FrontType, Stmt } from "../ast.ts";
import { structured_core_route } from "../diagnostic.ts";
import { clone_env, lookup } from "../env.ts";
import { same_type } from "../types.ts";
import { record_static_loop_statement } from "./binding.ts";
import {
  contains_loop_control,
  dynamic_conditional_loop_control_body,
  type DynamicLoopState,
  guard_loop_step,
  loop_break_statements,
  loop_continue_statements,
  stmt_value_contains_loop_control,
} from "./dynamic_control.ts";
import {
  dynamic_loop_control_binding_fallback,
  dynamic_loop_control_binding_type,
  dynamic_loop_control_function_value,
  dynamic_loop_control_guarded_binding_value,
  dynamic_loop_control_value_with_implicit_fallback,
} from "./fallback.ts";
import { bind_static_if_let_payload } from "./if_let_payload.ts";
import type { StaticLoopBodyExpanders } from "./body.ts";
import type { ExpandedLoopBody, StaticLoopHooks } from "./types.ts";

export function expand_dynamic_loop_control_body(
  stmts: Stmt[],
  env: Env,
  hooks: StaticLoopHooks,
  state: DynamicLoopState,
  expanders: StaticLoopBodyExpanders,
): ExpandedLoopBody {
  const statements: Stmt[] = [];

  for (const stmt of stmts) {
    if (stmt.tag === "break") {
      statements.push(guard_loop_step(state, loop_break_statements(state)));
      return { statements, control: "none" };
    }

    if (stmt.tag === "continue") {
      statements.push(guard_loop_step(state, loop_continue_statements(state)));
      return { statements, control: "none" };
    }

    if (stmt.tag === "return") {
      statements.push(guard_loop_step(state, [stmt]));
      return { statements, control: "none" };
    }

    if (stmt.tag === "bind") {
      const binding = dynamic_loop_control_binding(stmt, env, hooks, state);
      statements.push(binding);
      record_static_loop_statement(binding, env);
      continue;
    }

    if (stmt.tag === "assign") {
      const assignment = dynamic_loop_control_assignment(
        stmt,
        env,
        hooks,
        state,
      );

      if (assignment) {
        statements.push(assignment);
        record_static_loop_statement(assignment, env);
        continue;
      }
    }

    if (stmt.tag === "for_range") {
      const body = expanders.expand_for_range_body(stmt, env, hooks);

      if (body.statements.length > 0) {
        statements.push(guard_loop_step(state, body.statements));
      }

      continue;
    }

    if (stmt.tag === "for_collection") {
      const body = expanders.expand_for_collection_body(stmt, env, hooks);

      if (body.statements.length > 0) {
        statements.push(guard_loop_step(state, body.statements));
      }

      continue;
    }

    if (stmt.tag === "if_stmt") {
      const cond = hooks.resolve_static_i32_expr(stmt.cond, env);

      if (cond !== undefined) {
        if (cond !== 0) {
          const body = expand_dynamic_loop_control_body(
            stmt.body,
            env,
            hooks,
            state,
            expanders,
          );
          statements.push(...body.statements);
        }

        continue;
      }

      const conditional_body = dynamic_conditional_loop_control_body(
        stmt.body,
        state,
      );

      if (conditional_body) {
        statements.push(
          guard_loop_step(state, [{
            tag: "if_stmt",
            cond: stmt.cond,
            body: conditional_body,
          }]),
        );
        continue;
      }

      if (contains_loop_control(stmt.body)) {
        const body = expand_dynamic_loop_control_body(
          stmt.body,
          env,
          hooks,
          state,
          expanders,
        );
        statements.push(
          guard_loop_step(state, [{
            tag: "if_stmt",
            cond: stmt.cond,
            body: body.statements,
          }]),
        );
        continue;
      }

      statements.push(guard_loop_step(state, [stmt]));
      continue;
    }

    if (stmt.tag === "if_let_stmt") {
      const target = hooks.resolve_union_value(stmt.target, env);

      if (target) {
        if (target.expr.name !== stmt.case_name) {
          continue;
        }

        const body = expand_dynamic_if_let_control_body(
          stmt,
          target,
          env,
          hooks,
          state,
          expanders,
        );
        statements.push(...body.statements);
        continue;
      }

      const conditional_body = dynamic_conditional_loop_control_body(
        stmt.body,
        state,
      );

      if (conditional_body) {
        statements.push(
          guard_loop_step(state, [{
            tag: "if_let_stmt",
            case_name: stmt.case_name,
            value_name: stmt.value_name,
            target: stmt.target,
            body: conditional_body,
          }]),
        );
        continue;
      }

      if (contains_loop_control(stmt.body)) {
        const body = expand_dynamic_loop_control_body(
          stmt.body,
          env,
          hooks,
          state,
          expanders,
        );
        statements.push(
          guard_loop_step(state, [{
            tag: "if_let_stmt",
            case_name: stmt.case_name,
            value_name: stmt.value_name,
            target: stmt.target,
            body: body.statements,
          }]),
        );
        continue;
      }

      statements.push(guard_loop_step(state, [stmt]));
      continue;
    }

    statements.push(guard_loop_step(state, [stmt]));
  }

  return { statements, control: "none" };
}

function dynamic_loop_control_binding(
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

function dynamic_loop_control_assignment(
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

  let value = dynamic_loop_control_value_with_implicit_fallback(
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

  if (!same_type(previous_type, assignment_type)) {
    return false;
  }

  const inferred = hooks.infer_expr(stmt.value, env);

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

function expand_dynamic_if_let_control_body(
  stmt: Extract<Stmt, { tag: "if_let_stmt" }>,
  target: { expr: Extract<FrontExpr, { tag: "union_case" }>; env: Env },
  env: Env,
  hooks: StaticLoopHooks,
  state: DynamicLoopState,
  expanders: StaticLoopBodyExpanders,
): ExpandedLoopBody {
  if (!stmt.value_name) {
    return expand_dynamic_loop_control_body(
      stmt.body,
      env,
      hooks,
      state,
      expanders,
    );
  }

  const body_env = clone_env(env);
  bind_static_if_let_payload(stmt, target, body_env, hooks);
  return expand_dynamic_loop_control_body(
    stmt.body,
    body_env,
    hooks,
    state,
    expanders,
  );
}
