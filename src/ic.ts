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
  | { tag: "sup"; label: string; left: IC; right: IC }
  | { tag: "dup"; label: string; name: string; expr: IC; body: IC };

type Ctx = {
  used: Set<string>;
  next: number;
  name: (prefix: string) => string;
  var: (prefix: string) => string;
};

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

  if (ic.tag === "sup") {
    const left = fmt(ic.left);
    const right = fmt(ic.right);
    return `&${ic.label}{${left}, ${right}}`;
  }

  if (ic.tag === "dup") {
    const expr = fmt(ic.expr);
    const body = fmt(ic.body);
    return `! ${ic.name} &${ic.label} = ${expr};\n${body}`;
  }

  ic satisfies never;
  throw new Error("panic");
};

IC.reduce = function reduceRoot(ic: IC): IC {
  const ctx = Ctx(ic);
  return reduce(ic, ctx);
};

IC.emit = function emit(ic: IC): ExprNode {
  return lower(IC.reduce(ic), new Map());
};

IC satisfies Format<IC> & Reduce<IC> & Emit<IC, ExprNode>;

function reduce(ic: IC, ctx: Ctx): IC {
  if (ic.tag === "num" || ic.tag === "var") {
    return ic;
  }

  if (ic.tag === "prim") {
    const expected = arity(ic.prim);
    expect(
      ic.args.length === expected,
      "Primitive " + ic.prim + " expects " + expected + " arguments",
    );

    const args = ic.args.map((item) => reduce(item, ctx));

    for (let index = 0; index < args.length; index += 1) {
      const item = args[index];
      expect(item, "Missing primitive argument " + index);

      if (item.tag === "sup") {
        const leftArgs: IC[] = [];
        const rightArgs: IC[] = [];
        const copyNames: string[] = [];
        const copyExprs: IC[] = [];

        for (let pos = 0; pos < args.length; pos += 1) {
          const input = args[pos];
          expect(input, "Missing primitive argument " + pos);

          if (pos === index) {
            leftArgs.push(item.left);
            rightArgs.push(item.right);
          } else {
            const name = ctx.name("p");
            copyNames.push(name);
            copyExprs.push(input);
            leftArgs.push({ tag: "var", name: `${name}0` });
            rightArgs.push({ tag: "var", name: `${name}1` });
          }
        }

        let body: IC = {
          tag: "sup",
          label: item.label,
          left: { tag: "prim", prim: ic.prim, args: leftArgs },
          right: { tag: "prim", prim: ic.prim, args: rightArgs },
        };

        for (let copy = copyNames.length - 1; copy >= 0; copy -= 1) {
          const name = copyNames[copy];
          const expr = copyExprs[copy];
          expect(name, "Missing copied primitive name");
          expect(expr, "Missing copied primitive expression");

          body = {
            tag: "dup",
            label: item.label,
            name,
            expr,
            body,
          };
        }

        return reduce(body, ctx);
      }
    }

    const left = arg(args, 0);
    const right = arg(args, 1);

    if (left.tag === "num" && right.tag === "num") {
      expect(left.type === right.type, "Primitive numbers must have the same type");

      if (left.type === "i32") {
        const leftValue = left.value;
        const rightValue = right.value;
        expect(typeof leftValue === "number", "Expected i32 number");
        expect(typeof rightValue === "number", "Expected i32 number");

        if (ic.prim === "add") {
          return { tag: "num", type: "i32", value: (leftValue + rightValue) | 0 };
        }

        if (ic.prim === "sub") {
          return { tag: "num", type: "i32", value: (leftValue - rightValue) | 0 };
        }

        if (ic.prim === "mul") {
          return { tag: "num", type: "i32", value: Math.imul(leftValue, rightValue) };
        }

        ic.prim satisfies never;
        throw new Error("panic");
      }

      if (left.type === "i64") {
        const leftValue = left.value;
        const rightValue = right.value;
        expect(typeof leftValue === "bigint", "Expected i64 bigint");
        expect(typeof rightValue === "bigint", "Expected i64 bigint");

        if (ic.prim === "add") {
          return {
            tag: "num",
            type: "i64",
            value: BigInt.asIntN(64, leftValue + rightValue),
          };
        }

        if (ic.prim === "sub") {
          return {
            tag: "num",
            type: "i64",
            value: BigInt.asIntN(64, leftValue - rightValue),
          };
        }

        if (ic.prim === "mul") {
          return {
            tag: "num",
            type: "i64",
            value: BigInt.asIntN(64, leftValue * rightValue),
          };
        }

        ic.prim satisfies never;
        throw new Error("panic");
      }

      left.type satisfies never;
      throw new Error("panic");
    }

    return {
      tag: "prim",
      prim: ic.prim,
      args,
    };
  }

  if (ic.tag === "lam") {
    return {
      tag: "lam",
      name: ic.name,
      body: reduce(ic.body, ctx),
    };
  }

  if (ic.tag === "app") {
    const func = reduce(ic.func, ctx);
    const arg = reduce(ic.arg, ctx);

    if (func.tag === "lam") {
      return reduce(subst(func.body, func.name, arg), ctx);
    }

    if (func.tag === "sup") {
      const name = ctx.name("x");
      return reduce({
        tag: "dup",
        label: func.label,
        name,
        expr: arg,
        body: {
          tag: "sup",
          label: func.label,
          left: {
            tag: "app",
            func: func.left,
            arg: { tag: "var", name: `${name}0` },
          },
          right: {
            tag: "app",
            func: func.right,
            arg: { tag: "var", name: `${name}1` },
          },
        },
      }, ctx);
    }

    return {
      tag: "app",
      func,
      arg,
    };
  }

  if (ic.tag === "sup") {
    return {
      tag: "sup",
      label: ic.label,
      left: reduce(ic.left, ctx),
      right: reduce(ic.right, ctx),
    };
  }

  if (ic.tag === "dup") {
    const expr = reduce(ic.expr, ctx);

    if (expr.tag === "sup") {
      if (expr.label === ic.label) {
        const left = subst(ic.body, `${ic.name}0`, expr.left);
        const right = subst(left, `${ic.name}1`, expr.right);
        return reduce(right, ctx);
      }

      const leftName = ctx.name("a");
      const rightName = ctx.name("b");
      const leftProjection: IC = {
        tag: "sup",
        label: expr.label,
        left: { tag: "var", name: `${leftName}0` },
        right: { tag: "var", name: `${rightName}0` },
      };
      const rightProjection: IC = {
        tag: "sup",
        label: expr.label,
        left: { tag: "var", name: `${leftName}1` },
        right: { tag: "var", name: `${rightName}1` },
      };
      const left = subst(ic.body, `${ic.name}0`, leftProjection);
      const right = subst(left, `${ic.name}1`, rightProjection);

      return reduce({
        tag: "dup",
        label: ic.label,
        name: leftName,
        expr: expr.left,
        body: {
          tag: "dup",
          label: ic.label,
          name: rightName,
          expr: expr.right,
          body: right,
        },
      }, ctx);
    }

    if (expr.tag === "lam") {
      const bodyName = ctx.name("b");
      const leftName = ctx.var(expr.name);
      const rightName = ctx.var(expr.name);
      const sharedBody = subst(expr.body, expr.name, {
        tag: "sup",
        label: ic.label,
        left: { tag: "var", name: leftName },
        right: { tag: "var", name: rightName },
      });

      const leftFunc: IC = {
        tag: "lam",
        name: leftName,
        body: { tag: "var", name: `${bodyName}0` },
      };
      const rightFunc: IC = {
        tag: "lam",
        name: rightName,
        body: { tag: "var", name: `${bodyName}1` },
      };

      const left = subst(ic.body, `${ic.name}0`, leftFunc);
      const right = subst(left, `${ic.name}1`, rightFunc);
      return reduce({
        tag: "dup",
        label: ic.label,
        name: bodyName,
        expr: sharedBody,
        body: right,
      }, ctx);
    }

    const body = reduce(ic.body, ctx);
    return {
      tag: "dup",
      label: ic.label,
      name: ic.name,
      expr,
      body,
    };
  }

  ic satisfies never;
  throw new Error("panic");
}

