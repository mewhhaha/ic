import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Core } from "../core.ts";
import { TestSource as Source } from "./test_source.ts";
import { Ic } from "../ic.ts";
import { Emit, Format } from "../trait.ts";

function compile(text: string) {
  return Emit.emit(Source, Source.parse(text));
}

Deno.test("Source lowers pure linear bindings to Ic", () => {
  assert_equals(
    Format.fmt(Source, Source.parse("let !x = 41\n!x")),
    "let !x = 41\n!x",
  );

  assert_equals(
    Format.fmt(Source, Source.parse("const !x = 41\n!x")),
    "const !x = 41\n!x",
  );

  const consumed = compile(`
let !x = 41
!x + 1
`);

  assert_equals(Ic.reduce(consumed), { tag: "num", type: "i32", value: 42 });

  const rebound = compile(`
let !x = 41
x = !x + 1
x
`);

  assert_equals(Ic.reduce(rebound), { tag: "num", type: "i32", value: 42 });

  const moved = compile(`
let !x = 41
let !y = !x + 1
y
`);

  assert_equals(Ic.reduce(moved), { tag: "num", type: "i32", value: 42 });

  const const_consumed = compile(`
const !x = 41
!x + 1
`);

  assert_equals(Ic.reduce(const_consumed), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  assert_throws(
    () =>
      compile(`
let !x = 41
x + 1
`),
    "Linear value x used without explicit consumption",
  );

  assert_throws(
    () =>
      compile(`
let !x = 41
0
`),
    "Linear value x was not consumed",
  );

  assert_throws(
    () => compile("const !x = 1\nx + 1"),
    "Linear value x used without explicit consumption",
  );

  assert_equals(Ic.reduce(compile("const !x = 41\nx")), {
    tag: "num",
    type: "i32",
    value: 41,
  });

  assert_throws(
    () => compile("const !x = 1\n0"),
    "Linear value x was not consumed",
  );

  assert_throws(
    () => compile("!input"),
    "Unbound linear value: input",
  );

  assert_throws(
    () =>
      compile(`
let x = 1
!missing
`),
    "Unbound linear value: missing",
  );

  assert_throws(
    () =>
      compile(`
const bad = {
  let !x = 41
  !x
}
bad
`),
    "Cannot evaluate linear binding at compile time: x",
  );
});

Deno.test("Source lowers pure linear functions to Ic", () => {
  const inc = compile(`
let inc_once = (!x) => {
  !x + 1
}

inc_once(41)
`);

  assert_equals(Ic.reduce(inc), { tag: "num", type: "i32", value: 42 });

  const id = compile(`
let keep = (!x) => {
  x
}

keep(42)
`);

  assert_equals(Ic.reduce(id), { tag: "num", type: "i32", value: 42 });

  const rebound = compile(`
let add_once = (!x) => {
  x = !x + 1
  x
}

add_once(41)
`);

  assert_equals(Ic.reduce(rebound), { tag: "num", type: "i32", value: 42 });

  const branch = compile(`
let add_branch = (!x) => {
  if true {
    x = !x + 1
  }

  x
}

add_branch(41)
`);

  assert_equals(Ic.reduce(branch), { tag: "num", type: "i32", value: 42 });

  const branch_return = compile(`
let add_branch = (!x) => {
  if true {
    return !x + 1
  }

  x
}

add_branch(41)
`);

  assert_equals(Ic.reduce(branch_return), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const specialized = compile(`
let apply_once = (!x, const f) => {
  f(!x)
}

const inc = value => value + 1

apply_once(41, inc)
`);

  assert_equals(Ic.reduce(specialized), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const annotated = compile(`
let inc_once = (!x: Int) => {
  !x + 1
}

inc_once(41)
`);

  assert_equals(Ic.reduce(annotated), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const dynamic_linear_if = compile(`
let main = (!x: Int, flag) => {
  if flag {
    !x
  } else {
    !x
  }
}

main(input, flag)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(dynamic_linear_if)),
    "(! x#0_share0 &share_x_0_0 = input;\n" +
      "λflag#0. if flag#0 then x#0_share00 else x#0_share01)(flag)",
  );

  const dynamic_linear_return = compile(`
let main = (!x: Int, flag) => {
  if flag {
    return !x
  }

  x
}

main(input, flag)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(dynamic_linear_return)),
    "(! x#0_share0 &share_x_0_0 = input;\n" +
      "λflag#0. if flag#0 then x#0_share00 else x#0_share01)(flag)",
  );

  const captured_once = compile(`
let main = (!x) => {
  let consume = () => !x
  consume()
}

main(42)
`);

  assert_equals(Ic.reduce(captured_once), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_expr = compile(`
let main = (!x) => {
  let inc = () => !x + 1
  inc()
}

main(41)
`);

  assert_equals(Ic.reduce(captured_expr), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_param = compile(`
let main = (!x, y) => {
  let add = z => !x + z
  add(y)
}

main(40, 2)
`);

  assert_equals(Ic.reduce(captured_param), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_params = compile(`
let main = (!x) => {
  let add = (a, b) => !x + a + b
  add(1, 1)
}

main(40)
`);

  assert_equals(Ic.reduce(captured_params), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_linear_arg = compile(`
let main = (!x, !y) => {
  let add = z => !x + z
  add(!y)
}

main(40, 2)
`);

  assert_equals(Ic.reduce(captured_linear_arg), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_shadowed_param = compile(`
let main = (!x) => {
  let add = x => x + 1
  add(1)
  !x
}

main(40)
`);

  assert_equals(Ic.reduce(captured_shadowed_param), {
    tag: "num",
    type: "i32",
    value: 40,
  });

  const captured_alias = compile(`
let main = (!x) => {
  let consume = () => !x
  let f = consume
  f()
}

main(42)
`);

  assert_equals(Ic.reduce(captured_alias), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_param_alias = compile(`
let main = (!x, y) => {
  let add = z => !x + z
  let f = add
  f(y)
}

main(40, 2)
`);

  assert_equals(Ic.reduce(captured_param_alias), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_alias_chain = compile(`
let main = (!x) => {
  let consume = () => !x
  let f = consume
  let g = f
  g()
}

main(42)
`);

  assert_equals(Ic.reduce(captured_alias_chain), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_block_alias = compile(`
let main = (!x) => {
  let f = {
    let consume = () => !x
    consume
  }

  f()
}

main(42)
`);

  assert_equals(Ic.reduce(captured_block_alias), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_block_param = compile(`
let main = (!x, y) => {
  let f = {
    let add = z => !x + z
    add
  }

  f(y)
}

main(40, 2)
`);

  assert_equals(Ic.reduce(captured_block_param), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_direct_block_call = compile(`
let main = (!x) => {
  {
    let consume = () => !x
    consume
  }()
}

main(42)
`);

  assert_equals(Ic.reduce(captured_direct_block_call), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_static_if_then = compile(`
let main = (!x) => {
  let f = if true {
    () => !x
  } else {
    () => 0
  }

  f()
}

main(42)
`);

  assert_equals(Ic.reduce(captured_static_if_then), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_static_if_else = compile(`
let main = (!x) => {
  let f = if false {
    () => 0
  } else {
    () => !x + 1
  }

  f()
}

main(41)
`);

  assert_equals(Ic.reduce(captured_static_if_else), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  assert_throws(
    () =>
      compile(`
let main = (!x) => {
  let consume = () => !x
  consume() + consume()
}

main(41)
`),
    "Linear value x was already consumed",
  );

  assert_throws(
    () =>
      compile(`
let main = (!x) => {
  let consume = () => !x
  let f = consume
  f() + consume()
}

main(42)
`),
    "Linear value x was already consumed",
  );

  assert_throws(
    () =>
      compile(`
let main = (!x) => {
  let add = z => !x + z
  add(1) + add(2)
}

main(40)
`),
    "Linear value x was already consumed",
  );

  assert_throws(
    () =>
      compile(`
let main = (!x) => {
  let recurse = () => recurse()
  recurse()
  !x
}

main(41)
`),
    "Cannot validate recursive linear closure call yet: recurse",
  );

  assert_throws(
    () =>
      compile(`
let main = (!x) => {
  let consume = () => !x
  consume
}

main(41)
`),
    "Linear value x was not consumed",
  );

  const captured_dynamic_if = compile(`
let main = (!x, flag: Bool) => {
  let f = if flag {
    () => !x
  } else {
    () => !x + 1
  }

  f()
}

main(42, true)
`);

  assert_equals(Ic.reduce(captured_dynamic_if), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_dynamic_if_param_names = compile(`
let main = (!x, flag) => {
  let f = if flag {
    a => !x + a
  } else {
    b => !x + b
  }

  f(2)
}

main(40, false)
`);

  assert_equals(Ic.reduce(captured_dynamic_if_param_names), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_dynamic_if_equivalent_param_annotations = compile(`
let main = (!x, flag) => {
  let f = if flag {
    (a: Int) => !x + a
  } else {
    (b: I32) => !x + b
  }

  f(2)
}

main(40, false)
`);

  assert_equals(Ic.reduce(captured_dynamic_if_equivalent_param_annotations), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_dynamic_if_type_alias_param_annotations = compile(`
const { struct } = import "duck:prelude" ()
const user_type = struct { .age= Int }
const user_alias = user_type

let main = (!x, flag) => {
  let f = if flag {
    (a: user_type) => !x + a.age
  } else {
    (b: user_alias) => !x + b.age
  }

  f([.age = 2] as user_type)
}

main(40, false)
`);

  assert_equals(Ic.reduce(captured_dynamic_if_type_alias_param_annotations), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  assert_throws(
    () =>
      compile(`
const { struct } = import "duck:prelude" ()
const user_type = struct { .age= Int }
const { struct } = import "duck:prelude" ()
const other_type = struct { .score= Int }

let main = (!x, flag) => {
  let f = if flag {
    (a: user_type) => !x + a.age
  } else {
    (b: other_type) => !x + b.score
  }

  f([.age = 2] as user_type)
}

main(40, false)
`),
    "Dynamic function branches must have compatible parameters",
  );

  const captured_static_if_let = compile(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let main = (!x) => {
  const result = \`Ok (0)
  let f = if let \`Ok value = result {
    () => !x + value
  } else {
    () => !x + 1
  }

  f()
}

main(42)
`);

  assert_equals(Ic.reduce(captured_static_if_let), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const captured_dynamic_if_let = compile(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let main = (!x: Int, result: result_type) => {
  let f = if let \`Ok value = result {
    () => !x + value
  } else {
    () => !x + 1
  }

  f()
}

main(input, result)
`);

  const captured_dynamic_if_let_text = Format.fmt(
    Ic,
    Ic.reduce(captured_dynamic_if_let),
  );

  assert_includes(
    captured_dynamic_if_let_text,
    "λresult#0. ((result#0)(λpayload_Ok#0.",
  );
  assert_includes(captured_dynamic_if_let_text, " + payload_Ok#0");
  assert_includes(captured_dynamic_if_let_text, " + 1:i32");

  const captured_return_fallthrough = compile(`
let main = (!x: Int, flag) => {
  let consume = () => !x

  if flag {
    return consume()
  }

  consume()
}

main(input, flag)
`);

  assert_equals(
    Format.fmt(Ic, Ic.reduce(captured_return_fallthrough)),
    "(! x#0_share1 &share_x_0_1 = input;\n" +
      "λflag#0. if flag#0 then x#0_share10 else x#0_share11)(flag)",
  );

  assert_throws(
    () =>
      compile(`
let main = (!x, flag) => {
  let f = if flag {
    () => !x
  } else {
    () => 0
  }

  f()
}

main(42, true)
`),
    "Linear branches must consume the same values",
  );

  assert_throws(
    () =>
      compile(`
let main = (!x) => {
  let consume = () => !x
  let f = consume
  f
}

main(42)
`),
    "Linear value x was not consumed",
  );

  assert_throws(
    () =>
      compile(`
let main = (!x) => {
  let add = z => !x + z
  add
}

main(40)
`),
    "Linear value x was not consumed",
  );

  assert_throws(
    () =>
      compile(`
let main = (!x) => {
  let outer = () => {
    let inner = () => !x + 1
    inner()
  }

  x = outer()
  inner()
}

main(41)
`),
    "Linear value x was not consumed",
  );

  assert_throws(
    () =>
      compile(`
let bad = (!x) => {
  if true {
    !x
  }

  x
}

bad(41)
`),
    "Linear loop if fallthrough changes carried values",
  );
});

Deno.test("Source lowers explicit capability functions and reserves method effects", () => {
  const explicit_capability = compile(`
let main = (!io, const caps) => {
  io = caps.bump(!io)
  io
}

const caps = [.bump = value => value + 1]

main(41, caps)
`);

  assert_equals(Ic.reduce(explicit_capability), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const module_capability = compile(`
module logger = caps => {
  [.log = (!io) => {
    io = caps.bump(!io)
    io
  }]
}

const app = logger([.bump = value => value + 1])

app.log(41)
`);

  assert_equals(Ic.reduce(module_capability), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const frontend_known_method = compile(`
let !io = [.bump = self => 42]

io = io.bump()
io
`);

  assert_equals(Ic.reduce(frontend_known_method), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const specialized_frontend_known_method = compile(`
let main = (!io) => {
  io = io.bump()
  io
}

let !io = [.bump = self => 42]

main(!io)
`);

  assert_equals(Ic.reduce(specialized_frontend_known_method), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  assert_throws(
    () =>
      compile(`
let main = (!io) => {
  io = io.print("hello")
  io
}
main
`),
    "Cannot lower linear function to Ic frontend yet",
  );
  assert_throws(
    () =>
      compile(`
let main = (!io) => {
  io = io.print("hello")
  io
}
main
`),
    "use Source.core, Source.mod, or Source.wat",
  );

  assert_throws(
    () =>
      compile(`
let main = (!io) => {
  io.print("hello")
  io.print("world")
}
main
`),
    "Linear value io is consumed but not rebound",
  );

  assert_throws(
    () =>
      compile(`
let main = (!io) => {
  io = io.print("hello")
}
main
`),
    "Linear value io was not consumed",
  );

  assert_throws(
    () =>
      compile(`
let main = (!io, flag) => {
  io = if flag {
    io.print("hello")
  } else {
    io.print("world")
  }
  io
}
main
`),
    "Cannot lower linear function to Ic frontend yet",
  );

  assert_throws(
    () =>
      compile(`
let main = (!io) => {
  let print_once = () => io.print("hello")
  io = print_once()
  io
}
main
`),
    "Cannot lower linear function to Ic frontend yet",
  );

  assert_throws(
    () =>
      compile(`
let main = (!io, flag) => {
  if flag {
    io.print("hello")
  } else {
    0
  }
}
main
`),
    "Linear branches must consume the same values",
  );

  assert_throws(
    () =>
      compile(`
let main = (!io) => {
  if io {
    io
  } else {
    io
  }
}
main
`),
    "Linear value io used without explicit consumption",
  );

  assert_throws(
    () =>
      compile(`
let main = (!io) => {
  for i in 0..2 {
    io = io.print("tick")
  }
  io
}
main
`),
    "Cannot lower linear function to Ic frontend yet",
  );

  assert_throws(
    () =>
      compile(`
let main = (!io) => {
  for i in 0..2 {
    io = io.print("tick")
    continue
  }
  io
}
main
`),
    "Cannot lower linear function to Ic frontend yet",
  );

  assert_throws(
    () =>
      compile(`
let main = (!io) => {
  for i in 0..2 {
    io = io.print("tick")
    break
  }
  io
}
main
`),
    "Cannot lower linear function to Ic frontend yet",
  );

  assert_throws(
    () =>
      compile(`
let main = (!io) => {
  for i in 0..2 {
    io.print("tick")
  }
  io
}
main
`),
    "Linear value io is consumed but not rebound",
  );
});

Deno.test("Source lowers const-bounded range loops by expansion", () => {
  const ic = compile(`
let sum = 0

for i in 0..4 {
  sum = sum + i
}

sum
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 6 });

  const runtime_bound = compile(`
let n = 4
let sum = 0

for i in 0..n {
  sum = sum + i
}

sum
`);

  assert_equals(Ic.reduce(runtime_bound), {
    tag: "num",
    type: "i32",
    value: 6,
  });

  const descending = compile(`
let sum = 0

for i in 3..0 by -1 {
  sum = sum + i
}

sum
`);

  assert_equals(Ic.reduce(descending), { tag: "num", type: "i32", value: 6 });
});

Deno.test("Source lowers static range break and continue", () => {
  const break_ic = compile(`
let sum = 0

for i in 0..4 {
  sum = sum + 1
  break
  sum = sum + 100
}

sum
`);

  assert_equals(Ic.reduce(break_ic), { tag: "num", type: "i32", value: 1 });

  const continue_ic = compile(`
let sum = 0

for i in 0..4 {
  sum = sum + 1
  continue
  sum = sum + 100
}

sum
`);

  assert_equals(Ic.reduce(continue_ic), {
    tag: "num",
    type: "i32",
    value: 4,
  });

  const nested_break_ic = compile(`
let sum = 0

for i in 0..4 {
  sum = sum + 1
  if true {
    break
  }
  sum = sum + 100
}

sum
`);

  assert_equals(Ic.reduce(nested_break_ic), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  const nested_continue_ic = compile(`
let sum = 0

for i in 0..4 {
  sum = sum + 1
  if true {
    continue
  }
  sum = sum + 100
}

sum
`);

  assert_equals(Ic.reduce(nested_continue_ic), {
    tag: "num",
    type: "i32",
    value: 4,
  });

  const index_break_ic = compile(`
let sum = 0

for i in 0..4 {
  sum = sum + 1
  if i == 2 {
    break
  }
}

sum
`);

  assert_equals(Ic.reduce(index_break_ic), {
    tag: "num",
    type: "i32",
    value: 3,
  });

  const if_let_continue_ic = compile(`
let sum = 0

for i in 0..4 {
  sum = sum + 1
  if let \`Some value = \`Some (i) {
    continue
  }
  sum = sum + 100
}

sum
`);

  assert_equals(Ic.reduce(if_let_continue_ic), {
    tag: "num",
    type: "i32",
    value: 4,
  });

  const if_let_payload_break_ic = compile(`
let sum = 0

for i in 0..4 {
  sum = sum + 1
  if let \`Some value = \`Some (i) {
    if value == 2 {
      break
    }
  }
}

sum
`);

  assert_equals(Ic.reduce(if_let_payload_break_ic), {
    tag: "num",
    type: "i32",
    value: 3,
  });

  const if_let_non_match_ic = compile(`
let sum = 0

for i in 0..4 {
  sum = sum + 1
  if let \`None () = \`Some (i) {
    break
  }
  sum = sum + 100
}

sum
`);

  assert_equals(Ic.reduce(if_let_non_match_ic), {
    tag: "num",
    type: "i32",
    value: 404,
  });

  const match_break_ic = compile(`
let sum = 0

for i in 0..4 {
  match i {
    | 2 => { break }
    | _ => { sum = sum + 1 }
  }
}

sum
`);

  assert_equals(Ic.reduce(match_break_ic), {
    tag: "num",
    type: "i32",
    value: 2,
  });

  const match_continue_ic = compile(`
let sum = 0

for i in 0..4 {
  match \`Some (i) {
    | \`Some value => {
      if value == 2 {
        continue
      }
      sum = sum + 1
    }
    | _ => { sum = sum + 100 }
  }
}

sum
`);

  assert_equals(Ic.reduce(match_continue_ic), {
    tag: "num",
    type: "i32",
    value: 3,
  });

  const dynamic_match_break = (flag: number) =>
    compile(`
let main = flag => {
  let sum = 0
  for i in 0..2 {
    match flag {
      | 1 => { break }
      | _ => { sum = sum + 1 }
    }
  }
  sum
}
main(${flag.toString()})
`);

  assert_equals(Ic.reduce(dynamic_match_break(1)), {
    tag: "num",
    type: "i32",
    value: 0,
  });
  assert_equals(Ic.reduce(dynamic_match_break(0)), {
    tag: "num",
    type: "i32",
    value: 2,
  });

  const dynamic_match_continue = (flag: number) =>
    compile(`
let main = flag => {
  let sum = 0
  for i in 0..2 {
    match flag {
      | 1 => { continue }
      | _ => { sum = sum + 1 }
    }
  }
  sum
}
main(${flag.toString()})
`);

  assert_equals(Ic.reduce(dynamic_match_continue(1)), {
    tag: "num",
    type: "i32",
    value: 0,
  });
  assert_equals(Ic.reduce(dynamic_match_continue(0)), {
    tag: "num",
    type: "i32",
    value: 2,
  });

  const nested_match_break_scope_ic = compile(`
let sum = 0

for i in 0..2 {
  for j in 0..3 {
    sum = sum + 1
    match j {
      | 1 => { break }
      | _ => { sum = sum + 0 }
    }
  }
  sum = sum + 10
}

sum
`);

  assert_equals(Ic.reduce(nested_match_break_scope_ic), {
    tag: "num",
    type: "i32",
    value: 24,
  });

  const return_ic = compile(`
let main = flag => {
  for i in 0..4 {
    return 1
    if flag {
      break
    }
  }

  0
}

main(flag)
`);

  assert_equals(Ic.reduce(return_ic), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  const nested_return_ic = compile(`
let main = () => {
  for i in 0..4 {
    if i == 2 {
      return i
    }
  }

  99
}

main()
`);

  assert_equals(Ic.reduce(nested_return_ic), {
    tag: "num",
    type: "i32",
    value: 2,
  });

  const if_let_return_ic = compile(`
let main = () => {
  for i in 0..4 {
    if let \`Some value = \`Some i {
      return value
    }
  }

  99
}

main()
`);

  assert_equals(Ic.reduce(if_let_return_ic), {
    tag: "num",
    type: "i32",
    value: 0,
  });

  const nested_loop_return_ic = compile(`
let main = flag => {
  for i in 0..1 {
    for j in 0..1 {
      return 1
    }

    if flag {
      break
    }
  }

  0
}

main(flag)
`);

  assert_equals(Ic.reduce(nested_loop_return_ic), {
    tag: "num",
    type: "i32",
    value: 1,
  });

  const nested_loop_break_scope_ic = compile(`
let sum = 0

for i in 0..2 {
  for j in 0..4 {
    sum = sum + 1
    break
    sum = sum + 100
  }

  sum = sum + 10
}

sum
`);

  assert_equals(Ic.reduce(nested_loop_break_scope_ic), {
    tag: "num",
    type: "i32",
    value: 22,
  });

  const nested_loop_continue_scope_ic = compile(`
let sum = 0

for i in 0..2 {
  for j in 0..2 {
    sum = sum + 1
    continue
    sum = sum + 100
  }

  sum = sum + 10
}

sum
`);

  assert_equals(Ic.reduce(nested_loop_continue_scope_ic), {
    tag: "num",
    type: "i32",
    value: 24,
  });

  const linear_break_ic = compile(`
let main = (!x) => {
  for i in 0..4 {
    x = !x + 1
    break
  }

  x
}

main(41)
`);

  assert_equals(Ic.reduce(linear_break_ic), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const linear_continue_ic = compile(`
let main = (!x) => {
  for i in 0..2 {
    x = !x + 1
    continue
  }

  x
}

main(40)
`);

  assert_equals(Ic.reduce(linear_continue_ic), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  assert_throws(
    () =>
      compile(`
let main = (!x) => {
  for i in 0..2 {
    !x
    continue
  }

  x
}

main(40)
`),
    "Linear value x is consumed but not rebound",
  );

  const dynamic_break_ic = compile(`
let main = flag => {
  let total = 0

  for i in 0..3 {
    total = total + 1
    if flag {
      break
    }
    total = total + 10
  }

  total
}

main(flag)
`);
  const dynamic_break_text = Format.fmt(Ic, Ic.reduce(dynamic_break_ic));

  assert_includes(dynamic_break_text, "then 1:i32");
  assert_includes(dynamic_break_text, "else 33:i32");

  const dynamic_continue_ic = compile(`
let main = flag => {
  let total = 0

  for i in 0..3 {
    total = total + 1
    if flag {
      continue
    }
    total = total + 10
  }

  total
}

main(flag)
`);
  const dynamic_continue_text = Format.fmt(Ic, Ic.reduce(dynamic_continue_ic));

  assert_includes(dynamic_continue_text, "then 3:i32");
  assert_includes(dynamic_continue_text, "else 33:i32");

  const dynamic_break_after_binding_ic = compile(`
let main = flag => {
  let total = 0

  for i in 0..2 {
    if flag {
      let next = total + 1
      total = next
      break
    }
  }

  total
}

main(flag)
`);
  const dynamic_break_after_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_break_after_binding_ic),
  );

  assert_includes(dynamic_break_after_binding_text, "then 1:i32");
  assert_includes(dynamic_break_after_binding_text, "else 0:i32");

  const dynamic_break_after_top_level_binding_ic = compile(`
let main = flag => {
  let total = 0

  for i in 0..3 {
    let next = total + 1
    total = next
    if flag {
      break
    }
    total = total + 10
  }

  total
}

main(flag)
`);
  const dynamic_break_after_top_level_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_break_after_top_level_binding_ic),
  );

  assert_includes(dynamic_break_after_top_level_binding_text, "then 1:i32");
  assert_includes(dynamic_break_after_top_level_binding_text, "else 33:i32");

  const dynamic_continue_after_top_level_binding_ic = compile(`
let main = flag => {
  let total = 0

  for i in 0..3 {
    let next = total + 1
    total = next
    if flag {
      continue
    }
    total = total + 10
  }

  total
}

main(flag)
`);
  const dynamic_continue_after_top_level_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_continue_after_top_level_binding_ic),
  );

  assert_includes(
    dynamic_continue_after_top_level_binding_text,
    "then 3:i32",
  );
  assert_includes(
    dynamic_continue_after_top_level_binding_text,
    "else 33:i32",
  );

  const dynamic_i64_break_after_top_level_binding_ic = compile(`
let main = flag => {
  let total = 0i64

  for i in 0..2 {
    let next = total + 1i64
    total = next
    if flag {
      break
    }
  }

  total
}

main(flag)
`);
  const dynamic_i64_break_after_top_level_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_i64_break_after_top_level_binding_ic),
  );

  assert_includes(
    dynamic_i64_break_after_top_level_binding_text,
    "then 1:i64",
  );
  assert_includes(
    dynamic_i64_break_after_top_level_binding_text,
    "else 2:i64",
  );

  const dynamic_text_break_after_top_level_binding_ic = compile(`
let main = flag => {
  let total = 0

  for i in 0..2 {
    if flag {
      break
    }

    let label: Text = "ok"
    total = total + @len(label)
  }

  total
}

main(flag)
`);
  const dynamic_text_break_after_top_level_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_text_break_after_top_level_binding_ic),
  );

  assert_includes(
    dynamic_text_break_after_top_level_binding_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_text_break_after_top_level_binding_text,
    "else 4:i32",
  );

  const dynamic_deferred_numeric_binding_after_break_ic = compile(`
let main = flag => {
  let total = 0

  for i in 0..2 {
    if flag {
      break
    }

    let value = if choose {
      input
    } else {
      other
    }
    total = value + 1
  }

  total
}

main(flag)
`);
  const dynamic_deferred_numeric_binding_after_break_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_deferred_numeric_binding_after_break_ic),
  );

  assert_includes(
    dynamic_deferred_numeric_binding_after_break_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_deferred_numeric_binding_after_break_text,
    "choose",
  );
  assert_includes(
    dynamic_deferred_numeric_binding_after_break_text,
    "input",
  );
  assert_includes(
    dynamic_deferred_numeric_binding_after_break_text,
    "other",
  );

  const dynamic_deferred_text_if_let_binding_after_break_ic = compile(`
type OptionType = | \`Some Text | \`None Unit
const option_type = OptionType

let main = flag => {
  let total = 0
  let maybe: option_type = if choose {
    \`Some (input)
  } else {
    \`None ()
  }

  for i in 0..2 {
    if flag {
      break
    }

    let value = if let \`Some message = maybe {
      message
    } else {
      other
    }
    total = @len(value)
  }

  total
}

main(flag)
`);
  const dynamic_deferred_text_if_let_binding_after_break_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_deferred_text_if_let_binding_after_break_ic),
  );

  assert_includes(
    dynamic_deferred_text_if_let_binding_after_break_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_deferred_text_if_let_binding_after_break_text,
    "load(",
  );
  assert_includes(
    dynamic_deferred_text_if_let_binding_after_break_text,
    "other",
  );

  const dynamic_deferred_no_else_text_binding_after_break_ic = compile(`
type OptionType = | \`Some Text | \`None Unit
const option_type = OptionType

let main = flag => {
  let total = 0
  let maybe: option_type = if choose {
    \`Some (input)
  } else {
    \`None ()
  }

  for i in 0..2 {
    if flag {
      break
    }

    let value = if let \`Some message = maybe {
      message
    }
    total = @len(value)
  }

  total
}

main(flag)
`);
  const dynamic_deferred_no_else_text_binding_after_break_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_deferred_no_else_text_binding_after_break_ic),
  );

  assert_includes(
    dynamic_deferred_no_else_text_binding_after_break_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_deferred_no_else_text_binding_after_break_text,
    'else ""',
  );

  const dynamic_function_call_after_top_level_binding_ic = compile(`
let main = flag => {
  let total = 0

  for i in 0..2 {
    if flag {
      break
    }

    let id = x => x
    let value = id(i)
    total = value
  }

  total
}

main(flag)
`);
  const dynamic_function_call_after_top_level_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_function_call_after_top_level_binding_ic),
  );

  assert_includes(
    dynamic_function_call_after_top_level_binding_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_function_call_after_top_level_binding_text,
    "else 1:i32",
  );

  const dynamic_annotated_text_call_after_binding_ic = compile(`
let main = flag => {
  let total = 0

  for i in 0..2 {
    if flag {
      break
    }

    let id = (text: Text) => text
    let value = id(input)
    total = @len(value)
  }

  total
}

main(flag)
`);
  const dynamic_annotated_text_call_after_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_annotated_text_call_after_binding_ic),
  );

  assert_includes(
    dynamic_annotated_text_call_after_binding_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_annotated_text_call_after_binding_text,
    "load(",
  );
  assert_includes(
    dynamic_annotated_text_call_after_binding_text,
    "input",
  );

  const dynamic_function_branch_text_after_binding_ic = compile(`
let main = flag => {
  let total = 0

  for i in 0..2 {
    if flag {
      break
    }

    let id = if choose {
      (text: Text) => text
    } else {
      (other: Text) => other
    }
    let value = id(input)
    total = @len(value)
  }

  total
}

main(flag)
`);
  const dynamic_function_branch_text_after_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_function_branch_text_after_binding_ic),
  );

  assert_includes(
    dynamic_function_branch_text_after_binding_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_function_branch_text_after_binding_text,
    "load(",
  );
  assert_includes(
    dynamic_function_branch_text_after_binding_text,
    "choose",
  );

  const dynamic_function_branch_capture_after_binding_ic = compile(`
let main = flag => {
  let total = 0

  for i in 0..2 {
    if flag {
      break
    }

    let id = if choose {
      {
        let saved: Text = input
        (text: Text) => saved
      }
    } else {
      (other: Text) => other
    }
    let value = id(input)
    total = @len(value)
  }

  total
}

main(flag)
`);
  const dynamic_function_branch_capture_after_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_function_branch_capture_after_binding_ic),
  );

  assert_includes(
    dynamic_function_branch_capture_after_binding_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_function_branch_capture_after_binding_text,
    "load(",
  );
  assert_includes(
    dynamic_function_branch_capture_after_binding_text,
    "choose",
  );

  const dynamic_function_branch_struct_after_binding_ic = compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .label= Text
}

let main = flag => {
  let total = 0

  for i in 0..2 {
    if flag {
      break
    }

    let make = if choose {
      x => [.first = x + 1, .label = input] as pair_type
    } else {
      y => [.first = y, .label = input] as pair_type
    }
    let pair = make(i)
    total = pair.first + @len(pair.label)
  }

  total
}

main(flag)
`);
  const dynamic_function_branch_struct_after_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_function_branch_struct_after_binding_ic),
  );

  assert_includes(
    dynamic_function_branch_struct_after_binding_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_function_branch_struct_after_binding_text,
    "load(",
  );
  assert_includes(
    dynamic_function_branch_struct_after_binding_text,
    "choose",
  );

  const dynamic_if_let_function_branch_after_binding_ic = compile(`
type MaybeType = | \`Some Text | \`None Unit
const maybe_type = MaybeType

let main = flag => {
  let total = 0
  let maybe: maybe_type = if choose {
    \`Some (input)
  } else {
    \`None ()
  }

  for i in 0..2 {
    if flag {
      break
    }

    let id = if let \`Some saved = maybe {
      (text: Text) => saved
    } else {
      (other: Text) => other
    }
    let value = id(input)
    total = @len(value)
  }

  total
}

main(flag)
`);
  const dynamic_if_let_function_branch_after_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_if_let_function_branch_after_binding_ic),
  );

  assert_includes(
    dynamic_if_let_function_branch_after_binding_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_if_let_function_branch_after_binding_text,
    "load(",
  );
  assert_includes(
    dynamic_if_let_function_branch_after_binding_text,
    "choose",
  );

  const dynamic_struct_break_after_top_level_binding_ic = compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .label= Text
}

let main = flag => {
  let total = 0

  for i in 0..2 {
    if flag {
      break
    }

    let pair = [.first = i + 1, .label = "ok"] as pair_type
    total = total + pair.first + @len(pair.label)
  }

  total
}

main(flag)
`);
  const dynamic_struct_break_after_top_level_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_struct_break_after_top_level_binding_ic),
  );

  assert_includes(
    dynamic_struct_break_after_top_level_binding_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_struct_break_after_top_level_binding_text,
    "else 7:i32",
  );

  const dynamic_union_break_after_top_level_binding_ic = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

let main = flag => {
  let total = 0

  for i in 0..2 {
    if flag {
      break
    }

    let option = \`Some (i + 1)
    if let \`Some value = option {
      total = total + value
    }
  }

  total
}

main(flag)
`);
  const dynamic_union_break_after_top_level_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_union_break_after_top_level_binding_ic),
  );

  assert_includes(
    dynamic_union_break_after_top_level_binding_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_union_break_after_top_level_binding_text,
    "else 3:i32",
  );

  const dynamic_union_assignment_after_break_ic = compile(`
type OptionType = | \`Some Text | \`None Unit
const option_type = OptionType

let main = flag => {
  let option: option_type = \`None ()

  for i in 0..2 {
    if flag {
      break
    }

    option = \`Some (input)
  }

  if let \`Some value = option {
    @len(value)
  }
}

main(flag)
`);
  const dynamic_union_assignment_after_break_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_union_assignment_after_break_ic),
  );

  assert_includes(
    dynamic_union_assignment_after_break_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_union_assignment_after_break_text,
    "load(",
  );

  const dynamic_union_no_else_assignment_after_break_ic = compile(`
type OptionType = | \`Some Text | \`None Unit
const option_type = OptionType

let main = flag => {
  let option: option_type = \`None ()

  for i in 0..2 {
    if flag {
      break
    }

    option = if choose {
      \`Some (input)
    }
  }

  if let \`Some value = option {
    @len(value)
  }
}

main(flag)
`);
  const dynamic_union_no_else_assignment_after_break_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_union_no_else_assignment_after_break_ic),
  );

  assert_includes(
    dynamic_union_no_else_assignment_after_break_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_union_no_else_assignment_after_break_text,
    "load(",
  );
  assert_includes(
    dynamic_union_no_else_assignment_after_break_text,
    "choose",
  );

  const dynamic_union_change_assignment_after_break_ic = compile(`
type OptionType = | \`Some Text | \`None Unit
const option_type = OptionType

let main = flag => {
  let option: option_type = \`None ()

  for i in 0..2 {
    if flag {
      break
    }

    option := \`Some (input)
  }

  if let \`Some value = option {
    @len(value)
  }
}

main(flag)
`);
  const dynamic_union_change_assignment_after_break_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_union_change_assignment_after_break_ic),
  );

  assert_includes(
    dynamic_union_change_assignment_after_break_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_union_change_assignment_after_break_text,
    "load(",
  );

  const dynamic_union_no_else_change_assignment_after_break_ic = compile(`
type OptionType = | \`Some Text | \`None Unit
const option_type = OptionType

let main = flag => {
  let option: option_type = \`None ()

  for i in 0..2 {
    if flag {
      break
    }

    option := if choose {
      \`Some (input)
    }
  }

  if let \`Some value = option {
    @len(value)
  }
}

main(flag)
`);
  const dynamic_union_no_else_change_assignment_after_break_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_union_no_else_change_assignment_after_break_ic),
  );

  assert_includes(
    dynamic_union_no_else_change_assignment_after_break_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_union_no_else_change_assignment_after_break_text,
    "load(",
  );
  assert_includes(
    dynamic_union_no_else_change_assignment_after_break_text,
    "choose",
  );

  const dynamic_final_if_let_after_break_ic = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

