import type { FrontExpr } from "./ast.ts";
import type { Env, FrontType } from "./ast.ts";
import { specialize_prim_for_operands } from "../op.ts";
import type { Prim, ValType } from "../op.ts";
import { front_type_name } from "./types.ts";

export type NumericOperandHooks = {
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  resolve_numeric_expr_type: (
    expr: FrontExpr,
    env: Env,
  ) => ValType | undefined;
};

export function i32_expr(value: number): FrontExpr {
  return { tag: "num", type: "i32", value };
}

export function parse_number_expr(text: string): FrontExpr {
  if (text.endsWith("i64")) {
    const value = text.slice(0, text.length - 3);
    return { tag: "num", type: "i64", value: BigInt(value) };
  }

  if (text.endsWith("i32")) {
    const value = text.slice(0, text.length - 3);
    return { tag: "num", type: "i32", value: Number(value) };
  }

  return { tag: "num", type: "i32", value: Number(text) };
}

export function binary_prim(
  op: string,
  left: FrontExpr,
  right: FrontExpr,
): Prim | undefined {
  const type = binary_operand_type(left, right);

  if (type === "i64") {
    if (op === "+") {
      return "i64.add";
    }

    if (op === "-") {
      return "i64.sub";
    }

    if (op === "*") {
      return "i64.mul";
    }

    if (op === "/") {
      return "i64.div_s";
    }

    if (op === "%") {
      return "i64.rem_s";
    }

    if (op === "==") {
      return "i64.eq";
    }

    if (op === "!=") {
      return "i64.ne";
    }

    if (op === "<") {
      return "i64.lt_s";
    }

    if (op === "<=") {
      return "i64.le_s";
    }

    if (op === ">") {
      return "i64.gt_s";
    }

    if (op === ">=") {
      return "i64.ge_s";
    }

    return undefined;
  }

  if (op === "+") {
    return "i32.add";
  }

  if (op === "-") {
    return "i32.sub";
  }

  if (op === "*") {
    return "i32.mul";
  }

  if (op === "/") {
    return "i32.div_s";
  }

  if (op === "%") {
    return "i32.rem_s";
  }

  if (op === "==") {
    return "i32.eq";
  }

  if (op === "!=") {
    return "i32.ne";
  }

  if (op === "<") {
    return "i32.lt_s";
  }

  if (op === "<=") {
    return "i32.le_s";
  }

  if (op === ">") {
    return "i32.gt_s";
  }

  if (op === ">=") {
    return "i32.ge_s";
  }

  return undefined;
}

export function binary_operand_type(
  left: FrontExpr,
  right: FrontExpr,
): ValType {
  const left_type = parse_numeric_expr_type(left);
  const right_type = parse_numeric_expr_type(right);

  if (left_type === "i64" || right_type === "i64") {
    // Parsing only chooses a provisional primitive width. The semantic
    // operand check owns mixed-width rejection so tolerant parsing can keep
    // the expression and attach the diagnostic to its complete source span.
    return "i64";
  }

  return "i32";
}

function parse_numeric_expr_type(expr: FrontExpr): ValType | undefined {
  if (expr.tag === "num") {
    return expr.type;
  }

  if (expr.tag === "prim") {
    if (prim_result_type(expr.prim) === "i64") {
      return "i64";
    }

    if (!prim_can_retag_to_i64(expr.prim)) {
      return "i32";
    }

    const left_type = parse_numeric_expr_type(expr.left);
    const right_type = parse_numeric_expr_type(expr.right);

    if (left_type === "i64" || right_type === "i64") {
      if (left_type === "i32" || right_type === "i32") {
        return "i32";
      }

      return "i64";
    }

    if (left_type === "i32" && right_type === "i32") {
      return "i32";
    }

    return undefined;
  }

  if (expr.tag === "captured") {
    return parse_numeric_expr_type(expr.expr);
  }

  if (expr.tag === "if") {
    const then_type = parse_numeric_expr_type(expr.then_branch);
    const else_type = parse_numeric_expr_type(expr.else_branch);

    if (then_type && then_type === else_type) {
      return then_type;
    }
  }

  return undefined;
}

