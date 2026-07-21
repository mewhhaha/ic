import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Core } from "../core.ts";
import { Source } from "../frontend.ts";
import { Ic } from "../ic.ts";
import { Emit, Format } from "../trait.ts";
import { comptime_type_key, resolve_comptime_value } from "./comptime_value.ts";
import { TestSource } from "./test_source.ts";

Deno.test("resolved comptime values preserve structural type shape", () => {
  const env = { scopes: [], next: new Map() };
  const value = resolve_comptime_value(
    {
      tag: "struct_type",
      fields: [
        { name: "name", type_name: "Text" },
        { name: "score", type_name: "Int" },
      ],
    },
    env,
    {
      resolve_const_expr_with_env: (expr, value_env) => ({
        expr,
        env: value_env,
      }),
    },
  );

  if (!value || value.tag !== "type") {
    throw new Error("Expected resolved compile-time type value");
  }

  assert_equals(
    comptime_type_key(value.type),
    "record(name:scalar:Text,score:scalar:Int)",
  );
});

Deno.test("computed type members defer const parameters until specialization", () => {
  const wat = Source.wat(`
const attach_shape = (const shape) => {
  let target = []
  target = target :+ ("shape", shape)
  target
}

const target = attach_shape { .value = I32 }
const value_type = target.shape.value
let value: value_type = 42
value
`);

  assert_includes(wat, "i32.const 42");
});

Deno.test("type extensions accept shorthand member shapes after specialization", () => {
  const wat = Source.wat(`
const attach_members = (const value_type) => {
  let target = []
  target = target :+ { value_type, .same_type = value_type }
  target
}

const target = attach_members(I32)
const result_type = target.value_type
let value: result_type = 42
value
`);

  assert_includes(wat, "i32.const 42");
});

Deno.test("type extension syntax updates annotated runtime values", () => {
  const core = Source.core(`
const { struct } = import "duck:prelude" ()
type State = struct { .value = I32, .ready = Bool }

let update: [State, I32] -> State = (state: State, value: I32) => {
  state :+ { .value = value }
}

update([.value = 0, .ready = true], 42).value
`);

  assert_includes(Format.fmt(Core, core), "state { value: value }");
});

Deno.test("type extension syntax updates aliased runtime values", () => {
  const core = Source.core(`
const { struct } = import "duck:prelude" ()
type State = struct { .value = I32, .ready = Bool }

let update: [State, I32] -> State = (state: State, value: I32) => {
  let current: State = state
  current :+ { .value = value }
}

update([.value = 0, .ready = true], 42).value
`);

  assert_includes(Format.fmt(Core, core), "current { value: value }");
});

Deno.test("type match specializes a const function for a named type", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Name = Text
type Player = struct {.name = Name, .score = Int}

const classify = target => match target {
  | struct { .name= Text, .. } => 40
  | union { .. } => 0
  | _ => 1
}

classify(Player) + 2
`);

  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.const 2");
  assert_includes(wat, "i32.add");
});

Deno.test("type descriptors expose record sum product and array layout", () => {
  const record = Source.wat(`
const { struct } = import "duck:prelude" ()
type Player = struct {.name = Text, .score = Int}
@describe_type(Player).size + @describe_fields(Player)[1].offset
`);
  assert_includes(record, "i32.const 12");
  assert_includes(record, "i32.const 8");

  const sum = Source.wat(`
type Result = | \`Ok Int | \`Err Text

@describe_cases(Result)[1].tag
`);
  assert_includes(sum, "i32.const 1");

  const product = Source.wat(`
type Pair = [Int, I64]
@describe_type(Pair).size
`);
  assert_includes(product, "i32.const 16");

  const array = Source.wat(`
type Buffer = [Int; 3]
@describe_type(Buffer).length + @describe_type(Buffer).stride
`);
  assert_includes(array, "i32.const 3");
  assert_includes(array, "i32.const 4");
});

