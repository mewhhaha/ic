import { expect } from "./expect.ts";
import { Prim, type ValType } from "./op.ts";
import type { Emit, Format } from "./trait.ts";

export type Expr =
  | { tag: "num"; type: ValType; value: number | bigint }
  | { tag: "var"; type: ValType; name: string }
  | { tag: "prim"; type: ValType; prim: Prim; args: Expr[] }
  | { tag: "let"; name: string; value: Expr; body: Expr };

export function Expr() {}

Expr.type = function type(expr: Expr): ValType {
  switch (expr.tag) {
    case "num":
    case "var":
    case "prim":
      return expr.type;

    case "let":
      return type(expr.body);
  }
};

function arg(args: Expr[], index: number): Expr {
  const value = args[index];
  expect(value, "Missing argument " + index);
  return value;
}

// Collect all local variables into a map of local name to Wasm value type.
function collect(
  expr: Expr,
  out = new Map<string, ValType>(),
): Map<string, ValType> {
  switch (expr.tag) {
    case "num":
    case "var":
      return out;

    case "prim":
      for (const item of expr.args) {
        collect(item, out);
      }

      return out;

    case "let":
      out.set(expr.name, Expr.type(expr.value));
      collect(expr.value, out);
      collect(expr.body, out);
      return out;
  }
}

function emit(expr: Expr, env: Map<string, ValType>): string {
  switch (expr.tag) {
    case "num":
      return expr.type + ".const " + expr.value.toString();

    case "var": {
      const type = env.get(expr.name);
      expect(type, "Unbound variable: " + expr.name);

      expect(
        type === expr.type,
        "Local $" + expr.name + " is " + type + ", got " + expr.type,
      );

      return "local.get $" + expr.name;
    }

    case "prim": {
      const expected = Prim.arity(expr.prim);
      expect(
        expr.args.length === expected,
        "Primitive " + expr.prim + " expects " + expected + " arguments",
      );

      const primType = Prim.type(expr.prim);
      expect(
        primType.result === expr.type,
        "Primitive " + expr.prim + " returns " + primType.result + ", got " +
          expr.type,
      );

      for (let index = 0; index < expr.args.length; index += 1) {
        const item = expr.args[index];
        expect(item, "Missing primitive argument " + index);
        const expectedType = primType.args[index];
        expect(expectedType, "Missing primitive argument type " + index);
        const actual = Expr.type(item);
        expect(
          actual === expectedType,
          "Primitive " + expr.prim + " argument " + index + " expects " +
            expectedType + ", got " + actual,
        );
      }

      const lines = expr.args.map((item) => emit(item, env));
      lines.push(Prim.emit(expr.prim));
      return lines.join("\n");
    }

    case "let": {
      const type = Expr.type(expr.value);
      env = new Map(env);
      env.set(expr.name, type);

      return [
        emit(expr.value, env),
        "local.set $" + expr.name,
        emit(expr.body, env),
      ].join("\n");
    }
  }
}

Expr.emit = function (expr: Expr): string {
  const locals = [...collect(expr)]
    .map(([name, type]) => `(local $${name} ${type})`)
    .join("\n");

  const body = emit(expr, new Map());

  if (locals.length === 0) {
    return body;
  }

  return `${locals}\n${body}`;
};

Expr.fmt = function fmt(expr: Expr): string {
  switch (expr.tag) {
    case "num":
      return expr.value.toString() + ":" + expr.type;

    case "var":
      return expr.name + ":" + expr.type;

    case "prim": {
      const expected = Prim.arity(expr.prim);
      expect(
        expr.args.length === expected,
        "Primitive " + expr.prim + " expects " + expected + " arguments",
      );

      const primType = Prim.type(expr.prim);
      expect(
        primType.result === expr.type,
        "Primitive " + expr.prim + " returns " + primType.result + ", got " +
          expr.type,
      );

      for (let index = 0; index < expr.args.length; index += 1) {
        const item = expr.args[index];
        expect(item, "Missing primitive argument " + index);
        const expectedType = primType.args[index];
        expect(expectedType, "Missing primitive argument type " + index);
        const actual = Expr.type(item);
        expect(
          actual === expectedType,
          "Primitive " + expr.prim + " argument " + index + " expects " +
            expectedType + ", got " + actual,
        );
      }

      const left = fmt(arg(expr.args, 0));
      const op = Prim.fmt(expr.prim);
      const right = fmt(arg(expr.args, 1));
      return `(${left} ${op}:${expr.type} ${right})`;
    }

    case "let": {
      const type = Expr.type(expr.value);
      const value = fmt(expr.value);
      const body = fmt(expr.body);
      return `let ${expr.name}:${type} = ${value};\n${body}`;
    }
  }
};

Expr satisfies Format<Expr> & Emit<Expr, string>;
