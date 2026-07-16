import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Core } from "../core.ts";
import { TestSource as Source } from "./test_source.ts";
import { Ic } from "../ic.ts";
import { Emit, Format } from "../trait.ts";

function compile(text: string) {
  return Emit.emit(Source, Source.parse(text));
}

Deno.test("Source lowers struct field projection to Ic", () => {
  const ic = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .bonus= Int
}

let age = 40
let user = [.age = age + 1, .bonus = 5] as user_type
age = 0
user.age + 1
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  const block_local_call = compile(`
const { struct } = comptime (import "duck:prelude")()
const pair_type = struct {
  .first= Int,
  .label= Text
}

const make = x => {
  [.first = x + 1, .label = "ok"] as pair_type
}

let pair = {
  let made = make(input)
  made
}

pair.first
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(block_local_call)),
    "input + 1:i32",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const pair_type = struct {
  .first= Int
}

const make = x => {
  [.first = x + 1] as pair_type
}

let pair = {
  const made = make(input)
  made
}

pair.first
`),
    "Const binding captures runtime value: input",
  );
});

Deno.test("Source lowers const struct field projection", () => {
  const ic = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

const user = [.age = 41] as user_type

user.age + 1
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });
});

Deno.test("Source lowers dynamic typed struct if by selecting fields", () => {
  const ic = compile(`
const { struct } = comptime (import "duck:prelude")()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let pair = if input {
  [.first = 40, .second = 2] as pair_type
} else {
  [.first = 1, .second = 3] as pair_type
}

pair.first + pair.second
`);
  const text = Format.fmt(Ic, Ic.reduce(ic));

  assert_includes(text, "! input_share2 &share_input_2 = input;");
  assert_includes(text, "if input_share20 then 40:i32 else 1:i32");
  assert_includes(text, "if input_share21 then 2:i32 else 3:i32");

  const nested = compile(`
const { struct } = comptime (import "duck:prelude")()
const name_type = struct {
  .first= Text,
  .last= Text
}

const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= name_type,
  .age= Int
}

let selected = if flag {
  [.name = [.first = message, .last = other] as name_type, .age = 1] as user_type
} else {
  [.name = [.first = other, .last = message] as name_type, .age = 2] as user_type
}

@len(selected.name.first) + selected.age
`);
  const nested_text = Format.fmt(Ic, Ic.reduce(nested));

  assert_includes(nested_text, "load(if");
  assert_includes(nested_text, "then message else other");
  assert_includes(nested_text, "then 1:i32 else 2:i32");

  const call_only_struct_helper = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

let choose = flag => if flag {
  input
} else {
  other
}

let user: user_type = choose(flag)
user.age
`);
  const call_only_struct_helper_text = Format.fmt(
    Ic,
    Ic.reduce(call_only_struct_helper),
  );

  assert_equals(
    call_only_struct_helper_text,
    "if flag then (input)(λfield_age#0. field_age#0) else (other)(λfield_age#1. field_age#1)",
  );

  assert_equals(
    Format.fmt(
      Ic,
      Ic.reduce(compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text
}

let choose = flag => if flag {
  [.name = input] as user_type
} else {
  [.name = other] as user_type
}

@len(choose(flag).name)
`)),
    ),
    "load(if flag then input else other)",
  );

  const call_only_struct_text_get = Format.fmt(
    Ic,
    Ic.reduce(compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text
}

let choose = flag => if flag {
  [.name = input] as user_type
} else {
  [.name = other] as user_type
}

@get(choose(flag).name, index)
`)),
  );
  assert_includes(call_only_struct_text_get, "load8_u");
  assert_includes(call_only_struct_text_get, "if flag");
  assert_includes(call_only_struct_text_get, "input");
  assert_includes(call_only_struct_text_get, "other");
  assert_includes(call_only_struct_text_get, "index");

  const call_only_nested_struct_text = Format.fmt(
    Ic,
    Ic.reduce(compile(`
const { struct } = comptime (import "duck:prelude")()
const name_type = struct {
  .first= Text
}

const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= name_type
}

let choose = flag => if flag {
  [.name = [.first = input] as name_type] as user_type
} else {
  [.name = [.first = other] as name_type] as user_type
}

@len(choose(flag).name.first)
`)),
  );
  assert_equals(
    call_only_nested_struct_text,
    "load(if flag then input else other)",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text
}

let choose = flag => if flag {
  [.name = input] as user_type
} else {
  other
}

@len(choose(flag).name)
`),
    "Cannot lower dynamic if with struct branches to Ic frontend",
  );

  const union_payload_struct_age = Format.fmt(
    Ic,
    Ic.reduce(compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

type OptionType = | .some = user_type | .none
const option_type = OptionType

let choose = flag => if flag {
  option_type.some([.age = a] as user_type)
} else {
  option_type.none()
}

(if let .some(user) = choose(flag) {
  user
} else {
  [.age = b] as user_type
}).age
`)),
  );
  assert_includes(union_payload_struct_age, "if flag");
  assert_includes(union_payload_struct_age, "a");
  assert_includes(union_payload_struct_age, "b");
  assert_includes(union_payload_struct_age, "field_age");

  if (union_payload_struct_age.includes("choose#")) {
    throw new Error(
      "Expected union payload struct helper to inline before Ic lowering:\n" +
        union_payload_struct_age,
    );
  }

  const union_payload_struct_text_len = Format.fmt(
    Ic,
    Ic.reduce(compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text
}

type OptionType = | .some = user_type | .none
const option_type = OptionType

let choose = flag => if flag {
  option_type.some([.name = input] as user_type)
} else {
  option_type.none()
}

@len((if let .some(user) = choose(flag) {
  user
} else {
  [.name = other] as user_type
}).name)
`)),
  );
  assert_includes(union_payload_struct_text_len, "load(");
  assert_includes(union_payload_struct_text_len, "if flag");
  assert_includes(union_payload_struct_text_len, "input");
  assert_includes(union_payload_struct_text_len, "other");
  assert_includes(union_payload_struct_text_len, "field_name");

  const union_payload_struct_text_get = Format.fmt(
    Ic,
    Ic.reduce(compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text
}

type OptionType = | .some = user_type | .none
const option_type = OptionType

let choose = flag => if flag {
  option_type.some([.name = input] as user_type)
} else {
  option_type.none()
}

@get((if let .some(user) = choose(flag) {
  user
} else {
  [.name = other] as user_type
}).name, index)
`)),
  );
  assert_includes(union_payload_struct_text_get, "load8_u");
  assert_includes(union_payload_struct_text_get, "field_name");
  assert_includes(union_payload_struct_text_get, "index");

  const union_payload_struct_text_index = Format.fmt(
    Ic,
    Ic.reduce(compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text
}

type OptionType = | .some = user_type | .none
const option_type = OptionType

let choose = flag => if flag {
  option_type.some([.name = input] as user_type)
} else {
  option_type.none()
}

(if let .some(user) = choose(flag) {
  user
} else {
  [.name = other] as user_type
}).name[index]
`)),
  );
  assert_includes(union_payload_struct_text_index, "load8_u");
  assert_includes(union_payload_struct_text_index, "field_name");
  assert_includes(union_payload_struct_text_index, "index");

  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text
}

