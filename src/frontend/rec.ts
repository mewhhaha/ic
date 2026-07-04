import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, FrontType, Stmt } from "./ast.ts";
import {
  dynamic_if_let_ic_route,
  structured_core_route,
  unresolved_import_route,
} from "./diagnostic.ts";
import { validate_linear_rec } from "./linear.ts";
import { unwrap_ownership_wrapper_context_expr } from "./ownership.ts";
import { infer_rec_expr } from "./rec_infer.ts";
import { is_rec_call } from "./rec_validate.ts";
import type { StaticRecHooks } from "./rec_hooks.ts";
import { bind_rec_args, resolve_rec_target } from "./rec_bind.ts";
import {
  lower_rec_result_expr,
  type StaticRecBlockLowerer,
  type StaticRecResult,
} from "./rec_result.ts";
import { lower_expr_as_front_type } from "./typed_lower.ts";
import { front_type_from_type_name, is_builtin_type_name } from "./types.ts";

export { validate_rec_tail } from "./rec_validate.ts";

export function infer_static_rec_app_type(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: StaticRecHooks,
): FrontType | undefined {
  const target = resolve_rec_target(expr.func, env, hooks);

  if (!target) {
    return undefined;
  }

  const rec = target.expr;
  validate_static_rec_linear_params(rec);

  if (expr.args.length !== rec.params.length) {
    throw new Error(
      "rec expected " + rec.params.length.toString() + " arguments, got " +
        expr.args.length.toString(),
    );
  }

  const args = expr.args.map((arg) => hooks.capture_expr(arg, env));
  const local = hooks.clone_env(target.env);
  bind_rec_args(rec, args, local, hooks);
  return infer_rec_expr(rec.body, local, hooks);
}

export function lower_static_rec_app(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: StaticRecHooks,
): IcNode | undefined {
  const target = resolve_rec_target(expr.func, env, hooks);

  if (!target) {
    return undefined;
  }

  const rec = target.expr;
  validate_static_rec_linear_params(rec);

  if (expr.args.length !== rec.params.length) {
    throw new Error(
      "rec expected " + rec.params.length.toString() + " arguments, got " +
        expr.args.length.toString(),
    );
  }

  let args = expr.args.map((arg) => hooks.capture_expr(arg, env));

  for (let step = 0; step < 10000; step += 1) {
    const local = hooks.clone_env(target.env);
    bind_rec_args(rec, args, local, hooks);
    const result = lower_static_rec_expr(rec.body, local, hooks);

    if (!result) {
      throw new Error(
        "Cannot lower rec body without result to Ic frontend yet" +
          structured_core_route,
      );
    }

    if (result.tag === "done") {
      return result.value;
    }

    args = result.args;
  }

  throw new Error("rec static lowering exceeded 10000 steps");
}

export function lower_static_rec_app_as_front_type(
  expr: Extract<FrontExpr, { tag: "app" }>,
  type: FrontType,
  env: Env,
  hooks: StaticRecHooks,
): IcNode | undefined {
  const target = resolve_rec_target(expr.func, env, hooks);

  if (!target) {
    return undefined;
  }

  const rec = target.expr;
  validate_static_rec_linear_params(rec);

  if (expr.args.length !== rec.params.length) {
    throw new Error(
      "rec expected " + rec.params.length.toString() + " arguments, got " +
        expr.args.length.toString(),
    );
  }

  let args = expr.args.map((arg) => hooks.capture_expr(arg, env));

  for (let step = 0; step < 10000; step += 1) {
    const local = hooks.clone_env(target.env);
    bind_rec_args(rec, args, local, hooks);
    const result = lower_static_rec_expr(rec.body, local, hooks, type);

    if (!result) {
      throw new Error(
        "Cannot lower rec body without result to Ic frontend yet" +
          structured_core_route,
      );
    }

    if (result.tag === "done") {
      return result.value;
    }

    args = result.args;
  }

  throw new Error("rec static lowering exceeded 10000 steps");
}

function validate_static_rec_linear_params(
  rec: Extract<FrontExpr, { tag: "rec" }>,
): void {
  for (const param of rec.params) {
    if (param.is_linear) {
      validate_linear_rec(rec);
      return;
    }
  }
}

function lower_static_rec_expr(
  expr: FrontExpr,
  env: Env,
  hooks: StaticRecHooks,
  expected_type?: FrontType,
): StaticRecResult | undefined {
  if (expr.tag === "captured") {
    return lower_static_rec_expr(expr.expr, expr.env, hooks, expected_type);
  }

  if (expr.tag === "block") {
    return lower_static_rec_block(expr.statements, env, hooks, expected_type);
  }

  if (expr.tag === "if") {
    const cond = hooks.resolve_static_i32_expr(expr.cond, env);

    if (cond === undefined) {
      return {
        tag: "done",
        value: lower_rec_result_expr_with_expected_type(
          expr,
          env,
          hooks,
          lower_static_rec_block,
          expected_type,
        ),
      };
    }

    if (cond !== 0) {
      return lower_static_rec_expr(
        expr.then_branch,
        env,
        hooks,
        expected_type,
      );
    }

    return lower_static_rec_expr(
      expr.else_branch,
      env,
      hooks,
      expected_type,
    );
  }

  if (is_rec_call(expr)) {
    expect(expr.tag === "app", "Expected rec call");
    return {
      tag: "call",
      args: expr.args.map((arg) => hooks.capture_expr(arg, env)),
    };
  }

  return {
    tag: "done",
    value: lower_rec_result_expr_with_expected_type(
      expr,
      env,
      hooks,
      lower_static_rec_block,
      expected_type,
    ),
  };
}

