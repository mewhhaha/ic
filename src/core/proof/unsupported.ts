import type { Core, CoreExpr, CoreField, CoreStmt } from "../ast.ts";
import type {
  CoreUnsupportedCodegenHooks,
  CoreUnsupportedCodegenIssue,
} from "./types.ts";

export function core_unsupported_codegen_issues(
  core: Core,
  hooks: CoreUnsupportedCodegenHooks,
): CoreUnsupportedCodegenIssue[] {
  const issues: CoreUnsupportedCodegenIssue[] = [];
  scan_unsupported_codegen_stmts(core.statements, issues, hooks, 0);
  return issues;
}

function scan_unsupported_codegen_stmts(
  statements: CoreStmt[],
  issues: CoreUnsupportedCodegenIssue[],
  hooks: CoreUnsupportedCodegenHooks,
  loop_depth: number,
): void {
  // Support probes consult local facts, so each statement list opens a
  // fact scope and each scanned statement contributes its facts for the
  // statements after it.
  if (hooks.enter_scope) {
    hooks.enter_scope();
  }

  for (const stmt of statements) {
    scan_unsupported_codegen_stmt(stmt, issues, hooks, loop_depth);

    if (hooks.observe_stmt) {
      hooks.observe_stmt(stmt);
    }
  }

  if (hooks.exit_scope) {
    hooks.exit_scope();
  }
}

function scan_unsupported_codegen_stmt(
  stmt: CoreStmt,
  issues: CoreUnsupportedCodegenIssue[],
  hooks: CoreUnsupportedCodegenHooks,
  loop_depth: number,
): void {
  switch (stmt.tag) {
    case "bind":
      if (stmt.kind === "let" && hooks.type_value_expr(stmt.value)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "expr",
          feature: "type_value",
          message: "Cannot emit core type value expression yet",
        });
        return;
      }
      scan_unsupported_codegen_expr(
        stmt.value,
        issues,
        hooks,
        false,
        loop_depth,
      );
      return;

    case "assign":
      if (hooks.type_value_expr(stmt.value)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "expr",
          feature: "type_value",
          message: "Cannot emit core type value expression yet",
        });
        return;
      }
      scan_unsupported_codegen_expr(
        stmt.value,
        issues,
        hooks,
        false,
        loop_depth,
      );
      return;

    case "index_assign":
      if (!hooks.index_assign_supported(stmt)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "stmt",
          feature: "index_assign",
          message: "Cannot emit core index_assign statement yet",
        });
      }
      scan_unsupported_codegen_expr(
        stmt.index,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_expr(
        stmt.value,
        issues,
        hooks,
        true,
        loop_depth,
      );
      return;

    case "range_loop":
      scan_unsupported_codegen_expr(
        stmt.start,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_expr(
        stmt.end,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_expr(
        stmt.step,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_stmts(
        stmt.body,
        issues,
        hooks,
        loop_depth + 1,
      );
      return;

    case "collection_loop":
      if (!hooks.collection_loop_supported(stmt)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "stmt",
          feature: "collection_loop",
          message: "Cannot emit core collection_loop statement yet",
        });
      }
      scan_unsupported_codegen_expr(
        stmt.collection,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_stmts(
        stmt.body,
        issues,
        hooks,
        loop_depth + 1,
      );
      return;

    case "if_stmt":
      scan_unsupported_codegen_expr(
        stmt.cond,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_stmts(stmt.body, issues, hooks, loop_depth);
      return;

    case "if_else_stmt":
      scan_unsupported_codegen_expr(
        stmt.cond,
        issues,
        hooks,
        true,
        loop_depth,
      );
      scan_unsupported_codegen_stmts(
        stmt.then_body,
        issues,
        hooks,
        loop_depth,
      );
      scan_unsupported_codegen_stmts(
        stmt.else_body,
        issues,
        hooks,
        loop_depth,
      );
      return;

    case "if_let_stmt":
      if (!hooks.if_let_stmt_supported(stmt)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "stmt",
          feature: "if_let_stmt",
          message: "Cannot emit core if_let_stmt statement yet",
        });
      }
      scan_unsupported_codegen_expr(
        stmt.target,
        issues,
        hooks,
        true,
        loop_depth,
      );
      return;

    case "type_check":
      scan_unsupported_codegen_expr(
        stmt.target,
        issues,
        hooks,
        false,
        loop_depth,
      );
      return;

    case "return":
      scan_unsupported_codegen_expr(
        stmt.value,
        issues,
        hooks,
        true,
        loop_depth,
      );
      return;

    case "expr":
      scan_unsupported_codegen_expr(
        stmt.expr,
        issues,
        hooks,
        true,
        loop_depth,
      );
      return;

    case "break":
      if (stmt.value) {
        scan_unsupported_codegen_expr(
          stmt.value,
          issues,
          hooks,
          true,
          loop_depth,
        );
      }
      if (loop_depth === 0) {
        issues.push({
          tag: "unsupported_codegen",
          node: "stmt",
          feature: "break",
          message: "Cannot emit core break outside loop",
        });
      }
      return;

    case "continue":
      if (loop_depth === 0) {
        issues.push({
          tag: "unsupported_codegen",
          node: "stmt",
          feature: "continue",
          message: "Cannot emit core continue outside loop",
        });
      }
      return;

    case "unsupported":
      issues.push({
        tag: "unsupported_codegen",
        node: "stmt",
        feature: stmt.feature,
        message: "Cannot emit core " + stmt.feature + " statement yet",
      });
      return;
  }
}