type OptionType = | .some = user_type | .none
const option_type = OptionType

let choose = flag => if flag {
  option_type.some([.name = input] as user_type)
} else {
  option_type.none()
}

@len((if let .some(user) = choose(flag) {
  1
} else {
  [.name = other] as user_type
}).name)
`),
    "len requires a compile-time collection value",
  );

  const nested_if_let = compile(`
const { struct } = comptime (import "duck:prelude")()
const name_type = struct {
  .first= Text,
  .last= Text
}

const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= name_type,
  .age= Int
}

type ResultType = | .ok = Text | .err = Int
const result_type = ResultType

let result: result_type = input

let selected = if let .ok(payload) = result {
  [.name = [.first = payload, .last = other] as name_type, .age = 1] as user_type
} else {
  [.name = [.first = other, .last = message] as name_type, .age = 2] as user_type
}

@len(selected.name.first) + selected.age
`);
  const nested_if_let_text = Format.fmt(Ic, Ic.reduce(nested_if_let));

  assert_includes(nested_if_let_text, "load(");
  assert_includes(nested_if_let_text, "λpayload_ok");
  assert_includes(nested_if_let_text, "payload_ok");
  assert_includes(nested_if_let_text, "λpayload_ok#0. 1:i32");
  assert_includes(nested_if_let_text, "λpayload_err#0. 2:i32");
});

Deno.test("Source rejects missing struct fields", () => {
  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

let user: user_type = [.age = 41]

user.name
`),
    "Missing struct field: name",
  );
});

Deno.test("Source lowers struct and object values to Ic handlers", () => {
  const ic = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}

[.name = "Ada", .age = 41] as user_type
`);

  const text = Format.fmt(Ic, Ic.reduce(ic));
  assert_includes(text, "λpick#");
  assert_includes(text, '"Ada"');
  assert_includes(text, "41:i32");

  const rebound = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}

let user = [.name = "Ada", .age = 41] as user_type

user
`);

  const rebound_text = Format.fmt(Ic, Ic.reduce(rebound));
  assert_includes(rebound_text, "λpick#");
  assert_includes(rebound_text, '"Ada"');
  assert_includes(rebound_text, "41:i32");

  const object = compile("[.age = 41]");
  const object_text = Format.fmt(Ic, Ic.reduce(object));
  assert_includes(object_text, "λpick#");
  assert_includes(object_text, "41:i32");

  const object_function_field = compile(`
let box = [.run = x => x + 1]

box.run(41)
`);

  assert_equals(Ic.reduce(object_function_field), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const rebound_object = compile(`
let user = [.name = "Ada", .age = 41]

user
`);
  const rebound_object_text = Format.fmt(Ic, Ic.reduce(rebound_object));
  assert_includes(rebound_object_text, "λpick#");
  assert_includes(rebound_object_text, '"Ada"');
  assert_includes(rebound_object_text, "41:i32");

  const updated_object = compile(`
let user = [.age = 40]

user = user with {
  .age = user.age + 1
}
user
`);
  const updated_object_text = Format.fmt(Ic, Ic.reduce(updated_object));
  assert_includes(updated_object_text, "λpick#");
  assert_includes(updated_object_text, "41:i32");

  const dynamic_object = compile(`
let user = if input {
  [.name = "Ada", .age = 41]
} else {
  [.name = "Grace", .age = 32]
}

user.age + @len(user.name)
`);
  const dynamic_object_text = Format.fmt(Ic, Ic.reduce(dynamic_object));

  assert_includes(
    dynamic_object_text,
    "! input_share",
  );
  assert_includes(
    dynamic_object_text,
    "then 41:i32 else 32:i32",
  );
  assert_includes(
    dynamic_object_text,
    "then 3:i32 else 5:i32",
  );

  const dynamic_object_name = compile(`
let user = if input {
  [.name = "Ada", .age = 41]
} else {
  [.name = "Grace", .age = 32]
}

user.name
`);
  const dynamic_object_name_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_object_name),
  );

  assert_includes(
    dynamic_object_name_text,
    'if input then "Ada" else "Grace"',
  );

  const const_call_dynamic_object = compile(`
const make_user = flag => {
  if flag {
    [.name = "Ada", .age = 41]
  } else {
    [.name = "Grace", .age = 32]
  }
}

let user = make_user(input)

user.age + @len(user.name)
`);
  const const_call_dynamic_object_text = Format.fmt(
    Ic,
    Ic.reduce(const_call_dynamic_object),
  );

  assert_includes(
    const_call_dynamic_object_text,
    "then 41:i32 else 32:i32",
  );
  assert_includes(
    const_call_dynamic_object_text,
    "then 3:i32 else 5:i32",
  );

  assert_throws(
    () =>
      compile(`
if input {
  [.age = 41]
} else {
  [.name = "Ada"]
}
`),
    "If branches must have the same type",
  );
});

Deno.test("Source validates declared struct construction", () => {
  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .name= Text
}

let user: user_type = [.age = 41]

user.age
`),
    "Missing struct field: name",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

let user: user_type = [.age = 41, .name = "Ada"]

user.age
`),
    "Unknown struct field: name",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

let user: user_type = [.age = 41, .age = 42]

user.age
`),
    "Duplicate struct field: age",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

let user: user_type = [.age = "old"]

user.age
`),
    "Struct field age expects Int, got Text",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const wide_type = struct {
  .value= I64
}

let wide: wide_type = [.value = 41]