let main = (flag, option: option_type) => {
  for i in 0..1 {
    if flag {
      break
    }
  }

  if let \`Some value = option {
    value + 1
  }
}

main(flag, option)
`);
  const dynamic_final_if_let_after_break_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_final_if_let_after_break_ic),
  );

  assert_includes(dynamic_final_if_let_after_break_text, "then");
  assert_includes(dynamic_final_if_let_after_break_text, "payload_Some");
  assert_includes(dynamic_final_if_let_after_break_text, "0:i32");

  const nested_dynamic_break_ic = compile(`
let main = (flag, other) => {
  let total = 0

  for i in 0..3 {
    total = total + 1
    if flag {
      if other {
        break
      }
    }
    total = total + 10
  }

  total
}

main(flag, other)
`);
  const nested_dynamic_break_text = Format.fmt(
    Ic,
    Ic.reduce(nested_dynamic_break_ic),
  );

  assert_includes(nested_dynamic_break_text, "other");
  assert_includes(nested_dynamic_break_text, "1:i32");
  assert_includes(nested_dynamic_break_text, "33:i32");

  const nested_dynamic_continue_ic = compile(`
let main = (flag, other) => {
  let total = 0

  for i in 0..3 {
    total = total + 1
    if flag {
      if other {
        continue
      }
    }
    total = total + 10
  }

  total
}

main(flag, other)
`);
  const nested_dynamic_continue_text = Format.fmt(
    Ic,
    Ic.reduce(nested_dynamic_continue_ic),
  );

  assert_includes(nested_dynamic_continue_text, "other");
  assert_includes(nested_dynamic_continue_text, "3:i32");
  assert_includes(nested_dynamic_continue_text, "33:i32");

  const nested_dynamic_if_let_break_ic = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

