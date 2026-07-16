import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Expr } from "../expr.ts";
import { TestSource as Source } from "./test_source.ts";
import { Ic } from "../ic.ts";
import { Emit, Format } from "../trait.ts";

function compile(text: string) {
  return Emit.emit(Source, Source.parse(text));
}

Deno.test("Source specializes calls with const parameters", () => {
  const ic = compile(`
let apply_const = (x, const f) => {
  f(x)
}

const double = x => x * 2

let y = apply_const(21, double)
y
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  const captured_const_arg = compile(`
let apply_const = (x, const f) => {
  f(x)
}

const factor = 1
const inc = x => x + factor
const factor = 100

apply_const(41, inc)
`);

  assert_equals(Ic.reduce(captured_const_arg), {
    tag: "num",
    type: "i32",
    value: 42,
  });
});

Deno.test("Source rejects runtime values passed to const parameters", () => {
  assert_throws(
    () =>
      compile(`
let apply_const = (x, const f) => {
  f(x)
}

let double = x => x * 2
apply_const(21, double)
`),
    "Const parameter f requires compile-time argument: double",
  );
});

Deno.test("Source checks scalar runtime parameter annotations", () => {
  const ic = compile(`
let inc = (x: Int) => {
  x + 1
}

inc(41)
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  const wide = compile(`
let inc = (x: I64) => {
  x + 1i64
}

inc(41i64)
`);

  assert_equals(Ic.reduce(wide), { tag: "num", type: "i64", value: 42n });

  const alias = compile(`
let inc = (x: Int) => {
  x + 1
}

let f = inc
f(41)
`);

  assert_equals(Ic.reduce(alias), { tag: "num", type: "i32", value: 42 });

  const static_branch = compile(`
let inc = if 1 {
  (x: Int) => x + 1
} else {
  (x: Int) => x + 2
}

inc(41)
`);

  assert_equals(Ic.reduce(static_branch), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  assert_throws(
    () =>
      compile(`
let inc = (x: Int) => {
  x + 1
}

inc(41i64)
`),
    "Binding annotation expects Int, got I64",
  );

  const unknown_input = compile(`
let inc = (x: Int) => {
  x + 1
}

inc(input)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(unknown_input)),
    "input + 1:i32",
  );

  const unknown_text = compile(`
let byte_len = (value: Text) => {
  len(value)
}

byte_len(message)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(unknown_text)),
    "load(message)",
  );

  const helper_text = compile(`
const byte_len = value => {
  len(value)
}

let byte_len_text = (value: Text) => {
  byte_len(value)
}

byte_len_text(message)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(helper_text)),
    "load(message)",
  );

  assert_throws(
    () =>
      compile(`
let inc = if 1 {
  (x: Int) => x + 1
} else {
  (x: Int) => x + 2
}

inc("Ada")
`),
    "Binding annotation expects Int, got Text",
  );
});

Deno.test("Source reifies const values for ordinary runtime parameters", () => {
  const ic = compile(`
let apply = (x, f) => {
  f(x)
}

const double = x => x * 2

let y = apply(21, double)
y
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  const annotated = compile(`
let factor = 1

let scale = (x: Int) => {
  x + factor
}

factor = 100
scale(41)
`);

  assert_equals(Ic.reduce(annotated), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const static_branch = compile(`
let factor = 1

let scale = if 1 {
  (x: Int) => x + factor
} else {
  (x: Int) => x + factor + 1
}

factor = 100
scale(41)
`);

  assert_equals(Ic.reduce(static_branch), {
    tag: "num",
    type: "i32",
    value: 42,
  });
});

Deno.test("Source lowers runtime closures with captured values", () => {
  const ic = compile(`
let factor = 2

let scale = x => {
  x * factor
}

scale(21)
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });
});

Deno.test("Source lowers dynamic function branches to Ic lambdas", () => {
  const stored_branch = compile(`
let choose = flag => {
  if flag {
    x => x + 1
  } else {
    x => x + 2
  }
}

let f = choose(input)
f(40)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(stored_branch)),
    "if input then 41:i32 else 42:i32",
  );

  const multi_param = compile(`
let add = if input {
  (x, y) => x + y
} else {
  (x, y) => x - y
}

add(50, 8)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(multi_param)),
    "if input then 58:i32 else 42:i32",
  );

  const wide = compile(`
let choose = if input {
  x => 41i64
} else {
  x => 42i64
}

choose(0)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(wide)),
    "if input then 41:i64 else 42:i64",
  );

  const annotated_wide = compile(`
let factor: I64 = 2i64
let choose = if input {
  (x: I64) => x + factor
} else {
  (x: I64) => x + factor + 1i64
}

choose(40i64)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(annotated_wide)),
    "if input then 42:i64 else 43:i64",
  );

  const direct_wrapped_arg = compile(`
(if flag {
  (x: Int) => x + 1
} else {
  (x: Int) => x - 1
})(&input)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(direct_wrapped_arg)),
    "! x#0_share0 &share_x_0_0 = input;\n" +
      "if flag then x#0_share00 + 1:i32 else x#0_share01 - 1:i32",
  );

  const bound_wrapped_arg = compile(`
let choose = if flag {
  (x: Int) => x + 1
} else {
  (x: Int) => x - 1
}

choose(&input)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(bound_wrapped_arg)),
    "! x#0_share0 &share_x_0_0 = input;\n" +
      "if flag then x#0_share00 + 1:i32 else x#0_share01 - 1:i32",
  );

  const bound_wrapped_wide_arg = compile(`
let choose = if flag {
  (x: I64) => x + 1i64
} else {
  (x: I64) => x - 1i64
}

choose(freeze input)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(bound_wrapped_wide_arg)),
    "! x#0_share0 &share_x_0_0 = input;\n" +
      "if flag then x#0_share00 + 1:i64 else x#0_share01 - 1:i64",
  );

  const bound_wrapped_text_arg = compile(`
let choose = if flag {
  (x: Text) => len(x)
} else {
  (x: Text) => get(x, 0)
}

choose(scratch { input })
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(bound_wrapped_text_arg)),
    "! x#0_share0 &share_x_0_0 = input;\n" +
      "! x#0_share1 &share_x_0_1 = x#0_share01;\n" +
      "if flag then load(x#0_share00) else if 0:i32 < load(x#0_share11) then load8_u(x#0_share10 + 4:i32 + 0:i32) else trap",
  );

  const bound_wrapped_struct_arg = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .name= Text
}

let choose = if flag {
  (user: user_type) => user.age
} else {
  (user: user_type) => len(user.name)
}

choose(&input)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(bound_wrapped_struct_arg)),
    "! user#0_share0 &share_user_0_0 = input;\n" +
      "if flag then (user#0_share00)(λfield_age#0. λfield_name#0. field_age#0) else load((user#0_share01)(λfield_age#0. λfield_name#0. field_name#0))",
  );

  const bound_wrapped_union_arg = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let choose = if flag {
  (option: option_type) => if let .some(value) = option {
    value
  } else {
    0
  }
} else {
  (option: option_type) => 1
}

choose(&input)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(bound_wrapped_union_arg)),
    "if flag then ((input)(λpayload_some#0. payload_some#0))(λpayload_none#0. 0:i32) else 1:i32",
  );

  const branch_wrapped_arg = compile(`
let choose = if flag {
  (x: Int) => x + 1
} else {
  (x: Int) => x - 1
}

choose(if pick {
  (&input)} else {
  other
})
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(branch_wrapped_arg)),
    "! x#0_share0 &share_x_0_0 = if pick then input else other;\n" +
      "if flag then x#0_share00 + 1:i32 else x#0_share01 - 1:i32",
  );

  const text_branch_wrapped_arg = compile(`
let choose = if flag {
  (x: Text) => len(x)
} else {
  (x: Text) => get(x, 0)
}

choose(if pick {
  scratch { input }
} else {
  other
})
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(text_branch_wrapped_arg)),
    "! x#0_share0 &share_x_0_0 = if pick then input else other;\n" +
      "! x#0_share1 &share_x_0_1 = x#0_share01;\n" +
      "if flag then load(x#0_share00) else if 0:i32 < load(x#0_share11) then load8_u(x#0_share10 + 4:i32 + 0:i32) else trap",
  );

  const struct_branch_wrapped_arg = Format.fmt(
    Ic,
    Ic.reduce(compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .name= Text
}

let choose = if flag {
  (user: user_type) => user.age
} else {
  (user: user_type) => len(user.name)
}

choose(if pick {
  (&input)} else {
  other
})
`)),
  );
  assert_includes(struct_branch_wrapped_arg, "if pick");
  assert_includes(struct_branch_wrapped_arg, "field_age");
  assert_includes(struct_branch_wrapped_arg, "field_name");
  assert_includes(struct_branch_wrapped_arg, "if flag then");
  assert_includes(struct_branch_wrapped_arg, "else load");

  const union_branch_wrapped_arg = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let choose = if flag {
  (option: option_type) => if let .some(value) = option {
    value
  } else {
    0
  }
} else {
  (option: option_type) => 1
}

