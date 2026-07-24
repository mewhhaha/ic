import type { CoreExpr, CoreField, CoreStmt } from "../ast.ts";
import type { CoreCaptureState, CoreCaptureStaticCtx } from "./types.ts";

export function collect_core_expr_captures<ctx extends CoreCaptureStaticCtx>(
  expr: CoreExpr,
  state: CoreCaptureState<ctx>,
): void {
  switch (expr.tag) {
    case "var":
      add_core_capture_name(expr.name, state);
      collect_core_static_captures(expr.name, state);
      return;

    case "linear":
      add_core_capture_name(expr.name, state);
      return;

    case "num":
    case "text":
    case "type_name":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "prim":
      for (const arg of expr.args) {
        collect_core_expr_captures(arg, state);
      }

      return;

    case "lam":
    case "rec":
      with_core_capture_scope(
        state,
        expr.params.map((param) => param.name),
        () => {
          collect_core_expr_captures(expr.body, state);
        },
      );
      return;

    case "app":
      collect_core_expr_captures(expr.func, state);

      for (const arg of expr.args) {
        collect_core_expr_captures(arg, state);
      }

      return;

    case "block":
      collect_core_block_captures(expr.statements, state);
      return;

    case "loop":
      collect_core_block_captures(expr.body, state);
      return;

    case "comptime":
      collect_core_expr_captures(expr.expr, state);
      return;

    case "borrow":
      collect_core_expr_captures(expr.value, state);
      return;

    case "freeze":
      collect_core_expr_captures(expr.value, state);
      return;

    case "scratch":
      collect_core_expr_captures(expr.body, state);
      return;

    case "with":
      collect_core_expr_captures(expr.base, state);
      collect_core_field_captures(expr.fields, state);
      return;

    case "struct_value":
      collect_core_expr_captures(expr.type_expr, state);
      collect_core_field_captures(expr.fields, state);
      return;

    case "struct_update":
      collect_core_expr_captures(expr.base, state);
      collect_core_field_captures(expr.fields, state);
      return;

    case "if":
      collect_core_expr_captures(expr.cond, state);
      collect_core_expr_captures(expr.then_branch, state);
      collect_core_expr_captures(expr.else_branch, state);
      return;

    case "if_let":
      collect_core_expr_captures(expr.target, state);
      collect_core_expr_captures(expr.else_branch, state);

      if (!expr.value_name) {
        collect_core_expr_captures(expr.then_branch, state);
        return;
      }

      with_core_capture_scope(state, [expr.value_name], () => {
        collect_core_expr_captures(expr.then_branch, state);
      });
      return;

    case "field":
      collect_core_expr_captures(expr.object, state);
      return;

    case "index":
      collect_core_expr_captures(expr.object, state);
      collect_core_expr_captures(expr.index, state);
      return;

    case "union_case":
      if (expr.value) {
        collect_core_expr_captures(expr.value, state);
      }

      if (expr.type_expr) {
        collect_core_expr_captures(expr.type_expr, state);
      }

      return;
  }
}

function add_core_capture_name<ctx extends CoreCaptureStaticCtx>(
  name: string,
  state: CoreCaptureState<ctx>,
): void {
  if (state.bound.has(name)) {
    return;
  }

  if (!state.locals.has(name)) {
    return;
  }

  if (state.seen.has(name)) {
    return;
  }

  state.seen.add(name);
  state.names.push(name);
}

function collect_core_static_captures<ctx extends CoreCaptureStaticCtx>(
  name: string,
  state: CoreCaptureState<ctx>,
): void {
  if (state.bound.has(name)) {
    return;
  }

  if (state.static_seen.has(name)) {
    return;
  }

  const value = state.ctx.statics.get(name);

  if (!value) {
    return;
  }

  state.static_seen.add(name);
  collect_core_expr_captures(value, state);
}

function add_core_assigned_capture_name<ctx extends CoreCaptureStaticCtx>(
  name: string,
  state: CoreCaptureState<ctx>,
): void {
  add_core_capture_name(name, state);
}

function add_core_assigned_static_capture_name<
  ctx extends CoreCaptureStaticCtx,
>(
  name: string,
  state: CoreCaptureState<ctx>,
): boolean {
  if (state.bound.has(name)) {
    return false;
  }

  return state.hooks.static_struct_binding(name, state.ctx) !== undefined;
}

