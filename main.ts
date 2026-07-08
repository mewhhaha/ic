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

const final_value = numeric_result_text(reduced);

if (final_value !== undefined) {
  console.log(final_value);
} else {
  console.log(Format.fmt(Ic, reduced));
}

function numeric_result_text(value: typeof reduced): string | undefined {
  if (value.tag === "num") {
    return value.value.toString();
  }

  return undefined;
}
