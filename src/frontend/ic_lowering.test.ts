import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Core } from "../core.ts";
import { Source as PublicSource } from "../frontend.ts";
import { TestSource as Source } from "./test_source.ts";
import { Ic } from "../ic.ts";
import { Emit, Format } from "../trait.ts";

function compile(text: string) {
  return Emit.emit(Source, Source.parse(text));
}

Deno.test("public Source rejects raw host imports in favor of effects and Init", () => {
  const raw = 'host_import read from "env.read" () => I32\nread()';
  const migration = "not source syntax; use `declare effect` and " +
    "provide its resource through `Init`";

  assert_throws(() => PublicSource.parse(raw), migration);
  assert_throws(() => PublicSource.core(raw), migration);
  assert_throws(() => PublicSource.wat(raw), migration);

  const internal_ast = Source.parse(raw);
  assert_throws(() => PublicSource.core(internal_ast), migration);
  assert_throws(() => PublicSource.artifact(internal_ast), migration);

  const dir = Deno.makeTempDirSync();
  const path = dir + "/raw-host-import.duck";

  try {
    Deno.writeTextFileSync(path, raw);
    assert_throws(() => PublicSource.load(path), migration);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("Source lowers arithmetic expressions to Ic", () => {
  const ic = compile("40 + 2");

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  const div_rem = compile("20 / 5 + 7 % 3");

  assert_equals(Ic.reduce(div_rem), { tag: "num", type: "i32", value: 5 });

  const negative = compile("-5 + 47");

  assert_equals(Ic.reduce(negative), { tag: "num", type: "i32", value: 42 });

  const wide = compile("-5i64 + 47i64");

  assert_equals(Ic.reduce(wide), { tag: "num", type: "i64", value: 42n });

  const wide_cmp = compile("3i64 < 5i64");

  assert_equals(Ic.reduce(wide_cmp), { tag: "num", type: "i32", value: 1 });

  const annotated_wide = compile(`
let factor: I64 = 2i64
let add_factor = (x: I64) => {
  x + factor
}

add_factor(40i64)
`);

  assert_equals(Ic.reduce(annotated_wide), {
    tag: "num",
    type: "i64",
    value: 42n,
  });

  const annotated_chained_wide = compile(`
let factor: I64 = 2i64
let add_factor = (x: I64) => {
  x + factor + 1i64
}

add_factor(40i64)
`);

  assert_equals(Ic.reduce(annotated_chained_wide), {
    tag: "num",
    type: "i64",
    value: 43n,
  });

  const annotated_dynamic_wide = compile(`
let factor: I64 = 2i64
let choose = (flag, x: I64) => {
  if flag {
    x + factor
  } else {
    x + factor + 1i64
  }
}

choose(input, 40i64)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(annotated_dynamic_wide)),
    "if input then 42:i64 else 43:i64",
  );

  const implicit_wide_fallback = compile(`
let value = if input {
  42i64
}

value
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(implicit_wide_fallback)),
    "if input then 42:i64 else 0:i64",
  );

  assert_throws(
    () =>
      compile(`
let value = if input {
  42i64
} else {
  0
}

value
`),
    "If branches must have the same type",
  );

  const annotated_wide_cmp = compile(`
let limit: I64 = 5i64
let below = (x: I64) => {
  x < limit
}

below(3i64)
`);

  assert_equals(Ic.reduce(annotated_wide_cmp), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  assert_throws(
    () => compile("1 + 2i64"),
    "Mixed i32 and i64 operands for operator +",
  );

  assert_throws(
    () =>
      compile(`
let factor: I64 = 2i64
let add_one = (x: I64) => {
  x + 1
}

add_one(40i64)
`),
    "Mixed i32 and i64 operands for operator +",
  );

  assert_throws(
    () =>
      compile(`
let user = [.age = 1]
user + 1
`),
    "Primitive i32.add expects numeric operands, got struct",
  );

  assert_throws(
    () =>
      compile(`
let f = x => x
f + 1
`),
    "Primitive i32.add expects numeric operands, got function",
  );

  assert_throws(
    () =>
      compile(`
let result = \`Ok (1)
result + 1
`),
    "Primitive i32.add expects numeric operands, got union",
  );
});

Deno.test("Source lowers let rec lambdas through Ic fixpoints", () => {
  const source = `
let rec fib = n => {
  if n < 2 {
    n
  } else {
    fib(n - 1) + fib(n - 2)
  }
}

fib(6)
`;

  assert_equals(
    Format.fmt(Source, Source.parse("let rec fib = n => n\nfib(1)")),
    "let rec fib = n => n\nfib 1",
  );

  const ic = compile(source);

  assert_includes(Format.fmt(Ic, ic), "fix fib#0 =");
  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 8 });

  const tail_source = `
let rec sum_down = (n, total) => {
  if n == 0 {
    total
  } else {
    sum_down(n - 1, total + n)
  }
}

sum_down(4, 0)
`;
  const wat = Emit.emit(Core, Source.core(Source.parse(tail_source)));

  assert_includes(wat, "block $rec_exit_0 (result i32)");
  assert_includes(wat, "loop $rec_loop_0");
  assert_includes(wat, "br $rec_loop_0");

  // non-tail string tested via Ic; Core tail rec covered in driver test + core.test
});

Deno.test("Source exposes Ic open-term WAT bridge", () => {
  const wat = Source.ic_wat("input + 1");

  assert_includes(wat, "(func $main (param $input i32) (result i32)");
  assert_includes(wat, "local.get $input");
});

Deno.test("Source exposes recursive Ic WAT bridge", () => {
  const wat = Source.ic_wat(`
let rec fib = n => {
  if n < 2 {
    n
  } else {
    fib(n - 1) + fib(n - 2)
  }
}

fib(input)
`);

  assert_includes(wat, "(func $fib#0 (param $n#0 i32) (result i32)");
  assert_includes(wat, "(func $main (param $input i32) (result i32)");
  assert_includes(wat, "if (result i32)");
  assert_includes(wat, "call $fib#0");
});

Deno.test("Source lowers unknown dynamic if through numeric primitive context", () => {
  const direct = compile(`
(if flag { a } else { b }) + 1
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(direct)),
    "if flag then a else b + 1:i32",
  );

  const deferred_binding = compile(`
let value = if flag {
  a
} else {
  b
}

value + 1
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(deferred_binding)),
    "if flag then a else b + 1:i32",
  );

  const deferred_i64 = compile(`
let value = if flag {
  a
} else {
  b
}

value + 1i64
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(deferred_i64)),
    "if flag then a else b + 1:i64",
  );

  const call_only_helper = compile(`
let choose = flag => if flag {
  a
} else {
  b
}

choose(flag) + 1
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(call_only_helper)),
    "if flag then a else b + 1:i32",
  );

  const call_only_helper_wide = compile(`
let choose = flag => if flag {
  a
} else {
  b
}

choose(flag) + 1i64
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(call_only_helper_wide)),
    "if flag then a else b + 1:i64",
  );

  const call_only_no_else_helper = compile(`
let choose = flag => if flag {
  a
}

choose(flag) + 1
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(call_only_no_else_helper)),
    "if flag then a else 0:i32 + 1:i32",
  );

  assert_throws(
    () =>
      compile(`
let value = if flag {
  a
} else {
  b
}

value
`),
    "Cannot lower dynamic if with unknown branches to Ic frontend",
  );
});