let main = (flag, option: option_type) => {
  let total = 0

  for i in 0..3 {
    total = total + 1
    if flag {
      if let \`Some value = option {
        break
      }
    }
    total = total + 10
  }

  total
}

main(flag, option)
`);
  const nested_dynamic_if_let_break_text = Format.fmt(
    Ic,
    Ic.reduce(nested_dynamic_if_let_break_ic),
  );

  assert_includes(nested_dynamic_if_let_break_text, "payload_Some");
  assert_includes(nested_dynamic_if_let_break_text, "1:i32");
  assert_includes(nested_dynamic_if_let_break_text, "33:i32");

  const nested_dynamic_if_let_continue_ic = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

let main = (flag, option: option_type) => {
  let total = 0

  for i in 0..3 {
    total = total + 1
    if flag {
      if let \`Some value = option {
        continue
      }
    }
    total = total + 10
  }

  total
}

main(flag, option)
`);
  const nested_dynamic_if_let_continue_text = Format.fmt(
    Ic,
    Ic.reduce(nested_dynamic_if_let_continue_ic),
  );

  assert_includes(nested_dynamic_if_let_continue_text, "payload_Some");
  assert_includes(nested_dynamic_if_let_continue_text, "3:i32");
  assert_includes(nested_dynamic_if_let_continue_text, "33:i32");

  const nested_dynamic_break_before_trailing_stmt_ic = compile(`
let main = (flag, other) => {
  let total = 0

  for i in 0..2 {
    if flag {
      if other {
        break
      }

      total = total + 1
    }
  }

  total
}

main(flag, other)
`);
  const nested_dynamic_break_before_trailing_stmt_text = Format.fmt(
    Ic,
    Ic.reduce(nested_dynamic_break_before_trailing_stmt_ic),
  );

  assert_includes(nested_dynamic_break_before_trailing_stmt_text, "other");
  assert_includes(nested_dynamic_break_before_trailing_stmt_text, "2:i32");

  const dynamic_if_let_nested_break_before_payload_use_ic = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

let main = (flag, option: option_type) => {
  let total = 0

  for i in 0..2 {
    if let \`Some value = option {
      if flag {
        break
      }

      total = total + value
    }
  }

  total
}

main(flag, option)
`);
  const dynamic_if_let_nested_break_before_payload_use_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_if_let_nested_break_before_payload_use_ic),
  );

  assert_includes(
    dynamic_if_let_nested_break_before_payload_use_text,
    "payload_Some",
  );
  assert_includes(
    dynamic_if_let_nested_break_before_payload_use_text,
    "+ payload_Some",
  );

  const dynamic_if_let_break_ic = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

let main = (option: option_type) => {
  let total = 0

  for i in 0..3 {
    total = total + 1
    if let \`Some value = option {
      break
    }
    total = total + 10
  }

  total
}

main(option)
`);
  const dynamic_if_let_break_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_if_let_break_ic),
  );

  assert_includes(dynamic_if_let_break_text, "1:i32");
  assert_includes(dynamic_if_let_break_text, "33:i32");

  const dynamic_if_let_continue_ic = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

let main = (option: option_type) => {
  let total = 0

  for i in 0..3 {
    total = total + 1
    if let \`Some value = option {
      continue
    }
    total = total + 10
  }

  total
}

main(option)
`);
  const dynamic_if_let_continue_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_if_let_continue_ic),
  );

  assert_includes(dynamic_if_let_continue_text, "3:i32");
  assert_includes(dynamic_if_let_continue_text, "33:i32");

  const dynamic_if_let_break_after_assignment_ic = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

let main = (option: option_type) => {
  let total = 0

  for i in 0..2 {
    if let \`Some value = option {
      let next = total + value
      total = next
      break
    }
  }

  total
}

main(option)
`);
  const dynamic_if_let_break_after_assignment_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_if_let_break_after_assignment_ic),
  );

  assert_includes(dynamic_if_let_break_after_assignment_text, "payload_Some");
  assert_includes(dynamic_if_let_break_after_assignment_text, "0:i32");

  assert_throws(
    () =>
      compile(`
let main = (!x) => {
  break
  x
}

main(40)
`),
    "Cannot lower break outside static range loop",
  );
});