choose(if pick {
  scratch { input }
} else {
  other
})
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(union_branch_wrapped_arg)),
    "if flag then if pick then ((input)(λ_payload_some#01. _payload_some#01))(λ_payload_none#04. 0:i32) else ((other)(λ_payload_some#02. _payload_some#02))(λ_payload_none#05. 0:i32) else 1:i32",
  );

  const frozen_wrapped_union_arg = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let choose = if flag {
  (option: option_type) => if let .some(value) = option {
    value
  } else {
    0
  }
} else {
  (option: option_type) => 1
}

choose(freeze input)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(frozen_wrapped_union_arg)),
    "if flag then ((input)(λpayload_some#0. payload_some#0))(λpayload_none#0. 0:i32) else 1:i32",
  );

  const scratch_wrapped_union_arg = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let choose = if flag {
  (option: option_type) => if let .some(value) = option {
    value
  } else {
    0
  }
} else {
  (option: option_type) => 1
}

choose(scratch { input })
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(scratch_wrapped_union_arg)),
    "if flag then ((input)(λpayload_some#0. payload_some#0))(λpayload_none#0. 0:i32) else 1:i32",
  );

  const text = compile(`
let choose = if input {
  x => "Ada"
} else {
  x => "Grace"
}

choose(0)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(text)),
    'if input then "Ada" else "Grace"',
  );

  const aliases = compile(`
let inc = x => x + 1
let dec = x => x - 1

let choose = if input {
  inc
} else {
  dec
}

choose(41)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(aliases)),
    "if input then 42:i32 else 40:i32",
  );

  const annotated = compile(`
let choose = if input {
  (x: Int) => x + 1
} else {
  (x: Int) => x + 2
}

choose(40)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(annotated)),
    "if input then 41:i32 else 42:i32",
  );

  const one_sided_annotated = compile(`
let choose = if input {
  (x: Int) => x + 1
} else {
  x => x + 2
}

choose(40)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(one_sided_annotated)),
    "if input then 41:i32 else 42:i32",
  );

  const alias_annotated = compile(`
let choose = if input {
  (x: Int) => x + 1
} else {
  (x: I32) => x + 2
}

choose(40)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(alias_annotated)),
    "if input then 41:i32 else 42:i32",
  );

  const one_sided_wide = compile(`
let choose = if input {
  (x: I64) => x + 1i64
} else {
  x => x + 2i64
}

choose(40i64)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(one_sided_wide)),
    "if input then 41:i64 else 42:i64",
  );

  const const_aliases = compile(`
const inc = x => x + 1
const dec = x => x - 1

let choose = if input {
  inc
} else {
  dec
}

choose(41)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(const_aliases)),
    "if input then 42:i32 else 40:i32",
  );

  const captured_aliases = compile(`
let factor = 1
let inc = x => x + factor
factor = 100
let dec = x => x - factor

let choose = if input {
  inc
} else {
  dec
}

choose(41)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(captured_aliases)),
    "if input then 42:i32 else -59:i32",
  );

  const linear_param_branches = compile(`
let choose = if input {
  (!x) => !x
} else {
  (!x) => !x + 1
}

choose(41)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(linear_param_branches)),
    "if input then 41:i32 else 42:i32",
  );

  const annotated_linear_param_branches = compile(`
let choose = if input {
  (!x: Int) => !x
} else {
  (!x: Int) => !x + 1
}

choose(41)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(annotated_linear_param_branches)),
    "if input then 41:i32 else 42:i32",
  );

  assert_throws(
    () =>
      compile(`
let choose = if input {
  (!x) => x
} else {
  (!x) => x + 1
}

choose(41)
`),
    "Linear value x used without explicit consumption",
  );

  assert_throws(
    () =>
      compile(`
let choose = if input {
  (!x) => !x
} else {
  x => x + 1
}

choose(41)
`),
    "Dynamic function branches must have compatible parameters",
  );

  const annotated_aliases = compile(`
let inc = (x: Int) => x + 1
let dec = (x: Int) => x - 1

let choose = if input {
  inc
} else {
  dec
}

choose(41)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(annotated_aliases)),
    "if input then 42:i32 else 40:i32",
  );

  const annotated_text_param = compile(`
let choose = if input {
  (value: Text) => len(value)
} else {
  (value: Text) => len(value) + 1
}

choose(message)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(annotated_text_param)),
    "! value#0_share0 &share_value_0_0 = message;\n" +
      "if input then load(value#0_share00) else load(value#0_share01) + 1:i32",
  );

  const annotated_struct_param = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .name= Text
}

