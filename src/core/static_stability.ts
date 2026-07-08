import type { CoreExpr } from "./ast.ts";

export function stable_static_struct_value(
  value: CoreExpr,
): Extract<CoreExpr, { tag: "struct_value" }> | undefined {
  if (value.tag !== "struct_value") {
    return undefined;
  }

  for (const field of value.fields) {
    if (!is_stable_static_expr(field.value)) {
      return undefined;
    }
  }

  return value;
}

export function stable_static_text_value(
  value: CoreExpr,
): CoreExpr | undefined {
  if (value.tag === "text") {
    return value;
  }

  if (value.tag !== "if") {
    return undefined;
  }

  if (!is_stable_static_expr(value.cond)) {
    return undefined;
  }

  const then_text = stable_static_text_value(value.then_branch);
  const else_text = stable_static_text_value(value.else_branch);

  if (!then_text || !else_text) {
    return undefined;
  }

  return value;
}

export function is_stable_static_expr(expr: CoreExpr): boolean {
  switch (expr.tag) {
    case "num":
    case "text":
      return true;

    case "prim":
      for (const arg of expr.args) {
        if (!is_stable_static_expr(arg)) {
          return false;
        }
      }

      return true;

    case "if":
      return is_stable_static_expr(expr.cond) &&
        is_stable_static_expr(expr.then_branch) &&
        is_stable_static_expr(expr.else_branch);

    case "borrow":
      return is_stable_static_expr(expr.value);

    case "freeze":
      return is_stable_static_expr(expr.value);

    case "scratch":
      return is_stable_static_expr(expr.body);

    case "type_name":
    case "var":
    case "linear":
    case "lam":
    case "rec":
    case "rec_ref":
    case "app":
    case "block":
    case "comptime":
    case "with":
    case "struct_type":
    case "struct_value":
    case "struct_update":
    case "union_type":
    case "if_let":
    case "field":
    case "index":
    case "union_case":
    case "unsupported":
      return false;
  }
}
