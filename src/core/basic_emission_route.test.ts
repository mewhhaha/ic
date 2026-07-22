import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Core } from "../core.ts";
import { TestSource as Source } from "../frontend/test_source.ts";
import { Mod } from "../mod.ts";
import { Data, Emit, Format, Typed } from "../trait.ts";

Deno.test("Core allocation scopes number blocks and loops independently", () => {
  const core = Source.core(Source.parse(`
if true {
  let ignored = 0
}

let result = loop {
  let text: Text = @append("a", "b")
  break @len(text)
}
result
`));
  const proof = Core.proof(core);

  assert_equals(proof.ok, true);
  assert_equals(
    proof.allocations.facts.map((fact) => {
      return { scope: fact.scope, owner: fact.owner };
    }),
    [{ scope: "loop#0", owner: "text" }],
  );
  Core.check_proof(core);
});

Deno.test("Core.emit evaluates range bounds and dynamic steps once", () => {
  const core = Source.core(Source.parse(`
let n = 6
let step = 2
let sum = 0

for i in 0..n by step {
  sum = sum + i
}

sum
`));

  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $_range_end#0 i32)");
  assert_includes(wat, "(local $_range_step#0 i32)");
  assert_includes(wat, "local.set $_range_end#0");
  assert_includes(wat, "local.set $_range_step#0");
  assert_includes(wat, "i32.eqz");
  assert_includes(wat, "if (result i32)");
  assert_includes(wat, "i32.gt_s");
  assert_includes(wat, "i32.le_s");
});

Deno.test("Core.emit emits conditional break and continue in range loops", () => {
  const core = Source.core(Source.parse(`
let n = 5
let sum = 0

for i in 0..n {
  if i == 3 {
    break
  }

  if i == 1 {
    continue
  }

  sum = sum + i
}

sum
`));

  const wat = Emit.emit(Core, core);

  assert_includes(wat, "if");
  assert_includes(wat, "br $range_exit_0");
  assert_includes(wat, "br $range_continue_0");
});

Deno.test("Core.emit lowers type-changing shadowing to fresh locals", () => {
  const core = Source.core(Source.parse(`
let x = 1
x := 2i64
x
`));
  const wat = Emit.emit(Core, core);

  assert_equals(
    Format.fmt(Core, core),
    [
      "let _x#shadow0 = 2:i64",
      "_x#shadow0",
    ].join("\n"),
  );
  assert_equals(Typed.type(Core, core), "i64");
  assert_includes(wat, "(local $_x#shadow0 i64)");
  assert_includes(wat, "local.set $_x#shadow0");
  assert_includes(wat, "local.get $_x#shadow0");
});

Deno.test("Core.emit lowers closure-local type-changing shadowing", () => {
  const core = Source.core(Source.parse(`
let choose = flag => {
  let value = 1
  value := 2i64
  if flag {
    value
  } else {
    3i64
  }
}

choose(1)
`));
  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i64");
  assert_includes(wat, "(local $_local__value#shadow");
  assert_includes(wat, "i64.const 2");
});

Deno.test("nested static calls shadow same-named parameters", () => {
  const core = Source.core(Source.parse(`
let inner = (value: I64) => value
let outer = (value: I32) => inner(42i64)
outer(0)
`));
  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i64");
  assert_includes(wat, "i64.const 42");
});

Deno.test("Core.emit retags numeric primitives from operand facts", () => {
  const core = Source.core(Source.parse(`
let factor: I64 = 2i64
let add_factor = (x: I64) => {
  x + factor
}

add_factor(40i64)
`));
  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i64");
  assert_includes(wat, "i64.add");

  const chained_core = Source.core(Source.parse(`
let factor: I64 = 2i64
let add_factor = (x: I64) => {
  x + factor + 1i64
}

add_factor(40i64)
`));
  const chained_wat = Emit.emit(Core, chained_core);

  assert_equals(Typed.type(Core, chained_core), "i64");
  assert_includes(chained_wat, "i64.const 1");
  assert_includes(chained_wat, "i64.add");

  const dynamic_branch_core = Source.core(Source.parse(`
let flag = true
let factor: I64 = 2i64
let choose = (x: I64) => {
  if flag {
    x + factor
  } else {
    x + factor + 1i64
  }
}

choose(40i64)
`));
  const dynamic_branch_wat = Emit.emit(Core, dynamic_branch_core);

  assert_equals(Typed.type(Core, dynamic_branch_core), "i64");
  assert_includes(dynamic_branch_wat, "if (result i64)");
  assert_includes(dynamic_branch_wat, "i64.add");

  const implicit_wide_fallback_core = Source.core(Source.parse(`
let input = 1
let value = if input {
  42i64
}

value
`));
  const implicit_wide_fallback_wat = Emit.emit(
    Core,
    implicit_wide_fallback_core,
  );

  assert_equals(Typed.type(Core, implicit_wide_fallback_core), "i64");
  assert_includes(implicit_wide_fallback_wat, "if (result i64)");
  assert_includes(implicit_wide_fallback_wat, "i64.const 0");

  const cmp_core = Source.core(Source.parse(`
let limit: I64 = 5i64
let below = (x: I64) => {
  x < limit
}

below(3i64)
`));
  const cmp_wat = Emit.emit(Core, cmp_core);

  assert_equals(Typed.type(Core, cmp_core), "i32");
  assert_includes(cmp_wat, "i64.lt_s");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let factor: I64 = 2i64
let add_one = (x: I64) => {
  x + 1
}

add_one(40i64)
`)),
      ),
    "Mixed i32 and i64 operands for operator +",
  );
});

Deno.test("Core.from_source specializes division between named I64 locals", () => {
  const core = Source.core(Source.parse(`
let maximum: I64 = 9223372036854775807i64
let divisor: I64 = 2i64
if 1i64 > maximum / divisor { 1 } else { 0 }
`));

  assert_includes(Format.fmt(Core, core), "maximum i64.div_s divisor");
  assert_includes(Emit.emit(Core, core), "i64.div_s");
});

Deno.test("Core.from_source specializes arithmetic between named F64 locals", () => {
  const core = Source.core(Source.parse(`
let offset: F64 = 20.5f64
let add_offset = (value: F64) => value + offset
add_offset(21.5f64)
`));
  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "f64");
  assert_includes(Format.fmt(Core, core), "value f64.add offset");
  assert_includes(wat, "f64.add");
});

Deno.test("Core.emit lowers dynamic tail recursion to loops", () => {
  const core = Source.core(Source.parse(`
let sum_down = rec (n, total) => {
  if n == 0 {
    total
  } else {
    rec(n - 1, total + n)
  }
}

let input = 4
sum_down(input, 0)
`));
  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $n i32)");
  assert_includes(wat, "(local $total i32)");
  assert_includes(wat, "block $rec_exit_0 (result i32)");
  assert_includes(wat, "loop $rec_loop_0");
  assert_includes(wat, "br $rec_exit_0");
  assert_includes(wat, "br $rec_loop_0");
});

Deno.test("Core.emit unrolls static collection loops", () => {
  const core = Source.core(Source.parse(`
let sum = 0

for i, x in [.first = 10, .second = 32] {
  if i == 1 {
    continue
  }

  sum = sum + x
}

sum
`));

  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $sum i32)");
  assert_includes(wat, "(local $i i32)");
  assert_includes(wat, "(local $x i32)");
  assert_includes(wat, "block $collection_exit_0");
  assert_includes(wat, "block $collection_continue_0_0");
  assert_includes(wat, "block $collection_continue_0_1");
  assert_includes(wat, "local.set $x");
  assert_includes(wat, "br $collection_continue_0_1");

  const dynamic_core = Source.core(Source.parse(`
let flag = true
let sum = 0

for i, x in if flag {
  [.first = 10, .second = 20]
} else {
  [.first = 1, .second = 2]
} {
  sum = sum + i + x
}

sum
`));
  const dynamic_wat = Emit.emit(Core, dynamic_core);

  assert_equals(Typed.type(Core, dynamic_core), "i32");
  assert_includes(dynamic_wat, "block $collection_exit_0");
  assert_includes(dynamic_wat, "local.get $flag");
  assert_includes(dynamic_wat, "if (result i32)");
  assert_includes(dynamic_wat, "i32.const 10");
  assert_includes(dynamic_wat, "i32.const 1");

  const const_call_core = Source.core(Source.parse(`
let flag = true
let sum = 0

const make_xs = active => {
  if active {
    [.first = 10, .second = 20]
  } else {
    [.first = 1, .second = 2]
  }
}

for i, x in make_xs(flag) {
  sum = sum + i + x
}

sum
`));
  const const_call_wat = Emit.emit(Core, const_call_core);

  assert_equals(Typed.type(Core, const_call_core), "i32");
  assert_includes(const_call_wat, "block $collection_exit_0");
  assert_includes(const_call_wat, "local.get $flag");
  assert_includes(const_call_wat, "if (result i32)");
  assert_includes(const_call_wat, "i32.const 10");
  assert_includes(const_call_wat, "i32.const 1");
});

Deno.test("Core.emit lowers visible text collection loops", () => {
  const core = Source.core(Source.parse(`
let total = 0

for i, byte in "Ada" {
  if i == 1 {
    continue
  }

  total = total + byte
}

total
`));
  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $_text_value#0 i32)");
  assert_includes(wat, "(local $_text_end#0 i32)");
  assert_includes(wat, "block $text_collection_exit_0");
  assert_includes(wat, "loop $text_collection_loop_0");
  assert_includes(wat, "block $text_collection_continue_0");
  assert_includes(wat, "i32.load8_u");
  assert_includes(wat, "br $text_collection_continue_0");

  const runtime_core = Source.core(Source.parse(`
let flag = true
let sum_text = if flag {
  (value: Text) => {
    let total = 0

    for i, byte in value {
      total = total + i + byte
    }

    total
  }
} else {
  (value: Text) => @len(value)
}

sum_text("Ada")
`));
  const runtime_wat = Emit.emit(Mod, Core.mod(runtime_core));

  assert_equals(Typed.type(Core, runtime_core), "i32");
  assert_includes(runtime_wat, "call_indirect");
  assert_includes(runtime_wat, "loop $text_collection_loop_");
  assert_includes(runtime_wat, "i32.load8_u");
});

Deno.test("Core.emit types static-call block collection locals", () => {
  const core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

const sum = (pair: pair_type) => {
  let total = 0

  for i, x in pair {
    total = total + i + x
  }

  total
}

sum([.first = 10, .second = 31])
`));

  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $_local_total#0 i32)");
  assert_includes(wat, "(local $_local_i#1 i32)");
  assert_includes(wat, "(local $_local_x#2 i32)");
  assert_includes(wat, "block $collection_exit_0");
  assert_includes(wat, "i32.const 31");
  assert_includes(wat, "local.get $_local_total#0");

  const let_closure_core = Source.core(Source.parse(`
let add = x => x + 1
add(41)
`));

  assert_equals(Typed.type(Core, let_closure_core), "i32");
  assert_equals(
    Emit.emit(Core, let_closure_core),
    "\ni32.const 41\ni32.const 1\ni32.add",
  );

  const captured_closure_core = Source.core(Source.parse(`
let factor = 2
let scale = x => x + factor
factor = 3
scale(10)
`));
  const captured_closure_wat = Emit.emit(Core, captured_closure_core);

  assert_equals(Typed.type(Core, captured_closure_core), "i32");
  assert_includes(captured_closure_wat, "(local $_capture_factor#0 i32)");
  assert_includes(captured_closure_wat, "local.set $_capture_factor#0");
  assert_includes(captured_closure_wat, "local.get $_capture_factor#0");

  const param_assign_core = Source.core(Source.parse(`
let inc = x => {
  x = x + 1
  x
}

inc(1)
`));
  const param_assign_wat = Emit.emit(Core, param_assign_core);

  assert_equals(Typed.type(Core, param_assign_core), "i32");
  assert_includes(param_assign_wat, "(local $_arg_x#0 i32)");
  assert_includes(param_assign_wat, "local.set $_arg_x#0");
  assert_includes(param_assign_wat, "local.get $_arg_x#0");

  const local_shadow_core = Source.core(Source.parse(`
let factor = 2
let f = x => {
  let factor = x
  factor
}

f(10) + factor
`));
  const local_shadow_wat = Emit.emit(Core, local_shadow_core);

  assert_equals(Typed.type(Core, local_shadow_core), "i32");
  assert_includes(local_shadow_wat, "(local $factor i32)");
  assert_includes(local_shadow_wat, "(local $_local_");
  assert_includes(local_shadow_wat, "factor");
  assert_includes(local_shadow_wat, "local.get $factor");

  const assigned_capture_core = Source.core(Source.parse(`
let factor = 2
let f = x => {
  factor = factor + x
  factor
}

factor = 100
f(10) + f(20) + factor
`));
  const assigned_capture_wat = Emit.emit(Core, assigned_capture_core);

  assert_equals(Typed.type(Core, assigned_capture_core), "i32");
  assert_includes(assigned_capture_wat, "(local $_capture_factor#0 i32)");
  assert_includes(
    assigned_capture_wat,
    "(local $_capture__capture_factor#0#1 i32)",
  );
  assert_includes(assigned_capture_wat, "local.set $_capture_factor#0");
  assert_includes(
    assigned_capture_wat,
    "local.set $_capture__capture_factor#0#1",
  );

  const changed_capture_core = Source.core(Source.parse(`
let factor = 2
let bad = x => {
  let factor = 1i64
  factor
}
bad(10)
`));
  const changed_capture_wat = Emit.emit(Core, changed_capture_core);

  assert_equals(Typed.type(Core, changed_capture_core), "i64");
  assert_includes(changed_capture_wat, "(local $_local_");
  assert_includes(changed_capture_wat, "factor");
  assert_includes(changed_capture_wat, "i64)");
  assert_includes(changed_capture_wat, "i64.const 1");
});

