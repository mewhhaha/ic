import type { Env, FrontExpr, Stmt } from "./ast.ts";
import type { CallSpecializeHooks } from "./call_specialize_types.ts";
import { lookup_field } from "./fields.ts";

export function contains_unresolved_linear_effect(
  expr: FrontExpr,
  names: Set<string>,
  env: Env,
  hooks: CallSpecializeHooks,
): boolean {
  switch (expr.tag) {
    case "bool":
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "type_name":
    case "set_type":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return false;

    case "is":
      return contains_unresolved_linear_effect(expr.value, names, env, hooks);

    case "prim":
      return contains_unresolved_linear_effect(expr.left, names, env, hooks) ||
        contains_unresolved_linear_effect(expr.right, names, env, hooks);

    case "lam":
    case "rec":
      return false;

    case "app": {
      if (expr.func.tag === "field") {
        if (uses_linear_name(expr.func.object, names)) {
          if (!known_linear_method(expr.func, env, hooks)) {
            return true;
          }
        } else if (
          contains_unresolved_linear_effect(expr.func, names, env, hooks)
        ) {
          return true;
        }
      } else if (
        contains_unresolved_linear_effect(expr.func, names, env, hooks)
      ) {
        return true;
      }

      for (const arg of expr.args) {
        if (contains_unresolved_linear_effect(arg, names, env, hooks)) {
          return true;
        }
      }

      return false;
    }

    case "block":
      return contains_unresolved_linear_stmt(
        expr.statements,
        names,
        env,
        hooks,
      );

    case "comptime":
      return contains_unresolved_linear_effect(expr.expr, names, env, hooks);

    case "borrow":
      return contains_unresolved_linear_effect(expr.value, names, env, hooks);

    case "freeze":
      return contains_unresolved_linear_effect(expr.value, names, env, hooks);

    case "scratch":
      return contains_unresolved_linear_effect(expr.body, names, env, hooks);

    case "loop":
      return contains_unresolved_linear_stmt(expr.body, names, env, hooks);

    case "captured":
      return contains_unresolved_linear_effect(
        expr.expr,
        names,
        expr.env,
        hooks,
      );

    case "handler": {
      const local = new Set(names);

      for (const state of expr.state) {
        if (
          contains_unresolved_linear_effect(state.value, local, env, hooks)
        ) {
          return true;
        }

        local.delete(state.name);
      }

      for (const clause of expr.clauses) {
        const clause_names = shadow_linear_params(local, clause.params);

        if (
          contains_unresolved_linear_effect(
            clause.body,
            clause_names,
            env,
            hooks,
          )
        ) {
          return true;
        }
      }

      const return_names = shadow_linear_params(
        local,
        [expr.return_clause.param],
      );
      return contains_unresolved_linear_effect(
        expr.return_clause.body,
        return_names,
        env,
        hooks,
      );
    }

    case "try_with":
      return contains_unresolved_linear_effect(expr.body, names, env, hooks) ||
        contains_unresolved_linear_effect(expr.handler, names, env, hooks);

    case "with": {
      if (contains_unresolved_linear_effect(expr.base, names, env, hooks)) {
        return true;
      }

      for (const field of expr.fields) {
        if (contains_unresolved_linear_effect(field.value, names, env, hooks)) {
          return true;
        }
      }

      return false;
    }

    case "struct_value": {
      if (
        contains_unresolved_linear_effect(expr.type_expr, names, env, hooks)
      ) {
        return true;
      }

      for (const field of expr.fields) {
        if (contains_unresolved_linear_effect(field.value, names, env, hooks)) {
          return true;
        }
      }

      return false;
    }

    case "struct_update": {
      if (contains_unresolved_linear_effect(expr.base, names, env, hooks)) {
        return true;
      }

      for (const field of expr.fields) {
        if (contains_unresolved_linear_effect(field.value, names, env, hooks)) {
          return true;
        }
      }

      return false;
    }

    case "if":
      return contains_unresolved_linear_effect(expr.cond, names, env, hooks) ||
        contains_unresolved_linear_effect(
          expr.then_branch,
          names,
          env,
          hooks,
        ) ||
        contains_unresolved_linear_effect(
          expr.else_branch,
          names,
          env,
          hooks,
        );

    case "if_let":
      return contains_unresolved_linear_effect(
        expr.target,
        names,
        env,
        hooks,
      ) ||
        contains_unresolved_linear_effect(
          expr.then_branch,
          names,
          env,
          hooks,
        ) ||
        contains_unresolved_linear_effect(
          expr.else_branch,
          names,
          env,
          hooks,
        );

    case "field":
      return contains_unresolved_linear_effect(expr.object, names, env, hooks);

    case "index":
      return contains_unresolved_linear_effect(
        expr.object,
        names,
        env,
        hooks,
      ) ||
        contains_unresolved_linear_effect(expr.index, names, env, hooks);

    case "union_case":
      if (!expr.value) {
        return false;
      }

      return contains_unresolved_linear_effect(expr.value, names, env, hooks);
  }
}

