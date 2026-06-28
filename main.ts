import { IC } from "./src/ic.ts";
import { Expr } from "./src/expr.ts";
import { Mod } from "./src/mod.ts";

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
    { tag: "num", type: "i32", value: 21 },
    { tag: "num", type: "i32", value: 21 },
  ],
};

IC satisfies Format<IC> & Emit<IC, Expr>;
const expr = IC.emit(program);

Expr satisfies Format<Expr> & Emit<Expr, string>;
const mod: Mod = {
  funcs: {
    main: { name: "main", result: Expr.type(expr), body: Expr.emit(expr) },
  },
  exports: ["main"],
};

Mod satisfies Emit<Mod, string>;
const watText = Mod.emit(mod);

await Deno.mkdir("build", { recursive: true });
await Deno.writeTextFile("build/out.wat", watText);

console.log("IC:");
console.log(IC.fmt(program));

console.log("\nExpr:");
console.log(Expr.fmt(expr));

console.log("\nWAT:");
console.log(watText);
