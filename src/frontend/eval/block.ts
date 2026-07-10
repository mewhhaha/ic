import { expect } from "../../expect.ts";
import type { Env, FrontExpr, Stmt } from "../ast.ts";
import { assignment_type } from "../annotations.ts";
import { capture_expr } from "../capture.ts";
import { unresolved_import_route } from "../diagnostic.ts";
import { clone_env, lookup, push_binding } from "../env.ts";
import { same_type } from "../types.ts";
import type { FrontEvalHooks } from "./types.ts";

export type FrontBlockEvalApi = {
  eval_front_block: (
    stmts: Stmt[],
    env: Env,
    hooks: FrontEvalHooks,
  ) => FrontExpr;
  eval_front_value: (
    expr: FrontExpr,
    env: Env,
    hooks: FrontEvalHooks,
  ) => FrontExpr;
};

export function eval_front_block_impl(
  stmts: Stmt[],
  env: Env,
  hooks: FrontEvalHooks,
  api: FrontBlockEvalApi,
): FrontExpr {
  const local = clone_env(env);

  for (let index = 0; index < stmts.length; index += 1) {
    const stmt = stmts[index];
    expect(stmt, "Missing frontend block statement " + index);
    const is_final = index + 1 >= stmts.length;

    if (stmt.tag === "import") {
      throw new Error(
        "Cannot evaluate unresolved import; " + unresolved_import_route,
      );
    }

    if (stmt.tag === "host_import") {
      throw new Error(
        "Cannot evaluate host import declaration at compile time",
      );
    }

    if (stmt.tag === "expr") {
      const value = api.eval_front_value(stmt.expr, local, hooks);

      if (is_final) {
        return value;
      }

      continue;
    }

    if (stmt.tag === "return") {
      return api.eval_front_value(stmt.value, local, hooks);
    }

    if (stmt.tag === "bind") {
      if (stmt.is_linear) {
        throw new Error(
          "Cannot evaluate linear binding at compile time: " + stmt.name,
        );
      }

      const value_env = clone_env(local);
      let value = stmt.value;

      if (stmt.kind === "const") {
        value = hooks.prepare_const_value(value, value_env);
      } else {
        value = api.eval_front_value(value, value_env, hooks);
      }

      let value_type = hooks.infer_expr(value, value_env);

      if (stmt.annotation) {
        if (stmt.kind === "const") {
          hooks.check_binding_annotation(stmt.annotation, value, value_env);
          value = hooks.apply_annotation_context(
            stmt.annotation,
            value,
            value_env,
          );
          value_type = hooks.infer_expr(value, value_env);
        } else {
          const annotated = hooks.apply_runtime_binding_annotation(
            stmt.annotation,
            value,
            value_env,
          );
          value = annotated.value;
          value_type = annotated.type;
        }
      }

      push_binding(local, {
        name: stmt.name,
        ic_name: stmt.name,
        type: value_type,
        is_const: true,
        is_linear: false,
        value,
        value_env,
      });

      continue;
    }

    if (stmt.tag === "assign") {
      const previous = lookup(local, stmt.name);
      expect(previous, "Cannot assign unbound name: " + stmt.name);
      const value_env = clone_env(local);
      const value = api.eval_front_value(stmt.value, value_env, hooks);
      let value_type = hooks.infer_expr(value, value_env);

      if (stmt.mode === "same" && !same_type(previous.type, value_type)) {
        throw new Error("Assignment changes type for " + stmt.name);
      }

      value_type = assignment_type(previous.type, value_type, stmt.mode);

      push_binding(local, {
        name: stmt.name,
        ic_name: stmt.name,
        type: value_type,
        is_const: true,
        is_linear: false,
        value,
        value_env: undefined,
      });

      continue;
    }

    if (stmt.tag === "index_assign") {
      const previous = lookup(local, stmt.name);
      expect(previous, "Cannot assign unbound name: " + stmt.name);
      const value = hooks.apply_index_assignment(stmt, local);

      push_binding(local, {
        name: stmt.name,
        ic_name: stmt.name,
        type: hooks.infer_expr(value, local),
        is_const: true,
        is_linear: false,
        value,
        value_env: undefined,
      });

      continue;
    }

    if (stmt.tag === "for_range") {
      const expanded = hooks.expand_for_range(stmt, local);
      const rest = stmts.slice(index + 1);
      return api.eval_front_block([...expanded, ...rest], local, hooks);
    }

    if (stmt.tag === "for_collection") {
      const expanded = hooks.expand_for_collection(stmt, local);
      const rest = stmts.slice(index + 1);
      return api.eval_front_block([...expanded, ...rest], local, hooks);
    }

    if (stmt.tag === "if_stmt") {
      const cond = hooks.eval_i32_expr(
        stmt.cond,
        local,
        "module if condition",
      );

      if (cond !== 0) {
        const rest = stmts.slice(index + 1);
        return api.eval_front_block(
          [...stmt.body, ...rest],
          clone_env(local),
          hooks,
        );
      }

      continue;
    }

    if (stmt.tag === "if_let_stmt") {
      const target = hooks.resolve_union_value(stmt.target, local);

      if (!target) {
        throw new Error("Cannot evaluate dynamic module if let yet");
      }

      if (target.expr.name === stmt.case_name) {
        const rest = stmts.slice(index + 1);
        let body = stmt.body;

        if (stmt.value_name) {
          const value = target.expr.value;

          if (!value) {
            throw new Error("Union case has no payload: " + stmt.case_name);
          }

          body = [
            {
              tag: "bind",
              kind: "let",
              name: stmt.value_name,
              is_linear: false,
              annotation: undefined,
              value: capture_expr(value, target.env),
            },
            ...stmt.body,
          ];
        }

        return api.eval_front_block(
          [...body, ...rest],
          clone_env(local),
          hooks,
        );
      }

      continue;
    }

    if (stmt.tag === "type_check") {
      hooks.check_type_pattern(stmt, local);
      continue;
    }

    if (stmt.tag === "break" || stmt.tag === "continue") {
      throw new Error("Cannot evaluate module " + stmt.tag + " yet");
    }

    if (stmt.tag === "state_bind" || stmt.tag === "bind_pattern") {
      throw new Error("Cannot evaluate module " + stmt.tag + " yet");
    }

    if (stmt.tag === "resume_dup") {
      throw new Error(
        "Resumption duplication must be elaborated before module evaluation",
      );
    }

    throw new Error("Cannot evaluate module " + stmt.feature + " yet");
  }

  throw new Error("Module block has no result expression");
}
