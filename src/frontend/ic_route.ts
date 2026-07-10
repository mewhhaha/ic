import type { FrontExpr, Source, Stmt } from "./ast.ts";
import { structured_core_route } from "./diagnostic.ts";

export function validate_ic_route(source: Source): void {
  const declarations = source.declarations || [];

  for (const declaration of declarations) {
    if (
      declaration.tag === "effect" && declaration.implementation === "ix"
    ) {
      reject_ic_route("Ix-defined effect " + declaration.name);
    }
  }

  validate_ic_route_stmts(source.statements);
}

function validate_ic_route_stmts(statements: Stmt[]): void {
  for (const stmt of statements) {
    validate_ic_route_stmt(stmt);
  }
}

function validate_ic_route_stmt(stmt: Stmt): void {
  switch (stmt.tag) {
    case "import":
    case "host_import":
    case "break":
    case "continue":
    case "unsupported":
      return;

    case "bind":
    case "state_bind":
    case "bind_pattern":
    case "assign":
      validate_ic_route_expr(stmt.value);
      return;

    case "resume_dup":
      return reject_ic_route("resumption duplication");

    case "index_assign":
      validate_ic_route_expr(stmt.index);
      validate_ic_route_expr(stmt.value);
      return;

    case "for_range":
      validate_ic_route_expr(stmt.start);
      validate_ic_route_expr(stmt.end);
      validate_ic_route_expr(stmt.step);
      validate_ic_route_stmts(stmt.body);
      return;

    case "for_collection":
      validate_ic_route_expr(stmt.collection);
      validate_ic_route_stmts(stmt.body);
      return;

    case "if_stmt":
      validate_ic_route_expr(stmt.cond);
      validate_ic_route_stmts(stmt.body);
      return;

    case "if_let_stmt":
      validate_ic_route_expr(stmt.target);
      validate_ic_route_stmts(stmt.body);
      return;

    case "type_check":
      validate_ic_route_expr(stmt.target);
      return;

    case "return":
      validate_ic_route_expr(stmt.value);
      return;

    case "expr":
      validate_ic_route_expr(stmt.expr);
      return;
  }

  stmt satisfies never;
  throw new Error("panic");
}

function validate_ic_route_expr(expr: FrontExpr): void {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "struct_type":
    case "union_type":
    case "linear":
    case "unsupported":
      return;

    case "unit":
      return reject_ic_route("unit value");

    case "handler":
      return reject_ic_route("handler");

    case "try_with":
      return reject_ic_route("try-with handler expression");

    case "prim":
      validate_ic_route_expr(expr.left);
      validate_ic_route_expr(expr.right);
      return;

    case "lam":
    case "rec":
      validate_ic_route_expr(expr.body);
      return;

    case "app":
      validate_ic_route_expr(expr.func);

      for (const arg of expr.args) {
        validate_ic_route_expr(arg);
      }
      return;

    case "block":
      validate_ic_route_stmts(expr.statements);
      return;

    case "comptime":
      validate_ic_route_expr(expr.expr);
      return;

    case "borrow":
    case "freeze":
      validate_ic_route_expr(expr.value);
      return;

    case "scratch":
      validate_ic_route_expr(expr.body);
      return;

    case "captured":
      validate_ic_route_expr(expr.expr);
      return;

    case "with":
    case "struct_update":
      validate_ic_route_expr(expr.base);

      for (const field of expr.fields) {
        validate_ic_route_expr(field.value);
      }
      return;

    case "struct_value":
      validate_ic_route_expr(expr.type_expr);

      for (const field of expr.fields) {
        validate_ic_route_expr(field.value);
      }
      return;

    case "if":
      validate_ic_route_expr(expr.cond);
      validate_ic_route_expr(expr.then_branch);
      validate_ic_route_expr(expr.else_branch);
      return;

    case "if_let":
      validate_ic_route_expr(expr.target);
      validate_ic_route_expr(expr.then_branch);
      validate_ic_route_expr(expr.else_branch);
      return;

    case "field":
      validate_ic_route_expr(expr.object);
      return;

    case "index":
      validate_ic_route_expr(expr.object);
      validate_ic_route_expr(expr.index);
      return;

    case "union_case":
      if (expr.value) {
        validate_ic_route_expr(expr.value);
      }

      if (expr.type_expr) {
        validate_ic_route_expr(expr.type_expr);
      }
      return;
  }

  expr satisfies never;
  throw new Error("panic");
}

function reject_ic_route(feature: string): never {
  throw new Error(
    "Cannot lower " + feature + " through pure Ic" + structured_core_route,
  );
}