Deno.test("Core.mod specializes direct closures and tables capturing closures", () => {
  const dynamic_core = Source.core(Source.parse(`
let flag = true
let f = if flag {
  (x: Int) => x + 1
} else {
  (x: Int) => x + 2
}

f(40)
`));
  const dynamic_wat = Emit.emit(Mod, Core.mod(dynamic_core));

  assert_equals(Typed.type(Core, dynamic_core), "i32");
  assert_includes(dynamic_wat, "if (result i32)");
  assert_includes(dynamic_wat, "i32.add");

  const capture_core = Source.core(Source.parse(`
let flag = false
let n = 2
let f = if flag {
  (x: Int) => x + n
} else {
  (x: Int) => x + n + 1
}

n = 100
f(40)
`));
  const capture_wat = Emit.emit(Mod, Core.mod(capture_core));

  assert_equals(Typed.type(Core, capture_core), "i32");
  assert_includes(capture_wat, "i32.store offset=4");
  assert_includes(capture_wat, "i32.load offset=4");
  assert_includes(capture_wat, "local.set $__capture_0_n");
  assert_includes(capture_wat, "call_indirect (type $closure_i32_i32_to_i32)");

  const dynamic_text_capture_core = Source.core(Source.parse(`
let flag = true
let message: Text = if flag {
  "Ada"
} else {
  "Grace"
}
let f = if flag {
  (x: Int) => @len(message) + x
} else {
  (x: Int) => x
}

f(1)
`));
  const dynamic_text_capture_wat = Emit.emit(
    Mod,
    Core.mod(dynamic_text_capture_core),
  );

  assert_equals(Typed.type(Core, dynamic_text_capture_core), "i32");
  assert_includes(dynamic_text_capture_wat, "i32.store offset=4");
  assert_includes(dynamic_text_capture_wat, "i32.load offset=4");
  assert_includes(
    dynamic_text_capture_wat,
    "__if_cond#0",
  );
  assert_includes(
    dynamic_text_capture_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );

  const helper_text_capture_core = Source.core(Source.parse(`
let flag = true
let message: Text = if flag {
  "Ada"
} else {
  "Grace"
}
let make = (value: Text) => {
  if flag {
    (x: Int) => @len(value) + x
  } else {
    (x: Int) => x
  }
}

let f = make(message)
f(1)
`));
  const helper_text_capture_wat = Emit.emit(
    Mod,
    Core.mod(helper_text_capture_core),
  );

  assert_equals(Typed.type(Core, helper_text_capture_core), "i32");
  Core.check_proof(helper_text_capture_core);
  assert_includes(
    helper_text_capture_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );

  const captured_closure_core = Source.core(Source.parse(`
let flag = true
let add = freeze (if flag {
  (x: Int) => x + 1
} else {
  (x: Int) => x + 2
})
let run = (y: Int) => add(y) + 10

run(30)
`));
  const captured_closure_wat = Emit.emit(
    Mod,
    Core.mod(captured_closure_core),
  );

  assert_equals(Typed.type(Core, captured_closure_core), "i32");
  assert_includes(captured_closure_wat, "local.set $_capture_add#");
  assert_includes(
    captured_closure_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );

  const assigned_capture_core = Source.core(Source.parse(`
let flag = true
let factor = 2
let f = if flag {
  (x: Int) => {
    factor = factor + x
    factor
  }
} else {
  (x: Int) => {
    factor = factor + x + 1
    factor
  }
}

factor = 100
f(10) + f(20)
`));
  const assigned_capture_wat = Emit.emit(
    Mod,
    Core.mod(assigned_capture_core),
  );

  assert_equals(Typed.type(Core, assigned_capture_core), "i32");
  assert_includes(assigned_capture_wat, "i32.load offset=4");
  assert_includes(assigned_capture_wat, "local.set $__capture_0_factor");
  assert_includes(
    assigned_capture_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );

  const direct_assigned_capture_core = Source.core(Source.parse(`
let factor = 2
let f = (x: Int) => {
  factor = factor + x
  factor
}

f(10) + f(20)
`));
  const direct_assigned_capture_wat = Emit.emit(
    Mod,
    Core.mod(direct_assigned_capture_core),
  );

  assert_equals(Typed.type(Core, direct_assigned_capture_core), "i32");
  assert_includes(direct_assigned_capture_wat, "local.set $_capture_factor#");
  assert_includes(
    direct_assigned_capture_wat,
    "local.set $_capture__capture_factor#",
  );

  const returned_closure_core = Source.core(Source.parse(`
let make = n => {
  let offset = n + 1
  (x: Int) => x + offset
}

let f = make(1)
f(40)
`));
  const returned_closure_wat = Emit.emit(
    Mod,
    Core.mod(returned_closure_core),
  );

  assert_equals(Typed.type(Core, returned_closure_core), "i32");
  assert_includes(returned_closure_wat, "(table $__closure_table 1 funcref)");
  assert_includes(returned_closure_wat, "i32.store offset=4");
  assert_includes(returned_closure_wat, "i32.load offset=4");
  assert_includes(
    returned_closure_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );

  const returned_wide_closure_core = Source.core(Source.parse(`
let make = (n: I64) => {
  let offset: I64 = n + 1i64
  (x: I64) => x + offset
}

let f = make(1i64)
f(40i64)
`));
  const returned_wide_closure_wat = Emit.emit(
    Mod,
    Core.mod(returned_wide_closure_core),
  );

  assert_equals(Typed.type(Core, returned_wide_closure_core), "i64");
  assert_includes(
    returned_wide_closure_wat,
    "(type $closure_i32_i64_to_i64",
  );
  assert_includes(returned_wide_closure_wat, "i64.store offset=8");
  assert_includes(returned_wide_closure_wat, "i64.load offset=8");
  assert_includes(
    returned_wide_closure_wat,
    "call_indirect (type $closure_i32_i64_to_i64)",
  );

  const aggregate_param_closure_core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const user_type = struct { .age= Int }
const user_alias = user_type

let make = flag => {
  if flag {
    (user: user_type) => user.age + 1
  } else {
    (user: user_alias) => user.age + 2
  }
}

let f = make(0)
f([.age = 40] as user_type)
`));
  const aggregate_param_closure_wat = Emit.emit(
    Mod,
    Core.mod(aggregate_param_closure_core),
  );

  assert_equals(Core.proof(aggregate_param_closure_core).issues, []);
  assert_equals(Typed.type(Core, aggregate_param_closure_core), "i32");
  assert_includes(
    aggregate_param_closure_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );

  const union_param_closure_core = Source.core(Source.parse(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType
const result_alias = result_type

let make = flag => {
  if flag {
    (result: result_type) => if let \`Ok value = result { value + 1 } else { 0 }
  } else {
    (result: result_alias) => if let \`Ok value = result { value + 2 } else { 0 }
  }
}

let f = make(0)
f(\`Ok (40))
`));
  const union_param_closure_wat = Emit.emit(
    Mod,
    Core.mod(union_param_closure_core),
  );

  assert_equals(Core.proof(union_param_closure_core).issues, []);
  assert_equals(Typed.type(Core, union_param_closure_core), "i32");
  assert_includes(
    union_param_closure_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );

  const captured_text_assign_core = Source.core(Source.parse(`
let run = (text: Bytes, flag: Int) => {
  let f = if flag {
    (byte: Int) => {
      text[0] = byte
      text[0]
    }
  } else {
    (byte: Int) => text[0]
  }

  f(90)
}

run(@Utf8.encode("Ada"), 1)
`));
  const captured_text_assign_wat = Emit.emit(
    Mod,
    Core.mod(captured_text_assign_core),
  );

  assert_equals(Typed.type(Core, captured_text_assign_core), "i32");
  assert_includes(
    captured_text_assign_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );
  assert_includes(captured_text_assign_wat, "i32.store8");
  assert_includes(captured_text_assign_wat, "i32.load8_u");

  const invalid_captured_assignment_core = Source.core(Source.parse(`
let flag = true
let x = 1
let f = if flag {
  () => {
    x[0] = 9
    x
  }
} else {
  () => x
}

f()
`));
  const invalid_captured_assignment_message =
    "Core closure captured assignment only supports same-type scalar " +
    "rebinding, runtime Text byte assignment, runtime aggregate scalar/Text " +
    "index assignment, and static aggregate rebuilds";

  assert_equals(
    Core.proof(invalid_captured_assignment_core).issues.map((issue) =>
      issue.message
    ),
    [invalid_captured_assignment_message],
  );
  assert_throws(
    () => Core.check_proof(invalid_captured_assignment_core),
    invalid_captured_assignment_message,
  );
  assert_throws(
    () => Emit.emit(Core, invalid_captured_assignment_core),
    invalid_captured_assignment_message,
  );
  assert_throws(
    () => Core.mod(invalid_captured_assignment_core),
    invalid_captured_assignment_message,
  );

  const one_sided_core = Source.core(Source.parse(`
let flag = true
let f = if flag {
  (x: Int) => x + 1
} else {
  x => x + 2
}

f(40)
`));
  const one_sided_wat = Emit.emit(Mod, Core.mod(one_sided_core));

  assert_equals(Typed.type(Core, one_sided_core), "i32");
  assert_includes(
    one_sided_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );
  assert_includes(one_sided_wat, "i32.const 2");
  assert_includes(one_sided_wat, "i32.add");

  const one_sided_text_core = Source.core(Source.parse(`
let flag = true
let f = if flag {
  (value: Text) => @len(value)
} else {
  value => @len(value) + 1
}

f("Ada")
`));
  const one_sided_text_wat = Emit.emit(Mod, Core.mod(one_sided_text_core));

  assert_equals(Typed.type(Core, one_sided_text_core), "i32");
  assert_includes(
    one_sided_text_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );
  assert_includes(one_sided_text_wat, "i32.load");

  const one_sided_wide_core = Source.core(Source.parse(`
let flag = true
let f = if flag {
  (x: I64) => x + 1i64
} else {
  x => x + 2i64
}

f(40i64)
`));
  const one_sided_wide_wat = Emit.emit(Mod, Core.mod(one_sided_wide_core));

  assert_equals(Typed.type(Core, one_sided_wide_core), "i64");
  assert_includes(
    one_sided_wide_wat,
    "call_indirect (type $closure_i32_i64_to_i64)",
  );
  assert_includes(one_sided_wide_wat, "i64.const 2");

  const if_let_dynamic_target_core = Source.core(Source.parse(`
let flag = true
type ResultType = | \`Ok I32 | \`Err I32
const result_type = ResultType
let f = if let \`Ok value = if flag {
  \`Ok (40)
} else {
  \`Err (1)
} {
  (x: Int) => x + value
} else {
  x => x + 1
}

f(2)
`));
  const if_let_dynamic_target_wat = Emit.emit(
    Mod,
    Core.mod(if_let_dynamic_target_core),
  );

  assert_equals(Typed.type(Core, if_let_dynamic_target_core), "i32");
  assert_includes(
    if_let_dynamic_target_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );
  assert_includes(if_let_dynamic_target_wat, "local.set $value");

  const if_let_runtime_target_core = Source.core(Source.parse(`
let flag = true
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let result: result_type = if flag {
  \`Ok (40)
} else {
  \`Err (1)
}

let f = if let \`Ok value = result {
  (x: Int) => x + value
} else {
  x => x + 1
}

f(2)
`));
  const if_let_runtime_target_wat = Emit.emit(
    Mod,
    Core.mod(if_let_runtime_target_core),
  );

  assert_equals(Typed.type(Core, if_let_runtime_target_core), "i32");
  assert_includes(
    if_let_runtime_target_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );
  assert_includes(if_let_runtime_target_wat, "i32.load");
  assert_includes(if_let_runtime_target_wat, "local.set $value");

  const linear_if_let_runtime_target_core = Source.core(Source.parse(`
let flag = true
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let !base: I32 = 1
let result: result_type = if flag {
  \`Ok (40)
} else {
  \`Err (1)
}

let f = if let \`Ok value = result {
  () => !base + value + 1
} else {
  () => !base + 1
}

base = f()
base
`));
  const linear_if_let_runtime_target_wat = Emit.emit(
    Mod,
    Core.mod(linear_if_let_runtime_target_core),
  );

  assert_equals(Core.proof(linear_if_let_runtime_target_core).issues, []);
  assert_equals(Typed.type(Core, linear_if_let_runtime_target_core), "i32");
  assert_includes(
    linear_if_let_runtime_target_wat,
    "call_indirect (type $closure_i32_to_i32)",
  );
  assert_includes(linear_if_let_runtime_target_wat, "i32.load");
  assert_includes(linear_if_let_runtime_target_wat, "local.set $value");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let flag = true
