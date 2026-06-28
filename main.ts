import { Ic } from "./src/ic.ts";
import { Expr } from "./src/expr.ts";
import { Mod } from "./src/mod.ts";

const program: Ic = {
  tag: "dup",
  label: "A",
  name: "r",
  expr: {
    tag: "prim",
    prim: "i32.add",
    args: [
      {
        tag: "sup",
        label: "A",
        left: { tag: "num", type: "i32", value: 1 },
        right: { tag: "num", type: "i32", value: 2 },
      },
      {
        tag: "sup",
        label: "A",
        left: { tag: "num", type: "i32", value: 10 },
        right: { tag: "num", type: "i32", value: 20 },
      },
    ],
  },
  body: {
    tag: "prim",
    prim: "i32.add",
    args: [
      { tag: "var", name: "r0" },
      { tag: "var", name: "r1" },
    ],
  },
};

const reduced = Ic(program).reduce();
const expr = Ic(program).emit();

const mod: Mod = {
  funcs: {
    main: {
      name: "main",
      result: Expr(expr).type(),
      body: Expr(expr).emit(),
    },
  },
  exports: ["main"],
};

const watText = Mod(mod).emit();

await Deno.mkdir("build", { recursive: true });
await Deno.writeTextFile("build/out.wat", watText);

console.log("Ic:");
console.log(Ic(program).fmt());

console.log("Reduced Ic:");
console.log(Ic(reduced).fmt());

console.log("Expr:");
console.log(Expr(expr).fmt());

console.log("WAT:");
console.log(watText);