let choose = if input {
  (user: user_type) => user.age + 1
} else {
  (user: user_type) => len(user.name)
}

choose(person)
`);
  const annotated_struct_param_text = Format.fmt(
    Ic,
    Ic.reduce(annotated_struct_param),
  );

  assert_includes(
    annotated_struct_param_text,
    "if input then (user#0_share00)(λfield_age#0. λfield_name#0. field_age#0) + 1:i32",
  );
  assert_includes(
    annotated_struct_param_text,
    "else load((user#0_share01)(λfield_age#0. λfield_name#0. field_name#0))",
  );

  const one_sided_text_param = compile(`
let choose = if input {
  (value: Text) => len(value)
} else {
  value => len(value) + 1
}

choose(message)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(one_sided_text_param)),
    "! value#0_share0 &share_value_0_0 = message;\n" +
      "if input then load(value#0_share00) else load(value#0_share01) + 1:i32",
  );

  const one_sided_struct_param = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .name= Text
}

let choose = if input {
  (user: user_type) => user.age + 1
} else {
  user => len(user.name)
}

choose(person)
`);
  const one_sided_struct_param_text = Format.fmt(
    Ic,
    Ic.reduce(one_sided_struct_param),
  );

  assert_includes(
    one_sided_struct_param_text,
    "if input then (user#0_share00)(λfield_age#0. λfield_name#0. field_age#0) + 1:i32",
  );
  assert_includes(
    one_sided_struct_param_text,
    "else load((user#0_share01)(λfield_age#0. λfield_name#0. field_name#0))",
  );

  const annotated_union_param = compile(`
