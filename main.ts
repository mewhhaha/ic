import { IC } from "./src/ic.ts";
import { Expr } from "./src/expr.ts";
import { Mod } from "./src/mod.ts";

const program: IC = {
  tag: "app",
  func: {
    tag: "lam",
    name: "x",
    body: { tag: "var", name: "x" },
  },
  arg: { tag: "num", type: "i32", value: 42 },
};

const reduced = IC.reduce(program);
const expr = IC.emit(program);

const mod: Mod = {
  funcs: {
    main: {
      name: "main",
      result: Expr.type(expr),
      body: Expr.emit(expr),
    },
  },
  exports: ["main"],
};

const watText = Mod.emit(mod);

await Deno.mkdir("build", { recursive: true });
await Deno.writeTextFile("build/out.wat", watText);

console.log("IC:");
console.log(IC.fmt(program));

console.log("Reduced IC:");
console.log(IC.fmt(reduced));

console.log("Expr:");
console.log(Expr.fmt(expr));

console.log("WAT:");
console.log(watText);