Deno.test("type_of reifies a runtime value's declared type at compile time", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Player = struct {.name = Text, .score = I32}
let player: Player = [.name = "Ada", .score = 42]

@describe_type(@type_of(player)).size
`);

  assert_includes(wat, "i32.const 12");
});

Deno.test("type_of resolves a declared aggregate field type", () => {
  const wat = Source.ic_wat(`
const { struct } = import "duck:prelude" ()
type Player = struct {.name = Text, .score = I64}
let player: Player = [.name = "Ada", .score = 42i64]

@size_of(@type_of(player.score))
`);

  assert_includes(wat, "i32.const 8");
});

Deno.test("type_of preserves a structured compile-time parser result", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Config = struct {.length = I32}
const parse_config: Text -> Config = text => [.length = @len(text)]
const config = comptime parse_config("duck")

config.length + @describe_type(@type_of(config)).size
`);

  assert_includes(wat, "i32.const 4");
  assert_includes(wat, "i32.add");
});

Deno.test("type_of retains integer text and boolean literal types", () => {
  const integer = Source.wat(`
const exact_type = @type_of(1)
let value: exact_type = 1
value
`);
  const text = Source.wat(`
const exact_type = @type_of("GET")
let value: exact_type = "GET"
@len(value)
`);
  const boolean = Source.wat(`
const exact_type = @type_of(true)
let value: exact_type = true
if value { 1 } else { 0 }
`);

  assert_includes(integer, "i32.const 1");
  assert_includes(text, "\\47\\45\\54");
  assert_includes(boolean, "i32.const 1");
  assert_throws(
    () =>
      Source.wat(`
const exact_type = @type_of(1)
let value: exact_type = 2
value
`),
    "annotation expects exact_type, got 2",
  );
  assert_throws(
    () =>
      Source.wat(`
const one = 1
const exact_type = @type_of(one)
let value: exact_type = 2
value
`),
    "annotation expects exact_type, got 2",
  );
});

Deno.test("@cast explicitly widens literal types", () => {
  const integer = Source.wat(`
const wide_type = @type_of(@cast(1, I32))
let value: wide_type = 2
value
`);
  const text = Source.wat(`
const wide_type = @type_of(@cast("GET", Text))
let value: wide_type = "POST"
@len(value)
`);
  const boolean = Source.wat(`
const wide_type = @type_of(@cast(true, Bool))
let value: wide_type = false
if value { 0 } else { 2 }
`);

  assert_includes(integer, "i32.const 2");
  assert_includes(text, "\\50\\4f\\53\\54");
  assert_includes(boolean, "i32.const 2");

  const mutable = Source.wat(`
let one = 1
const wide_type = @type_of(one)
let value: wide_type = 2
value
`);
  assert_includes(mutable, "i32.const 2");
});

Deno.test("type_of retains the storage width of suffixed literals", () => {
  const wat = Source.ic_wat("@size_of(@type_of(42i64))");

  assert_includes(wat, "i32.const 8");
});

Deno.test("type descriptors receive normalized const array lengths", () => {
  const wat = Source.wat(`
type Buffer = [Int; width + 1]
const width = 2

@describe_type(Buffer).length
`);

  assert_includes(wat, "i32.const 3");
});

Deno.test("const-directed construction and projection erase to fixed access", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Player = struct {.name = Int, .score = Int}

const player_fields = @describe_fields(Player)
const score_field = player_fields[1]
let player = @construct(Player, [.name = 20, .score = 40])

@project(player, score_field) + 2
`);

  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.const 2");
  assert_includes(wat, "i32.add");
});

Deno.test("const-directed builders specialize construction inside loops", () => {
  const wat = Source.wat(`
const sum_pair_for = (const pair_type) => value => {
  let result = 0

  loop {
    let pair: pair_type = @construct(pair_type, [value, value + 1])
    result = pair[0] + pair[1]
    break
  }

  result
}

type IntPair = [I32, I32]
const sum_pair = comptime sum_pair_for(IntPair)

sum_pair 20
`);

  assert_includes(wat, "i32.const 20");
  assert_includes(wat, "i32.const 1");
  assert_includes(wat, "i32.add");
});

Deno.test("case descriptors construct inspect and project union cases", () => {
  const wat = Source.wat(`
type Result = | \`Ok Int | \`Err Int

const cases = @describe_cases(Result)
const ok_case = cases[0]
let result: Result = @construct(ok_case, 42)

if @is_case(result, ok_case) {
  @project(result, ok_case)
} else {
  0
}
`);

  assert_includes(wat, "i32.const 42");
  assert_includes(wat, "if (result i32)");
});