wide.value
`),
    "Struct field value expects I64, got I32",
  );
});

Deno.test("Source lowers pure struct updates by rebuilding values", () => {
  const ic = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .bonus= Int
}

let user = [.age = 41, .bonus = 5] as user_type

let updated = user with {
  .age = user.age + 1
}

user.age + updated.age
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 83 });

  const direct = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .bonus= Int
}

let user = [.age = 41, .bonus = 5] as user_type

user with {
  .age = user.age + 1
}
`);
  const direct_text = Format.fmt(Ic, Ic.reduce(direct));

  assert_includes(direct_text, "λpick#");
  assert_includes(direct_text, "42:i32");

  const closure_update = compile(`
let birthday = user => {
  user with {
    .age = user.age + 1
  }
}

birthday([.name = "Ada", .age = 41]).age
`);

  assert_equals(Ic.reduce(closure_update), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const closure_text_update = compile(`
let rename = user => {
  user with {
    .name = "Grace"
  }
}

@len(rename([.name = "Ada", .age = 41]).name)
`);

  assert_equals(Ic.reduce(closure_text_update), {
    tag: "num",
    type: "i32",
    value: 5,
  });
});

Deno.test("Source lowers assignment struct updates without mutating prior reads", () => {
  const ic = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .bonus= Int
}

let user = [.age = 41, .bonus = 5] as user_type

let old_age = user.age
user = user with {
  .age = user.age + 1
}

old_age + user.age
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 83 });
});

Deno.test("Source rejects invalid struct updates", () => {
  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

let user = [.age = 41] as user_type

user = user with {
  .name = 1
}

user.age
`),
    "Missing struct field: name",
  );
});

Deno.test("Source lowers known union if let expressions", () => {
  const ic = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let input = 41
let result = .ok(input)
input = 0

if let .ok(value) = result {
  value + 1
} else {
  0
}
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  const const_payload = compile(`
const payload = 41
const result = .ok(payload)
const payload = 0

if let .ok(value) = result {
  value + 1
} else {
  0
}
`);

  assert_equals(Ic.reduce(const_payload), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const const_block_payload = compile(`
const result = {
  let payload = 41
  .ok(payload)
}

if let .ok(value) = result {
  value + 1
} else {
  0
}
`);

  assert_equals(Ic.reduce(const_block_payload), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const runtime_payload = compile(`
let result = .ok(input)

if let .ok(value) = result {
  value + 1
} else {
  0
}
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(runtime_payload)),
    "input + 1:i32",
  );

  const field_payload = compile(`
let input = 41
let box = [.result = .ok(input)]
input = 0

if let .ok(value) = box.result {
  value + 1
} else {
  0
}
`);

  assert_equals(Ic.reduce(field_payload), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const indexed_payload = compile(`
let input = 41
let box = [.first = .ok(input), .second = .err(0)]
input = 0

if let .ok(value) = box[0] {
  value + 1
} else {
  0
}
`);

  assert_equals(Ic.reduce(indexed_payload), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const block_payload = compile(`
if let .ok(value) = {
  let input = 41
  .ok(input)
} {
  value + 1
} else {
  0
}
`);

  assert_equals(Ic.reduce(block_payload), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const block_shadowed_payload = compile(`
if let .ok(value) = {
  let input = 40
  input = input + 1
  .ok(input)
} {
  value + 1
} else {
  0
}
`);

  assert_equals(Ic.reduce(block_shadowed_payload), {
    tag: "num",
    type: "i32",
    value: 42,
  });
});

Deno.test("Source validates typed union constructors", () => {
  const ic = compile(`
type ResultType = | .ok = Int | .err = Text | .none
const result_type = ResultType

let result = result_type.ok(41)

if let .ok(value) = result {
  value + 1
} else {
  0
}
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  const const_constructor_payload = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

const payload = 41
const result = result_type.ok(payload)
const payload = 0

if let .ok(value) = result {
  value + 1
} else {
  0
}
`);

  assert_equals(Ic.reduce(const_constructor_payload), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const unit_ic = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let option = option_type.none()

if let .none = option {
  42
} else {
  0
}
`);

  assert_equals(Ic.reduce(unit_ic), { tag: "num", type: "i32", value: 42 });

  const unit_field_ic = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let option = option_type.none

if let .none = option {
  42
} else {
  0
}
`);

  assert_equals(Ic.reduce(unit_field_ic), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const dynamic_unit_field_ic = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let option = if input {
  option_type.some(1)
} else {
  option_type.none
}

if let .some(value) = option {
  value
} else {
  0
}
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(dynamic_unit_field_ic)),
    "if input then 1:i32 else 0:i32",
  );

  assert_throws(
    () =>
      compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

option_type.some
`),
    "Union case some expects 1 payload",
  );

  const annotated = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let result: result_type = .ok(41)
result
`);
  const annotated_text = Format.fmt(Ic, Ic.reduce(annotated));

  assert_includes(annotated_text, "λcase_ok#");
  assert_includes(annotated_text, "41:i32");

  const annotated_struct_payload = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}

type ResultType = | .ok = user_type | .err = user_type
const result_type = ResultType

let result: result_type = .ok([.age = 40, .score = 2])

if let .ok(user) = result {
  user.age + user.score
} else {
  0
}
`);

  assert_equals(Ic.reduce(annotated_struct_payload), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}

type ResultType = | .ok = user_type | .err = user_type
const result_type = ResultType

let result: result_type = .ok([.age = 40])

result
`),
    "Missing struct field: score",
  );

  const annotated_param = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let keep = (result: result_type) => {
  result
}

keep(.ok(41))
`);
  const annotated_param_text = Format.fmt(Ic, Ic.reduce(annotated_param));

  assert_includes(annotated_param_text, "λcase_ok#");
  assert_includes(annotated_param_text, "41:i32");

  assert_throws(
    () =>
      compile(`
type ResultType = | .ok = Int
const result_type = ResultType

let result = result_type.err("bad")
result
`),
    "Missing union case: err",
  );

  assert_throws(
    () =>
      compile(`
type ResultType = | .ok = Int
const result_type = ResultType

let result = result_type.ok("bad")
result
`),
    "Union case ok expects Int, got Text",
  );

  assert_throws(
    () =>
      compile(`
type ResultType = | .ok = I64
const result_type = ResultType

let result = result_type.ok(41)
result
`),
    "Union case ok expects I64, got I32",
  );

  assert_throws(
    () =>
      compile(`
type OptionType = | .none
const option_type = OptionType

let option = option_type.none(1)
option
`),
    "Union case none expects no payload",
  );
});

Deno.test("Source specializes generic struct and union type constructors", () => {
  const union_ic = compile(`
type ResultType e t = | .ok = t | .err = e
const result_type = ResultType

const int_result = result_type(Text)(Int)
let result = int_result.ok(41)

if let .ok(value) = result {
  value + @size_of(int_result)
} else {
  0
}
`);

  assert_equals(Ic.reduce(union_ic), { tag: "num", type: "i32", value: 53 });

  const struct_ic = compile(`