function contains_unresolved_linear_stmt(
  stmts: Stmt[],
  names: Set<string>,
  env: Env,
  hooks: CallSpecializeHooks,
): boolean {
  for (const stmt of stmts) {
    switch (stmt.tag) {
      case "import":
      case "host_import":
      case "continue":
      case "type_check":
      case "unsupported":
        break;

      case "break":
        if (
          stmt.value &&
          contains_unresolved_linear_effect(stmt.value, names, env, hooks)
        ) {
          return true;
        }
        break;

      case "bind":
      case "state_bind":
      case "bind_pattern":
      case "resume_dup":
        if (contains_unresolved_linear_effect(stmt.value, names, env, hooks)) {
          return true;
        }
        break;

      case "assign":
        if (contains_unresolved_linear_effect(stmt.value, names, env, hooks)) {
          return true;
        }
        break;

      case "index_assign":
        if (
          contains_unresolved_linear_effect(stmt.index, names, env, hooks) ||
          contains_unresolved_linear_effect(stmt.value, names, env, hooks)
        ) {
          return true;
        }
        break;

      case "expr":
        if (contains_unresolved_linear_effect(stmt.expr, names, env, hooks)) {
          return true;
        }
        break;

      case "return":
        if (contains_unresolved_linear_effect(stmt.value, names, env, hooks)) {
          return true;
        }
        break;

      case "for_range":
        if (
          contains_unresolved_linear_effect(stmt.start, names, env, hooks) ||
          contains_unresolved_linear_effect(stmt.end, names, env, hooks) ||
          contains_unresolved_linear_effect(stmt.step, names, env, hooks) ||
          contains_unresolved_linear_stmt(stmt.body, names, env, hooks)
        ) {
          return true;
        }
        break;

      case "for_collection":
        if (
          contains_unresolved_linear_effect(
            stmt.collection,
            names,
            env,
            hooks,
          ) ||
          contains_unresolved_linear_stmt(stmt.body, names, env, hooks)
        ) {
          return true;
        }
        break;

      case "if_stmt":
        if (
          contains_unresolved_linear_effect(stmt.cond, names, env, hooks) ||
          contains_unresolved_linear_stmt(stmt.body, names, env, hooks)
        ) {
          return true;
        }
        break;

      case "if_let_stmt":
        if (
          contains_unresolved_linear_effect(stmt.target, names, env, hooks) ||
          contains_unresolved_linear_stmt(stmt.body, names, env, hooks)
        ) {
          return true;
        }
        break;
    }
  }

  return false;
}

function shadow_linear_params(
  names: Set<string>,
  params: { name: string }[],
): Set<string> {
  const local = new Set(names);

  for (const param of params) {
    local.delete(param.name);
  }

  return local;
}

function known_linear_method(
  expr: Extract<FrontExpr, { tag: "field" }>,
  env: Env,
  hooks: CallSpecializeHooks,
): boolean {
  const target = hooks.resolve_struct_value(expr.object, env);

  if (!target) {
    return false;
  }

  if (target.expr.tag !== "struct_value") {
    return false;
  }

  const field = lookup_field(target.expr.fields, expr.name);

  if (!field) {
    return false;
  }

  return field.value.tag === "lam";
}

function uses_linear_name(expr: FrontExpr, names: Set<string>): boolean {
  if (expr.tag === "var" || expr.tag === "linear") {
    return names.has(expr.name);
  }

  if (expr.tag === "captured") {
    return uses_linear_name(expr.expr, names);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return uses_linear_name(expr.value, names);
  }

  if (expr.tag === "scratch") {
    return uses_linear_name(expr.body, names);
  }

  return false;
}