Deno.test("Source lowers const-known collection loops by expansion", () => {
  const ic = compile(`
const xs = [10, 20]

let sum = 0

for x in xs {
  sum = sum + x
}

sum
`);

  assert_equals(Ic.reduce(ic), { tag: "num", type: "i32", value: 30 });

  const indexed = compile(`
const xs = [10, 20]

let sum = 0

for i, x in xs {
  sum = sum + i + x
}

sum
`);

  assert_equals(Ic.reduce(indexed), { tag: "num", type: "i32", value: 31 });

  const visible_arg = compile(`
let sum = xs => {
  let total = 0

  for x in xs {
    total = total + x
  }

  total
}

sum([10, 32])
`);

  assert_equals(Ic.reduce(visible_arg), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const indexed_visible_arg = compile(`
let sum = xs => {
  let total = 0

  for i, x in xs {
    total = total + i + x
  }

  total
}

sum([10, 31])
`);

  assert_equals(Ic.reduce(indexed_visible_arg), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const dynamic_break = compile(`
const xs = [10, 20, 30]

let main = (flag: Bool) => {
  let total = 0

  for x in xs {
    total = total + 1
    if flag {
      break
    }
    total = total + x
  }

  total
}

main(flag)
`);
  const dynamic_break_text = Format.fmt(Ic, Ic.reduce(dynamic_break));

  assert_includes(dynamic_break_text, "then 1:i32");
  assert_includes(dynamic_break_text, "else 63:i32");

  const dynamic_continue = compile(`
const xs = [10, 20, 30]

let main = (flag: Bool) => {
  let total = 0

  for x in xs {
    total = total + 1
    if flag {
      continue
    }
    total = total + x
  }

  total
}

main(flag)
`);
  const dynamic_continue_text = Format.fmt(Ic, Ic.reduce(dynamic_continue));

  assert_includes(dynamic_continue_text, "then 3:i32");
  assert_includes(dynamic_continue_text, "else 63:i32");

  const dynamic_if_let_break = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

const xs = [10, 20, 30]

let main = (option: option_type) => {
  let total = 0

  for x in xs {
    total = total + 1
    if let \`Some value = option {
      break
    }
    total = total + x
  }

  total
}

main(option)
`);
  const dynamic_if_let_break_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_if_let_break),
  );

  assert_includes(dynamic_if_let_break_text, "1:i32");
  assert_includes(dynamic_if_let_break_text, "63:i32");

  const dynamic_collection_break_after_assignment = compile(`
const xs = [10, 20]

let main = (flag: Bool) => {
  let total = 0

  for x in xs {
    if flag {
      let next = total + x
      total = next
      break
    }
  }

  total
}

main(flag)
`);
  const dynamic_collection_break_after_assignment_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_collection_break_after_assignment),
  );

  assert_includes(
    dynamic_collection_break_after_assignment_text,
    "then 10:i32",
  );
  assert_includes(dynamic_collection_break_after_assignment_text, "else 0:i32");

  const dynamic_collection_break_after_top_level_binding = compile(`
const xs = [10, 20]

let main = (flag: Bool) => {
  let total = 0

  for x in xs {
    let next = total + x
    total = next
    if flag {
      break
    }
  }

  total
}

main(flag)
`);
  const dynamic_collection_break_after_top_level_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_collection_break_after_top_level_binding),
  );

  assert_includes(
    dynamic_collection_break_after_top_level_binding_text,
    "then 10:i32",
  );
  assert_includes(
    dynamic_collection_break_after_top_level_binding_text,
    "else 30:i32",
  );

  const dynamic_collection_continue_after_top_level_binding = compile(`
const xs = [10, 20]

let main = (flag: Bool) => {
  let total = 0

  for x in xs {
    let next = total + x
    total = next
    if flag {
      continue
    }
    total = total + 1
  }

  total
}

main(flag)
`);
  const dynamic_collection_continue_after_top_level_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_collection_continue_after_top_level_binding),
  );

  assert_includes(
    dynamic_collection_continue_after_top_level_binding_text,
    "then 30:i32",
  );
  assert_includes(
    dynamic_collection_continue_after_top_level_binding_text,
    "else 32:i32",
  );

  const dynamic_collection_text_break_after_top_level_binding = compile(`
const xs = [10, 20]

let main = (flag: Bool) => {
  let total = 0

  for x in xs {
    if flag {
      break
    }

    let label: Text = "item"
    total = total + x + @len(label)
  }

  total
}

main(flag)
`);
  const dynamic_collection_text_break_after_top_level_binding_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_collection_text_break_after_top_level_binding),
  );

  assert_includes(
    dynamic_collection_text_break_after_top_level_binding_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_collection_text_break_after_top_level_binding_text,
    "else 38:i32",
  );

  const dynamic_collection_struct_break_after_top_level_binding = compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .label= Text
}

