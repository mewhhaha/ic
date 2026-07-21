import type { FrontExpr, Source, Stmt } from "./ast.ts";
import { structured_core_route } from "./diagnostic.ts";
import {
  source_diagnostic,
  type SourceDiagnostic,
} from "./semantic_diagnostic.ts";

export function validate_ic_route(source: Source): void {
  validate_ic_route_source(source, undefined);
}

export function diagnose_ic_route(source: Source): SourceDiagnostic[] {
  const diagnostics: SourceDiagnostic[] = [];
  validate_ic_route_source(source, diagnostics);
  return diagnostics;
}

function validate_ic_route_source(
  source: Source,
  diagnostics: SourceDiagnostic[] | undefined,
): void {
  const declarations = source.declarations || [];

  for (const declaration of declarations) {
    if (
      declaration.tag === "effect" && declaration.implementation === "duck"
    ) {
      reject_ic_route(
        "Duck-defined effect " + declaration.name,
        declaration,
        diagnostics,
      );
    }
  }

  validate_ic_route_stmts(source.statements, diagnostics);
}

function validate_ic_route_stmts(
  statements: Stmt[],
  diagnostics: SourceDiagnostic[] | undefined,
): void {
  for (const stmt of statements) {
    validate_ic_route_stmt(stmt, diagnostics);
  }
}

function validate_ic_route_stmt(
  stmt: Stmt,
  diagnostics: SourceDiagnostic[] | undefined,
): void {
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
      validate_ic_route_expr(stmt.value, diagnostics);
      return;

    case "resume_dup":
      reject_ic_route("resumption duplication", stmt, diagnostics);
      return;

    case "index_assign":
      validate_ic_route_expr(stmt.index, diagnostics);
      validate_ic_route_expr(stmt.value, diagnostics);
      return;

    case "for_range":
      validate_ic_route_expr(stmt.start, diagnostics);
      validate_ic_route_expr(stmt.end, diagnostics);
      validate_ic_route_expr(stmt.step, diagnostics);
      validate_ic_route_stmts(stmt.body, diagnostics);
      return;

    case "for_collection":
      validate_ic_route_expr(stmt.collection, diagnostics);
      validate_ic_route_stmts(stmt.body, diagnostics);
      return;

    case "if_stmt":
      validate_ic_route_expr(stmt.cond, diagnostics);
      validate_ic_route_stmts(stmt.body, diagnostics);
      return;

    case "if_let_stmt":
      validate_ic_route_expr(stmt.target, diagnostics);
      validate_ic_route_stmts(stmt.body, diagnostics);
      return;

    case "type_check":
      validate_ic_route_expr(stmt.target, diagnostics);
      return;

    case "return":
      validate_ic_route_expr(stmt.value, diagnostics);
      return;

    case "expr":
      validate_ic_route_expr(stmt.expr, diagnostics);
      return;
  }

  stmt satisfies never;
  throw new Error("@panic");
}