const { struct } = comptime (import "duck:prelude")()
const pair_type = a => b => struct {
  .first= a,
  .second= b
}

const user_pair_type = pair_type(Text)(Int)

let pair: user_pair_type = ["Ada", 30]

pair.second + @size_of(user_pair_type)
`);

  assert_equals(Ic.reduce(struct_ic), { tag: "num", type: "i32", value: 42 });

  const const_block_struct_type = compile(`
const user_type = {
  const { struct } = comptime (import "duck:prelude")()
  const value = struct {
    .age= Int
  }

  value
}

let user: user_type = [41]

user.age + 1
`);

  assert_equals(Ic.reduce(const_block_struct_type), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const const_block_union_type = compile(`
type BlockResult = | .ok = Int | .err = Int
const result_type = {
  const value = BlockResult

  value
}

let result = result_type.ok(41)

if let .ok(value) = result {
  value + 1
} else {
  0
}
`);

  assert_equals(Ic.reduce(const_block_union_type), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_type_alias = compile(`
const my_int = Int
const alias = my_int
const my_int = I64

const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= alias
}

type OptionType = | .some = alias | .none
const option_type = OptionType

@size_of(user_type) + @size_of(option_type)
`);

  assert_equals(Ic.reduce(captured_type_alias), {
    tag: "num",
    type: "i32",
    value: 12,
  });

  assert_throws(
    () =>
      compile(`
type ResultType e t = | .ok = t | .err = e
const result_type = ResultType

const int_result = result_type(Text)(Int)
int_result.ok("bad")
`),
    "Union case ok expects Int, got Text",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const pair_type = a => b => struct {
  .first= a,
  .second= b
}

const user_pair_type = pair_type(Text)(Int)

let pair: user_pair_type = [1, 2]

pair.second
`),
    "Struct field first expects Text, got I32",
  );
});

Deno.test("Source lowers non-matching union if let expressions", () => {
  const ic = compile(`
let result = .err(5)

if let .ok(value) = result {
  value
} else {
  42
}
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });
});

Deno.test("Source lowers no-else if let statements with fallthrough", () => {
  const ic = compile(`
let result = .err(42)

if let .ok(value) = result {
  return value
}

if let .err(error) = result {
  return error
}

0
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  const fallthrough = compile(`
let result = .ok(41)
let output = 0

if let .ok(value) = result {
  output = value + 1
}

output
`);

  assert_equals(Ic.reduce(fallthrough), {
    tag: "num",
    type: "i32",
    value: 42,
  });
});

Deno.test("Source lowers typed dynamic if let statements with fallthrough", () => {
  const some = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let value_or_zero = (option: option_type) => {
  let output = 0

  if let .some(value) = option {
    output = value + 1
  }

  output
}

value_or_zero(option_type.some(41))
`);

  assert_equals(Ic.reduce(some), { tag: "num", type: "i32", value: 42 });

  const none = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let value_or_zero = (option: option_type) => {
  let output = 0

  if let .some(value) = option {
    output = value + 1
  }

  output
}

value_or_zero(option_type.none())
`);

  assert_equals(Ic.reduce(none), { tag: "num", type: "i32", value: 0 });
});

Deno.test("Source lowers no-else if and if let expressions with implicit fallback", () => {
  const scalar_if = compile(`
let x = if input {
  42
}

x
`);
  const scalar_if_text = Format.fmt(Ic, Ic.reduce(scalar_if));

  assert_includes(scalar_if_text, "if input then 42:i32 else 0:i32");

  const text_if = compile(`
let x = if input {
  "Ada"
}

x
`);
  const text_if_text = Format.fmt(Ic, Ic.reduce(text_if));

  assert_equals(text_if_text, 'if input then "Ada" else ""');

  const block_final_if = compile(`
let x = {
  if input {
    42
  }
}

x
`);
  const block_final_if_text = Format.fmt(Ic, Ic.reduce(block_final_if));

  assert_includes(block_final_if_text, "if input then 42:i32 else 0:i32");

  const known_some = compile(`
let result = .ok(41)
let value = if let .ok(found) = result {
  found + 1
}

value
`);

  assert_equals(Ic.reduce(known_some), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const known_miss = compile(`
let result = .err(41)
let value = if let .ok(found) = result {
  found + 1
}

value
`);

  assert_equals(Ic.reduce(known_miss), {
    tag: "num",
    type: "i32",
    value: 0,
  });

  const known_text_miss = compile(`
type OptionType = | .some = Text | .none
const option_type = OptionType

let result = option_type.none()
let value = if let .some(found) = result {
  found
}

value
`);

  assert_equals(Ic.reduce(known_text_miss), {
    tag: "text",
    value: "",
  });

  const nested_text_if_let = compile(`
type InnerType = | .some = Text | .none
const inner_type = InnerType

type OuterType = | .ok = inner_type | .err
const outer_type = OuterType

let outer: outer_type = source
let text = if let .ok(inner) = outer {
  if let .some(value) = inner {
    value
  }
}

@len(text)
`);
  const nested_text_if_let_text = Format.fmt(
    Ic,
    Ic.reduce(nested_text_if_let),
  );

  assert_includes(nested_text_if_let_text, "payload_ok");
  assert_includes(nested_text_if_let_text, "payload_some");
  assert_includes(nested_text_if_let_text, 'λpayload_err#0. ""');

  const nested_struct_if_let = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

type InnerType = | .some = user_type | .none
const inner_type = InnerType

type OuterType = | .ok = inner_type | .err
const outer_type = OuterType

let outer: outer_type = source
let user = if let .ok(inner) = outer {
  if let .some(value) = inner {
    value
  }
}

user.age
`);
  const nested_struct_if_let_text = Format.fmt(
    Ic,
    Ic.reduce(nested_struct_if_let),
  );

  assert_includes(nested_struct_if_let_text, "payload_ok");
  assert_includes(nested_struct_if_let_text, "payload_some");
  assert_includes(nested_struct_if_let_text, "field_age");

  const known_wide_miss = compile(`
type ResultType = | .ok = I64 | .err = I64
const result_type = ResultType

let result: result_type = .err(1i64)
let value = if let .ok(found) = result {
  found + 1i64
}

value
`);

  assert_equals(Ic.reduce(known_wide_miss), {
    tag: "num",
    type: "i64",
    value: 0n,
  });

  const dynamic = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let value_or_zero = (result: result_type) => if let .ok(found) = result {
  found + 1
}

let result = result_type.ok(41)
value_or_zero(result)
`);

  assert_equals(Ic.reduce(dynamic), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const dynamic_miss = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let value_or_zero = (result: result_type) => if let .ok(found) = result {
  found + 1
}

value_or_zero(result_type.err(99))
`);

  assert_equals(Ic.reduce(dynamic_miss), {
    tag: "num",
    type: "i32",
    value: 0,
  });

  const dynamic_wide = compile(`
type ResultType = | .ok = I64 | .err = I64
const result_type = ResultType

let result = if input {
  result_type.ok(41i64)
} else {
  result_type.err(7i64)
}

let value = if let .ok(found) = result {
  found + 1i64
}

value
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(dynamic_wide)),
    "if input then 42:i64 else 0:i64",
  );

  const dynamic_text = compile(`
type OptionType = | .some = Text | .none
const option_type = OptionType

let result = if input {
  option_type.some("Ada")
} else {
  option_type.none()
}

let value = if let .some(found) = result {
  found
}

value
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(dynamic_text)),
    'if input then "Ada" else ""',
  );

  const dynamic_struct = compile(`
let value = if input {
  [.age = 1]
}

value.age
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(dynamic_struct)),
    "if input then 1:i32 else 0:i32",
  );

  const dynamic_if_let_struct = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let result = if input {
  result_type.ok(41)
} else {
  result_type.err(0)
}