const xs = [10, 20]

let main = (flag: Bool) => {
  let total = 0

  for x in xs {
    if flag {
      break
    }

    let pair = [.first = x, .label = "item"] as pair_type
    total = total + pair.first + @len(pair.label)
  }

  total
}

main(flag)
`);
  const dynamic_collection_struct_break_after_top_level_binding_text = Format
    .fmt(
      Ic,
      Ic.reduce(dynamic_collection_struct_break_after_top_level_binding),
    );

  assert_includes(
    dynamic_collection_struct_break_after_top_level_binding_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_collection_struct_break_after_top_level_binding_text,
    "else 38:i32",
  );

  const dynamic_collection_union_break_after_top_level_binding = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

const xs = [10, 20]

let main = (flag: Bool) => {
  let total = 0

  for x in xs {
    if flag {
      break
    }

    let option = \`Some (x)
    if let \`Some value = option {
      total = total + value
    }
  }

  total
}

main(flag)
`);
  const dynamic_collection_union_break_after_top_level_binding_text = Format
    .fmt(
      Ic,
      Ic.reduce(dynamic_collection_union_break_after_top_level_binding),
    );

  assert_includes(
    dynamic_collection_union_break_after_top_level_binding_text,
    "then 0:i32",
  );
  assert_includes(
    dynamic_collection_union_break_after_top_level_binding_text,
    "else 30:i32",
  );

  const dynamic_collection_nested_break = compile(`
const xs = [10, 20, 30]

let main = (flag: Bool, other: Bool) => {
  let total = 0

  for x in xs {
    total = total + 1
    if flag {
      if other {
        break
      }
    }
    total = total + x
  }

  total
}

main(flag, other)
`);
  const dynamic_collection_nested_break_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_collection_nested_break),
  );

  assert_includes(dynamic_collection_nested_break_text, "other");
  assert_includes(dynamic_collection_nested_break_text, "1:i32");
  assert_includes(dynamic_collection_nested_break_text, "63:i32");

  const dynamic_collection_nested_break_before_trailing_stmt = compile(`
const xs = [10, 20, 30]

let main = (flag: Bool, other: Bool) => {
  let total = 0

  for x in xs {
    if flag {
      if other {
        break
      }

      total = total + x
    }
  }

  total
}

main(flag, other)
`);
  const dynamic_collection_nested_break_before_trailing_stmt_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_collection_nested_break_before_trailing_stmt),
  );

  assert_includes(
    dynamic_collection_nested_break_before_trailing_stmt_text,
    "other",
  );
  assert_includes(
    dynamic_collection_nested_break_before_trailing_stmt_text,
    "60:i32",
  );

  const dynamic_collection_nested_if_let_break = compile(`
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType

const xs = [10, 20, 30]

let main = (flag: Bool, option: option_type) => {
  let total = 0

  for x in xs {
    total = total + 1
    if flag {
      if let \`Some value = option {
        break
      }
    }
    total = total + x
  }

  total
}

main(flag, option)
`);
  const dynamic_collection_nested_if_let_break_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_collection_nested_if_let_break),
  );

  assert_includes(dynamic_collection_nested_if_let_break_text, "payload_Some");
  assert_includes(dynamic_collection_nested_if_let_break_text, "1:i32");
  assert_includes(dynamic_collection_nested_if_let_break_text, "63:i32");
});

Deno.test("Source lowers const-known index access", () => {
  const direct = compile(`
const xs = [10, 20]

xs[0] + xs[1]
`);

  assert_equals(Ic.reduce(direct), { tag: "num", type: "i32", value: 30 });

  const looped = compile(`
const xs = [10, 20]

let sum = 0

for i, x in xs {
  sum = sum + xs[i]
}

sum
`);

  assert_equals(Ic.reduce(looped), { tag: "num", type: "i32", value: 30 });

  const dynamic = compile(`
const xs = [10, 20]

xs[i]
`);
  const dynamic_text = Format.fmt(Ic, Ic.reduce(dynamic));

  assert_includes(dynamic_text, "! i_share0 &share_i_0 = i;");
  assert_includes(dynamic_text, "if i_share01 == 0:i32 then 10:i32");
  assert_includes(dynamic_text, "if i_share00 == 1:i32 then 20:i32");
  assert_includes(dynamic_text, "else trap");

  const closure_static = compile(`
let second = xs => xs[1]

second([.first = 10, .second = 32])
`);

  assert_equals(Ic.reduce(closure_static), {
    tag: "num",
    type: "i32",
    value: 32,
  });

  const closure_dynamic = compile(`
let choose = (xs, i) => {
  xs[i]
}

choose([.first = 10, .second = 32], input)
`);
  const closure_dynamic_text = Format.fmt(Ic, Ic.reduce(closure_dynamic));

  assert_includes(
    closure_dynamic_text,
    "! i#0_share0 &share_i_0_0 = input;",
  );
  assert_includes(
    closure_dynamic_text,
    "if i#0_share01 == 0:i32 then 10:i32",
  );
  assert_includes(
    closure_dynamic_text,
    "if i#0_share00 == 1:i32 then 32:i32",
  );
  assert_includes(closure_dynamic_text, "else trap");

  const const_call_dynamic = compile(`
const make_xs = flag => {
  if flag {
    [.first = 10, .second = 20]
  } else {
    [.first = 30, .second = 40]
  }
}

let xs = make_xs(input)

xs[i]
`);
  const const_call_dynamic_text = Format.fmt(
    Ic,
    Ic.reduce(
      const_call_dynamic,
    ),
  );

  assert_includes(
    const_call_dynamic_text,
    "then 10:i32 else 30:i32",
  );
  assert_includes(
    const_call_dynamic_text,
    "then 20:i32 else 40:i32",
  );
  assert_includes(const_call_dynamic_text, "else trap");

  const wide = compile(`
const xs = [3i64, 7i64]

xs[i]
`);
  const wide_text = Format.fmt(Ic, Ic.reduce(wide));

  assert_includes(wide_text, "! i_share0 &share_i_0 = i;");
  assert_includes(wide_text, "if i_share01 == 0:i32 then 3:i64");
  assert_includes(wide_text, "if i_share00 == 1:i32 then 7:i64");

  assert_throws(
    () => compile("xs[i]"),
    "use Source.core, Source.mod, or Source.wat",
  );

  assert_throws(
    () =>
      compile(`
const xs = [10]

xs[1]
`),
    "Index out of bounds: 1",
  );
});

Deno.test("Source lowers const-known collection len and get helpers", () => {
  const direct = compile(`
const xs = [10, 20, 30]

@len(xs) + @get(xs, 1)
`);

  assert_equals(Ic.reduce(direct), { tag: "num", type: "i32", value: 23 });

  const closure_len = compile(`
let size = xs => @len(xs)

size([10, 32])
`);

  assert_equals(Ic.reduce(closure_len), {
    tag: "num",
    type: "i32",
    value: 2,
  });

  const closure_get = compile(`
let second = xs => @get(xs, 1)

second([10, 32])
`);

  assert_equals(Ic.reduce(closure_get), {
    tag: "num",
    type: "i32",
    value: 32,
  });

  const closure_dynamic_get = compile(`
let choose = (xs, i) => {
  @get(xs, i)
}

choose([10, 32], input)
`);
  const closure_dynamic_get_text = Format.fmt(
    Ic,
    Ic.reduce(closure_dynamic_get),
  );

  assert_includes(
    closure_dynamic_get_text,
    "! i#0_share0 &share_i_0_0 = input;",
  );
  assert_includes(
    closure_dynamic_get_text,
    "if i#0_share01 == 0:i32 then 10:i32",
  );
  assert_includes(
    closure_dynamic_get_text,
    "if i#0_share00 == 1:i32 then 32:i32",
  );
  assert_includes(closure_dynamic_get_text, "else trap");

  const dynamic_text_get = compile(`
let rename = value => {
  value :+ {
    .second = "Grace"
  }
}

@get(rename([.first = "Ada", .second = "Eve"])[input], 1)
`);
  const dynamic_text_get_text = Format.fmt(Ic, Ic.reduce(dynamic_text_get));

  assert_includes(dynamic_text_get_text, "if input_share01 == 0:i32");
  assert_includes(dynamic_text_get_text, "then 100:i32");
  assert_includes(dynamic_text_get_text, "if input_share00 == 1:i32");
  assert_includes(dynamic_text_get_text, "then 114:i32");
  assert_includes(dynamic_text_get_text, "else trap");

  const dynamic_text_byte = compile(`
let rename = value => {
  value :+ {
    .second = "Grace"
  }
}

rename([.first = "Ada", .second = "Eve"])[input][1]
`);
  const dynamic_text_byte_text = Format.fmt(Ic, Ic.reduce(dynamic_text_byte));

  assert_includes(dynamic_text_byte_text, "if input_share01 == 0:i32");
  assert_includes(dynamic_text_byte_text, "then 100:i32");
  assert_includes(dynamic_text_byte_text, "if input_share00 == 1:i32");
  assert_includes(dynamic_text_byte_text, "then 114:i32");
  assert_includes(dynamic_text_byte_text, "else trap");

  assert_throws(
    () =>
      compile(`
let rename = value => {
  value :+ {
    .second = "Grace"
  }
}

@get(rename([.first = "Ada", .second = "Eve"])[input], 1i64)
`),
    "Text index must be i32",
  );

  assert_throws(
    () =>
      compile(`
let rename = value => {
  value :+ {
    .second = "Grace"
  }
}

rename([.first = "Ada", .second = "Eve"])[input][1i64]
`),
    "Text index must be i32",
  );

  const looped = compile(`
const xs = [10, 20, 30]

let sum = 0

for i in 0..@len(xs) {
  sum = sum + @get(xs, i)
}

sum
`);

  assert_equals(Ic.reduce(looped), { tag: "num", type: "i32", value: 60 });

  const dynamic = compile(`
const xs = [10, 20, 30]

@get(xs, input)
`);
  const dynamic_text = Format.fmt(Ic, Ic.reduce(dynamic));

  assert_includes(dynamic_text, "! input_share0 &share_input_0 = input;");
  assert_includes(
    dynamic_text,
    "! input_share1 &share_input_1 = input_share01;",
  );
  assert_includes(dynamic_text, "if input_share11 == 0:i32 then 10:i32");
  assert_includes(dynamic_text, "if input_share10 == 1:i32 then 20:i32");
  assert_includes(dynamic_text, "if input_share00 == 2:i32 then 30:i32");
  assert_includes(dynamic_text, "else trap");

  const dynamic_text_index = compile(`
const messages = ["Ada", "Grace"]

@get(messages, input)
`);
  const dynamic_text_index_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_text_index),
  );

  assert_includes(dynamic_text_index_text, "if input_share01 == 0:i32");
  assert_includes(dynamic_text_index_text, 'then "Ada"');
  assert_includes(dynamic_text_index_text, "if input_share00 == 1:i32");
  assert_includes(dynamic_text_index_text, 'then "Grace"');
  assert_includes(dynamic_text_index_text, "else trap");

  const dynamic_text_len = compile(`
const messages = [.first = "Ada", .second = "Grace"]

@len(messages[input])
`);
  const dynamic_text_len_text = Format.fmt(Ic, Ic.reduce(dynamic_text_len));

  assert_includes(dynamic_text_len_text, "if input_share01 == 0:i32");
  assert_includes(dynamic_text_len_text, "then 3:i32");
  assert_includes(dynamic_text_len_text, "if input_share00 == 1:i32");
  assert_includes(dynamic_text_len_text, "then 5:i32");
  assert_includes(dynamic_text_len_text, "else trap");

  assert_throws(
    () => compile("@len(xs)"),
    "len requires a compile-time collection value",
  );
});

