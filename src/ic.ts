import { expect } from "./expect.ts";
import { Expr, type Expr as ExprNode } from "./expr.ts";
import { Prim, type ValType } from "./op.ts";
import type { Emit, Format, Reduce } from "./trait.ts";

export type Ic =
  | { tag: "num"; type: ValType; value: number | bigint }
  | { tag: "var"; name: string }
  | { tag: "prim"; prim: Prim; args: Ic[] }
  | { tag: "lam"; name: string; body: Ic }
  | { tag: "app"; func: Ic; arg: Ic }
  | { tag: "sup"; label: string; left: Ic; right: Ic }
  | { tag: "dup"; label: string; name: string; expr: Ic; body: Ic };

type Ctx = {
  used: Set<string>;
  next: number;
  name: (prefix: string) => string;
  var: (prefix: string) => string;
};

export function Ic(ic: Ic): typeof Ic & Ic {
  return Object.assign(Ic.bind(ic), {
    fmt: Ic.fmt.bind(ic),
    reduce: Ic.reduce.bind(ic),
    emit: Ic.emit.bind(ic),
  }) as typeof Ic & Ic;
}

function arg(args: Ic[], index: number): Ic {
  const value = args[index];
  expect(value, "Missing argument " + index);
  return value;
}

function exprArg(args: ExprNode[], index: number): ExprNode {
  const value = args[index];
  expect(value, "Missing argument " + index);
  return value;
}

Ic.fmt = function (this: Ic): string {
  if (this.tag === "num") {
    return this.value.toString() + ":" + this.type;
  }

  if (this.tag === "var") {
    return this.name;
  }

  if (this.tag === "prim") {
    const expected = Prim(this.prim).arity();
    expect(
      this.args.length === expected,
      "Primitive " + this.prim + " expects " + expected + " arguments",
    );

    const left = Ic(arg(this.args, 0)).fmt();
    const op = Prim(this.prim).fmt();
    const right = Ic(arg(this.args, 1)).fmt();
    return `${left} ${op} ${right}`;
  }

  if (this.tag === "lam") {
    const body = Ic(this.body).fmt();
    return `λ${this.name}. ${body}`;
  }

  if (this.tag === "app") {
    const func = Ic(this.func).fmt();
    const arg = Ic(this.arg).fmt();
    return `(${func})(${arg})`;
  }

  if (this.tag === "sup") {
    const left = Ic(this.left).fmt();
    const right = Ic(this.right).fmt();
    return `&${this.label}{${left}, ${right}}`;
  }

  if (this.tag === "dup") {
    const expr = Ic(this.expr).fmt();
    const body = Ic(this.body).fmt();
    return `! ${this.name} &${this.label} = ${expr};\n${body}`;
  }

  this satisfies never;
  throw new Error("panic");
};

Ic.reduce = function (this: Ic): Ic {
  const ctx = Ctx(this);
  return reduce(this, ctx);
};

Ic.emit = function (this: Ic): ExprNode {
  return lower(Ic(this).reduce(), new Map());
};

Ic satisfies Format<Ic> & Reduce<Ic> & Emit<Ic, ExprNode>;