type OptionType = | .some = Int | .none
const option_type = OptionType

let choose = if input {
  (option: option_type) => if let .some(value) = option {
    value
  } else {
    0
  }
} else {
  (option: option_type) => 1
}

choose(result)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(annotated_union_param)),
    "if input then ((result)(λpayload_some#0. payload_some#0))(λpayload_none#0. 0:i32) else 1:i32",
  );

  assert_throws(
    () =>
      compile(`
let choose = if input {
  (x: Int) => x + 1
} else {
  x => x + 2
}

choose("Ada")
`),
    "Binding annotation expects Int, got Text",
  );

  assert_throws(
    () =>
      compile(`
let choose = if input {
  (value: Int) => value + 1
} else {
  (value: Text) => len(value)
}

choose(message)
`),
    "Dynamic function branches must have compatible parameters",
  );

  assert_throws(
    () =>
      compile(`
let choose = if input {
  x => x + 1
} else {
  (x, y) => x + y
}

choose(1)
`),
    "Dynamic function branches must have compatible parameters",
  );

  const struct_result = compile(`
let choose = if input {
  x => [.first = x, .second = x + 1]
} else {
  x => [.first = x + 2, .second = x + 3]
}

let pair = choose(40)
pair.first + pair.second
`);
  const struct_result_text = Format.fmt(Ic, Ic.reduce(struct_result));

  assert_includes(
    struct_result_text,
    "then 40:i32 else 42:i32",
  );
  assert_includes(
    struct_result_text,
    "then 41:i32 else 43:i32",
  );

  const union_result = compile(`
let choose = if input {
  x => .ok(x)
} else {
  x => .err(x + 1)
}

let result = choose(40)

if let .ok(value) = result {
  value
} else {
  0
}
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(union_result)),
    "if input then 40:i32 else 0:i32",
  );

  const if_let_function_result = compile(`
let result = if flag {
  .ok(input)
} else {
  .err(other)
}

let choose = if let .ok(value) = result {
  x => x + value
} else {
  x => x + 1
}

choose(2)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(if_let_function_result)),
    "if flag then 2:i32 + input else 3:i32",
  );

  const if_let_text_function_result = compile(`
let result = if flag {
  .ok(input)
} else {
  .err(other)
}

let choose = if let .ok(value) = result {
  (x: Text) => len(x) + value
} else {
  (x: Text) => len(x) + 1
}

choose(message)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(if_let_text_function_result)),
    "! x#0_share0 &share_x_0_0 = message;\n" +
      "if flag then load(x#0_share00) + input else load(x#0_share01) + 1:i32",
  );

  assert_throws(
    () =>
      compile(`
let result = if flag {
  .ok(input)
} else {
  .err(other)
}

let choose = if let .ok(value) = result {
  (x: Int) => x + value
} else {
  (x: Text) => len(x) + 1
}

choose(message)
`),
    "Cannot lower dynamic if let function branches with incompatible " +
      "parameter shapes to Ic frontend",
  );
  assert_throws(
    () =>
      compile(`
let result = if flag {
  .ok(input)
} else {
  .err(other)
}

let choose = if let .ok(value) = result {
  (x: Int) => x + value
} else {
  (x: Text) => len(x) + 1
}

choose(message)
`),
    "use Source.core, Source.mod, or Source.wat",
  );
});

Deno.test("Source rejects runtime captures in const bindings", () => {
  assert_throws(
    () =>
      compile(`
let factor = 2
const scale = x => x * factor
scale
`),
    "Const binding captures runtime value: factor",
  );
});

Deno.test("Source rejects runtime values in comptime expressions", () => {
  assert_throws(
    () =>
      compile(`
let input = 41
let value = comptime input + 1
value
`),
    "comptime expression requires compile-time values: input",
  );
});

Deno.test("Source distinguishes fail, panic, and recoverable result_type values", () => {
  assert_throws(
    () =>
      compile(`
let value = comptime fail("expected value with len")
value
`),
    "fail: expected value with len",
  );

  const panic = compile('panic("index out of bounds")');

  assert_equals(Ic.reduce(panic), {
    tag: "prim",
    prim: "i32.trap",
    args: [],
  });
  assert_equals(Emit.emit(Expr, Emit.emit(Ic, panic)), "unreachable");

  const ic = compile(`
let result = .err(42)

if let .ok(value) = result {
  value
} else {
  7
}
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 7 });
});

