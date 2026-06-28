import { expect } from "./expect.ts";
import { Expr, type Expr as ExprNode } from "./expr.ts";
import { Prim, type ValType } from "./op.ts";
import type { Emit, Format, Reduce } from "./trait.ts";

export type IC =
  | { tag: "num"; type: ValType; value: number | bigint }
  | { tag: "var"; name: string }
  | { tag: "prim"; prim: Prim; args: IC[] }
  | { tag: "lam"; name: string; body: IC }
  | { tag: "app"; func: IC; arg: IC }
  | { tag: "sup"; label: string; left: IC; right: IC }
  | { tag: "dup"; label: string; name: string; expr: IC; body: IC }
  | { tag: "era"; expr: IC; body: IC };

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

IC.fmt = function fmt(ic: IC): string {
  switch (ic.tag) {
    case "num":
      return ic.value.toString() + ":" + ic.type;

    case "var":
      return ic.name;

    case "prim": {
      const expected = Prim.arity(ic.prim);
      expect(
        ic.args.length === expected,
        "Primitive " + ic.prim + " expects " + expected + " arguments",
      );

      const left = fmt(arg(ic.args, 0));
      const op = Prim.fmt(ic.prim);
      const right = fmt(arg(ic.args, 1));
      return `${left} ${op} ${right}`;
    }

    case "lam": {
      const body = fmt(ic.body);
      return `λ${ic.name}. ${body}`;
    }

    case "app": {
      const func = fmt(ic.func);
      const arg = fmt(ic.arg);
      return `(${func})(${arg})`;
    }

    case "sup": {
      const left = fmt(ic.left);
      const right = fmt(ic.right);
      return `&${ic.label}{${left}, ${right}}`;
    }

    case "dup": {
      const expr = fmt(ic.expr);
      const body = fmt(ic.body);
      return `! ${ic.name} &${ic.label} = ${expr};\n${body}`;
    }

    case "era": {
      const expr = fmt(ic.expr);
      const body = fmt(ic.body);
      return `~ ${expr};\n${body}`;
    }
  }
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
  switch (ic.tag) {
    case "num":
    case "var":
      return ic;

    case "prim": {
      const expected = Prim.arity(ic.prim);
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
        expect(
          left.type === right.type,
          "Primitive numbers must have the same type",
        );

        const primType = Prim.type(ic.prim);
        const leftExpected = primType.args[0];
        const rightExpected = primType.args[1];
        expect(leftExpected, "Missing primitive argument type 0");
        expect(rightExpected, "Missing primitive argument type 1");
        expect(
          left.type === leftExpected,
          "Primitive " + ic.prim + " argument 0 expects " + leftExpected +
            ", got " + left.type,
        );
        expect(
          right.type === rightExpected,
          "Primitive " + ic.prim + " argument 1 expects " + rightExpected +
            ", got " + right.type,
        );
        expect(
          primType.result === left.type,
          "Primitive " + ic.prim + " returns " + primType.result + ", got " +
            left.type,
        );

        switch (left.type) {
          case "i32": {
            const leftValue = left.value;
            const rightValue = right.value;
            expect(typeof leftValue === "number", "Expected i32 number");
            expect(typeof rightValue === "number", "Expected i32 number");

            if (ic.prim === "i32.add") {
              return {
                tag: "num",
                type: "i32",
                value: (leftValue + rightValue) | 0,
              };
            }

            if (ic.prim === "i32.sub") {
              return {
                tag: "num",
                type: "i32",
                value: (leftValue - rightValue) | 0,
              };
            }

            if (ic.prim === "i32.mul") {
              return {
                tag: "num",
                type: "i32",
                value: Math.imul(leftValue, rightValue),
              };
            }

            throw new Error("panic");
          }

          case "i64": {
            const leftValue = left.value;
            const rightValue = right.value;
            expect(typeof leftValue === "bigint", "Expected i64 bigint");
            expect(typeof rightValue === "bigint", "Expected i64 bigint");

            if (ic.prim === "i64.add") {
              return {
                tag: "num",
                type: "i64",
                value: BigInt.asIntN(64, leftValue + rightValue),
              };
            }

            if (ic.prim === "i64.sub") {
              return {
                tag: "num",
                type: "i64",
                value: BigInt.asIntN(64, leftValue - rightValue),
              };
            }

            if (ic.prim === "i64.mul") {
              return {
                tag: "num",
                type: "i64",
                value: BigInt.asIntN(64, leftValue * rightValue),
              };
            }

            throw new Error("panic");
          }
        }
      }

      return {
        tag: "prim",
        prim: ic.prim,
        args,
      };
    }

    case "lam":
      return {
        tag: "lam",
        name: ic.name,
        body: reduce(ic.body, ctx),
      };

    case "app": {
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

    case "sup":
      return {
        tag: "sup",
        label: ic.label,
        left: reduce(ic.left, ctx),
        right: reduce(ic.right, ctx),
      };

    case "dup": {
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

    case "era": {
      const expr = reduce(ic.expr, ctx);
      const body = erase(expr, ic.body, ctx);
      return reduce(body, ctx);
    }
  }
}

function erase(expr: IC, body: IC, ctx: Ctx): IC {
  switch (expr.tag) {
    case "num":
    case "var":
      return body;

    case "prim":
      return eraseMany(expr.args, body);

    case "lam":
      return { tag: "era", expr: expr.body, body };

    case "app":
      return eraseMany([expr.func, expr.arg], body);

    case "sup":
      return eraseMany([expr.left, expr.right], body);

    case "dup": {
      const left = { tag: "var", name: `${expr.name}0` } satisfies IC;
      const right = { tag: "var", name: `${expr.name}1` } satisfies IC;
      const next = eraseMany([left, right], expr.body);
      return eraseMany([expr.expr, next], body);
    }

    case "era":
      return eraseMany([expr.expr, expr.body], body);
  }

  function eraseMany(items: IC[], next: IC): IC {
    let result = next;

    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      expect(item, "Missing erasure item " + index);
      result = { tag: "era", expr: item, body: result };
    }

    return result;
  }
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
  switch (ic.tag) {
    case "num":
      return out;

    case "var":
      out.add(ic.name);
      return out;

    case "prim":
      for (const item of ic.args) {
        collectNames(item, out);
      }

      return out;

    case "lam":
      out.add(ic.name);
      collectNames(ic.body, out);
      return out;

    case "app":
      collectNames(ic.func, out);
      collectNames(ic.arg, out);
      return out;

    case "sup":
      collectNames(ic.left, out);
      collectNames(ic.right, out);
      return out;

    case "dup":
      out.add(ic.name);
      out.add(`${ic.name}0`);
      out.add(`${ic.name}1`);
      collectNames(ic.expr, out);
      collectNames(ic.body, out);
      return out;

    case "era":
      collectNames(ic.expr, out);
      collectNames(ic.body, out);
      return out;
  }
}

