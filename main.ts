import { IC } from "./src/ic.ts";
import { Expr } from "./src/expr.ts";
import { Mod } from "./src/mod.ts";

const program: IC = {
  tag: "prim",
  prim: "add",
  args: [
    { tag: "num", type: "i32", value: 21 },
    { tag: "num", type: "i32", value: 21 },
  ],
};

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

console.log("Expr:");
console.log(Expr.fmt(expr));

console.log("WAT:");
console.log(watText);