function prim_can_retag_to_i64(prim: Prim): boolean {
  return prim === "i32.add" || prim === "i32.sub" || prim === "i32.mul" ||
    prim === "i32.div_s" || prim === "i32.rem_s";
}

export function prim_returns_bool(prim: Prim): boolean {
  return prim === "i32.eq" || prim === "i64.eq" || prim === "i32.ne" ||
    prim === "i64.ne" || prim === "i32.lt_s" || prim === "i64.lt_s" ||
    prim === "i32.le_s" || prim === "i64.le_s" || prim === "i32.gt_s" ||
    prim === "i64.gt_s" || prim === "i32.ge_s" || prim === "i64.ge_s";
}

export function numeric_expr_type(expr: FrontExpr): ValType | undefined {
  if (expr.tag === "num") {
    return expr.type;
  }

  if (expr.tag === "prim") {
    return prim_result_type(expr.prim);
  }

  if (expr.tag === "captured") {
    return numeric_expr_type(expr.expr);
  }

  if (expr.tag === "if") {
    const then_type = numeric_expr_type(expr.then_branch);
    const else_type = numeric_expr_type(expr.else_branch);

    if (then_type && then_type === else_type) {
      return then_type;
    }
  }

  return undefined;
}

export function check_numeric_primitive_operands(
  expr: Extract<FrontExpr, { tag: "prim" }>,
  env: Env,
  hooks: NumericOperandHooks,
): Prim {
  const left_type = hooks.infer_expr(expr.left, env);
  const right_type = hooks.infer_expr(expr.right, env);

  if (left_type.tag === "bool" || right_type.tag === "bool") {
    const equality = expr.prim === "i32.eq" || expr.prim === "i32.ne";

    if (
      equality && left_type.tag === "bool" && right_type.tag === "bool"
    ) {
      return expr.prim;
    }

    if (equality) {
      throw new Error("Boolean equality requires Bool operands");
    }
  }

  if (left_type.tag === "text" || right_type.tag === "text") {
    if (expr.prim === "i32.eq" || expr.prim === "i32.ne") {
      if (left_type.tag === "text" && right_type.tag === "text") {
        return expr.prim;
      }

      throw new Error("Text equality requires text operands");
    }

    throw new Error("Text concatenation requires visible text operands");
  }

  const left_error = numeric_operand_error(left_type);

  if (left_error) {
    throw new Error(
      "Primitive " + expr.prim + " expects numeric operands, got " +
        left_error,
    );
  }

  const right_error = numeric_operand_error(right_type);

  if (right_error) {
    throw new Error(
      "Primitive " + expr.prim + " expects numeric operands, got " +
        right_error,
    );
  }

  const left_numeric_type = hooks.resolve_numeric_expr_type(
    expr.left,
    env,
  );
  const right_numeric_type = hooks.resolve_numeric_expr_type(
    expr.right,
    env,
  );

  return specialize_prim_for_operands(
    expr.prim,
    left_numeric_type,
    right_numeric_type,
  );
}

function numeric_operand_error(type: FrontType): string | undefined {
  if (type.tag === "int" || type.tag === "unknown") {
    return undefined;
  }

  return front_type_name(type);
}

export function prim_result_type(prim: Prim): ValType {
  if (
    prim === "i64.add" || prim === "i64.sub" || prim === "i64.mul" ||
    prim === "i64.div_s" || prim === "i64.rem_s" || prim === "i64.select" ||
    prim === "i64.load" || prim === "i64.load8_u" || prim === "i64.trap"
  ) {
    return "i64";
  }

  return "i32";
}

export function select_prim_for_branches(
  then_branch: FrontExpr,
  else_branch: FrontExpr,
): Prim {
  const then_type = numeric_expr_type(then_branch);
  const else_type = numeric_expr_type(else_branch);

  if (then_type === "i64" || else_type === "i64") {
    if (then_type === "i32" || else_type === "i32") {
      throw new Error("Mixed i32 and i64 if branches");
    }

    return "i64.select";
  }

  return "i32.select";
}
