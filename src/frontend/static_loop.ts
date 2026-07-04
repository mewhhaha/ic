import type { Env, FrontExpr, Stmt } from "./ast.ts";
import { structured_core_route } from "./diagnostic.ts";
import { clone_env, fresh } from "./env.ts";
import { format_expr } from "./format.ts";
import {
  bind_loop_static_value,
  continues_range,
  validate_loop_binding_readonly,
} from "./static_loop/binding.ts";
import { type DynamicLoopState } from "./static_loop/dynamic_control.ts";
import { expand_dynamic_loop_control_body } from "./static_loop/expand_dynamic.ts";
import {
  collection_index_value,
  runtime_struct_collection_items,
  static_struct_collection_items,
  text_collection_items,
} from "./static_loop/items.ts";
import type {
  CollectionLoopItem,
  ExpandedLoopBody,
  ForCollectionStmt,
  StaticLoopHooks,
} from "./static_loop/types.ts";
import {
  collection_body_needs_dynamic_loop_control,
  expand_static_loop_body,
  range_body_needs_dynamic_loop_control,
  type StaticLoopBodyExpanders,
} from "./static_loop/body.ts";

export type { StaticLoopHooks };

const static_loop_body_expanders: StaticLoopBodyExpanders = {
  expand_for_range_body,
  expand_for_collection_body,
};

export function expand_for_range(
  stmt: Extract<Stmt, { tag: "for_range" }>,
  env: Env,
  hooks: StaticLoopHooks,
): Stmt[] {
  return expand_for_range_body(stmt, env, hooks).statements;
}

function expand_for_range_body(
  stmt: Extract<Stmt, { tag: "for_range" }>,
  env: Env,
  hooks: StaticLoopHooks,
): ExpandedLoopBody {
  validate_loop_binding_readonly(stmt.index, "index", stmt.body);
  const start = hooks.eval_i32_expr(stmt.start, env, "for start");
  const end = hooks.eval_i32_expr(stmt.end, env, "for end");
  const step = hooks.eval_i32_expr(stmt.step, env, "for step");

  if (step === 0) {
    throw new Error("for step must be nonzero");
  }

  if (
    range_body_needs_dynamic_loop_control(
      stmt,
      env,
      hooks,
      start,
      end,
      step,
      static_loop_body_expanders,
    )
  ) {
    return expand_for_range_dynamic_control(stmt, env, hooks, start, end, step);
  }

  const expanded: Stmt[] = [];
  let current = start;

  while (continues_range(current, end, step)) {
    const loop_env = clone_env(env);
    const index_value: FrontExpr = { tag: "num", type: "i32", value: current };
    bind_loop_static_value(loop_env, stmt.index, index_value);
    expanded.push({
      tag: "bind",
      kind: "let",
      name: stmt.index,
      is_linear: false,
      annotation: undefined,
      value: index_value,
    });

    const body = expand_static_loop_body(
      stmt.body,
      loop_env,
      hooks,
      static_loop_body_expanders,
    );
    expanded.push(...body.statements);

    if (body.control === "break" || body.control === "return") {
      if (body.control === "return") {
        return { statements: expanded, control: "return" };
      }

      break;
    }

    current += step;
  }

  return { statements: expanded, control: "none" };
}

function expand_for_range_dynamic_control(
  stmt: Extract<Stmt, { tag: "for_range" }>,
  env: Env,
  hooks: StaticLoopHooks,
  start: number,
  end: number,
  step: number,
): ExpandedLoopBody {
  const expanded: Stmt[] = [];
  const active_name = fresh(env, "loop_active");
  expanded.push({
    tag: "bind",
    kind: "let",
    name: active_name,
    is_linear: false,
    annotation: undefined,
    value: { tag: "num", type: "i32", value: 1 },
  });

  let current = start;

  while (continues_range(current, end, step)) {
    const step_name = fresh(env, "loop_step");
    const loop_env = clone_env(env);
    const index_value: FrontExpr = { tag: "num", type: "i32", value: current };
    bind_loop_static_value(loop_env, stmt.index, index_value);
    expanded.push({
      tag: "bind",
      kind: "let",
      name: stmt.index,
      is_linear: false,
      annotation: undefined,
      value: index_value,
    });

    const state: DynamicLoopState = { active_name, step_name };
    expanded.push({
      tag: "bind",
      kind: "let",
      name: step_name,
      is_linear: false,
      annotation: undefined,
      value: { tag: "var", name: active_name },
    });

    const body = expand_dynamic_loop_control_body(
      stmt.body,
      loop_env,
      hooks,
      state,
      static_loop_body_expanders,
    );
    expanded.push(...body.statements);

    if (body.control === "break" || body.control === "return") {
      if (body.control === "return") {
        return { statements: expanded, control: "return" };
      }

      break;
    }

    current += step;
  }

  return { statements: expanded, control: "none" };
}

export function expand_for_collection(
  stmt: ForCollectionStmt,
  env: Env,
  hooks: StaticLoopHooks,
): Stmt[] {
  return expand_for_collection_body(stmt, env, hooks).statements;
}