function scan_unsupported_codegen_expr(
  expr: CoreExpr,
  issues: CoreUnsupportedCodegenIssue[],
  hooks: CoreUnsupportedCodegenHooks,
  runtime_position: boolean,
  loop_depth = 0,
): void {
  if (runtime_position && hooks.type_value_expr(expr)) {
    issues.push({
      tag: "unsupported_codegen",
      node: "expr",
      feature: "type_value",
      message: "Cannot emit core type value expression yet",
    });
    return;
  }

  if (runtime_position) {
    const direct_issue = direct_unsupported_codegen_expr_issue(expr);

    if (direct_issue) {
      issues.push(direct_issue);
      return;
    }
  }

  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "linear":
    case "lam":
    case "rec":
    case "struct_type":
    case "union_type":
      return;

    case "prim":
      for (const arg of expr.args) {
        scan_unsupported_codegen_expr(
          arg,
          issues,
          hooks,
          runtime_position,
          loop_depth,
        );
      }
      return;

    case "app":
      scan_unsupported_codegen_expr(
        expr.func,
        issues,
        hooks,
        false,
        loop_depth,
      );
      for (const arg of expr.args) {
        scan_unsupported_codegen_expr(
          arg,
          issues,
          hooks,
          runtime_position,
          loop_depth,
        );
      }
      return;

    case "block":
      scan_unsupported_codegen_stmts(
        expr.statements,
        issues,
        hooks,
        loop_depth,
      );
      return;

    case "loop":
      scan_unsupported_codegen_stmts(
        expr.body,
        issues,
        hooks,
        loop_depth + 1,
      );
      return;

    case "comptime":
      scan_unsupported_codegen_expr(
        expr.expr,
        issues,
        hooks,
        false,
        loop_depth,
      );
      return;

    case "borrow":
    case "freeze":
      scan_unsupported_codegen_expr(
        expr.value,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "scratch":
      scan_unsupported_codegen_expr(
        expr.body,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "with":
      scan_unsupported_codegen_expr(
        expr.base,
        issues,
        hooks,
        false,
        loop_depth,
      );
      scan_unsupported_codegen_fields(
        expr.fields,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "struct_value":
      scan_unsupported_codegen_expr(
        expr.type_expr,
        issues,
        hooks,
        false,
        loop_depth,
      );
      scan_unsupported_codegen_fields(
        expr.fields,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "struct_update":
      scan_unsupported_codegen_expr(
        expr.base,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      scan_unsupported_codegen_fields(
        expr.fields,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "if":
      scan_unsupported_codegen_expr(
        expr.cond,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      scan_unsupported_codegen_expr(
        expr.then_branch,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      scan_unsupported_codegen_expr(
        expr.else_branch,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "if_let":
      if (!hooks.if_let_expr_supported(expr)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "expr",
          feature: "if_let",
          message: "Cannot emit core if_let expression yet",
        });
      }
      scan_unsupported_codegen_expr(
        expr.target,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "field":
      scan_unsupported_codegen_expr(
        expr.object,
        issues,
        hooks,
        false,
        loop_depth,
      );
      return;

    case "index":
      if (!hooks.index_expr_supported(expr)) {
        issues.push({
          tag: "unsupported_codegen",
          node: "expr",
          feature: "index",
          message: "Cannot emit core index expression yet",
        });
      }
      scan_unsupported_codegen_expr(
        expr.object,
        issues,
        hooks,
        false,
        loop_depth,
      );
      scan_unsupported_codegen_expr(
        expr.index,
        issues,
        hooks,
        runtime_position,
        loop_depth,
      );
      return;

    case "union_case":
      if (expr.value) {
        scan_unsupported_codegen_expr(
          expr.value,
          issues,
          hooks,
          runtime_position,
          loop_depth,
        );
      }

      if (expr.type_expr) {
        scan_unsupported_codegen_expr(
          expr.type_expr,
          issues,
          hooks,
          false,
          loop_depth,
        );
      }
      return;

    case "unsupported":
      if (expr.feature === "missing_capability_method") {
        issues.push({
          tag: "unsupported_codegen",
          node: "expr",
          feature: expr.feature,
          message: "Missing host capability method: " + expr.text,
        });
        return;
      }

      issues.push({
        tag: "unsupported_codegen",
        node: "expr",
        feature: expr.feature,
        message: "Cannot emit core " + expr.feature + " expression yet",
      });
      return;
  }
}

function direct_unsupported_codegen_expr_issue(
  expr: CoreExpr,
): CoreUnsupportedCodegenIssue | undefined {
  switch (expr.tag) {
    case "rec":
    case "comptime":
    case "with":
      return {
        tag: "unsupported_codegen",
        node: "expr",
        feature: expr.tag,
        message: "Cannot emit core " + expr.tag + " expression yet",
      };

    case "num":
    case "text":
    case "type_name":
    case "var":
    case "prim":
    case "lam":
    case "app":
    case "block":
    case "loop":
    case "borrow":
    case "freeze":
    case "scratch":
    case "struct_type":
    case "struct_value":
    case "struct_update":
    case "union_type":
    case "if":
    case "if_let":
    case "field":
    case "index":
    case "union_case":
      return undefined;

    case "unsupported":
      if (expr.feature === "missing_capability_method") {
        return {
          tag: "unsupported_codegen",
          node: "expr",
          feature: expr.feature,
          message: "Missing host capability method: " + expr.text,
        };
      }

      return undefined;
  }
}

function scan_unsupported_codegen_fields(
  fields: CoreField[],
  issues: CoreUnsupportedCodegenIssue[],
  hooks: CoreUnsupportedCodegenHooks,
  runtime_position: boolean,
  loop_depth: number,
): void {
  for (const field of fields) {
    scan_unsupported_codegen_expr(
      field.value,
      issues,
      hooks,
      runtime_position,
      loop_depth,
    );
  }
}