let value = if let .ok(found) = result {
  [.age = found]
}

value.age
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(dynamic_if_let_struct)),
    "if input then 41:i32 else 0:i32",
  );

  const dynamic_union = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let value = if input {
  option_type.some(7)
}

if let .some(found) = value {
  found
} else {
  0
}
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(dynamic_union)),
    "if input then 7:i32 else 0:i32",
  );
});

Deno.test("Source lowers typed union if let through Ic handlers", () => {
  const ok = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let unwrap = (result: result_type) => {
  if let .ok(value) = result {
    value + 1
  } else {
    0
  }
}

let input = 41
let result = result_type.ok(input)
input = 0

unwrap(result)
`);

  assert_equals(Ic.reduce(ok), { tag: "num", type: "i32", value: 42 });

  const err = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let unwrap = (result: result_type) => {
  if let .ok(value) = result {
    value + 1
  } else {
    0
  }
}

unwrap(result_type.err(99))
`);

  assert_equals(Ic.reduce(err), { tag: "num", type: "i32", value: 0 });

  const call_only_union_helper = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let choose = flag => if flag {
  input
} else {
  other
}

let option: option_type = choose(flag)

if let .some(value) = option {
  value
} else {
  0
}
`);
  const call_only_union_helper_text = Format.fmt(
    Ic,
    Ic.reduce(call_only_union_helper),
  );

  assert_includes(call_only_union_helper_text, "if flag then");
  assert_includes(call_only_union_helper_text, "input");
  assert_includes(call_only_union_helper_text, "other");
  assert_includes(call_only_union_helper_text, "payload_some");

  if (call_only_union_helper_text.includes("choose#")) {
    throw new Error(
      "Expected call-only union helper to inline before Ic lowering:\n" +
        call_only_union_helper_text,
    );
  }

  const typed_object_field = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let input = 41
let result = result_type.ok(input)
input = 0

let user = if let .ok(value) = result {
  [.age = value]
} else {
  [.age = 0]
}

user.age
`);

  assert_equals(Ic.reduce(typed_object_field), {
    tag: "num",
    type: "i32",
    value: 41,
  });

  const dynamic_union = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let result = if input {
  result_type.ok(40)
} else {
  result_type.ok(1)
}

if let .ok(value) = result {
  value + 2
} else {
  0
}
`);
  const dynamic_union_text = Format.fmt(Ic, Ic.reduce(dynamic_union));

  assert_includes(dynamic_union_text, "if input then 40:i32 else 1:i32");
  assert_includes(dynamic_union_text, "+ 2:i32");

  const dynamic_cases = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let result = if input {
  result_type.ok(40)
} else {
  result_type.err(1)
}

if let .ok(value) = result {
  value + 2
} else {
  7
}
`);
  const dynamic_cases_text = Format.fmt(Ic, Ic.reduce(dynamic_cases));

  assert_includes(dynamic_cases_text, "if input then 42:i32 else 7:i32");

  const direct_dynamic_cases = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

if let .ok(value) = if input {
  result_type.ok(40)
} else {
  result_type.err(1)
} {
  value + 2
} else {
  7
}
`);
  const direct_dynamic_cases_text = Format.fmt(
    Ic,
    Ic.reduce(direct_dynamic_cases),
  );

  assert_includes(direct_dynamic_cases_text, "if input then 42:i32 else 7:i32");

  const block_dynamic_cases = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

if let .ok(value) = {
  let result = if input {
    result_type.ok(40)
  } else {
    result_type.err(1)
  }

  result
} {
  value + 2
} else {
  7
}
`);
  const block_dynamic_cases_text = Format.fmt(
    Ic,
    Ic.reduce(block_dynamic_cases),
  );

  assert_includes(block_dynamic_cases_text, "if input then 42:i32 else 7:i32");

  const block_local_union_call = compile(`
type ResultType = | .ok = Int | .err = Text
const result_type = ResultType

const make = x => {
  result_type.ok(x + 1)
}

let result = {
  let made = make(input)
  made
}

if let .ok(value) = result {
  value
} else {
  0
}
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(block_local_union_call)),
    "input + 1:i32",
  );

  assert_throws(
    () =>
      compile(`
type ResultType = | .ok = Int
const result_type = ResultType

const make = x => {
  result_type.ok(x + 1)
}

let result = {
  const made = make(input)
  made
}

if let .ok(value) = result {
  value
} else {
  0
}
`),
    "Const binding captures runtime value: input",
  );

  const direct_dynamic_object_field = compile(`
let user = if let .ok(value) = if input {
  .ok(41)
} else {
  .err(1)
} {
  [.age = value]
} else {
  [.age = 0]
}

user.age
`);
  const direct_dynamic_object_field_text = Format.fmt(
    Ic,
    Ic.reduce(direct_dynamic_object_field),
  );

  assert_includes(
    direct_dynamic_object_field_text,
    "if input then 41:i32 else 0:i32",
  );

  const direct_dynamic_object_value = compile(`
if let .ok(value) = if input {
  .ok(41)
} else {
  .err(1)
} {
  [.age = value]
} else {
  [.age = 0]
}
`);
  const direct_dynamic_object_value_text = Format.fmt(
    Ic,
    Ic.reduce(direct_dynamic_object_value),
  );

  assert_includes(direct_dynamic_object_value_text, "λpick#");
  assert_includes(
    direct_dynamic_object_value_text,
    "if input then 41:i32 else 0:i32",
  );

  const direct_dynamic_struct_value = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

if let .ok(value) = if input {
  result_type.ok(41)
} else {
  result_type.err(1)
} {
  [.age = value] as user_type
} else {
  [.age = 0] as user_type
}
`);
  const direct_dynamic_struct_value_text = Format.fmt(
    Ic,
    Ic.reduce(direct_dynamic_struct_value),
  );

  assert_includes(direct_dynamic_struct_value_text, "λpick#");
  assert_includes(
    direct_dynamic_struct_value_text,
    "if input then 41:i32 else 0:i32",
  );

  const dynamic_struct_payload = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}

