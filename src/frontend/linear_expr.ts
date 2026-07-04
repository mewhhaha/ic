import { expect } from "../expect.ts";
import type { FrontExpr, Stmt } from "./ast.ts";
import {
  clone_linear_closures,
  type LinearClosureBinding,
  type LinearClosureEnv,
  type LinearClosureRef,
  merge_used_linear_closures,
  resolve_linear_closure_ref,
} from "./linear_closure.ts";
import { same_name_set, same_names } from "./linear_state.ts";

export type LinearUseMode = "assignment" | "bind" | "discard" | "final";

export type LinearExprHooks = {
  validate_linear_block: (
    stmts: Stmt[],
    available: Set<string>,
    closures: LinearClosureEnv,
    active_calls: Set<string>,
  ) => void;
};

export function consume_linear_expr(
  expr: FrontExpr,
  available: Set<string>,
  mode: LinearUseMode,
  closures: LinearClosureEnv,
  active_calls: Set<string>,
  hooks: LinearExprHooks,
): string[] {
  const consumed: string[] = [];

  function consume(name: string): void {
    if (!available.has(name)) {
      throw new Error("Linear value " + name + " was already consumed");
    }

    if (consumed.includes(name)) {
      throw new Error("Linear value " + name + " used more than once");
    }

    available.delete(name);
    consumed.push(name);
  }

  function walk(item: FrontExpr, is_root: boolean): void {
    if (item.tag === "linear") {
      consume(item.name);
      return;
    }

    if (item.tag === "var" && available.has(item.name)) {
      if (mode === "final" && is_root) {
        consume(item.name);
        return;
      }

      throw new Error(
        "Linear value " + item.name + " used without explicit consumption",
      );
    }

    if (item.tag === "app") {
      const closure = resolve_linear_closure_ref(item.func, closures);

      if (closure && closure.expr.params.length === item.args.length) {
        consume_linear_closure_call(
          linear_closure_call_name(item.func),
          closure,
          item.args,
        );
        return;
      }

      if (
        item.func.tag === "field" && item.func.object.tag === "var" &&
        available.has(item.func.object.name)
      ) {
        consume(item.func.object.name);
      } else {
        walk(item.func, false);
      }

      for (const arg of item.args) {
        walk(arg, false);
      }

      return;
    }

    if (item.tag === "prim") {
      walk(item.left, false);
      walk(item.right, false);
      return;
    }

    if (item.tag === "field") {
      walk(item.object, false);
      return;
    }

    if (item.tag === "index") {
      walk(item.object, false);
      walk(item.index, false);
      return;
    }

    if (item.tag === "block") {
      const before = new Set(available);
      const block_closures = clone_linear_closures(closures);
      hooks.validate_linear_block(
        item.statements,
        available,
        block_closures,
        active_calls,
      );
      merge_used_linear_closures(closures, block_closures);

      for (const name of before) {
        if (!available.has(name) && !consumed.includes(name)) {
          consumed.push(name);
        }
      }

      return;
    }

    if (item.tag === "if") {
      consume_linear_condition(
        item.cond,
        available,
        closures,
        active_calls,
        hooks,
      );
      const before = new Set(available);
      const then_branch = consume_linear_branch(
        item.then_branch,
        before,
        mode,
        closures,
        active_calls,
        hooks,
      );
      const else_branch = consume_linear_branch(
        item.else_branch,
        before,
        mode,
        closures,
        active_calls,
        hooks,
      );
      merge_linear_branches(
        available,
        consumed,
        closures,
        then_branch,
        else_branch,
      );
      return;
    }

    if (item.tag === "if_let") {
      consume_linear_condition(
        item.target,
        available,
        closures,
        active_calls,
        hooks,
      );
      const before = new Set(available);
      const then_branch = consume_linear_branch(
        item.then_branch,
        before,
        mode,
        closures,
        active_calls,
        hooks,
      );
      const else_branch = consume_linear_branch(
        item.else_branch,
        before,
        mode,
        closures,
        active_calls,
        hooks,
      );
      merge_linear_branches(
        available,
        consumed,
        closures,
        then_branch,
        else_branch,
      );
      return;
    }
  }

  function linear_closure_call_name(func: FrontExpr): string {
    if (func.tag === "var") {
      return func.name;
    }

    return "<inline>";
  }

  function consume_linear_closure_call(
    name: string,
    closure: LinearClosureRef,
    args: FrontExpr[],
  ): void {
    if (active_calls.has(name)) {
      throw new Error(
        "Cannot validate recursive linear closure call yet: " + name,
      );
    }

    for (const arg of args) {
      walk(arg, false);
    }

    active_calls.add(name);
    const before = new Set(available);
    const local_available = new Set(available);
    const local_closures = clone_linear_closures(closures);
    const param_names = new Set<string>();

    for (const param of closure.expr.params) {
      param_names.add(param.name);
      local_closures.delete(param.name);

      if (param.is_linear) {
        local_available.add(param.name);
      } else {
        local_available.delete(param.name);
      }
    }

    if (closure.expr.body.tag === "block") {
      hooks.validate_linear_block(
        closure.expr.body.statements,
        local_available,
        local_closures,
        active_calls,
      );
    } else {
      consume_linear_expr(
        closure.expr.body,
        local_available,
        "final",
        local_closures,
        active_calls,
        hooks,
      );
    }

    active_calls.delete(name);

    for (const param of closure.expr.params) {
      if (param.is_linear && local_available.has(param.name)) {
        throw new Error("Linear value " + param.name + " was not consumed");
      }
    }

    let consumed_outer_linear = false;

    for (const used of before) {
      if (param_names.has(used)) {
        continue;
      }

      if (!local_available.has(used)) {
        consumed_outer_linear = true;
      }
    }

    if (consumed_outer_linear && closure.binding) {
      if (closures.used.has(closure.binding)) {
        throw new Error("Linear closure " + name + " was already consumed");
      }

      closures.used.add(closure.binding);
    }

    merge_used_linear_closures(closures, local_closures);

    for (const used of before) {
      if (param_names.has(used)) {
        continue;
      }

      if (!local_available.has(used)) {
        if (consumed.includes(used)) {
          throw new Error("Linear value " + used + " used more than once");
        }

        available.delete(used);
        consumed.push(used);
      }
    }
  }

  walk(expr, true);

  if (mode === "discard" && consumed.length > 0) {
    const name = consumed[0];
    expect(name, "Missing discarded linear value");
    throw new Error("Linear value " + name + " is consumed but not rebound");
  }

  return consumed;
}

