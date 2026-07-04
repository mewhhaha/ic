import { expect } from "../../expect.ts";
import type { FrontExpr, Stmt } from "../ast.ts";
import { linear_param_names } from "../linear.ts";

type CallOnlyUseScan = {
  valid: boolean;
  used: boolean;
};

export function can_defer_call_only_runtime_lam_binding(
  name: string,
  value: FrontExpr,
  stmts: Stmt[],
  index: number,
  is_linear: boolean,
  error: unknown,
): boolean {
  if (!is_call_only_defer_error(error)) {
    return false;
  }

  if (is_linear) {
    return false;
  }

  if (value.tag !== "lam") {
    return false;
  }

  if (linear_param_names(value).size > 0) {
    return false;
  }

  if (expr_contains_linear(value.body)) {
    return false;
  }

  const scan = scan_call_only_stmt_tail(name, stmts, index + 1);

  if (!scan.valid) {
    return false;
  }

  return scan.used;
}

function is_call_only_defer_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error.message.startsWith(
      "Cannot lower dynamic if with unknown branches to Ic frontend",
    )
  ) {
    return true;
  }

  if (
    error.message.startsWith(
      "Cannot lower dynamic if let without typed union target to Ic frontend",
    )
  ) {
    return true;
  }

  if (
    error.message.startsWith("No-else if implicit fallback supports ") &&
    error.message.endsWith(", got unknown")
  ) {
    return true;
  }

  return false;
}

function scan_call_only_stmt_tail(
  name: string,
  stmts: Stmt[],
  start: number,
): CallOnlyUseScan {
  let used = false;

  for (let index = start; index < stmts.length; index += 1) {
    const stmt = stmts[index];
    expect(stmt, "Missing call-only scan statement " + index.toString());
    const scan = scan_call_only_stmt(name, stmt);

    if (!scan.valid) {
      return scan;
    }

    if (scan.used) {
      used = true;
    }

    if (stmt_shadows_name(stmt, name)) {
      return { valid: true, used };
    }
  }

  return { valid: true, used };
}

function scan_call_only_stmts(
  name: string,
  stmts: Stmt[],
): CallOnlyUseScan {
  return scan_call_only_stmt_tail(name, stmts, 0);
}

function scan_call_only_stmt(
  name: string,
  stmt: Stmt,
): CallOnlyUseScan {
  switch (stmt.tag) {
    case "import":
    case "host_import":
    case "break":
    case "continue":
    case "unsupported":
      return { valid: true, used: false };

    case "bind": {
      const scan = scan_call_only_expr(name, stmt.value, false);

      if (!scan.valid) {
        return scan;
      }

      return scan;
    }

    case "assign":
      return scan_call_only_expr(name, stmt.value, false);

    case "index_assign": {
      if (stmt.name === name) {
        return { valid: false, used: true };
      }

      return merge_call_only_scans(
        scan_call_only_expr(name, stmt.index, false),
        scan_call_only_expr(name, stmt.value, false),
      );
    }

    case "for_range":
      return merge_call_only_scans(
        scan_call_only_expr(name, stmt.start, false),
        scan_call_only_expr(name, stmt.end, false),
        scan_call_only_expr(name, stmt.step, false),
        scan_call_only_stmts(name, stmt.body),
      );

    case "for_collection": {
      const collection = scan_call_only_expr(name, stmt.collection, false);

      if (!collection.valid) {
        return collection;
      }

      if (stmt.index === name || stmt.item === name) {
        return collection;
      }

      return merge_call_only_scans(
        collection,
        scan_call_only_stmts(name, stmt.body),
      );
    }

    case "if_stmt":
      return merge_call_only_scans(
        scan_call_only_expr(name, stmt.cond, false),
        scan_call_only_stmts(name, stmt.body),
      );

    case "if_let_stmt":
      return merge_call_only_scans(
        scan_call_only_expr(name, stmt.target, false),
        scan_call_only_stmts(name, stmt.body),
      );

    case "type_check":
      return scan_call_only_expr(name, stmt.target, false);

    case "return":
      return scan_call_only_expr(name, stmt.value, false);

    case "expr":
      return scan_call_only_expr(name, stmt.expr, false);
  }
}