Deno.test("Source lowers compile-time struct layout facts", () => {
  const ic = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .big= I64
}

const user_layout = layout(user_type)

size_of(user_type) + align_of(user_type) + user_layout.fields.big
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 32 });
});

Deno.test("Source lowers compile-time union layout facts", () => {
  const ic = compile(`
type ResultType = | .ok = Int | .err = I64
const result_type = ResultType

const result_layout = layout(result_type)

size_of(result_type) + align_of(result_type) + result_layout.tag_offset + result_layout.payload_offset
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 28 });
});

Deno.test("Source lowers structural fact helper builtins", () => {
  const ic = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}

type ResultType = | .ok = Int | .err = Text
const result_type = ResultType

size_of(Int) + align_of(Text) + has(user_type.name) + has(user_type.missing) + size_of(fields_of(user_type).age) + align_of(fields_of(user_type).name) + size_of(cases_of(result_type).ok) + align_of(cases_of(result_type).err)
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 25 });
});

Deno.test("Source runs fail from structural fact checkers", () => {
  const ic = compile(`
const has_name = t => {
  if !has(t.name) {
    return fail("expected name")
  }

  t
}

const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text
}

let keep = (const t: has_name, value) => {
  value + size_of(t)
}

keep(user_type, 34)
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 42 });

  assert_throws(
    () =>
      compile(`
const has_name = t => {
  if !has(t.name) {
    return fail("expected name")
  }

  t
}

const { struct } = comptime (import "duck:prelude")()
const age_only_type = struct {
  .age= Int
}

let keep = (const t: has_name, value) => {
  value
}

keep(age_only_type, 1)
`),
    "fail: expected name",
  );
});

