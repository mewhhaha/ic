import {
  array,
  ask,
  type AsReader,
  type AsTask,
  type AsWriter,
  Do,
  Effect,
  from_fn,
  Just,
  maybe,
  type MaybeValue,
  Nothing,
  Program,
  run_reader,
  run_task,
  run_writer,
  tell,
  type Uses,
} from "@mewhhaha/typeclasses";
import { Ic, type Ic as IcNode } from "./src/ic.ts";
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

type DemoConfig = {
  readonly source_text: string;
  readonly wat_path: string;
};

// The demo pipeline is an effect program: the compiler stages stay pure,
// configuration comes from a Reader, stage dumps accumulate in a Writer,
// and filesystem output runs as Tasks supplied by the interpreter.
type Demo =
  | Uses<AsReader<DemoConfig>>
  | Uses<AsWriter<array.AsArray, string>>
  | Uses<AsTask>;

const Demo = Program.scope<Demo>();

const demo = Demo(function* () {
  const config = yield* ask<DemoConfig>();
  const source = Source.parse(config.source_text);
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
  yield* from_fn(() => Deno.mkdir("build", { recursive: true }));
  yield* from_fn(() => Deno.writeTextFile(config.wat_path, wat_text));
  yield* tell(array.ArrayT([
    "Source:",
    Format.fmt(Source, source),
    "Ic:",
    Format.fmt(Ic, program),
    "Reduced Ic:",
    Format.fmt(Ic, reduced),
    "Expr:",
    Format.fmt(Expr, expr),
    "WAT:",
    wat_text,
  ]));

  return maybe(
    Format.fmt(Ic, reduced),
    (line: string) => line,
    Do(function* () {
      const numeric = yield* numeric_result(reduced);
      return numeric;
    }),
  );
});

const [final_line, log] = await Effect.interpret(demo)
  .handle((effect) =>
    run_reader(effect, { source_text, wat_path: "build/out.wat" })
  )
  .handle((effect) => run_writer(effect, array.ArrayT<string>([])))
  .run(run_task);

for (const line of array.to_array(log)) {
  console.log(line);
}

console.log(final_line);

function numeric_result(value: IcNode): MaybeValue<string> {
  if (value.tag === "num") {
    return Just(value.value.toString());
  }

  return Nothing();
}
