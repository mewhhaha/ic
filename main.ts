import { Expr } from "./src/expr.ts";
import { IC } from "./src/ic.ts";
import * as Wat from "./src/wat.ts";

type Format<self> = {
  fmt: (value: self) => string;
};

type Emit<from, to> = {
  emit: (value: from) => to;
};

const program: IC = {
  tag: "dup",
  name: "x",
  expr: { tag: "num", value: 21 },
  body: {
    tag: "add",
    left: { tag: "var", name: "x0" },
    right: { tag: "var", name: "x1" },
  },
};

IC satisfies Format<IC> & Emit<IC, Expr>;
const expr = IC.emit(program);

Expr satisfies Format<Expr> & Emit<Expr, string>;
const wat = Wat.main(Expr.emit(expr));

await Deno.mkdir("build", { recursive: true });
await Deno.writeTextFile("build/out.wat", wat);

console.log("IC:");
console.log(IC.fmt(program));

console.log("\nExpr:");
console.log(Expr.fmt(expr));

console.log("\nWAT:");
console.log(wat);