Deno.test("Source lowers let and same-type shadowing to fresh Ic names", () => {
  const ic = compile(`
let x = 40
x = x + 2
x
`);

  assert_equals(
    Format.fmt(Ic, ic),
    "(λx#0. (λx#1. x#1)(x#0 + 2:i32))(40:i32)",
  );
  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  const function_shadow = compile(`
let f = x => x + 1
f = y => y + 2
f(40)
`);

  assert_equals(Ic.reduce(function_shadow), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const aliased_annotation_shadow = compile(`
let f = (x: Int) => x + 1
f = (y: I32) => y + 2
f(40)
`);

  assert_equals(Ic.reduce(aliased_annotation_shadow), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const aliased_struct_shadow = compile(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int
}

const { struct } = import "duck:prelude" ()
const other_user_type = struct {
  .age= I32
}

let user = [.age = 1] as user_type
user = [.age = 41] as other_user_type
user.age + 1
`);

  assert_equals(Ic.reduce(aliased_struct_shadow), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const anonymous_struct_shadow = compile(`
let user = [.age = 1]
user = [.age = 41]
user.age + 1
`);

  assert_equals(Ic.reduce(anonymous_struct_shadow), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const typed_to_anonymous_shadow = compile(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int
}

let user = [.age = 1] as user_type
user = [.age = 41]
user.age + 1
`);

  assert_equals(Ic.reduce(typed_to_anonymous_shadow), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const shorthand_union_shadow = compile(`
let result = \`Ok (1)
result = \`Ok (41)

if let \`Ok value = result {
  value + 1
} else {
  0
}
`);

  assert_equals(Ic.reduce(shorthand_union_shadow), {
    tag: "num",
    type: "i32",
    value: 42,
  });
});

Deno.test("Source lowers unused runtime bindings to explicit erasure", () => {
  const unused = compile(`
let x = 1
2
`);

  assert_equals(Format.fmt(Ic, unused), "~ 1:i32;\n2:i32");
  assert_equals(Ic.reduce(unused), { tag: "num", type: "i32", value: 2 });

  const shadowed = compile(`
let x = 1
x = 2
3
`);

  assert_equals(Format.fmt(Ic, shadowed), "~ 1:i32;\n~ 2:i32;\n3:i32");
  assert_equals(Ic.reduce(shadowed), { tag: "num", type: "i32", value: 3 });
});

Deno.test("Source lowers repeated runtime names to explicit sharing", () => {
  const binding = compile(`
let x = 21
x + x
`);

  assert_equals(
    Format.fmt(Ic, binding),
    "! x#0_share0 &share_x_0_0 = 21:i32;\n" +
      "x#0_share00 + x#0_share01",
  );
  assert_equals(Ic.reduce(binding), { tag: "num", type: "i32", value: 42 });

  const triple = compile(`
let x = 14
x + x + x
`);

  assert_equals(
    Format.fmt(Ic, triple),
    "! x#0_share0 &share_x_0_0 = 14:i32;\n" +
      "! x#0_share1 &share_x_0_1 = x#0_share01;\n" +
      "x#0_share00 + x#0_share10 + x#0_share11",
  );
  assert_equals(Ic.reduce(triple), { tag: "num", type: "i32", value: 42 });

  const param = compile(`
let double = x => x + x
double(input)
`);
  const param_text = Format.fmt(Ic, param);
  assert_includes(
    param_text,
    "λx#0. ! x#0_share0 &share_x_0_0 = x#0;",
  );
  assert_equals(
    Format.fmt(Ic, Ic.reduce(param)),
    "! x#0_share0 &share_x_0_0 = input;\n" +
      "x#0_share00 + x#0_share01",
  );

  const constant_param = compile(`
let double = x => x + x
double(21)
`);
  assert_equals(Ic.reduce(constant_param), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const free = compile("input + input");
  assert_equals(
    Format.fmt(Ic, free),
    "! input_share0 &share_input_0 = input;\n" +
      "input_share00 + input_share01",
  );
  assert_equals(Format.fmt(Ic, Ic.reduce(free)), Format.fmt(Ic, free));
});

Deno.test("Source allows type-changing shadowing with :=", () => {
  const ic = compile(`
let x = 40
x := x + 2
x
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  const extended_type = compile(`
const { struct } = import "duck:prelude" ()
type User = struct { .age = I32 }
extend User { .default_age = 41 }
const default_age = 0
User.default_age + 1
`);

  assert_equals(Ic.reduce(extended_type), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const union_result = compile(`
let option = if let \`Ok value = if input {
  \`Ok (41)
} else {
  \`Err (0)
} {
  \`Some (value)
} else {
  \`None ()
}

option := 1
option
`);

  assert_equals(Ic.reduce(union_result), {
    tag: "num",
    type: "i32",
    value: 1,
  });
});

Deno.test("Source rejects type-changing assignment with =", () => {
  assert_throws(
    () =>
      compile(`
let x = 1
x = "hello"
x
`),
    "Assignment changes type for x",
  );

  assert_throws(
    () =>
      compile(`
let x = 1i64
x = 2
x
`),
    "Assignment changes type for x",
  );

  assert_throws(
    () =>
      compile(`
let option = if let \`Ok value = if input {
  \`Ok (41)
} else {
  \`Err (0)
} {
  \`Some (value)
} else {
  \`None ()
}

option = 1
option
`),
    "Assignment changes type for option",
  );

  assert_throws(
    () =>
      compile(`
let option = if let \`Ok value = if input {
  \`Ok (41)
} else {
  \`Err (0)
} {
  scratch { \`Some (value) }
} else {
  freeze \`None ()
}

option = 1
option
`),
    "Assignment changes type for option",
  );

  assert_throws(
    () =>
      compile(`
let f = x => x + 1
f = (x, y) => x + y
f(1, 41)
`),
    "Assignment changes type for f",
  );

  assert_throws(
    () =>
      compile(`
let f = if input {
  x => x + 1
} else {
  x => x + 2
}

f = (x, y) => x + y
f(1, 41)
`),
    "Assignment changes type for f",
  );

  assert_throws(
    () =>
      compile(`
let f = freeze (x => x + 1)
f = (x, y) => x + y
f(1, 41)
`),
    "Assignment changes type for f",
  );

  assert_throws(
    () =>
      compile(`
let f = (x: Text) => @len(x)
f = x => x + 1
f(message)
`),
    "Assignment changes type for f",
  );

  assert_throws(
    () =>
      compile(`
let f = (x: Int) => x + 1
f = (y: Text) => @len(y)
f(1)
`),
    "Assignment changes type for f",
  );

  assert_throws(
    () =>
      compile(`
let f = (x: Unit) => 0
f = (y: Text) => @len(y)
f(message)
`),
    "Assignment changes type for f",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int
}

const { struct } = import "duck:prelude" ()
const other_user_type = struct {
  .age= Text
}

let user = [.age = 1] as user_type
user = [.age = "Ada"] as other_user_type
user.age
`),
    "Assignment changes type for user",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int
}

const { struct } = import "duck:prelude" ()
const other_user_type = struct {
  .age= I64
}

let user = [.age = 1] as user_type
user = [.age = 2i64] as other_user_type
user.age
`),
    "Assignment changes type for user",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int
}

let user = [.age = 1] as user_type
user = [.age = "Ada"]
user.age
`),
    "Assignment changes type for user",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int
}

let user = [.age = 1] as user_type
user = [.age = 2i64]
user.age
`),
    "Assignment changes type for user",
  );

  assert_throws(
    () =>
      compile(`
let user = [.age = 1]
user = [.age = "Ada"]
user.age
`),
    "Assignment changes type for user",
  );

  assert_throws(
    () =>
      compile(`
let result = \`Ok (1)
result = \`Ok ("Ada")
result
`),
    "Assignment changes type for result",
  );

  assert_throws(
    () =>
      compile(`
let result = \`Ok (1)
result = \`Ok (2i64)
result
`),
    "Assignment changes type for result",
  );
});

