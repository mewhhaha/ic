import { expect } from "../expect.ts";
import { Prim } from "../op.ts";
import { Callable, Format } from "../trait.ts";
import type { Ic } from "./ast.ts";

function arg(args: Ic[], index: number): Ic {
  const value = args[index];
  expect(value, "Missing argument " + index);
  return value;
}

export function fmt_ic(ic: Ic): string {
  switch (ic.tag) {
    case "num":
      return ic.value.toString() + ":" + ic.type;

    case "text":
      return Deno.inspect(ic.value);

    case "var":
      return ic.name;

    case "prim": {
      const expected = Callable.arity(Prim, ic.prim);
      expect(
        ic.args.length === expected,
        "Primitive " + ic.prim + " expects " + expected + " arguments",
      );

      if (ic.prim === "i32.select" || ic.prim === "i64.select") {
        const then_branch = fmt_ic(arg(ic.args, 0));
        const else_branch = fmt_ic(arg(ic.args, 1));
        const cond = fmt_ic(arg(ic.args, 2));
        return `if ${cond} then ${then_branch} else ${else_branch}`;
      }

      if (expected === 0) {
        return Format.fmt(Prim, ic.prim);
      }

      if (expected === 1) {
        const value = fmt_ic(arg(ic.args, 0));
        const op = Format.fmt(Prim, ic.prim);
        return `${op}(${value})`;
      }

      const left = fmt_ic(arg(ic.args, 0));
      const op = Format.fmt(Prim, ic.prim);
      const right = fmt_ic(arg(ic.args, 1));
      return `${left} ${op} ${right}`;
    }

    case "lam": {
      const body = fmt_ic(ic.body);
      return `λ${ic.name}. ${body}`;
    }

    case "app": {
      const func = fmt_ic(ic.func);
      const value = fmt_ic(ic.arg);
      return `(${func})(${value})`;
    }

    case "sup": {
      const left = fmt_ic(ic.left);
      const right = fmt_ic(ic.right);
      return `&${ic.label}{${left}, ${right}}`;
    }

    case "dup": {
      const expr = fmt_ic(ic.expr);
      const body = fmt_ic(ic.body);
      return `! ${ic.name} &${ic.label} = ${expr};\n${body}`;
    }

    case "era": {
      const expr = fmt_ic(ic.expr);
      const body = fmt_ic(ic.body);
      return `~ ${expr};\n${body}`;
    }

    case "fix": {
      const expr = fmt_ic(ic.expr);
      const body = fmt_ic(ic.body);
      return `fix ${ic.name} = ${expr};\n${body}`;
    }
  }
}
