import { expectArity, PRIMS, watPrim, type Prim, type ValType } from "./op.ts";

export type Expr =
  | { tag: "num"; type: ValType; value: number | bigint }
  | { tag: "var"; type: ValType; name: string }
  | { tag: "prim"; type: ValType; prim: Prim; args: Expr[] }
  | { tag: "let"; name: string; value: Expr; body: Expr };

export function Expr() {}

Expr.type = function type(expr: Expr): ValType {
  if (expr.tag === "let") {
    return type(expr.body);
  }

  return expr.type;
};

function expectType(expr: Expr, expected: ValType): void {
  const actual = Expr.type(expr);

  if (actual !== expected) {
    throw new Error("Expected " + expected + ", got " + actual);
  }
}

function arg(args: Expr[], index: number): Expr {
  const value = args[index];

  if (value === undefined) {
    throw new Error("Missing argument " + index);
  }

  return value;
}

// Collect all local variables into a map of local name to Wasm value type.
function collect(expr: Expr, out = new Map<string, ValType>()): Map<string, ValType> {
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
    out.set(expr.name, Expr.type(expr.value));
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

    if (type === undefined) {
      throw new Error("Unbound variable: " + expr.name);
    }

    if (type !== expr.type) {
      throw new Error("Local $" + expr.name + " is " + type + ", got " + expr.type);
    }

    return "local.get $" + expr.name;
  }

  if (expr.tag === "prim") {
    expectArity(expr.prim, expr.args);

    for (const item of expr.args) {
      expectType(item, expr.type);
    }

    const lines = expr.args.map((item) => _emit(item, env));
    lines.push(watPrim(expr.type, expr.prim));
    return lines.join("\n");
  }

  if (expr.tag === "let") {
    const type = Expr.type(expr.value);
    const nextEnv = new Map(env);
    nextEnv.set(expr.name, type);

    return [
      _emit(expr.value, env),
      "local.set $" + expr.name,
      _emit(expr.body, nextEnv),
    ].join("\n");
  }

  expr satisfies never;
  throw new Error("panic");
}

Expr.emit = function emit(expr: Expr): string {
  const locals = [...collect(expr)]
    .map(([name, type]) => `(local $${name} ${type})`)
    .join("\n");

  const body = _emit(expr, new Map());

  if (locals.length === 0) {
    return body;
  }

  return `${locals}\n${body}`;
};

Expr.fmt = function fmt(expr: Expr): string {
  if (expr.tag === "num") {
    return expr.value.toString() + ":" + expr.type;
  }

  if (expr.tag === "var") {
    return expr.name + ":" + expr.type;
  }

  if (expr.tag === "prim") {
    expectArity(expr.prim, expr.args);

    const left = fmt(arg(expr.args, 0));
    const op = PRIMS[expr.prim].fmt;
    const right = fmt(arg(expr.args, 1));
    return `(${left} ${op}:${expr.type} ${right})`;
  }

  if (expr.tag === "let") {
    const type = Expr.type(expr.value);
    const value = fmt(expr.value);
    const body = fmt(expr.body);
    return `let ${expr.name}:${type} = ${value};\n${body}`;
  }

  expr satisfies never;
  throw new Error("panic");
};