Deno.test("Source evaluates const functions with loops and assignments", () => {
  const range_ic = compile(`
const sum_to = n => {
  let total = 0

  for i in 0..n {
    total = total + i
  }

  total
}

sum_to(6)
`);

  assert_equals(Ic.reduce(range_ic), { tag: "num", type: "i32", value: 15 });

  const fields_ic = compile(`
const field_bytes = t => {
  let total = 0

  for index, field_type in fields_of(t) {
    total = total + size_of(field_type)
  }

  total
}

const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int,
  .wide= I64
}

field_bytes(user_type)
`);

  assert_equals(Ic.reduce(fields_ic), { tag: "num", type: "i32", value: 20 });
});

Deno.test("Source rejects missing layout information", () => {
  assert_throws(
    () =>
      compile(`
const { struct } = comptime (import "duck:prelude")()
const bad_type = struct {
  .nested= missing_type
}

size_of(bad_type)
`),
    "Missing layout for type: missing_type",
  );
});

Deno.test("Source enforces semantic casing", () => {
  const ic = compile(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

const user_layout = layout(user_type)

user_layout.size
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 4 });

  assert_throws(
    () => Source.parse("let VALUE = 1\nVALUE"),
    "Parameter must use snake_case: VALUE",
  );

  assert_throws(
    () => Source.parse("let _value = 1\n_value"),
    "Parameter must use snake_case: _value",
  );

  assert_throws(
    () => Source.parse("const _Bad = 1\n_Bad"),
    "Parameter must use snake_case: _Bad",
  );

  assert_throws(
    () => Source.parse("const _value = 1\n_value"),
    "Parameter must use snake_case: _value",
  );

  assert_throws(
    () => Source.parse("const Id = t => t\nId"),
    "Parameter must use snake_case: Id",
  );

  assert_throws(
    () => Source.parse("const !knownToken = 1\n!knownToken"),
    "Parameter must use snake_case: knownToken",
  );

  assert_equals(
    Format.fmt(Source, Source.parse("const id = t => t\nid(Int)")),
    "const id = t => t\nid Int",
  );

  assert_throws(
    () => Source.parse("BadName"),
    "Name must use snake_case: BadName",
  );

  assert_throws(
    () => Source.parse("const id = T => T\nid"),
    "Parameter must use snake_case: T",
  );

  assert_throws(
    () => Source.parse("let value = 1\nBadName = 2"),
    "Runtime binding must use snake_case: BadName",
  );

  assert_throws(
    () => Source.parse("let value = 1\nBadName := 2"),
    "Runtime binding must use snake_case: BadName",
  );

  assert_throws(
    () => Source.parse("let value = [.item = 1]\nBadName[0] = 2"),
    "Runtime binding must use snake_case: BadName",
  );

  assert_throws(
    () => Source.parse("[.BadName = 1]"),
    "Product label must use snake_case: BadName",
  );

  assert_throws(
    () => Source.parse("[._field = 1]"),
    "Product label must use snake_case: _field",
  );

  assert_throws(
    () => Source.parse("const user_type = struct { .BadName= Int }\nuser_type"),
    "Shape member must use snake_case: BadName",
  );

  assert_throws(
    () => Source.parse("let value: BadType = 1\nvalue"),
    "Type annotation must use snake_case: BadType",
  );

  assert_throws(
    () => Source.parse("const value: badType = 1\nvalue"),
    "Type annotation must use snake_case: badType",
  );

  assert_throws(
    () =>
      Source.parse("const user_type = struct { .name= BadType }\nuser_type"),
    "Name must use snake_case: BadType",
  );

  assert_throws(
    () => Source.parse("let struct { .name= BadType, .. } = user_type\n1"),
    "Field type annotation must use snake_case: BadType",
  );

  assert_throws(
    () => Source.parse(".BadName(1)"),
    "Union case must use snake_case: BadName",
  );

  assert_throws(
    () => Source.parse("module App = caps => { { main: 1 } }"),
    "Module must use snake_case: App",
  );

  assert_throws(
    () => Source.parse("module app = Caps => { { main: Caps.value } }"),
    "Parameter must use snake_case: Caps",
  );

  assert_throws(
    () => Source.parse('const BadName = import "./bad"'),
    "Parameter must use snake_case: BadName",
  );

  assert_throws(
    () => Source.parse("let value = [.field = 1]\nvalue.BadName"),
    "Field must use snake_case: BadName",
  );

  assert_throws(
    () => Source.parse("let !Token = 1\n!Token"),
    "Parameter must use snake_case: Token",
  );

  assert_throws(
    () => Source.parse("!Token"),
    "Linear value must use snake_case: Token",
  );

  assert_throws(
    () => Source.parse("let keep = (!Token) => !Token\nkeep"),
    "Parameter must use snake_case: Token",
  );

  assert_throws(
    () => Source.parse("let loop = rec Current => Current\nloop"),
    "Parameter must use snake_case: Current",
  );

  assert_throws(
    () => Source.parse("let apply = (value, const Fn) => Fn(value)\napply"),
    "Const binding must use snake_case: Fn",
  );

  assert_throws(
    () => Source.parse("for Item in { value: 1 } { Item }\n0"),
    "Loop index must use snake_case: Item",
  );

  assert_throws(
    () => Source.parse("for i, Item in { value: 1 } { Item }\n0"),
    "Collection item must use snake_case: Item",
  );

  assert_throws(
    () => Source.parse("let struct { .BadName= Int, .. } = user_type\n1"),
    "Type pattern field must use snake_case: BadName",
  );

  assert_throws(
    () => Source.parse("if let .ok(BadName) = .ok(1) { BadName }\n0"),
    "Union case value must use snake_case: BadName",
  );

  assert_throws(
    () => Source.parse("let value = if let .ok(badName) = .ok(1) { badName }"),
    "Union case value must use snake_case: badName",
  );
});

