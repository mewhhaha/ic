import type { Binding, Env, FrontExpr, FrontType, Stmt } from "../ast.ts";
import { lookup } from "../env.ts";
import { front_expr_is_static_shareable_text } from "../ownership.ts";
import { same_type } from "../types.ts";
import { infer_app_expr_type } from "./app.ts";
import { infer_block_type } from "./block.ts";
import { infer_if_expr_type, infer_if_let_expr_type } from "./control.ts";
import { infer_field_type, infer_index_type } from "./access.ts";
import { infer_prim_result_type } from "./prim.ts";
import type { InferHooks } from "./types.ts";
import { prim_returns_bool } from "../numeric.ts";

export function infer_front_expr(
  expr: FrontExpr,
  env: Env,
  hooks: InferHooks,
): FrontType {
  switch (expr.tag) {
    case "bool":
      return { tag: "bool" };

    case "atom":
      return { tag: "atom", name: expr.name };

    case "num":
      return { tag: "int", type: expr.type };

    case "unit":
      return { tag: "int", type: "i32" };

    case "text":
      return { tag: "text" };

    case "type_name":
      return { tag: "type" };

    case "set_type":
      return { tag: "set", type_expr: expr.type_expr };

    case "is":
      return { tag: "bool" };

    case "var": {
      const binding = lookup(env, expr.name);

      if (binding) {
        if (binding.type.tag === "unknown") {
          const value_type = infer_binding_value_type(binding, hooks);

          if (value_type) {
            return value_type;
          }
        }

        return binding.type;
      }

      return { tag: "unknown" };
    }

    case "prim":
      if (hooks.visible_text_value(expr, env, new Set())) {
        return { tag: "text" };
      }

      hooks.check_text_concat_operand_visibility(expr, env);

      if (prim_returns_bool(expr.prim)) {
        return { tag: "bool" };
      }

      return {
        tag: "int",
        type: infer_prim_result_type(expr, env, hooks, infer_front_expr),
      };

    case "lam":
      return { tag: "fn", params: expr.params };

    case "rec":
      return { tag: "fn", params: expr.params };

    case "app":
      return infer_app_expr_type(expr, env, hooks);

    case "block":
      return infer_block_type(expr.statements, env, hooks, infer_front_expr);

    case "comptime":
      return infer_front_expr(expr.expr, env, hooks);

    case "borrow":
    case "freeze": {
      const result_type = infer_front_expr(expr.value, env, hooks);

      if (result_type.tag === "bool" || result_type.tag === "int") {
        return result_type;
      }

      if (front_expr_is_static_shareable_text(expr.value, env, hooks)) {
        return { tag: "text" };
      }

      if (result_type.tag === "text") {
        return result_type;
      }

      if (
        result_type.tag === "struct" ||
        result_type.tag === "union" ||
        result_type.tag === "union_value" ||
        result_type.tag === "fn"
      ) {
        return result_type;
      }

      return { tag: "unknown" };
    }

    case "scratch": {
      const result_type = infer_front_expr(expr.body, env, hooks);

      if (result_type.tag === "bool" || result_type.tag === "int") {
        return result_type;
      }

      if (front_expr_is_static_shareable_text(expr.body, env, hooks)) {
        return { tag: "text" };
      }

      if (result_type.tag === "text") {
        return result_type;
      }

      if (
        result_type.tag === "struct" ||
        result_type.tag === "union" ||
        result_type.tag === "union_value" ||
        result_type.tag === "fn"
      ) {
        return result_type;
      }

      return { tag: "unknown" };
    }

    case "loop":
      return infer_loop_result_type(expr.body, env, hooks);

    case "captured":
      return infer_front_expr(expr.expr, expr.env, hooks);

    case "handler":
      throw new Error(
        "Handler expression must be elaborated before frontend inference",
      );

    case "try_with":
      throw new Error(
        "Try-with expression must be elaborated before frontend inference",
      );

    case "with":
      return infer_front_expr(expr.base, env, hooks);

    case "struct_type":
      return { tag: "type" };

    case "struct_value":
      return {
        tag: "struct",
        fields: expr.fields.map((field) => field.name),
        field_types: hooks.resolve_struct_value_type_fields(expr, env),
      };

    case "struct_update": {
      const struct_type = hooks.maybe_struct_type_value(expr.base, env);

      if (struct_type) {
        return infer_front_expr(
          {
            tag: "struct_value",
            type_expr: expr.base,
            fields: expr.fields,
          },
          env,
          hooks,
        );
      }

      const target = hooks.resolve_struct_value(expr.base, env);

      if (!target) {
        return { tag: "unknown" };
      }

      return infer_front_expr(target.expr, target.env, hooks);
    }

    case "union_type":
      return { tag: "type" };

    case "if":
      return infer_if_expr_type(expr, env, hooks, infer_front_expr);

    case "if_let":
      return infer_if_let_expr_type(expr, env, hooks, infer_front_expr);

    case "field":
      return infer_field_type(expr, env, hooks, infer_front_expr);

    case "index":
      return infer_index_type(expr, env, hooks, infer_front_expr);

    case "union_case": {
      if (expr.type_expr) {
        const union_type = hooks.resolve_union_type_value(expr.type_expr, env);

        if (union_type) {
          return { tag: "union_value", cases: union_type.cases };
        }
      }

      const union_cases = hooks.infer_union_cases(expr, env);

      if (union_cases) {
        return { tag: "union_value", cases: union_cases };
      }

      return { tag: "union", case_name: expr.name };
    }

    case "linear": {
      const binding = lookup(env, expr.name);

      if (binding) {
        return binding.type;
      }

      return { tag: "unknown" };
    }

    case "unsupported":
      return { tag: "unknown" };
  }
}

