import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Source } from "../frontend.ts";
import { Ic } from "../ic.ts";
import { Emit } from "../trait.ts";
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

Deno.test("type match specializes a const function for a named type", () => {
  const wat = Source.wat(`
type Name = Text
type Player = [.name = Name, .score = Int]

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
type Player = [.name = Text, .score = Int]
@describe_type(Player).size + @describe_fields(Player)[1].offset
`);
  assert_includes(record, "i32.const 12");
  assert_includes(record, "i32.const 8");

  const sum = Source.wat(`
type Result = | .ok = Int | .err = Text

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
type Player = [.name = Int, .score = Int]

const player_fields = @describe_fields(Player)
const score_field = player_fields[1]
let player = @construct(Player, [.name = 20, .score = 40])

@project(player, score_field) + 2
`);

  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.const 2");
  assert_includes(wat, "i32.add");
});

Deno.test("case descriptors construct inspect and project union cases", () => {
  const wat = Source.wat(`
type Result = | .ok = Int | .err = Int

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
type Player = [.left = Int, .right = Int]

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
