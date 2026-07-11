import { expect } from "../../expect.ts";
import type { FrontExpr, Stmt } from "../ast.ts";

export type CallOnlyUseScan = {
  valid: boolean;
  used: boolean;
};

export function scan_call_only_stmt_tail(
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
    case "continue":
    case "unsupported":
      return { valid: true, used: false };

    case "break":
      if (!stmt.value) {
        return { valid: true, used: false };
      }

      return scan_call_only_expr(name, stmt.value, false);

    case "bind": {
      const scan = scan_call_only_expr(name, stmt.value, false);

      if (!scan.valid) {
        return scan;
      }

      return scan;
    }

    case "state_bind":
    case "bind_pattern":
      return scan_call_only_expr(name, stmt.value, false);

    case "resume_dup":
      return scan_call_only_expr(name, stmt.value, false);

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
    case "atom":
    case "unit":
    case "text":
    case "type_name":
    case "set_type":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return { valid: true, used: false };

    case "is":
      return scan_call_only_expr(name, expr.value, false);

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

    case "loop":
      return scan_call_only_stmts(name, expr.body);

    case "captured":
      return scan_call_only_expr(name, expr.expr, call_target);

    case "handler": {
      let result: CallOnlyUseScan = { valid: true, used: false };
      let state_shadows_name = false;

      for (const state of expr.state) {
        if (!state_shadows_name) {
          result = merge_call_only_scans(
            result,
            scan_call_only_expr(name, state.value, false),
          );

          if (!result.valid) {
            return result;
          }
        }

        if (state.name === name) {
          state_shadows_name = true;
        }
      }

      if (state_shadows_name) {
        return result;
      }

      for (const clause of expr.clauses) {
        if (params_shadow_name(clause.params, name)) {
          continue;
        }

        result = merge_call_only_scans(
          result,
          scan_call_only_expr(name, clause.body, false),
        );

        if (!result.valid) {
          return result;
        }
      }

      if (expr.return_clause.param.name === name) {
        return result;
      }

      return merge_call_only_scans(
        result,
        scan_call_only_expr(name, expr.return_clause.body, false),
      );
    }

    case "try_with":
      return merge_call_only_scans(
        scan_call_only_expr(name, expr.body, false),
        scan_call_only_expr(name, expr.handler, false),
      );

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
  if (stmt.tag === "resume_dup") {
    return stmt.left === name || stmt.right === name;
  }

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
