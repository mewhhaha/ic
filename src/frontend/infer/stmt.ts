import { expect } from "../../expect.ts";
import type { Env, FrontType, Stmt } from "../ast.ts";
import { lookup } from "../env.ts";
import type { InferExprFn, InferHooks } from "./types.ts";

export function infer_stmt_result_with(
  stmt: Stmt | undefined,
  env: Env,
  hooks: InferHooks,
  infer_expr: InferExprFn,
): FrontType {
  expect(stmt, "Missing statement for inference");

  if (stmt.tag === "import" || stmt.tag === "host_import") {
    return { tag: "unknown" };
  }

  if (stmt.tag === "expr") {
    return infer_expr(stmt.expr, env, hooks);
  }

  if (stmt.tag === "return") {
    return infer_expr(stmt.value, env, hooks);
  }

  if (stmt.tag === "bind") {
    return infer_expr(stmt.value, env, hooks);
  }

  if (stmt.tag === "assign") {
    return infer_expr(stmt.value, env, hooks);
  }

  if (stmt.tag === "index_assign") {
    const binding = lookup(env, stmt.name);

    if (binding) {
      return binding.type;
    }

    return { tag: "unknown" };
  }

  if (stmt.tag === "for_range") {
    return { tag: "unknown" };
  }

  if (stmt.tag === "for_collection") {
    return { tag: "unknown" };
  }

  if (stmt.tag === "if_stmt") {
    return infer_expr(
      {
        tag: "if",
        cond: stmt.cond,
        then_branch: { tag: "block", statements: stmt.body },
        else_branch: {
          tag: "unsupported",
          feature: "implicit if statement fallback",
          text: "",
        },
        implicit_else: true,
      },
      env,
      hooks,
    );
  }

  if (stmt.tag === "if_let_stmt") {
    return infer_expr(
      {
        tag: "if_let",
        case_name: stmt.case_name,
        value_name: stmt.value_name,
        target: stmt.target,
        then_branch: { tag: "block", statements: stmt.body },
        else_branch: {
          tag: "unsupported",
          feature: "implicit if let statement fallback",
          text: "",
        },
        implicit_else: true,
      },
      env,
      hooks,
    );
  }

  if (stmt.tag === "type_check") {
    return { tag: "unknown" };
  }

  if (stmt.tag === "break" || stmt.tag === "continue") {
    return { tag: "unknown" };
  }

  return { tag: "unknown" };
}
