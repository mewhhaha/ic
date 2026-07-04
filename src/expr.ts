import { expect } from "./expect.ts";
import { Prim, type ValType } from "./op.ts";
import { Callable, Data, Emit, Format, Typed } from "./trait.ts";

export type Expr =
  | { tag: "num"; type: ValType; value: number | bigint }
  | { tag: "text"; value: string }
  | { tag: "var"; type: ValType; name: string }
  | { tag: "prim"; type: ValType; prim: Prim; args: Expr[] }
  | {
    tag: "if";
    type: ValType;
    cond: Expr;
    then_branch: Expr;
    else_branch: Expr;
  }
  | { tag: "let"; name: string; value: Expr; body: Expr };

export type ExprDataSegment = {
  offset: number;
  bytes: number[];
};

export function Expr() {}

Expr.type = function type(expr: Expr): ValType {
  switch (expr.tag) {
    case "text":
      return "i32";

    case "num":
    case "var":
    case "prim":
    case "if":
      return expr.type;

    case "let":
      return type(expr.body);
  }
};

type TextLayout = {
  offsets: Map<Expr, number>;
  data: ExprDataSegment[];
};

const text_encoder = new TextEncoder();

function u32_le(value: number): number[] {
  expect(Number.isInteger(value), "Text byte length must be an integer");
  expect(value >= 0, "Text byte length must be non-negative");
  expect(value <= 0xffffffff, "Text byte length is too large");

  const bytes: number[] = [];
  let rest = value;

  for (let index = 0; index < 4; index += 1) {
    bytes.push(rest % 256);
    rest = Math.floor(rest / 256);
  }

  return bytes;
}

function text_bytes(value: string): number[] {
  const encoded = text_encoder.encode(value);
  const bytes = u32_le(encoded.length);

  for (const byte of encoded) {
    bytes.push(byte);
  }

  return bytes;
}

function align_to_4(value: number): number {
  let aligned = value;

  while (aligned % 4 !== 0) {
    aligned += 1;
  }

  return aligned;
}

function build_text_layout(expr: Expr): TextLayout {
  const offsets = new Map<Expr, number>();
  const data: ExprDataSegment[] = [];
  let offset = 0;

  function visit(item: Expr): void {
    switch (item.tag) {
      case "num":
      case "var":
        return;

      case "text": {
        const existing = offsets.get(item);

        if (existing !== undefined) {
          return;
        }

        const bytes = text_bytes(item.value);
        offsets.set(item, offset);
        data.push({ offset, bytes });
        offset = align_to_4(offset + bytes.length);
        return;
      }

      case "prim":
        for (const arg of item.args) {
          visit(arg);
        }

        return;

      case "if":
        visit(item.cond);
        visit(item.then_branch);
        visit(item.else_branch);
        return;

      case "let":
        visit(item.value);
        visit(item.body);
        return;
    }
  }

  visit(expr);
  return { offsets, data };
}

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

    case "text":
      return out;

    case "prim":
      for (const item of expr.args) {
        collect(item, out);
      }

      return out;

    case "if":
      collect(expr.cond, out);
      collect(expr.then_branch, out);
      collect(expr.else_branch, out);
      return out;

    case "let":
      out.set(expr.name, Typed.type(Expr, expr.value));
      collect(expr.value, out);
      collect(expr.body, out);
      return out;
  }
}

function emit(
  expr: Expr,
  env: Map<string, ValType>,
  text_layout: TextLayout,
): string {
  switch (expr.tag) {
    case "num":
      return expr.type + ".const " + expr.value.toString();

    case "text": {
      const offset = text_layout.offsets.get(expr);
      expect(offset !== undefined, "Missing text data offset");
      return "i32.const " + offset.toString();
    }

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
      const expected = Callable.arity(Prim, expr.prim);
      expect(
        expr.args.length === expected,
        "Primitive " + expr.prim + " expects " + expected + " arguments",
      );

      const prim_type = Callable.type(Prim, expr.prim);
      expect(
        prim_type.result === expr.type,
        "Primitive " + expr.prim + " returns " + prim_type.result + ", got " +
          expr.type,
      );

      for (let index = 0; index < expr.args.length; index += 1) {
        const item = expr.args[index];
        expect(item, "Missing primitive argument " + index);
        const expected_type = prim_type.args[index];
        expect(expected_type, "Missing primitive argument type " + index);
        const actual = Typed.type(Expr, item);
        expect(
          actual === expected_type,
          "Primitive " + expr.prim + " argument " + index + " expects " +
            expected_type + ", got " + actual,
        );
      }

      const lines = expr.args.map((item) => emit(item, env, text_layout));
      lines.push(Emit.emit(Prim, expr.prim));
      return lines.join("\n");
    }

    case "if": {
      const cond_type = Typed.type(Expr, expr.cond);
      expect(cond_type === "i32", "If condition expects i32, got " + cond_type);

      const then_type = Typed.type(Expr, expr.then_branch);
      const else_type = Typed.type(Expr, expr.else_branch);
      expect(
        then_type === expr.type,
        "If then branch returns " + then_type + ", got " + expr.type,
      );
      expect(
        else_type === expr.type,
        "If else branch returns " + else_type + ", got " + expr.type,
      );

      const then_body = indent(emit(expr.then_branch, env, text_layout));
      const else_body = indent(emit(expr.else_branch, env, text_layout));
      return [
        emit(expr.cond, env, text_layout),
        "if (result " + expr.type + ")",
        then_body,
        "else",
        else_body,
        "end",
      ].join("\n");
    }

    case "let": {
      const type = Typed.type(Expr, expr.value);
      env = new Map(env);
      env.set(expr.name, type);

      return [
        emit(expr.value, env, text_layout),
        "local.set $" + expr.name,
        emit(expr.body, env, text_layout),
      ].join("\n");
    }
  }
}

