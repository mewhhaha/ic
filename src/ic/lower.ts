import { expect } from "../expect.ts";
import { Expr, type Expr as ExprNode } from "../expr.ts";
import { Prim, type ValType } from "../op.ts";
import { Callable, Typed } from "../trait.ts";
import type { Ic } from "./ast.ts";

export function lower_ic(ic: Ic): ExprNode {
  return lower(ic, new Map());
}

export function lower_ic_with_env(
  ic: Ic,
  env: Map<string, ValType>,
): ExprNode {
  return lower(ic, new Map(env));
}

function lower(ic: Ic, env: Map<string, ValType>): ExprNode {
  switch (ic.tag) {
    case "num":
      return { tag: "num", type: ic.type, value: ic.value };

    case "text":
      return { tag: "text", value: ic.value };

    case "var": {
      const type = env.get(ic.name);
      expect(type, "Unbound variable: " + ic.name);
      return { tag: "var", type, name: ic.name };
    }

    case "prim": {
      const expected = Callable.arity(Prim, ic.prim);
      expect(
        ic.args.length === expected,
        "Primitive " + ic.prim + " expects " + expected + " arguments",
      );

      const prim_type = Callable.type(Prim, ic.prim);
      const args = ic.args.map((item) => lower(item, env));

      for (let index = 0; index < args.length; index += 1) {
        const item = args[index];
        expect(item, "Missing primitive argument " + index);
        const expected_type = prim_type.args[index];
        expect(expected_type, "Missing primitive argument type " + index);
        const actual = Typed.type(Expr, item);
        expect(
          actual === expected_type,
          "Primitive " + ic.prim + " argument " + index + " expects " +
            expected_type + ", got " + actual,
        );
      }

      if (ic.prim === "i32.select" || ic.prim === "i64.select") {
        const then_branch = args[0];
        const else_branch = args[1];
        const cond = args[2];
        expect(then_branch, "Missing select then branch");
        expect(else_branch, "Missing select else branch");
        expect(cond, "Missing select condition");
        return {
          tag: "if",
          type: prim_type.result,
          cond,
          then_branch,
          else_branch,
        };
      }

      return {
        tag: "prim",
        type: prim_type.result,
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
      const type = Typed.type(Expr, value);
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

    case "fix":
      throw new Error("Cannot lower recursive binding before reduction");
  }
}

function rename(expr: ExprNode, name: string): ExprNode {
  switch (expr.tag) {
    case "num":
    case "text":
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

    case "if":
      return {
        tag: "if",
        type: expr.type,
        cond: rename(expr.cond, name),
        then_branch: rename(expr.then_branch, name),
        else_branch: rename(expr.else_branch, name),
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