type LoopBreakResult = {
  type: FrontType;
  source_type: "unit" | "value";
};

function infer_loop_result_type(
  body: Stmt[],
  env: Env,
  hooks: InferHooks,
): FrontType {
  const breaks: LoopBreakResult[] = [];
  collect_loop_breaks_from_stmts(body, env, hooks, breaks);

  const first = breaks[0];

  if (!first) {
    return { tag: "unknown" };
  }

  for (const item of breaks.slice(1)) {
    if (
      item.source_type !== first.source_type ||
      !same_type(item.type, first.type)
    ) {
      throw new Error(
        "Loop breaks must return one source type, got " +
          loop_break_type_text(first) + " and " + loop_break_type_text(item),
      );
    }
  }

  return first.type;
}

function collect_loop_breaks_from_stmts(
  stmts: Stmt[],
  env: Env,
  hooks: InferHooks,
  breaks: LoopBreakResult[],
): void {
  for (const stmt of stmts) {
    if (stmt.tag === "break") {
      if (!stmt.value || stmt.value.tag === "unit") {
        breaks.push({ type: { tag: "int", type: "i32" }, source_type: "unit" });
      } else {
        breaks.push({
          type: infer_front_expr(stmt.value, env, hooks),
          source_type: "value",
        });
        collect_loop_breaks_from_expr(stmt.value, env, hooks, breaks);
      }
      continue;
    }

    if (stmt.tag === "continue" || stmt.tag === "return") {
      continue;
    }

    if (stmt.tag === "for_range" || stmt.tag === "for_collection") {
      continue;
    }

    if (stmt.tag === "if_stmt") {
      collect_loop_breaks_from_expr(stmt.cond, env, hooks, breaks);
      collect_loop_breaks_from_stmts(stmt.body, env, hooks, breaks);
      continue;
    }

    if (stmt.tag === "if_let_stmt") {
      collect_loop_breaks_from_expr(stmt.target, env, hooks, breaks);
      collect_loop_breaks_from_stmts(stmt.body, env, hooks, breaks);
      continue;
    }

    if (
      stmt.tag === "bind" || stmt.tag === "state_bind" ||
      stmt.tag === "bind_pattern" || stmt.tag === "resume_dup" ||
      stmt.tag === "assign"
    ) {
      collect_loop_breaks_from_expr(stmt.value, env, hooks, breaks);
      continue;
    }

    if (stmt.tag === "index_assign") {
      collect_loop_breaks_from_expr(stmt.index, env, hooks, breaks);
      collect_loop_breaks_from_expr(stmt.value, env, hooks, breaks);
      continue;
    }

    if (stmt.tag === "type_check") {
      collect_loop_breaks_from_expr(stmt.target, env, hooks, breaks);
      continue;
    }

    if (stmt.tag === "expr") {
      collect_loop_breaks_from_expr(stmt.expr, env, hooks, breaks);
    }
  }
}