let f = if flag {
  (value: Int) => value + 1
} else {
  (value: Text) => @len(value)
}

f("Ada")
`)),
      ),
    "Core closure if branch type mismatch",
  );
});

Deno.test("Core.emit resolves static aggregate bindings", () => {
  const core = Source.core(Source.parse(`
let xs = [.first = 10, .second = 20]
let user = [.name = 1, .age = 41]
let total = 0

for i, x in xs {
  total = total + i + x
}

total + xs[1] + user.age
`));

  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $total i32)");
  assert_includes(wat, "(local $i i32)");
  assert_includes(wat, "(local $x i32)");
  assert_includes(wat, "block $collection_exit_0");
  assert_includes(wat, "i32.const 20");
  assert_includes(wat, "i32.const 41");
});

Deno.test("Core.emit lowers dynamic aggregate index expressions", () => {
  const core = Source.core(Source.parse(`
let xs = [.first = 10, .second = 32]
let i = 1

xs[i]
`));

  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "local.get $i");
  assert_includes(wat, "i32.eq");
  assert_includes(wat, "if (result i32)");
  assert_includes(wat, "unreachable");

  assert_throws(
    () =>
      Emit.emit(
        Core,
        Source.core(Source.parse(`
let xs = [.first = 10, .second = 20i64]
let i = 0

xs[i]
`)),
      ),
    "Core collection item type mismatch: i32, got i64",
  );
});

Deno.test("Core.emit lowers nested tuple indexes from runtime aggregate parameters", () => {
  const core = Source.core(Source.parse(`
type Entry = [Text, I64]
type Pair = [Entry, I32]

let rec second: Pair -> I64 = pair => {
  let [entry, _] = pair
  let [_, timestamp] = entry
  timestamp
}

let pair: Pair = [["duck", 42i64], 1]
second(pair)
`));

  const wat = Emit.emit(Mod, Core.mod(core));

  assert_includes(wat, "i64.load");
});

Deno.test("Core.emit lowers static aggregate len and get calls", () => {
  const core = Source.core(Source.parse(`
let xs = [.first = 10, .second = 32]
let i = 1

@len(xs) + @get(xs, i) + @get(xs, 0)
`));
  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "i32.const 2");
  assert_includes(wat, "local.get $i");
  assert_includes(wat, "i32.eq");
  assert_includes(wat, "if (result i32)");
  assert_includes(wat, "i32.const 10");
  assert_includes(wat, "i32.const 32");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let xs = 1
let i = 0
@get(xs, i)
`)),
      ),
    "Cannot type core get over unknown collection",
  );

  assert_throws(
    () =>
      Emit.emit(
        Core,
        Source.core(Source.parse(`
let xs = [.first = 10, .second = 20i64]
let i = 0

@get(xs, i)
`)),
      ),
    "Core collection item type mismatch: i32, got i64",
  );
});

Deno.test("Core.emit lowers runtime aggregate collection facts", () => {
  const core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let flag = true
let make = if flag {
  (first: Int, second: Int) => [.first = first, .second = second] as pair_type
} else {
  (first: Int, second: Int) => [.first = second, .second = first] as pair_type
}

let pair: pair_type = make(10, 31)
let i = 1
let total = 0

for index, value in pair {
  total = total + index + value
}

@len(pair) * 1000 + @get(pair, i) * 100 + pair[0] * 10 + total
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $pair i32)");
  assert_includes(wat, "local.set $pair");
  assert_includes(wat, "i32.const 2");
  assert_includes(wat, "block $collection_exit_");
  assert_includes(wat, "local.set $index");
  assert_includes(wat, "local.set $value");
  assert_includes(wat, "local.get $pair");
  assert_includes(wat, "i32.load offset=0");
  assert_includes(wat, "i32.load offset=4");

  const control_core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let flag = true
let make = if flag {
  (first: Int, second: Int) => [.first = first, .second = second] as pair_type
} else {
  (first: Int, second: Int) => [.first = second, .second = first] as pair_type
}

let pair: pair_type = make(10, 31)
let total = 0

for index, value in pair {
  if index == 0 {
    continue
  }

  total = total + value

  if index == 1 {
    break
  }

  total = total + 100
}

total
`));
  const control_proof = Core.proof(control_core);
  const control_wat = Emit.emit(Mod, Core.mod(control_core));

  assert_equals(control_proof.ok, true);
  assert_equals(control_proof.managed_storage, "disabled");
  assert_equals(Typed.type(Core, control_core), "i32");
  assert_includes(control_wat, "block $collection_exit_");
  assert_includes(control_wat, "block $collection_continue_");
  assert_includes(control_wat, "br $collection_continue_");
  assert_includes(control_wat, "br $collection_exit_");
  assert_includes(control_wat, "local.set $total");

  const nested_core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const scores_type = struct {
  .first= Int,
  .second= Int
}
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .scores= scores_type,
  .bonus= Int
}

let flag = true
let make_scores = if flag {
  () => [.first = 10, .second = 20] as scores_type
} else {
  () => [.first = 1, .second = 2] as scores_type
}
let scores: scores_type = make_scores()
let frozen_scores: scores_type = freeze scores
let make_user = if flag {
  () => [.scores = frozen_scores, .bonus = 1] as user_type
} else {
  () => [.scores = frozen_scores, .bonus = 2] as user_type
}
let user: user_type = make_user()
let total = 0

for index, score in user.scores {
  total = total + index + score
}

total + user.bonus
`));
  const nested_wat = Emit.emit(Mod, Core.mod(nested_core));

  assert_equals(Typed.type(Core, nested_core), "i32");
  assert_includes(nested_wat, "(local $user i32)");
  assert_includes(nested_wat, "block $collection_exit_");
  assert_includes(nested_wat, "local.set $score");
  assert_includes(nested_wat, "local.get $user");
  assert_includes(nested_wat, "i32.load offset=0");
  assert_includes(nested_wat, "i32.load offset=4");
  assert_includes(nested_wat, "i32.load offset=8");
});

Deno.test("Core preserves dynamic indexed runtime union item facts", () => {
  const core = Source.core(Source.parse(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType
const { struct } = import "duck:prelude" ()
const choices_type = struct {
  .first= result_type,
  .second= result_type
}

let flag = true
let make = if flag {
  (first: result_type, second: result_type) => [.first = first, .second = second] as choices_type
} else {
  (first: result_type, second: result_type) => [.first = second, .second = first] as choices_type
}

let choices: choices_type = make(\`Ok (40), \`Err (2))
let index = 1
let picked: result_type = @get(choices, index)
if let \`Ok value = picked {
  value + 2
} else {
  0
}
`));
  const proof = Core.proof(core);
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(proof.ok, true);
  assert_equals(
    proof.drops.steps.map((step) => step.owner),
    ["choices"],
  );
  assert_equals(
    proof.allocations.facts.some((fact) => {
      return fact.ownership.tag === "unique_heap" &&
        fact.ownership.reason === "runtime_union";
    }),
    true,
  );
  assert_includes(wat, "local.get $index");
  assert_includes(wat, "if (result i32)");
  assert_includes(wat, "unreachable");
  assert_includes(wat, "local.set $picked");
  assert_includes(wat, "local.get $picked");
  assert_includes(wat, "i32.load offset=4");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
type FirstType = | \`Ok Int | \`Err Int
const first_type = FirstType
type SecondType = | \`Some Int | \`None Unit
const second_type = SecondType
const { struct } = import "duck:prelude" ()
const mixed_type = struct {
  .first= first_type,
  .second= second_type
}

let mixed: mixed_type = [.first = \`Ok (1), .second = \`Some (2)] as mixed_type
let index = 1
let picked: first_type = @get(mixed, index)
picked
`)),
      ),
    "Core collection item union fact mismatch",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let items = 1
