import { expect } from "./expect.ts";
import { Prim, type ValType } from "./op.ts";
import type { Emit, Format } from "./trait.ts";

export type Expr =
  | { tag: "num"; type: ValType; value: number | bigint }
  | { tag: "var"; type: ValType; name: string }
  | { tag: "prim"; type: ValType; prim: Prim; args: Expr[] }
  | { tag: "let"; name: string; value: Expr; body: Expr };

export function Expr(expr: Expr): typeof Expr & Expr {
  return Object.assign(Expr.bind(expr), {
    type: Expr.type.bind(expr),
    emit: Expr.emit.bind(expr),
    fmt: Expr.fmt.bind(expr),
  }) as typeof Expr & Expr;
}

Expr.type = function (this: Expr): ValType {
  if (this.tag === "let") {
    return Expr(this.body).type();
  }

  return this.type;
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
  if (expr.tag === "num" || expr.tag === "var") {
    return out;
  }

  if (expr.tag === "prim") {
    for (const item of expr.args) {
      collect(item, out);
    }

    return out;
  }

  if (expr.tag === "let") {
    out.set(expr.name, Expr(expr.value).type());
    collect(expr.value, out);
    collect(expr.body, out);
    return out;
  }

  expr satisfies never;
  throw new Error("panic");
}

function _emit(expr: Expr, env: Map<string, ValType>): string {
  if (expr.tag === "num") {
    return expr.type + ".const " + expr.value.toString();
  }

  if (expr.tag === "var") {
    const type = env.get(expr.name);
    expect(type, "Unbound variable: " + expr.name);

    expect(
      type === expr.type,
      "Local $" + expr.name + " is " + type + ", got " + expr.type,
    );

    return "local.get $" + expr.name;
  }

  if (expr.tag === "prim") {
    const expected = Prim(expr.prim).arity();
    expect(
      expr.args.length === expected,
      "Primitive " + expr.prim + " expects " + expected + " arguments",
    );

    for (const item of expr.args) {
      const actual = Expr(item).type();
      expect(actual === expr.type, "Expected " + expr.type + ", got " + actual);
    }

    const lines = expr.args.map((item) => _emit(item, env));
    lines.push(Prim(expr.prim).emit());
    return lines.join("\n");
  }

  if (expr.tag === "let") {
    const type = Expr(expr.value).type();
    env = new Map(env);
    env.set(expr.name, type);

    return [
      _emit(expr.value, env),
      "local.set $" + expr.name,
      _emit(expr.body, env),
    ].join("\n");
  }

  expr satisfies never;
  throw new Error("panic");
}

Expr.emit = function (this: Expr): string {
  const locals = [...collect(this)]
    .map(([name, type]) => `(local $${name} ${type})`)
    .join("\n");

  const body = _emit(this, new Map());

  if (locals.length === 0) {
    return body;
  }

  return `${locals}\n${body}`;
};

Expr.fmt = function (this: Expr): string {
  if (this.tag === "num") {
    return this.value.toString() + ":" + this.type;
  }

  if (this.tag === "var") {
    return this.name + ":" + this.type;
  }

  if (this.tag === "prim") {
    const expected = Prim(this.prim).arity();
    expect(
      this.args.length === expected,
      "Primitive " + this.prim + " expects " + expected + " arguments",
    );

    const left = Expr(arg(this.args, 0)).fmt();
    const op = Prim(this.prim).fmt();
    const right = Expr(arg(this.args, 1)).fmt();
    return `(${left} ${op}:${this.type} ${right})`;
  }

  if (this.tag === "let") {
    const type = Expr(this.value).type();
    const value = Expr(this.value).fmt();
    const body = Expr(this.body).fmt();
    return `let ${this.name}:${type} = ${value};\n${body}`;
  }

  this satisfies never;
  throw new Error("panic");
};

Expr satisfies Format<Expr> & Emit<Expr, string>;
