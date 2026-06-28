import { expect } from "./expect.ts";
import { Expr, type Expr as ExprNode } from "./expr.ts";
import { arity, PRIMS, type Prim, type ValType } from "./op.ts";

type PrimIC = { tag: "prim"; prim: Prim; args: IC[] };

export type IC =
  | { tag: "num"; value: number }
  | { tag: "var"; name: string }
  | PrimIC
  | { tag: "dup"; name: string; expr: IC; body: IC };

export function IC() {}

function arg(args: IC[], index: number): IC {
  const value = args[index];

  if (value === undefined) {
    throw new Error("Missing argument " + index);
  }

  return value;
}

function exprArg(args: ExprNode[], index: number): ExprNode {
  const value = args[index];

  if (value === undefined) {
    throw new Error("Missing argument " + index);
  }

  return value;
}

IC.fmt = function fmt(ic: IC): string {
  if (ic.tag === "num") {
    return ic.value.toString();
  }

  if (ic.tag === "var") {
    return ic.name;
  }

  if (ic.tag === "prim") {
    const expected = arity(ic.prim);
    expect(
      ic.args.length === expected,
      "Primitive " + ic.prim + " expects " + expected + " arguments",
    );

    const left = fmt(arg(ic.args, 0));
    const op = PRIMS[ic.prim].fmt;
    const right = fmt(arg(ic.args, 1));
    return `${left} ${op} ${right}`;
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
    const type = env.get(ic.name);

    if (type === undefined) {
      throw new Error("Unbound variable: " + ic.name);
    }

    return { tag: "var", type, name: ic.name };
  }

  if (ic.tag === "prim") {
    const expected = arity(ic.prim);
    expect(
      ic.args.length === expected,
      "Primitive " + ic.prim + " expects " + expected + " arguments",
    );

    const args = ic.args.map((item) => lower(item, env));
    const type = Expr.type(exprArg(args, 0));

    for (const item of args) {
      if (Expr.type(item) !== type) {
        throw new Error("Primitive operands must have the same type");
      }
    }

    return {
      tag: "prim",
      type,
      prim: ic.prim,
      args,
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

  if (expr.tag === "prim") {
    return {
      tag: "prim",
      type: expr.type,
      prim: expr.prim,
      args: expr.args.map((item) => rename(item, name)),
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