let index = 0
@get(items, index)
`)),
      ),
    "Cannot type core get over unknown collection",
  );
});

Deno.test("Core.emit lowers runtime aggregate scalar index assignment", () => {
  const core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let flag = true
let make = if flag {
  (first: Int, second: Int) => [.first = first, .second = second] as pair_type
} else {
  (first: Int, second: Int) => [.first = second, .second = first] as pair_type
}

let pair: pair_type = make(10, 31)
pair[0] = 40
let i = 1
pair[i] = 2
pair.first + pair.second
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $pair i32)");
  assert_includes(wat, "i32.store offset=0");
  assert_includes(wat, "i32.store offset=4");
  assert_includes(wat, "(local $_aggregate_index#");
  assert_includes(wat, "(local $_aggregate_value#");
  assert_includes(wat, "local.get $i");
  assert_includes(wat, "unreachable");
  assert_includes(wat, "i32.load offset=0");
  assert_includes(wat, "i32.load offset=4");

  assert_throws(
    () =>
      Emit.emit(
        Mod,
        Core.mod(Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let flag = true
let make = if flag {
  (first: Int, second: Int) => [.first = first, .second = second] as pair_type
} else {
  (first: Int, second: Int) => [.first = second, .second = first] as pair_type
}

let pair: pair_type = make(10, 31)
pair[0] = "Ada"
0
`))),
      ),
    "Core runtime aggregate index assignment field first expects i32, got Text",
  );

  assert_throws(
    () =>
      Emit.emit(
        Mod,
        Core.mod(Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let flag = true
let make = if flag {
  (first: Int, second: Int) => [.first = first, .second = second] as pair_type
} else {
  (first: Int, second: Int) => [.first = second, .second = first] as pair_type
}

let pair: pair_type = make(10, 31)
let view = &pair
pair[0] = 40
0
`))),
      ),
    "Cannot mutate borrowed owner pair in program#0 while borrow#0 is active",
  );
});

Deno.test("Core.emit lowers runtime aggregate Text index assignment", () => {
  const core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const names_type = struct {
  .first= Text,
  .second= Text
}

let flag = true
let make = if flag {
  (first: Text, second: Text) => [.first = first, .second = second] as names_type
} else {
  (first: Text, second: Text) => [.first = second, .second = first] as names_type
}

let names: names_type = make("Ada", "Grace")
names[0] = "Edsger"
let i = 1
names[i] = names.first + " Hopper"
@len(names.first) * 100 + @len(names.second)
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $names i32)");
  assert_includes(wat, "i32.store offset=0");
  assert_includes(wat, "i32.store offset=4");
  assert_includes(wat, "(local $_aggregate_index#");
  assert_includes(wat, "(local $_aggregate_value#");
  assert_includes(wat, "local.get $i");
  assert_includes(wat, "unreachable");
  assert_includes(wat, "i32.load offset=0");
  assert_includes(wat, "i32.load offset=4");

  assert_throws(
    () =>
      Emit.emit(
        Mod,
        Core.mod(Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const names_type = struct {
  .first= Text,
  .second= Text
}

let flag = true
let make = if flag {
  (first: Text, second: Text) => [.first = first, .second = second] as names_type
} else {
  (first: Text, second: Text) => [.first = second, .second = first] as names_type
}

let names: names_type = make("Ada", "Grace")
names[0] = 42
0
`))),
      ),
    "Core runtime aggregate index assignment field first expects Text",
  );

  assert_throws(
    () =>
      Emit.emit(
        Mod,
        Core.mod(Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const mixed_type = struct {
  .name= Text,
  .age= Int
}

let flag = true
let make = if flag {
  (name: Text, age: Int) => [.name = name, .age = age] as mixed_type
} else {
  (name: Text, age: Int) => [.name = name, .age = age] as mixed_type
}

let mixed: mixed_type = make("Ada", 36)
let i = 0
mixed[i] = "Grace"
0
`))),
      ),
    "Core runtime aggregate dynamic index assignment field text fact mismatch",
  );
});

Deno.test("Core.emit lowers runtime aggregate union index assignment", () => {
  const core = Source.core(Source.parse(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

const { struct } = import "duck:prelude" ()
const slots_type = struct {
  .first= result_type,
  .second= result_type
}

let flag = true
let make_slots = if flag {
  (first: Int, second: Int) => [.first = \`Ok (first), .second = \`Err (second)] as slots_type
} else {
  (first: Int, second: Int) => [.first = \`Err (first), .second = \`Ok (second)] as slots_type
}
let slots: slots_type = make_slots(1, 2)
slots[0] = \`Err (40)
let i = 1
slots[i] = \`Ok (2)
slots
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $slots i32)");
  assert_includes(wat, "i32.store offset=0");
  assert_includes(wat, "i32.store offset=4");
  assert_includes(wat, "(local $_aggregate_index#");
  assert_includes(wat, "(local $_aggregate_value#");
  assert_includes(wat, "local.get $i");
  assert_includes(wat, "unreachable");

  assert_throws(
    () =>
      Emit.emit(
        Mod,
        Core.mod(Source.core(Source.parse(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

const { struct } = import "duck:prelude" ()
const slots_type = struct {
  .first= result_type,
  .second= result_type
}

let flag = true
let make_slots = if flag {
  (first: Int, second: Int) => [.first = \`Ok (first), .second = \`Err (second)] as slots_type
} else {
  (first: Int, second: Int) => [.first = \`Err (first), .second = \`Ok (second)] as slots_type
}
let slots: slots_type = make_slots(1, 2)
slots[0] = 42
0
`))),
      ),
    "Core runtime aggregate index assignment field first expects a matching union value",
  );

  assert_throws(
    () =>
      Emit.emit(
        Mod,
        Core.mod(Source.core(Source.parse(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

const { struct } = import "duck:prelude" ()
const mixed_type = struct {
  .result= result_type,
  .count= Int
}

let flag = true
let make_mixed = if flag {
  (value: Int, count: Int) => [.result = \`Ok (value), .count = count] as mixed_type
} else {
  (value: Int, count: Int) => [.result = \`Err (value), .count = count] as mixed_type
}
let mixed: mixed_type = make_mixed(1, 2)
let i = 0
mixed[i] = \`Err (4)
0
`))),
      ),
    "Core runtime aggregate dynamic index assignment field text fact mismatch",
  );
});

Deno.test("Core rejects runtime aggregate union mutation closure capture", () => {
  const core = Source.core(Source.parse(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

const { struct } = import "duck:prelude" ()
const slots_type = struct {
  .first= result_type,
  .second= result_type
}

let flag = true
let make_slots = if flag {
  (first: Int, second: Int) => [.first = \`Ok (first), .second = \`Err (second)] as slots_type
} else {
  (first: Int, second: Int) => [.first = \`Err (first), .second = \`Ok (second)] as slots_type
}
let slots: slots_type = make_slots(1, 2)
let write = (i: Int, value: Int) => {
  slots[i] = \`Ok (value)
  0
}

write(1, 2)
slots
`));
  assert_throws(
    () => Emit.emit(Mod, Core.mod(core)),
    "unique_heap runtime_aggregate capture requires linear closure ownership " +
      "support",
  );
});

Deno.test("Core.emit lowers runtime aggregate nested index assignment", () => {
  const core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .left= Int,
  .right= Int
}

const { struct } = import "duck:prelude" ()
const slots_type = struct {
  .first= pair_type,
  .second= pair_type
}

let flag = true
let make_slots = if flag {
  (a: Int, b: Int, c: Int, d: Int) => [.first = [.left = a, .right = b] as pair_type, .second = [.left = c, .right = d] as pair_type] as slots_type
} else {
  (a: Int, b: Int, c: Int, d: Int) => [.first = [.left = c, .right = d] as pair_type, .second = [.left = a, .right = b] as pair_type] as slots_type
}

let slots: slots_type = make_slots(1, 2, 3, 4)
slots[0] = [.left = 10, .right = 20] as pair_type
let i = 1
slots[i] = [.left = 5, .right = 7] as pair_type
slots.first.left + slots.first.right + slots.second.left + slots.second.right
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $slots i32)");
  assert_includes(wat, "(local $_aggregate_value#");
  assert_includes(wat, "i32.load offset=0");
  assert_includes(wat, "i32.load offset=4");
  assert_includes(wat, "i32.store offset=0");
  assert_includes(wat, "i32.store offset=4");
  assert_includes(wat, "i32.store offset=8");
  assert_includes(wat, "i32.store offset=12");

  assert_throws(
    () =>
      Emit.emit(
        Mod,
        Core.mod(Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .left= Int,
  .right= Int
}

const { struct } = import "duck:prelude" ()
const slots_type = struct {
  .first= pair_type,
  .second= pair_type
}

let flag = true
let make_slots = if flag {
  (a: Int, b: Int, c: Int, d: Int) => [.first = [.left = a, .right = b] as pair_type, .second = [.left = c, .right = d] as pair_type] as slots_type
} else {
  (a: Int, b: Int, c: Int, d: Int) => [.first = [.left = c, .right = d] as pair_type, .second = [.left = a, .right = b] as pair_type] as slots_type
}

let slots: slots_type = make_slots(1, 2, 3, 4)
slots[0] = 42
0
`))),
      ),
    "Core runtime aggregate index assignment field first expects a matching aggregate value",
  );

  assert_throws(
    () =>
      Emit.emit(
        Mod,
        Core.mod(Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .left= Int,
  .right= Int
}

const { struct } = import "duck:prelude" ()
const mixed_type = struct {
  .pair= pair_type,
  .count= Int
}

let flag = true
let make_mixed = if flag {
  (a: Int, b: Int, count: Int) => [.pair = [.left = a, .right = b] as pair_type, .count = count] as mixed_type
} else {
  (a: Int, b: Int, count: Int) => [.pair = [.left = b, .right = a] as pair_type, .count = count] as mixed_type
}

let mixed: mixed_type = make_mixed(1, 2, 3)
let i = 0
mixed[i] = [.left = 4, .right = 5] as pair_type
0
`))),
      ),
    "Core runtime aggregate dynamic index assignment field text fact mismatch",
  );
});

Deno.test("Core rejects runtime aggregate nested mutation closure capture", () => {
  const core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .left= Int,
  .right= Int
}

const { struct } = import "duck:prelude" ()
const slots_type = struct {
  .first= pair_type,
  .second= pair_type
}

let flag = true
let make_slots = if flag {
  (a: Int, b: Int, c: Int, d: Int) => [.first = [.left = a, .right = b] as pair_type, .second = [.left = c, .right = d] as pair_type] as slots_type
} else {
  (a: Int, b: Int, c: Int, d: Int) => [.first = [.left = c, .right = d] as pair_type, .second = [.left = a, .right = b] as pair_type] as slots_type
}

let slots: slots_type = make_slots(1, 2, 3, 4)
let write = (i: Int, left: Int, right: Int) => {
  slots[i] = [.left = left, .right = right] as pair_type
  0
}

write(1, 5, 7)
slots.first.left + slots.first.right + slots.second.left + slots.second.right
`));
  assert_throws(
    () => Emit.emit(Mod, Core.mod(core)),
    "unique_heap runtime_aggregate capture requires linear closure ownership " +
      "support",
  );
});

Deno.test("Core rejects runtime aggregate Text mutation closure capture", () => {
  const core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const names_type = struct {
  .first= Text,
  .second= Text
}

let flag = true
let make = if flag {
  (first: Text, second: Text) => [.first = first, .second = second] as names_type
} else {
  (first: Text, second: Text) => [.first = second, .second = first] as names_type
}

let names: names_type = make("Ada", "Grace")
let write = (i: Int, suffix: Text) => {
  names[i] = names.first + suffix
  @len(names.second)
}

write(1, " Hopper")
`));
  assert_throws(
    () => Emit.emit(Mod, Core.mod(core)),
    "unique_heap runtime_aggregate capture requires linear closure ownership " +
      "support",
  );
});