function collect_core_block_captures<ctx extends CoreCaptureStaticCtx>(
  stmts: CoreStmt[],
  state: CoreCaptureState<ctx>,
): void {
  const added: string[] = [];

  try {
    for (const stmt of stmts) {
      collect_core_stmt_captures(stmt, state);

      if (stmt.tag === "bind") {
        if (!state.bound.has(stmt.name)) {
          state.bound.add(stmt.name);
          added.push(stmt.name);
        }
      }
    }
  } finally {
    for (const name of added) {
      state.bound.delete(name);
    }
  }
}

function collect_core_stmt_captures<ctx extends CoreCaptureStaticCtx>(
  stmt: CoreStmt,
  state: CoreCaptureState<ctx>,
): void {
  switch (stmt.tag) {
    case "bind":
      collect_core_expr_captures(stmt.value, state);
      return;

    case "assign":
      if (state.locals.has(stmt.name) && !state.bound.has(stmt.name)) {
        if (stmt.mode === "change") {
          state.invalid_assignment = true;
        } else {
          add_core_assigned_capture_name(stmt.name, state);
        }
      }

      collect_core_expr_captures(stmt.value, state);
      return;

    case "index_assign":
      if (state.locals.has(stmt.name) && !state.bound.has(stmt.name)) {
        if (
          state.ctx.text_locals.has(stmt.name) ||
          state.ctx.struct_locals.has(stmt.name)
        ) {
          add_core_assigned_capture_name(stmt.name, state);
        } else {
          state.invalid_assignment = true;
        }
      } else {
        add_core_assigned_static_capture_name(stmt.name, state);
      }

      collect_core_expr_captures(stmt.index, state);
      collect_core_expr_captures(stmt.value, state);
      return;

    case "range_loop":
      collect_core_expr_captures(stmt.start, state);
      collect_core_expr_captures(stmt.end, state);
      collect_core_expr_captures(stmt.step, state);
      with_core_capture_scope(state, [stmt.index], () => {
        collect_core_block_captures(stmt.body, state);
      });
      return;

    case "collection_loop": {
      collect_core_expr_captures(stmt.collection, state);
      const names = [stmt.item];

      if (stmt.index) {
        names.push(stmt.index);
      }

      with_core_capture_scope(state, names, () => {
        collect_core_block_captures(stmt.body, state);
      });
      return;
    }

    case "if_stmt":
      collect_core_expr_captures(stmt.cond, state);
      collect_core_block_captures(stmt.body, state);
      return;

    case "if_else_stmt":
      collect_core_expr_captures(stmt.cond, state);
      collect_core_block_captures(stmt.then_body, state);
      collect_core_block_captures(stmt.else_body, state);
      return;

    case "if_let_stmt":
      collect_core_expr_captures(stmt.target, state);

      if (!stmt.value_name) {
        collect_core_block_captures(stmt.body, state);
        return;
      }

      with_core_capture_scope(state, [stmt.value_name], () => {
        collect_core_block_captures(stmt.body, state);
      });
      return;

    case "type_check":
      collect_core_expr_captures(stmt.target, state);
      return;

    case "return":
      collect_core_expr_captures(stmt.value, state);
      return;

    case "expr":
      collect_core_expr_captures(stmt.expr, state);
      return;

    case "break":
      if (stmt.value) {
        collect_core_expr_captures(stmt.value, state);
      }
      return;
    case "continue":
    case "unsupported":
      return;
  }
}

function collect_core_field_captures<ctx extends CoreCaptureStaticCtx>(
  fields: CoreField[],
  state: CoreCaptureState<ctx>,
): void {
  for (const field of fields) {
    collect_core_expr_captures(field.value, state);
  }
}

function with_core_capture_scope<ctx extends CoreCaptureStaticCtx>(
  state: CoreCaptureState<ctx>,
  names: string[],
  body: () => void,
): void {
  const added: string[] = [];

  try {
    for (const name of names) {
      if (!state.bound.has(name)) {
        state.bound.add(name);
        added.push(name);
      }
    }

    body();
  } finally {
    for (const name of added) {
      state.bound.delete(name);
    }
  }
}