function collect_loop_breaks_from_expr(
  expr: FrontExpr,
  env: Env,
  hooks: InferHooks,
  breaks: LoopBreakResult[],
): void {
  switch (expr.tag) {
    case "loop":
    case "lam":
    case "rec":
    case "handler":
    case "try_with":
    case "bool":
    case "num":
    case "unit":
    case "text":
    case "type_name":
    case "set_type":
    case "var":
    case "linear":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "is":
      collect_loop_breaks_from_expr(expr.value, env, hooks, breaks);
      return;

    case "prim":
      collect_loop_breaks_from_expr(expr.left, env, hooks, breaks);
      collect_loop_breaks_from_expr(expr.right, env, hooks, breaks);
      return;

    case "app":
      collect_loop_breaks_from_expr(expr.func, env, hooks, breaks);
      for (const arg of expr.args) {
        collect_loop_breaks_from_expr(arg, env, hooks, breaks);
      }
      return;

    case "block":
      collect_loop_breaks_from_stmts(expr.statements, env, hooks, breaks);
      return;

    case "comptime":
      collect_loop_breaks_from_expr(expr.expr, env, hooks, breaks);
      return;

    case "borrow":
    case "freeze":
      collect_loop_breaks_from_expr(expr.value, env, hooks, breaks);
      return;

    case "scratch":
      collect_loop_breaks_from_expr(expr.body, env, hooks, breaks);
      return;

    case "captured":
      collect_loop_breaks_from_expr(expr.expr, expr.env, hooks, breaks);
      return;

    case "with":
    case "struct_update":
      collect_loop_breaks_from_expr(expr.base, env, hooks, breaks);
      for (const field of expr.fields) {
        collect_loop_breaks_from_expr(field.value, env, hooks, breaks);
      }
      return;

    case "struct_value":
      collect_loop_breaks_from_expr(expr.type_expr, env, hooks, breaks);
      for (const field of expr.fields) {
        collect_loop_breaks_from_expr(field.value, env, hooks, breaks);
      }
      return;

    case "if":
      collect_loop_breaks_from_expr(expr.cond, env, hooks, breaks);
      collect_loop_breaks_from_expr(expr.then_branch, env, hooks, breaks);
      collect_loop_breaks_from_expr(expr.else_branch, env, hooks, breaks);
      return;

    case "if_let":
      collect_loop_breaks_from_expr(expr.target, env, hooks, breaks);
      collect_loop_breaks_from_expr(expr.then_branch, env, hooks, breaks);
      collect_loop_breaks_from_expr(expr.else_branch, env, hooks, breaks);
      return;

    case "field":
      collect_loop_breaks_from_expr(expr.object, env, hooks, breaks);
      return;

    case "index":
      collect_loop_breaks_from_expr(expr.object, env, hooks, breaks);
      collect_loop_breaks_from_expr(expr.index, env, hooks, breaks);
      return;

    case "union_case":
      if (expr.value) {
        collect_loop_breaks_from_expr(expr.value, env, hooks, breaks);
      }
      if (expr.type_expr) {
        collect_loop_breaks_from_expr(expr.type_expr, env, hooks, breaks);
      }
      return;
  }
}

function loop_break_type_text(value: LoopBreakResult): string {
  if (value.source_type === "unit") {
    return "Unit";
  }

  if (value.type.tag === "int") {
    return value.type.type || "Int";
  }

  return value.type.tag;
}

function infer_binding_value_type(
  binding: Binding,
  hooks: InferHooks,
): FrontType | undefined {
  if (!binding.value || !binding.value_env) {
    return undefined;
  }

  return infer_front_expr(binding.value, binding.value_env, hooks);
}