export type LinearBranch = {
  available: Set<string>;
  consumed: string[];
  used_closures: Set<LinearClosureBinding>;
};

export function consume_linear_condition(
  expr: FrontExpr,
  available: Set<string>,
  closures: LinearClosureEnv,
  active_calls: Set<string>,
  hooks: LinearExprHooks,
): void {
  const condition_available = new Set(available);
  consume_linear_expr(
    expr,
    condition_available,
    "discard",
    clone_linear_closures(closures),
    new Set(active_calls),
    hooks,
  );
}

export function consume_linear_branch(
  expr: FrontExpr,
  available: Set<string>,
  mode: LinearUseMode,
  closures: LinearClosureEnv,
  active_calls: Set<string>,
  hooks: LinearExprHooks,
): LinearBranch {
  const branch_available = new Set(available);
  const branch_closures = clone_linear_closures(closures);
  const branch_consumed = consume_linear_expr(
    expr,
    branch_available,
    mode,
    branch_closures,
    new Set(active_calls),
    hooks,
  );
  return {
    available: branch_available,
    consumed: branch_consumed,
    used_closures: new Set(branch_closures.used),
  };
}

export function merge_linear_branches(
  available: Set<string>,
  consumed: string[],
  closures: LinearClosureEnv,
  left: LinearBranch,
  right: LinearBranch,
): void {
  if (!same_names(left.consumed, right.consumed)) {
    throw new Error("Linear branches must consume the same values");
  }

  if (!same_name_set(left.available, right.available)) {
    throw new Error("Linear branches must leave the same available values");
  }

  if (
    !same_linear_closure_binding_set(
      left.used_closures,
      right.used_closures,
    )
  ) {
    throw new Error("Linear branches must consume the same closures");
  }

  available.clear();

  for (const name of left.available) {
    available.add(name);
  }

  for (const name of left.consumed) {
    if (!consumed.includes(name)) {
      consumed.push(name);
    }
  }

  for (const id of left.used_closures) {
    closures.used.add(id);
  }
}

function same_linear_closure_binding_set(
  left: Set<LinearClosureBinding>,
  right: Set<LinearClosureBinding>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const binding of left) {
    if (!right.has(binding)) {
      return false;
    }
  }

  return true;
}
