import type { FrontExpr } from "./ast.ts";
import type { Env, FrontType } from "./ast.ts";
import {
  numeric_builtin_prim,
  Prim,
  specialize_prim_for_operands,
} from "../op.ts";
import type { ValType } from "../op.ts";
import { Callable } from "../trait.ts";
import { front_type_name } from "./types.ts";
import { compiler_builtin_args } from "./call_args.ts";
import {
  integer_literal_fits,
  integer_type_from_name,
  integer_val_type,
} from "../integer.ts";

export type NumericOperandHooks = {
  infer_expr: (expr: FrontExpr, env: Env) => FrontType;
  resolve_numeric_expr_type: (
    expr: FrontExpr,
    env: Env,
  ) => ValType | undefined;
};

export type NumericBuiltinCall = {
  prim: Prim;
  args: FrontExpr[];
};

export function numeric_builtin_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
): NumericBuiltinCall | undefined {
  if (expr.func.tag !== "var") {
    return undefined;
  }

  const prim = numeric_builtin_prim(expr.func.name);

  if (!prim) {
    return undefined;
  }

  return { prim, args: compiler_builtin_args(expr) };
}

export function i32_expr(value: number): FrontExpr {
  return { tag: "num", type: "i32", value };
}

export function parse_number_expr(text: string): FrontExpr {
  if (text.endsWith("f64")) {
    const literal = text.slice(0, text.length - 3);
    const value = Number(literal);

    if (!Number.isFinite(value)) {
      throw new Error("f64 literal is out of range: " + literal);
    }

    return { tag: "num", type: "f64", value };
  }

  if (text.endsWith("f32")) {
    const literal = text.slice(0, text.length - 3);
    const value = Math.fround(Number(literal));

    if (!Number.isFinite(value)) {
      throw new Error("f32 literal is out of range: " + literal);
    }

    return { tag: "num", type: "f32", value };
  }

  const integer_suffix = /([iu])([1-9][0-9]*)$/.exec(text);

  if (integer_suffix) {
    const suffix = integer_suffix[0];
    const integer = integer_type_from_name(suffix.toUpperCase());

    if (!integer) {
      throw new Error("Invalid fixed-width integer suffix: " + suffix);
    }

    const literal = text.slice(0, text.length - suffix.length);
    const value = BigInt(literal);

    let fits = integer_literal_fits(integer, value);

    if (integer.signed) {
      const minimum_magnitude = 1n << BigInt(integer.width - 1);

      if (value === minimum_magnitude) {
        fits = true;
      }
    }

    if (!fits) {
      throw new Error(
        "Integer literal " + literal + " is out of range for " +
          suffix.toUpperCase(),
      );
    }

    const carrier = integer_val_type(integer);
    let type: "i32" | "i64" = "i64";

    if (carrier) {
      type = carrier;
    }

    if (type === "i32") {
      if (suffix === "i32") {
        return { tag: "num", type, value: Number(value) };
      }

      return { tag: "num", type, value: Number(value), integer };
    }

    if (suffix === "i64") {
      return { tag: "num", type, value };
    }

    return { tag: "num", type, value, integer };
  }

  return { tag: "num", type: "i32", value: Number(text) };
}