Deno.test("comptime recursive functions preserve tail recursion", () => {
  const source = TestSource.parse(`
const factorial = rec (value, result) => {
  if value == 0 {
    result
  } else {
    rec(value - 1, result * value)
  }
}

comptime factorial(5, 1)
`);
  const ic = Emit.emit(TestSource, source);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 120 });
});

Deno.test("comptime recursive functions evaluate non-tail calls", () => {
  const source = TestSource.parse(`
const factorial = rec value => {
  if value == 0 {
    1
  } else {
    value * rec(value - 1)
  }
}

comptime factorial(5)
`);
  const ic = Emit.emit(TestSource, source);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 120 });
});

Deno.test("named comptime recursion memoizes repeated subproblems", () => {
  const wat = Source.wat(`
const fibonacci = rec value => {
  if value < 2 {
    value
  } else {
    fibonacci(value - 1) + fibonacci(value - 2)
  }
}

comptime fibonacci(20)
`);

  assert_includes(wat, "i32.const 6765");
});

Deno.test("comptime recursion constructs closed fixed arrays", () => {
  const wat = Source.wat(`
const countdown = rec value => {
  if value == 0 {
    []
  } else {
    [value, ...rec(value - 1)]
  }
}

const values = comptime countdown(3)
values[0] + values[2]
`);

  assert_includes(wat, "i32.const 3");
  assert_includes(wat, "i32.const 1");
  assert_includes(wat, "i32.add");
});

Deno.test("named const recursion is a valid compile-time self-reference", () => {
  const analysis = Source.analyze(`
const factorial = rec value => {
  if value == 0 {
    1
  } else {
    value * factorial(value - 1)
  }
}

comptime factorial(5)
`);

  assert_equals(analysis.diagnostics, []);
});

Deno.test("const fold reduces a fixed array at the comptime boundary", () => {
  const wat = Source.wat(`
const fold = rec (values, index, state, next) => {
  if index == @len(values) {
    state
  } else {
    rec(values, index + 1, next(state, values[index]), next)
  }
}

comptime fold([1, 2, 3], 0, 0, (sum, value) => sum + value)
`);

  assert_includes(wat, "i32.const 6");
});

Deno.test("const fold derives a runtime record function from field descriptors", () => {
  const wat = Source.wat(`
const { struct } = import "duck:prelude" ()
type Player = struct {.left = Int, .right = Int}

const fold = rec (values, index, state, next) => {
  if index == @len(values) {
    state
  } else {
    rec(values, index + 1, next(state, values[index]), next)
  }
}

const add_field = (sum, field) => {
  value => sum(value) + @project(value, field)
}

const derive_sum = (const target) => {
  const fields = @describe_fields(target)

  fold(fields, 0, value => 0, add_field)
}

const sum_player = comptime derive_sum(Player)
let player: Player = [.left = 20, .right = 22]
sum_player(player)
`);

  assert_includes(wat, "i32.const 20");
  assert_includes(wat, "i32.const 22");
  assert_includes(wat, "i32.add");
});

Deno.test("comptime recursion reports repeated argument cycles", () => {
  assert_throws(
    () =>
      Emit.emit(
        TestSource,
        TestSource.parse(`
const forever = rec value => rec value
comptime forever(1)
`),
      ),
    "Compile-time recursion cycle detected at step 2: 1",
  );
});