function scan_call_only_expr(
  name: string,
  expr: FrontExpr,
  call_target: boolean,
): CallOnlyUseScan {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return { valid: true, used: false };

    case "var":
      if (expr.name !== name) {
        return { valid: true, used: false };
      }

      if (call_target) {
        return { valid: true, used: true };
      }

      return { valid: false, used: true };

    case "prim":
      return merge_call_only_scans(
        scan_call_only_expr(name, expr.left, false),
        scan_call_only_expr(name, expr.right, false),
      );

    case "lam":
    case "rec":
      if (params_shadow_name(expr.params, name)) {
        return { valid: true, used: false };
      }

      if (expr_mentions_name(expr.body, name)) {
        return { valid: false, used: true };
      }

      return { valid: true, used: false };

    case "app": {
      let result = scan_call_only_expr(name, expr.func, true);

      if (!result.valid) {
        return result;
      }

      for (const arg of expr.args) {
        result = merge_call_only_scans(
          result,
          scan_call_only_expr(name, arg, false),
        );

        if (!result.valid) {
          return result;
        }
      }

      return result;
    }

    case "block":
      return scan_call_only_stmts(name, expr.statements);

    case "comptime":
      return scan_call_only_expr(name, expr.expr, false);

    case "borrow":
    case "freeze":
      return scan_call_only_expr(name, expr.value, false);

    case "scratch":
      return scan_call_only_expr(name, expr.body, false);

    case "captured":
      return scan_call_only_expr(name, expr.expr, call_target);

    case "with": {
      let result = scan_call_only_expr(name, expr.base, false);

      for (const field of expr.fields) {
        result = merge_call_only_scans(
          result,
          scan_call_only_expr(name, field.value, false),
        );

        if (!result.valid) {
          return result;
        }
      }

      return result;
    }

    case "struct_value": {
      let result = scan_call_only_expr(name, expr.type_expr, false);

      for (const field of expr.fields) {
        result = merge_call_only_scans(
          result,
          scan_call_only_expr(name, field.value, false),
        );

        if (!result.valid) {
          return result;
        }
      }

      return result;
    }

    case "struct_update": {
      let result = scan_call_only_expr(name, expr.base, false);

      for (const field of expr.fields) {
        result = merge_call_only_scans(
          result,
          scan_call_only_expr(name, field.value, false),
        );

        if (!result.valid) {
          return result;
        }
      }

      return result;
    }

    case "if":
      return merge_call_only_scans(
        scan_call_only_expr(name, expr.cond, false),
        scan_call_only_expr(name, expr.then_branch, false),
        scan_call_only_expr(name, expr.else_branch, false),
      );

    case "if_let":
      return merge_call_only_scans(
        scan_call_only_expr(name, expr.target, false),
        scan_call_only_expr(name, expr.then_branch, false),
        scan_call_only_expr(name, expr.else_branch, false),
      );

    case "field":
      return scan_call_only_expr(name, expr.object, false);

    case "index":
      return merge_call_only_scans(
        scan_call_only_expr(name, expr.object, false),
        scan_call_only_expr(name, expr.index, false),
      );

    case "union_case": {
      let result: CallOnlyUseScan = { valid: true, used: false };

      if (expr.type_expr) {
        result = scan_call_only_expr(name, expr.type_expr, false);
      }

      if (expr.value) {
        result = merge_call_only_scans(
          result,
          scan_call_only_expr(name, expr.value, false),
        );
      }

      return result;
    }

    case "linear":
      return { valid: true, used: false };
  }
}

function merge_call_only_scans(
  ...scans: CallOnlyUseScan[]
): CallOnlyUseScan {
  let used = false;

  for (const scan of scans) {
    if (!scan.valid) {
      return scan;
    }

    if (scan.used) {
      used = true;
    }
  }

  return { valid: true, used };
}

function stmt_shadows_name(stmt: Stmt, name: string): boolean {
  if (stmt.tag !== "bind" && stmt.tag !== "assign") {
    return false;
  }

  return stmt.name === name;
}

function params_shadow_name(
  params: Extract<FrontExpr, { tag: "lam" | "rec" }>["params"],
  name: string,
): boolean {
  for (const param of params) {
    if (param.name === name) {
      return true;
    }
  }

  return false;
}

