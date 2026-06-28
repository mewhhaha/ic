import { IC } from "./src/ic.ts";
import { Expr } from "./src/expr.ts";
import { main as wat } from "./src/wat.ts";

type Format<self> = {
  fmt: (value: self) => string;
};

type Emit<from, to> = {
  emit: (value: from) => to;
};

const program: IC = {
  tag: "prim",
  prim: "add",
  args: [
    { tag: "num", value: 21 },
    { tag: "num", value: 21 },
  ],
};

IC satisfies Format<IC> & Emit<IC, Expr>;
const expr = IC.emit(program);

Expr satisfies Format<Expr> & Emit<Expr, string>;
const watText = wat(Expr.emit(expr), Expr.type(expr));

await Deno.mkdir("build", { recursive: true });
await Deno.writeTextFile("build/out.wat", watText);

console.log("IC:");
console.log(IC.fmt(program));

console.log("\nExpr:");
console.log(Expr.fmt(expr));

console.log("\nWAT:");
console.log(watText);