Deno.test("source-defined trait operators lower through IC intrinsics", () => {
  assert_equals(Ic.reduce(compile("1 << 4")), {
    tag: "num",
    type: "i32",
    value: 16,
  });
  assert_equals(Ic.reduce(compile('"a" <> "b"')), {
    tag: "text",
    value: "ab",
  });
});

Deno.test("Source lowers text literals to Ic", () => {
  const literal = compile('"hello"');

  assert_equals(Ic.reduce(literal), { tag: "text", value: "hello" });

  const rebound = compile(`
let message: Text = "hello"
message = "world"
message
`);

  assert_equals(Ic.reduce(rebound), { tag: "text", value: "world" });

  const branch = compile(`
if true {
  "ready"
} else {
  "no"
}
`);

  assert_equals(Ic.reduce(branch), { tag: "text", value: "ready" });

  const escaped = compile('"hello\\nworld"');

  assert_equals(Format.fmt(Ic, Ic.reduce(escaped)), '"hello\\nworld"');

  const escaped_tab = compile('"hello\\tworld"');

  assert_equals(Ic.reduce(escaped_tab), {
    tag: "text",
    value: "hello\tworld",
  });

  const escaped_return = compile('"hello\\rworld"');

  assert_equals(Ic.reduce(escaped_return), {
    tag: "text",
    value: "hello\rworld",
  });

  const escaped_quote = compile('"hello \\"Ada\\""');

  assert_equals(Ic.reduce(escaped_quote), {
    tag: "text",
    value: 'hello "Ada"',
  });

  const escaped_backslash = compile('"path \\\\ tmp"');

  assert_equals(Ic.reduce(escaped_backslash), {
    tag: "text",
    value: "path \\ tmp",
  });

  const concat = compile('"hello" + " world"');

  assert_equals(Ic.reduce(concat), { tag: "text", value: "hello world" });

  const named_concat = compile(`
let message = "hello"
message + " world"
`);

  assert_equals(Ic.reduce(named_concat), {
    tag: "text",
    value: "hello world",
  });

  const rebound_concat = compile(`
let message: Text = "hello"
message = message + " world"
message
`);

  assert_equals(Ic.reduce(rebound_concat), {
    tag: "text",
    value: "hello world",
  });

  const comptime_concat = compile(`
const message = comptime ("hello" + " world")
message
`);

  assert_equals(Ic.reduce(comptime_concat), {
    tag: "text",
    value: "hello world",
  });

  const dynamic_branch = compile(`
if flag {
  "ready"
} else {
  "no"
}
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(dynamic_branch)),
    'if flag then "ready" else "no"',
  );

  const dynamic_concat = compile(`
let message = if flag {
  "hi"
} else {
  "hello"
}

message + "!"
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(dynamic_concat)),
    'if flag then "hi!" else "hello!"',
  );

  const block_concat = compile(`
{
  let message = "Ada"
  message
} + "!"
`);

  assert_equals(Ic.reduce(block_concat), {
    tag: "text",
    value: "Ada!",
  });

  const block_dynamic_concat = compile(`
{
  let message = if flag {
    "hi"
  } else {
    "hello"
  }

  message
} + "!"
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(block_dynamic_concat)),
    'if flag then "hi!" else "hello!"',
  );

  assert_equals(Ic.reduce(compile('@len("hello")')), {
    tag: "num",
    type: "i32",
    value: 5,
  });

  assert_equals(Ic.reduce(compile('@len("hé" + "!")')), {
    tag: "num",
    type: "i32",
    value: 4,
  });

  assert_equals(
    Ic.reduce(compile(`
@len({
  let message = "Ada"
  message
})
`)),
    {
      tag: "num",
      type: "i32",
      value: 3,
    },
  );

  assert_equals(Ic.reduce(compile('"Ada"[1]')), {
    tag: "num",
    type: "i32",
    value: 100,
  });

  assert_equals(Ic.reduce(compile('"hé"[1]')), {
    tag: "num",
    type: "i32",
    value: 195,
  });

  assert_equals(
    Ic.reduce(compile(`
{
  let message = "Ada"
  message
}[1]
`)),
    {
      tag: "num",
      type: "i32",
      value: 100,
    },
  );

  assert_equals(
    Ic.reduce(compile(`
@get({
  let message = "Ada"
  message
}, 2)
`)),
    {
      tag: "num",
      type: "i32",
      value: 97,
    },
  );

  const block_runtime_byte = compile(`
{
  let message = "Ada"
  message
}[i]
`);
  const block_runtime_byte_text = Format.fmt(Ic, Ic.reduce(block_runtime_byte));

  assert_includes(block_runtime_byte_text, "then 65:i32");
  assert_includes(block_runtime_byte_text, "then 100:i32");
  assert_includes(block_runtime_byte_text, "then 97:i32");
  assert_includes(block_runtime_byte_text, "else trap");

  const text_byte_branch = compile(`
let message = if flag {
  "Ada"
} else {
  "Eve"
}

message[2]
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(text_byte_branch)),
    "if flag then 97:i32 else 101:i32",
  );

  const text_byte_branch_trap = compile(`
let message = if flag {
  "A"
} else {
  "BC"
}

message[1]
`);
  const text_byte_branch_trap_text = Format.fmt(
    Ic,
    Ic.reduce(text_byte_branch_trap),
  );

  assert_equals(
    text_byte_branch_trap_text,
    "if flag then trap else 67:i32",
  );

  const block_dynamic_byte = compile(`
{
  let message = if flag {
    "Ada"
  } else {
    "Eve"
  }

  message
}[2]
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(block_dynamic_byte)),
    "if flag then 97:i32 else 101:i32",
  );

  assert_throws(
    () => compile('"Ada"[3]'),
    "Text index out of bounds: 3",
  );

  const named_len = compile(`
let message = "hello"
@len(message)
`);

  assert_equals(Ic.reduce(named_len), {
    tag: "num",
    type: "i32",
    value: 5,
  });

  const dynamic_len = compile(`
let message = if flag {
  "hi"
} else {
  "hello"
}

@len(message)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(dynamic_len)),
    "if flag then 2:i32 else 5:i32",
  );

  const runtime_len = compile(`
let byte_len = (value: Text) => {
  @len(value)
}

byte_len("hello")
`);

  assert_equals(Format.fmt(Ic, Ic.reduce(runtime_len)), 'load("hello")');

  const runtime_byte = compile(`
let byte_at = (value: Text) => {
  value[1]
}

byte_at("Ada")
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(runtime_byte)),
    'if 1:i32 < load("Ada") then load8_u("Ada" + 4:i32 + 1:i32) else trap',
  );

  const runtime_dynamic_byte = compile(`
let byte_at = (value: Text, i) => {
  value[i]
}

byte_at("Ada", 2)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(runtime_dynamic_byte)),
    'if 2:i32 < load("Ada") then load8_u("Ada" + 4:i32 + 2:i32) else trap',
  );

  const runtime_get_byte = compile(`
let byte_at = (value: Text, i) => {
  @get(value, i)
}

byte_at("Ada", 2)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(runtime_get_byte)),
    'if 2:i32 < load("Ada") then load8_u("Ada" + 4:i32 + 2:i32) else trap',
  );

  const visible_get_byte = compile('@get("Ada", 1)');

  assert_equals(Ic.reduce(visible_get_byte), {
    tag: "num",
    type: "i32",
    value: 100,
  });

  const runtime_oob_byte = compile(`
let byte_at = (value: Text, i) => {
  value[i]
}

byte_at("Ada", 3)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(runtime_oob_byte)),
    'if 3:i32 < load("Ada") then load8_u("Ada" + 4:i32 + 3:i32) else trap',
  );

  assert_throws(
    () =>
      compile(`
let byte_at = (value: Text, i: I64) => {
  value[i]
}

byte_at("Ada", 1i64)
`),
    "Text index must be i32",
  );

  assert_throws(
    () => compile('name + "!"'),
    "Text concatenation requires visible text operands",
  );

  assert_throws(
    () =>
      compile(`
let append = (value: Text) => {
  value + 1
}

append("Ada")
`),
    "Text concatenation requires visible text operands",
  );

  assert_equals(Ic.reduce(compile('"Ada" == "Ada"')), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  assert_equals(Ic.reduce(compile('"Ada" != "Ada"')), {
    tag: "num",
    type: "i32",
    value: 0,
  });

  assert_equals(Ic.reduce(compile('@slice("Grace", 1, 4)')), {
    tag: "text",
    value: "rac",
  });

  const dynamic_visible_slice = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let name = if input {
  "Grace"
} else {
  "Ada"
}

@slice(name, 1, 3)
`)),
  );
  assert_equals(
    dynamic_visible_slice,
    'if input then "ra" else "da"',
  );

  const bound_dynamic_slice_equality = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let part = @slice(if input {
  "Grace"
} else {
  "Ada"
}, 1, 3)

part == "ra"
`)),
  );
  assert_equals(
    bound_dynamic_slice_equality,
    "if input then 1:i32 else 0:i32",
  );

  const bound_dynamic_slice_len = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let part = @slice(if input {
  "Grace"
} else {
  "Ada"
}, 1, 3)