Deno.test("Core rejects runtime aggregate scalar mutation closure capture", () => {
  const static_core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let flag = true
let make = if flag {
  (first: Int, second: Int) => [.first = first, .second = second] as pair_type
} else {
  (first: Int, second: Int) => [.first = second, .second = first] as pair_type
}

let pair: pair_type = make(10, 31)
let write = (i: Int, value: Int) => {
  pair[i] = value
  pair.first + pair.second
}

write(0, 40) + write(1, 2)
`));
  assert_throws(
    () => Emit.emit(Mod, Core.mod(static_core)),
    "unique_heap runtime_aggregate capture requires linear closure ownership " +
      "support",
  );

  const first_class_core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let flag = true
let make = if flag {
  (first: Int, second: Int) => [.first = first, .second = second] as pair_type
} else {
  (first: Int, second: Int) => [.first = second, .second = first] as pair_type
}

let pair: pair_type = make(10, 31)
let write = (i: Int, value: Int) => {
  pair[i] = value
  pair.first + pair.second
}

write(0, 40) + write(1, 2)
`));
  assert_throws(
    () => Emit.emit(Mod, Core.mod(first_class_core)),
    "unique_heap runtime_aggregate capture requires linear closure ownership " +
      "support",
  );
});

Deno.test("Core rejects collection-loop borrowed views that escape the iteration", () => {
  const source = `
const { struct } = import "duck:prelude" ()
const names_type = struct {
  .first= Text,
  .second= Text
}

let flag = true
let make = if flag {
  (first: Text, second: Text) => [.first = first, .second = second] as names_type
} else {
  (first: Text, second: Text) => [.first = second, .second = first] as names_type
}

let names: names_type = make("Ada", "Grace")
let i = 1
let picked: Text = @get(names, i)
let first: Text = names[0]
let view: Text = ""
let total = 0

for index, name in names {
  let item_alias = name
  view = &item_alias
  total = total + index + @len(name)
}

@len(names) * 1000 + @len(picked) * 100 + @len(first) * 10 + total + @len(view)
`;
  const core = Source.core(Source.parse(source));

  assert_equals(Core.proof(core).borrows, {
    ok: false,
    issues: [
      {
        tag: "rejected_borrow",
        edge: {
          id: "borrow#0",
          source_scope: "loop#0",
          target_scope: "program#0",
          ownership: {
            tag: "unique_heap",
            reason: "text",
          },
          decision: {
            tag: "rejected",
            reason: "borrow view rooted in collection iteration loop#0 " +
              "cannot escape to program#0",
          },
        },
        message: "Rejected borrow borrow#0 in program#0: borrow view rooted " +
          "in collection iteration loop#0 cannot escape to program#0",
      },
    ],
  });
  assert_throws(
    () => Core.check_proof(core),
    "borrow view rooted in collection iteration loop#0 cannot escape to " +
      "program#0",
  );
  assert_throws(
    () => Source.wat(Source.parse(source)),
    "borrow view rooted in collection iteration loop#0 cannot escape to " +
      "program#0",
  );
});

Deno.test("Core.emit keeps collection-loop borrowed reads inside the iteration", () => {
  const core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const names_type = struct {
  .first= Text,
  .second= Text
}

let flag = true
let make = if flag {
  (first: Text, second: Text) => [.first = first, .second = second] as names_type
} else {
  (first: Text, second: Text) => [.first = second, .second = first] as names_type
}

let names: names_type = make("Ada", "Grace")
let i = 1
let picked: Text = @get(names, i)
let first: Text = names[0]
let total = 0
let borrowed_total = 0

for index, name in names {
  let view = &name
  borrowed_total = borrowed_total + @len(view)
  total = total + index + @len(name)
}

@len(names) * 1000 + @len(picked) * 100 + @len(first) * 10 + total + borrowed_total
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $names i32)");
  assert_includes(wat, "(local $picked i32)");
  assert_includes(wat, "(local $first i32)");
  assert_includes(wat, "(local $view i32)");
  assert_includes(wat, "(local $name i32)");
  assert_includes(wat, "local.set $name");
  assert_includes(wat, "local.set $view");
  assert_includes(wat, "i32.load offset=0");
  assert_includes(wat, "i32.load offset=4");
  assert_includes(wat, "i32.load");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const mixed_type = struct {
  .name= Text,
  .age= Int
}

let flag = true
let make = if flag {
  (name: Text, age: Int) => [.name = name, .age = age] as mixed_type
} else {
  (name: Text, age: Int) => [.name = name, .age = age + 1] as mixed_type
}

let mixed: mixed_type = make("Ada", 41)
let i = if flag {
  0
} else {
  1
}

@len(@get(mixed, i))
`)),
      ),
    "Core collection item text fact mismatch",
  );
});

Deno.test("Core.emit captures runtime values in static aggregates", () => {
  const struct_core = Source.core(Source.parse(`
let a = 1
let xs = [.first = a, .second = 2]
a = 9
xs[0] + xs[1]
`));
  const struct_wat = Emit.emit(Core, struct_core);

  assert_equals(Typed.type(Core, struct_core), "i32");
  assert_includes(struct_wat, "(local $_field_first#0 i32)");
  assert_includes(struct_wat, "local.set $_field_first#0");
  assert_includes(struct_wat, "local.get $_field_first#0");

  const union_core = Source.core(Source.parse(`
let payload = 41
let result = \`Ok (payload)
payload = 1
if let \`Ok x = result {
  x
} else {
  0
}
`));
  const union_wat = Emit.emit(Core, union_core);

  assert_equals(Typed.type(Core, union_core), "i32");
  assert_includes(union_wat, "(local $_payload_Ok#0 i32)");
  assert_includes(union_wat, "local.set $_payload_Ok#0");
  assert_includes(union_wat, "local.get $_payload_Ok#0");
});

Deno.test("Core.emit rebuilds static struct update expressions", () => {
  const core = Source.core(Source.parse(`
let user = [.age = 40, .score = 2]
let next = 41
let updated = user :+ { .age = next }
next = 1
updated.age + user.age + updated.score
`));
  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $_field_age#0 i32)");
  assert_includes(wat, "local.set $_field_age#0");
  assert_includes(wat, "local.get $_field_age#0");
  assert_includes(wat, "i32.const 40");
  assert_includes(wat, "i32.const 2");

  const direct_core = Source.core(Source.parse(`
let user = [.age = 40, .score = 2]
(user :+ { .age = 41 }).age
`));

  assert_equals(Typed.type(Core, direct_core), "i32");
  assert_equals(Emit.emit(Core, direct_core), "\ni32.const 41");

  const assignment_core = Source.core(Source.parse(`
let user = [.age = 40, .score = 2]
user = user :+ { .age = 41 }
user.age
`));

  assert_equals(Core.proof(assignment_core).issues, []);
  assert_equals(Typed.type(Core, assignment_core), "i32");
  assert_equals(Emit.emit(Core, assignment_core).trim(), "i32.const 41");

  assert_throws(
    () =>
      Emit.emit(
        Core,
        Source.core(Source.parse(`
let user = [.age = 40, .score = 2]
let updated = user :+ { .missing = 1 }
updated.age
`)),
      ),
    "Missing static core field: missing",
  );

  assert_throws(
    () =>
      Emit.emit(
        Core,
        Source.core(Source.parse(`
let user = [.age = 40, .score = 2]
let updated = user :+ { .age = 41i64 }
updated.age
`)),
      ),
    "Core struct update field age expects i32, got i64",
  );
});

Deno.test("Core.emit captures dynamic aggregate if bindings", () => {
  const struct_core = Source.core(Source.parse(`
let flag = false
let user = if flag {
  [.age = 41, .score = 1]
} else {
  [.age = 32, .score = 10]
}

flag = true
user.age + user.score
`));
  const struct_wat = Emit.emit(Core, struct_core);

  assert_equals(Typed.type(Core, struct_core), "i32");
  assert_includes(struct_wat, "(local $_field_age#0 i32)");
  assert_includes(struct_wat, "(local $_field_score#1 i32)");
  assert_includes(struct_wat, "local.get $flag");
  assert_includes(struct_wat, "local.set $_field_age#0");
  assert_includes(struct_wat, "local.set $_field_score#1");

  const union_core = Source.core(Source.parse(`
type ResultType = | \`Ok I32 | \`Err I32
const result_type = ResultType
let flag = true
let payload = 41
let result = if flag {
  \`Ok (payload)
} else {
  \`Err (7)
}

flag = false
payload = 1
if let \`Ok value = result {
  value + 1
} else {
  0
}
`));
  const union_wat = Emit.emit(Core, union_core);

  assert_equals(Typed.type(Core, union_core), "i32");
  assert_includes(union_wat, "(local $_if_cond#0 i32)");
  assert_includes(union_wat, "(local $_payload_Ok#1 i32)");
  assert_includes(union_wat, "local.set $_if_cond#0");
  assert_includes(union_wat, "local.set $_payload_Ok#1");
});

Deno.test("Core.emit lowers direct dynamic aggregate if access", () => {
  const field_core = Source.core(Source.parse(`
let flag = false

(if flag {
  [.age = 41, .score = 1]
} else {
  [.age = 32, .score = 10]
}).age
`));
  const field_wat = Emit.emit(Core, field_core);

  assert_equals(Typed.type(Core, field_core), "i32");
  assert_includes(field_wat, "local.get $flag");
  assert_includes(field_wat, "if (result i32)");
  assert_includes(field_wat, "i32.const 41");
  assert_includes(field_wat, "i32.const 32");

  const index_core = Source.core(Source.parse(`
let flag = false
let i = 1

(if flag {
  [.first = 41, .second = 1]
} else {
  [.first = 32, .second = 10]
})[i]
`));
  const index_wat = Emit.emit(Core, index_core);

  assert_equals(Typed.type(Core, index_core), "i32");
  assert_includes(index_wat, "local.get $i");
  assert_includes(index_wat, "i32.eq");
  assert_includes(index_wat, "if (result i32)");
  assert_includes(index_wat, "unreachable");

  const same_case_union_core = Source.core(Source.parse(`
type ResultType = | \`Ok I32 | \`Err I32
const result_type = ResultType
let flag = false
let left = 41
let right = 32
let result = if flag {
  \`Ok (left)
} else {
  \`Ok (right)
}

left = 1
right = 2
if let \`Ok value = result {
  value
} else {
  0
}
`));
  const same_case_union_wat = Emit.emit(Core, same_case_union_core);

  assert_equals(Typed.type(Core, same_case_union_core), "i32");
  assert_includes(same_case_union_wat, "(local $_payload_Ok#1 i32)");
  assert_includes(same_case_union_wat, "(local $_payload_Ok#2 i32)");
  assert_includes(same_case_union_wat, "local.set $_payload_Ok#1");
  assert_includes(same_case_union_wat, "local.set $_payload_Ok#2");
});

Deno.test("Core.emit lowers dynamic if else statements with assignments", () => {
  const core = Source.core(Source.parse(`
let flag = true
let value = 0

if flag {
  value = 10
} else {
  value = 20
}

flag = false
value
`));
  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(Format.fmt(Core, core), "} else {");
  assert_includes(wat, "if");
  assert_includes(wat, "else");
  assert_includes(wat, "local.set $value");

  const expr_core = Source.core(Source.parse(`
let flag = true

if flag {
  10
} else {
  20
}
`));

  assert_equals(Typed.type(Core, expr_core), "i32");
  assert_includes(Emit.emit(Core, expr_core), "if (result i32)");

  const chain_core = Source.core(Source.parse(`
host_import choose from "env.choose" () => I32
let choice = choose()
let value = 0

if choice == 1 {
  value = 10
} else if choice == 2 {
  value = 42
} else {
  value = 20
}

value
`));
  const outer = chain_core.statements.find((stmt) => {
    return stmt.tag === "if_else_stmt";
  });

  assert_equals(outer?.tag, "if_else_stmt");

  if (!outer || outer.tag !== "if_else_stmt") {
    throw new Error("Expected outer else-if Core statement");
  }

  assert_equals(outer.else_body[0]?.tag, "if_else_stmt");
  assert_equals(Core.proof(chain_core).issues, []);
  assert_equals(Typed.type(Core, chain_core), "i32");
  assert_equals(
    Emit.emit(Core, chain_core).split("\n").filter((line) => {
      return line.trim() === "if";
    }).length,
    2,
  );
});