function expand_for_collection_body(
  stmt: ForCollectionStmt,
  env: Env,
  hooks: StaticLoopHooks,
): ExpandedLoopBody {
  validate_loop_binding_readonly(stmt.item, "item", stmt.body);

  if (stmt.index) {
    validate_loop_binding_readonly(stmt.index, "index", stmt.body);
  }

  const target = hooks.resolve_struct_value(stmt.collection, env);

  if (target) {
    const items = static_struct_collection_items(target);

    if (
      collection_body_needs_dynamic_loop_control(
        stmt,
        env,
        hooks,
        items,
        bind_collection_loop_item,
        static_loop_body_expanders,
      )
    ) {
      return expand_for_collection_dynamic_control(stmt, env, hooks, items);
    }

    return expand_for_collection_static(stmt, env, hooks, items);
  }

  const text_bytes = hooks.resolve_text_bytes(stmt.collection, env);

  if (text_bytes) {
    const items = text_collection_items(text_bytes);

    if (
      collection_body_needs_dynamic_loop_control(
        stmt,
        env,
        hooks,
        items,
        bind_collection_loop_item,
        static_loop_body_expanders,
      )
    ) {
      return expand_for_collection_dynamic_control(stmt, env, hooks, items);
    }

    return expand_for_collection_static(stmt, env, hooks, items);
  }

  const runtime_target = hooks.resolve_runtime_struct_type(
    stmt.collection,
    env,
  );

  if (!runtime_target) {
    throw new Error(
      "Cannot lower collection loop to Ic frontend yet: " +
        format_expr(stmt.collection) +
        structured_core_route,
    );
  }

  const items = runtime_struct_collection_items(stmt, runtime_target.fields);

  if (
    collection_body_needs_dynamic_loop_control(
      stmt,
      env,
      hooks,
      items,
      bind_collection_loop_item,
      static_loop_body_expanders,
    )
  ) {
    return expand_for_collection_dynamic_control(stmt, env, hooks, items);
  }

  return expand_for_collection_static(stmt, env, hooks, items);
}

function expand_for_collection_static(
  stmt: ForCollectionStmt,
  env: Env,
  hooks: StaticLoopHooks,
  items: CollectionLoopItem[],
): ExpandedLoopBody {
  const expanded: Stmt[] = [];

  for (const item of items) {
    const loop_env = clone_env(env);
    push_collection_loop_binds(expanded, loop_env, stmt, item);

    const body = expand_static_loop_body(
      stmt.body,
      loop_env,
      hooks,
      static_loop_body_expanders,
    );
    expanded.push(...body.statements);

    if (body.control === "break" || body.control === "return") {
      if (body.control === "return") {
        return { statements: expanded, control: "return" };
      }

      break;
    }
  }

  return { statements: expanded, control: "none" };
}

function expand_for_collection_dynamic_control(
  stmt: ForCollectionStmt,
  env: Env,
  hooks: StaticLoopHooks,
  items: CollectionLoopItem[],
): ExpandedLoopBody {
  const expanded: Stmt[] = [];
  const active_name = fresh(env, "loop_active");
  expanded.push({
    tag: "bind",
    kind: "let",
    name: active_name,
    is_linear: false,
    annotation: undefined,
    value: { tag: "num", type: "i32", value: 1 },
  });

  for (const item of items) {
    const step_name = fresh(env, "loop_step");
    const loop_env = clone_env(env);
    push_collection_loop_binds(expanded, loop_env, stmt, item);

    const state: DynamicLoopState = { active_name, step_name };
    expanded.push({
      tag: "bind",
      kind: "let",
      name: step_name,
      is_linear: false,
      annotation: undefined,
      value: { tag: "var", name: active_name },
    });

    const body = expand_dynamic_loop_control_body(
      stmt.body,
      loop_env,
      hooks,
      state,
      static_loop_body_expanders,
    );
    expanded.push(...body.statements);

    if (body.control === "break" || body.control === "return") {
      if (body.control === "return") {
        return { statements: expanded, control: "return" };
      }

      break;
    }
  }

  return { statements: expanded, control: "none" };
}

function push_collection_loop_binds(
  expanded: Stmt[],
  loop_env: Env,
  stmt: ForCollectionStmt,
  item: CollectionLoopItem,
): void {
  bind_collection_loop_item(loop_env, stmt, item);

  if (stmt.index) {
    expanded.push({
      tag: "bind",
      kind: "let",
      name: stmt.index,
      is_linear: false,
      annotation: undefined,
      value: collection_index_value(item),
    });
  }

  expanded.push({
    tag: "bind",
    kind: "let",
    name: stmt.item,
    is_linear: false,
    annotation: undefined,
    value: item.value,
  });
}

function bind_collection_loop_item(
  loop_env: Env,
  stmt: ForCollectionStmt,
  item: CollectionLoopItem,
): void {
  if (stmt.index) {
    bind_loop_static_value(loop_env, stmt.index, collection_index_value(item));
  }

  bind_loop_static_value(loop_env, stmt.item, item.value);
}