@len(part)
`)),
  );
  assert_equals(
    bound_dynamic_slice_len,
    "if input then 2:i32 else 2:i32",
  );

  const bound_dynamic_slice_index = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let part = @slice(if input {
  "Grace"
} else {
  "Ada"
}, 1, 3)

part[0]
`)),
  );
  assert_equals(
    bound_dynamic_slice_index,
    "if input then 114:i32 else 100:i32",
  );

  assert_equals(Ic.reduce(compile('@append("Ada", "!")')), {
    tag: "text",
    value: "Ada!",
  });

  const dynamic_visible_append = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let name = if input {
  "Ada"
} else {
  "Grace"
}

@append(name, "!")
`)),
  );
  assert_equals(
    dynamic_visible_append,
    'if input then "Ada!" else "Grace!"',
  );

  const nested_dynamic_visible_append = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let left = if input {
  "Ada"
} else {
  "Grace"
}
let right = if input {
  "!"
} else {
  "?"
}

@append(left, right)
`)),
  );
  assert_includes(nested_dynamic_visible_append, 'then "Ada!" else "Ada?"');
  assert_includes(nested_dynamic_visible_append, 'then "Grace!" else "Grace?"');

  const bound_dynamic_append_equality = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let message = @append(if input {
  "Ada"
} else {
  "Grace"
}, "!")

