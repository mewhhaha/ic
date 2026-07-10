import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";
import type { Env, Stmt } from "./ast.ts";
import {
  structured_core_route,
  unresolved_import_route,
} from "./diagnostic.ts";
import {
  lower_assign_statement,
  lower_bind_statement,
  lower_index_assign_statement,
} from "./stmt/binding.ts";
import {
  lower_expr_statement,
  lower_for_collection_statement,
  lower_for_range_statement,
  lower_if_let_statement,
  lower_if_statement,
} from "./stmt/control.ts";
import type { StatementLowerHooks } from "./stmt/types.ts";

export type { StatementLowerHooks };

export function lower_statements(
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
): IcNode {
  return lower_statements_with_done(
    stmts,
    index,
    env,
    hooks,
    undefined,
  );
}

function lower_statements_with_done(
  stmts: Stmt[],
  index: number,
  env: Env,
  hooks: StatementLowerHooks,
  on_done: (() => IcNode) | undefined,
): IcNode {
  if (index >= stmts.length) {
    if (on_done) {
      return on_done();
    }

    throw new Error("Program has no result expression");
  }

  const stmt = stmts[index];
  expect(stmt, "Missing statement " + index);

  if (stmt.tag === "import") {
    throw new Error(
      "Cannot lower unresolved import; " + unresolved_import_route,
    );
  }

  if (stmt.tag === "host_import") {
    throw new Error(
      "Cannot lower host import through pure Ic" + structured_core_route,
    );
  }

  if (stmt.tag === "bind") {
    return lower_bind_statement(
      stmt,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  if (stmt.tag === "assign") {
    return lower_assign_statement(
      stmt,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  if (stmt.tag === "index_assign") {
    return lower_index_assign_statement(
      stmt,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  if (stmt.tag === "for_range") {
    return lower_for_range_statement(
      stmt,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  if (stmt.tag === "for_collection") {
    return lower_for_collection_statement(
      stmt,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  if (stmt.tag === "if_stmt") {
    return lower_if_statement(
      stmt,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  if (stmt.tag === "if_let_stmt") {
    return lower_if_let_statement(
      stmt,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  if (stmt.tag === "type_check") {
    hooks.check_type_pattern(stmt, env);
    return lower_statements_with_done(
      stmts,
      index + 1,
      env,
      hooks,
      on_done,
    );
  }

  if (stmt.tag === "break") {
    throw new Error("Cannot lower break outside static range loop");
  }

  if (stmt.tag === "continue") {
    throw new Error("Cannot lower continue outside static range loop");
  }

  if (stmt.tag === "return") {
    return hooks.lower_expr(stmt.value, env);
  }

  if (stmt.tag === "expr") {
    return lower_expr_statement(
      stmt,
      stmts,
      index,
      env,
      hooks,
      on_done,
      lower_statements_with_done,
    );
  }

  if (stmt.tag === "state_bind" || stmt.tag === "bind_pattern") {
    throw new Error(
      "Cannot lower " + stmt.tag + " to Ic frontend yet" +
        structured_core_route,
    );
  }

  if (stmt.tag === "resume_dup") {
    throw new Error(
      "Resumption duplication must be elaborated before Ic lowering",
    );
  }

  throw new Error(
    "Cannot lower " + stmt.feature + " to Ic frontend yet" +
      structured_core_route,
  );
}