function lower_static_rec_block(
  stmts: Stmt[],
  env: Env,
  hooks: StaticRecHooks,
  expected_type?: FrontType,
): StaticRecResult | undefined {
  if (expected_type) {
    const alias = simple_expected_rec_alias_block_value(
      stmts,
      expected_type,
      env,
      hooks,
    );

    if (alias) {
      return {
        tag: "done",
        value: lower_rec_result_expr_with_expected_type(
          alias,
          env,
          hooks,
          lower_static_rec_block,
          expected_type,
        ),
      };
    }
  }

  const local = hooks.clone_env(env);

  for (let index = 0; index < stmts.length; index += 1) {
    const stmt = stmts[index];
    expect(stmt, "Missing rec body statement " + index);
    const is_final = index + 1 >= stmts.length;

    if (stmt.tag === "expr") {
      if (is_final) {
        return lower_static_rec_expr(stmt.expr, local, hooks, expected_type);
      }

      lower_rec_result_expr(stmt.expr, local, hooks, lower_static_rec_block);
    } else if (stmt.tag === "return") {
      return lower_static_rec_expr(stmt.value, local, hooks, expected_type);
    } else if (stmt.tag === "bind") {
      let value = stmt.value;

      if (stmt.kind === "const") {
        value = hooks.prepare_const_value(value, local);
        hooks.push_binding(local, {
          name: stmt.name,
          ic_name: stmt.name,
          type: hooks.infer_expr(value, local),
          is_const: true,
          is_linear: stmt.is_linear,
          value,
          value_env: undefined,
        });
      } else {
        value = hooks.prepare_runtime_value(value, local);
        let value_type = hooks.infer_expr(value, local);

        if (stmt.annotation) {
          const annotated = hooks.apply_runtime_binding_annotation(
            stmt.annotation,
            value,
            local,
          );
          value = annotated.value;
          value_type = annotated.type;
          value = unwrap_ownership_wrapper_context_expr(value);
        }

        hooks.push_binding(local, {
          name: stmt.name,
          ic_name: hooks.fresh(local, stmt.name),
          type: value_type,
          is_const: false,
          is_linear: stmt.is_linear,
          value,
          value_env: hooks.clone_env(local),
          is_deferred: can_defer_rec_binding_value(value, value_type),
        });
      }
    } else if (stmt.tag === "assign") {
      const previous = hooks.lookup(local, stmt.name);
      expect(previous, "Cannot assign unbound name: " + stmt.name);
      let value = hooks.prepare_runtime_value(stmt.value, local);
      let value_type = hooks.infer_expr(value, local);

      if (stmt.mode === "same" && !hooks.same_type(previous.type, value_type)) {
        throw new Error("Assignment changes type for " + stmt.name);
      }

      value_type = hooks.assignment_type(
        previous.type,
        value_type,
        stmt.mode,
      );

      if (stmt.mode === "same") {
        value = unwrap_ownership_wrapper_context_expr(value);
      }

      hooks.push_binding(local, {
        name: stmt.name,
        ic_name: hooks.fresh(local, stmt.name),
        type: value_type,
        is_const: false,
        is_linear: previous.is_linear,
        value,
        value_env: hooks.clone_env(local),
      });
    } else if (stmt.tag === "index_assign") {
      const value = hooks.apply_index_assignment(stmt, local);
      hooks.push_binding(local, {
        name: stmt.name,
        ic_name: hooks.fresh(local, stmt.name),
        type: hooks.infer_expr(value, local),
        is_const: false,
        is_linear: false,
        value,
        value_env: hooks.clone_env(local),
      });
    } else if (stmt.tag === "for_range") {
      const expanded = hooks.expand_for_range(stmt, local);
      const rest = stmts.slice(index + 1);
      return lower_static_rec_block([...expanded, ...rest], local, hooks);
    } else if (stmt.tag === "for_collection") {
      const expanded = hooks.expand_for_collection(stmt, local);
      const rest = stmts.slice(index + 1);
      return lower_static_rec_block([...expanded, ...rest], local, hooks);
    } else if (stmt.tag === "if_stmt") {
      const cond = hooks.resolve_static_i32_expr(stmt.cond, local);
      const rest = stmts.slice(index + 1);

      if (cond === undefined) {
        return {
          tag: "done",
          value: lower_rec_result_expr_with_expected_type(
            {
              tag: "if",
              cond: stmt.cond,
              then_branch: {
                tag: "block",
                statements: [...stmt.body, ...rest],
              },
              else_branch: {
                tag: "block",
                statements: rest,
              },
            },
            local,
            hooks,
            lower_static_rec_block,
            expected_type,
          ),
        };
      }

      if (cond !== 0) {
        return lower_static_rec_block(
          [...stmt.body, ...rest],
          hooks.clone_env(local),
          hooks,
          expected_type,
        );
      }
    } else if (stmt.tag === "if_let_stmt") {
      const target = hooks.resolve_union_value(stmt.target, local);
      const rest = stmts.slice(index + 1);

      if (!target) {
        const target_type = infer_rec_expr(stmt.target, local, hooks);

        if (target_type.tag === "union_value") {
          return {
            tag: "done",
            value: lower_rec_result_expr_with_expected_type(
              {
                tag: "if_let",
                case_name: stmt.case_name,
                value_name: stmt.value_name,
                target: stmt.target,
                then_branch: {
                  tag: "block",
                  statements: [...stmt.body, ...rest],
                },
                else_branch: {
                  tag: "block",
                  statements: rest,
                },
              },
              local,
              hooks,
              lower_static_rec_block,
              expected_type,
            ),
          };
        }

        throw new Error(dynamic_if_let_ic_route);
      }

      if (target.expr.name === stmt.case_name) {
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
              value: hooks.capture_expr(value, target.env),
            },
            ...stmt.body,
          ];
        }

        return lower_static_rec_block(
          [...body, ...rest],
          hooks.clone_env(local),
          hooks,
          expected_type,
        );
      }
    } else if (stmt.tag === "type_check") {
      hooks.check_type_pattern(stmt.pattern, stmt.target, local);
    } else if (stmt.tag === "break" || stmt.tag === "continue") {
      throw new Error(
        "Cannot lower rec " + stmt.tag + " body yet" +
          structured_core_route,
      );
    } else if (stmt.tag === "import") {
      throw new Error(
        "Cannot lower unresolved import; " + unresolved_import_route,
      );
    } else if (stmt.tag === "host_import") {
      throw new Error(
        "Cannot lower host import through static rec; " +
          "use Source.core, Source.mod, or Source.wat",
      );
    } else {
      throw new Error(
        "Cannot lower rec " + stmt.tag + " body yet" +
          structured_core_route,
      );
    }
  }

  return undefined;
}