message == "Ada!"
`)),
  );
  assert_equals(
    bound_dynamic_append_equality,
    "if input then 1:i32 else 0:i32",
  );

  const bound_dynamic_append_len = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let message = @append(if input {
  "a"
} else {
  "bb"
}, "!")

@len(message)
`)),
  );
  assert_equals(
    bound_dynamic_append_len,
    "if input then 2:i32 else 3:i32",
  );

  const bound_dynamic_append_index = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let message = @append(if input {
  "a"
} else {
  "bb"
}, "!")

message[1]
`)),
  );
  assert_equals(
    bound_dynamic_append_index,
    "if input then 33:i32 else 98:i32",
  );

  const dynamic_visible_equality = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let name = if input {
  "Ada"
} else {
  "Grace"
}

name == "Ada"
`)),
  );
  assert_equals(
    dynamic_visible_equality,
    "if input then 1:i32 else 0:i32",
  );

  const dynamic_visible_inequality = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let left = if input {
  "Ada"
} else {
  "Grace"
}
let right = if input {
  "Grace"
} else {
  "Ada"
}

left != right
`)),
  );
  assert_includes(dynamic_visible_inequality, "then if");
  assert_includes(dynamic_visible_inequality, "else if");
  assert_includes(dynamic_visible_inequality, "then 1:i32 else 0:i32");

  assert_equals(
    Ic.reduce(compile(`
let message = if let \`Ok value = \`Ok ("Ada") {
  value
} else {
  "Grace"
}

message == "Ada"
`)),
    {
      tag: "num",
      type: "i32",
      value: 1,
    },
  );

  assert_equals(
    Ic.reduce(compile(`
let message = if let \`Ok value = \`Ok ("Ada") {
  value
} else {
  "Grace"
}

@len(message)
`)),
    {
      tag: "num",
      type: "i32",
      value: 3,
    },
  );

  assert_equals(
    Ic.reduce(compile(`
let message = if let \`Ok value = \`Ok ("Ada") {
  value
} else {
  "Grace"
}

message[1]
`)),
    {
      tag: "num",
      type: "i32",
      value: 100,
    },
  );

  const dynamic_if_let_text_equality = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let message = if let \`Ok value = if input {
  \`Ok ("Ada")
} else {
  \`Err ("Grace")
} {
  value
} else {
  "Grace"
}

message == "Ada"
`)),
  );
  assert_equals(
    dynamic_if_let_text_equality,
    "if input then 1:i32 else 0:i32",
  );

  const dynamic_if_let_text_len = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let message = if let \`Ok value = if input {
  \`Ok ("Ada")
} else {
  \`Err ("Grace")
} {
  value
} else {
  "Grace"
}

@len(message)
`)),
  );
  assert_equals(
    dynamic_if_let_text_len,
    "if input then 3:i32 else 5:i32",
  );

  const dynamic_if_let_text_index = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let message = if let \`Ok value = if input {
  \`Ok ("Ada")
} else {
  \`Err ("Grace")
} {
  value
} else {
  "Grace"
}

message[1]
`)),
  );
  assert_equals(
    dynamic_if_let_text_index,
    "if input then 100:i32 else 114:i32",
  );

  const helper_append_text_equality = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let suffix = value => @append(value, "!")
