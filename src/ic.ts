import { Expr, type Expr as ExprNode } from "./expr.ts";
import { fmtOp, isOp, type Op, type ValType } from "./op.ts";

type BinaryIC = { tag: Op; left: IC; right: IC };

export type IC =
  | { tag: "num"; value: number }
  | { tag: "var"; name: string }
  | BinaryIC
  | { tag: "dup"; name: string; expr: IC; body: IC };

export function IC() {}

IC.fmt = function fmt(ic: IC): string {
  if (ic.tag === "num") {
    return ic.value.toString();
  }

  if (ic.tag === "var") {
    return ic.name;
  }

  if (isOp(ic.tag)) {
    const left = fmt(ic.left);
    const right = fmt(ic.right);
    return `${left} ${fmtOp(ic.tag)} ${right}`;
  }

  if (ic.tag === "dup") {
    const expr = fmt(ic.expr);
    const body = fmt(ic.body);
    return `! ${ic.name} &D = ${expr};\n${body}`;
  }

  ic satisfies never;
  throw new Error("panic");
};

IC.emit = function emit(ic: IC): ExprNode {
  return lower(ic, new Map());
};

function lower(ic: IC, env: Map<string, ValType>): ExprNode {
  if (ic.tag === "num") {
    return { tag: "num", type: "i32", value: ic.value };
  }

  if (ic.tag === "var") {
    return { tag: "var", type: env.get(ic.name) ?? "i32", name: ic.name };
  }

  if (isOp(ic.tag)) {
    const left = lower(ic.left, env);
    const right = lower(ic.right, env);
    const type = Expr.type(left);

    if (Expr.type(right) !== type) {
      throw new Error("Binary operands must have the same type");
    }

    return {
      tag: "bin",
      type,
      op: ic.tag,
      left,
      right,
    };
  }

  if (ic.tag === "dup") {
    const value = lower(ic.expr, env);
    const type = Expr.type(value);
    const nextEnv = new Map(env);

    nextEnv.set(`${ic.name}0`, type);
    nextEnv.set(`${ic.name}1`, type);

    return {
      tag: "let",
      name: ic.name,
      value,
      body: rename(lower(ic.body, nextEnv), ic.name),
    };
  }

  ic satisfies never;
  throw new Error("panic");
}

function rename(expr: ExprNode, name: string): ExprNode {
  if (expr.tag === "num") {
    return expr;
  }

  if (expr.tag === "var") {
    if (expr.name === `${name}0` || expr.name === `${name}1`) {
      return { ...expr, name };
    }

    return expr;
  }

  if (expr.tag === "bin") {
    return {
      tag: "bin",
      type: expr.type,
      op: expr.op,
      left: rename(expr.left, name),
      right: rename(expr.right, name),
    };
  }

  if (expr.tag === "let") {
    return {
      tag: "let",
      name: expr.name,
      value: rename(expr.value, name),
      body: rename(expr.body, name),
    };
  }

  expr satisfies never;
  throw new Error("panic");
}