Deno.test("Source rejects excluded grammar families explicitly", () => {
  const cases = [
    { text: "class user {}", feature: "classes" },
    { text: "trait show {}", feature: "traits" },
    { text: "macro debug {}", feature: "macros" },
    {
      text: "instance show_int = show(Int)",
      feature: "runtime instance search",
    },
    { text: "extends base {}", feature: "inheritance" },
    { text: "where show(Int)", feature: "where clauses" },
  ];

  for (const item of cases) {
    const formatted = Format.fmt(Source, Source.parse(item.text));
    assert_includes(formatted, "<unsupported " + item.feature + ">");
    assert_throws(
      () => compile(item.text),
      "Cannot lower " + item.feature + " to Ic frontend yet" +
        "; use Source.core, Source.mod, or Source.wat for structured " +
        "Core/Wasm lowering",
    );
  }

  assert_includes(
    Format.fmt(Source, Source.parse("let x = 1 where x")),
    "<unsupported where clauses>",
  );

  assert_throws(
    () => Source.parse("let class = 1"),
    "Parameter is reserved for unsupported classes: class",
  );

  assert_throws(
    () => Source.parse("const instance = 1"),
    "Parameter is reserved for unsupported runtime instance search: instance",
  );

  assert_throws(
    () => Source.parse("let f = (macro) => macro\nf"),
    "Parameter is reserved for unsupported macros: macro",
  );
});