function reduce(ic: Ic, ctx: Ctx): Ic {
  if (ic.tag === "num" || ic.tag === "var") {
    return ic;
  }

  if (ic.tag === "prim") {
    const expected = Prim(ic.prim).arity();
    expect(
      ic.args.length === expected,
      "Primitive " + ic.prim + " expects " + expected + " arguments",
    );

    const args = ic.args.map((item) => reduce(item, ctx));

    for (let index = 0; index < args.length; index += 1) {
      const item = args[index];
      expect(item, "Missing primitive argument " + index);

      if (item.tag === "sup") {
        const leftArgs: Ic[] = [];
        const rightArgs: Ic[] = [];
        const copyNames: string[] = [];
        const copyExprs: Ic[] = [];

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

        let body: Ic = {
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
      expect(
        left.type === right.type,
        "Primitive numbers must have the same type",
      );

      const primType = ic.prim.slice(0, 3);
      expect(
        primType === left.type,
        "Primitive " + ic.prim + " cannot operate on " + left.type,
      );

      const op = ic.prim.slice(4);

      if (left.type === "i32") {
        const leftValue = left.value;
        const rightValue = right.value;
        expect(typeof leftValue === "number", "Expected i32 number");
        expect(typeof rightValue === "number", "Expected i32 number");

        if (op === "add") {
          return {
            tag: "num",
            type: "i32",
            value: (leftValue + rightValue) | 0,
          };
        }

        if (op === "sub") {
          return {
            tag: "num",
            type: "i32",
            value: (leftValue - rightValue) | 0,
          };
        }

        if (op === "mul") {
          return {
            tag: "num",
            type: "i32",
            value: Math.imul(leftValue, rightValue),
          };
        }
      }

      if (left.type === "i64") {
        const leftValue = left.value;
        const rightValue = right.value;
        expect(typeof leftValue === "bigint", "Expected i64 bigint");
        expect(typeof rightValue === "bigint", "Expected i64 bigint");

        if (op === "add") {
          return {
            tag: "num",
            type: "i64",
            value: BigInt.asIntN(64, leftValue + rightValue),
          };
        }

        if (op === "sub") {
          return {
            tag: "num",
            type: "i64",
            value: BigInt.asIntN(64, leftValue - rightValue),
          };
        }

        if (op === "mul") {
          return {
            tag: "num",
            type: "i64",
            value: BigInt.asIntN(64, leftValue * rightValue),
          };
        }
      }

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
      return reduce(
        {
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
        },
        ctx,
      );
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
      const leftProjection: Ic = {
        tag: "sup",
        label: expr.label,
        left: { tag: "var", name: `${leftName}0` },
        right: { tag: "var", name: `${rightName}0` },
      };
      const rightProjection: Ic = {
        tag: "sup",
        label: expr.label,
        left: { tag: "var", name: `${leftName}1` },
        right: { tag: "var", name: `${rightName}1` },
      };
      const left = subst(ic.body, `${ic.name}0`, leftProjection);
      const right = subst(left, `${ic.name}1`, rightProjection);

      return reduce(
        {
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
        },
        ctx,
      );
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

      const leftFunc: Ic = {
        tag: "lam",
        name: leftName,
        body: { tag: "var", name: `${bodyName}0` },
      };
      const rightFunc: Ic = {
        tag: "lam",
        name: rightName,
        body: { tag: "var", name: `${bodyName}1` },
      };

      const left = subst(ic.body, `${ic.name}0`, leftFunc);
      const right = subst(left, `${ic.name}1`, rightFunc);
      return reduce(
        {
          tag: "dup",
          label: ic.label,
          name: bodyName,
          expr: sharedBody,
          body: right,
        },
        ctx,
      );
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

function Ctx(ic: Ic): Ctx {
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

function collectNames(ic: Ic, out = new Set<string>()): Set<string> {
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

function subst(ic: Ic, name: string, value: Ic): Ic {
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

function lower(ic: Ic, env: Map<string, ValType>): ExprNode {
  if (ic.tag === "num") {
    return { tag: "num", type: ic.type, value: ic.value };
  }

  if (ic.tag === "var") {
    const type = env.get(ic.name);
    expect(type, "Unbound variable: " + ic.name);
    return { tag: "var", type, name: ic.name };
  }

  if (ic.tag === "prim") {
    const expected = Prim(ic.prim).arity();
    expect(
      ic.args.length === expected,
      "Primitive " + ic.prim + " expects " + expected + " arguments",
    );

    const args = ic.args.map((item) => lower(item, env));
    const type = Expr(exprArg(args, 0)).type();

    for (const item of args) {
      const actual = Expr(item).type();
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
    const type = Expr(value).type();
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