type ResultType = | .ok = user_type | .err = user_type
const result_type = ResultType

let result: result_type = if input {
  .ok([.age = 40, .score = 2] as user_type)
} else {
  .err([.age = 5, .score = 1] as user_type)
}

if let .ok(user) = result {
  user.age + user.score
} else {
  0
}
`);
  const dynamic_struct_payload_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_struct_payload),
  );

  assert_includes(
    dynamic_struct_payload_text,
    "if input then 42:i32 else 0:i32",
  );

  const dynamic_shorthand_struct_payload = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}

type ResultType = | .ok = user_type | .err = user_type
const result_type = ResultType

let result: result_type = if input {
  .ok([.age = 40, .score = 2])
} else {
  .err([.age = 5, .score = 1])
}

if let .ok(user) = result {
  user.age + user.score
} else {
  0
}
`);
  const dynamic_shorthand_struct_payload_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_shorthand_struct_payload),
  );

  assert_includes(
    dynamic_shorthand_struct_payload_text,
    "if input then 42:i32 else 0:i32",
  );

  const parameter_shorthand_struct_payload = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}

type ResultType = | .ok = user_type | .err = user_type
const result_type = ResultType

let unwrap = (result: result_type) => {
  if let .ok(user) = result {
    user.age + user.score
  } else {
    0
  }
}

unwrap(.ok([.age = 40, .score = 2]))
`);

  assert_equals(Ic.reduce(parameter_shorthand_struct_payload), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const dynamic_wide = compile(`
type ResultType = | .ok = I64 | .err = I64
const result_type = ResultType

let result = if input {
  result_type.ok(40i64)
} else {
  result_type.err(1i64)
}

if let .ok(value) = result {
  value + 2i64
} else {
  7i64
}
`);
  const dynamic_wide_text = Format.fmt(Ic, Ic.reduce(dynamic_wide));

  assert_includes(dynamic_wide_text, "if input then 42:i64 else 7:i64");

  const dynamic_text_payload_len = compile(`
type ResultType = | .ok = Text | .err = Text
const result_type = ResultType

let result = if input {
  result_type.ok("Ada")
} else {
  result_type.err("Grace")
}

if let .ok(value) = result {
  @len(value)
} else {
  0
}
`);
  const dynamic_text_payload_len_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_text_payload_len),
  );

  assert_includes(
    dynamic_text_payload_len_text,
    'if input then load("Ada") else 0:i32',
  );

  const direct_wide_payload = compile(`
type ResultType = | .ok = I64 | .err = I64
const result_type = ResultType

let result = if input {
  result_type.ok(40i64)
} else {
  result_type.err(1i64)
}

if let .ok(value) = result {
  value
} else {
  7i64
}
`);
  const direct_wide_payload_text = Format.fmt(
    Ic,
    Ic.reduce(direct_wide_payload),
  );

  assert_includes(direct_wide_payload_text, "if input then 40:i64 else 7:i64");

  const dynamic_text_result = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let result = if input {
  result_type.ok(40)
} else {
  result_type.err(1)
}

if let .ok(value) = result {
  "found"
} else {
  "missing"
}
`);
  const dynamic_text_result_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_text_result),
  );

  assert_includes(
    dynamic_text_result_text,
    'if input then "found" else "missing"',
  );

  const untyped_block_dynamic_cases = compile(`
if let .ok(value) = {
  let result = if input {
    .ok(40)
  } else {
    .err(1)
  }

  result
} {
  value + 2
} else {
  7
}
`);
  const untyped_block_dynamic_cases_text = Format.fmt(
    Ic,
    Ic.reduce(untyped_block_dynamic_cases),
  );

  assert_includes(
    untyped_block_dynamic_cases_text,
    "if input then 42:i32 else 7:i32",
  );

  const untyped_dynamic_cases = compile(`
if let .ok(value) = if input {
  .ok(40)
} else {
  .err(1)
} {
  value + 2
} else {
  7
}
`);
  const untyped_dynamic_cases_text = Format.fmt(
    Ic,
    Ic.reduce(untyped_dynamic_cases),
  );

  assert_includes(
    untyped_dynamic_cases_text,
    "if input then 42:i32 else 7:i32",
  );

  const bound_untyped_dynamic_cases = compile(`
let result = if input {
  .ok(40)
} else {
  .err(1)
}

if let .ok(value) = result {
  value + 2
} else {
  7
}
`);
  const bound_untyped_dynamic_cases_text = Format.fmt(
    Ic,
    Ic.reduce(bound_untyped_dynamic_cases),
  );

  assert_includes(
    bound_untyped_dynamic_cases_text,
    "if input then 42:i32 else 7:i32",
  );

  const const_call_dynamic_cases = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

const make_result = flag => {
  if flag {
    result_type.ok(40)
  } else {
    result_type.err(1)
  }
}

let result = make_result(input)