Deno.test("Source parses every Task 11 MVP grammar include", () => {
  const cases = [
    { feature: "let", text: "let value = 1\nvalue" },
    { feature: "const", text: "const value = 1\nvalue" },
    { feature: "comptime", text: "comptime 1" },
    {
      feature: "shadowing with = and :=",
      text: 'let value = 1\nvalue = 2\nvalue := "x"\nvalue',
    },
    { feature: "closures", text: "x => x" },
    { feature: "return", text: "{ return 1 }" },
    { feature: "if", text: "if 1 { 2 } else { 3 }" },
    {
      feature: "if let",
      text: "if let .ok(value) = .ok(1) { value } else { 0 }",
    },
    { feature: "rec", text: "let f = rec n => n\nf" },
    { feature: "for", text: "for i in 0..3 { i }\n0" },
    { feature: "break", text: "for i in 0..3 { break }\n0" },
    { feature: "continue", text: "for i in 0..3 { continue }\n0" },
    {
      feature: "linear parameters with !",
      text: "let f = (!io) => !io\nf",
    },
    { feature: "borrow views", text: "&value" },
    { feature: "freeze values", text: "freeze value" },
    { feature: "scratchpads with value results", text: "scratch { 1 }" },
    {
      feature: "struct",
      text: "const user_type = struct { .age= Int }\nuser_type",
    },
    {
      feature: "union",
      text: "type OptionType = | .none | .some = Int\n" +
        "const option_type = OptionType\noption_type",
    },
    { feature: "type-values", text: "Int" },
    {
      feature: "const parameters",
      text: "let apply = (const f, x) => f(x)\napply",
    },
    {
      feature: "with extensions",
      text: "const base = [.x = 1]\n" +
        "const extended = base with { .y = 2 }\nextended",
    },
    {
      feature: "fact checkers",
      text: "let value: has_name = item\nvalue",
    },
    {
      feature: "modules as functions",
      text: "module app = caps => { { .main = 1 } }",
    },
    { feature: "compile-time layout helpers", text: "layout(user_type)" },
    {
      feature: "monomorphization",
      text: "let id = (const t, x: t) => x\nid(Int, 1)",
    },
    { feature: "Wasm codegen", text: "40 + 2" },
  ];

  for (const item of cases) {
    const parsed = Source.parse(item.text);
    const formatted = Format.fmt(Source, parsed);
    assert_equals(typeof item.feature, "string");
    assert_equals(formatted.length > 0, true);
  }
});

Deno.test("Source rejects every Task 11 MVP grammar exclude", () => {
  const cases = [
    {
      feature: "global IO",
      run: () => compile('io.print("x")'),
      error: "Cannot lower method call to Ic frontend yet: print",
    },
    {
      feature: "global typeclass instance search",
      run: () => compile("instance show_int = show(Int)"),
      error: "Cannot lower runtime instance search to Ic frontend yet",
    },
    {
      feature: "runtime structural dispatch",
      run: () => compile("value.map(f)"),
      error: "Cannot lower method call to Ic frontend yet: map",
    },
    {
      feature: "implicit effects",
      run: () => compile('io.print("x")'),
      error: "Cannot lower method call to Ic frontend yet: print",
    },
    {
      feature: "inheritance",
      run: () => compile("extends base {}"),
      error: "Cannot lower inheritance to Ic frontend yet",
    },
    {
      feature: "classes",
      run: () => compile("class user {}"),
      error: "Cannot lower classes to Ic frontend yet",
    },
    {
      feature: "traits",
      run: () => compile("trait show {}"),
      error: "Cannot lower traits to Ic frontend yet",
    },
    {
      feature: "macros as a separate system",
      run: () => compile("macro debug {}"),
      error: "Cannot lower macros to Ic frontend yet",
    },
    {
      feature: "dependent runtime-sized types",
      run: () => Source.core("let value: make_type n = 1\nvalue"),
      error: "Rich type annotation is not lowered yet on value",
    },
    {
      feature: "general first-class linear closure capture",
      run: () => compile('freeze ((!io) => io.print("x"))'),
      error: "Cannot lower linear function to Ic frontend yet",
    },
    {
      feature: "baseline GC fallback for uncertain lifetimes",
      run: () => compile("scratch { input }"),
      error: "Cannot lower scratch result through pure Ic",
    },
    {
      feature: "first-class source-level region objects beyond scratchpads",
      run: () => Source.parse("region { 1 }"),
      error:
        "Runtime products use contextual `[...]` values; updates use `with { ... }`",
    },
    {
      feature: "attached scratch regions that survive scratch reset",
      run: () => compile("scratch { input }"),
      error: "Cannot lower scratch result through pure Ic",
    },
    {
      feature:
        "implicit promotion or managed storage for unsafe scratch returns",
      run: () => compile("scratch { input }"),
      error: "Cannot lower scratch result through pure Ic",
    },
    {
      feature: "collector-decided scratch or temporary cleanup",
      run: () => compile("scratch { input }"),
      error: "Cannot lower scratch result through pure Ic",
    },
  ];

  for (const item of cases) {
    assert_equals(typeof item.feature, "string");
    assert_throws(item.run, item.error);
  }
});