function validate_ic_route_expr(
  expr: FrontExpr,
  diagnostics: SourceDiagnostic[] | undefined,
): void {
  switch (expr.tag) {
    case "bool":
    case "num":
    case "atom":
    case "text":
    case "type_name":
    case "set_type":
    case "var":
    case "struct_type":
    case "union_type":
    case "linear":
    case "unsupported":
      return;

    case "unit":
      reject_ic_route("unit value", expr, diagnostics);
      return;

    case "is":
      validate_ic_route_expr(expr.value, diagnostics);
      return;

    case "as":
      validate_ic_route_expr(expr.value, diagnostics);
      return;

    case "product":
    case "shape":
      for (const entry of expr.entries) {
        validate_ic_route_expr(entry.value, diagnostics);
      }
      return;

    case "array":
      for (const item of expr.items) {
        validate_ic_route_expr(item, diagnostics);
      }

      if (expr.rest !== undefined) {
        validate_ic_route_expr(expr.rest, diagnostics);
      }
      return;

    case "array_repeat":
      validate_ic_route_expr(expr.value, diagnostics);
      validate_ic_route_expr(expr.length, diagnostics);
      return;

    case "import":
      reject_ic_route(
        "unresolved expression import " + expr.path,
        expr,
        diagnostics,
      );
      return;

    case "match":
      validate_ic_route_expr(expr.target, diagnostics);

      for (const arm of expr.arms) {
        if (arm.guard !== undefined) {
          validate_ic_route_expr(arm.guard, diagnostics);
        }

        validate_ic_route_expr(arm.body, diagnostics);
      }
      return;

    case "handler":
      reject_ic_route("handler", expr, diagnostics);
      return;

    case "try_with":
      reject_ic_route("try-with handler expression", expr, diagnostics);
      return;

    case "prim":
      validate_ic_route_expr(expr.left, diagnostics);
      validate_ic_route_expr(expr.right, diagnostics);
      return;

    case "lam":
    case "rec":
      validate_ic_route_expr(expr.body, diagnostics);
      return;

    case "app":
      validate_ic_route_expr(expr.func, diagnostics);

      for (const arg of expr.args) {
        validate_ic_route_expr(arg, diagnostics);
      }
      return;

    case "block":
      validate_ic_route_stmts(expr.statements, diagnostics);
      return;

    case "comptime":
      validate_ic_route_expr(expr.expr, diagnostics);
      return;

    case "borrow":
    case "freeze":
      validate_ic_route_expr(expr.value, diagnostics);
      return;

    case "scratch":
      validate_ic_route_expr(expr.body, diagnostics);
      return;

    case "loop":
      reject_ic_route("loop expression", expr, diagnostics);
      return;

    case "captured":
      validate_ic_route_expr(expr.expr, diagnostics);
      return;

    case "with":
    case "struct_update":
      validate_ic_route_expr(expr.base, diagnostics);

      for (const field of expr.fields) {
        validate_ic_route_expr(field.value, diagnostics);
      }
      return;

    case "type_with":
      validate_ic_route_expr(expr.base, diagnostics);

      for (const member of expr.members) {
        validate_ic_route_expr(member.name, diagnostics);
        validate_ic_route_expr(member.value, diagnostics);
      }
      return;

    case "struct_value":
      validate_ic_route_expr(expr.type_expr, diagnostics);

      for (const field of expr.fields) {
        validate_ic_route_expr(field.value, diagnostics);
      }
      return;

    case "if":
      validate_ic_route_expr(expr.cond, diagnostics);
      validate_ic_route_expr(expr.then_branch, diagnostics);
      validate_ic_route_expr(expr.else_branch, diagnostics);
      return;

    case "if_let":
      validate_ic_route_expr(expr.target, diagnostics);
      validate_ic_route_expr(expr.then_branch, diagnostics);
      validate_ic_route_expr(expr.else_branch, diagnostics);
      return;

    case "field":
      validate_ic_route_expr(expr.object, diagnostics);
      return;

    case "index":
      validate_ic_route_expr(expr.object, diagnostics);
      validate_ic_route_expr(expr.index, diagnostics);
      return;

    case "union_case":
      if (expr.value && expr.value.tag !== "unit") {
        validate_ic_route_expr(expr.value, diagnostics);
      }

      if (expr.type_expr) {
        validate_ic_route_expr(expr.type_expr, diagnostics);
      }
      return;
  }

  expr satisfies never;
  throw new Error("@panic");
}

function reject_ic_route(
  feature: string,
  subject: object,
  diagnostics: SourceDiagnostic[] | undefined,
): void {
  const message = "Cannot lower " + feature + " through pure Ic" +
    structured_core_route;

  if (diagnostics === undefined) {
    throw new Error(message);
  }

  diagnostics.push(source_diagnostic(
    "DUCK2901",
    message,
    subject,
  ));
}
