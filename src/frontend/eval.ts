import { expect } from "../expect.ts";
import type {
  Env,
  FrontExpr,
  FrontType,
  ResolvedFrontExpr,
  Stmt,
} from "./ast.ts";
import { assignment_type } from "./annotations.ts";
import { capture_deferred_expr, capture_expr } from "./capture.ts";
import { validate_const_expr } from "./constness.ts";
import { unresolved_import_route } from "./diagnostic.ts";
import { clone_env, lookup, push_binding } from "./env.ts";
import { call_message } from "./fields.ts";
import { same_type } from "./types.ts";

type ResolvedUnionValue = {
  expr: Extract<FrontExpr, { tag: "union_case" }>;
  env: Env;
};

export type FrontEvalHooks = {
  apply_annotation_context: (
    annotation: string,
    value: FrontExpr,
    env: Env,
  ) => FrontExpr;
  apply_index_assignment: (
    stmt: Extract<Stmt, { tag: "index_assign" }>,
    env: Env,
  ) => FrontExpr;
  apply_runtime_binding_annotation: (
    annotation: string,
    value: FrontExpr,
    env: Env,
  ) => { value: FrontExpr; type: FrontType };
  check_binding_annotation: (
    annotation: string,
    value: FrontExpr,
    env: Env,
  ) => void;
  check_type_pattern: (
    stmt: Extract<Stmt, { tag: "type_check" }>,
    env: Env,
  ) => void;
  eval_const_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
    allow_unmarked_params: boolean,
  ) => FrontExpr | undefined;
  eval_i32_expr: (expr: FrontExpr, env: Env, label: string) => number;
  expand_for_collection: (
    stmt: Extract<Stmt, { tag: "for_collection" }>,
    env: Env,
  ) => Stmt[];
  expand_for_range: (
    stmt: Extract<Stmt, { tag: "for_range" }>,
    env: Env,
  ) => Stmt[];
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  inline_deferred_const_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  prepare_const_value: (expr: FrontExpr, env: Env) => FrontExpr;
  resolve_const_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => FrontExpr | undefined;
  resolve_index_expr: (
    expr: Extract<FrontExpr, { tag: "index" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_struct_field_expr: (
    expr: Extract<FrontExpr, { tag: "field" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_union_constructor_call: (
    expr: Extract<FrontExpr, { tag: "app" }>,
    env: Env,
  ) => ResolvedFrontExpr | undefined;
  resolve_union_value: (
    expr: FrontExpr,
    env: Env,
  ) => ResolvedUnionValue | undefined;
  visible_text_value: (
    expr: FrontExpr,
    env: Env,
    seen: Set<string>,
  ) => FrontExpr | undefined;
};

export function eval_front_value(
  expr: FrontExpr,
  env: Env,
  hooks: FrontEvalHooks,
): FrontExpr {
  if (expr.tag === "block") {
    return eval_front_block(expr.statements, env, hooks);
  }

  if (expr.tag === "comptime") {
    validate_const_expr(
      expr.expr,
      env,
      new Set(),
      "comptime expression requires compile-time values",
    );
    return eval_front_value(expr.expr, env, hooks);
  }

  if (expr.tag === "app") {
    if (expr.func.tag === "var" && expr.func.name === "fail") {
      throw new Error("fail: " + call_message(expr.args));
    }

    const union_value = hooks.resolve_union_constructor_call(expr, env);

    if (union_value) {
      return union_value.expr;
    }

    const value = hooks.eval_const_call(expr, env, true);

    if (value) {
      return value;
    }

    const deferred = hooks.inline_deferred_const_call(expr, env);

    if (deferred) {
      return capture_expr(deferred.expr, deferred.env);
    }
  }

  if (expr.tag === "prim") {
    const text_value = hooks.visible_text_value(expr, env, new Set());

    if (text_value) {
      return eval_front_value(text_value, env, hooks);
    }
  }

  if (expr.tag === "field") {
    const const_field = hooks.resolve_const_field_expr(expr, env);

    if (const_field) {
      return eval_front_value(const_field, env, hooks);
    }

    const struct_field = hooks.resolve_struct_field_expr(expr, env);

    if (struct_field) {
      return eval_front_value(struct_field.expr, struct_field.env, hooks);
    }

    throw new Error("Missing const field: " + expr.name);
  }

  if (expr.tag === "index") {
    const item = hooks.resolve_index_expr(expr, env);

    if (item) {
      return eval_front_value(item.expr, item.env, hooks);
    }

    throw new Error("Cannot evaluate dynamic index access yet");
  }

  return capture_deferred_expr(expr, env);
}

export function eval_front_block(
  stmts: Stmt[],
  env: Env,
  hooks: FrontEvalHooks,
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
      const value = eval_front_value(stmt.expr, local, hooks);

      if (is_final) {
        return value;
      }

      continue;
    }

    if (stmt.tag === "return") {
      return eval_front_value(stmt.value, local, hooks);
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
        value = eval_front_value(value, value_env, hooks);
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
      const value = eval_front_value(stmt.value, value_env, hooks);
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
      return eval_front_block([...expanded, ...rest], local, hooks);
    }

    if (stmt.tag === "for_collection") {
      const expanded = hooks.expand_for_collection(stmt, local);
      const rest = stmts.slice(index + 1);
      return eval_front_block([...expanded, ...rest], local, hooks);
    }

    if (stmt.tag === "if_stmt") {
      const cond = hooks.eval_i32_expr(
        stmt.cond,
        local,
        "module if condition",
      );

      if (cond !== 0) {
        const rest = stmts.slice(index + 1);
        return eval_front_block(
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

        return eval_front_block([...body, ...rest], clone_env(local), hooks);
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

    throw new Error("Cannot evaluate module " + stmt.feature + " yet");
  }

  throw new Error("Module block has no result expression");
}

export function eval_simple_front_block(
  expr: Extract<FrontExpr, { tag: "block" }>,
  env: Env,
  hooks: FrontEvalHooks,
): FrontExpr | undefined {
  if (!can_eval_simple_front_block(expr.statements)) {
    return undefined;
  }

  try {
    return eval_front_block(expr.statements, env, hooks);
  } catch (error) {
    if (
      error instanceof Error &&
      is_simple_block_non_foldable_error(error.message)
    ) {
      return undefined;
    }

    throw error;
  }
}

function is_simple_block_non_foldable_error(message: string): boolean {
  if (message.startsWith("Cannot lower dynamic module ")) {
    return true;
  }

  if (message.startsWith("Cannot evaluate dynamic module ")) {
    return true;
  }

  if (message === "Module block has no result expression") {
    return true;
  }

  if (
    message.startsWith("Const parameter ") &&
    message.includes(" requires compile-time argument")
  ) {
    return true;
  }

  return false;
}

function can_eval_simple_front_block(stmts: Stmt[]): boolean {
  if (stmts.length <= 1) {
    return false;
  }

  for (const stmt of stmts) {
    if (stmt.tag === "bind") {
      continue;
    }

    if (stmt.tag === "assign") {
      continue;
    }

    if (stmt.tag === "index_assign") {
      continue;
    }

    if (stmt.tag === "return") {
      continue;
    }

    if (stmt.tag === "expr") {
      continue;
    }

    return false;
  }

  return true;
}