if let .ok(value) = result {
  value + 2
} else {
  7
}
`);
  const const_call_dynamic_cases_text = Format.fmt(
    Ic,
    Ic.reduce(const_call_dynamic_cases),
  );

  assert_includes(
    const_call_dynamic_cases_text,
    "if input then 42:i32 else 7:i32",
  );

  const direct_const_call_dynamic_cases = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

const make_result = flag => {
  if flag {
    result_type.ok(40)
  } else {
    result_type.err(1)
  }
}

if let .ok(value) = make_result(input) {
  value + 2
} else {
  7
}
`);
  const direct_const_call_dynamic_cases_text = Format.fmt(
    Ic,
    Ic.reduce(direct_const_call_dynamic_cases),
  );

  assert_includes(
    direct_const_call_dynamic_cases_text,
    "if input then 42:i32 else 7:i32",
  );

  const runtime_closure_dynamic_cases = compile(`
let choose = flag => {
  if flag {
    .ok(input + 1)
  } else {
    .err(1)
  }
}

let result = choose(input)

if let .ok(value) = result {
  value + 2
} else {
  7
}
`);
  const runtime_closure_dynamic_cases_text = Format.fmt(
    Ic,
    Ic.reduce(runtime_closure_dynamic_cases),
  );

  assert_includes(runtime_closure_dynamic_cases_text, "then");
  assert_includes(runtime_closure_dynamic_cases_text, "+ 1:i32 + 2:i32");
  assert_includes(runtime_closure_dynamic_cases_text, "else 7:i32");

  const direct_runtime_closure_dynamic_cases = compile(`
let choose = flag => {
  if flag {
    .ok(40)
  } else {
    .err(1)
  }
}

if let .ok(value) = choose(input) {
  value + 2
} else {
  7
}
`);
  const direct_runtime_closure_dynamic_cases_text = Format.fmt(
    Ic,
    Ic.reduce(direct_runtime_closure_dynamic_cases),
  );

  assert_includes(
    direct_runtime_closure_dynamic_cases_text,
    "if input then 42:i32 else 7:i32",
  );

  const untyped_dynamic_text_result = compile(`
if let .ok(value) = if input {
  .ok(40)
} else {
  .err(1)
} {
  "found"
} else {
  "missing"
}
`);
  const untyped_dynamic_text_result_text = Format.fmt(
    Ic,
    Ic.reduce(untyped_dynamic_text_result),
  );

  assert_includes(
    untyped_dynamic_text_result_text,
    'if input then "found" else "missing"',
  );

  const dynamic_if_let_union_result = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

type OptionType = | .some = Int | .none
const option_type = OptionType

if let .ok(value) = if input {
  result_type.ok(40)
} else {
  result_type.err(1)
} {
  option_type.some(value)
} else {
  option_type.none()
}
`);
  const dynamic_if_let_union_result_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_if_let_union_result),
  );

  assert_includes(dynamic_if_let_union_result_text, "λcase_some#");
  assert_includes(dynamic_if_let_union_result_text, "λcase_none#");
  assert_includes(
    dynamic_if_let_union_result_text,
    "if input then (case_some#",
  );
  assert_includes(dynamic_if_let_union_result_text, "else (case_none#");

  const dynamic_if_let_union_result_apply = compile(`
let option = if let .ok(value) = if input {
  .ok(payload)
} else {
  .err(other)
} {
  .some(value)
} else {
  .none
}