Deno.test("Core.emit merges static if else assignments", () => {
  const aggregate_core = Source.core(Source.parse(`
let flag = true
let user = [.age = 0, .score = 0]

if flag {
  user = [.age = 41, .score = 1]
} else {
  user = [.age = 32, .score = 9]
}

flag = false
user.age + user.score
`));
  const aggregate_wat = Emit.emit(Core, aggregate_core);

  assert_equals(Typed.type(Core, aggregate_core), "i32");
  assert_includes(aggregate_wat, "(local $_if_cond#0 i32)");
  assert_includes(aggregate_wat, "(local $_field_age#1 i32)");
  assert_includes(aggregate_wat, "(local $_field_score#2 i32)");
  assert_includes(aggregate_wat, "local.set $_if_cond#0");
  assert_includes(aggregate_wat, "local.set $_field_age#1");
  assert_includes(aggregate_wat, "local.set $_field_score#2");

  const text_core = Source.core(Source.parse(`
let flag = true
let message = ""

if flag {
  message = "hi"
} else {
  message = "world"
}

flag = false
@len(message)
`));
  const text_wat = Emit.emit(Core, text_core);

  assert_equals(Typed.type(Core, text_core), "i32");
  assert_includes(text_wat, "(local $_if_cond#0 i32)");
  assert_includes(text_wat, "(local $message i32)");
  assert_includes(text_wat, "local.set $message");
  assert_includes(text_wat, "local.get $message\ni32.load");
});

Deno.test("Core.emit applies static aggregate index assignments", () => {
  const core = Source.core(Source.parse(`
let xs = [.first = 10, .second = 20]

xs[1] = 32
xs[0] + xs[1]
`));

  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "i32.const 10");
  assert_includes(wat, "i32.const 32");
  assert_includes(wat, "i32.add");

  const runtime_value_core = Source.core(Source.parse(`
let xs = [.first = 10, .second = 20]
let value = 32

xs[1] = value
xs[0] + xs[1]
`));
  const runtime_value_wat = Emit.emit(Core, runtime_value_core);

  assert_includes(runtime_value_wat, "(local $_index_value#0 i32)");
  assert_includes(runtime_value_wat, "local.set $_index_value#0");
  assert_includes(runtime_value_wat, "local.get $_index_value#0");

  const dynamic_core = Source.core(Source.parse(`
let xs = [.first = 10, .second = 20]
let i = 0
let value = 32

xs[i] = value
xs[0] + xs[1]
`));
  const dynamic_wat = Emit.emit(Core, dynamic_core);

  assert_includes(dynamic_wat, "(local $_index#0 i32)");
  assert_includes(dynamic_wat, "(local $_index_value#1 i32)");
  assert_includes(dynamic_wat, "local.set $_index#0");
  assert_includes(dynamic_wat, "local.set $_index_value#1");
  assert_includes(dynamic_wat, "if (result i32)");

  const dynamic_text_core = Source.core(Source.parse(`
let messages = [.first = "Ada", .second = "Grace"]
let i = 1
let next = "Edsger"

messages[i] = next
next = "Nope"
@len(messages[1])
`));
  const dynamic_text_wat = Emit.emit(Core, dynamic_text_core);

  assert_equals(Typed.type(Core, dynamic_text_core), "i32");
  assert_includes(dynamic_text_wat, "(local $_index#0 i32)");
  assert_includes(dynamic_text_wat, "(local $_index_value#1 i32)");
  assert_includes(dynamic_text_wat, "local.set $_index#0");
  assert_includes(dynamic_text_wat, "local.set $_index_value#1");
  assert_includes(dynamic_text_wat, "local.get $_index_value#1");
  assert_includes(dynamic_text_wat, "if (result i32)");

  const runtime_text_core = Source.core(Source.parse(`
let write_byte = (message: Bytes, i: Int, value: Int) => {
  message[i] = value
  message[i]
}

write_byte(@Utf8.encode("Ada"), 1, 111)
`));
  const runtime_text_wat = Emit.emit(Core, runtime_text_core);

  assert_equals(Typed.type(Core, runtime_text_core), "i32");
  assert_includes(runtime_text_wat, "(local $_text_assign_index#");
  assert_includes(runtime_text_wat, "(local $_text_assign_value#");
  assert_includes(runtime_text_wat, "i32.store8");
  assert_includes(runtime_text_wat, "i32.load8_u");

  const frozen_static_aggregate_core = Source.core(Source.parse(`
let user = freeze [.age = 41, .bonus = 1]
user.age + user.bonus
`));
  assert_equals(Typed.type(Core, frozen_static_aggregate_core), "i32");
  assert_equals(
    Emit.emit(Core, frozen_static_aggregate_core).trim(),
    "i32.const 41\ni32.const 1\ni32.add",
  );

  const scratch_static_aggregate_core = Source.core(Source.parse(`
let x = 40
let user = scratch { [.age = x + 1, .bonus = 1] }
user.age + user.bonus
`));
  const scratch_static_aggregate_wat = Emit.emit(
    Core,
    scratch_static_aggregate_core,
  );
  assert_equals(Typed.type(Core, scratch_static_aggregate_core), "i32");
  assert_includes(scratch_static_aggregate_wat, "(local $x i32)");
  assert_includes(
    scratch_static_aggregate_wat,
    "(local $_field_age#0 i32)",
  );
  assert_includes(scratch_static_aggregate_wat, "local.set $_field_age#0");
  assert_includes(scratch_static_aggregate_wat, "local.get $_field_age#0");
  assert_equals(scratch_static_aggregate_wat.includes("__scratch_heap"), false);

  const annotated_scratch_static_aggregate_core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .name= Text
}
let x = 40
let user: user_type = scratch {
  [.age = x + 1, .name = "Ada"] as user_type
}
user.age + @len(user.name)
`));
  const annotated_scratch_static_aggregate_wat = Emit.emit(
    Core,
    annotated_scratch_static_aggregate_core,
  );
  assert_equals(
    Typed.type(Core, annotated_scratch_static_aggregate_core),
    "i32",
  );
  assert_includes(
    annotated_scratch_static_aggregate_wat,
    "(local $_field_age#0 i32)",
  );
  assert_includes(
    annotated_scratch_static_aggregate_wat,
    "local.set $_field_age#0",
  );
  assert_includes(
    annotated_scratch_static_aggregate_wat,
    "local.get $_field_age#0",
  );
  assert_equals(
    annotated_scratch_static_aggregate_wat.includes("__scratch_heap"),
    false,
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .name= Text
}
let x = 40
let user: user_type = scratch {
  [.age = x + 1, .name = @append("A", "da")] as user_type
}
user.age + @len(user.name)
`)),
      ),
    "Cannot type core scratch block with unsafe scratch return field name " +
      "may reference unique_heap text and non-scalar unique_heap " +
      "runtime_aggregate result yet: unique_heap runtime_aggregate cannot " +
      "leave scratch without freeze or explicit promotion",
  );

  const frozen_text_mutation_core = Source.core(Source.parse(`
let message: Bytes = freeze @Utf8.encode("Ada")
message[0] = 66
@len(message)
`));
  const frozen_text_mutation_message =
    "Cannot mutate frozen/shareable core binding: message";

  assert_equals(
    Core.proof(frozen_text_mutation_core).issues.map((issue) => issue.message),
    [frozen_text_mutation_message],
  );
  assert_throws(
    () => Core.check_proof(frozen_text_mutation_core),
    frozen_text_mutation_message,
  );
  assert_throws(
    () => Typed.type(Core, frozen_text_mutation_core),
    frozen_text_mutation_message,
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let message: Bytes = freeze @Utf8.encode("Ada")
message[0] = 66
@len(message)
`)),
      ),
    "Cannot mutate frozen/shareable core binding: message",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let user = freeze [.age = 41, .bonus = 1]
user[0] = 42
user.age
`)),
      ),
    "Cannot mutate frozen/shareable core binding: user",
  );

  const captured_closure_core = Source.core(Source.parse(`
let pair = [.first = 1, .second = 2]
let f = i => {
  pair[i] = 40
  pair[0] + pair[1]
}

let a = f(0)
let b = f(1)
a + b + pair[0] + pair[1]
`));
  const captured_closure_wat = Emit.emit(Core, captured_closure_core);

  assert_equals(Typed.type(Core, captured_closure_core), "i32");
  assert_includes(captured_closure_wat, "local.set $a");
  assert_includes(captured_closure_wat, "local.set $b");
  assert_includes(captured_closure_wat, "i32.const 1\ni32.add\ni32.const 2");

  const param_closure_core = Source.core(Source.parse(`
let update = xs => {
  xs[0] = 40
  xs[0] + xs[1]
}

let pair = [.first = 1, .second = 2]
update(pair) + pair[0] + pair[1]
`));
  const param_closure_wat = Emit.emit(Core, param_closure_core);

  assert_equals(Typed.type(Core, param_closure_core), "i32");
  assert_includes(param_closure_wat, "i32.const 40");
  assert_includes(param_closure_wat, "i32.const 1\ni32.add\ni32.const 2");

  assert_throws(
    () =>
      Emit.emit(
        Core,
        Source.core(Source.parse(`
let xs = [.first = 10, .second = 20i64]
let i = 0

xs[i] = 32
xs[0]
`)),
      ),
    "Core dynamic index assignment field second expects i64, got i32",
  );
});

Deno.test("Core.emit tracks unannotated conditional text bindings", () => {
  const core = Source.core(Source.parse(`
let flag = true
let label = if flag { "left" } else { "right" }
label[0]
`));

  const wat = Emit.emit(Core, core);

  assert_includes(wat, "if (result i32)");
  assert_includes(wat, "i32.const 108");
  assert_includes(wat, "i32.const 114");
});

Deno.test("Core.emit lowers static if let statements", () => {
  const core = Source.core(Source.parse(`
let result = 0
let ok_result = \`Ok (41)
let err_result = \`Err (9)
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType
type OptionType = | \`Some Int | \`None Unit
const option_type = OptionType
let typed_result = \`Ok (1)
let none_result = \`None ()

if let \`Ok x = ok_result {
  result = x + 1
}

if let \`Ok y = err_result {
  result = y
}

if let \`Ok z = typed_result {
  result = result + z
}

if let \`None () = none_result {
  result = result + 1
}

result
`));

  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $x i32)");
  assert_includes(wat, "i32.const 41");
  assert_includes(wat, "local.set $x");
  assert_includes(wat, "i32.const 1");
  assert_includes(wat, "local.set $z");
  assert_includes(wat, "local.set $result");
});

Deno.test("Core emits nested runtime union match cleanup on return and fallthrough", () => {
  const core = Source.core(Source.parse(`
host_import branch_flag from "env.flag" () => I32
type ResultType = | \`Ok I32 | \`Err I32
let rec choose: Bool -> ResultType = (flag: Bool) => {
  if flag { \`Ok 21 } else { \`Err 0 }
}

if branch_flag() {
  let ignored = 0
}

if let \`Ok first = choose(branch_flag()) {
  if let \`Ok second = choose(branch_flag()) {
    return first + second
  }
}

0
`));
  const proof = Core.proof(core);
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(proof.ok, true);
  assert_equals(
    proof.drops.steps.map((step) => step.edge),
    [
      "return_exit",
      "return_exit",
      "conditional_cleanup",
      "conditional_cleanup",
    ],
  );
  assert_equals(wat.split("call $__free").length - 1, 4);
  const main = wat.slice(wat.indexOf("(func $main"));
  assert_equals(
    main.indexOf("call $__free") > main.indexOf("call $choose"),
    true,
  );
});