export function binary_prim(
  op: string,
  left: FrontExpr,
  right: FrontExpr,
): Prim | undefined {
  const type = binary_operand_type(left, right);

  if (type === "f32" || type === "f64") {
    const prefix = type + ".";
    if (op === "+") {
      return prefix + "add" as Prim;
    }

    if (op === "-") {
      return prefix + "sub" as Prim;
    }

    if (op === "*") {
      return prefix + "mul" as Prim;
    }

    if (op === "/") {
      return prefix + "div" as Prim;
    }

    if (op === "==") {
      return prefix + "eq" as Prim;
    }

    if (op === "!=") {
      return prefix + "ne" as Prim;
    }

    if (op === "<") {
      return prefix + "lt" as Prim;
    }

    if (op === "<=") {
      return prefix + "le" as Prim;
    }

    if (op === ">") {
      return prefix + "gt" as Prim;
    }

    if (op === ">=") {
      return prefix + "ge" as Prim;
    }

    return undefined;
  }

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

  if (left_type === "f64" || right_type === "f64") {
    return "f64";
  }

  if (left_type === "f32" || right_type === "f32") {
    return "f32";
  }

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
    const result_type = prim_result_type(expr.prim);

    if (
      result_type === "i64" || result_type === "f32" ||
      result_type === "f64"
    ) {
      return result_type;
    }

    if (!prim_can_retag(expr.prim)) {
      return "i32";
    }

    const left_type = parse_numeric_expr_type(expr.left);
    const right_type = parse_numeric_expr_type(expr.right);

    if (left_type === "f64" || right_type === "f64") {
      if (left_type !== undefined && left_type !== "f64") {
        return "i32";
      }

      if (right_type !== undefined && right_type !== "f64") {
        return "i32";
      }

      return "f64";
    }

    if (left_type === "f32" || right_type === "f32") {
      if (left_type !== undefined && left_type !== "f32") {
        return "i32";
      }

      if (right_type !== undefined && right_type !== "f32") {
        return "i32";
      }

      return "f32";
    }

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

function prim_can_retag(prim: Prim): boolean {
  return prim === "i32.add" || prim === "i32.sub" || prim === "i32.mul" ||
    prim === "i32.div_s" || prim === "i32.rem_s" || prim === "i32.and" ||
    prim === "i32.or" || prim === "i32.xor" || prim === "i32.shl" ||
    prim === "i32.shr_u";
}

export function prim_returns_bool(prim: Prim): boolean {
  return prim === "i32.eq" || prim === "i64.eq" || prim === "i32.ne" ||
    prim === "i64.ne" || prim === "i32.lt_s" || prim === "i64.lt_s" ||
    prim === "i32.le_s" || prim === "i64.le_s" || prim === "i32.gt_s" ||
    prim === "i64.gt_s" || prim === "i32.ge_s" || prim === "i64.ge_s" ||
    prim === "f32.eq" || prim === "f32.ne" || prim === "f32.lt" ||
    prim === "f32.le" || prim === "f32.gt" || prim === "f32.ge" ||
    prim === "f64.eq" || prim === "f64.ne" || prim === "f64.lt" ||
    prim === "f64.le" || prim === "f64.gt" || prim === "f64.ge";
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

  if (left_type.tag === "char" || right_type.tag === "char") {
    const equality = expr.prim === "i32.eq" || expr.prim === "i32.ne";

    if (
      equality && left_type.tag === "char" && right_type.tag === "char"
    ) {
      return expr.prim;
    }

    if (equality) {
      throw new Error("Char equality requires Char operands");
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
  return Callable.type(Prim, prim).result;
}

export function select_prim_for_branches(
  then_branch: FrontExpr,
  else_branch: FrontExpr,
): Prim {
  const then_type = numeric_expr_type(then_branch);
  const else_type = numeric_expr_type(else_branch);

  if (then_type === "f64" || else_type === "f64") {
    if (then_type !== undefined && then_type !== "f64") {
      throw new Error("Mixed f64 and " + then_type + " if branches");
    }

    if (else_type !== undefined && else_type !== "f64") {
      throw new Error("Mixed f64 and " + else_type + " if branches");
    }

    return "f64.select";
  }

  if (then_type === "f32" || else_type === "f32") {
    if (then_type !== undefined && then_type !== "f32") {
      throw new Error("Mixed f32 and " + then_type + " if branches");
    }

    if (else_type !== undefined && else_type !== "f32") {
      throw new Error("Mixed f32 and " + else_type + " if branches");
    }

    return "f32.select";
  }

  if (then_type === "i64" || else_type === "i64") {
    if (then_type === "i32" || else_type === "i32") {
      throw new Error("Mixed i32 and i64 if branches");
    }

    return "i64.select";
  }

  return "i32.select";
}