option(value => value + 1, none_value => 0)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(dynamic_if_let_union_result_apply)),
    "if input then payload + 1:i32 else 0:i32",
  );

  const const_call_dynamic_if_let_union_result = compile(`
const make_result = (flag, ok_payload, err_payload) => {
  if flag {
    .ok(ok_payload)
  } else {
    .err(err_payload)
  }
}

let option = if let .ok(value) = make_result(input, payload, other) {
  .some(value)
} else {
  .none
}

option(value => value + 1, none_value => 0)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(const_call_dynamic_if_let_union_result)),
    "if input then payload + 1:i32 else 0:i32",
  );

  const runtime_closure_dynamic_if_let_union_result = compile(`
let make_result = flag => {
  if flag {
    .ok(payload)
  } else {
    .err(other)
  }
}

let option = if let .ok(value) = make_result(input) {
  .some(value)
} else {
  .none
}

option(value => value + 1, none_value => 0)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(runtime_closure_dynamic_if_let_union_result)),
    "if input then payload + 1:i32 else 0:i32",
  );

  const dynamic_if_let_union_result_identity_branch_calls = compile(`
let id = value => value

let option = if let .ok(found) = if flag {
  id(.ok(input))
} else {
  id(.err(other))
} {
  .some(found)
} else {
  .none
}

option(value => value + 1, none_value => 0)
`);

  assert_equals(
    Format.fmt(
      Ic,
      Ic.reduce(dynamic_if_let_union_result_identity_branch_calls),
    ),
    "if flag then input + 1:i32 else 0:i32",
  );

  const dynamic_if_let_union_result_constructor_branch_calls = compile(`
let ok = value => .ok(value)
let err = value => .err(value)

let option = if let .ok(found) = if flag {
  ok(input)
} else {
  err(other)
} {
  .some(found)
} else {
  .none
}

option(value => value + 1, none_value => 0)
`);

  assert_equals(
    Format.fmt(
      Ic,
      Ic.reduce(dynamic_if_let_union_result_constructor_branch_calls),
    ),
    "if flag then input + 1:i32 else 0:i32",
  );

  const untyped_same_case_value = compile(`
let result = if input {
  .ok(40)
} else {
  .ok(1)
}

result
`);
  const untyped_same_case_value_text = Format.fmt(
    Ic,
    Ic.reduce(untyped_same_case_value),
  );

  assert_includes(untyped_same_case_value_text, "λcase_ok#");
  assert_includes(
    untyped_same_case_value_text,
    "if input then 40:i32 else 1:i32",
  );

  const bound_untyped_same_case = compile(`
let result = if input {
  .ok(40)
} else {
  .ok(1)
}

if let .ok(value) = result {
  value + 2
} else {
  7
}
`);
  const bound_untyped_same_case_text = Format.fmt(
    Ic,
    Ic.reduce(bound_untyped_same_case),
  );

  assert_includes(
    bound_untyped_same_case_text,
    "if input then 40:i32 else 1:i32",
  );
  assert_includes(bound_untyped_same_case_text, "+ 2:i32");

  const direct_untyped_same_case = compile(`
if let .ok(value) = if input {
  .ok(40)
} else {
  .ok(1)
} {
  value + 2
} else {
  7
}
`);
  const direct_untyped_same_case_text = Format.fmt(
    Ic,
    Ic.reduce(direct_untyped_same_case),
  );

  assert_includes(
    direct_untyped_same_case_text,
    "if input then 42:i32 else 3:i32",
  );

  const wide_untyped_same_case = compile(`
let result = if input {
  .ok(40i64)
} else {
  .ok(1i64)
}

if let .ok(value) = result {
  value + 2i64
} else {
  7i64
}
`);
  const wide_untyped_same_case_text = Format.fmt(
    Ic,
    Ic.reduce(wide_untyped_same_case),
  );

  assert_includes(
    wide_untyped_same_case_text,
    "if input then 40:i64 else 1:i64",
  );
  assert_includes(wide_untyped_same_case_text, "+ 2:i64");

  const untyped_dynamic_case_value = compile(`
let result = if input {
  .ok(40)
} else {
  .err(1)
}

result
`);
  const untyped_dynamic_case_value_text = Format.fmt(
    Ic,
    Ic.reduce(untyped_dynamic_case_value),
  );

  assert_includes(untyped_dynamic_case_value_text, "λcase_ok#");
  assert_includes(untyped_dynamic_case_value_text, "λcase_err#");
  assert_includes(
    untyped_dynamic_case_value_text,
    "if input then (case_ok#",
  );
  assert_includes(untyped_dynamic_case_value_text, "40:i32");
  assert_includes(untyped_dynamic_case_value_text, "1:i32");

  const direct_untyped_dynamic_case_value = compile(`
if input {
  .ok(40)
} else {
  .err(1)
}
`);
  const direct_untyped_dynamic_case_value_text = Format.fmt(
    Ic,
    Ic.reduce(direct_untyped_dynamic_case_value),
  );

  assert_includes(direct_untyped_dynamic_case_value_text, "λcase_ok#");
  assert_includes(direct_untyped_dynamic_case_value_text, "λcase_err#");
  assert_includes(
    direct_untyped_dynamic_case_value_text,
    "if input then (case_ok#",
  );

  const wide_dynamic_case_apply = compile(`
let result = if input {
  .ok(40i64)
} else {
  .err(1i64)
}

result(value => value, error_value => 7i64)
`);
  const wide_dynamic_case_apply_reduced = Ic.reduce(wide_dynamic_case_apply);

  assert_equals(wide_dynamic_case_apply_reduced, {
    tag: "prim",
    prim: "i64.select",
    args: [
      { tag: "num", type: "i64", value: 40n },
      { tag: "num", type: "i64", value: 7n },
      { tag: "var", name: "input" },
    ],
  });

  assert_throws(
    () =>
      compile(`
if let .ok(value) = if input {
  .ok(40)
} else {
  .ok("bad")
} {
  value
} else {
  0
}
`),
    "Union case ok has inconsistent payload types",
  );

  assert_throws(
    () =>
      compile(`
type ResultType = | .ok = Text | .err = Int
const result_type = ResultType

let result = result_type.ok("bad")

if let .ok(value) = result {
  value + 1
} else {
  0
}
`),
    "Text concatenation requires visible text operands",
  );

  const typed_dynamic_case_value = compile(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

let result = if input {
  result_type.ok(40)
} else {
  result_type.err(1)
}

result
`);
  const typed_dynamic_case_value_text = Format.fmt(
    Ic,
    Ic.reduce(typed_dynamic_case_value),
  );

  assert_includes(typed_dynamic_case_value_text, "λcase_ok#");
  assert_includes(typed_dynamic_case_value_text, "λcase_err#");
  assert_includes(
    typed_dynamic_case_value_text,
    "if input then (case_ok#",
  );
  assert_includes(typed_dynamic_case_value_text, "40:i32");
  assert_includes(typed_dynamic_case_value_text, "1:i32");

  const unit = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let is_none = (option: option_type) => {
  if let .none = option {
    42
  } else {
    0
  }
}

is_none(option_type.none())
`);

  assert_equals(Ic.reduce(unit), { tag: "num", type: "i32", value: 42 });

  assert_throws(
    () =>
      compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let bad = (option: option_type) => {
  if let .none(value) = option {
    value
  } else {
    0
  }
}

bad(option_type.none())
`),
    "Union case has no payload: none",
  );
});

Deno.test("Source rejects untyped dynamic if let expressions", () => {
  const source = `
let result = 1
if let .ok(value) = result {
  value
} else {
  0
}
`;

  assert_includes(
    Format.fmt(Core, Source.core(source)),
    "if let .ok(value) = result",
  );

  assert_throws(
    () => compile(source),
    "Cannot lower dynamic if let without typed union target to Ic frontend",
  );
  assert_throws(
    () => compile(source),
    "use Source.core, Source.mod, or Source.wat",
  );
});

Deno.test("Source lowers dynamic if let through result type context", () => {
  const text_result = compile(`
let result = if flag {
  .ok(input)
} else {
  .err(other)
}

let value: Text = if let .ok(found) = result {
  message
} else {
  other_text
}

@len(value)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(text_result)),
    "load(if flag then message else other_text)",
  );

  const direct_text_result = compile(`
let result = if flag {
  .ok(input)
} else {
  .err(other)
}

@len(if let .ok(found) = result {
  message
} else {
  other_text
})
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(direct_text_result)),
    "load(if flag then message else other_text)",
  );

  const no_else_text_result = compile(`
let result = if flag {
  .ok(input)
} else {
  .err(other)
}

@len(if let .ok(found) = result {
  message
})
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(no_else_text_result)),
    'load(if flag then message else "")',
  );

  const direct_get_result = compile(`
let result = if flag {
  .ok(input)
} else {
  .err(other)
}

@get(if let .ok(found) = result {
  message
} else {
  other_text
}, 0)
`);
  const direct_get_text = Format.fmt(Ic, Ic.reduce(direct_get_result));
  assert_includes(direct_get_text, "load8_u(if flag");
  assert_includes(direct_get_text, "else other_text");

  const direct_index_result = compile(`
let result = if flag {
  .ok(input)
} else {
  .err(other)
}

(if let .ok(found) = result {
  message
} else {
  other_text
})[index]
`);
  const direct_index_text = Format.fmt(Ic, Ic.reduce(direct_index_result));
  assert_includes(direct_index_text, "load8_u(if flag");
  assert_includes(direct_index_text, "+ index");

  const no_else_get_result = compile(`
let result = if flag {
  .ok(input)
} else {
  .err(other)
}

@get(if let .ok(found) = result {
  message
}, 0)
`);
  const no_else_get_text = Format.fmt(Ic, Ic.reduce(no_else_get_result));
  assert_includes(no_else_get_text, "load8_u(if flag");
  assert_includes(no_else_get_text, 'else ""');

  const struct_field_result = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

let result = if flag {
  .ok(input)
} else {
  .err(other)
}

let user: user_type = if let .ok(found) = result {
  [.age = found] as user_type
} else {
  [.age = 0] as user_type
}

user.age + 1
`);

  const struct_field_text = Format.fmt(Ic, Ic.reduce(struct_field_result));
  assert_includes(struct_field_text, "if flag then input else 0:i32");
  assert_includes(struct_field_text, "+ 1:i32");

  const consumed_struct_field_result = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

let result = if flag {
  .ok(input)
} else {
  .err(other)
}

let user = if let .ok(found) = result {
  [.age = found] as user_type
} else {
  [.age = 0] as user_type
}

user.age + 1
`);

  const consumed_struct_field_text = Format.fmt(
    Ic,
    Ic.reduce(consumed_struct_field_result),
  );
  assert_includes(consumed_struct_field_text, "if flag then input else 0:i32");
  assert_includes(consumed_struct_field_text, "+ 1:i32");
});