function indent(text: string): string {
  return text.split("\n").map((line) => "  " + line).join("\n");
}

export function emit_expr_with_env(
  expr: Expr,
  initial_env: Map<string, ValType>,
): string {
  const text_layout = build_text_layout(expr);
  const local_types = collect(expr);

  for (const name of initial_env.keys()) {
    local_types.delete(name);
  }

  const locals = [...local_types]
    .map(([name, type]) => `(local $${name} ${type})`)
    .join("\n");

  const body = emit(expr, new Map(initial_env), text_layout);

  if (locals.length === 0) {
    return body;
  }

  return `${locals}\n${body}`;
}

Expr.emit = function (expr: Expr): string {
  return emit_expr_with_env(expr, new Map());
};

Expr.fmt = function fmt(expr: Expr): string {
  switch (expr.tag) {
    case "num":
      return expr.value.toString() + ":" + expr.type;

    case "text":
      return Deno.inspect(expr.value) + ":text";

    case "var":
      return expr.name + ":" + expr.type;

    case "prim": {
      const expected = Callable.arity(Prim, expr.prim);
      expect(
        expr.args.length === expected,
        "Primitive " + expr.prim + " expects " + expected + " arguments",
      );

      const prim_type = Callable.type(Prim, expr.prim);
      expect(
        prim_type.result === expr.type,
        "Primitive " + expr.prim + " returns " + prim_type.result + ", got " +
          expr.type,
      );

      for (let index = 0; index < expr.args.length; index += 1) {
        const item = expr.args[index];
        expect(item, "Missing primitive argument " + index);
        const expected_type = prim_type.args[index];
        expect(expected_type, "Missing primitive argument type " + index);
        const actual = Typed.type(Expr, item);
        expect(
          actual === expected_type,
          "Primitive " + expr.prim + " argument " + index + " expects " +
            expected_type + ", got " + actual,
        );
      }

      if (expr.prim === "i32.select" || expr.prim === "i64.select") {
        const then_branch = fmt(arg(expr.args, 0));
        const else_branch = fmt(arg(expr.args, 1));
        const cond = fmt(arg(expr.args, 2));
        return `(if ${cond} then ${then_branch} else ${else_branch}):${expr.type}`;
      }

      if (expected === 0) {
        return Format.fmt(Prim, expr.prim) + ":" + expr.type;
      }

      if (expected === 1) {
        const value = fmt(arg(expr.args, 0));
        const op = Format.fmt(Prim, expr.prim);
        return `${op}(${value}):${expr.type}`;
      }

      const left = fmt(arg(expr.args, 0));
      const op = Format.fmt(Prim, expr.prim);
      const right = fmt(arg(expr.args, 1));
      return `(${left} ${op}:${expr.type} ${right})`;
    }

    case "if": {
      const cond_type = Typed.type(Expr, expr.cond);
      expect(cond_type === "i32", "If condition expects i32, got " + cond_type);

      const then_type = Typed.type(Expr, expr.then_branch);
      const else_type = Typed.type(Expr, expr.else_branch);
      expect(
        then_type === expr.type,
        "If then branch returns " + then_type + ", got " + expr.type,
      );
      expect(
        else_type === expr.type,
        "If else branch returns " + else_type + ", got " + expr.type,
      );

      return "(if " + fmt(expr.cond) + " then " +
        fmt(expr.then_branch) + " else " + fmt(expr.else_branch) + "):" +
        expr.type;
    }

    case "let": {
      const type = Typed.type(Expr, expr.value);
      const value = fmt(expr.value);
      const body = fmt(expr.body);
      return `let ${expr.name}:${type} = ${value};\n${body}`;
    }
  }
};

Expr.data = function data(expr: Expr): ExprDataSegment[] {
  return build_text_layout(expr).data;
};

Expr satisfies
  & Format<Expr>
  & Emit<Expr, string>
  & Typed<Expr, ValType>
  & Data<Expr, ExprDataSegment>;