function expr_mentions_name(expr: FrontExpr, name: string): boolean {
  const scan = scan_name_expr(expr, name);
  return scan.used;
}

function expr_contains_linear(expr: FrontExpr): boolean {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "var":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return false;

    case "linear":
      return true;

    case "prim":
      return expr_contains_linear(expr.left) ||
        expr_contains_linear(expr.right);

    case "lam":
    case "rec":
      return expr_contains_linear(expr.body);

    case "app":
      if (expr_contains_linear(expr.func)) {
        return true;
      }

      for (const arg of expr.args) {
        if (expr_contains_linear(arg)) {
          return true;
        }
      }

      return false;

    case "block":
      return stmts_contain_linear(expr.statements);

    case "comptime":
      return expr_contains_linear(expr.expr);

    case "borrow":
    case "freeze":
      return expr_contains_linear(expr.value);

    case "scratch":
      return expr_contains_linear(expr.body);

    case "captured":
      return expr_contains_linear(expr.expr);

    case "with":
      if (expr_contains_linear(expr.base)) {
        return true;
      }

      return fields_contain_linear(expr.fields);

    case "struct_value":
      if (expr_contains_linear(expr.type_expr)) {
        return true;
      }

      return fields_contain_linear(expr.fields);

    case "struct_update":
      if (expr_contains_linear(expr.base)) {
        return true;
      }

      return fields_contain_linear(expr.fields);

    case "if":
      return expr_contains_linear(expr.cond) ||
        expr_contains_linear(expr.then_branch) ||
        expr_contains_linear(expr.else_branch);

    case "if_let":
      return expr_contains_linear(expr.target) ||
        expr_contains_linear(expr.then_branch) ||
        expr_contains_linear(expr.else_branch);

    case "field":
      return expr_contains_linear(expr.object);

    case "index":
      return expr_contains_linear(expr.object) ||
        expr_contains_linear(expr.index);

    case "union_case":
      if (expr.type_expr && expr_contains_linear(expr.type_expr)) {
        return true;
      }

      if (expr.value && expr_contains_linear(expr.value)) {
        return true;
      }

      return false;
  }
}

function fields_contain_linear(
  fields: Extract<
    FrontExpr,
    { tag: "with" | "struct_value" | "struct_update" }
  >[
    "fields"
  ],
): boolean {
  for (const field of fields) {
    if (expr_contains_linear(field.value)) {
      return true;
    }
  }

  return false;
}

function stmts_contain_linear(stmts: Stmt[]): boolean {
  for (const stmt of stmts) {
    if (stmt_contains_linear(stmt)) {
      return true;
    }
  }

  return false;
}

function stmt_contains_linear(stmt: Stmt): boolean {
  switch (stmt.tag) {
    case "import":
    case "host_import":
    case "break":
    case "continue":
    case "unsupported":
      return false;

    case "bind":
    case "assign":
      return expr_contains_linear(stmt.value);

    case "index_assign":
      return expr_contains_linear(stmt.index) ||
        expr_contains_linear(stmt.value);

    case "for_range":
      return expr_contains_linear(stmt.start) ||
        expr_contains_linear(stmt.end) ||
        expr_contains_linear(stmt.step) ||
        stmts_contain_linear(stmt.body);

    case "for_collection":
      return expr_contains_linear(stmt.collection) ||
        stmts_contain_linear(stmt.body);

    case "if_stmt":
      return expr_contains_linear(stmt.cond) ||
        stmts_contain_linear(stmt.body);

    case "if_let_stmt":
      return expr_contains_linear(stmt.target) ||
        stmts_contain_linear(stmt.body);

    case "type_check":
      return expr_contains_linear(stmt.target);

    case "return":
      return expr_contains_linear(stmt.value);

    case "expr":
      return expr_contains_linear(stmt.expr);
  }
}

function scan_name_expr(
  expr: FrontExpr,
  name: string,
): CallOnlyUseScan {
  switch (expr.tag) {
    case "var":
      if (expr.name === name) {
        return { valid: true, used: true };
      }

      return { valid: true, used: false };

    case "lam":
    case "rec":
      if (params_shadow_name(expr.params, name)) {
        return { valid: true, used: false };
      }

      return scan_name_expr(expr.body, name);

    default:
      return scan_call_only_expr(name, expr, true);
  }
}
