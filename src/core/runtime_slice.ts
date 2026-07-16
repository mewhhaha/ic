import type { Core, CoreExpr, CoreStmt } from "./ast.ts";

export type CoreRuntimeSliceFact = {
  element_type: "i32" | "Text";
  element_ownership: "scalar_local" | "frozen_shareable";
  ownership: "unique_heap";
  pointer_offset: 4;
  length: CoreExpr;
  capacity: number;
};

export function core_runtime_i32_slice(
  expr: CoreExpr,
): Extract<CoreExpr, { tag: "app" }> | undefined {
  if (expr.tag !== "app") {
    return undefined;
  }

  if (expr.func.tag !== "var") {
    return undefined;
  }

  if (expr.func.name !== "@runtime_i32_slice") {
    return undefined;
  }

  return expr;
}

export function core_runtime_slice_fact(
  expr: CoreExpr,
): CoreRuntimeSliceFact | undefined {
  if (expr.tag !== "app" || expr.func.tag !== "var") {
    return undefined;
  }

  let element_type: CoreRuntimeSliceFact["element_type"];
  let element_ownership: CoreRuntimeSliceFact["element_ownership"];
  if (expr.func.name === "@runtime_i32_slice") {
    element_type = "i32";
    element_ownership = "scalar_local";
  } else if (expr.func.name === "@runtime_text_slice") {
    element_type = "Text";
    element_ownership = "frozen_shareable";
  } else {
    return undefined;
  }

  const length = expr.args[0];
  if (!length) {
    return undefined;
  }

  return {
    element_type,
    element_ownership,
    ownership: "unique_heap",
    pointer_offset: 4,
    length,
    capacity: expr.args.length - 1,
  };
}

export function core_runtime_i32_slice_fact(
  expr: CoreExpr,
): CoreRuntimeSliceFact | undefined {
  const fact = core_runtime_slice_fact(expr);
  if (!fact || fact.element_type !== "i32") {
    return undefined;
  }
  return fact;
}

export function core_runtime_slice_facts(core: Core): CoreRuntimeSliceFact[] {
  const facts: CoreRuntimeSliceFact[] = [];
  scan_runtime_slice_stmts(core.statements, facts);
  return facts;
}

function scan_runtime_slice_stmts(
  statements: CoreStmt[],
  facts: CoreRuntimeSliceFact[],
): void {
  for (const stmt of statements) {
    if (stmt.tag === "collection_loop") {
      const fact = core_runtime_slice_fact(stmt.collection);
      if (fact) {
        facts.push(fact);
      }
      scan_runtime_slice_stmts(stmt.body, facts);
      continue;
    }

    if (
      stmt.tag === "range_loop" || stmt.tag === "if_stmt" ||
      stmt.tag === "if_let_stmt"
    ) {
      scan_runtime_slice_stmts(stmt.body, facts);
      continue;
    }

    if (stmt.tag === "if_else_stmt") {
      scan_runtime_slice_stmts(stmt.then_body, facts);
      scan_runtime_slice_stmts(stmt.else_body, facts);
    }
  }
}

export function runtime_slice_index_local(id: number): string {
  return "_slice_index#" + id.toString();
}

export function runtime_slice_value_local(id: number): string {
  return "_slice_value#" + id.toString();
}

export function runtime_slice_end_local(id: number): string {
  return "_slice_end#" + id.toString();
}