Deno.test("Core.emit lowers static if let expressions", () => {
  const core = Source.core(Source.parse(`
let result = if let \`Ok x = \`Ok (41) {
  x + 1
} else {
  0
}

let fallback = if let \`Ok y = \`Err (9) {
  y
} else {
  5
}

result + fallback
`));
  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $x i32)");
  assert_includes(wat, "(local $result i32)");
  assert_includes(wat, "i32.const 41");
  assert_includes(wat, "local.set $x");
  assert_includes(wat, "i32.const 5");

  const wide_fallback_core = Source.core(Source.parse(`
type ResultType = | \`Ok I64 | \`Err I64
const result_type = ResultType

let result: result_type = \`Err (1i64)
let value = if let \`Ok found = result {
  found + 1i64
}

value
`));
  const wide_fallback_wat = Emit.emit(Core, wide_fallback_core);

  assert_equals(Typed.type(Core, wide_fallback_core), "i64");
  assert_includes(wide_fallback_wat, "(local $value i64)");
  assert_includes(wide_fallback_wat, "i64.const 0");
});

Deno.test("Core.emit lowers dynamic union-if if let targets", () => {
  const expr_core = Source.core(Source.parse(`
type ResultType = | \`Ok I32 | \`Err I32
const result_type = ResultType
let input = 1
let value = if let \`Ok x = if input {
  \`Ok (41)
} else {
  \`Err (7)
} {
  x + 1
} else {
  5
}

value
`));
  const expr_wat = Emit.emit(Core, expr_core);

  assert_equals(Typed.type(Core, expr_core), "i32");
  assert_includes(expr_wat, "(local $x i32)");
  assert_includes(expr_wat, "if (result i32)");
  assert_includes(expr_wat, "local.set $x");
  assert_includes(expr_wat, "i32.const 5");

  const stmt_core = Source.core(Source.parse(`
type ResultType = | \`Ok I32 | \`Err I32
const result_type = ResultType
let input = 1
let result = 0

if let \`Ok x = if input {
  \`Ok (41)
} else {
  \`Err (7)
} {
  result = x + 1
}

result
`));
  const stmt_wat = Emit.emit(Core, stmt_core);

  assert_equals(Typed.type(Core, stmt_core), "i32");
  assert_includes(stmt_wat, "if");
  assert_includes(stmt_wat, "local.set $x");
  assert_includes(stmt_wat, "local.set $result");

  const typed_core = Source.core(Source.parse(`
let input = 1
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let result = if input {
  \`Ok (40)
} else {
  \`Err (1)
}

if let \`Ok value = result {
  value + 2
} else {
  7
}
`));
  const typed_wat = Emit.emit(Core, typed_core);

  assert_equals(Typed.type(Core, typed_core), "i32");
  assert_includes(typed_wat, "(local $value i32)");
  assert_includes(typed_wat, "local.set $_if_cond#0");
  assert_includes(typed_wat, "local.set $value");
  assert_includes(typed_wat, "i32.const 7");

  const typed_struct_payload_core = Source.core(Source.parse(`
let input = 1
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .score= Int
}

type ResultType = | \`Ok user_type | \`Err user_type
const result_type = ResultType

let result: result_type = if input {
  \`Ok ([.age = 40, .score = 2] as user_type)
} else {
  \`Err ([.age = 5, .score = 1] as user_type)
}

if let \`Ok user = result {
  user.age + user.score
} else {
  0
}
`));
  const typed_struct_payload_wat = Emit.emit(Core, typed_struct_payload_core);

  assert_equals(Typed.type(Core, typed_struct_payload_core), "i32");
  assert_includes(typed_struct_payload_wat, "if (result i32)");
  assert_includes(typed_struct_payload_wat, "i32.const 40");
  assert_includes(typed_struct_payload_wat, "i32.const 2");
  assert_includes(typed_struct_payload_wat, "i32.add");
  assert_includes(typed_struct_payload_wat, "i32.const 0");

  const const_call_core = Source.core(Source.parse(`
let input = 1

type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

const make_result = flag => {
  if flag {
    \`Ok (40)
  } else {
    \`Err (1)
  }
}

let result = make_result(input)

if let \`Ok value = result {
  value + 2
} else {
  7
}
`));
  const const_call_wat = Emit.emit(Core, const_call_core);

  assert_equals(Typed.type(Core, const_call_core), "i32");
  assert_includes(const_call_wat, "(local $value i32)");
  assert_includes(const_call_wat, "local.set $_if_cond#0");
  assert_includes(const_call_wat, "local.set $value");
  assert_includes(const_call_wat, "i32.const 7");

  const typed_wide_core = Source.core(Source.parse(`
let input = 1

type ResultType = | \`Ok I64 | \`Err I64
const result_type = ResultType

let result: result_type = if input {
  \`Ok (40i64)
} else {
  \`Err (1i64)
}

let selected = if let \`Ok value = result {
  value + 2i64
}

selected
`));
  const typed_wide_wat = Emit.emit(Core, typed_wide_core);

  assert_equals(Typed.type(Core, typed_wide_core), "i64");
  assert_includes(typed_wide_wat, "(local $value i64)");
  assert_includes(typed_wide_wat, "if (result i64)");
  assert_includes(typed_wide_wat, "i64.const 0");
});

Deno.test("Core.emit lowers text literals to pointers with data", () => {
  const core = Source.core(Source.parse('"hi"'));
  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_equals(wat, "i32.const 0");
  assert_equals(Data.data(Core, core), [
    { offset: 0, bytes: [2, 0, 0, 0, 104, 105] },
  ]);
});

Deno.test("Core.emit lowers visible text concatenation to text data", () => {
  const core = Source.core(Source.parse('"hello" + " world"'));

  assert_equals(Typed.type(Core, core), "i32");
  assert_equals(Emit.emit(Core, core), "i32.const 0");
  assert_equals(Data.data(Core, core), [
    {
      offset: 0,
      bytes: [
        11,
        0,
        0,
        0,
        104,
        101,
        108,
        108,
        111,
        32,
        119,
        111,
        114,
        108,
        100,
      ],
    },
  ]);

  const dynamic_core = Source.core(Source.parse(`
let flag = true
let message = if flag {
  "hi"
} else {
  "hello"
}

message + "!"
`));
  const dynamic_wat = Emit.emit(Core, dynamic_core);

  assert_equals(Typed.type(Core, dynamic_core), "i32");
  assert_includes(dynamic_wat, "(local $_if_cond#0 i32)");
  assert_includes(dynamic_wat, "local.set $_if_cond#0");
  assert_includes(dynamic_wat, "if (result i32)");
  assert_includes(dynamic_wat, "i32.const 20");
  assert_includes(dynamic_wat, "i32.const 28");
  assert_equals(Data.data(Core, dynamic_core), [
    { offset: 0, bytes: [2, 0, 0, 0, 104, 105] },
    { offset: 8, bytes: [5, 0, 0, 0, 104, 101, 108, 108, 111] },
    { offset: 20, bytes: [3, 0, 0, 0, 104, 105, 33] },
    { offset: 28, bytes: [6, 0, 0, 0, 104, 101, 108, 108, 111, 33] },
  ]);

  const dynamic_index_core = Source.core(Source.parse(`
let messages = [.first = "Ada", .second = "Grace"]

let i = if true {
  1
} else {
  0
}

messages[i] + "!"
`));
  const dynamic_index_wat = Emit.emit(Core, dynamic_index_core);

  assert_equals(Typed.type(Core, dynamic_index_core), "i32");
  assert_includes(dynamic_index_wat, "if (result i32)");
  assert_includes(dynamic_index_wat, "i32.const 20");
  assert_includes(dynamic_index_wat, "i32.const 28");
  assert_includes(dynamic_index_wat, "unreachable");
  assert_equals(Data.data(Core, dynamic_index_core), [
    { offset: 0, bytes: [3, 0, 0, 0, 65, 100, 97] },
    { offset: 8, bytes: [5, 0, 0, 0, 71, 114, 97, 99, 101] },
    { offset: 20, bytes: [4, 0, 0, 0, 65, 100, 97, 33] },
    { offset: 28, bytes: [6, 0, 0, 0, 71, 114, 97, 99, 101, 33] },
  ]);

  const static_call_core = Source.core(Source.parse(`
let append = (left: Text, right: Text) => {
  left + right
}

append("hi", "!")
`));

  assert_equals(Typed.type(Core, static_call_core), "i32");
  assert_equals(Data.data(Core, static_call_core), [
    { offset: 0, bytes: [3, 0, 0, 0, 104, 105, 33] },
  ]);

  const runtime_core = Source.core(Source.parse(`
let flag = true
let append = if flag {
  (left: Text, right: Text) => left + right
} else {
  (left: Text, right: Text) => right + left
}

append("hi", "!")
`));
  const runtime_wat = Emit.emit(Mod, Core.mod(runtime_core));

  assert_equals(Typed.type(Core, runtime_core), "i32");
  assert_includes(runtime_wat, "(global $__closure_heap (mut i32)");
  assert_includes(runtime_wat, "i32.store8");
  assert_includes(runtime_wat, "block $text_concat_left_exit_");
  assert_includes(runtime_wat, "block $text_concat_right_exit_");

  const scratch_runtime_core = Source.core(Source.parse(`
let flag = true
let scratch_text = if flag {
  (message: Text) => scratch {
    message + "!"
    7
  }
} else {
  (message: Text) => scratch {
    "!" + message
    8
  }
}

scratch_text("hi")
`));
  const scratch_runtime_wat = Emit.emit(Mod, Core.mod(scratch_runtime_core));

  assert_equals(Typed.type(Core, scratch_runtime_core), "i32");
  assert_includes(
    scratch_runtime_wat,
    "(global $__scratch_heap (mut i32) (i32.const 32768))",
  );
  assert_includes(
    scratch_runtime_wat,
    "global.get $__scratch_heap\n    local.set $_text_concat_result#",
  );
  assert_includes(
    scratch_runtime_wat,
    "global.set $__scratch_heap\n    local.get $_text_concat_result#",
  );

  if (
    scratch_runtime_wat.includes(
      "global.get $__closure_heap\n    local.set $_text_concat_result#",
    )
  ) {
    throw new Error("Scratch text concat allocated from persistent heap");
  }

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let name = 1
"hello " + name
`)),
      ),
    "Core text concatenation requires visible text operands",
  );
});

Deno.test("Core.emit lowers runtime text equality to byte compare loop", () => {
  const core = Source.core(Source.parse(`
let flag = true
let compare = if flag {
  (left: Text, right: Text) => left == right
} else {
  (left: Text, right: Text) => left != right
}

compare("Ada", "Ada")
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $_text_eq_left#");
  assert_includes(wat, "(local $_text_eq_right#");
  assert_includes(wat, "block $text_eq_exit_");
  assert_includes(wat, "loop $text_eq_loop_");
  assert_includes(wat, "i32.load8_u");
  assert_includes(wat, "local.set $_text_eq_result#");
});