function Ctx(ic: IC): Ctx {
  const ctx: Ctx = {
    used: collectNames(ic),
    next: 0,
    name(prefix: string): string {
      while (true) {
        const name = "_" + prefix + ctx.next.toString();
        ctx.next += 1;

        if (
          !ctx.used.has(name) &&
          !ctx.used.has(`${name}0`) &&
          !ctx.used.has(`${name}1`)
        ) {
          ctx.used.add(name);
          ctx.used.add(`${name}0`);
          ctx.used.add(`${name}1`);
          return name;
        }
      }
    },
    var(prefix: string): string {
      while (true) {
        const name = "_" + prefix + ctx.next.toString();
        ctx.next += 1;

        if (!ctx.used.has(name)) {
          ctx.used.add(name);
          return name;
        }
      }
    },
  };

  return ctx;
}

function collectNames(ic: IC, out = new Set<string>()): Set<string> {
  if (ic.tag === "num") {
    return out;
  }

  if (ic.tag === "var") {
    out.add(ic.name);
    return out;
  }

  if (ic.tag === "prim") {
    for (const item of ic.args) {
      collectNames(item, out);
    }

    return out;
  }

  if (ic.tag === "lam") {
    out.add(ic.name);
    collectNames(ic.body, out);
    return out;
  }

  if (ic.tag === "app") {
    collectNames(ic.func, out);
    collectNames(ic.arg, out);
    return out;
  }

  if (ic.tag === "sup") {
    collectNames(ic.left, out);
    collectNames(ic.right, out);
    return out;
  }

  if (ic.tag === "dup") {
    out.add(ic.name);
    out.add(`${ic.name}0`);
    out.add(`${ic.name}1`);
    collectNames(ic.expr, out);
    collectNames(ic.body, out);
    return out;
  }

  ic satisfies never;
  throw new Error("panic");
}

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

  if (ic.tag === "sup") {
    return {
      tag: "sup",
      label: ic.label,
      left: subst(ic.left, name, value),
      right: subst(ic.right, name, value),
    };
  }

  if (ic.tag === "dup") {
    const expr = subst(ic.expr, name, value);

    if (name === `${ic.name}0` || name === `${ic.name}1`) {
      return {
        tag: "dup",
        label: ic.label,
        name: ic.name,
        expr,
        body: ic.body,
      };
    }

    return {
      tag: "dup",
      label: ic.label,
      name: ic.name,
      expr,
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

  if (ic.tag === "sup") {
    throw new Error("Cannot lower superposition before reduction");
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