let message = suffix(if input {
  "Ada"
} else {
  "Grace"
})

message == "Ada!"
`)),
  );
  assert_equals(
    helper_append_text_equality,
    "if input then 1:i32 else 0:i32",
  );

  const helper_slice_text_equality = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let take = value => @slice(value, 1, 3)
let part = take(if input {
  "Grace"
} else {
  "Ada"
})

part == "ra"
`)),
  );
  assert_equals(
    helper_slice_text_equality,
    "if input then 1:i32 else 0:i32",
  );

  const helper_text_if_equality = Format.fmt(
    Ic,
    Ic.reduce(compile(`
let choose = flag => if flag {
  "Ada"
} else {
  "Grace"
}

let message = choose(input)
message == "Ada"
`)),
  );
  assert_equals(
    helper_text_if_equality,
    "if input then 1:i32 else 0:i32",
  );

  const helper_if_let_text_equality = Format.fmt(
    Ic,
    Ic.reduce(compile(`
type ResultType = | \`Ok Text | \`Err Text
const result_type = ResultType

let from_result = (result: result_type) => if let \`Ok value = result {
  value
} else {
  "fallback"
}

let message = from_result(if input {
  \`Ok ("Ada")
} else {
  \`Err ("Grace")
})

message == "Ada"
`)),
  );
  assert_equals(
    helper_if_let_text_equality,
    "if input then 1:i32 else 0:i32",
  );

  const runtime_text_identity = compile(`
let same = (value: Text) => {
  value == value
}

same(input)
`);

  assert_equals(Ic.reduce(runtime_text_identity), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  const runtime_text_non_identity = compile(`
let different = (value: Text) => {
  value != value
}

different(input)
`);

  assert_equals(Ic.reduce(runtime_text_non_identity), {
    tag: "num",
    type: "i32",
    value: 0,
  });

  const runtime_text_borrow_identity = compile(`
let same = (value: Text) => {
  &value == &value
}

same(input)
`);

  assert_equals(Ic.reduce(runtime_text_borrow_identity), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  const runtime_text_scratch_identity = compile(`
let same = (value: Text) => {
  scratch { value } == scratch { value }
}

same(input)
`);

  assert_equals(Ic.reduce(runtime_text_scratch_identity), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  const runtime_text_mixed_wrapper_identity = compile(`
let value: Text = input
&value == scratch { value }
`);

  assert_equals(Ic.reduce(runtime_text_mixed_wrapper_identity), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  const runtime_text_scratch_alias_identity = compile(`
let value: Text = input
scratch {
  let alias = value
  alias
} == scratch {
  let alias = value
  alias
}
`);

  assert_equals(Ic.reduce(runtime_text_scratch_alias_identity), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  const runtime_text_helper_identity = compile(`
let identity = (value: Text) => {
  value
}

identity(input) == identity(input)
`);

  assert_equals(Ic.reduce(runtime_text_helper_identity), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  const runtime_text_helper_scratch_identity = compile(`
let identity = (value: Text) => {
  scratch { value }
}

identity(input) == identity(input)
`);

  assert_equals(Ic.reduce(runtime_text_helper_scratch_identity), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  assert_throws(
    () =>
      compile(`
let same = (value: Text) => {
  value == "Ada"
}

same(input)
`),
    "Text equality with runtime text requires structured Core/Wasm lowering",
  );

  assert_throws(
    () =>
      compile(`
let suffix = (value: Text) => {
  @append(value, "!")
}

suffix(input) == suffix(input)
`),
    "Text equality with runtime text requires structured Core/Wasm lowering",
  );

  assert_equals(
    Ic.reduce(compile(`
let take = (value: Text, start) => {
  @slice(value, start, 4)
}

take("Grace", 1)
`)),
    { tag: "text", value: "rac" },
  );

  assert_throws(
    () =>
      compile(`
let add_suffix = (value: Text) => {
  @append(value, "!")
}

let message: Text = input
add_suffix(message)
`),
    "Text append with runtime text requires structured Core/Wasm lowering",
  );
});

Deno.test("Source lowers Bool and character literals to typed i32", () => {
  assert_equals(Ic.reduce(compile("true")), {
    tag: "num",
    type: "i32",
    value: 1,
  });
  assert_equals(Ic.reduce(compile("false")), {
    tag: "num",
    type: "i32",
    value: 0,
  });
  assert_equals(Ic.reduce(compile("true && !false")), {
    tag: "num",
    type: "i32",
    value: 1,
  });
  assert_equals(Ic.reduce(compile("'A'")), {
    tag: "num",
    type: "i32",
    value: 65,
  });
  assert_equals(Ic.reduce(compile("'λ'")), {
    tag: "num",
    type: "i32",
    value: 955,
  });
  assert_equals(Ic.reduce(compile("'🦀'")), {
    tag: "num",
    type: "i32",
    value: 129408,
  });
  assert_equals(Ic.reduce(compile(String.raw`'\n'`)), {
    tag: "num",
    type: "i32",
    value: 10,
  });
  assert_equals(Ic.reduce(compile(String.raw`'\''`)), {
    tag: "num",
    type: "i32",
    value: 39,
  });
  assert_equals(Ic.reduce(compile(String.raw`'\\'`)), {
    tag: "num",
    type: "i32",
    value: 92,
  });

  const parenthesized_character_pattern = compile(`
let value = 'c'
if (let 'c' = value) {
  42
} else {
  0
}
`);

  assert_equals(Ic.reduce(parenthesized_character_pattern), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const literal_patterns = compile(`
let flag = false
let value = 0
if let false = flag {
  value = 1
}
if let 1 = value {
  value = 2
}
if let "ready" = "ready" {
  value = value + 40
}
value
`);

  assert_equals(Ic.reduce(literal_patterns), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  assert_equals(
    Ic.reduce(compile(`
let value = 42i64
if let 42i64 = value {
  42
} else {
  0
}
`)),
    {
      tag: "num",
      type: "i32",
      value: 42,
    },
  );

  assert_throws(
    () => compile("''"),
    "Character literal must contain exactly one Unicode scalar value",
  );
  assert_throws(
    () => compile("'ab'"),
    "Character literal must contain exactly one Unicode scalar value",
  );
  assert_throws(
    () => compile("'a"),
    "Unterminated character literal",
  );
  assert_throws(
    () => compile(String.raw`'\x'`),
    "Unsupported character escape: \\x",
  );
  assert_throws(
    () => Source.core("if (let value = 1) { 42 }"),
    "Unreachable match arm 1",
  );
});

Deno.test("Source checks binding annotations", () => {
  assert_equals(
    Format.fmt(Source, Source.parse("let x: Int = 1\nx")),
    "let x: Int = 1\nx",
  );

  const scalar = compile(`
let x: Int = 41
x + 1
`);

  assert_equals(Ic.reduce(scalar), { tag: "num", type: "i32", value: 42 });

  const wide = compile(`
let x: I64 = 41i64
x + 1i64
`);

  assert_equals(Ic.reduce(wide), { tag: "num", type: "i64", value: 42n });

  assert_throws(
    () => compile("let x: Text = 1\nx"),
    "Binding annotation expects Text, got I32",
  );

  assert_throws(
    () => compile("let x: I64 = 1\nx"),
    "Binding annotation expects I64, got I32",
  );

  const unknown_scalar = compile(`
let x: Int = input
x + 1
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(unknown_scalar)),
    "input + 1:i32",
  );

  const unknown_text = compile(`
let value: Text = message
@len(value)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(unknown_text)),
    "load(message)",
  );

  const reassigned_text = compile(`
let value: Text = message
value = other
@len(value)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(reassigned_text)),
    "load(other)",
  );

  const block_reassigned_text = compile(`
@len({
  let value: Text = message
  value = other
  value
})
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(block_reassigned_text)),
    "load(other)",
  );

  assert_throws(
    () =>
      compile(`
const has_age = t => {
  let struct { .age= Int, .. } = t
  t
}

let user: has_age = input
user
`),
    "Const parameter t requires compile-time argument: input",
  );
});

Deno.test("Source evaluates pure comptime const functions before Ic lowering", () => {
  const ic = compile(`
const make_adder = n => {
  x => x + n
}

const add_three = comptime make_adder(3)

let y = add_three(39)
y
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  const value_capture = compile(`
const factor = 1
const value = factor + 1
const factor = 100

value
`);

  assert_equals(Ic.reduce(value_capture), {
    tag: "num",
    type: "i32",
    value: 2,
  });

  const closure_capture = compile(`
const factor = 1
const scale = x => x + factor
const factor = 100

scale(41)
`);

  assert_equals(Ic.reduce(closure_capture), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const static_branch_capture = compile(`
const factor = 1
const scale = if true {
  x => x + factor
} else {
  x => x + factor + 1
}
const factor = 100

scale(41)
`);

  assert_equals(Ic.reduce(static_branch_capture), {
    tag: "num",
    type: "i32",
    value: 42,
  });
});

Deno.test("Source lowers const-foldable if expressions", () => {
  const ic = compile(`
const limit = 10

if 3 < limit {
  42
} else {
  0
}
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  const block_value = compile(`
{
  const { struct } = import "duck:prelude" ()
  const age_type = struct { .age = Int }
  let age = 41
  let box: age_type = [age]
  box
}.age + 1
`);

  assert_equals(Ic.reduce(block_value), {
    tag: "num",
    type: "i32",
    value: 42,
  });
});

Deno.test("Source lowers pure runtime if expressions through select", () => {
  const ic = compile(`
let input = true

if input {
  42
} else {
  0
}
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });
});

Deno.test("Source lowers else-if chains as nested expressions", () => {
  const ordinary = compile(`
let choice = 2

if choice == 1 {
  10
} else if choice == 2 {
  42
} else {
  0
}
`);

  assert_equals(Ic.reduce(ordinary), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const literal_pattern = compile(`
let token = 'x'

if let 'a' = token {
  1
} else if (let 'x' = token) {
  42
} else {
  0
}
`);

  assert_equals(Ic.reduce(literal_pattern), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const union_pattern = compile(`
let result = \`Err (42)

if let \`Ok value = result {
  value
} else if let \`Err error = result {
  error
} else {
  0
}
`);

  assert_equals(Ic.reduce(union_pattern), {
    tag: "num",
    type: "i32",
    value: 42,
  });
  assert_includes(
    Format.fmt(
      Source,
      Source.parse(`
if let \`Ok value = result {
  value
} else if let \`Err error = result {
  error
} else {
  0
}
`),
    ),
    "else if let `Err error",
  );

  const assigned_wat = Source.wat(`
host_import choose from "env.choose" () => I32
let choice = choose()
let result = 0

if choice == 1 {
  result = 1
} else if choice == 2 {
  result = 42
} else {
  result = 3
}

result
  `);

  assert_includes(assigned_wat, "i32.const 42");
  assert_equals(
    assigned_wat.split("\n").filter((line) => {
      return line.trim() === "if";
    }).length,
    2,
  );

  const implicit_final_else = compile(`
let first = false
let second = true

if first {
  1
} else if second {
  42
}
`);

  assert_equals(Ic.reduce(implicit_final_else), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  assert_includes(
    Format.fmt(
      Source,
      Source.parse(`
if first {
  1
} else if second {
  2
} else {
  3
}
`),
    ),
    "else if second",
  );
});

Deno.test("Source lowers no-else if statements with fallthrough", () => {
  const selected = compile(`
let flag = true

if flag {
  return 42
}

0
`);

  assert_equals(Ic.reduce(selected), { tag: "num", type: "i32", value: 42 });

  const skipped = compile(`
let flag = false

if flag {
  return 42
}

7
`);

  assert_equals(Ic.reduce(skipped), { tag: "num", type: "i32", value: 7 });

  const fallthrough = compile(`
let flag = true
let value = 1

if flag {
  value = value + 41
}

value
`);

  assert_equals(Ic.reduce(fallthrough), { tag: "num", type: "i32", value: 42 });
});

Deno.test("Source lowers dynamic no-else if statements through select", () => {
  const assigned = compile(`
let value = 1

if flag {
  value = 42
}

value
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(assigned)),
    "if flag then 42:i32 else 1:i32",
  );

  const returned = compile(`
if flag {
  return 42
}

0
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(returned)),
    "if flag then 42:i32 else 0:i32",
  );
});

Deno.test("Source propagates returns through nested blocks", () => {
  const nested = compile(`
let f = () => {
  {
    return 41
  }

  1
}

f() + 1
`);

  assert_equals(Ic.reduce(nested), { tag: "num", type: "i32", value: 42 });

  const fallthrough = compile(`
let f = flag => {
  {
    if flag {
      return 41
    }
  }

  1
}

f(0) + 1
`);

  assert_equals(Ic.reduce(fallthrough), {
    tag: "num",
    type: "i32",
    value: 2,
  });

  const dynamic = compile(`
let f = flag => {
  {
    if flag {
      return 41
    }
  }

  1
}

f(input) + 1
`);
  const dynamic_text = Format.fmt(Ic, Ic.reduce(dynamic));

  assert_includes(dynamic_text, "if input then 41:i32 else 1:i32");
  assert_includes(dynamic_text, "+ 1:i32");

  const if_let_match = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

let f = (option: option_type) => {
  {
    if let \`Some value = option {
      return value
    }
  }

  0
}

f(\`Some (41)) + 1
`);

  assert_equals(Ic.reduce(if_let_match), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const if_let_fallthrough = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

let f = (option: option_type) => {
  {
    if let \`Some value = option {
      return value
    }
  }

  0
}

f(\`None ()) + 1
`);

  assert_equals(Ic.reduce(if_let_fallthrough), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  const dynamic_if_let = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

let f = (option: option_type) => {
  {
    if let \`Some value = option {
      return value
    }
  }

  0
}

f(if input {
  \`Some (41)
} else {
  \`None ()
}) + 1
`);
  const dynamic_if_let_text = Format.fmt(Ic, Ic.reduce(dynamic_if_let));

  assert_includes(dynamic_if_let_text, "if input then 41:i32 else 0:i32");
  assert_includes(dynamic_if_let_text, "+ 1:i32");
});

Deno.test("Source preserves dynamic if conditions as Ic select", () => {
  const ic = compile(`
if input {
  42
} else {
  0
}
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(ic)),
    "if input then 42:i32 else 0:i32",
  );

  const wide = compile(`
if input {
  1i64
} else {
  2i64
}
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(wide)),
    "if input then 1:i64 else 2:i64",
  );

  assert_throws(
    () =>
      compile(`
if input {
  1i64
} else {
  2
}
`),
    "If branches must have the same type",
  );

  assert_throws(
    () =>
      compile(`
if "x" {
  1
} else {
  0
}
`),
    "If condition expects Bool, got Text",
  );

  assert_throws(
    () =>
      compile(`
if [.age = 1] {
  1
} else {
  0
}
`),
    "If condition expects Bool, got struct",
  );

  assert_throws(
    () =>
      compile(`
let f = x => x

if f {
  1
} else {
  0
}
`),
    "If condition expects Bool, got fn",
  );

  assert_throws(
    () =>
      compile(`
let result = \`Ok (1)

if result {
  1
} else {
  0
}
`),
    "If condition expects Bool, got union",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int
}

if input {
  user_type
} else {
  user_type
}
`),
    "Cannot lower dynamic if with Type branches to Ic frontend",
  );

  assert_throws(
    () =>
      compile(`
let check = (value: I64) => {
  if value {
    1
  } else {
    0
  }
}

check(1i64)
`),
    "If condition expects Bool, got I64",
  );
});

Deno.test("Source lowers logical operators through boolean if expressions", () => {
  const both = compile("(1 < 2) && (3 < 4)");

  assert_equals(Ic.reduce(both), { tag: "num", type: "i32", value: 1 });

  const either = compile("false || true");

  assert_equals(Ic.reduce(either), { tag: "num", type: "i32", value: 1 });

  const neither = compile("false || false");

  assert_equals(Ic.reduce(neither), { tag: "num", type: "i32", value: 0 });

  const and_short = compile('false && @fail("right branch")');

  assert_equals(Ic.reduce(and_short), { tag: "num", type: "i32", value: 0 });

  const or_short = compile('true || @fail("right branch")');

  assert_equals(Ic.reduce(or_short), { tag: "num", type: "i32", value: 1 });

  const bounds = compile(`
const xs = [10, 20]

const i = 0

if i < 0 || i >= @len(xs) {
  @panic("index out of bounds")
} else {
  @get(xs, i)
}
`);

  assert_equals(Ic.reduce(bounds), { tag: "num", type: "i32", value: 10 });
});