Deno.test("Source lowers typed runtime struct indexing to Ic", () => {
  const field_projection = compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let first_plus_one = (pair: pair_type) => {
  pair.first + 1
}

let input = 41
let pair = [.first = input, .second = 0] as pair_type
input = 0

first_plus_one(pair)
`);

  assert_equals(Ic.reduce(field_projection), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const static_index = compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let second_plus_one = (pair: pair_type) => {
  @get(pair, 1) + 1
}

let pair = [.first = 0, .second = 41] as pair_type

second_plus_one(pair)
`);

  assert_equals(Ic.reduce(static_index), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const dynamic_index = compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let choose = (pair: pair_type, i) => {
  pair[i]
}

let pair = [.first = 10, .second = 20] as pair_type

choose(pair, i)
`);
  const dynamic_text = Format.fmt(Ic, Ic.reduce(dynamic_index));

  assert_includes(dynamic_text, "! i#0_share0 &share_i_0_0 = i;");
  assert_includes(dynamic_text, "if i#0_share01 == 0:i32 then 10:i32");
  assert_includes(dynamic_text, "if i#0_share00 == 1:i32 then 20:i32");
  assert_includes(dynamic_text, "else trap");

  const dynamic_runtime_fields = compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let choose = (pair: pair_type, i) => {
  pair[i]
}

let pair = [.first = left, .second = right] as pair_type

choose(pair, i)
`);
  const dynamic_runtime_fields_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_runtime_fields),
  );

  assert_includes(dynamic_runtime_fields_text, "then left");
  assert_includes(dynamic_runtime_fields_text, "then right");
  assert_includes(dynamic_runtime_fields_text, "else trap");

  const dynamic_get = compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let choose = (pair: pair_type, i) => {
  @get(pair, i)
}

let pair = [.first = 10, .second = 20] as pair_type

choose(pair, i)
`);
  const dynamic_get_text = Format.fmt(Ic, Ic.reduce(dynamic_get));

  assert_includes(dynamic_get_text, "! i#0_share0 &share_i_0_0 = i;");
  assert_includes(dynamic_get_text, "if i#0_share01 == 0:i32 then 10:i32");
  assert_includes(dynamic_get_text, "if i#0_share00 == 1:i32 then 20:i32");

  const wide = compile(`
const { struct } = import "duck:prelude" ()
const wide_type = struct {
  .first= I64,
  .second= I64
}

let choose = (pair: wide_type, i) => {
  pair[i]
}

let pair = [.first = 3i64, .second = 7i64] as wide_type

choose(pair, i)
`);
  const wide_text = Format.fmt(Ic, Ic.reduce(wide));

  assert_includes(wide_text, "! i#0_share0 &share_i_0_0 = i;");
  assert_includes(wide_text, "if i#0_share01 == 0:i32 then 3:i64");
  assert_includes(wide_text, "if i#0_share00 == 1:i32 then 7:i64");

  const length = compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let count = (pair: pair_type) => {
  @len(pair)
}

let pair = [.first = 10, .second = 20] as pair_type

count(pair) + 40
`);

  assert_equals(Ic.reduce(length), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const collection_loop = compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let sum = (pair: pair_type) => {
  let total = 0

  for x in pair {
    total = total + x
  }

  total
}

let pair = [.first = 10, .second = 32] as pair_type

sum(pair)
`);

  assert_equals(Ic.reduce(collection_loop), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const indexed_loop = compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let sum = (pair: pair_type) => {
  let total = 0

  for i, x in pair {
    total = total + i + x
  }

  total
}

let pair = [.first = 10, .second = 31] as pair_type

sum(pair)
`);

  assert_equals(Ic.reduce(indexed_loop), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const dynamic_runtime_struct_loop = compile(`
const { struct } = import "duck:prelude" ()
const triple_type = struct {
  .first= Int,
  .second= Int,
  .third= Int
}

let sum = (value: triple_type, flag) => {
  let total = 0

  for x in value {
    total = total + 1
    if flag {
      break
    }
    total = total + x
  }

  total
}

sum(value, flag)
`);
  const dynamic_runtime_struct_loop_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_runtime_struct_loop),
  );

  assert_includes(dynamic_runtime_struct_loop_text, "then 1:i32");
  assert_includes(dynamic_runtime_struct_loop_text, "field_first");
  assert_includes(dynamic_runtime_struct_loop_text, "field_second");
  assert_includes(dynamic_runtime_struct_loop_text, "field_third");

  const dynamic_text_loop = compile(`
let main = flag => {
  let total = 0

  for byte in "ABC" {
    total = total + 1
    if flag {
      continue
    }
    total = total + byte
  }

  total
}

main(flag)
`);
  const dynamic_text_loop_text = Format.fmt(Ic, Ic.reduce(dynamic_text_loop));

  assert_includes(dynamic_text_loop_text, "then 3:i32");
  assert_includes(dynamic_text_loop_text, "else 201:i32");

  const text_loop = compile(`
let total = 0

for byte in "Ada" {
  total = total + byte
}

total
`);

  assert_equals(Ic.reduce(text_loop), {
    tag: "num",
    type: "i32",
    value: 262,
  });

  const indexed_text_loop = compile(`
let total = 0

for i, byte in "Ada" {
  total = total + i + byte
}

total
`);

  assert_equals(Ic.reduce(indexed_text_loop), {
    tag: "num",
    type: "i32",
    value: 265,
  });

  const runtime_text_argument_loop = compile(`
let sum_text = (value: Text) => {
  let total = 0

  for byte in value {
    total = total + byte
  }

  total
}

sum_text("Ada")
`);

  assert_equals(Ic.reduce(runtime_text_argument_loop), {
    tag: "num",
    type: "i32",
    value: 262,
  });

  const runtime_text_argument_indexed_loop = compile(`
let sum_text = value => {
  let total = 0

  for i, byte in value {
    total = total + i + byte
  }

  total
}

sum_text("Ada")
`);

  assert_equals(Ic.reduce(runtime_text_argument_indexed_loop), {
    tag: "num",
    type: "i32",
    value: 265,
  });

  const text_argument_byte = compile(`
let byte_at = (value, i) => {
  value[i]
}

byte_at("Ada", 2)
`);

  assert_equals(Ic.reduce(text_argument_byte), {
    tag: "num",
    type: "i32",
    value: 97,
  });

  const dynamic_text_argument_byte = compile(`
let byte_at = (value, i) => {
  value[i]
}

byte_at("Ada", input)
`);
  const dynamic_text_argument_byte_text = Format.fmt(
    Ic,
    Ic.reduce(dynamic_text_argument_byte),
  );

  assert_includes(
    dynamic_text_argument_byte_text,
    "! i#0_share0 &share_i_0_0 = input;",
  );
  assert_includes(
    dynamic_text_argument_byte_text,
    "if i#0_share11 == 0:i32 then 65:i32",
  );
  assert_includes(
    dynamic_text_argument_byte_text,
    "if i#0_share10 == 1:i32 then 100:i32",
  );
  assert_includes(
    dynamic_text_argument_byte_text,
    "if i#0_share00 == 2:i32 then 97:i32",
  );
  assert_includes(dynamic_text_argument_byte_text, "else trap");

  const text_argument_len = compile(`
let byte_len = value => @len(value)

byte_len("Ada")
`);

  assert_equals(Ic.reduce(text_argument_len), {
    tag: "num",
    type: "i32",
    value: 3,
  });

  const text_argument_get = compile(`
let byte_at = value => @get(value, 1)

byte_at("Ada")
`);

  assert_equals(Ic.reduce(text_argument_get), {
    tag: "num",
    type: "i32",
    value: 100,
  });

  const range_len_loop = compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let sum = (pair: pair_type) => {
  let total = 0

  for i in 0..@len(pair) {
    total = total + pair[i]
  }

  total
}

let pair = [.first = 10, .second = 32] as pair_type

sum(pair)
`);

  assert_equals(Ic.reduce(range_len_loop), {
    tag: "num",
    type: "i32",
    value: 42,
  });

  const text_index = compile(`
const { struct } = import "duck:prelude" ()
const messages_type = struct {
  .first= Text,
  .second= Text
}

let choose = (messages: messages_type, i) => {
  messages[i]
}

let messages = [.first = "Ada", .second = "Grace"] as messages_type

choose(messages, i)
`);
  const text_index_text = Format.fmt(Ic, Ic.reduce(text_index));

  assert_includes(text_index_text, "if i#0_share01 == 0:i32");
  assert_includes(text_index_text, 'then "Ada"');
  assert_includes(text_index_text, "if i#0_share00 == 1:i32");
  assert_includes(text_index_text, 'then "Grace"');
  assert_includes(text_index_text, "else trap");

  const typed_text_index_len = compile(`
const { struct } = import "duck:prelude" ()
const messages_type = struct {
  .first= Text,
  .second= Text
}

let messages = [.first = "Ada", .second = "Grace"] as messages_type