function can_defer_rec_binding_value(
  value: FrontExpr,
  type: FrontType,
): boolean {
  if (type.tag !== "unknown") {
    return false;
  }

  if (value.tag === "captured") {
    return can_defer_rec_binding_value(value.expr, type);
  }

  return value.tag === "if" || value.tag === "if_let";
}

function simple_expected_rec_alias_block_value(
  stmts: Stmt[],
  expected_type: FrontType,
  env: Env,
  hooks: StaticRecHooks,
): FrontExpr | undefined {
  if (stmts.length !== 2) {
    return undefined;
  }

  const bind = stmts[0];
  const result = stmts[1];
  expect(bind, "Missing rec alias binding");
  expect(result, "Missing rec alias result");

  if (bind.tag !== "bind") {
    return undefined;
  }

  if (bind.kind !== "let") {
    return undefined;
  }

  if (bind.is_linear) {
    return undefined;
  }

  const result_expr = rec_block_result_expr(result);

  if (!result_expr) {
    return undefined;
  }

  if (result_expr.tag !== "var" || result_expr.name !== bind.name) {
    return undefined;
  }

  if (
    bind.annotation && !rec_annotation_matches_expected_type(
      bind.annotation,
      expected_type,
      env,
      hooks,
    )
  ) {
    return undefined;
  }

  return bind.value;
}

function rec_block_result_expr(stmt: Stmt): FrontExpr | undefined {
  if (stmt.tag === "expr") {
    return stmt.expr;
  }

  if (stmt.tag === "return") {
    return stmt.value;
  }

  return undefined;
}

function rec_annotation_matches_expected_type(
  annotation: string,
  expected_type: FrontType,
  env: Env,
  hooks: StaticRecHooks,
): boolean {
  const resolved = hooks.resolve_annotation_type(annotation, env);

  if (resolved && resolved.tag !== "unknown") {
    return hooks.same_type(resolved, expected_type);
  }

  if (!is_builtin_type_name(annotation)) {
    return false;
  }

  return hooks.same_type(
    front_type_from_type_name(annotation),
    expected_type,
  );
}

function lower_rec_result_expr_with_expected_type(
  expr: FrontExpr,
  env: Env,
  hooks: StaticRecHooks,
  lower_static_rec_block: StaticRecBlockLowerer,
  expected_type?: FrontType,
): IcNode {
  if (!expected_type) {
    return lower_rec_result_expr(expr, env, hooks, lower_static_rec_block);
  }

  return lower_expr_as_front_type(expr, expected_type, env, {
    infer_expr: (value, value_env) => infer_rec_expr(value, value_env, hooks),
    lower_app_as_front_type: (value, type, value_env) =>
      lower_static_rec_app_as_front_type(value, type, value_env, hooks),
    lower_expr: (value, value_env) =>
      lower_rec_result_expr(value, value_env, hooks, lower_static_rec_block),
    resolve_annotation_type: hooks.resolve_annotation_type,
  });
}