Deno.test("Core.emit lowers runtime text slice to copy loop", () => {
  const core = Source.core(Source.parse(`
let flag = true
let slicer = if flag {
  (value: Text, start: Int, end: Int) => @slice(value, start, end)
} else {
  (value: Text, start: Int, end: Int) => @slice(value, start, end)
}

let part: Text = slicer("Grace", 1, 4)
@len(part) + @get(part, 0)
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $_text_slice_text#");
  assert_includes(wat, "(local $_text_slice_start#");
  assert_includes(wat, "(local $_text_slice_result#");
  assert_includes(wat, "block $text_slice_exit_");
  assert_includes(wat, "loop $text_slice_loop_");
  assert_includes(wat, "i32.store8");
  assert_includes(wat, "local.set $part");
});

Deno.test("Core.emit lowers visible text len", () => {
  const literal_core = Source.core(Source.parse('@len("hello")'));

  assert_equals(Typed.type(Core, literal_core), "i32");
  assert_equals(Emit.emit(Core, literal_core), "i32.const 5");

  const binding_core = Source.core(Source.parse(`
let message = "hello"
@len(message)
`));

  assert_equals(Typed.type(Core, binding_core), "i32");
  assert_equals(Emit.emit(Core, binding_core), "\ni32.const 5");

  const dynamic_core = Source.core(Source.parse(`
let flag = true
let message = if flag {
  "hi"
} else {
  "world"
}

flag = false
@len(message)
`));
  const dynamic_wat = Emit.emit(Core, dynamic_core);

  assert_equals(Typed.type(Core, dynamic_core), "i32");
  assert_includes(dynamic_wat, "(local $_if_cond#0 i32)");
  assert_includes(dynamic_wat, "local.set $_if_cond#0");
  assert_includes(dynamic_wat, "if (result i32)");
  assert_includes(dynamic_wat, "i32.const 2");
  assert_includes(dynamic_wat, "i32.const 5");

  const dynamic_index_core = Source.core(Source.parse(`
let messages = [.first = "Ada", .second = "Grace"]

let i = if true {
  1
} else {
  0
}

@len(messages[i])
`));
  const dynamic_index_wat = Emit.emit(Core, dynamic_index_core);

  assert_equals(Typed.type(Core, dynamic_index_core), "i32");
  assert_includes(dynamic_index_wat, "if (result i32)");
  assert_includes(dynamic_index_wat, "i32.const 3");
  assert_includes(dynamic_index_wat, "i32.const 5");
  assert_includes(dynamic_index_wat, "unreachable");

  const runtime_core = Source.core(Source.parse(`
let flag = true
let byte_len = if flag {
  (value: Text) => @len(value)
} else {
  (value: Text) => @len(value) + 1
}

byte_len("Ada")
`));
  const runtime_wat = Emit.emit(Mod, Core.mod(runtime_core));

  assert_equals(Typed.type(Core, runtime_core), "i32");
  assert_includes(runtime_wat, "call_indirect");
  assert_includes(runtime_wat, "i32.load");

  assert_throws(
    () => Typed.type(Core, Source.core(Source.parse("let x = 1\n@len(x)"))),
    "Cannot type core len over unknown collection or text",
  );
});

Deno.test("Core.emit lowers visible text byte indexes", () => {
  const static_core = Source.core(Source.parse(`
let message = "Ada"
message[1]
`));

  assert_equals(Typed.type(Core, static_core), "i32");
  assert_equals(Emit.emit(Core, static_core), "\ni32.const 100");

  const static_get_core = Source.core(Source.parse(`
let message = "Ada"
@get(message, 2)
`));

  assert_equals(Typed.type(Core, static_get_core), "i32");
  assert_equals(Emit.emit(Core, static_get_core), "\ni32.const 97");

  const dynamic_core = Source.core(Source.parse(`
let message = "Ada"
let i = if true {
  2
} else {
  0
}

message[i]
`));
  const dynamic_wat = Emit.emit(Core, dynamic_core);

  assert_equals(Typed.type(Core, dynamic_core), "i32");
  assert_includes(dynamic_wat, "if (result i32)");
  assert_includes(dynamic_wat, "i32.const 65");
  assert_includes(dynamic_wat, "i32.const 100");
  assert_includes(dynamic_wat, "i32.const 97");
  assert_includes(dynamic_wat, "unreachable");

  const runtime_core = Source.core(Source.parse(`
let flag = true
let byte_at = if flag {
  (value: Text, i: Int) => value[i]
} else {
  (value: Text, i: Int) => @get(value, i)
}

byte_at("Ada", 2)
`));
  const runtime_wat = Emit.emit(Mod, Core.mod(runtime_core));

  assert_equals(Typed.type(Core, runtime_core), "i32");
  assert_includes(runtime_wat, "call_indirect");
  assert_includes(runtime_wat, "i32.load8_u");
  assert_includes(runtime_wat, "unreachable");

  assert_throws(
    () => Typed.type(Core, Source.core(Source.parse('"Ada"[3]'))),
    "Core text index out of bounds: 3",
  );

  assert_throws(
    () => Typed.type(Core, Source.core(Source.parse('@get("Ada", 3)'))),
    "Core text index out of bounds: 3",
  );
});

Deno.test("Core.emit lowers panic to a runtime trap", () => {
  const core = Source.core(Source.parse('@panic("boom")'));

  assert_equals(Typed.type(Core, core), "i32");
  assert_equals(Emit.emit(Core, core), "unreachable");

  const branch_core = Source.core(Source.parse(`
if false {
  @panic("boom")
} else {
  42
}
`));

  assert_equals(Typed.type(Core, branch_core), "i32");
  assert_includes(Emit.emit(Core, branch_core), "unreachable");

  assert_throws(
    () => Typed.type(Core, Source.core(Source.parse("@panic(1)"))),
    "Core panic message must be text",
  );
});

Deno.test("Core.emit checks builtin binding annotations", () => {
  const scalar = Source.core(Source.parse(`
let x: Int = 41
x + 1
`));

  assert_equals(Typed.type(Core, scalar), "i32");
  assert_includes(Emit.emit(Core, scalar), "i32.const 41");

  const text = Source.core(Source.parse(`
let text: Text = "Ada"
@len(text)
`));

  assert_equals(Typed.type(Core, text), "i32");
  assert_includes(Emit.emit(Core, text), "i32.const 3");

  const scratch_text = Source.core(Source.parse(`
let prefix: Text = @slice("Ada", 0, 3)
let text: Text = scratch {
  let temp: Text = @append(prefix, "!")
  freeze temp
}
@len(text)
`));

  assert_equals(Typed.type(Core, scratch_text), "i32");
  assert_equals(Core.proof(scratch_text).issues, []);
  Core.check_proof(scratch_text);
  assert_includes(Emit.emit(Core, scratch_text), "global.set $__scratch_heap");

  const type_value = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const user_type: Type = struct {
  .age= Int
}

41
`));

  assert_equals(Typed.type(Core, type_value), "i32");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let x: Int = 1i64
x
`)),
      ),
    "Core binding annotation expects Int, got I64",
  );

  assert_throws(
    () =>
      Emit.emit(
        Core,
        Source.core(Source.parse(`
let x: Int = "Ada"
x
`)),
      ),
    "Core binding annotation expects Int, got Text",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let value: Text = {
  let inner: Text = 1
  inner
}
value
`)),
      ),
    "Binding annotation expects Text, got I32",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let prefix: Text = @slice("Ada", 0, 3)
let text: Text = scratch {
  @append(prefix, "!")
}
@len(text)
`)),
      ),
    "unique_heap text cannot leave scratch without freeze or explicit promotion",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
const value: Type = 1
1
`)),
      ),
    "Core binding annotation expects Type, got I32",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let value: has_name = 1
value
`)),
      ),
    "Cannot check core binding annotation: has_name",
  );
});

Deno.test("Core preserves and checks parameter annotations", () => {
  const formatted = Source.core(Source.parse(`
const keep = (const f, !io: Int, value: Text) => {
  value
}

keep
`));

  assert_includes(
    Format.fmt(Core, formatted),
    "const keep = (const f, !io: Int, value: Text) =>",
  );

  const valid = Source.core(Source.parse(`
const byte_len = (value: Text) => {
  @len(value)
}

byte_len("Ada")
`));

  assert_equals(Typed.type(Core, valid), "i32");
  assert_includes(Emit.emit(Core, valid), "i32.const 3");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
const byte_len = (value: Text) => {
  @len(value)
}

byte_len(1)
`)),
      ),
    "Core parameter annotation expects Text, got I32",
  );
});

Deno.test("Core.emit applies direct type annotation context", () => {
  const struct_core = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let pair: pair_type = [.first = 40, .second = 2]

pair.first + pair.second
`));

  assert_equals(Typed.type(Core, struct_core), "i32");
  assert_includes(Emit.emit(Core, struct_core), "i32.const 40");

  const union_core = Source.core(Source.parse(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

const alias_type = result_type

let result: alias_type = \`Ok (41)

if let \`Ok value = result {
  value + 1
} else {
  0
}
`));

  assert_equals(Typed.type(Core, union_core), "i32");
  assert_includes(Emit.emit(Core, union_core), "i32.const 41");

  const struct_alias_core = Source.core(Source.parse(`
const int_type = Int

const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= int_type,
  .second= Int
}

const alias_type = pair_type

let pair: alias_type = [.first = 40, .second = 2]

pair.first + pair.second
`));

  assert_equals(Typed.type(Core, struct_alias_core), "i32");
  assert_includes(Emit.emit(Core, struct_alias_core), "i32.const 40");

  const union_payload_alias_core = Source.core(Source.parse(`
const int_type = Int

type ResultType = | \`Ok int_type | \`Err Int
const result_type = ResultType

let result: result_type = \`Ok (41)

if let \`Ok value = result {
  value + 1
} else {
  0
}
`));

  assert_equals(Typed.type(Core, union_payload_alias_core), "i32");
  assert_includes(Emit.emit(Core, union_payload_alias_core), "i32.const 41");

  const dynamic_union_core = Source.core(Source.parse(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let input = 1
let result: result_type = if input {
  \`Ok (40)
} else {
  \`Err (7)
}

if let \`Ok value = result {
  value + 1
} else {
  0
}
`));
  const dynamic_union_wat = Emit.emit(Core, dynamic_union_core);

  assert_equals(Typed.type(Core, dynamic_union_core), "i32");
  assert_includes(dynamic_union_wat, "(local $_if_cond#0 i32)");
  assert_includes(dynamic_union_wat, "local.set $_if_cond#0");
  assert_includes(dynamic_union_wat, "if (result i32)");
  assert_includes(dynamic_union_wat, "i32.const 40");
  assert_includes(dynamic_union_wat, "i32.const 0");

  const dynamic_union_text_core = Source.core(Source.parse(`
type ResultType = | \`Ok Text | \`Err Text
const result_type = ResultType

let input = 1
let left = "Ada"
let right = "Grace"
let result: result_type = if input {
  \`Ok (left)
} else {
  \`Err (right)
}

input = 0
left = "Zoe"
right = "Ida"

let value = if let \`Ok text = result {
  text
} else {
  ""
}

@len(value)
`));
  const dynamic_union_text_wat = Emit.emit(Core, dynamic_union_text_core);

  assert_equals(Typed.type(Core, dynamic_union_text_core), "i32");
  assert_includes(dynamic_union_text_wat, "(local $_if_cond#0 i32)");
  assert_includes(dynamic_union_text_wat, "local.set $_if_cond#0");
  assert_includes(dynamic_union_text_wat, "if (result i32)");
  assert_includes(dynamic_union_text_wat, "i32.const 3");
  assert_includes(dynamic_union_text_wat, "i32.const 0");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
const text_type = Text

const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= text_type
}

let pair: pair_type = [.first = 41]

pair.first
`)),
      ),
    "Core struct field first expects Text, got I32",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
type ResultType = \`Ok Int
const result_type = ResultType

let result: result_type = \`Ok ("Ada")

if let \`Ok value = result {
  value
} else {
  0
}
`)),
      ),
    "Union case Ok expects Int, got Text",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
type ResultType = \`Ok Int
const result_type = ResultType

let result = \`Ok ("Ada")

if let \`Ok value = result {
  value
} else {
  0
}
`)),
      ),
    "Union case Ok expects Int, got Text",
  );
});