@len(messages[i])
`);
  const typed_text_index_len_text = Format.fmt(
    Ic,
    Ic.reduce(typed_text_index_len),
  );

  assert_includes(typed_text_index_len_text, "if i_share01 == 0:i32");
  assert_includes(typed_text_index_len_text, "then 3:i32");
  assert_includes(typed_text_index_len_text, "if i_share00 == 1:i32");
  assert_includes(typed_text_index_len_text, "then 5:i32");
  assert_includes(typed_text_index_len_text, "else trap");

  const runtime_text_index_len = compile(`
const { struct } = import "duck:prelude" ()
const messages_type = struct {
  .first= Text,
  .second= Text
}

let byte_len = (messages: messages_type, i) => {
  @len(messages[i])
}

let messages = [.first = first_text, .second = second_text] as messages_type

byte_len(messages, i)
`);
  const runtime_text_index_len_text = Format.fmt(
    Ic,
    Ic.reduce(runtime_text_index_len),
  );

  assert_includes(runtime_text_index_len_text, "load(");
  assert_includes(runtime_text_index_len_text, "then first_text");
  assert_includes(runtime_text_index_len_text, "then second_text");
  assert_includes(runtime_text_index_len_text, "else trap");

  assert_throws(
    () =>
      compile(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int
}

let bad = (pair: pair_type) => {
  pair[1]
}

let pair = [.first = 0] as pair_type

bad(pair)
`),
    "Index out of bounds: 1",
  );

  assert_throws(
    () =>
      compile(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let choose = (user: user_type, i) => {
  user[i]
}

let user = [.name = "Ada", .age = 41] as user_type

choose(user, i)
`),
    "Cannot lower dynamic index for non-numeric field: name",
  );
});

Deno.test("Source rejects unsupported loop forms and invalid ranges", () => {
  const dynamic_source = `
let sum = 0

for i in 0..n {
  sum = sum + i
}

sum
`;
  assert_throws(
    () => Source.core(dynamic_source),
    "Unbound core value: n",
  );

  assert_throws(
    () => compile(dynamic_source),
    "Cannot lower dynamic for end to Ic frontend yet",
  );

  assert_throws(
    () => compile(dynamic_source),
    "use Source.core, Source.mod, or Source.wat",
  );

  const dynamic_control_binding_source = `
for i in 0..3 {
  if input {
    break
  }

  let f = x => x
}

1
`;

  const dynamic_control_binding_core = Source.core(
    "let input = true\n" + dynamic_control_binding_source,
  );
  assert_equals(dynamic_control_binding_core.statements[1]?.tag, "range_loop");

  assert_throws(
    () =>
      compile(`
for x in xs {
  x
}

0
`),
    "Cannot lower collection loop to Ic frontend yet: xs",
  );

  const dynamic_control_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_binding_source)),
  );
  assert_includes(dynamic_control_binding_ic, "1:i32");
  assert_equals(dynamic_control_binding_ic.includes("f#"), false);

  const dynamic_control_function_call_source = `
let total = 41

for i in 0..3 {
  if input {
    break
  }

  let f = x => x
  total = f(total)
}

total
`;

  const dynamic_control_function_call_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_function_call_source)),
  );
  assert_includes(dynamic_control_function_call_ic, "41:i32");
  assert_equals(dynamic_control_function_call_ic.includes("f#"), false);

  const dynamic_control_block_function_call_source = `
let total = 0

for i in 0..2 {
  if input {
    break
  }

  let f = {
    let id = x => x
    id
  }

  total = f(total + 1)
}

total
`;

  const dynamic_control_block_function_call_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_block_function_call_source)),
  );
  assert_equals(
    dynamic_control_block_function_call_ic,
    `! input_share0 &share_input_0 = input;
if input_share01 then 0:i32 else if input_share00 then 1:i32 else 2:i32`,
  );
  assert_equals(dynamic_control_block_function_call_ic.includes("f#"), false);

  const dynamic_control_block_captured_function_call_source = `
let total = 0

for i in 0..2 {
  if input {
    break
  }

  let f = {
    let offset = i + 1
    let add = x => x + offset
    add
  }

  total = f(total)
}

total
`;

  const dynamic_control_block_captured_function_call_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_block_captured_function_call_source)),
  );
  assert_equals(
    dynamic_control_block_captured_function_call_ic,
    `! input_share0 &share_input_0 = input;
if input_share01 then 0:i32 else if input_share00 then 1:i32 else 3:i32`,
  );
  assert_equals(
    dynamic_control_block_captured_function_call_ic.includes("f#"),
    false,
  );
  assert_equals(
    dynamic_control_block_captured_function_call_ic.includes("offset#"),
    false,
  );

  const dynamic_control_block_returned_function_call_source = `
let total = 0

for i in 0..2 {
  if input {
    break
  }

  let f = {
    let offset = i + 1
    return x => x + offset
  }

  total = f(total)
}

total
`;

  const dynamic_control_block_returned_function_call_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_block_returned_function_call_source)),
  );
  assert_equals(
    dynamic_control_block_returned_function_call_ic,
    `! input_share0 &share_input_0 = input;
if input_share01 then 0:i32 else if input_share00 then 1:i32 else 3:i32`,
  );
  assert_equals(
    dynamic_control_block_returned_function_call_ic.includes("f#"),
    false,
  );
  assert_equals(
    dynamic_control_block_returned_function_call_ic.includes("offset#"),
    false,
  );

  const dynamic_control_block_binding_source = `
let total = 0

for i in 0..2 {
  if input {
    break
  }

  let amount = {
    let inner = i + 1
    inner
  }
  total = total + amount
}

total
`;

  const dynamic_control_block_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_block_binding_source)),
  );
  assert_equals(
    dynamic_control_block_binding_ic,
    `! input_share0 &share_input_0 = input;
if input_share01 then 0:i32 else if input_share00 then 1:i32 else 3:i32`,
  );

  const dynamic_control_annotated_text_binding_source = `
let total = 0

for i in 0..2 {
  if input {
    break
  }

  let label: Text = text
  total = total + @len(label)
}

total
`;

  const dynamic_control_annotated_text_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_annotated_text_binding_source)),
  );
  assert_includes(dynamic_control_annotated_text_binding_ic, "load(text");
  assert_includes(
    dynamic_control_annotated_text_binding_ic,
    "if input_share01 then 0:i32",
  );

  const dynamic_control_annotated_int_binding_source = `
let total = 0

for i in 0..2 {
  if input {
    break
  }

  let amount: Int = value
  total = total + amount
}

total
`;

  const dynamic_control_annotated_int_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_annotated_int_binding_source)),
  );
  assert_includes(dynamic_control_annotated_int_binding_ic, "value_share");
  assert_includes(
    dynamic_control_annotated_int_binding_ic,
    "if input_share01 then 0:i32",
  );

  const dynamic_control_annotated_i64_binding_source = `
let total: I64 = 0i64

for i in 0..2 {
  if input {
    break
  }

  let amount: I64 = value
  total = total + amount
}

total
`;

  const dynamic_control_annotated_i64_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_annotated_i64_binding_source)),
  );
  assert_includes(dynamic_control_annotated_i64_binding_ic, "value_share");
  assert_includes(
    dynamic_control_annotated_i64_binding_ic,
    "if input_share01 then 0:i64",
  );

  const dynamic_control_annotated_struct_binding_source = `
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .label= Text
}

let total = 0

for i in 0..2 {
  if input {
    break
  }

  let pair: pair_type = source
  total = total + pair.first + @len(pair.label)
}

total
`;

  const dynamic_control_annotated_struct_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_annotated_struct_binding_source)),
  );
  assert_includes(dynamic_control_annotated_struct_binding_ic, "field_first");
  assert_includes(dynamic_control_annotated_struct_binding_ic, "field_label");
  assert_includes(dynamic_control_annotated_struct_binding_ic, "source_share");
  assert_includes(
    dynamic_control_annotated_struct_binding_ic,
    "if input_share01 then 0:i32",
  );

  const dynamic_control_annotated_union_binding_source = `
type ResultType = | \`Ok Int | \`Err Text
const result_type = ResultType

let total = 0

for i in 0..2 {
  if input {
    break
  }

  let result: result_type = source
  if let \`Ok value = result {
    total = total + value
  }
}

total
`;

  const dynamic_control_annotated_union_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_annotated_union_binding_source)),
  );
  assert_includes(dynamic_control_annotated_union_binding_ic, "payload_Ok");
  assert_includes(dynamic_control_annotated_union_binding_ic, "source_share");
  assert_includes(
    dynamic_control_annotated_union_binding_ic,
    "if input_share",
  );

  const dynamic_control_annotated_nested_struct_binding_source = `
const { struct } = import "duck:prelude" ()
const name_type = struct {
  .first= Text
}

const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= name_type,
  .age= Int
}

let total = 0

for i in 0..2 {
  if input {
    break
  }

  let user: user_type = source
  total = total + user.age + @len(user.name.first)
}

total
`;

  const dynamic_control_annotated_nested_struct_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_annotated_nested_struct_binding_source)),
  );
  assert_includes(
    dynamic_control_annotated_nested_struct_binding_ic,
    "field_age",
  );
  assert_includes(
    dynamic_control_annotated_nested_struct_binding_ic,
    "field_name",
  );
  assert_includes(
    dynamic_control_annotated_nested_struct_binding_ic,
    "field_first",
  );
  assert_includes(
    dynamic_control_annotated_nested_struct_binding_ic,
    "if input_share01 then 0:i32",
  );

  const dynamic_control_annotated_struct_block_if_let_binding_source = `
type MaybeType = | \`Some Int | \`None Unit
const maybe_type = MaybeType

const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int
}

let maybe: maybe_type = source
let total = 33

for i in 0..2 {
  if i == input {
    break
  }

  let user: user_type = {
    let selected = if let \`Some found = maybe {
      (&input_user)    } else {
      scratch { other_user }
    }

    return selected
  }

  total = user.age
}

total
`;

  const dynamic_control_annotated_struct_block_if_let_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(
      compile(dynamic_control_annotated_struct_block_if_let_binding_source),
    ),
  );
  assert_includes(
    dynamic_control_annotated_struct_block_if_let_binding_ic,
    "field_age",
  );
  assert_includes(
    dynamic_control_annotated_struct_block_if_let_binding_ic,
    "input_user",
  );
  assert_includes(
    dynamic_control_annotated_struct_block_if_let_binding_ic,
    "other_user",
  );

  const dynamic_control_annotated_union_block_if_let_binding_source = `
type MaybeType = | \`Some Int | \`None Unit
const maybe_type = MaybeType

type OptionType = | \`Ok Int | \`Err Unit
const option_type = OptionType

let maybe: maybe_type = source
let total = 33

for i in 0..2 {
  if i == input {
    break
  }

  let option: option_type = {
    let selected = if let \`Some found = maybe {
      (&input_option)    } else {
      scratch { other_option }
    }

    return selected
  }

  if let \`Ok value = option {
    total = value
  }
}

total
`;

  const dynamic_control_annotated_union_block_if_let_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(
      compile(dynamic_control_annotated_union_block_if_let_binding_source),
    ),
  );
  assert_includes(
    dynamic_control_annotated_union_block_if_let_binding_ic,
    "payload_Ok",
  );
  assert_includes(
    dynamic_control_annotated_union_block_if_let_binding_ic,
    "input_option",
  );
  assert_includes(
    dynamic_control_annotated_union_block_if_let_binding_ic,
    "other_option",
  );

  const dynamic_control_const_call_binding_source = `
const id = x => x
let total = 0

for i in 0..2 {
  if input {
    break
  }

  let amount = id(i + 1)
  total = total + amount
}

total
`;

  const dynamic_control_const_call_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_const_call_binding_source)),
  );
  assert_equals(
    dynamic_control_const_call_binding_ic,
    `! input_share0 &share_input_0 = input;
if input_share01 then 0:i32 else if input_share00 then 1:i32 else 3:i32`,
  );

  const dynamic_control_struct_call_binding_source = `
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .label= Text
}

const make = x => {
  [.first = x + 1, .label = "ok"] as pair_type
}

let total = 0

for i in 0..2 {
  if input {
    break
  }

  let pair = make(i)
  total = total + pair.first + @len(pair.label)
}

total
`;

  const dynamic_control_struct_call_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_struct_call_binding_source)),
  );
  assert_equals(
    dynamic_control_struct_call_binding_ic,
    `! input_share0 &share_input_0 = input;
if input_share01 then 0:i32 else if input_share00 then 3:i32 else 7:i32`,
  );

  const dynamic_control_struct_block_call_binding_source = `
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .label= Text
}

const make = x => {
  [.first = x + 1, .label = "ok"] as pair_type
}

let total = 0

for i in 0..2 {
  if input {
    break
  }

  let pair = {
    let made = make(i)
    made
  }
  total = total + pair.first + @len(pair.label)
}

total
`;

  const dynamic_control_struct_block_call_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_struct_block_call_binding_source)),
  );
  assert_equals(
    dynamic_control_struct_block_call_binding_ic,
    `! input_share0 &share_input_0 = input;
if input_share01 then 0:i32 else if input_share00 then 3:i32 else 7:i32`,
  );

  const dynamic_control_union_block_call_binding_source = `
type ResultType = | \`Ok Int | \`Err Text
const result_type = ResultType

const make = x => {
  \`Ok (x + 1)
}

let total = 0

for i in 0..2 {
  if input {
    break
  }

  let result = {
    let made = make(i)
    made
  }

  if let \`Ok value = result {
    total = total + value
  }
}

total
`;

  const dynamic_control_union_block_call_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_union_block_call_binding_source)),
  );
  assert_equals(
    dynamic_control_union_block_call_binding_ic,
    `! input_share0 &share_input_0 = input;
if input_share01 then 0:i32 else if input_share00 then 1:i32 else 3:i32`,
  );

  const dynamic_control_no_else_union_binding_source = `
type ResultType = | \`Ok Int | \`Err Text
const result_type = ResultType

let total = 0

for i in 0..2 {
  if input {
    break
  }

  let result = if flag {
    \`Ok (i + 1)
  }

  if let \`Ok value = result {
    total = total + value
  }
}

total
`;

  const dynamic_control_no_else_union_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_no_else_union_binding_source)),
  );
  assert_equals(
    dynamic_control_no_else_union_binding_ic,
    `! input_share0 &share_input_0 = input;
! flag_share0 &share_flag_0 = flag;
if input_share01 then 0:i32 else ! total#1_share0 &share_total_1_0 = 0:i32 + if flag_share00 then 1:i32 else 0:i32;
if input_share00 then total#1_share00 else total#1_share01 + if flag_share01 then 2:i32 else 0:i32`,
  );

  const dynamic_control_no_else_if_let_union_binding_source = `
type ResultType = | \`Ok Int | \`Err Unit
const result_type = ResultType

type MaybeType = | \`Some Int | \`None Unit
const maybe_type = MaybeType

let total = 0

for i in 0..1 {
  if input {
    break
  }

  let maybe = if flag {
    \`Some (1)
  } else {
    \`None ()
  }

  let result = if let \`Some value = maybe {
    \`Ok (value + 1)
  }

  if let \`Ok amount = result {
    total = total + amount
  }
}

total
`;

  const dynamic_control_no_else_if_let_union_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_no_else_if_let_union_binding_source)),
  );
  assert_equals(
    dynamic_control_no_else_if_let_union_binding_ic,
    "if input then 0:i32 else if flag then 2:i32 else 0:i32",
  );

  const dynamic_control_no_else_if_let_text_binding_source = `
type MaybeType = | \`Some Text | \`None Unit
const maybe_type = MaybeType

let maybe: maybe_type = source
let total = 0

for i in 0..1 {
  if input {
    break
  }

  let text = if let \`Some value = maybe {
    value
  }

  total = total + @len(text)
}

total
`;

  const dynamic_control_no_else_if_let_text_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_no_else_if_let_text_binding_source)),
  );
  assert_equals(
    dynamic_control_no_else_if_let_text_binding_ic,
    'if input then 0:i32 else 0:i32 + load(((source)(λpayload_Some#0. payload_Some#0))(λpayload_None#0. ""))',
  );

  const dynamic_control_no_else_if_let_struct_binding_source = `
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int
}

type MaybeType = | \`Some user_type | \`None Unit
const maybe_type = MaybeType

let maybe: maybe_type = source
let total = 0

for i in 0..1 {
  if input {
    break
  }

  let user = if let \`Some value = maybe {
    value
  }

  total = total + user.age
}

total
`;

  const dynamic_control_no_else_if_let_struct_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_no_else_if_let_struct_binding_source)),
  );
  assert_equals(
    dynamic_control_no_else_if_let_struct_binding_ic,
    "if input then 0:i32 else 0:i32 + (((source)(λpayload_Some#0. payload_Some#0))(λpayload_None#0. λpick#0. (pick#0)(0:i32)))(λfield_age#0. field_age#0)",
  );

  const dynamic_control_shorthand_if_let_union_binding_source = `
type MaybeType = | \`Some Int | \`None Unit
const maybe_type = MaybeType

let maybe: maybe_type = source
let total = 33

for i in 0..1 {
  if i == input {
    break
  }

  let result = if let \`Some value = maybe {
    \`Ok (value)
  }

  if let \`Ok amount = result {
    total = amount
  }
}

total
`;

  const dynamic_control_shorthand_if_let_union_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_shorthand_if_let_union_binding_source)),
  );
  assert_includes(
    dynamic_control_shorthand_if_let_union_binding_ic,
    "0:i32 == input",
  );
  assert_includes(
    dynamic_control_shorthand_if_let_union_binding_ic,
    "λcase_Ok",
  );
  assert_includes(
    dynamic_control_shorthand_if_let_union_binding_ic,
    "λpayload_Ok",
  );

  const dynamic_control_const_binding_source = `
let total = 0

for i in 0..3 {
  if input {
    break
  }

  const amount = i + 1
  total = total + amount
}

total
`;

  const dynamic_control_const_binding_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_const_binding_source)),
  );
  assert_equals(
    dynamic_control_const_binding_ic,
    `! input_share0 &share_input_0 = input;
! input_share1 &share_input_1 = input_share01;
if input_share11 then 0:i32 else if input_share10 then 1:i32 else if input_share00 then 3:i32 else 6:i32`,
  );

  const dynamic_control_const_function_source = `
let total = 41

for i in 0..3 {
  if input {
    break
  }

  const f = x => x
  total = f(total)
}

total
`;

  const dynamic_control_const_function_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_const_function_source)),
  );
  assert_includes(dynamic_control_const_function_ic, "41:i32");
  assert_equals(dynamic_control_const_function_ic.includes("f#"), false);

  const dynamic_control_nested_loop_source = `
for i in 0..3 {
  if input {
    break
  }

  for j in 0..2 {
    j
  }
}

1
`;

  const dynamic_control_nested_loop_core = Source.core(
    "let input = 1\n" + dynamic_control_nested_loop_source,
  );
  assert_equals(
    dynamic_control_nested_loop_core.statements[1]?.tag,
    "range_loop",
  );

  const dynamic_control_nested_loop_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_nested_loop_source)),
  );
  assert_includes(dynamic_control_nested_loop_ic, "1:i32");

  const dynamic_control_nested_loop_guard_source = `
let total = 0

for i in 0..3 {
  if input {
    break
  }

  for j in 0..2 {
    total = total + 1
  }
}

total
`;

  const dynamic_control_nested_loop_guard_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_nested_loop_guard_source)),
  );
  assert_equals(
    dynamic_control_nested_loop_guard_ic,
    `! input_share0 &share_input_0 = input;
! input_share1 &share_input_1 = input_share01;
if input_share11 then 0:i32 else if input_share10 then 2:i32 else if input_share00 then 4:i32 else 6:i32`,
  );

  const dynamic_control_nested_collection_source = `
const xs = [.first = 10, .second = 20]

let total = 0

for i in 0..3 {
  if input {
    break
  }

  for x in xs {
    total = total + x
  }
}

total
`;

  const dynamic_control_nested_collection_ic = Format.fmt(
    Ic,
    Ic.reduce(compile(dynamic_control_nested_collection_source)),
  );
  assert_equals(
    dynamic_control_nested_collection_ic,
    `! input_share0 &share_input_0 = input;
! input_share1 &share_input_1 = input_share01;
if input_share11 then 0:i32 else if input_share10 then 30:i32 else if input_share00 then 60:i32 else 90:i32`,
  );

  const structured_source = `
let n = 5
let sum = 0

for i in 0..n {
  sum = sum + i
}

sum
`;

  const structured_mod = Source.mod(structured_source);
  assert_equals(structured_mod.exports, ["main"]);

  const structured_wat = Source.wat(structured_source);
  assert_includes(structured_wat, "(module");
  assert_includes(structured_wat, "(func $main (result i32)");
  assert_includes(structured_wat, "loop $range_loop_0");

  assert_throws(
    () =>
      compile(`
for i in 0..10 by 0 {
  i
}

0
`),
    "for step must be nonzero",
  );

  assert_throws(
    () =>
      compile(`
for i in 0..2 {
  i = i + 1
}

0
`),
    "Loop index is read-only: i",
  );

  assert_throws(
    () =>
      compile(`
for x in xs {
  x
}

0
`),
    "use Source.core, Source.mod, or Source.wat",
  );

  const unknown_collection_core = Source.core(Source.parse(`
let xs = 1
let total = 0

for x in xs {
  total = total + x
}

total
`));

  assert_equals(
    Format.fmt(Core, unknown_collection_core),
    "let xs = 1:i32\nlet total = 0:i32\ncollection_loop x in xs carry [total] {\n  total = total i32.add x\n}\ntotal",
  );

  assert_throws(
    () =>
      compile(`
const xs = [.first = 1]

for x in xs {
  x = x + 1
}

0
`),
    "Loop item is read-only: x",
  );

  assert_throws(
    () =>
      compile(`
for i, x in xs {
  x
}

0
`),
    "use Source.core, Source.mod, or Source.wat",
  );

  const indexed_unknown_collection_core = Source.core(Source.parse(`
let xs = 1
let total = 0
for i, x in xs {
  total = total + i + x
}

total
`));

  assert_equals(
    Format.fmt(Core, indexed_unknown_collection_core),
    "let xs = 1:i32\nlet total = 0:i32\ncollection_loop i, x in xs carry [total] {\n  total = total i32.add i i32.add x\n}\ntotal",
  );

  assert_throws(
    () =>
      compile(`
const xs = [.first = 1]

for i, x in xs {
  i = i + 1
}

0
`),
    "Loop index is read-only: i",
  );

  assert_throws(
    () => compile("break"),
    "Cannot lower break outside static range loop",
  );

  assert_throws(
    () => compile("continue"),
    "Cannot lower continue outside static range loop",
  );
});
