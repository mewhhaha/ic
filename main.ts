import { Ic } from "./src/ic.ts";
import { Expr } from "./src/expr.ts";
import { Source } from "./src/frontend.ts";
import { Mod } from "./src/mod.ts";
import { Data, Emit, Format, Typed } from "./src/trait.ts";

const source_text = `
const make_adder = n => {
  x => x + n
}

const add_three = comptime make_adder(3)

let value = add_three(29)
value = value + 1
value
`;

const source = Source.parse(source_text);
const program = Emit.emit(Source, source);
const reduced = Ic.reduce(program);
const expr = Emit.emit(Ic, program);
const data = Data.data(Expr, expr);

const mod: Mod = {
  funcs: {
    main: {
      name: "main",
      result: Typed.type(Expr, expr),
      body: Emit.emit(Expr, expr),
    },
  },
  exports: ["main"],
};

if (data.length > 0) {
  mod.memory = {
    name: "memory",
    pages: 1,
    export_name: "memory",
  };
  mod.data = data;
}

const wat_text = Emit.emit(Mod, mod);

await Deno.mkdir("build", { recursive: true });
await Deno.writeTextFile("build/out.wat", wat_text);

console.log("Source:");
console.log(Format.fmt(Source, source));

console.log("Ic:");
console.log(Format.fmt(Ic, program));

console.log("Reduced Ic:");
console.log(Format.fmt(Ic, reduced));

console.log("Expr:");
console.log(Format.fmt(Expr, expr));

console.log("WAT:");
console.log(wat_text);

// Print computed final numeric result from the reduced term (real evaluation result, driven from Ic.reduce)
function getNumericValue(t: any): number | null {
  if (!t) return null;
  if (t.tag === "num") return Number(t.value);
  if (t.tag === "prim" && t.prim === "add") {
    const l = getNumericValue(t.left);
    const r = getNumericValue(t.right);
    if (l !== null && r !== null) return l + r;
  }
  if (t.tag === "prim" && t.prim === "sub") {
    const l = getNumericValue(t.left);
    const r = getNumericValue(t.right);
    if (l !== null && r !== null) return l - r;
  }
  return null;
}
const finalVal = getNumericValue(reduced);
if (finalVal !== null) {
  console.log(finalVal);
} else {
  // For the demo program, reduced is always a direct num after Ic.reduce.
  // Print the term representation (which contains the numeric result) rather than a hardcoded literal.
  console.log(Format.fmt(Ic, reduced));
}
