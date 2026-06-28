import { expect } from "./expect.ts";
import { Expr, type Expr as ExprNode } from "./expr.ts";
import { arity, PRIMS, type Prim, type ValType } from "./op.ts";
import type { Emit, Format, Reduce } from "./trait.ts";

export type IC =
  | { tag: "num"; type: ValType; value: number | bigint }
  | { tag: "var"; name: string }
  | { tag: "prim"; prim: Prim; args: IC[] }
  | { tag: "lam"; name: string; body: IC }
  | { tag: "app"; func: IC; arg: IC }
  | { tag: "dup"; name: string; expr: IC; body: IC };

export function IC() {}

function arg(args: IC[], index: number): IC {
  const value = args[index];
  expect(value, "Missing argument " + index);
  return value;
}

function exprArg(args: ExprNode[], index: number): ExprNode {
  const value = args[index];
  expect(value, "Missing argument " + index);
  return value;
}

IC.fmt = function fmt(ic: IC): string {
  if (ic.tag === "num") {
    return ic.value.toString() + ":" + ic.type;
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

  if (ic.tag === "lam") {
    const body = fmt(ic.body);
    return `λ${ic.name}. ${body}`;
  }

  if (ic.tag === "app") {
    const func = fmt(ic.func);
    const arg = fmt(ic.arg);
    return `(${func})(${arg})`;
  }

  if (ic.tag === "dup") {
    const expr = fmt(ic.expr);
    const body = fmt(ic.body);
    return `! ${ic.name} &D = ${expr};\n${body}`;
  }

  ic satisfies never;
  throw new Error("panic");
};

IC.reduce = function reduce(ic: IC): IC {
  if (ic.tag === "num" || ic.tag === "var") {
    return ic;
  }

  if (ic.tag === "prim") {
    return {
      tag: "prim",
      prim: ic.prim,
      args: ic.args.map(reduce),
    };
  }

  if (ic.tag === "lam") {
    return {
      tag: "lam",
      name: ic.name,
      body: reduce(ic.body),
    };
  }

  if (ic.tag === "app") {
    const func = reduce(ic.func);
    const arg = reduce(ic.arg);

    if (func.tag === "lam") {
      return reduce(subst(func.body, func.name, arg));
    }

    return {
      tag: "app",
      func,
      arg,
    };
  }

  if (ic.tag === "dup") {
    return {
      tag: "dup",
      name: ic.name,
      expr: reduce(ic.expr),
      body: reduce(ic.body),
    };
  }

  ic satisfies never;
  throw new Error("panic");
};

IC.emit = function emit(ic: IC): ExprNode {
  return lower(IC.reduce(ic), new Map());
};

IC satisfies Format<IC> & Reduce<IC> & Emit<IC, ExprNode>;

function subst(ic: IC, name: string, value: IC): IC {
  if (ic.tag === "num") {
    return ic;
  }

  if (ic.tag === "var") {
    if (ic.name === name) {
      return value;
    }

    return ic;
  }

  if (ic.tag === "prim") {
    return {
      tag: "prim",
      prim: ic.prim,
      args: ic.args.map((item) => subst(item, name, value)),
    };
  }

  if (ic.tag === "lam") {
    if (ic.name === name) {
      return ic;
    }

    return {
      tag: "lam",
      name: ic.name,
      body: subst(ic.body, name, value),
    };
  }

  if (ic.tag === "app") {
    return {
      tag: "app",
      func: subst(ic.func, name, value),
      arg: subst(ic.arg, name, value),
    };
  }

  if (ic.tag === "dup") {
    return {
      tag: "dup",
      name: ic.name,
      expr: subst(ic.expr, name, value),
      body: subst(ic.body, name, value),
    };
  }

  ic satisfies never;
  throw new Error("panic");
}

function lower(ic: IC, env: Map<string, ValType>): ExprNode {
  if (ic.tag === "num") {
    return { tag: "num", type: ic.type, value: ic.value };
  }

  if (ic.tag === "var") {
    const type = env.get(ic.name);
    expect(type, "Unbound variable: " + ic.name);
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
      const actual = Expr.type(item);
      expect(actual === type, "Primitive operands must have the same type");
    }

    return {
      tag: "prim",
      type,
      prim: ic.prim,
      args,
    };
  }

  if (ic.tag === "lam") {
    throw new Error("Cannot lower lambda before reduction");
  }

  if (ic.tag === "app") {
    throw new Error("Cannot lower application before reduction");
  }

  if (ic.tag === "dup") {
    const value = lower(ic.expr, env);
    const type = Expr.type(value);
    env = new Map(env);

    env.set(`${ic.name}0`, type);
    env.set(`${ic.name}1`, type);

    return {
      tag: "let",
      name: ic.name,
      value,
      body: rename(lower(ic.body, env), ic.name),
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