function subst(ic: IC, name: string, value: IC): IC {
  switch (ic.tag) {
    case "num":
      return ic;

    case "var":
      if (ic.name === name) {
        return value;
      }

      return ic;

    case "prim":
      return {
        tag: "prim",
        prim: ic.prim,
        args: ic.args.map((item) => subst(item, name, value)),
      };

    case "lam":
      if (ic.name === name) {
        return ic;
      }

      return {
        tag: "lam",
        name: ic.name,
        body: subst(ic.body, name, value),
      };

    case "app":
      return {
        tag: "app",
        func: subst(ic.func, name, value),
        arg: subst(ic.arg, name, value),
      };

    case "sup":
      return {
        tag: "sup",
        label: ic.label,
        left: subst(ic.left, name, value),
        right: subst(ic.right, name, value),
      };

    case "dup": {
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

    case "era":
      return {
        tag: "era",
        expr: subst(ic.expr, name, value),
        body: subst(ic.body, name, value),
      };
  }
}

function lower(ic: IC, env: Map<string, ValType>): ExprNode {
  switch (ic.tag) {
    case "num":
      return { tag: "num", type: ic.type, value: ic.value };

    case "var": {
      const type = env.get(ic.name);
      expect(type, "Unbound variable: " + ic.name);
      return { tag: "var", type, name: ic.name };
    }

    case "prim": {
      const expected = Prim.arity(ic.prim);
      expect(
        ic.args.length === expected,
        "Primitive " + ic.prim + " expects " + expected + " arguments",
      );

      const primType = Prim.type(ic.prim);
      const args = ic.args.map((item) => lower(item, env));

      for (let index = 0; index < args.length; index += 1) {
        const item = args[index];
        expect(item, "Missing primitive argument " + index);
        const expectedType = primType.args[index];
        expect(expectedType, "Missing primitive argument type " + index);
        const actual = Expr.type(item);
        expect(
          actual === expectedType,
          "Primitive " + ic.prim + " argument " + index + " expects " +
            expectedType + ", got " + actual,
        );
      }

      return {
        tag: "prim",
        type: primType.result,
        prim: ic.prim,
        args,
      };
    }

    case "lam":
      throw new Error("Cannot lower lambda before reduction");

    case "app":
      throw new Error("Cannot lower application before reduction");

    case "sup":
      throw new Error("Cannot lower superposition before reduction");

    case "dup": {
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

    case "era":
      throw new Error("Cannot lower erasure before reduction");
  }
}

function rename(expr: ExprNode, name: string): ExprNode {
  switch (expr.tag) {
    case "num":
      return expr;

    case "var":
      if (expr.name === `${name}0` || expr.name === `${name}1`) {
        return { ...expr, name };
      }

      return expr;

    case "prim":
      return {
        tag: "prim",
        type: expr.type,
        prim: expr.prim,
        args: expr.args.map((item) => rename(item, name)),
      };

    case "let":
      return {
        tag: "let",
        name: expr.name,
        value: rename(expr.value, name),
        body: rename(expr.body, name),
      };
  }
}
