import { assert_equals, assert_includes, assert_throws } from "./assert.ts";
import { Core, type Core as CoreNode, type CoreExpr } from "./core.ts";
import { core_borrow_plan, core_validate_borrow_plan } from "./core/borrow.ts";
import { core_escape_analysis } from "./core/escape.ts";
import {
  core_borrow_lifetime_decision,
  core_freeze_lifetime_decision,
  core_scratch_return_lifetime_decision,
} from "./core/lifetime.ts";
import { core_expr_ownership } from "./core/ownership.ts";
import { Source } from "./frontend.ts";
import { Mod } from "./mod.ts";
import { Data, Emit, Format, Typed } from "./trait.ts";

Deno.test("Core.emit emits i32 range loops with carried locals", () => {
  const core = Source.core(Source.parse(`
let n = 5
let sum = 0

for i in 0..n {
  sum = sum + i
}

sum
`));

  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "(local $n i32)");
  assert_includes(wat, "(local $sum i32)");
  assert_includes(wat, "(local $i i32)");
  assert_includes(wat, "block $range_exit_0");
  assert_includes(wat, "loop $range_loop_0");
  assert_includes(wat, "i32.ge_s");
  assert_includes(wat, "local.set $sum");
  assert_includes(wat, "local.get $sum");
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
      "let x = 1:i32",
      "let _x#shadow0 = 2:i64",
      "_x#shadow0",
    ].join("\n"),
  );
  assert_equals(Typed.type(Core, core), "i64");
  assert_includes(wat, "(local $x i32)");
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
  assert_includes(wat, "(local $_local_value#");
  assert_includes(wat, "(local $_local__value#shadow");
  assert_includes(wat, "i64.const 2");
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
let flag = 1
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

for i, x in { first: 10, second: 32 } {
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
let flag = 1
let sum = 0

for i, x in if flag {
  { first: 10, second: 20 }
} else {
  { first: 1, second: 2 }
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
let flag = 1
let sum = 0

const make_xs = active => {
  if active {
    { first: 10, second: 20 }
  } else {
    { first: 1, second: 2 }
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
let flag = 1
let sum_text = if flag {
  (value: Text) => {
    let total = 0

    for i, byte in value {
      total = total + i + byte
    }

    total
  }
} else {
  (value: Text) => len(value)
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
const pair_type = struct {
  first: Int,
  second: Int
}

const sum = (pair: pair_type) => {
  let total = 0

  for i, x in pair {
    total = total + i + x
  }

  total
}

sum({
  first: 10,
  second: 31
})
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
  factor := 1i64
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

Deno.test("Core.mod lowers first-class scalar closures through a table", () => {
  const dynamic_core = Source.core(Source.parse(`
let flag = 1
let f = if flag {
  (x: Int) => x + 1
} else {
  (x: Int) => x + 2
}

f(40)
`));
  const dynamic_wat = Emit.emit(Mod, Core.mod(dynamic_core));

  assert_equals(Typed.type(Core, dynamic_core), "i32");
  assert_includes(dynamic_wat, "(type $closure_i32_i32_to_i32");
  assert_includes(dynamic_wat, "(table $__closure_table 2 funcref)");
  assert_includes(
    dynamic_wat,
    "(elem (i32.const 0) $__closure_0 $__closure_1)",
  );
  assert_includes(dynamic_wat, "call_indirect (type $closure_i32_i32_to_i32)");

  const capture_core = Source.core(Source.parse(`
let flag = 0
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
let flag = 1
let message: Text = if flag {
  "Ada"
} else {
  "Grace"
}
let f = if flag {
  (x: Int) => len(message) + x
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
let flag = 1
let message: Text = if flag {
  "Ada"
} else {
  "Grace"
}
let make = (value: Text) => {
  if flag {
    (x: Int) => len(value) + x
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
let flag = 1
let add = if flag {
  (x: Int) => x + 1
} else {
  (x: Int) => x + 2
}
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
let flag = 1
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
const user_type = struct { age: Int }
const user_alias = user_type

let make = flag => {
  if flag {
    (user: user_type) => user.age + 1
  } else {
    (user: user_alias) => user.age + 2
  }
}

let f = make(0)
f(user_type { age: 40 })
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
const result_type = union { ok: Int, err: Int }
const result_alias = result_type

let make = flag => {
  if flag {
    (result: result_type) => if let .ok(value) = result { value + 1 } else { 0 }
  } else {
    (result: result_alias) => if let .ok(value) = result { value + 2 } else { 0 }
  }
}

let f = make(0)
f(result_type.ok(40))
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
let run = (text: Text, flag: Int) => {
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

run("Ada", 1)
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
let flag = 1
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
let flag = 1
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
let flag = 1
let f = if flag {
  (value: Text) => len(value)
} else {
  value => len(value) + 1
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
let flag = 1
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
let flag = 1
let f = if let .ok(value) = if flag {
  .ok(40)
} else {
  .err(1)
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
let flag = 1
const result_type = union {
  ok: Int,
  err: Int
}

let result: result_type = if flag {
  .ok(40)
} else {
  .err(1)
}

let f = if let .ok(value) = result {
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
let flag = 1
const result_type = union {
  ok: Int,
  err: Int
}

let !base: I32 = 1
let result: result_type = if flag {
  .ok(40)
} else {
  .err(1)
}

let f = if let .ok(value) = result {
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
let flag = 1
let f = if flag {
  (value: Int) => value + 1
} else {
  (value: Text) => len(value)
}

f("Ada")
`)),
      ),
    "Core closure if branch type mismatch",
  );
});

Deno.test("Core.emit resolves static aggregate bindings", () => {
  const core = Source.core(Source.parse(`
let xs = { first: 10, second: 20 }
let user = { name: 1, age: 41 }
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
let xs = { first: 10, second: 32 }
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
let xs = { first: 10, second: 20i64 }
let i = 0

xs[i]
`)),
      ),
    "Core collection item type mismatch: i32, got i64",
  );
});

Deno.test("Core.emit lowers static aggregate len and get calls", () => {
  const core = Source.core(Source.parse(`
let xs = { first: 10, second: 32 }
let i = 1

len(xs) + get(xs, i) + get(xs, 0)
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
let i = 0
get(xs, i)
`)),
      ),
    "Cannot type core get over unknown collection",
  );

  assert_throws(
    () =>
      Emit.emit(
        Core,
        Source.core(Source.parse(`
let xs = { first: 10, second: 20i64 }
let i = 0

get(xs, i)
`)),
      ),
    "Core collection item type mismatch: i32, got i64",
  );
});

Deno.test("Core.emit lowers runtime aggregate collection facts", () => {
  const core = Source.core(Source.parse(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let i = 1
let total = 0

for index, value in pair {
  total = total + index + value
}

len(pair) * 1000 + get(pair, i) * 100 + pair[0] * 10 + total
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
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
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
const scores_type = struct {
  first: Int,
  second: Int
}
const user_type = struct {
  scores: scores_type,
  bonus: Int
}

let flag = 1
let make_scores = if flag {
  () => scores_type { first: 10, second: 20 }
} else {
  () => scores_type { first: 1, second: 2 }
}
let scores: scores_type = make_scores()
let make_user = if flag {
  () => user_type { scores: scores, bonus: 1 }
} else {
  () => user_type { scores: scores, bonus: 2 }
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

Deno.test("Core.emit lowers runtime aggregate scalar index assignment", () => {
  const core = Source.core(Source.parse(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
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
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
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
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let view = borrow pair
pair[0] = 40
0
`))),
      ),
    "Cannot mutate borrowed owner pair in program#0 while borrow#0 is active",
  );
});

Deno.test("Core.emit lowers runtime aggregate Text index assignment", () => {
  const core = Source.core(Source.parse(`
const names_type = struct {
  first: Text,
  second: Text
}

let flag = 1
let make = if flag {
  (first: Text, second: Text) => names_type {
    first: first,
    second: second
  }
} else {
  (first: Text, second: Text) => names_type {
    first: second,
    second: first
  }
}

let names: names_type = make("Ada", "Grace")
names[0] = "Edsger"
let i = 1
names[i] = names.first + " Hopper"
len(names.first) * 100 + len(names.second)
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
const names_type = struct {
  first: Text,
  second: Text
}

let flag = 1
let make = if flag {
  (first: Text, second: Text) => names_type {
    first: first,
    second: second
  }
} else {
  (first: Text, second: Text) => names_type {
    first: second,
    second: first
  }
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
const mixed_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text, age: Int) => mixed_type {
    name: name,
    age: age
  }
} else {
  (name: Text, age: Int) => mixed_type {
    name: name,
    age: age
  }
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
const result_type = union {
  ok: Int,
  err: Int
}

const slots_type = struct {
  first: result_type,
  second: result_type
}

let flag = 1
let make_slots = if flag {
  (first: Int, second: Int) => slots_type {
    first: result_type.ok(first),
    second: result_type.err(second)
  }
} else {
  (first: Int, second: Int) => slots_type {
    first: result_type.err(first),
    second: result_type.ok(second)
  }
}
let slots: slots_type = make_slots(1, 2)
slots[0] = result_type.err(40)
let i = 1
slots[i] = result_type.ok(2)
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
const result_type = union {
  ok: Int,
  err: Int
}

const slots_type = struct {
  first: result_type,
  second: result_type
}

let flag = 1
let make_slots = if flag {
  (first: Int, second: Int) => slots_type {
    first: result_type.ok(first),
    second: result_type.err(second)
  }
} else {
  (first: Int, second: Int) => slots_type {
    first: result_type.err(first),
    second: result_type.ok(second)
  }
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
const result_type = union {
  ok: Int,
  err: Int
}

const mixed_type = struct {
  result: result_type,
  count: Int
}

let flag = 1
let make_mixed = if flag {
  (value: Int, count: Int) => mixed_type {
    result: result_type.ok(value),
    count: count
  }
} else {
  (value: Int, count: Int) => mixed_type {
    result: result_type.err(value),
    count: count
  }
}
let mixed: mixed_type = make_mixed(1, 2)
let i = 0
mixed[i] = result_type.err(4)
0
`))),
      ),
    "Core runtime aggregate dynamic index assignment field text fact mismatch",
  );
});

Deno.test("Core.emit lowers captured runtime aggregate union index assignment", () => {
  const core = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

const slots_type = struct {
  first: result_type,
  second: result_type
}

let flag = 1
let make_slots = if flag {
  (first: Int, second: Int) => slots_type {
    first: result_type.ok(first),
    second: result_type.err(second)
  }
} else {
  (first: Int, second: Int) => slots_type {
    first: result_type.err(first),
    second: result_type.ok(second)
  }
}
let slots: slots_type = make_slots(1, 2)
let write = if flag {
  (i: Int, value: Int) => {
    slots[i] = result_type.ok(value)
    0
  }
} else {
  (i: Int, value: Int) => {
    slots[i] = result_type.err(value)
    0
  }
}

write(1, 2)
slots
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "call_indirect");
  assert_includes(wat, "(local $slots i32)");
  assert_includes(wat, "i32.store offset=0");
  assert_includes(wat, "i32.store offset=4");
  assert_includes(wat, "(local $_aggregate_index#");
  assert_includes(wat, "(local $_aggregate_value#");
});

Deno.test("Core.emit lowers runtime aggregate nested index assignment", () => {
  const core = Source.core(Source.parse(`
const pair_type = struct {
  left: Int,
  right: Int
}

const slots_type = struct {
  first: pair_type,
  second: pair_type
}

let flag = 1
let make_slots = if flag {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: a, right: b },
    second: pair_type { left: c, right: d }
  }
} else {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: c, right: d },
    second: pair_type { left: a, right: b }
  }
}

let slots: slots_type = make_slots(1, 2, 3, 4)
slots[0] = pair_type { left: 10, right: 20 }
let i = 1
slots[i] = pair_type { left: 5, right: 7 }
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
const pair_type = struct {
  left: Int,
  right: Int
}

const slots_type = struct {
  first: pair_type,
  second: pair_type
}

let flag = 1
let make_slots = if flag {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: a, right: b },
    second: pair_type { left: c, right: d }
  }
} else {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: c, right: d },
    second: pair_type { left: a, right: b }
  }
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
const pair_type = struct {
  left: Int,
  right: Int
}

const mixed_type = struct {
  pair: pair_type,
  count: Int
}

let flag = 1
let make_mixed = if flag {
  (a: Int, b: Int, count: Int) => mixed_type {
    pair: pair_type { left: a, right: b },
    count: count
  }
} else {
  (a: Int, b: Int, count: Int) => mixed_type {
    pair: pair_type { left: b, right: a },
    count: count
  }
}

let mixed: mixed_type = make_mixed(1, 2, 3)
let i = 0
mixed[i] = pair_type { left: 4, right: 5 }
0
`))),
      ),
    "Core runtime aggregate dynamic index assignment field text fact mismatch",
  );
});

Deno.test("Core.emit lowers captured runtime aggregate nested index assignment", () => {
  const core = Source.core(Source.parse(`
const pair_type = struct {
  left: Int,
  right: Int
}

const slots_type = struct {
  first: pair_type,
  second: pair_type
}

let flag = 1
let make_slots = if flag {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: a, right: b },
    second: pair_type { left: c, right: d }
  }
} else {
  (a: Int, b: Int, c: Int, d: Int) => slots_type {
    first: pair_type { left: c, right: d },
    second: pair_type { left: a, right: b }
  }
}

let slots: slots_type = make_slots(1, 2, 3, 4)
let write = if flag {
  (i: Int, left: Int, right: Int) => {
    slots[i] = pair_type { left: left, right: right }
    0
  }
} else {
  (i: Int, left: Int, right: Int) => {
    slots[i] = pair_type { left: right, right: left }
    0
  }
}

write(1, 5, 7)
slots.first.left + slots.first.right + slots.second.left + slots.second.right
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "call_indirect");
  assert_includes(wat, "(local $slots i32)");
  assert_includes(wat, "(local $_aggregate_value#");
  assert_includes(wat, "i32.store offset=8");
  assert_includes(wat, "i32.store offset=12");
});

Deno.test("Core.emit lowers captured runtime aggregate Text index assignment", () => {
  const core = Source.core(Source.parse(`
const names_type = struct {
  first: Text,
  second: Text
}

let flag = 1
let make = if flag {
  (first: Text, second: Text) => names_type {
    first: first,
    second: second
  }
} else {
  (first: Text, second: Text) => names_type {
    first: second,
    second: first
  }
}

let names: names_type = make("Ada", "Grace")
let write = if flag {
  (i: Int, suffix: Text) => {
    names[i] = names.first + suffix
    len(names.second)
  }
} else {
  (i: Int, suffix: Text) => {
    names[i] = suffix
    len(names.second)
  }
}

write(1, " Hopper")
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "call_indirect");
  assert_includes(wat, "i32.store offset=4");
  assert_includes(wat, "i32.load offset=4");
});

Deno.test("Core.emit lowers captured runtime aggregate scalar index assignment", () => {
  const static_core = Source.core(Source.parse(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let write = (i: Int, value: Int) => {
  pair[i] = value
  pair.first + pair.second
}

write(0, 40) + write(1, 2)
`));
  const static_wat = Emit.emit(Mod, Core.mod(static_core));

  assert_equals(Typed.type(Core, static_core), "i32");
  assert_includes(static_wat, "i32.store offset=0");
  assert_includes(static_wat, "i32.store offset=4");

  const first_class_core = Source.core(Source.parse(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}

let pair: pair_type = make(10, 31)
let write = if flag {
  (i: Int, value: Int) => {
    pair[i] = value
    pair.first + pair.second
  }
} else {
  (i: Int, value: Int) => {
    pair[i] = value + 1
    pair.first + pair.second
  }
}

write(0, 40) + write(1, 2)
`));
  const first_class_wat = Emit.emit(Mod, Core.mod(first_class_core));

  assert_equals(Typed.type(Core, first_class_core), "i32");
  assert_includes(first_class_wat, "call_indirect");
  assert_includes(first_class_wat, "i32.store offset=0");
  assert_includes(first_class_wat, "i32.store offset=4");
});

Deno.test("Core.emit preserves runtime aggregate text collection facts", () => {
  const core = Source.core(Source.parse(`
const names_type = struct {
  first: Text,
  second: Text
}

let flag = 1
let make = if flag {
  (first: Text, second: Text) => names_type {
    first: first,
    second: second
  }
} else {
  (first: Text, second: Text) => names_type {
    first: second,
    second: first
  }
}

let names: names_type = make("Ada", "Grace")
let i = 1
let picked: Text = get(names, i)
let first: Text = names[0]
let view: Text = ""
let total = 0

for index, name in names {
  view = borrow name
  total = total + index + len(name)
}

len(names) * 1000 + len(picked) * 100 + len(first) * 10 + total + len(view)
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
const mixed_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text, age: Int) => mixed_type { name: name, age: age }
} else {
  (name: Text, age: Int) => mixed_type { name: name, age: age + 1 }
}

let mixed: mixed_type = make("Ada", 41)
let i = if flag {
  0
} else {
  1
}

len(get(mixed, i))
`)),
      ),
    "Core collection item text fact mismatch",
  );
});

Deno.test("Core.emit captures runtime values in static aggregates", () => {
  const struct_core = Source.core(Source.parse(`
let a = 1
let xs = { first: a, second: 2 }
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
let result = .ok(payload)
payload = 1
if let .ok(x) = result {
  x
} else {
  0
}
`));
  const union_wat = Emit.emit(Core, union_core);

  assert_equals(Typed.type(Core, union_core), "i32");
  assert_includes(union_wat, "(local $_payload_ok#0 i32)");
  assert_includes(union_wat, "local.set $_payload_ok#0");
  assert_includes(union_wat, "local.get $_payload_ok#0");
});

Deno.test("Core.emit rebuilds static struct update expressions", () => {
  const core = Source.core(Source.parse(`
let user = { age: 40, score: 2 }
let next = 41
let updated = user { age: next }
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
let user = { age: 40, score: 2 }
(user { age: 41 }).age
`));

  assert_equals(Typed.type(Core, direct_core), "i32");
  assert_equals(Emit.emit(Core, direct_core), "\ni32.const 41");

  const assignment_core = Source.core(Source.parse(`
let user = { age: 40, score: 2 }
user = user { age: 41 }
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
let user = { age: 40, score: 2 }
let updated = user { missing: 1 }
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
let user = { age: 40, score: 2 }
let updated = user { age: 41i64 }
updated.age
`)),
      ),
    "Core struct update field age expects i32, got i64",
  );
});

Deno.test("Core.emit captures dynamic aggregate if bindings", () => {
  const struct_core = Source.core(Source.parse(`
let flag = 0
let user = if flag {
  { age: 41, score: 1 }
} else {
  { age: 32, score: 10 }
}

flag = 1
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
let flag = 1
let payload = 41
let result = if flag {
  .ok(payload)
} else {
  .err(7)
}

flag = 0
payload = 1
if let .ok(value) = result {
  value + 1
} else {
  0
}
`));
  const union_wat = Emit.emit(Core, union_core);

  assert_equals(Typed.type(Core, union_core), "i32");
  assert_includes(union_wat, "(local $_if_cond#0 i32)");
  assert_includes(union_wat, "(local $_payload_ok#1 i32)");
  assert_includes(union_wat, "local.set $_if_cond#0");
  assert_includes(union_wat, "local.set $_payload_ok#1");
});

Deno.test("Core.emit lowers direct dynamic aggregate if access", () => {
  const field_core = Source.core(Source.parse(`
let flag = 0

(if flag {
  { age: 41, score: 1 }
} else {
  { age: 32, score: 10 }
}).age
`));
  const field_wat = Emit.emit(Core, field_core);

  assert_equals(Typed.type(Core, field_core), "i32");
  assert_includes(field_wat, "local.get $flag");
  assert_includes(field_wat, "if (result i32)");
  assert_includes(field_wat, "i32.const 41");
  assert_includes(field_wat, "i32.const 32");

  const index_core = Source.core(Source.parse(`
let flag = 0
let i = 1

(if flag {
  { first: 41, second: 1 }
} else {
  { first: 32, second: 10 }
})[i]
`));
  const index_wat = Emit.emit(Core, index_core);

  assert_equals(Typed.type(Core, index_core), "i32");
  assert_includes(index_wat, "local.get $i");
  assert_includes(index_wat, "i32.eq");
  assert_includes(index_wat, "if (result i32)");
  assert_includes(index_wat, "unreachable");

  const same_case_union_core = Source.core(Source.parse(`
let flag = 0
let left = 41
let right = 32
let result = if flag {
  .ok(left)
} else {
  .ok(right)
}

left = 1
right = 2
if let .ok(value) = result {
  value
} else {
  0
}
`));
  const same_case_union_wat = Emit.emit(Core, same_case_union_core);

  assert_equals(Typed.type(Core, same_case_union_core), "i32");
  assert_includes(same_case_union_wat, "(local $_payload_ok#1 i32)");
  assert_includes(same_case_union_wat, "(local $_payload_ok#2 i32)");
  assert_includes(same_case_union_wat, "local.set $_payload_ok#1");
  assert_includes(same_case_union_wat, "local.set $_payload_ok#2");
});

Deno.test("Core.emit lowers dynamic if else statements with assignments", () => {
  const core = Source.core(Source.parse(`
let flag = 1
let value = 0

if flag {
  value = 10
} else {
  value = 20
}

flag = 0
value
`));
  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(Format.fmt(Core, core), "} else {");
  assert_includes(wat, "if");
  assert_includes(wat, "else");
  assert_includes(wat, "local.set $value");

  const expr_core = Source.core(Source.parse(`
let flag = 1

if flag {
  10
} else {
  20
}
`));

  assert_equals(Typed.type(Core, expr_core), "i32");
  assert_includes(Emit.emit(Core, expr_core), "if (result i32)");
});

Deno.test("Core.emit merges static if else assignments", () => {
  const aggregate_core = Source.core(Source.parse(`
let flag = 1
let user = { age: 0, score: 0 }

if flag {
  user = { age: 41, score: 1 }
} else {
  user = { age: 32, score: 9 }
}

flag = 0
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
let flag = 1
let message = ""

if flag {
  message = "hi"
} else {
  message = "world"
}

flag = 0
len(message)
`));
  const text_wat = Emit.emit(Core, text_core);

  assert_equals(Typed.type(Core, text_core), "i32");
  assert_includes(text_wat, "(local $_if_cond#0 i32)");
  assert_includes(text_wat, "i32.const 2");
  assert_includes(text_wat, "i32.const 5");
});

Deno.test("Core.emit applies static aggregate index assignments", () => {
  const core = Source.core(Source.parse(`
let xs = { first: 10, second: 20 }

xs[1] = 32
xs[0] + xs[1]
`));

  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "i32.const 10");
  assert_includes(wat, "i32.const 32");
  assert_includes(wat, "i32.add");

  const runtime_value_core = Source.core(Source.parse(`
let xs = { first: 10, second: 20 }
let value = 32

xs[1] = value
xs[0] + xs[1]
`));
  const runtime_value_wat = Emit.emit(Core, runtime_value_core);

  assert_includes(runtime_value_wat, "(local $_index_value#0 i32)");
  assert_includes(runtime_value_wat, "local.set $_index_value#0");
  assert_includes(runtime_value_wat, "local.get $_index_value#0");

  const dynamic_core = Source.core(Source.parse(`
let xs = { first: 10, second: 20 }
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
let messages = { first: "Ada", second: "Grace" }
let i = 1
let next = "Edsger"

messages[i] = next
next = "Nope"
len(messages[1])
`));
  const dynamic_text_wat = Emit.emit(Core, dynamic_text_core);

  assert_equals(Typed.type(Core, dynamic_text_core), "i32");
  assert_includes(dynamic_text_wat, "(local $_index#0 i32)");
  assert_includes(dynamic_text_wat, "local.set $_index#0");
  assert_includes(dynamic_text_wat, "if (result i32)");
  assert_includes(dynamic_text_wat, "i32.const 6");
  assert_includes(dynamic_text_wat, "i32.const 5");

  const runtime_text_core = Source.core(Source.parse(`
let write_byte = (message: Text, i: Int, value: Int) => {
  message[i] = value
  message[i]
}

write_byte("Ada", 1, 111)
`));
  const runtime_text_wat = Emit.emit(Core, runtime_text_core);

  assert_equals(Typed.type(Core, runtime_text_core), "i32");
  assert_includes(runtime_text_wat, "(local $_text_assign_index#");
  assert_includes(runtime_text_wat, "(local $_text_assign_value#");
  assert_includes(runtime_text_wat, "i32.store8");
  assert_includes(runtime_text_wat, "i32.load8_u");

  const frozen_static_aggregate_core = Source.core(Source.parse(`
let user = freeze { age: 41, bonus: 1 }
user.age + user.bonus
`));
  assert_equals(Typed.type(Core, frozen_static_aggregate_core), "i32");
  assert_equals(
    Emit.emit(Core, frozen_static_aggregate_core).trim(),
    "i32.const 41\ni32.const 1\ni32.add",
  );

  const scratch_static_aggregate_core = Source.core(Source.parse(`
let x = 40
let user = scratch { { age: x + 1, bonus: 1 } }
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
const user_type = struct {
  age: Int,
  name: Text
}
let x = 40
let user: user_type = scratch {
  user_type { age: x + 1, name: "Ada" }
}
user.age + len(user.name)
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
const user_type = struct {
  age: Int,
  name: Text
}
let x = 40
let user: user_type = scratch {
  user_type { age: x + 1, name: append("A", "da") }
}
user.age + len(user.name)
`)),
      ),
    "Cannot type core scratch block with unsafe scratch return field name " +
      "may reference unique_heap text and non-scalar unique_heap " +
      "runtime_aggregate result yet: unique_heap runtime_aggregate cannot " +
      "leave scratch without freeze or explicit promotion",
  );

  const frozen_text_mutation_core = Source.core(Source.parse(`
let message = "Ada"
message[0] = 66
len(message)
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
let message = freeze "Ada"
message[0] = 66
len(message)
`)),
      ),
    "Cannot mutate frozen/shareable core binding: message",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let user = freeze { age: 41, bonus: 1 }
user[0] = 42
user.age
`)),
      ),
    "Cannot mutate frozen/shareable core binding: user",
  );

  const captured_closure_core = Source.core(Source.parse(`
let pair = { first: 1, second: 2 }
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

let pair = { first: 1, second: 2 }
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
let xs = { first: 10, second: 20i64 }
let i = 0

xs[i] = 32
xs[0]
`)),
      ),
    "Core dynamic index assignment field second expects i64, got i32",
  );
});

Deno.test("Core.emit lowers static if let statements", () => {
  const core = Source.core(Source.parse(`
let result = 0
let ok_result = .ok(41)
let err_result = .err(9)
const result_type = union {
  ok: Int,
  err: Int
}
const option_type = union {
  some: Int,
  none: Unit
}
let typed_result = result_type.ok(1)
let none_result = option_type.none()

if let .ok(x) = ok_result {
  result = x + 1
}

if let .ok(y) = err_result {
  result = y
}

if let .ok(z) = typed_result {
  result = result + z
}

if let .none = none_result {
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

Deno.test("Core.emit lowers static if let expressions", () => {
  const core = Source.core(Source.parse(`
let result = if let .ok(x) = .ok(41) {
  x + 1
} else {
  0
}

let fallback = if let .ok(y) = .err(9) {
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
const result_type = union {
  ok: I64,
  err: I64
}

let result: result_type = .err(1i64)
let value = if let .ok(found) = result {
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
let input = 1
let value = if let .ok(x) = if input {
  .ok(41)
} else {
  .err(7)
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
let input = 1
let result = 0

if let .ok(x) = if input {
  .ok(41)
} else {
  .err(7)
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
const result_type = union {
  ok: Int,
  err: Int
}

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
`));
  const typed_wat = Emit.emit(Core, typed_core);

  assert_equals(Typed.type(Core, typed_core), "i32");
  assert_includes(typed_wat, "(local $value i32)");
  assert_includes(typed_wat, "local.set $_if_cond#0");
  assert_includes(typed_wat, "local.set $value");
  assert_includes(typed_wat, "i32.const 7");

  const typed_struct_payload_core = Source.core(Source.parse(`
let input = 1
const user_type = struct {
  age: Int,
  score: Int
}

const result_type = union {
  ok: user_type,
  err: user_type
}

let result: result_type = if input {
  .ok(user_type {
    age: 40,
    score: 2
  })
} else {
  .err(user_type {
    age: 5,
    score: 1
  })
}

if let .ok(user) = result {
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

const result_type = union {
  ok: Int,
  err: Int
}

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
`));
  const const_call_wat = Emit.emit(Core, const_call_core);

  assert_equals(Typed.type(Core, const_call_core), "i32");
  assert_includes(const_call_wat, "(local $value i32)");
  assert_includes(const_call_wat, "local.set $_if_cond#0");
  assert_includes(const_call_wat, "local.set $value");
  assert_includes(const_call_wat, "i32.const 7");

  const typed_wide_core = Source.core(Source.parse(`
let input = 1

const result_type = union {
  ok: I64,
  err: I64
}

let result: result_type = if input {
  .ok(40i64)
} else {
  .err(1i64)
}

let selected = if let .ok(value) = result {
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
let flag = 1
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
let messages = {
  first: "Ada",
  second: "Grace"
}

let i = if 1 {
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
let flag = 1
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
let flag = 1
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
let flag = 1
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
let flag = 1
let slicer = if flag {
  (value: Text, start: Int, end: Int) => slice(value, start, end)
} else {
  (value: Text, start: Int, end: Int) => slice(value, start, end)
}

let part: Text = slicer("Grace", 1, 4)
len(part) + get(part, 0)
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
  const literal_core = Source.core(Source.parse('len("hello")'));

  assert_equals(Typed.type(Core, literal_core), "i32");
  assert_equals(Emit.emit(Core, literal_core), "i32.const 5");

  const binding_core = Source.core(Source.parse(`
let message = "hello"
len(message)
`));

  assert_equals(Typed.type(Core, binding_core), "i32");
  assert_equals(Emit.emit(Core, binding_core), "\ni32.const 5");

  const dynamic_core = Source.core(Source.parse(`
let flag = 1
let message = if flag {
  "hi"
} else {
  "world"
}

flag = 0
len(message)
`));
  const dynamic_wat = Emit.emit(Core, dynamic_core);

  assert_equals(Typed.type(Core, dynamic_core), "i32");
  assert_includes(dynamic_wat, "(local $_if_cond#0 i32)");
  assert_includes(dynamic_wat, "local.set $_if_cond#0");
  assert_includes(dynamic_wat, "if (result i32)");
  assert_includes(dynamic_wat, "i32.const 2");
  assert_includes(dynamic_wat, "i32.const 5");

  const dynamic_index_core = Source.core(Source.parse(`
let messages = {
  first: "Ada",
  second: "Grace"
}

let i = if 1 {
  1
} else {
  0
}

len(messages[i])
`));
  const dynamic_index_wat = Emit.emit(Core, dynamic_index_core);

  assert_equals(Typed.type(Core, dynamic_index_core), "i32");
  assert_includes(dynamic_index_wat, "if (result i32)");
  assert_includes(dynamic_index_wat, "i32.const 3");
  assert_includes(dynamic_index_wat, "i32.const 5");
  assert_includes(dynamic_index_wat, "unreachable");

  const runtime_core = Source.core(Source.parse(`
let flag = 1
let byte_len = if flag {
  (value: Text) => len(value)
} else {
  (value: Text) => len(value) + 1
}

byte_len("Ada")
`));
  const runtime_wat = Emit.emit(Mod, Core.mod(runtime_core));

  assert_equals(Typed.type(Core, runtime_core), "i32");
  assert_includes(runtime_wat, "call_indirect");
  assert_includes(runtime_wat, "i32.load");

  assert_throws(
    () => Typed.type(Core, Source.core(Source.parse("let x = 1\nlen(x)"))),
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
get(message, 2)
`));

  assert_equals(Typed.type(Core, static_get_core), "i32");
  assert_equals(Emit.emit(Core, static_get_core), "\ni32.const 97");

  const dynamic_core = Source.core(Source.parse(`
let message = "Ada"
let i = if 1 {
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
let flag = 1
let byte_at = if flag {
  (value: Text, i: Int) => value[i]
} else {
  (value: Text, i: Int) => get(value, i)
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
    () => Typed.type(Core, Source.core(Source.parse('get("Ada", 3)'))),
    "Core text index out of bounds: 3",
  );
});

Deno.test("Core.emit lowers panic to a runtime trap", () => {
  const core = Source.core(Source.parse('panic("boom")'));

  assert_equals(Typed.type(Core, core), "i32");
  assert_equals(Emit.emit(Core, core), "unreachable");

  const branch_core = Source.core(Source.parse(`
if 0 {
  panic("boom")
} else {
  42
}
`));

  assert_equals(Typed.type(Core, branch_core), "i32");
  assert_includes(Emit.emit(Core, branch_core), "unreachable");

  assert_throws(
    () => Typed.type(Core, Source.core(Source.parse("panic(1)"))),
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
len(text)
`));

  assert_equals(Typed.type(Core, text), "i32");
  assert_includes(Emit.emit(Core, text), "i32.const 3");

  const scratch_text = Source.core(Source.parse(`
let prefix: Text = slice("Ada", 0, 3)
let text: Text = scratch {
  let temp: Text = append(prefix, "!")
  freeze temp
}
len(text)
`));

  assert_equals(Typed.type(Core, scratch_text), "i32");
  assert_equals(Core.proof(scratch_text).issues, []);
  Core.check_proof(scratch_text);
  assert_includes(Emit.emit(Core, scratch_text), "global.set $__scratch_heap");

  const type_value = Source.core(Source.parse(`
const user_type: Type = struct {
  age: Int
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
    "Core binding annotation expects Text, got I32",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let prefix: Text = slice("Ada", 0, 3)
let text: Text = scratch {
  append(prefix, "!")
}
len(text)
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
  len(value)
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
  len(value)
}

byte_len(1)
`)),
      ),
    "Core parameter annotation expects Text, got I32",
  );
});

Deno.test("Core.emit applies direct type annotation context", () => {
  const struct_core = Source.core(Source.parse(`
const pair_type = struct {
  first: Int,
  second: Int
}

let pair: pair_type = {
  first: 40,
  second: 2
}

pair.first + pair.second
`));

  assert_equals(Typed.type(Core, struct_core), "i32");
  assert_includes(Emit.emit(Core, struct_core), "i32.const 40");

  const union_core = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

const alias_type = result_type

let result: alias_type = .ok(41)

if let .ok(value) = result {
  value + 1
} else {
  0
}
`));

  assert_equals(Typed.type(Core, union_core), "i32");
  assert_includes(Emit.emit(Core, union_core), "i32.const 41");

  const struct_alias_core = Source.core(Source.parse(`
const int_type = Int

const pair_type = struct {
  first: int_type,
  second: Int
}

const alias_type = pair_type

let pair: alias_type = {
  first: 40,
  second: 2
}

pair.first + pair.second
`));

  assert_equals(Typed.type(Core, struct_alias_core), "i32");
  assert_includes(Emit.emit(Core, struct_alias_core), "i32.const 40");

  const union_payload_alias_core = Source.core(Source.parse(`
const int_type = Int

const result_type = union {
  ok: int_type,
  err: Int
}

let result: result_type = .ok(41)

if let .ok(value) = result {
  value + 1
} else {
  0
}
`));

  assert_equals(Typed.type(Core, union_payload_alias_core), "i32");
  assert_includes(Emit.emit(Core, union_payload_alias_core), "i32.const 41");

  const dynamic_union_core = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

let input = 1
let result: result_type = if input {
  result_type.ok(40)
} else {
  result_type.err(7)
}

if let .ok(value) = result {
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
const result_type = union {
  ok: Text,
  err: Text
}

let input = 1
let left = "Ada"
let right = "Grace"
let result: result_type = if input {
  result_type.ok(left)
} else {
  result_type.err(right)
}

input = 0
left = "Zoe"
right = "Ida"

let value = if let .ok(text) = result {
  text
} else {
  ""
}

len(value)
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

const pair_type = struct {
  first: text_type
}

let pair: pair_type = {
  first: 41
}

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
const result_type = union {
  ok: Int
}

let result: result_type = .ok("Ada")

if let .ok(value) = result {
  value
} else {
  0
}
`)),
      ),
    "Core union case ok expects Int, got Text",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
const result_type = union {
  ok: Int
}

let result = result_type.ok("Ada")

if let .ok(value) = result {
  value
} else {
  0
}
`)),
      ),
    "Core union case ok expects Int, got Text",
  );
});

Deno.test("Core.emit materializes runtime scalar Text and struct union values", () => {
  const direct_core = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

let keep = "x"

result_type.ok(41)
`));
  const direct_wat = Emit.emit(Mod, Core.mod(direct_core));

  assert_equals(Typed.type(Core, direct_core), "i32");
  assert_includes(direct_wat, '(export "memory" (memory $memory))');
  assert_includes(
    direct_wat,
    "(global $__closure_heap (mut i32) (i32.const 8))",
  );
  assert_includes(direct_wat, "(local $_union#0 i32)");
  assert_includes(direct_wat, "i32.const 0");
  assert_includes(direct_wat, "i32.const 41");
  assert_includes(direct_wat, "i32.store offset=4");

  const scratch_union_core = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

let flag = 1

scratch {
  if flag {
    result_type.ok(41)
  } else {
    result_type.err(5)
  }

  7
}
`));
  const scratch_union_wat = Emit.emit(Mod, Core.mod(scratch_union_core));

  assert_equals(Typed.type(Core, scratch_union_core), "i32");
  assert_includes(
    scratch_union_wat,
    "(global $__scratch_heap (mut i32) (i32.const 0))",
  );
  assert_includes(
    scratch_union_wat,
    "global.get $__scratch_heap\n      local.set $_union#",
  );
  assert_includes(
    scratch_union_wat,
    "global.set $__scratch_heap\n      local.get $_union#",
  );

  if (scratch_union_wat.includes("(global $__closure_heap")) {
    throw new Error("Scratch union temporary required persistent heap");
  }

  const dynamic_core = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

let keep = "x"
let flag = 0

if flag {
  result_type.ok(41)
} else {
  result_type.err(7)
}
`));
  const dynamic_wat = Emit.emit(Mod, Core.mod(dynamic_core));

  assert_equals(Typed.type(Core, dynamic_core), "i32");
  assert_includes(dynamic_wat, "(local $_union#0 i32)");
  assert_includes(dynamic_wat, "(local $_union#1 i32)");
  assert_includes(dynamic_wat, "if (result i32)");
  assert_includes(dynamic_wat, "i32.const 1");
  assert_includes(dynamic_wat, "i32.const 7");
  assert_includes(dynamic_wat, "i32.store offset=4");

  const wide_core = Source.core(Source.parse(`
const result_type = union {
  ok: I64,
  err: Unit
}

let keep = "x"

result_type.ok(41i64)
`));
  const wide_wat = Emit.emit(Mod, Core.mod(wide_core));

  assert_equals(Typed.type(Core, wide_core), "i32");
  assert_includes(wide_wat, "i32.const 16");
  assert_includes(wide_wat, "i64.const 41");
  assert_includes(wide_wat, "i64.store offset=4");

  const text_core = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Unit
}

let keep = "x"

result_type.ok("Ada")
`));
  const text_wat = Emit.emit(Mod, Core.mod(text_core));

  assert_equals(Typed.type(Core, text_core), "i32");
  assert_includes(text_wat, "i32.store offset=4");

  const struct_core = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let keep = "x"

result_type.ok(user_type { age: 40, score: 2 })
`));
  const struct_wat = Emit.emit(Mod, Core.mod(struct_core));

  assert_equals(Typed.type(Core, struct_core), "i32");
  assert_includes(struct_wat, "(local $_aggregate#1 i32)");
  assert_includes(struct_wat, "i32.store offset=0");
  assert_includes(struct_wat, "i32.store offset=4");

  if (struct_wat.includes("i32.store offset=8")) {
    throw new Error("Struct union payload should store an aggregate pointer");
  }
  assert_equals(
    Core.proof(struct_core).allocations.facts.map((fact) => {
      return {
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [
      {
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        reason: "runtime_aggregate",
        expression: "struct_value",
      },
    ],
  );

  const aggregate_payload_core = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let user: user_type = user_type {
  age: 40,
  score: 2
}
let result: result_type = result_type.ok(user)

if let .ok(found) = result {
  found.age + found.score
} else {
  0
}
`));
  const aggregate_payload_wat = Emit.emit(
    Mod,
    Core.mod(aggregate_payload_core),
  );
  const aggregate_payload_proof = Core.proof(aggregate_payload_core);

  assert_equals(Typed.type(Core, aggregate_payload_core), "i32");
  assert_equals(aggregate_payload_proof.ok, true);
  assert_equals(aggregate_payload_proof.transfers, {
    transfers: [
      {
        id: "transfer#0",
        scope: "program#0",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
    ],
    issues: [],
  });
  assert_equals(aggregate_payload_proof.drops.steps, [
    {
      tag: "heap_drop",
      id: "drop#0",
      edge: "scope_exit",
      scope: "program#0",
      owner: "result",
      ownership: {
        tag: "unique_heap",
        reason: "runtime_union",
      },
      storage: "persistent_unique_heap",
      runtime: "no_op_bump_allocator",
      reason: "unique_heap runtime_union scope exit lowers to no-op with " +
        "bump allocator",
    },
  ]);
  assert_includes(aggregate_payload_wat, "(local $found i32)");
  assert_includes(aggregate_payload_wat, "local.set $found");
  assert_includes(aggregate_payload_wat, "local.get $found");
  assert_includes(aggregate_payload_wat, "i32.load offset=0");
  assert_includes(aggregate_payload_wat, "i32.load offset=4");

  const use_after_payload_transfer = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let user: user_type = user_type {
  age: 40,
  score: 2
}
let result: result_type = result_type.ok(user)
let total = if let .ok(found) = result {
  found.age + found.score
} else {
  0
}

total + user.age
`));
  const use_after_payload_transfer_proof = Core.proof(
    use_after_payload_transfer,
  );

  assert_equals(use_after_payload_transfer_proof.ok, false);
  assert_equals(use_after_payload_transfer_proof.transfers.issues, [
    {
      tag: "use_after_transfer",
      owner: "user",
      transfer: {
        id: "transfer#0",
        scope: "program#0",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
      use: "value use",
      message: "Use of transferred owner user after ownership transfer " +
        "transfer#0 to union_case.ok",
    },
  ]);
  assert_throws(
    () => Core.check_proof(use_after_payload_transfer),
    "Use of transferred owner user after ownership transfer transfer#0 to " +
      "union_case.ok",
  );

  const branch_assignment_payload_transfer = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let flag = 1
let user: user_type = user_type {
  age: flag,
  score: 2
}
let result: result_type = result_type.err()
if flag {
  result = result_type.ok(user)
} else {
  result = result_type.ok(user)
}
let total = if let .ok(found) = result {
  found.age + found.score
} else {
  0
}

total
`));
  const branch_assignment_payload_transfer_proof = Core.proof(
    branch_assignment_payload_transfer,
  );
  const branch_assignment_payload_transfer_wat = Emit.emit(
    Mod,
    Core.mod(branch_assignment_payload_transfer),
  );

  assert_equals(branch_assignment_payload_transfer_proof.ok, true);
  assert_equals(branch_assignment_payload_transfer_proof.transfers, {
    transfers: [
      {
        id: "transfer#0",
        scope: "program#0/if_then",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
      {
        id: "transfer#1",
        scope: "program#0/if_else",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
    ],
    issues: [],
  });
  assert_includes(branch_assignment_payload_transfer_wat, "if");
  assert_includes(branch_assignment_payload_transfer_wat, "(local $found i32)");
  assert_includes(branch_assignment_payload_transfer_wat, "i32.load offset=0");
  assert_includes(branch_assignment_payload_transfer_wat, "i32.load offset=4");

  const branch_assignment_payload_transfer_use_after = Source.core(
    Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let flag = 1
let user: user_type = user_type {
  age: flag,
  score: 2
}
let result: result_type = result_type.err()
if flag {
  result = result_type.ok(user)
} else {
  result = result_type.ok(user)
}
let total = if let .ok(found) = result {
  found.age + found.score
} else {
  0
}

total + user.age
`),
  );
  const branch_assignment_payload_transfer_use_after_proof = Core.proof(
    branch_assignment_payload_transfer_use_after,
  );

  assert_equals(branch_assignment_payload_transfer_use_after_proof.ok, false);
  assert_equals(
    branch_assignment_payload_transfer_use_after_proof.transfers.issues,
    [
      {
        tag: "use_after_transfer",
        owner: "user",
        transfer: {
          id: "transfer#1",
          scope: "program#0/if_else",
          owner: "user",
          callee: "union_case.ok",
          argument: 0,
        },
        use: "value use",
        message: "Use of transferred owner user after ownership transfer " +
          "transfer#1 to union_case.ok",
      },
    ],
  );
  assert_throws(
    () => Core.check_proof(branch_assignment_payload_transfer_use_after),
    "Use of transferred owner user after ownership transfer transfer#1 to " +
      "union_case.ok",
  );

  const one_sided_branch_assignment_payload_transfer = Source.core(
    Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let flag = 1
let user: user_type = user_type {
  age: flag,
  score: 2
}
let result: result_type = result_type.err()
if flag {
  result = result_type.ok(user)
} else {
  result = result_type.err()
}
let total = if let .ok(found) = result {
  found.age + found.score
} else {
  0
}

total
`),
  );
  const one_sided_branch_assignment_payload_transfer_proof = Core.proof(
    one_sided_branch_assignment_payload_transfer,
  );

  assert_equals(one_sided_branch_assignment_payload_transfer_proof.ok, false);
  assert_equals(
    one_sided_branch_assignment_payload_transfer_proof.transfers.issues,
    [
      {
        tag: "conditional_transfer_requires_cleanup",
        owner: "user",
        transfer: {
          id: "transfer#0",
          scope: "program#0/if_then",
          owner: "user",
          callee: "union_case.ok",
          argument: 0,
        },
        message: "Conditional transfer of owner user through transfer#0 to " +
          "union_case.ok requires conditional cleanup/drop facts",
      },
    ],
  );
  assert_throws(
    () => Core.check_proof(one_sided_branch_assignment_payload_transfer),
    "Conditional transfer of owner user through transfer#0 to union_case.ok " +
      "requires conditional cleanup/drop facts",
  );
  assert_throws(
    () => Core.mod(one_sided_branch_assignment_payload_transfer),
    "Conditional transfer of owner user through transfer#0 to union_case.ok " +
      "requires conditional cleanup/drop facts",
  );

  const loop_payload_transfer = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let xs = { first: 1 }
let user: user_type = user_type {
  age: 40,
  score: 2
}
let result: result_type = result_type.err()
for x in xs {
  result = result_type.ok(user)
}
let total = if let .ok(found) = result {
  found.age + found.score
} else {
  0
}

total
`));
  const loop_payload_transfer_proof = Core.proof(loop_payload_transfer);

  assert_equals(loop_payload_transfer_proof.ok, false);
  assert_equals(loop_payload_transfer_proof.transfers.issues, [
    {
      tag: "conditional_transfer_requires_cleanup",
      owner: "user",
      transfer: {
        id: "transfer#0",
        scope: "program#0/loop",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
      message: "Conditional transfer of owner user through transfer#0 to " +
        "union_case.ok requires conditional cleanup/drop facts",
    },
  ]);
  assert_throws(
    () => Core.check_proof(loop_payload_transfer),
    "Conditional transfer of owner user through transfer#0 to union_case.ok " +
      "requires conditional cleanup/drop facts",
  );
  assert_throws(
    () => Core.mod(loop_payload_transfer),
    "Conditional transfer of owner user through transfer#0 to union_case.ok " +
      "requires conditional cleanup/drop facts",
  );

  const alias_payload_transfer = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let user: user_type = user_type {
  age: 40,
  score: 2
}
let alias: user_type = user
let result: result_type = result_type.ok(alias)

if let .ok(found) = result {
  found.age + found.score
} else {
  0
}
`));
  const alias_payload_transfer_proof = Core.proof(alias_payload_transfer);
  const alias_payload_transfer_wat = Emit.emit(
    Mod,
    Core.mod(alias_payload_transfer),
  );

  assert_equals(alias_payload_transfer_proof.ok, true);
  assert_equals(alias_payload_transfer_proof.transfers, {
    transfers: [
      {
        id: "transfer#0",
        scope: "program#0",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
    ],
    issues: [],
  });
  assert_includes(alias_payload_transfer_wat, "(local $found i32)");

  const use_after_alias_payload_transfer = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let user: user_type = user_type {
  age: 40,
  score: 2
}
let alias: user_type = user
let result: result_type = result_type.ok(alias)
let total = if let .ok(found) = result {
  found.age + found.score
} else {
  0
}

total + user.age
`));
  const use_after_alias_payload_transfer_proof = Core.proof(
    use_after_alias_payload_transfer,
  );

  assert_equals(use_after_alias_payload_transfer_proof.ok, false);
  assert_equals(use_after_alias_payload_transfer_proof.transfers.issues, [
    {
      tag: "use_after_transfer",
      owner: "user",
      transfer: {
        id: "transfer#0",
        scope: "program#0",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
      use: "value use",
      message: "Use of transferred owner user after ownership transfer " +
        "transfer#0 to union_case.ok",
    },
  ]);

  const wrapper_payload_transfer = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let wrap = (payload: user_type) => result_type.ok(payload)
let user: user_type = user_type {
  age: 40,
  score: 2
}
let result: result_type = wrap(user)

if let .ok(found) = result {
  found.age + found.score
} else {
  0
}
`));
  const wrapper_payload_transfer_proof = Core.proof(wrapper_payload_transfer);
  const wrapper_payload_transfer_wat = Emit.emit(
    Mod,
    Core.mod(wrapper_payload_transfer),
  );

  assert_equals(wrapper_payload_transfer_proof.ok, true);
  assert_equals(wrapper_payload_transfer_proof.transfers, {
    transfers: [
      {
        id: "transfer#0",
        scope: "program#0/static_call/wrap",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
    ],
    issues: [],
  });
  assert_equals(wrapper_payload_transfer_proof.drops.steps, [
    {
      tag: "heap_drop",
      id: "drop#0",
      edge: "scope_exit",
      scope: "program#0",
      owner: "result",
      ownership: {
        tag: "unique_heap",
        reason: "runtime_union",
      },
      storage: "persistent_unique_heap",
      runtime: "no_op_bump_allocator",
      reason: "unique_heap runtime_union scope exit lowers to no-op with " +
        "bump allocator",
    },
    {
      tag: "heap_drop",
      id: "drop#1",
      edge: "scope_exit",
      scope: "program#0",
      owner: "wrap",
      ownership: {
        tag: "unique_heap",
        reason: "closure",
      },
      storage: "persistent_unique_heap",
      runtime: "no_op_bump_allocator",
      reason: "unique_heap closure scope exit lowers to no-op with " +
        "bump allocator",
    },
  ]);
  assert_includes(wrapper_payload_transfer_wat, "(local $found i32)");

  const wrapper_payload_transfer_use_after = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let wrap = (payload: user_type) => result_type.ok(payload)
let user: user_type = user_type {
  age: 40,
  score: 2
}
let result: result_type = wrap(user)
let total = if let .ok(found) = result {
  found.age + found.score
} else {
  0
}

total + user.age
`));
  const wrapper_payload_transfer_use_after_proof = Core.proof(
    wrapper_payload_transfer_use_after,
  );

  assert_equals(wrapper_payload_transfer_use_after_proof.ok, false);
  assert_equals(wrapper_payload_transfer_use_after_proof.transfers.issues, [
    {
      tag: "use_after_transfer",
      owner: "user",
      transfer: {
        id: "transfer#0",
        scope: "program#0/static_call/wrap",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
      use: "value use",
      message: "Use of transferred owner user after ownership transfer " +
        "transfer#0 to union_case.ok",
    },
  ]);

  const branch_wrapper_payload_transfer = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let flag = 1
let wrap = if flag {
  (payload: user_type) => result_type.ok(payload)
} else {
  (payload: user_type) => result_type.ok(payload)
}
let user: user_type = user_type {
  age: 40,
  score: 2
}
let result: result_type = wrap(user)

if let .ok(found) = result {
  found.age + found.score
} else {
  0
}
`));
  const branch_wrapper_payload_transfer_proof = Core.proof(
    branch_wrapper_payload_transfer,
  );
  const branch_wrapper_payload_transfer_wat = Emit.emit(
    Mod,
    Core.mod(branch_wrapper_payload_transfer),
  );

  assert_equals(branch_wrapper_payload_transfer_proof.ok, true);
  assert_equals(branch_wrapper_payload_transfer_proof.transfers, {
    transfers: [
      {
        id: "transfer#0",
        scope: "program#0/static_call/wrap/if_then",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
      {
        id: "transfer#1",
        scope: "program#0/static_call/wrap/if_else",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
    ],
    issues: [],
  });
  assert_equals(branch_wrapper_payload_transfer_proof.drops.steps, [
    {
      tag: "heap_drop",
      id: "drop#0",
      edge: "scope_exit",
      scope: "program#0",
      owner: "result",
      ownership: {
        tag: "unique_heap",
        reason: "runtime_union",
      },
      storage: "persistent_unique_heap",
      runtime: "no_op_bump_allocator",
      reason: "unique_heap runtime_union scope exit lowers to no-op with " +
        "bump allocator",
    },
  ]);
  assert_includes(branch_wrapper_payload_transfer_wat, "if (result i32)");
  assert_includes(branch_wrapper_payload_transfer_wat, "i32.add");

  const branch_wrapper_payload_transfer_use_after = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let flag = 1
let wrap = if flag {
  (payload: user_type) => result_type.ok(payload)
} else {
  (payload: user_type) => result_type.ok(payload)
}
let user: user_type = user_type {
  age: 40,
  score: 2
}
let result: result_type = wrap(user)
let total = if let .ok(found) = result {
  found.age + found.score
} else {
  0
}

total + user.age
`));
  const branch_wrapper_payload_transfer_use_after_proof = Core.proof(
    branch_wrapper_payload_transfer_use_after,
  );

  assert_equals(branch_wrapper_payload_transfer_use_after_proof.ok, false);
  assert_equals(
    branch_wrapper_payload_transfer_use_after_proof.transfers.issues,
    [
      {
        tag: "use_after_transfer",
        owner: "user",
        transfer: {
          id: "transfer#1",
          scope: "program#0/static_call/wrap/if_else",
          owner: "user",
          callee: "union_case.ok",
          argument: 0,
        },
        use: "value use",
        message: "Use of transferred owner user after ownership transfer " +
          "transfer#1 to union_case.ok",
      },
    ],
  );

  const branch_wrapper_alias_payload_transfer_use_after = Source.core(
    Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let flag = 1
let wrap = if flag {
  (payload: user_type) => result_type.ok(payload)
} else {
  (payload: user_type) => result_type.ok(payload)
}
let user: user_type = user_type {
  age: 40,
  score: 2
}
let alias: user_type = user
let result: result_type = wrap(alias)
let total = if let .ok(found) = result {
  found.age + found.score
} else {
  0
}

total + user.age
`),
  );
  const branch_wrapper_alias_payload_transfer_use_after_proof = Core.proof(
    branch_wrapper_alias_payload_transfer_use_after,
  );

  assert_equals(
    branch_wrapper_alias_payload_transfer_use_after_proof.ok,
    false,
  );
  assert_equals(
    branch_wrapper_alias_payload_transfer_use_after_proof.transfers.issues,
    [
      {
        tag: "use_after_transfer",
        owner: "user",
        transfer: {
          id: "transfer#1",
          scope: "program#0/static_call/wrap/if_else",
          owner: "user",
          callee: "union_case.ok",
          argument: 0,
        },
        use: "value use",
        message: "Use of transferred owner user after ownership transfer " +
          "transfer#1 to union_case.ok",
      },
    ],
  );

  const higher_order_alias_payload_transfer = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let wrap = (payload: user_type) => result_type.ok(payload)
let relay = (const f, payload: user_type) => {
  let g = f
  g(payload)
}
let user: user_type = user_type {
  age: 40,
  score: 2
}
let result: result_type = relay(wrap, user)

if let .ok(found) = result {
  found.age + found.score
} else {
  0
}
`));
  const higher_order_alias_payload_transfer_proof = Core.proof(
    higher_order_alias_payload_transfer,
  );

  assert_equals(higher_order_alias_payload_transfer_proof.ok, true);
  assert_equals(
    higher_order_alias_payload_transfer_proof.transfers.transfers,
    [
      {
        id: "transfer#0",
        scope: "program#0/static_call/relay/block/static_call/g",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
    ],
  );
  assert_includes(
    Emit.emit(Mod, Core.mod(higher_order_alias_payload_transfer)),
    "(local $found i32)",
  );

  const higher_order_alias_payload_transfer_use_after = Source.core(
    Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let wrap = (payload: user_type) => result_type.ok(payload)
let relay = (const f, payload: user_type) => {
  let g = f
  g(payload)
}
let user: user_type = user_type {
  age: 40,
  score: 2
}
let result: result_type = relay(wrap, user)
let total = if let .ok(found) = result {
  found.age + found.score
} else {
  0
}

total + user.age
`),
  );

  assert_throws(
    () => Core.check_proof(higher_order_alias_payload_transfer_use_after),
    "Use of transferred owner user after ownership transfer transfer#0 to " +
      "union_case.ok",
  );

  const branch_higher_order_alias_payload_transfer = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let wrap = (payload: user_type) => result_type.ok(payload)
let flag = 1
let relay = if flag {
  (const f, payload: user_type) => {
    let g = f
    g(payload)
  }
} else {
  (const f, payload: user_type) => {
    let g = f
    g(payload)
  }
}
let user: user_type = user_type {
  age: 40,
  score: 2
}
let result: result_type = relay(wrap, user)

if let .ok(found) = result {
  found.age + found.score
} else {
  0
}
`));
  const branch_higher_order_alias_payload_transfer_proof = Core.proof(
    branch_higher_order_alias_payload_transfer,
  );

  assert_equals(branch_higher_order_alias_payload_transfer_proof.ok, true);
  assert_equals(
    branch_higher_order_alias_payload_transfer_proof.transfers.transfers,
    [
      {
        id: "transfer#0",
        scope: "program#0/static_call/relay/if_then/block/static_call/g",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
      {
        id: "transfer#1",
        scope: "program#0/static_call/relay/if_else/block/static_call/g",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
    ],
  );
  assert_includes(
    Emit.emit(Mod, Core.mod(branch_higher_order_alias_payload_transfer)),
    "if (result i32)",
  );

  const branch_higher_order_alias_payload_transfer_use_after = Source.core(
    Source.parse(`
const user_type = struct {
  age: Int,
  score: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let wrap = (payload: user_type) => result_type.ok(payload)
let flag = 1
let relay = if flag {
  (const f, payload: user_type) => {
    let g = f
    g(payload)
  }
} else {
  (const f, payload: user_type) => {
    let g = f
    g(payload)
  }
}
let user: user_type = user_type {
  age: 40,
  score: 2
}
let result: result_type = relay(wrap, user)
let total = if let .ok(found) = result {
  found.age + found.score
} else {
  0
}

total + user.age
`),
  );

  assert_throws(
    () =>
      Core.check_proof(
        branch_higher_order_alias_payload_transfer_use_after,
      ),
    "Use of transferred owner user after ownership transfer transfer#1 to " +
      "union_case.ok",
  );
});

Deno.test("Core.emit materializes runtime aggregate values", () => {
  const core = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: I64,
  name: Text
}

let user: user_type = user_type {
  age: 41,
  score: 9i64,
  name: "Ada"
}

user
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_equals(Core.ownership(core), {
    tag: "unique_heap",
    reason: "runtime_aggregate",
  });
  assert_includes(wat, '(export "memory" (memory $memory))');
  assert_includes(
    wat,
    "(global $__closure_heap (mut i32) (i32.const 8))",
  );
  assert_includes(wat, "(local $_aggregate#0 i32)");
  assert_includes(wat, "i32.const 24");
  assert_includes(wat, "i32.const 41");
  assert_includes(wat, "i32.store offset=0");
  assert_includes(wat, "i64.const 9");
  assert_includes(wat, "i64.store offset=8");
  assert_includes(wat, "i32.store offset=16");

  const captured_field_core = Source.core(Source.parse(`
const pair_type = struct {
  age: Int,
  score: Int
}

let age = 41
let pair: pair_type = pair_type { age: age, score: 2 }
age = 0
pair
`));
  const captured_field_wat = Emit.emit(Mod, Core.mod(captured_field_core));

  assert_equals(Typed.type(Core, captured_field_core), "i32");
  assert_includes(captured_field_wat, "(local $_field_age#0 i32)");
  assert_includes(captured_field_wat, "(local $_aggregate#1 i32)");
  assert_includes(captured_field_wat, "local.set $_field_age#0");
  assert_includes(captured_field_wat, "local.get $_field_age#0");
  assert_includes(captured_field_wat, "i32.store offset=0");

  const runtime_field_core = Source.core(Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text) => user_type { name: name, age: 40 }
} else {
  (name: Text) => user_type { name: name, age: 5 }
}
let user: user_type = make("Ada")

len(user.name) + user.age
`));
  const runtime_field_wat = Emit.emit(Mod, Core.mod(runtime_field_core));

  assert_equals(Typed.type(Core, runtime_field_core), "i32");
  assert_includes(
    runtime_field_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );
  assert_includes(runtime_field_wat, "(local $user i32)");
  assert_includes(runtime_field_wat, "local.set $user");
  assert_includes(runtime_field_wat, "local.get $user");
  assert_includes(runtime_field_wat, "i32.load offset=0");
  assert_includes(runtime_field_wat, "i32.load offset=4");

  const runtime_pointer_core = Source.core(Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text) => user_type { name: name, age: 40 }
} else {
  (name: Text) => user_type { name: name, age: 5 }
}
let user: user_type = make("Ada")

user
`));

  assert_equals(Core.ownership(runtime_pointer_core), {
    tag: "unique_heap",
    reason: "runtime_aggregate",
  });
  assert_equals(
    Core.proof(runtime_pointer_core).final_result.storage,
    "persistent_unique_heap",
  );

  const frozen_runtime_pointer_core = Source.core(Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text) => user_type { name: name, age: 40 }
} else {
  (name: Text) => user_type { name: name, age: 5 }
}
let user: user_type = make("Ada")
let frozen: user_type = freeze user

len(frozen.name) + frozen.age
`));
  const frozen_runtime_pointer_wat = Emit.emit(
    Mod,
    Core.mod(frozen_runtime_pointer_core),
  );
  const frozen_runtime_pointer_proof = Core.proof(
    frozen_runtime_pointer_core,
  );

  assert_equals(Typed.type(Core, frozen_runtime_pointer_core), "i32");
  assert_equals(frozen_runtime_pointer_proof.ok, true);
  assert_equals(
    frozen_runtime_pointer_proof.freeze_edges.map((edge) => {
      return {
        id: edge.id,
        ownership: edge.analysis.ownership,
        decision: edge.analysis.decision,
      };
    }),
    [
      {
        id: "freeze#0",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_aggregate consumes the " +
            "owned buffer as immutable shareable storage",
        },
      },
    ],
  );
  assert_includes(frozen_runtime_pointer_wat, "(local $frozen i32)");
  assert_includes(frozen_runtime_pointer_wat, "local.set $frozen");
  assert_includes(frozen_runtime_pointer_wat, "local.get $frozen");
  assert_includes(frozen_runtime_pointer_wat, "i32.load offset=0");
  assert_includes(frozen_runtime_pointer_wat, "i32.load offset=4");

  const frozen_runtime_pointer_mutation_core = Source.core(Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text) => user_type { name: name, age: 40 }
} else {
  (name: Text) => user_type { name: name, age: 5 }
}
let user: user_type = make("Ada")
let frozen: user_type = freeze user
frozen[1] = 1
frozen.age
`));
  const frozen_runtime_pointer_mutation_message =
    "Cannot mutate frozen/shareable core binding: frozen";
  const frozen_runtime_pointer_mutation_proof = Core.proof(
    frozen_runtime_pointer_mutation_core,
  );

  assert_equals(frozen_runtime_pointer_mutation_proof.ok, false);
  assert_equals(
    frozen_runtime_pointer_mutation_proof.issues.map((issue) => issue.message),
    [frozen_runtime_pointer_mutation_message],
  );

  assert_throws(
    () => Core.check_proof(frozen_runtime_pointer_mutation_core),
    frozen_runtime_pointer_mutation_message,
  );

  assert_throws(
    () => Emit.emit(Core, frozen_runtime_pointer_mutation_core),
    frozen_runtime_pointer_mutation_message,
  );

  assert_throws(
    () => Core.mod(frozen_runtime_pointer_mutation_core),
    frozen_runtime_pointer_mutation_message,
  );

  const nested_field_core = Source.core(Source.parse(`
const name_type = struct {
  first: Text,
  last: Text
}
const user_type = struct {
  age: Int,
  name: name_type
}

let flag = 1
let make = if flag {
  (first: Text) => user_type {
    age: 40,
    name: name_type { first: first, last: "Lovelace" }
  }
} else {
  (first: Text) => user_type {
    age: 5,
    name: name_type { first: first, last: "Hopper" }
  }
}
let user: user_type = make("Ada")
let name: name_type = user.name

len(name.first) + len(name.last) + user.age
`));
  const nested_field_wat = Emit.emit(Mod, Core.mod(nested_field_core));

  assert_equals(Typed.type(Core, nested_field_core), "i32");
  assert_includes(nested_field_wat, "(local $name i32)");
  assert_includes(nested_field_wat, "i32.const 4");
  assert_includes(nested_field_wat, "i32.add");
  assert_includes(nested_field_wat, "local.set $name");
  assert_includes(nested_field_wat, "local.get $name");
  assert_includes(nested_field_wat, "i32.load offset=0");
  assert_includes(nested_field_wat, "i32.load offset=4");
  assert_includes(nested_field_wat, "local.get $user");
  assert_includes(nested_field_wat, "i32.load offset=0");

  const captured_pointer_core = Source.core(Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let make = if flag {
  (name: Text) => user_type { name: name, age: 41 }
} else {
  (name: Text) => user_type { name: name, age: 5 }
}
let user: user_type = make("Ada")
let get_age = if flag {
  () => user.age
} else {
  () => user.age + 1
}

get_age()
`));
  const captured_pointer_wat = Emit.emit(
    Mod,
    Core.mod(captured_pointer_core),
  );

  assert_equals(Typed.type(Core, captured_pointer_core), "i32");
  assert_includes(captured_pointer_wat, "(local $user i32)");
  assert_includes(captured_pointer_wat, "(local $__capture_2_user i32)");
  assert_includes(captured_pointer_wat, "local.get $user");
  assert_includes(captured_pointer_wat, "i32.store offset=4");
  assert_includes(captured_pointer_wat, "local.set $__capture_2_user");
  assert_includes(captured_pointer_wat, "local.get $__capture_2_user");
  assert_includes(captured_pointer_wat, "i32.load offset=4");

  const scratch_aggregate_core = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  name: Text
}
let flag = 1
let f = if flag {
  (x: Int) => x
} else {
  (x: Int) => x + 1
}

scratch {
  user_type { age: 41, name: "Ada" }
  f(7)
}
`));
  const scratch_aggregate_wat = Emit.emit(
    Mod,
    Core.mod(scratch_aggregate_core),
  );

  assert_equals(Typed.type(Core, scratch_aggregate_core), "i32");
  assert_includes(
    scratch_aggregate_wat,
    "(global $__closure_heap (mut i32) (i32.const 8))",
  );
  assert_includes(
    scratch_aggregate_wat,
    "(global $__scratch_heap (mut i32) (i32.const 32768))",
  );
  assert_includes(scratch_aggregate_wat, "global.get $__scratch_heap");
  assert_includes(scratch_aggregate_wat, "local.set $_aggregate#4");
  assert_includes(scratch_aggregate_wat, "global.set $__scratch_heap");
  assert_includes(scratch_aggregate_wat, "local.get $_aggregate#4");
  assert_includes(scratch_aggregate_wat, "drop");
  assert_equals(
    Core.proof(scratch_aggregate_core).allocations.facts.map((fact) => {
      return {
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [
      {
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "closure",
        },
        reason: "closure",
        expression: "lam",
      },
      {
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "closure",
        },
        reason: "closure",
        expression: "lam",
      },
      {
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_aggregate",
          },
        },
        reason: "runtime_aggregate",
        expression: "struct_value",
      },
    ],
  );

  const escaping_scratch_aggregate_core = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  name: Text
}

scratch {
  user_type { age: 41, name: "Ada" }
}
`));

  assert_equals(Typed.type(Core, escaping_scratch_aggregate_core), "i32");
  assert_throws(
    () => Core.check_proof(escaping_scratch_aggregate_core),
    "Rejected baseline proof final_result: scratch_backed over unique_heap " +
      "runtime_aggregate may reference storage reset before the final result " +
      "is used",
  );
  assert_throws(
    () => Core.mod(escaping_scratch_aggregate_core),
    "Rejected baseline proof final_result: scratch_backed over unique_heap " +
      "runtime_aggregate may reference storage reset before the final result " +
      "is used",
  );
});

Deno.test("Core.emit matches stored runtime scalar Text and struct union pointers", () => {
  const core = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

let flag = 1
let make = if flag {
  (x: Int) => result_type.ok(x)
} else {
  (x: Int) => result_type.err(x)
}
let result: result_type = make(41)

if let .ok(value) = result {
  value + 1
} else {
  0
}
`));
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(wat, "call_indirect (type $closure_i32_i32_to_i32)");
  assert_includes(wat, "(local $_union_match#");
  assert_includes(wat, "local.set $_union_match#");
  assert_includes(wat, "i32.load");
  assert_includes(wat, "i32.eq");
  assert_includes(wat, "i32.load offset=4");
  assert_includes(wat, "local.set $value");

  const text_core = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Unit
}

let flag = 1
let make = if flag {
  (x: Text) => result_type.ok(x)
} else {
  (x: Text) => result_type.err()
}
let result: result_type = make("Ada")

if let .ok(value) = result {
  len(value)
} else {
  0
}
`));
  const text_wat = Emit.emit(Mod, Core.mod(text_core));

  assert_equals(Typed.type(Core, text_core), "i32");
  assert_includes(text_wat, "call_indirect (type $closure_i32_i32_to_i32)");
  assert_includes(text_wat, "(local $_union_match#");
  assert_includes(text_wat, "i32.load offset=4");
  assert_includes(text_wat, "local.set $value");

  const struct_core = Source.core(Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let flag = 1
let make = if flag {
  (name: Text) => result_type.ok(user_type { name: name, age: 40 })
} else {
  (name: Text) => result_type.err()
}
let result: result_type = make("Ada")

if let .ok(user) = result {
  len(user.name) + user.age
} else {
  0
}
`));
  const struct_wat = Emit.emit(Mod, Core.mod(struct_core));

  assert_equals(Typed.type(Core, struct_core), "i32");
  assert_includes(struct_wat, "call_indirect (type $closure_i32_i32_to_i32)");
  assert_includes(struct_wat, "(local $user i32)");
  assert_includes(struct_wat, "local.set $user");
  assert_includes(struct_wat, "i32.load offset=0");
  assert_includes(struct_wat, "i32.load offset=4");

  const nested_core = Source.core(Source.parse(`
const name_type = struct {
  first: Text,
  last: Text
}
const user_type = struct {
  name: name_type,
  age: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let flag = 1
let make = if flag {
  (first: Text) => result_type.ok(user_type {
    name: name_type { first: first, last: "Lovelace" },
    age: 40
  })
} else {
  (first: Text) => result_type.err()
}
let result: result_type = make("Ada")

if let .ok(user) = result {
  len(user.name.first) + len(user.name.last) + user.age
} else {
  0
}
`));
  const nested_wat = Emit.emit(Mod, Core.mod(nested_core));

  assert_equals(Typed.type(Core, nested_core), "i32");
  assert_includes(nested_wat, "(local $user i32)");
  assert_includes(nested_wat, "local.set $user");
  assert_includes(nested_wat, "i32.load offset=0");
  assert_includes(nested_wat, "i32.load offset=4");
  assert_includes(nested_wat, "i32.load offset=8");

  const union_payload_core = Source.core(Source.parse(`
const inner_type = union {
  some: Int,
  none: Unit
}
const outer_type = union {
  ok: inner_type,
  err: Unit
}

let flag = 1
let make = if flag {
  (value: Int) => outer_type.ok(inner_type.some(value))
} else {
  (value: Int) => outer_type.err()
}
let result: outer_type = make(41)

if let .ok(inner) = result {
  if let .some(value) = inner {
    value + 1
  } else {
    0
  }
} else {
  0
}
`));
  const union_payload_wat = Emit.emit(Mod, Core.mod(union_payload_core));

  assert_equals(Typed.type(Core, union_payload_core), "i32");
  assert_includes(union_payload_wat, "local.set $inner");
  assert_includes(union_payload_wat, "local.set $value");
  assert_includes(union_payload_wat, "i32.store offset=4");
  assert_includes(union_payload_wat, "i32.load offset=4");

  const nested_union_core = Source.core(Source.parse(`
const inner_type = union {
  some: Int,
  none: Unit
}
const box_type = struct {
  inner: inner_type,
  bonus: Int
}
const result_type = union {
  ok: box_type,
  err: Unit
}

let flag = 1
let make = if flag {
  (value: Int) => result_type.ok(box_type {
    inner: inner_type.some(value),
    bonus: 1
  })
} else {
  (value: Int) => result_type.err()
}
let result: result_type = make(41)

if let .ok(box) = result {
  if let .some(value) = box.inner {
    value + box.bonus
  } else {
    0
  }
} else {
  0
}
`));
  const nested_union_wat = Emit.emit(Mod, Core.mod(nested_union_core));

  assert_equals(Typed.type(Core, nested_union_core), "i32");
  assert_includes(nested_union_wat, "(local $box i32)");
  assert_includes(nested_union_wat, "local.set $box");
  assert_includes(nested_union_wat, "i32.load offset=0");
  assert_includes(nested_union_wat, "i32.store offset=4");
  assert_includes(nested_union_wat, "i32.load offset=4");
});

Deno.test("Core.emit applies direct parameter annotation context", () => {
  const struct_core = Source.core(Source.parse(`
const pair_type = struct {
  first: Int,
  second: Int
}

const sum_pair = (pair: pair_type) => {
  pair.first + pair.second
}

sum_pair({
  first: 40,
  second: 2
})
`));

  assert_equals(Typed.type(Core, struct_core), "i32");
  assert_equals(
    Emit.emit(Core, struct_core).trim(),
    "i32.const 40\ni32.const 2\ni32.add",
  );

  const union_core = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

const unwrap = (result: result_type) => {
  if let .ok(value) = result {
    value + 1
  } else {
    0
  }
}

unwrap(.ok(41))
`));

  assert_equals(Typed.type(Core, union_core), "i32");
  assert_includes(Emit.emit(Core, union_core), "i32.const 41");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
const pair_type = struct {
  first: Int,
  second: Int
}

const sum_pair = (pair: pair_type) => {
  pair.first + pair.second
}

sum_pair({
  first: 40
})
`)),
      ),
    "Missing core struct field: second",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
const result_type = union {
  ok: Int
}

const unwrap = (result: result_type) => {
  if let .ok(value) = result {
    value
  } else {
    0
  }
}

unwrap(.ok("Ada"))
`)),
      ),
    "Core union case ok expects Int, got Text",
  );
});

Deno.test("Core.emit instantiates generic type constructors", () => {
  const option_core = Source.core(Source.parse(`
const option_type = t => union {
  some: t,
  none: Unit
}

const option_int_type: Type = option_type(Int)

let result: option_int_type = .some(41)

if let .some(value) = result {
  value + 1
} else {
  0
}
`));

  assert_equals(Typed.type(Core, option_core), "i32");
  assert_includes(Emit.emit(Core, option_core), "i32.const 41");

  const direct_core = Source.core(Source.parse(`
const option_type = t => union {
  some: t,
  none: Unit
}

let result = option_type(Int).some(41)

if let .some(value) = result {
  value + 1
} else {
  0
}
`));

  assert_equals(Typed.type(Core, direct_core), "i32");
  assert_includes(Emit.emit(Core, direct_core), "i32.const 41");

  const curried_core = Source.core(Source.parse(`
const result_type = e => t => union {
  ok: t,
  err: e
}

const parse_result_type = result_type(Text)(Int)

let result: parse_result_type = .ok(41)

if let .ok(value) = result {
  value + 1
} else {
  0
}
`));

  assert_equals(Typed.type(Core, curried_core), "i32");
  assert_includes(Emit.emit(Core, curried_core), "i32.const 41");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
const option_type = t => union {
  some: t,
  none: Unit
}

const option_text_type = option_type(Text)

let result: option_text_type = .some(41)

if let .some(value) = result {
  value
} else {
  ""
}
`)),
      ),
    "Core union case some expects Text, got I32",
  );
});

Deno.test("Core.emit elides type-level consts and type checks", () => {
  const core = Source.core(Source.parse(`
const int_type = Int

const user_type = struct {
  name: Text,
  age: int_type
}

const alias_type = user_type

let struct { age: int_type, .. } = alias_type

41
`));

  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(Format.fmt(Core, core), "type_check struct alias_type");
  assert_includes(wat, "i32.const 41");

  const union_core = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Text
}

let union { ok: Int, .. } = result_type

41
`));

  assert_equals(Typed.type(Core, union_core), "i32");
  assert_includes(Emit.emit(Core, union_core), "i32.const 41");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
const user_type = struct {
  age: Int
}

let struct { name: Text, .. } = user_type

41
`)),
      ),
    "Missing struct field: name",
  );

  assert_throws(
    () =>
      Emit.emit(
        Core,
        Source.core(Source.parse(`
const result_type = union {
  ok: Int
}

let struct { ok: Int, .. } = result_type

41
`)),
      ),
    "Expected struct type value",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  name: Text
}

let struct { age: Int } = user_type

41
`)),
      ),
    "Struct pattern does not allow extra fields",
  );
});

Deno.test("Core.emit rejects nodes that still need structured codegen", () => {
  const core = Source.core(Source.parse(`
let total = 0

for x in xs {
  total = total + x
}

total
`));

  assert_throws(
    () => Core.check_proof(core),
    "Cannot emit core collection_loop statement yet",
  );
  assert_throws(
    () => Emit.emit(Core, core),
    "Cannot emit core collection_loop statement yet",
  );

  const field_core = Source.core(Source.parse("user.name"));
  const field_proof = Core.proof(field_core);
  assert_equals(
    field_proof.issues[0]?.message,
    "Cannot emit core field expression yet",
  );
  assert_throws(
    () => Core.check_proof(field_core),
    "Cannot emit core field expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, field_core),
    "Cannot emit core field expression yet",
  );

  const index_core = Source.core(Source.parse("xs[i]"));
  const index_proof = Core.proof(index_core);
  assert_equals(
    index_proof.issues[0]?.message,
    "Cannot emit core index expression yet",
  );
  assert_throws(
    () => Core.check_proof(index_core),
    "Cannot emit core index expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, index_core),
    "Cannot emit core index expression yet",
  );

  const index_assign_core = Source.core(Source.parse(`
let xs = 1
xs[0] = 2
0
`));
  const index_assign_proof = Core.proof(index_assign_core);
  assert_equals(
    index_assign_proof.issues[0]?.message,
    "Cannot emit core index_assign statement yet",
  );
  assert_throws(
    () => Core.check_proof(index_assign_core),
    "Cannot emit core index_assign statement yet",
  );
  assert_throws(
    () => Emit.emit(Core, index_assign_core),
    "Cannot emit core index_assign statement yet",
  );

  const unbound_index_assign_core = Source.core(Source.parse(`
xs[0] = 2
0
`));
  const unbound_index_assign_proof = Core.proof(unbound_index_assign_core);
  assert_equals(
    unbound_index_assign_proof.issues[0]?.message,
    "Cannot emit core index_assign statement yet",
  );
  assert_throws(
    () => Core.check_proof(unbound_index_assign_core),
    "Cannot emit core index_assign statement yet",
  );
  assert_throws(
    () => Emit.emit(Core, unbound_index_assign_core),
    "Cannot emit core index_assign statement yet",
  );

  const comptime_bind_core = Source.core(Source.parse(`
let x = comptime 1
x
`));
  const comptime_bind_proof = Core.proof(comptime_bind_core);
  assert_equals(
    comptime_bind_proof.issues[0]?.message,
    "Cannot emit core comptime expression yet",
  );
  assert_throws(
    () => Core.check_proof(comptime_bind_core),
    "Cannot emit core comptime expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, comptime_bind_core),
    "Cannot emit core comptime expression yet",
  );

  const comptime_assign_core = Source.core(Source.parse(`
let x = 0
x = comptime 1
x
`));
  const comptime_assign_proof = Core.proof(comptime_assign_core);
  assert_equals(
    comptime_assign_proof.issues[0]?.message,
    "Cannot emit core comptime expression yet",
  );
  assert_throws(
    () => Core.check_proof(comptime_assign_core),
    "Cannot emit core comptime expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, comptime_assign_core),
    "Cannot emit core comptime expression yet",
  );

  const nonfinal_field_core = Source.core(Source.parse(`
user.name
0
`));
  const nonfinal_field_proof = Core.proof(nonfinal_field_core);
  assert_equals(
    nonfinal_field_proof.issues[0]?.message,
    "Cannot emit core field expression yet",
  );
  assert_throws(
    () => Core.check_proof(nonfinal_field_core),
    "Cannot emit core field expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, nonfinal_field_core),
    "Cannot emit core field expression yet",
  );

  const nonfinal_index_core = Source.core(Source.parse(`
xs[i]
0
`));
  const nonfinal_index_proof = Core.proof(nonfinal_index_core);
  assert_equals(
    nonfinal_index_proof.issues[0]?.message,
    "Cannot emit core index expression yet",
  );
  assert_throws(
    () => Core.check_proof(nonfinal_index_core),
    "Cannot emit core index expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, nonfinal_index_core),
    "Cannot emit core index expression yet",
  );

  const unsupported_builtin_collection_calls = [
    {
      source: "let x = 1\nlen(x)",
      type_message: "Cannot type core len over unknown collection or text",
      emit_message: "Cannot emit core len over unknown collection or text",
    },
    {
      source: "let x = 1\nget(x, 0)",
      type_message: "Cannot type core get over unknown collection",
      emit_message: "Cannot emit core get over unknown collection",
    },
  ];

  for (const item of unsupported_builtin_collection_calls) {
    const builtin_core = Source.core(Source.parse(item.source));
    assert_equals(
      Core.proof(builtin_core).issues[0]?.message,
      item.emit_message,
    );
    assert_throws(
      () => Typed.type(Core, builtin_core),
      item.type_message,
    );
    assert_throws(
      () => Core.check_proof(builtin_core),
      item.emit_message,
    );
    assert_throws(
      () => Emit.emit(Core, builtin_core),
      item.emit_message,
    );

    const nonfinal_builtin_core = Source.core(
      Source.parse(item.source + "\n0"),
    );
    assert_equals(
      Core.proof(nonfinal_builtin_core).issues[0]?.message,
      item.emit_message,
    );
    assert_throws(
      () => Core.check_proof(nonfinal_builtin_core),
      item.emit_message,
    );
    assert_throws(
      () => Emit.emit(Core, nonfinal_builtin_core),
      item.emit_message,
    );
  }

  const if_let_expr_core = Source.core(Source.parse(`
if let .ok(value) = result {
  value
} else {
  0
}
`));
  const if_let_expr_proof = Core.proof(if_let_expr_core);
  assert_equals(
    if_let_expr_proof.issues[0]?.message,
    "Cannot emit core if_let expression yet",
  );
  assert_throws(
    () => Core.check_proof(if_let_expr_core),
    "Cannot emit core if_let expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, if_let_expr_core),
    "Cannot emit core if_let expression yet",
  );

  const if_let_stmt_core = Source.core(Source.parse(`
if let .ok(value) = result {
  value
}

0
`));
  const if_let_stmt_proof = Core.proof(if_let_stmt_core);
  assert_equals(
    if_let_stmt_proof.issues[0]?.message,
    "Cannot emit core if_let_stmt statement yet",
  );
  assert_throws(
    () => Core.check_proof(if_let_stmt_core),
    "Cannot emit core if_let_stmt statement yet",
  );
  assert_throws(
    () => Emit.emit(Core, if_let_stmt_core),
    "Cannot emit core if_let_stmt statement yet",
  );

  const app_core = Source.core(Source.parse("foo(1)"));
  const app_proof = Core.proof(app_core);
  assert_equals(
    app_proof.issues[0]?.message,
    "Cannot emit core app expression yet",
  );
  assert_throws(
    () => Core.check_proof(app_core),
    "Cannot emit core app expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, app_core),
    "Cannot emit core app expression yet",
  );

  const direct_type_core = Source.core(Source.parse(`
struct {
  name: Text
}
`));
  const direct_type_proof = Core.proof(direct_type_core);
  assert_equals(
    direct_type_proof.issues[0]?.message,
    "Cannot emit core type value expression yet",
  );
  assert_throws(
    () => Core.check_proof(direct_type_core),
    "Cannot emit core type value expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, direct_type_core),
    "Cannot emit core type value expression yet",
  );

  const named_type_core = Source.core(Source.parse(`
const user_type = struct {
  name: Text
}

user_type
`));
  const named_type_proof = Core.proof(named_type_core);
  assert_equals(
    named_type_proof.issues[0]?.message,
    "Cannot emit core type value expression yet",
  );
  assert_throws(
    () => Core.check_proof(named_type_core),
    "Cannot emit core type value expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, named_type_core),
    "Cannot emit core type value expression yet",
  );

  const runtime_type_expr_core: CoreNode = {
    tag: "program",
    statements: [
      {
        tag: "expr",
        expr: {
          tag: "struct_type",
          fields: [{ name: "name", type_name: "Text" }],
        },
      },
      { tag: "expr", expr: { tag: "num", type: "i32", value: 1 } },
    ],
  };
  const runtime_type_expr_proof = Core.proof(runtime_type_expr_core);
  assert_equals(
    runtime_type_expr_proof.issues[0]?.message,
    "Cannot emit core type value expression yet",
  );
  assert_throws(
    () => Core.check_proof(runtime_type_expr_core),
    "Cannot emit core type value expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, runtime_type_expr_core),
    "Cannot emit core type value expression yet",
  );

  const runtime_type_bind_core: CoreNode = {
    tag: "program",
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: "runtime_type",
        is_linear: false,
        annotation: undefined,
        value: {
          tag: "struct_type",
          fields: [{ name: "name", type_name: "Text" }],
        },
      },
      { tag: "expr", expr: { tag: "num", type: "i32", value: 1 } },
    ],
  };
  const runtime_type_bind_proof = Core.proof(runtime_type_bind_core);
  assert_equals(
    runtime_type_bind_proof.issues[0]?.message,
    "Cannot emit core type value expression yet",
  );
  assert_throws(
    () => Core.check_proof(runtime_type_bind_core),
    "Cannot emit core type value expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, runtime_type_bind_core),
    "Cannot emit core type value expression yet",
  );

  const static_type_bind_core: CoreNode = {
    tag: "program",
    statements: [
      {
        tag: "bind",
        kind: "const",
        name: "static_type",
        is_linear: false,
        annotation: undefined,
        value: {
          tag: "struct_type",
          fields: [{ name: "name", type_name: "Text" }],
        },
      },
      { tag: "expr", expr: { tag: "num", type: "i32", value: 1 } },
    ],
  };
  assert_equals(Core.proof(static_type_bind_core).issues, []);
  assert_equals(Emit.emit(Core, static_type_bind_core).trim(), "i32.const 1");

  const direct_linear_core: CoreNode = {
    tag: "program",
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: "x",
        is_linear: true,
        annotation: "I32",
        value: { tag: "num", type: "i32", value: 42 },
      },
      { tag: "expr", expr: { tag: "linear", name: "x" } },
    ],
  };
  assert_equals(Core.proof(direct_linear_core).issues, []);
  assert_includes(Emit.emit(Core, direct_linear_core), "local.get $x");

  const direct_unsupported_exprs: {
    expr: CoreExpr;
    message: string;
  }[] = [
    {
      expr: {
        tag: "rec",
        params: [],
        body: { tag: "num", type: "i32", value: 1 },
      },
      message: "Cannot emit core rec expression yet",
    },
    {
      expr: {
        tag: "comptime",
        expr: { tag: "num", type: "i32", value: 1 },
      },
      message: "Cannot emit core comptime expression yet",
    },
    {
      expr: { tag: "with", base: { tag: "var", name: "x" }, fields: [] },
      message: "Cannot emit core with expression yet",
    },
    {
      expr: {
        tag: "struct_update",
        base: { tag: "var", name: "x" },
        fields: [],
      },
      message: "Cannot emit core struct_update expression yet",
    },
  ];

  for (const item of direct_unsupported_exprs) {
    const core: CoreNode = {
      tag: "program",
      statements: [{ tag: "expr", expr: item.expr }],
    };
    assert_equals(Core.proof(core).issues[0]?.message, item.message);
    assert_throws(() => Core.check_proof(core), item.message);
    assert_throws(() => Emit.emit(Core, core), item.message);
  }

  const final_lam_core = Source.core(Source.parse("x => x"));
  assert_equals(
    Core.proof(final_lam_core).issues[0]?.message,
    "Cannot emit core lam expression yet",
  );
  assert_throws(
    () => Core.check_proof(final_lam_core),
    "Cannot emit core lam expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, final_lam_core),
    "Cannot emit core lam expression yet",
  );

  const nonfinal_lam_core = Source.core(Source.parse(`
(x => x)
0
`));
  assert_equals(
    Core.proof(nonfinal_lam_core).issues[0]?.message,
    "Cannot emit core lam expression yet",
  );
  assert_throws(
    () => Core.check_proof(nonfinal_lam_core),
    "Cannot emit core lam expression yet",
  );
  assert_throws(
    () => Emit.emit(Core, nonfinal_lam_core),
    "Cannot emit core lam expression yet",
  );

  const final_collection_loop_core = Source.core(Source.parse(`
for x in xs {
  x
}
`));
  assert_equals(
    Core.proof(final_collection_loop_core).issues[0]?.message,
    "Cannot emit core collection_loop statement yet",
  );
  assert_throws(
    () => Core.check_proof(final_collection_loop_core),
    "Cannot emit core collection_loop statement yet",
  );
  assert_throws(
    () => Emit.emit(Core, final_collection_loop_core),
    "Cannot emit core collection_loop statement yet",
  );

  const final_if_let_stmt_core = Source.core(Source.parse(`
if let .ok(value) = result {
  value
}
`));
  assert_equals(
    Core.proof(final_if_let_stmt_core).issues[0]?.message,
    "Cannot emit core if_let_stmt statement yet",
  );
  assert_throws(
    () => Core.check_proof(final_if_let_stmt_core),
    "Cannot emit core if_let_stmt statement yet",
  );
  assert_throws(
    () => Emit.emit(Core, final_if_let_stmt_core),
    "Cannot emit core if_let_stmt statement yet",
  );

  const outside_loop_controls: {
    stmt: Extract<
      CoreNode["statements"][number],
      { tag: "break" | "continue" }
    >;
    message: string;
  }[] = [
    {
      stmt: { tag: "break" },
      message: "Cannot emit core break outside loop",
    },
    {
      stmt: { tag: "continue" },
      message: "Cannot emit core continue outside loop",
    },
  ];

  for (const item of outside_loop_controls) {
    const nonfinal_core: CoreNode = {
      tag: "program",
      statements: [
        item.stmt,
        { tag: "expr", expr: { tag: "num", type: "i32", value: 0 } },
      ],
    };
    assert_equals(Core.proof(nonfinal_core).issues[0]?.message, item.message);
    assert_throws(() => Core.check_proof(nonfinal_core), item.message);
    assert_throws(() => Emit.emit(Core, nonfinal_core), item.message);

    const final_core: CoreNode = {
      tag: "program",
      statements: [item.stmt],
    };
    assert_equals(Core.proof(final_core).issues[0]?.message, item.message);
    assert_throws(() => Core.check_proof(final_core), item.message);
    assert_throws(() => Emit.emit(Core, final_core), item.message);
  }

  const unsupported_binding_values: {
    name: string;
    value: CoreExpr;
    message: string;
  }[] = [
    {
      name: "with",
      value: { tag: "with", base: { tag: "var", name: "x" }, fields: [] },
      message: "Cannot emit core with expression yet",
    },
    {
      name: "unsupported",
      value: { tag: "unsupported", feature: "demo", text: "demo" },
      message: "Cannot emit core unsupported expression yet",
    },
    {
      name: "struct_update",
      value: {
        tag: "struct_update",
        base: { tag: "var", name: "x" },
        fields: [],
      },
      message: "Cannot emit core struct_update expression yet",
    },
  ];

  for (const item of unsupported_binding_values) {
    const let_core: CoreNode = {
      tag: "program",
      statements: [
        {
          tag: "bind",
          kind: "let",
          name: item.name,
          is_linear: false,
          annotation: undefined,
          value: item.value,
        },
        { tag: "expr", expr: { tag: "num", type: "i32", value: 0 } },
      ],
    };
    assert_equals(Core.proof(let_core).issues[0]?.message, item.message);
    assert_throws(() => Core.check_proof(let_core), item.message);
    assert_throws(() => Emit.emit(Core, let_core), item.message);

    const assign_core: CoreNode = {
      tag: "program",
      statements: [
        {
          tag: "bind",
          kind: "let",
          name: item.name,
          is_linear: false,
          annotation: undefined,
          value: { tag: "num", type: "i32", value: 0 },
        },
        {
          tag: "assign",
          name: item.name,
          mode: "same",
          value: item.value,
        },
        { tag: "expr", expr: { tag: "num", type: "i32", value: 0 } },
      ],
    };
    assert_equals(Core.proof(assign_core).issues[0]?.message, item.message);
    assert_throws(() => Core.check_proof(assign_core), item.message);
    assert_throws(() => Emit.emit(Core, assign_core), item.message);
  }

  const direct_struct_update_core = Source.core(Source.parse(`
let user = { age: 40, score: 2 }
user { age: 41 }
`));
  assert_equals(
    Core.proof(direct_struct_update_core).issues[0]?.message,
    "Cannot emit core struct_update expression yet",
  );
  assert_throws(
    () => Core.check_proof(direct_struct_update_core),
    "Cannot emit core struct_update expression yet",
  );

  const struct_update_projection_core = Source.core(Source.parse(`
let user = { age: 40, score: 2 }
(user { age: 41 }).age
`));
  assert_equals(Core.proof(struct_update_projection_core).issues, []);
  assert_equals(
    Emit.emit(Core, struct_update_projection_core).trim(),
    "i32.const 41",
  );
});

Deno.test("Core rejects static values carried through dynamic loops", () => {
  const range_core = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let n = len(prefix) - 1
let existing: result_type = result_type.err(5)

for i in 0..n {
  existing = result_type.ok(append(prefix, "da"))
}

let result: result_type = scratch {
  let temp = existing
  freeze temp
}

if let .ok(value) = result {
  len(value)
} else {
  0
}
`));

  assert_throws(
    () => Typed.type(Core, range_core),
    "Cannot carry static aggregate/union core value through dynamic range loop yet: existing",
  );
  assert_throws(
    () => Core.check_proof(range_core),
    "Cannot carry static aggregate/union core value through dynamic range loop yet: existing",
  );
  assert_throws(
    () => Emit.emit(Core, range_core),
    "Cannot carry static aggregate/union core value through dynamic range loop yet: existing",
  );

  const collection_core = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Int
}

let start = 0
let bytes: Text = slice("Ada", start, 1)
let existing: result_type = result_type.err(5)

for byte in bytes {
  existing = result_type.ok("Ada")
}

let result: result_type = scratch {
  let temp = existing
  freeze temp
}

if let .ok(value) = result {
  len(value)
} else {
  0
}
`));

  assert_throws(
    () => Typed.type(Core, collection_core),
    "Cannot carry static aggregate/union core value through dynamic collection loop yet: existing",
  );
  assert_throws(
    () => Core.check_proof(collection_core),
    "Cannot carry static aggregate/union core value through dynamic collection loop yet: existing",
  );
  assert_throws(
    () => Emit.emit(Core, collection_core),
    "Cannot carry static aggregate/union core value through dynamic collection loop yet: existing",
  );

  const alias_core = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let n = len(prefix) - 1
let selected: result_type = result_type.ok(append(prefix, "da"))
let existing: result_type = result_type.err(5)

for i in 0..n {
  existing = selected
}

let result: result_type = scratch {
  let temp = existing
  freeze temp
}

if let .ok(value) = result {
  len(value)
} else {
  0
}
`));

  assert_throws(
    () => Core.check_proof(alias_core),
    "Cannot carry static aggregate/union core value through dynamic range loop yet: existing",
  );
});

Deno.test("Core.emit preserves scalar ownership and scratchpad nodes", () => {
  const borrowed = Source.core(Source.parse("borrow (1 + 2)"));
  assert_equals(Format.fmt(Core, borrowed), "borrow 1:i32 i32.add 2:i32");
  assert_equals(Core.ownership(borrowed), {
    tag: "scalar_local",
    type: "i32",
  });
  assert_equals(Core.escape(borrowed), {
    edge: "final_result",
    ownership: {
      tag: "scalar_local",
      type: "i32",
    },
    storage: "scalar_local",
    escapes: false,
    decision: {
      tag: "allowed",
      reason: "scalar local result does not escape linear memory",
    },
  });
  assert_equals(Core.borrows(borrowed), {
    edges: [
      {
        id: "borrow#0",
        source_scope: "program#0",
        target_scope: "program#0",
        ownership: {
          tag: "scalar_local",
          type: "i32",
        },
        decision: {
          tag: "allowed",
          reason: "scalar locals do not create a borrow lifetime",
        },
      },
    ],
    barriers: [],
    skipped_closures: [],
  });
  assert_equals(Core.validate_borrows(borrowed), {
    ok: true,
    issues: [],
  });
  Core.check_borrows(borrowed);
  assert_equals(Typed.type(Core, borrowed), "i32");
  assert_includes(Emit.emit(Core, borrowed), "i32.add");

  const frozen = Source.core(Source.parse("freeze (40i64 + 2i64)"));
  assert_equals(
    Format.fmt(Core, frozen),
    "freeze 40:i64 i64.add 2:i64",
  );
  assert_equals(Core.ownership(frozen), {
    tag: "scalar_local",
    type: "i64",
  });
  assert_equals(Typed.type(Core, frozen), "i64");
  assert_includes(Emit.emit(Core, frozen), "i64.add");

  const scratch = Source.core(Source.parse("scratch { 1 + 2 }"));
  assert_equals(Format.fmt(Core, scratch), "scratch { 1:i32 i32.add 2:i32 }");
  assert_equals(Core.ownership(scratch), {
    tag: "scalar_local",
    type: "i32",
  });
  assert_equals(Core.cleanup(scratch), {
    steps: [
      {
        tag: "scratch_reset",
        scope: "scratch#0",
        exit_edges: ["fallthrough"],
        return_value: {
          edge: "scratch_return",
          ownership: {
            tag: "scalar_local",
            type: "i32",
          },
          storage: "scalar_local",
          escapes: false,
          decision: {
            tag: "allowed",
            reason: "scalar locals can leave a scratch scope",
          },
        },
      },
    ],
  });
  assert_equals(Core.lifetimes(scratch), {
    scopes: [
      {
        id: "program#0",
        kind: "program",
        parent: undefined,
        boundary: "program",
      },
      {
        id: "scratch#0",
        kind: "scratch",
        parent: "program#0",
        boundary: "scratchpad",
        exit_edges: ["fallthrough"],
      },
      {
        id: "block#0",
        kind: "block",
        parent: "scratch#0",
        boundary: "block",
      },
    ],
  });
  assert_equals(Typed.type(Core, scratch), "i32");
  const scratch_wat = Emit.emit(Core, scratch);
  assert_includes(scratch_wat, "(local $_scratch_base#0 i32)");
  assert_includes(scratch_wat, "(local $_scratch_result#1 i32)");
  assert_includes(scratch_wat, "global.get $__scratch_heap");
  assert_includes(scratch_wat, "local.set $_scratch_base#0");
  assert_includes(scratch_wat, "i32.add");
  assert_includes(scratch_wat, "local.set $_scratch_result#1");
  assert_includes(scratch_wat, "global.set $__scratch_heap");
  assert_includes(scratch_wat, "local.get $_scratch_result#1");

  const scratch_mod_wat = Emit.emit(Mod, Core.mod(scratch));
  assert_includes(scratch_mod_wat, "(memory $memory 1)");
  assert_includes(
    scratch_mod_wat,
    "(global $__scratch_heap (mut i32) (i32.const 0))",
  );

  const closure_scratch = Source.core(Source.parse(`
let f = (value: Int) => {
  scratch { value + 1 }
}

f(1)
`));
  assert_equals(Core.cleanup(closure_scratch), {
    steps: [
      {
        tag: "scratch_reset",
        scope: "scratch#0",
        exit_edges: ["fallthrough"],
        return_value: {
          edge: "scratch_return",
          ownership: {
            tag: "scalar_local",
            type: "i32",
          },
          storage: "scalar_local",
          escapes: false,
          decision: {
            tag: "allowed",
            reason: "scalar locals can leave a scratch scope",
          },
        },
      },
    ],
  });
  assert_equals(
    Core.proof(closure_scratch).cleanup,
    Core.cleanup(closure_scratch),
  );
  Core.check_proof(closure_scratch);

  const text_literal = Source.core(Source.parse('"text"'));
  assert_equals(Core.ownership(text_literal), {
    tag: "frozen_shareable",
    reason: "text",
  });
  assert_equals(Core.escape(text_literal), {
    edge: "final_result",
    ownership: {
      tag: "frozen_shareable",
      reason: "text",
    },
    storage: "static_data",
    escapes: true,
    decision: {
      tag: "allowed",
      reason: "frozen_shareable text may escape as immutable shareable data",
    },
  });

  const frozen_text = Source.core(Source.parse('freeze "text"'));
  assert_equals(Core.ownership(frozen_text), {
    tag: "frozen_shareable",
    reason: "freeze",
  });
  assert_equals(Core.escape(frozen_text), {
    edge: "final_result",
    ownership: {
      tag: "frozen_shareable",
      reason: "freeze",
    },
    storage: "frozen_heap",
    escapes: true,
    decision: {
      tag: "allowed",
      reason: "frozen_shareable freeze may escape as immutable shareable data",
    },
  });
  assert_equals(Typed.type(Core, frozen_text), "i32");
  assert_includes(Emit.emit(Core, frozen_text), "i32.const");

  const bound_frozen_text = Source.core(Source.parse(`
let message = freeze "text"
len(message)
`));
  assert_equals(Typed.type(Core, bound_frozen_text), "i32");
  assert_equals(Emit.emit(Core, bound_frozen_text).trim(), "i32.const 4");

  const closure_value = Source.core(Source.parse("(x: Int) => x"));
  assert_equals(Core.ownership(closure_value), {
    tag: "unique_heap",
    reason: "closure",
  });
  assert_equals(Core.escape(closure_value), {
    edge: "final_result",
    ownership: {
      tag: "unique_heap",
      reason: "closure",
    },
    storage: "persistent_unique_heap",
    escapes: true,
    decision: {
      tag: "allowed",
      reason: "unique_heap closure escapes as the owned final result",
    },
  });

  const scratch_closure_expr: CoreExpr = {
    tag: "scratch",
    body: {
      tag: "lam",
      params: [
        {
          name: "x",
          is_const: false,
          is_linear: false,
          annotation: "Int",
        },
      ],
      body: { tag: "var", name: "x" },
    },
  };
  assert_equals(
    core_expr_ownership(scratch_closure_expr, {}, {
      closure_fn_type: (expr) => {
        if (expr.tag === "lam") {
          return {
            tag: "fn",
            params: ["i32"],
            param_texts: [false],
            result: "i32",
            result_text: false,
            result_struct: undefined,
            result_union: undefined,
          };
        }

        return undefined;
      },
      core_expr_is_text: () => false,
      expr_type: () => "i32",
      runtime_union_value: () => undefined,
      static_struct_value: () => undefined,
      static_text_value: () => undefined,
    }),
    {
      tag: "scratch_backed",
      source: {
        tag: "unique_heap",
        reason: "closure",
      },
    },
  );
  assert_equals(
    core_scratch_return_lifetime_decision({
      tag: "unique_heap",
      reason: "closure",
    }),
    {
      tag: "rejected",
      reason:
        "unique_heap closure cannot leave scratch without freeze or explicit promotion",
    },
  );
  assert_equals(
    core_borrow_lifetime_decision({
      tag: "unique_heap",
      reason: "closure",
    }),
    {
      tag: "rejected",
      reason:
        "borrow over unique_heap closure needs lexical lifetime tracking before the owner can be protected",
    },
  );
  assert_equals(
    core_freeze_lifetime_decision({
      tag: "unique_heap",
      reason: "runtime_union",
    }),
    {
      tag: "allowed",
      reason:
        "freeze of unique_heap runtime_union consumes the owned buffer as immutable shareable storage",
    },
  );
  assert_equals(
    core_borrow_lifetime_decision({
      tag: "frozen_shareable",
      reason: "text",
    }),
    {
      tag: "allowed",
      reason: "frozen_shareable values are immutable and freely shareable",
    },
  );
  assert_equals(
    core_escape_analysis("scratch_return", {
      tag: "scratch_backed",
      source: {
        tag: "unique_heap",
        reason: "closure",
      },
    }),
    {
      edge: "scratch_return",
      ownership: {
        tag: "scratch_backed",
        source: {
          tag: "unique_heap",
          reason: "closure",
        },
      },
      storage: "rejected",
      escapes: true,
      decision: {
        tag: "rejected",
        reason:
          "scratch_backed over unique_heap closure may reference storage reset at scratch scope exit",
      },
    },
  );
  assert_equals(
    core_escape_analysis("borrow_view", {
      tag: "unique_heap",
      reason: "text",
    }),
    {
      edge: "borrow_view",
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "rejected",
      escapes: true,
      decision: {
        tag: "rejected",
        reason:
          "borrow over unique_heap text needs lexical lifetime tracking before the owner can be protected",
      },
    },
  );
  assert_equals(
    core_escape_analysis("freeze", {
      tag: "scratch_backed",
      source: {
        tag: "unique_heap",
        reason: "runtime_union",
      },
    }),
    {
      edge: "freeze",
      ownership: {
        tag: "scratch_backed",
        source: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
      },
      storage: "rejected",
      escapes: true,
      decision: {
        tag: "rejected",
        reason:
          "freeze of scratch_backed over unique_heap runtime_union needs explicit scratch-to-heap promotion before scratch reset",
      },
    },
  );

  const scratch_text = Source.core(Source.parse('scratch { "temp" }'));
  assert_equals(Core.ownership(scratch_text), {
    tag: "frozen_shareable",
    reason: "text",
  });
  assert_equals(Core.cleanup(scratch_text), {
    steps: [
      {
        tag: "scratch_reset",
        scope: "scratch#0",
        exit_edges: ["fallthrough"],
        return_value: {
          edge: "scratch_return",
          ownership: {
            tag: "frozen_shareable",
            reason: "text",
          },
          storage: "static_data",
          escapes: true,
          decision: {
            tag: "allowed",
            reason: "frozen_shareable values do not reference scratch storage",
          },
        },
      },
    ],
  });
  assert_equals(Typed.type(Core, scratch_text), "i32");
  const scratch_text_wat = Emit.emit(Core, scratch_text);
  assert_includes(scratch_text_wat, "global.get $__scratch_heap");
  assert_includes(scratch_text_wat, "i32.const");
  assert_includes(scratch_text_wat, "global.set $__scratch_heap");

  const scratch_borrowed_text = Source.core(
    Source.parse('scratch { borrow "temp" }'),
  );
  assert_equals(Core.borrows(scratch_borrowed_text), {
    edges: [
      {
        id: "borrow#0",
        source_scope: "block#0",
        target_scope: "block#0",
        ownership: {
          tag: "frozen_shareable",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "frozen_shareable values are immutable and freely shareable",
        },
      },
    ],
    barriers: [],
    skipped_closures: [],
  });
  assert_equals(Core.validate_borrows(scratch_borrowed_text), {
    ok: true,
    issues: [],
  });
  Core.check_borrows(scratch_borrowed_text);

  const scratch_frozen_text = Source.core(
    Source.parse('scratch { freeze "temp" }'),
  );
  assert_equals(Core.ownership(scratch_frozen_text), {
    tag: "frozen_shareable",
    reason: "freeze",
  });
  assert_equals(Typed.type(Core, scratch_frozen_text), "i32");
  const scratch_frozen_text_wat = Emit.emit(Core, scratch_frozen_text);
  assert_includes(scratch_frozen_text_wat, "global.get $__scratch_heap");
  assert_includes(scratch_frozen_text_wat, "i32.const");
  assert_includes(scratch_frozen_text_wat, "global.set $__scratch_heap");

  const scratch_local = Source.core(Source.parse(`
scratch {
  let x = 1
  x + 2
}
`));
  const scratch_local_wat = Emit.emit(Core, scratch_local);

  assert_equals(Typed.type(Core, scratch_local), "i32");
  assert_includes(scratch_local_wat, "(local $x i32)");
  assert_includes(scratch_local_wat, "global.get $__scratch_heap");
  assert_includes(scratch_local_wat, "local.set $x");
  assert_includes(scratch_local_wat, "local.get $x");
  assert_includes(scratch_local_wat, "global.set $__scratch_heap");

  const scratch_return_edges = Source.core(Source.parse(`
scratch {
  if 1 {
    return 2
  }

  3
}
`));
  assert_equals(Core.cleanup(scratch_return_edges).steps, [
    {
      tag: "scratch_reset",
      scope: "scratch#0",
      exit_edges: ["fallthrough", "return"],
      return_value: {
        edge: "scratch_return",
        ownership: {
          tag: "scalar_local",
          type: "i32",
        },
        storage: "scalar_local",
        escapes: false,
        decision: {
          tag: "allowed",
          reason: "scalar locals can leave a scratch scope",
        },
      },
    },
  ]);
  const scratch_return_edges_wat = Emit.emit(Core, scratch_return_edges);
  assert_includes(
    scratch_return_edges_wat,
    [
      "  local.get $_scratch_base#0",
      "  global.set $__scratch_heap",
      "  return",
    ].join("\n"),
  );

  const scratch_loop_edges = Source.core(Source.parse(`
for i in 0..3 {
  scratch {
    if i {
      break
    }

    1
  }

  scratch {
    if i {
      continue
    }

    1
  }

  scratch {
    for j in 0..1 {
      break
    }

    1
  }
}

0
`));
  assert_equals(
    Core.cleanup(scratch_loop_edges).steps.map((step) => step.exit_edges),
    [
      ["fallthrough", "break"],
      ["fallthrough", "continue"],
      ["fallthrough"],
    ],
  );
  const scratch_loop_edges_wat = Emit.emit(Core, scratch_loop_edges);
  assert_includes(
    scratch_loop_edges_wat,
    [
      "        local.get $_scratch_base#0",
      "        global.set $__scratch_heap",
      "        br $range_exit_0",
    ].join("\n"),
  );
  assert_includes(
    scratch_loop_edges_wat,
    [
      "        local.get $_scratch_base#2",
      "        global.set $__scratch_heap",
      "        br $range_continue_0",
    ].join("\n"),
  );
  assert_equals(Core.lifetimes(scratch_loop_edges), {
    scopes: [
      {
        id: "program#0",
        kind: "program",
        parent: undefined,
        boundary: "program",
      },
      {
        id: "loop#0",
        kind: "loop",
        parent: "program#0",
        boundary: "loop_iteration",
      },
      {
        id: "scratch#0",
        kind: "scratch",
        parent: "loop#0",
        boundary: "scratchpad",
        exit_edges: ["fallthrough", "break"],
      },
      {
        id: "block#0",
        kind: "block",
        parent: "scratch#0",
        boundary: "block",
      },
      {
        id: "block#1",
        kind: "block",
        parent: "block#0",
        boundary: "block",
      },
      {
        id: "scratch#1",
        kind: "scratch",
        parent: "loop#0",
        boundary: "scratchpad",
        exit_edges: ["fallthrough", "continue"],
      },
      {
        id: "block#2",
        kind: "block",
        parent: "scratch#1",
        boundary: "block",
      },
      {
        id: "block#3",
        kind: "block",
        parent: "block#2",
        boundary: "block",
      },
      {
        id: "scratch#2",
        kind: "scratch",
        parent: "loop#0",
        boundary: "scratchpad",
        exit_edges: ["fallthrough"],
      },
      {
        id: "block#4",
        kind: "block",
        parent: "scratch#2",
        boundary: "block",
      },
      {
        id: "loop#1",
        kind: "loop",
        parent: "block#4",
        boundary: "loop_iteration",
      },
    ],
  });

  const captured_borrow = Source.core(Source.parse(`
let factor = 2
let scale = x => borrow (x + factor)
factor = 3
scale(10)
`));
  const captured_borrow_wat = Emit.emit(Core, captured_borrow);

  assert_equals(Typed.type(Core, captured_borrow), "i32");
  assert_includes(captured_borrow_wat, "(local $_capture_factor#0 i32)");
  assert_includes(captured_borrow_wat, "local.set $_capture_factor#0");
  assert_includes(captured_borrow_wat, "local.get $_capture_factor#0");
  assert_equals(Core.lifetimes(captured_borrow), {
    scopes: [
      {
        id: "program#0",
        kind: "program",
        parent: undefined,
        boundary: "program",
      },
      {
        id: "closure#0",
        kind: "closure",
        parent: "program#0",
        boundary: "closure_environment",
      },
      {
        id: "function_call#0",
        kind: "function_call",
        parent: "program#0",
        boundary: "function_call",
      },
    ],
  });
  assert_equals(Core.borrows(captured_borrow), {
    edges: [
      {
        id: "borrow#0",
        source_scope: "function_call#0",
        target_scope: "function_call#0",
        ownership: {
          tag: "scalar_local",
          type: "i32",
        },
        decision: {
          tag: "allowed",
          reason: "scalar locals do not create a borrow lifetime",
        },
      },
    ],
    barriers: [],
    skipped_closures: [],
  });
  assert_equals(Core.validate_borrows(captured_borrow), {
    ok: true,
    issues: [],
  });
  Core.check_borrows(captured_borrow);

  const bounded_text_borrow = Source.core(
    Source.parse("(message: Text) => len(borrow message)"),
  );
  assert_equals(Core.borrows(bounded_text_borrow), {
    edges: [
      {
        id: "borrow#0",
        source_scope: "function_call#0",
        target_scope: "function_call#0",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "borrow over unique_heap text is bounded to function_call#0",
        },
      },
    ],
    barriers: [],
    skipped_closures: [],
  });
  assert_equals(Core.validate_borrows(bounded_text_borrow), {
    ok: true,
    issues: [],
  });
  Core.check_borrows(bounded_text_borrow);
  assert_equals(Typed.type(Core, bounded_text_borrow), "i32");
  assert_includes(
    Emit.emit(Mod, Core.mod(bounded_text_borrow)),
    [
      "  (func $__closure_0 (param $__env i32) (param $message i32) (result i32)",
      "    local.get $message",
      "    i32.load",
      "  )",
    ].join("\n"),
  );

  const escaping_text_borrow = Source.core(
    Source.parse("(message: Text) => borrow message"),
  );
  const escaping_text_borrow_message =
    "borrow over unique_heap text needs lexical lifetime tracking before the owner can be protected";
  assert_equals(Core.validate_borrows(escaping_text_borrow), {
    ok: false,
    issues: [
      {
        tag: "rejected_borrow",
        edge: {
          id: "borrow#0",
          source_scope: "closure#0",
          target_scope: "closure#0",
          ownership: {
            tag: "unique_heap",
            reason: "text",
          },
          decision: {
            tag: "rejected",
            reason: escaping_text_borrow_message,
          },
        },
        message: "Rejected borrow borrow#0 in closure#0: " +
          escaping_text_borrow_message,
      },
    ],
  });
  assert_throws(
    () => Typed.type(Core, escaping_text_borrow),
    escaping_text_borrow_message,
  );

  const mutate_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  borrow message
  message[0] = 65
  1
}
`));
  assert_equals(Core.validate_borrows(mutate_borrowed_text), {
    ok: false,
    issues: [
      {
        tag: "borrowed_owner_barrier",
        barrier: {
          scope: "block#0",
          owner: "message",
          action: "index_assign",
          borrow_id: "borrow#0",
          message:
            "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
        },
        message:
          "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
      },
    ],
  });
  assert_throws(
    () => Typed.type(Core, mutate_borrowed_text),
    "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
  );

  const mutate_aliased_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  let alias = message
  borrow alias
  message[0] = 65
  1
}
`));
  assert_equals(Core.validate_borrows(mutate_aliased_borrowed_text), {
    ok: false,
    issues: [
      {
        tag: "borrowed_owner_barrier",
        barrier: {
          scope: "block#0",
          owner: "message",
          action: "index_assign",
          borrow_id: "borrow#0",
          message:
            "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
        },
        message:
          "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
      },
    ],
  });
  assert_throws(
    () => Core.check_borrows(mutate_aliased_borrowed_text),
    "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
  );

  const borrow_struct_field_blocks_owner_assignment = Source.core(Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let user: user_type = user_type { name: "A", age: 1 }
borrow user.name
user = user_type { name: "B", age: 2 }
1
`));
  assert_equals(
    Core.validate_borrows(borrow_struct_field_blocks_owner_assignment),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(borrow_struct_field_blocks_owner_assignment),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const borrow_struct_field_alias_blocks_owner_assignment = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let user: user_type = user_type { name: "A", age: 1 }
let name = user.name
let other = name
borrow other
user = user_type { name: "B", age: 2 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(borrow_struct_field_alias_blocks_owner_assignment),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(borrow_struct_field_alias_blocks_owner_assignment),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const block_field_alias_result_blocks_owner_assignment = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let user: user_type = user_type { name: "A", age: 1 }
let name = {
  let inner = user.name
  inner
}
borrow name
user = user_type { name: "B", age: 2 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(block_field_alias_result_blocks_owner_assignment),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(block_field_alias_result_blocks_owner_assignment),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const block_borrow_view_result_blocks_owner_assignment = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let user: user_type = user_type { name: "A", age: 1 }
let view = {
  let inner = borrow user.name
  inner
}
user = user_type { name: "B", age: 2 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(block_borrow_view_result_blocks_owner_assignment),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(block_borrow_view_result_blocks_owner_assignment),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const block_if_field_alias_result_blocks_owner_assignment = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let user: user_type = user_type { name: "A", age: 1 }
let name = {
  let inner: Text = "fallback"
  if flag {
    inner = user.name
  }
  inner
}
borrow name
user = user_type { name: "B", age: 2 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(block_if_field_alias_result_blocks_owner_assignment),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () =>
      Core.check_borrows(
        block_if_field_alias_result_blocks_owner_assignment,
      ),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const block_if_else_field_alias_result_blocks_all_possible_owners = Source
    .core(
      Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let user: user_type = user_type { name: "A", age: 1 }
let other: user_type = user_type { name: "C", age: 3 }
let name = {
  let inner: Text = "fallback"
  if flag {
    inner = user.name
  } else {
    inner = other.name
  }
  inner
}
borrow name
user = user_type { name: "B", age: 2 }
other = user_type { name: "D", age: 4 }
1
`),
    );
  assert_equals(
    Core.validate_borrows(
      block_if_else_field_alias_result_blocks_all_possible_owners,
    ),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "other",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner other in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner other in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () =>
      Core.check_borrows(
        block_if_else_field_alias_result_blocks_all_possible_owners,
      ),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const block_if_let_field_alias_result_blocks_owner_assignment = Source.core(
    Source.parse(`
const maybe_text = union {
  some: Text,
  none: Unit
}
const user_type = struct {
  name: Text,
  age: Int
}

let target: maybe_text = .some("hit")
let user: user_type = user_type { name: "A", age: 1 }
let name = {
  let inner: Text = "fallback"
  if let .some(value) = target {
    inner = user.name
  }
  inner
}
borrow name
user = user_type { name: "B", age: 2 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(
      block_if_let_field_alias_result_blocks_owner_assignment,
    ),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () =>
      Core.check_borrows(
        block_if_let_field_alias_result_blocks_owner_assignment,
      ),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const block_loop_field_alias_result_blocks_owner_assignment = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let n = 1
let user: user_type = user_type { name: "A", age: 1 }
let name = {
  let inner: Text = "fallback"
  for i in 0..n {
    inner = user.name
  }
  inner
}
borrow name
user = user_type { name: "B", age: 2 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(
      block_loop_field_alias_result_blocks_owner_assignment,
    ),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () =>
      Core.check_borrows(
        block_loop_field_alias_result_blocks_owner_assignment,
      ),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const borrow_struct_field_alias_blocks_alias_mutation = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let user: user_type = user_type { name: "A", age: 1 }
let name = user.name
borrow name
name[0] = 65
1
`),
  );
  assert_equals(
    Core.validate_borrows(borrow_struct_field_alias_blocks_alias_mutation),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "index_assign",
            borrow_id: "borrow#0",
            message:
              "Cannot mutate borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot mutate borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(borrow_struct_field_alias_blocks_alias_mutation),
    "Cannot mutate borrowed owner user in program#0 while borrow#0 is active",
  );

  const branch_field_alias_blocks_owner_assignment = Source.core(Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let user: user_type = user_type { name: "A", age: 1 }
let name: Text = "fallback"
if flag {
  name = user.name
}
borrow name
user = user_type { name: "B", age: 2 }
1
`));
  assert_equals(
    Core.validate_borrows(branch_field_alias_blocks_owner_assignment),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(branch_field_alias_blocks_owner_assignment),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const loop_field_alias_blocks_owner_assignment = Source.core(Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let n = 1
let user: user_type = user_type { name: "A", age: 1 }
let name: Text = "fallback"
for i in 0..n {
  name = user.name
}
borrow name
user = user_type { name: "B", age: 2 }
1
`));
  assert_equals(
    Core.validate_borrows(loop_field_alias_blocks_owner_assignment),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(loop_field_alias_blocks_owner_assignment),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const unreachable_loop_field_alias_allows_owner_assignment = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let user: user_type = user_type { name: "A", age: 1 }
let name: Text = "fallback"
for i in 0..1 {
  break
  name = user.name
}
borrow name
user = user_type { name: "B", age: 2 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(
      unreachable_loop_field_alias_allows_owner_assignment,
    ),
    {
      ok: true,
      issues: [],
    },
  );
  Core.check_borrows(unreachable_loop_field_alias_allows_owner_assignment);

  const merged_field_alias_blocks_all_possible_owners = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let user: user_type = user_type { name: "A", age: 1 }
let other: user_type = user_type { name: "C", age: 3 }
let name: Text = "fallback"
if flag {
  name = user.name
} else {
  name = other.name
}
borrow name
user = user_type { name: "B", age: 2 }
other = user_type { name: "D", age: 4 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(merged_field_alias_blocks_all_possible_owners),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "other",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner other in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner other in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(merged_field_alias_blocks_all_possible_owners),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const conditional_field_alias_blocks_all_possible_owners = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let user: user_type = user_type { name: "A", age: 1 }
let other: user_type = user_type { name: "C", age: 3 }
let name = if flag { user.name } else { other.name }
borrow name
user = user_type { name: "B", age: 2 }
other = user_type { name: "D", age: 4 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(conditional_field_alias_blocks_all_possible_owners),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "other",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner other in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner other in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () =>
      Core.check_borrows(
        conditional_field_alias_blocks_all_possible_owners,
      ),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const conditional_field_alias_blocks_possible_owner = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let user: user_type = user_type { name: "A", age: 1 }
let name = if flag { user.name } else { "fallback" }
borrow name
user = user_type { name: "B", age: 2 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(conditional_field_alias_blocks_possible_owner),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(conditional_field_alias_blocks_possible_owner),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const if_let_field_alias_result_blocks_possible_owner = Source.core(
    Source.parse(`
const maybe_text = union {
  some: Text,
  none: Unit
}
const user_type = struct {
  name: Text,
  age: Int
}

let target: maybe_text = .some("hit")
let user: user_type = user_type { name: "A", age: 1 }
let name = if let .some(value) = target { user.name } else { "fallback" }
borrow name
user = user_type { name: "B", age: 2 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(if_let_field_alias_result_blocks_possible_owner),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(if_let_field_alias_result_blocks_possible_owner),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const if_let_field_alias_result_blocks_all_possible_owners = Source.core(
    Source.parse(`
const maybe_text = union {
  some: Text,
  none: Unit
}
const user_type = struct {
  name: Text,
  age: Int
}

let target: maybe_text = .some("hit")
let user: user_type = user_type { name: "A", age: 1 }
let other: user_type = user_type { name: "C", age: 3 }
let name = if let .some(value) = target { user.name } else { other.name }
borrow name
user = user_type { name: "B", age: 2 }
other = user_type { name: "D", age: 4 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(if_let_field_alias_result_blocks_all_possible_owners),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "other",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner other in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner other in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () =>
      Core.check_borrows(
        if_let_field_alias_result_blocks_all_possible_owners,
      ),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const conditional_borrow_view_blocks_possible_owner = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let user: user_type = user_type { name: "A", age: 1 }
let view = if flag { borrow user.name } else { "fallback" }
user = user_type { name: "B", age: 2 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(conditional_borrow_view_blocks_possible_owner),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(conditional_borrow_view_blocks_possible_owner),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const conditional_borrow_view_blocks_all_possible_owners = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let user: user_type = user_type { name: "A", age: 1 }
let other: user_type = user_type { name: "C", age: 3 }
let view = if flag { borrow user.name } else { borrow other.name }
user = user_type { name: "B", age: 2 }
other = user_type { name: "D", age: 4 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(conditional_borrow_view_blocks_all_possible_owners),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "other",
            action: "assign",
            borrow_id: "borrow#1",
            message:
              "Cannot move or replace borrowed owner other in program#0 while borrow#1 is active",
          },
          message:
            "Cannot move or replace borrowed owner other in program#0 while borrow#1 is active",
        },
      ],
    },
  );
  assert_throws(
    () =>
      Core.check_borrows(
        conditional_borrow_view_blocks_all_possible_owners,
      ),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const if_let_borrow_view_blocks_possible_owner = Source.core(Source.parse(`
const maybe_text = union {
  some: Text,
  none: Unit
}
const user_type = struct {
  name: Text,
  age: Int
}

let target: maybe_text = .some("hit")
let user: user_type = user_type { name: "A", age: 1 }
let view = if let .some(value) = target { borrow user.name } else { "fallback" }
user = user_type { name: "B", age: 2 }
1
`));
  assert_equals(
    Core.validate_borrows(if_let_borrow_view_blocks_possible_owner),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(if_let_borrow_view_blocks_possible_owner),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const if_let_field_alias_blocks_owner_assignment = Source.core(Source.parse(`
const maybe_text = union {
  some: Text,
  none: Unit
}
const user_type = struct {
  name: Text,
  age: Int
}

let target: maybe_text = .some("hit")
let user: user_type = user_type { name: "A", age: 1 }
let name: Text = "fallback"
if let .some(value) = target {
  name = user.name
}
borrow name
user = user_type { name: "B", age: 2 }
1
`));
  assert_equals(
    Core.validate_borrows(if_let_field_alias_blocks_owner_assignment),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () => Core.check_borrows(if_let_field_alias_blocks_owner_assignment),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const if_let_stored_field_borrow_blocks_owner_assignment = Source.core(
    Source.parse(`
const maybe_text = union {
  some: Text,
  none: Unit
}
const user_type = struct {
  name: Text,
  age: Int
}

let target: maybe_text = .some("hit")
let user: user_type = user_type { name: "A", age: 1 }
let name: Text = "fallback"
if let .some(value) = target {
  name = borrow user.name
}
user = user_type { name: "B", age: 2 }
1
`),
  );
  assert_equals(
    Core.validate_borrows(if_let_stored_field_borrow_blocks_owner_assignment),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "user",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () =>
      Core.check_borrows(if_let_stored_field_borrow_blocks_owner_assignment),
    "Cannot move or replace borrowed owner user in program#0 while borrow#0 is active",
  );

  const stored_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  let view = borrow message
  len(view)
}
`));
  assert_equals(Core.borrows(stored_borrowed_text), {
    edges: [
      {
        id: "borrow#0",
        source_scope: "block#0",
        target_scope: "block#0",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "borrow over unique_heap text is bounded to block#0",
        },
      },
    ],
    barriers: [],
    skipped_closures: [],
  });
  assert_equals(Core.validate_borrows(stored_borrowed_text), {
    ok: true,
    issues: [],
  });
  Core.check_borrows(stored_borrowed_text);
  assert_equals(Typed.type(Core, stored_borrowed_text), "i32");
  assert_includes(
    Emit.emit(Mod, Core.mod(stored_borrowed_text)),
    [
      "  (func $__closure_0 (param $__env i32) (param $message i32) (result i32)",
      "    (local $view i32)",
      "    local.get $message",
      "    local.set $view",
      "    local.get $view",
      "    i32.load",
      "  )",
    ].join("\n"),
  );

  const mutate_stored_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  let view = borrow message
  len(view)
  message[0] = 65
  1
}
`));
  assert_equals(Core.validate_borrows(mutate_stored_borrowed_text), {
    ok: false,
    issues: [
      {
        tag: "borrowed_owner_barrier",
        barrier: {
          scope: "block#0",
          owner: "message",
          action: "index_assign",
          borrow_id: "borrow#0",
          message:
            "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
        },
        message:
          "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
      },
    ],
  });
  assert_throws(
    () => Core.check_borrows(mutate_stored_borrowed_text),
    "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
  );

  const mutate_collection_item_borrow_owner = Source.core(Source.parse(`
const names_type = struct {
  first: Text,
  second: Text
}

let start = 0
let first: Text = slice("Ada", start, 3)
let second: Text = slice("Grace", start, 5)
let flag = 1
let make_names = if flag {
  () => names_type { first: first, second: second }
} else {
  () => names_type { first: first, second: second }
}
let names: names_type = make_names()
let view: Text = ""

for index, name in names {
  view = borrow name
}

names[0] = "Edsger"
len(view)
`));
  assert_equals(Core.validate_borrows(mutate_collection_item_borrow_owner), {
    ok: false,
    issues: [
      {
        tag: "borrowed_owner_barrier",
        barrier: {
          scope: "program#0",
          owner: "names",
          action: "index_assign",
          borrow_id: "borrow#0",
          message:
            "Cannot mutate borrowed owner names in program#0 while borrow#0 is active",
        },
        message:
          "Cannot mutate borrowed owner names in program#0 while borrow#0 is active",
      },
    ],
  });
  assert_throws(
    () => Core.check_borrows(mutate_collection_item_borrow_owner),
    "Cannot mutate borrowed owner names in program#0 while borrow#0 is active",
  );

  const returned_stored_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  let view = borrow message
  view
}
`));
  const returned_stored_borrowed_text_message =
    "stored borrow view view cannot escape borrowed owner message from block#0";
  assert_equals(Core.validate_borrows(returned_stored_borrowed_text), {
    ok: false,
    issues: [
      {
        tag: "rejected_borrow",
        edge: {
          id: "borrow#1",
          source_scope: "block#0",
          target_scope: "block#0",
          ownership: {
            tag: "borrow_view",
            source: {
              tag: "unique_heap",
              reason: "text",
            },
          },
          decision: {
            tag: "rejected",
            reason: returned_stored_borrowed_text_message,
          },
        },
        message: "Rejected borrow borrow#1 in block#0: " +
          returned_stored_borrowed_text_message,
      },
    ],
  });
  assert_throws(
    () => Typed.type(Core, returned_stored_borrowed_text),
    returned_stored_borrowed_text_message,
  );

  const captured_stored_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  let view = borrow message
  (x: Int) => len(view)
}
`));
  const captured_stored_borrowed_text_message =
    "stored borrow view view cannot be captured by closure#1 because it references borrowed owner message from block#0";
  assert_equals(Core.validate_borrows(captured_stored_borrowed_text), {
    ok: false,
    issues: [
      {
        tag: "rejected_borrow",
        edge: {
          id: "borrow#1",
          source_scope: "block#0",
          target_scope: "closure#1",
          ownership: {
            tag: "borrow_view",
            source: {
              tag: "unique_heap",
              reason: "text",
            },
          },
          decision: {
            tag: "rejected",
            reason: captured_stored_borrowed_text_message,
          },
        },
        message: "Rejected borrow borrow#1 in closure#1: " +
          captured_stored_borrowed_text_message,
      },
    ],
  });
  assert_throws(
    () => Core.check_borrows(captured_stored_borrowed_text),
    captured_stored_borrowed_text_message,
  );

  const branch_stored_borrowed_text = Source.core(Source.parse(`
(flag: Int, message: Text) => {
  let view: Text = "fallback"
  if flag {
    view = borrow message
  }
  len(view)
}
`));
  assert_equals(Core.validate_borrows(branch_stored_borrowed_text), {
    ok: true,
    issues: [],
  });
  Core.check_borrows(branch_stored_borrowed_text);
  assert_equals(Typed.type(Core, branch_stored_borrowed_text), "i32");

  const mutate_branch_stored_borrowed_text = Source.core(Source.parse(`
(flag: Int, message: Text) => {
  let view: Text = "fallback"
  if flag {
    view = borrow message
  }
  message[0] = 65
  1
}
`));
  assert_equals(Core.validate_borrows(mutate_branch_stored_borrowed_text), {
    ok: false,
    issues: [
      {
        tag: "borrowed_owner_barrier",
        barrier: {
          scope: "block#0",
          owner: "message",
          action: "index_assign",
          borrow_id: "borrow#0",
          message:
            "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
        },
        message:
          "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
      },
    ],
  });
  assert_throws(
    () => Core.check_borrows(mutate_branch_stored_borrowed_text),
    "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
  );

  const returned_branch_stored_borrowed_text = Source.core(Source.parse(`
(flag: Int, message: Text) => {
  let view: Text = "fallback"
  if flag {
    view = borrow message
  }
  view
}
`));
  const returned_branch_stored_borrowed_text_message =
    "stored borrow view view cannot escape borrowed owner message from block#0";
  assert_equals(Core.validate_borrows(returned_branch_stored_borrowed_text), {
    ok: false,
    issues: [
      {
        tag: "rejected_borrow",
        edge: {
          id: "borrow#1",
          source_scope: "block#0",
          target_scope: "block#0",
          ownership: {
            tag: "borrow_view",
            source: {
              tag: "unique_heap",
              reason: "text",
            },
          },
          decision: {
            tag: "rejected",
            reason: returned_branch_stored_borrowed_text_message,
          },
        },
        message: "Rejected borrow borrow#1 in block#0: " +
          returned_branch_stored_borrowed_text_message,
      },
    ],
  });
  assert_throws(
    () => Core.check_borrows(returned_branch_stored_borrowed_text),
    returned_branch_stored_borrowed_text_message,
  );

  const mutate_loop_stored_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  let view: Text = "fallback"
  for i in 0..1 {
    view = borrow message
  }
  message[0] = 65
  1
}
`));
  assert_equals(Core.validate_borrows(mutate_loop_stored_borrowed_text), {
    ok: false,
    issues: [
      {
        tag: "borrowed_owner_barrier",
        barrier: {
          scope: "block#0",
          owner: "message",
          action: "index_assign",
          borrow_id: "borrow#0",
          message:
            "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
        },
        message:
          "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
      },
    ],
  });
  assert_throws(
    () => Core.check_borrows(mutate_loop_stored_borrowed_text),
    "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
  );

  const mutate_after_loop_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  for i in 0..1 {
    borrow message
  }
  message[0] = 65
  1
}
`));
  assert_equals(Core.validate_borrows(mutate_after_loop_borrowed_text), {
    ok: true,
    issues: [],
  });

  const unreachable_break_loop_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  let view: Text = "fallback"
  for i in 0..1 {
    break
    view = borrow message
  }
  message[0] = 65
  1
}
`));
  assert_equals(Core.validate_borrows(unreachable_break_loop_borrowed_text), {
    ok: true,
    issues: [],
  });
  Core.check_borrows(unreachable_break_loop_borrowed_text);

  const unreachable_continue_loop_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  let view: Text = "fallback"
  for i in 0..1 {
    continue
    view = borrow message
  }
  message[0] = 65
  1
}
`));
  assert_equals(
    Core.validate_borrows(unreachable_continue_loop_borrowed_text),
    {
      ok: true,
      issues: [],
    },
  );
  Core.check_borrows(unreachable_continue_loop_borrowed_text);

  const mutate_break_carried_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  let view: Text = "fallback"
  for i in 0..1 {
    view = borrow message
    break
  }
  message[0] = 65
  1
}
`));
  assert_equals(Core.validate_borrows(mutate_break_carried_borrowed_text), {
    ok: false,
    issues: [
      {
        tag: "borrowed_owner_barrier",
        barrier: {
          scope: "block#0",
          owner: "message",
          action: "index_assign",
          borrow_id: "borrow#0",
          message:
            "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
        },
        message:
          "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
      },
    ],
  });
  assert_throws(
    () => Core.check_borrows(mutate_break_carried_borrowed_text),
    "Cannot mutate borrowed owner message in block#0 while borrow#0 is active",
  );

  const manual_barrier_core: CoreNode = {
    tag: "program",
    statements: [
      {
        tag: "expr",
        expr: {
          tag: "block",
          statements: [
            {
              tag: "expr",
              expr: { tag: "borrow", value: { tag: "var", name: "owner" } },
            },
            {
              tag: "assign",
              name: "owner",
              mode: "change",
              value: { tag: "num", type: "i32", value: 1 },
            },
            {
              tag: "expr",
              expr: { tag: "borrow", value: { tag: "var", name: "frozen" } },
            },
            {
              tag: "expr",
              expr: { tag: "freeze", value: { tag: "var", name: "frozen" } },
            },
            {
              tag: "expr",
              expr: { tag: "num", type: "i32", value: 1 },
            },
          ],
        },
      },
    ],
  };
  const manual_barrier_plan = core_borrow_plan(manual_barrier_core, {}, {
    closure_body_ctx: (_expr, ctx) => {
      return { tag: "scan", ctx };
    },
    closure_fn_type: () => undefined,
    core_expr_is_text: (expr) => {
      if (expr.tag === "var") {
        return expr.name === "owner" || expr.name === "frozen";
      }

      return false;
    },
    expr_type: () => "i32",
    runtime_union_value: () => undefined,
    static_core_call_value: () => undefined,
    static_struct_value: () => undefined,
    static_text_value: () => undefined,
    static_value: () => undefined,
  });
  assert_equals(core_validate_borrow_plan(manual_barrier_plan), {
    ok: false,
    issues: [
      {
        tag: "borrowed_owner_barrier",
        barrier: {
          scope: "block#0",
          owner: "owner",
          action: "assign",
          borrow_id: "borrow#0",
          message:
            "Cannot move or replace borrowed owner owner in block#0 while borrow#0 is active",
        },
        message:
          "Cannot move or replace borrowed owner owner in block#0 while borrow#0 is active",
      },
      {
        tag: "borrowed_owner_barrier",
        barrier: {
          scope: "block#0",
          owner: "frozen",
          action: "freeze",
          borrow_id: "borrow#1",
          message:
            "Cannot freeze borrowed owner frozen in block#0 while borrow#1 is active",
        },
        message:
          "Cannot freeze borrowed owner frozen in block#0 while borrow#1 is active",
      },
    ],
  });

  const borrowed_text = Source.core(Source.parse('borrow "text"'));
  assert_equals(Format.fmt(Core, borrowed_text), 'borrow "text"');
  assert_equals(Core.ownership(borrowed_text), {
    tag: "frozen_shareable",
    reason: "text",
  });
  assert_equals(Core.borrows(borrowed_text), {
    edges: [
      {
        id: "borrow#0",
        source_scope: "program#0",
        target_scope: "program#0",
        ownership: {
          tag: "frozen_shareable",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "frozen_shareable values are immutable and freely shareable",
        },
      },
    ],
    barriers: [],
    skipped_closures: [],
  });
  assert_equals(Core.validate_borrows(borrowed_text), {
    ok: true,
    issues: [],
  });
  Core.check_borrows(borrowed_text);
  assert_equals(Typed.type(Core, borrowed_text), "i32");
  assert_includes(Emit.emit(Core, borrowed_text), "i32.const");

  const scratch_closure = Source.core(
    Source.parse("scratch { (x: Int) => x }"),
  );
  assert_throws(
    () => Typed.type(Core, scratch_closure),
    "unique_heap closure cannot leave scratch without freeze or explicit promotion",
  );

  const escaping_untyped_plain_closure = Source.core(
    Source.parse("x => x"),
  );
  assert_equals(Core.validate_borrows(escaping_untyped_plain_closure), {
    ok: true,
    issues: [],
  });
  Core.check_borrows(escaping_untyped_plain_closure);

  const escaping_untyped_borrow_closure = Source.core(
    Source.parse("x => borrow x"),
  );
  assert_equals(Core.validate_borrows(escaping_untyped_borrow_closure), {
    ok: false,
    issues: [
      {
        tag: "skipped_closure",
        scope: "closure#0",
        message:
          "Skipped closure borrow analysis in closure#0: Cannot analyze closure-body borrows without parameter annotation: x",
      },
    ],
  });
  assert_throws(
    () => Core.check_borrows(escaping_untyped_borrow_closure),
    "Skipped closure borrow analysis in closure#0",
  );
  assert_throws(
    () => Typed.type(Core, escaping_untyped_borrow_closure),
    "Skipped closure borrow analysis in closure#0",
  );

  const borrowed_closure = Source.core(Source.parse("borrow ((x: Int) => x)"));
  const borrowed_closure_message =
    "borrow over unique_heap closure needs lexical lifetime tracking before the owner can be protected";
  assert_equals(Core.borrows(borrowed_closure), {
    edges: [
      {
        id: "borrow#0",
        source_scope: "program#0",
        target_scope: "program#0",
        ownership: {
          tag: "unique_heap",
          reason: "closure",
        },
        decision: {
          tag: "rejected",
          reason: borrowed_closure_message,
        },
      },
    ],
    barriers: [],
    skipped_closures: [],
  });
  assert_equals(Core.validate_borrows(borrowed_closure), {
    ok: false,
    issues: [
      {
        tag: "rejected_borrow",
        edge: {
          id: "borrow#0",
          source_scope: "program#0",
          target_scope: "program#0",
          ownership: {
            tag: "unique_heap",
            reason: "closure",
          },
          decision: {
            tag: "rejected",
            reason: borrowed_closure_message,
          },
        },
        message: "Rejected borrow borrow#0 in program#0: " +
          borrowed_closure_message,
      },
    ],
  });
  assert_throws(
    () => Core.check_borrows(borrowed_closure),
    "Rejected borrow borrow#0 in program#0",
  );
  assert_throws(
    () => Typed.type(Core, borrowed_closure),
    "needs lexical lifetime tracking before the owner can be protected",
  );

  const frozen_closure = Source.core(Source.parse(`
let f = freeze ((x: Int) => x + 1)
f(41)
`));
  const frozen_closure_proof = Core.proof(frozen_closure);

  assert_equals(Typed.type(Core, frozen_closure), "i32");
  assert_equals(frozen_closure_proof.ok, true);
  assert_equals(
    frozen_closure_proof.freeze_edges.map((edge) => {
      return {
        id: edge.id,
        ownership: edge.analysis.ownership,
        decision: edge.analysis.decision,
      };
    }),
    [
      {
        id: "freeze#0",
        ownership: {
          tag: "unique_heap",
          reason: "closure",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap closure consumes the owned " +
            "environment pointer as immutable shareable storage",
        },
      },
    ],
  );

  const frozen_union = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

let result: result_type = freeze result_type.ok(41)

if let .ok(value) = result {
  value + 1
} else {
  0
}
`));
  const frozen_union_proof = Core.proof(frozen_union);

  assert_equals(Typed.type(Core, frozen_union), "i32");
  assert_equals(frozen_union_proof.ok, true);
  assert_equals(
    frozen_union_proof.freeze_edges.map((edge) => {
      return {
        id: edge.id,
        ownership: edge.analysis.ownership,
        decision: edge.analysis.decision,
      };
    }),
    [
      {
        id: "freeze#0",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_union consumes the owned " +
            "buffer as immutable shareable storage",
        },
      },
    ],
  );
});

Deno.test("Core.proof gates baseline no-GC ownership facts", () => {
  const scalar_scratch = Source.core(Source.parse(`
let x = scratch { 1 + 2 }
x
`));
  const proof = Core.proof(scalar_scratch);
  assert_equals({
    target: proof.target,
    managed_storage: proof.managed_storage,
    ok: proof.ok,
    issue_count: proof.issues.length,
    final_storage: proof.final_result.storage,
    cleanup_scopes: proof.cleanup.steps.map((step) => step.scope),
    drop_count: proof.drops.steps.length,
  }, {
    target: "core-3-nonweb",
    managed_storage: "disabled",
    ok: true,
    issue_count: 0,
    final_storage: "scalar_local",
    cleanup_scopes: ["scratch#0"],
    drop_count: 0,
  });
  Core.check_proof(scalar_scratch);
  assert_equals(Typed.type(Core, scalar_scratch), "i32");

  const static_aggregate = Source.core(Source.parse(`
let xs = { first: 10, second: 20 }
let user = { name: "Ada", age: 41 }
let total = 0

for i, x in xs {
  total = total + i + x
}

total + xs[1] + len(user.name)
`));
  const static_aggregate_proof = Core.proof(static_aggregate);
  assert_equals({
    ok: static_aggregate_proof.ok,
    issue_count: static_aggregate_proof.issues.length,
    final_storage: static_aggregate_proof.final_result.storage,
    drop_count: static_aggregate_proof.drops.steps.length,
  }, {
    ok: true,
    issue_count: 0,
    final_storage: "scalar_local",
    drop_count: 0,
  });
  Core.check_proof(static_aggregate);

  const frozen_static_aggregate = Source.core(Source.parse(`
let user = freeze { age: 41, bonus: 1 }
user.age + user.bonus
`));
  const frozen_static_aggregate_proof = Core.proof(frozen_static_aggregate);
  assert_equals({
    ok: frozen_static_aggregate_proof.ok,
    managed_storage: frozen_static_aggregate_proof.managed_storage,
    issue_count: frozen_static_aggregate_proof.issues.length,
    final_storage: frozen_static_aggregate_proof.final_result.storage,
    freeze_edges: frozen_static_aggregate_proof.freeze_edges.map((edge) => {
      return {
        id: edge.id,
        storage: edge.analysis.storage,
        ownership: edge.analysis.ownership,
        decision: edge.analysis.decision,
      };
    }),
    drop_count: frozen_static_aggregate_proof.drops.steps.length,
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "frozen_heap",
        ownership: {
          tag: "frozen_shareable",
          reason: "freeze",
        },
        decision: {
          tag: "allowed",
          reason: "freeze is idempotent for frozen_shareable values",
        },
      },
    ],
    drop_count: 0,
  });
  Core.check_proof(frozen_static_aggregate);

  const scratch_static_aggregate = Source.core(Source.parse(`
let x = 40
let user = scratch { { age: x + 1, bonus: 1 } }
user.age + user.bonus
`));
  const scratch_static_aggregate_proof = Core.proof(scratch_static_aggregate);
  assert_equals({
    ok: scratch_static_aggregate_proof.ok,
    managed_storage: scratch_static_aggregate_proof.managed_storage,
    issue_count: scratch_static_aggregate_proof.issues.length,
    final_storage: scratch_static_aggregate_proof.final_result.storage,
    scratch_return: scratch_static_aggregate_proof.cleanup.steps.map(
      (step) => {
        return {
          scope: step.scope,
          storage: step.return_value.storage,
          ownership: step.return_value.ownership,
          decision: step.return_value.decision,
        };
      },
    ),
    drop_count: scratch_static_aggregate_proof.drops.steps.length,
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return: [
      {
        scope: "scratch#0",
        storage: "frozen_heap",
        ownership: {
          tag: "frozen_shareable",
          reason: "runtime_aggregate",
        },
        decision: {
          tag: "allowed",
          reason: "frozen_shareable values do not reference scratch storage",
        },
      },
    ],
    drop_count: 0,
  });
  Core.check_proof(scratch_static_aggregate);

  const annotated_scratch_static_aggregate = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  name: Text
}
let x = 40
let user: user_type = scratch {
  user_type { age: x + 1, name: "Ada" }
}
user.age + len(user.name)
`));
  const annotated_scratch_static_aggregate_proof = Core.proof(
    annotated_scratch_static_aggregate,
  );
  assert_equals({
    ok: annotated_scratch_static_aggregate_proof.ok,
    managed_storage: annotated_scratch_static_aggregate_proof.managed_storage,
    issue_count: annotated_scratch_static_aggregate_proof.issues.length,
    final_storage:
      annotated_scratch_static_aggregate_proof.final_result.storage,
    scratch_return: annotated_scratch_static_aggregate_proof.cleanup.steps.map(
      (step) => {
        return {
          scope: step.scope,
          storage: step.return_value.storage,
          ownership: step.return_value.ownership,
          decision: step.return_value.decision,
        };
      },
    ),
    drop_count: annotated_scratch_static_aggregate_proof.drops.steps.length,
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return: [
      {
        scope: "scratch#0",
        storage: "frozen_heap",
        ownership: {
          tag: "frozen_shareable",
          reason: "runtime_aggregate",
        },
        decision: {
          tag: "allowed",
          reason: "frozen_shareable values do not reference scratch storage",
        },
      },
    ],
    drop_count: 0,
  });
  Core.check_proof(annotated_scratch_static_aggregate);

  const unsafe_annotated_scratch_static_aggregate = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  name: Text
}
let x = 40
let user: user_type = scratch {
  user_type { age: x + 1, name: append("A", "da") }
}
user.age + len(user.name)
`));
  const unsafe_annotated_scratch_static_aggregate_proof = Core.proof(
    unsafe_annotated_scratch_static_aggregate,
  );
  const unsafe_annotated_scratch_static_aggregate_message =
    "Rejected baseline proof scratch#0 scratch_return: unsafe scratch return " +
    "field name may reference unique_heap text and unique_heap " +
    "runtime_aggregate cannot leave scratch without freeze or explicit " +
    "promotion";
  assert_equals({
    ok: unsafe_annotated_scratch_static_aggregate_proof.ok,
    managed_storage:
      unsafe_annotated_scratch_static_aggregate_proof.managed_storage,
    issue_count: unsafe_annotated_scratch_static_aggregate_proof.issues.length,
    issue_message: unsafe_annotated_scratch_static_aggregate_proof.issues[0]
      ?.message,
    scratch_return: unsafe_annotated_scratch_static_aggregate_proof.cleanup
      .steps.map((step) => {
        return {
          scope: step.scope,
          return_detail: step.return_detail,
          storage: step.return_value.storage,
          ownership: step.return_value.ownership,
          decision: step.return_value.decision,
        };
      }),
  }, {
    ok: false,
    managed_storage: "disabled",
    issue_count: 1,
    issue_message: unsafe_annotated_scratch_static_aggregate_message,
    scratch_return: [
      {
        scope: "scratch#0",
        return_detail: "field name may reference unique_heap text",
        storage: "rejected",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        decision: {
          tag: "rejected",
          reason:
            "unique_heap runtime_aggregate cannot leave scratch without " +
            "freeze or explicit promotion",
        },
      },
    ],
  });
  assert_throws(
    () => Core.check_proof(unsafe_annotated_scratch_static_aggregate),
    unsafe_annotated_scratch_static_aggregate_message,
  );

  const scratch_static_aggregate_block_setup = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  name: Text
}
let user: user_type = scratch {
  let temp: Text = freeze append("Ada", "!")
  user_type { age: 40, name: temp }
}
user.age + len(user.name)
`));
  const scratch_static_aggregate_block_setup_proof = Core.proof(
    scratch_static_aggregate_block_setup,
  );
  assert_equals({
    ok: scratch_static_aggregate_block_setup_proof.ok,
    managed_storage: scratch_static_aggregate_block_setup_proof.managed_storage,
    issue_count: scratch_static_aggregate_block_setup_proof.issues.length,
    final_storage:
      scratch_static_aggregate_block_setup_proof.final_result.storage,
    scratch_return: scratch_static_aggregate_block_setup_proof.cleanup.steps
      .map((step) => {
        return {
          scope: step.scope,
          storage: step.return_value.storage,
          ownership: step.return_value.ownership,
          decision: step.return_value.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return: [
      {
        scope: "scratch#0",
        storage: "frozen_heap",
        ownership: {
          tag: "frozen_shareable",
          reason: "runtime_aggregate",
        },
        decision: {
          tag: "allowed",
          reason: "frozen_shareable values do not reference scratch storage",
        },
      },
    ],
  });
  Core.check_proof(scratch_static_aggregate_block_setup);
  const scratch_static_aggregate_block_setup_wat = Emit.emit(
    Mod,
    Core.mod(scratch_static_aggregate_block_setup),
  );
  assert_includes(scratch_static_aggregate_block_setup_wat, "local.set $temp");
  assert_includes(
    scratch_static_aggregate_block_setup_wat,
    "global.set $__scratch_heap",
  );

  const scratch_static_aggregate_block_alias = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  name: Text
}
let user: user_type = scratch {
  let name: Text = freeze append("Ada", "!")
  let temp: user_type = user_type { age: 40, name: name }
  temp
}
user.age + len(user.name)
`));
  const scratch_static_aggregate_block_alias_proof = Core.proof(
    scratch_static_aggregate_block_alias,
  );
  assert_equals({
    ok: scratch_static_aggregate_block_alias_proof.ok,
    managed_storage: scratch_static_aggregate_block_alias_proof.managed_storage,
    issue_count: scratch_static_aggregate_block_alias_proof.issues.length,
    final_storage:
      scratch_static_aggregate_block_alias_proof.final_result.storage,
    scratch_return: scratch_static_aggregate_block_alias_proof.cleanup.steps
      .map(
        (step) => {
          return {
            scope: step.scope,
            storage: step.return_value.storage,
            ownership: step.return_value.ownership,
            decision: step.return_value.decision,
          };
        },
      ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return: [
      {
        scope: "scratch#0",
        storage: "frozen_heap",
        ownership: {
          tag: "frozen_shareable",
          reason: "runtime_aggregate",
        },
        decision: {
          tag: "allowed",
          reason: "frozen_shareable values do not reference scratch storage",
        },
      },
    ],
  });
  Core.check_proof(scratch_static_aggregate_block_alias);
  const scratch_static_aggregate_block_alias_wat = Emit.emit(
    Mod,
    Core.mod(scratch_static_aggregate_block_alias),
  );
  assert_includes(scratch_static_aggregate_block_alias_wat, "local.set $name");
  assert_includes(
    scratch_static_aggregate_block_alias_wat,
    "global.set $__scratch_heap",
  );

  const scratch_static_nested_aggregate_block_alias = Source.core(Source.parse(`
const name_type = struct {
  first: Text,
  last: Text
}
const user_type = struct {
  age: Int,
  name: name_type
}
let user: user_type = scratch {
  let first: Text = freeze append("A", "da")
  let name: name_type = name_type { first: first, last: "Lovelace" }
  let temp: user_type = user_type { age: 40, name: name }
  temp
}
len(user.name.first) + len(user.name.last) + user.age
`));
  const scratch_static_nested_aggregate_block_alias_proof = Core.proof(
    scratch_static_nested_aggregate_block_alias,
  );
  assert_equals({
    ok: scratch_static_nested_aggregate_block_alias_proof.ok,
    managed_storage:
      scratch_static_nested_aggregate_block_alias_proof.managed_storage,
    issue_count:
      scratch_static_nested_aggregate_block_alias_proof.issues.length,
    scratch_return: scratch_static_nested_aggregate_block_alias_proof.cleanup
      .steps.map(
        (step) => {
          return {
            scope: step.scope,
            return_detail: step.return_detail,
            storage: step.return_value.storage,
            ownership: step.return_value.ownership,
            decision: step.return_value.decision,
          };
        },
      ),
  }, {
    ok: false,
    managed_storage: "disabled",
    issue_count: 1,
    scratch_return: [
      {
        scope: "scratch#0",
        return_detail: "field name may reference unique_heap runtime_aggregate",
        storage: "rejected",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        decision: {
          tag: "rejected",
          reason:
            "unique_heap runtime_aggregate cannot leave scratch without " +
            "freeze or explicit promotion",
        },
      },
    ],
  });
  assert_throws(
    () => Core.check_proof(scratch_static_nested_aggregate_block_alias),
    "Rejected baseline proof scratch#0 scratch_return: " +
      "unsafe scratch return field name may reference unique_heap " +
      "runtime_aggregate and unique_heap runtime_aggregate cannot leave " +
      "scratch without freeze or explicit promotion",
  );

  const scratch_static_union = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}
let value = scratch { result_type.ok(41) }
if let .ok(x) = value { x } else { 0 }
`));
  const scratch_static_union_proof = Core.proof(scratch_static_union);
  assert_equals({
    ok: scratch_static_union_proof.ok,
    managed_storage: scratch_static_union_proof.managed_storage,
    issue_count: scratch_static_union_proof.issues.length,
    final_storage: scratch_static_union_proof.final_result.storage,
    scratch_return: scratch_static_union_proof.cleanup.steps.map((step) => {
      return {
        scope: step.scope,
        storage: step.return_value.storage,
        ownership: step.return_value.ownership,
        decision: step.return_value.decision,
      };
    }),
    drop_count: scratch_static_union_proof.drops.steps.length,
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return: [
      {
        scope: "scratch#0",
        storage: "frozen_heap",
        ownership: {
          tag: "frozen_shareable",
          reason: "runtime_union",
        },
        decision: {
          tag: "allowed",
          reason: "frozen_shareable values do not reference scratch storage",
        },
      },
    ],
    drop_count: 0,
  });
  Core.check_proof(scratch_static_union);

  const scratch_static_union_block_setup = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Int
}
let result: result_type = scratch {
  let temp: Text = freeze append("Ada", "!")
  result_type.ok(temp)
}
if let .ok(value) = result { len(value) } else { 0 }
`));
  const scratch_static_union_block_setup_proof = Core.proof(
    scratch_static_union_block_setup,
  );
  assert_equals({
    ok: scratch_static_union_block_setup_proof.ok,
    managed_storage: scratch_static_union_block_setup_proof.managed_storage,
    issue_count: scratch_static_union_block_setup_proof.issues.length,
    final_storage: scratch_static_union_block_setup_proof.final_result.storage,
    scratch_return: scratch_static_union_block_setup_proof.cleanup.steps.map(
      (step) => {
        return {
          scope: step.scope,
          storage: step.return_value.storage,
          ownership: step.return_value.ownership,
          decision: step.return_value.decision,
        };
      },
    ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return: [
      {
        scope: "scratch#0",
        storage: "frozen_heap",
        ownership: {
          tag: "frozen_shareable",
          reason: "runtime_union",
        },
        decision: {
          tag: "allowed",
          reason: "frozen_shareable values do not reference scratch storage",
        },
      },
    ],
  });
  Core.check_proof(scratch_static_union_block_setup);
  const scratch_static_union_block_setup_wat = Emit.emit(
    Mod,
    Core.mod(scratch_static_union_block_setup),
  );
  assert_includes(scratch_static_union_block_setup_wat, "local.set $temp");
  assert_includes(
    scratch_static_union_block_setup_wat,
    "global.set $__scratch_heap",
  );

  const scratch_static_union_block_alias = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Int
}
let result: result_type = scratch {
  let name: Text = freeze append("Ada", "!")
  let temp: result_type = result_type.ok(name)
  temp
}
if let .ok(value) = result { len(value) } else { 0 }
`));
  const scratch_static_union_block_alias_proof = Core.proof(
    scratch_static_union_block_alias,
  );
  assert_equals({
    ok: scratch_static_union_block_alias_proof.ok,
    managed_storage: scratch_static_union_block_alias_proof.managed_storage,
    issue_count: scratch_static_union_block_alias_proof.issues.length,
    final_storage: scratch_static_union_block_alias_proof.final_result.storage,
    scratch_return: scratch_static_union_block_alias_proof.cleanup.steps.map(
      (step) => {
        return {
          scope: step.scope,
          storage: step.return_value.storage,
          ownership: step.return_value.ownership,
          decision: step.return_value.decision,
        };
      },
    ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return: [
      {
        scope: "scratch#0",
        storage: "frozen_heap",
        ownership: {
          tag: "frozen_shareable",
          reason: "runtime_union",
        },
        decision: {
          tag: "allowed",
          reason: "frozen_shareable values do not reference scratch storage",
        },
      },
    ],
  });
  Core.check_proof(scratch_static_union_block_alias);
  const scratch_static_union_block_alias_wat = Emit.emit(
    Mod,
    Core.mod(scratch_static_union_block_alias),
  );
  assert_includes(scratch_static_union_block_alias_wat, "local.set $name");
  assert_includes(
    scratch_static_union_block_alias_wat,
    "global.set $__scratch_heap",
  );

  const scratch_dynamic_static_union = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}
let flag = 1
let value = scratch {
  if flag {
    result_type.ok(41)
  } else {
    result_type.err(9)
  }
}
if let .ok(x) = value { x } else { 0 }
`));
  const scratch_dynamic_static_union_proof = Core.proof(
    scratch_dynamic_static_union,
  );
  assert_equals({
    ok: scratch_dynamic_static_union_proof.ok,
    managed_storage: scratch_dynamic_static_union_proof.managed_storage,
    issue_count: scratch_dynamic_static_union_proof.issues.length,
    final_storage: scratch_dynamic_static_union_proof.final_result.storage,
    scratch_return: scratch_dynamic_static_union_proof.cleanup.steps.map(
      (step) => {
        return {
          scope: step.scope,
          storage: step.return_value.storage,
          ownership: step.return_value.ownership,
          decision: step.return_value.decision,
        };
      },
    ),
    drop_count: scratch_dynamic_static_union_proof.drops.steps.length,
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return: [
      {
        scope: "scratch#0",
        storage: "frozen_heap",
        ownership: {
          tag: "frozen_shareable",
          reason: "runtime_union",
        },
        decision: {
          tag: "allowed",
          reason: "frozen_shareable values do not reference scratch storage",
        },
      },
    ],
    drop_count: 0,
  });
  Core.check_proof(scratch_dynamic_static_union);

  const scratch_runtime_text_temporary = Source.core(Source.parse(`
let flag = 1
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
  const scratch_runtime_text_temporary_proof = Core.proof(
    scratch_runtime_text_temporary,
  );
  assert_equals(
    scratch_runtime_text_temporary_proof.allocations.facts.map((fact) => {
      return {
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [
      {
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "closure",
        },
        reason: "closure",
        expression: "lam",
      },
      {
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "prim",
      },
      {
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "closure",
        },
        reason: "closure",
        expression: "lam",
      },
      {
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "prim",
      },
    ],
  );
  Core.check_proof(scratch_runtime_text_temporary);

  const runtime_text_slice = Source.core(Source.parse(`
let part: Text = slice("Grace", 1, 4)
len(part)
`));
  const runtime_text_slice_proof = Core.proof(runtime_text_slice);
  assert_equals({
    ok: runtime_text_slice_proof.ok,
    managed_storage: runtime_text_slice_proof.managed_storage,
    issue_count: runtime_text_slice_proof.issues.length,
    final_storage: runtime_text_slice_proof.final_result.storage,
    allocations: runtime_text_slice_proof.allocations.facts.map((fact) => {
      return {
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    allocations: [
      {
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
    ],
  });
  Core.check_proof(runtime_text_slice);

  const runtime_text_append = Source.core(Source.parse(`
let prefix: Text = slice("Grace", 0, 3)
let part: Text = append(prefix, "ce")
len(part)
`));
  const runtime_text_append_proof = Core.proof(runtime_text_append);
  assert_equals({
    ok: runtime_text_append_proof.ok,
    managed_storage: runtime_text_append_proof.managed_storage,
    issue_count: runtime_text_append_proof.issues.length,
    final_storage: runtime_text_append_proof.final_result.storage,
    allocations: runtime_text_append_proof.allocations.facts.map((fact) => {
      return {
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    drops: runtime_text_append_proof.drops.steps.map((step) => {
      return {
        edge: step.edge,
        scope: step.scope,
        owner: step.owner,
        ownership: step.ownership,
        storage: step.storage,
      };
    }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    allocations: [
      {
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
    ],
    drops: [
      {
        edge: "scope_exit",
        scope: "program#0",
        owner: "part",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        storage: "persistent_unique_heap",
      },
      {
        edge: "scope_exit",
        scope: "program#0",
        owner: "prefix",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        storage: "persistent_unique_heap",
      },
    ],
  });
  Core.check_proof(runtime_text_append);

  const frozen_runtime_text = Source.core(Source.parse(`
let prefix: Text = slice("Grace", 0, 3)
let part: Text = freeze append(prefix, "ce")
len(part)
`));
  const frozen_runtime_text_proof = Core.proof(frozen_runtime_text);
  assert_equals({
    ok: frozen_runtime_text_proof.ok,
    managed_storage: frozen_runtime_text_proof.managed_storage,
    issue_count: frozen_runtime_text_proof.issues.length,
    final_storage: frozen_runtime_text_proof.final_result.storage,
    freeze_edges: frozen_runtime_text_proof.freeze_edges.map((edge) => {
      return {
        id: edge.id,
        storage: edge.analysis.storage,
        ownership: edge.analysis.ownership,
        decision: edge.analysis.decision,
      };
    }),
    drops: frozen_runtime_text_proof.drops.steps.map((step) => {
      return {
        edge: step.edge,
        scope: step.scope,
        owner: step.owner,
        ownership: step.ownership,
        storage: step.storage,
      };
    }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
    drops: [
      {
        edge: "scope_exit",
        scope: "program#0",
        owner: "prefix",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        storage: "persistent_unique_heap",
      },
    ],
  });
  Core.check_proof(frozen_runtime_text);

  const mutating_frozen_runtime_text = Source.core(Source.parse(`
let prefix: Text = slice("Ada", 0, 3)
let part: Text = freeze append(prefix, "!")
part[0] = 65
len(part)
`));
  assert_throws(
    () => Emit.emit(Core, mutating_frozen_runtime_text),
    "Cannot mutate frozen/shareable core binding: part",
  );

  const scratch_frozen_runtime_text = Source.core(Source.parse(`
let prefix: Text = slice("Ada", 0, 3)
scratch { freeze append(prefix, "!") }
`));
  const scratch_frozen_runtime_text_proof = Core.proof(
    scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: scratch_frozen_runtime_text_proof.ok,
    managed_storage: scratch_frozen_runtime_text_proof.managed_storage,
    issue_count: scratch_frozen_runtime_text_proof.issues.length,
    final_storage: scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_return_storage: scratch_frozen_runtime_text_proof.cleanup.steps[0]
      ?.return_value.storage,
    allocations: scratch_frozen_runtime_text_proof.allocations.facts.map(
      (fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      },
    ),
    freeze_edges: scratch_frozen_runtime_text_proof.freeze_edges.map((edge) => {
      return {
        id: edge.id,
        storage: edge.analysis.storage,
        ownership: edge.analysis.ownership,
        decision: edge.analysis.decision,
      };
    }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(scratch_frozen_runtime_text);

  const bound_scratch_frozen_runtime_text = Source.core(Source.parse(`
let prefix: Text = slice("Ada", 0, 3)
scratch {
  let temp: Text = append(prefix, "!")
  freeze temp
}
`));
  const bound_scratch_frozen_runtime_text_proof = Core.proof(
    bound_scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: bound_scratch_frozen_runtime_text_proof.ok,
    managed_storage: bound_scratch_frozen_runtime_text_proof.managed_storage,
    issue_count: bound_scratch_frozen_runtime_text_proof.issues.length,
    final_storage: bound_scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_return_storage: bound_scratch_frozen_runtime_text_proof.cleanup
      .steps[0]
      ?.return_value.storage,
    allocations: bound_scratch_frozen_runtime_text_proof.allocations.facts.map(
      (fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      },
    ),
    freeze_edges: bound_scratch_frozen_runtime_text_proof.freeze_edges.map(
      (edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      },
    ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(bound_scratch_frozen_runtime_text);

  const alias_scratch_frozen_runtime_text = Source.core(Source.parse(`
let prefix: Text = slice("Ada", 0, 3)
scratch {
  let temp: Text = append(prefix, "!")
  let alias: Text = temp
  freeze alias
}
`));
  const alias_scratch_frozen_runtime_text_proof = Core.proof(
    alias_scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: alias_scratch_frozen_runtime_text_proof.ok,
    managed_storage: alias_scratch_frozen_runtime_text_proof.managed_storage,
    issue_count: alias_scratch_frozen_runtime_text_proof.issues.length,
    final_storage: alias_scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_return_storage: alias_scratch_frozen_runtime_text_proof.cleanup
      .steps[0]
      ?.return_value.storage,
    allocations: alias_scratch_frozen_runtime_text_proof.allocations.facts.map(
      (fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      },
    ),
    freeze_edges: alias_scratch_frozen_runtime_text_proof.freeze_edges.map(
      (edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      },
    ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(alias_scratch_frozen_runtime_text);

  const block_scratch_frozen_runtime_text = Source.core(Source.parse(`
let prefix: Text = slice("Ada", 0, 3)
scratch {
  let temp: Text = {
    let inner: Text = append(prefix, "!")
    inner
  }
  freeze temp
}
`));
  const block_scratch_frozen_runtime_text_proof = Core.proof(
    block_scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: block_scratch_frozen_runtime_text_proof.ok,
    managed_storage: block_scratch_frozen_runtime_text_proof.managed_storage,
    issue_count: block_scratch_frozen_runtime_text_proof.issues.length,
    final_storage: block_scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_return_storage: block_scratch_frozen_runtime_text_proof.cleanup
      .steps[0]
      ?.return_value.storage,
    allocations: block_scratch_frozen_runtime_text_proof.allocations.facts.map(
      (fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      },
    ),
    freeze_edges: block_scratch_frozen_runtime_text_proof.freeze_edges.map(
      (edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      },
    ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#1",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(block_scratch_frozen_runtime_text);

  const static_call_scratch_frozen_runtime_text = Source.core(Source.parse(`
let freeze_suffix = (value: Text) => {
  scratch {
    let temp: Text = append(value, "!")
    temp = append(temp, "?")
    freeze temp
  }
}

freeze_suffix("hi")
`));
  const static_call_scratch_frozen_runtime_text_proof = Core.proof(
    static_call_scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: static_call_scratch_frozen_runtime_text_proof.ok,
    managed_storage:
      static_call_scratch_frozen_runtime_text_proof.managed_storage,
    issue_count: static_call_scratch_frozen_runtime_text_proof.issues.length,
    final_storage:
      static_call_scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_return_storage: static_call_scratch_frozen_runtime_text_proof
      .cleanup.steps[0]
      ?.return_value.storage,
    allocations: static_call_scratch_frozen_runtime_text_proof.allocations
      .facts.map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    drops: static_call_scratch_frozen_runtime_text_proof.drops.steps.map(
      (step) => {
        return {
          edge: step.edge,
          scope: step.scope,
          owner: step.owner,
          storage: step.storage,
          ownership: step.ownership,
        };
      },
    ),
    freeze_edges: static_call_scratch_frozen_runtime_text_proof.freeze_edges
      .map((edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "block#1",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#1",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#1",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    drops: [
      {
        edge: "assignment_replace",
        scope: "block#0",
        owner: "temp",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(static_call_scratch_frozen_runtime_text);

  const branch_closure_scratch_frozen_runtime_text = Source.core(Source.parse(`
let flag = 1
let freeze_suffix = if flag {
  (value: Text) => {
    scratch {
      let temp: Text = append(value, "!")
      freeze temp
    }
  }
} else {
  (value: Text) => {
    scratch {
      let temp: Text = append(value, "?")
      freeze temp
    }
  }
}

let result: Text = freeze_suffix("hi")
len(result)
`));
  const branch_closure_scratch_frozen_runtime_text_proof = Core.proof(
    branch_closure_scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: branch_closure_scratch_frozen_runtime_text_proof.ok,
    managed_storage:
      branch_closure_scratch_frozen_runtime_text_proof.managed_storage,
    issue_count: branch_closure_scratch_frozen_runtime_text_proof.issues.length,
    final_storage:
      branch_closure_scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_returns: branch_closure_scratch_frozen_runtime_text_proof.cleanup
      .steps.map((step) => {
        return {
          scope: step.scope,
          storage: step.return_value.storage,
        };
      }),
    freeze_edges: branch_closure_scratch_frozen_runtime_text_proof.freeze_edges
      .map((edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_returns: [
      {
        scope: "scratch#0",
        storage: "frozen_heap",
      },
      {
        scope: "scratch#1",
        storage: "frozen_heap",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
      {
        id: "freeze#1",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(branch_closure_scratch_frozen_runtime_text);
  assert_equals(
    Typed.type(Core, branch_closure_scratch_frozen_runtime_text),
    "i32",
  );

  const direct_scratch_frozen_runtime_aggregate = Source.core(Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let user: user_type = scratch {
  freeze user_type { name: append(prefix, "da"), age: 40 }
}

len(user.name) + user.age
`));
  const direct_scratch_frozen_runtime_aggregate_proof = Core.proof(
    direct_scratch_frozen_runtime_aggregate,
  );
  assert_equals({
    ok: direct_scratch_frozen_runtime_aggregate_proof.ok,
    managed_storage:
      direct_scratch_frozen_runtime_aggregate_proof.managed_storage,
    issue_count: direct_scratch_frozen_runtime_aggregate_proof.issues.length,
    final_storage:
      direct_scratch_frozen_runtime_aggregate_proof.final_result.storage,
    scratch_return_storage: direct_scratch_frozen_runtime_aggregate_proof
      .cleanup.steps[0]
      ?.return_value.storage,
    allocations: direct_scratch_frozen_runtime_aggregate_proof.allocations.facts
      .map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    freeze_edges: direct_scratch_frozen_runtime_aggregate_proof.freeze_edges
      .map((edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        reason: "runtime_aggregate",
        expression: "struct_value",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_aggregate consumes the " +
            "owned buffer as immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(direct_scratch_frozen_runtime_aggregate);
  assert_includes(
    Emit.emit(Mod, Core.mod(direct_scratch_frozen_runtime_aggregate)),
    "global.get $__closure_heap",
  );

  const direct_scratch_frozen_runtime_union = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Unit
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let result: result_type = scratch {
  freeze result_type.ok(append(prefix, "da"))
}

if let .ok(value) = result {
  len(value)
} else {
  0
}
`));
  const direct_scratch_frozen_runtime_union_proof = Core.proof(
    direct_scratch_frozen_runtime_union,
  );
  assert_equals({
    ok: direct_scratch_frozen_runtime_union_proof.ok,
    managed_storage: direct_scratch_frozen_runtime_union_proof.managed_storage,
    issue_count: direct_scratch_frozen_runtime_union_proof.issues.length,
    final_storage:
      direct_scratch_frozen_runtime_union_proof.final_result.storage,
    scratch_return_storage: direct_scratch_frozen_runtime_union_proof.cleanup
      .steps[0]?.return_value
      .storage,
    allocations: direct_scratch_frozen_runtime_union_proof.allocations.facts
      .map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    freeze_edges: direct_scratch_frozen_runtime_union_proof.freeze_edges.map(
      (edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      },
    ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_union consumes the owned " +
            "buffer as immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(direct_scratch_frozen_runtime_union);
  assert_includes(
    Emit.emit(Mod, Core.mod(direct_scratch_frozen_runtime_union)),
    "global.get $__closure_heap",
  );

  const bound_scratch_frozen_runtime_union = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Unit
}

let start = 0
let prefix: Text = slice("Ada", start, 1)

scratch {
  let temp = result_type.ok(append(prefix, "da"))
  freeze temp
}
`));
  const bound_scratch_frozen_runtime_union_proof = Core.proof(
    bound_scratch_frozen_runtime_union,
  );
  assert_equals({
    ok: bound_scratch_frozen_runtime_union_proof.ok,
    managed_storage: bound_scratch_frozen_runtime_union_proof.managed_storage,
    issue_count: bound_scratch_frozen_runtime_union_proof.issues.length,
    final_storage:
      bound_scratch_frozen_runtime_union_proof.final_result.storage,
    scratch_return_storage: bound_scratch_frozen_runtime_union_proof.cleanup
      .steps[0]?.return_value.storage,
    allocations: bound_scratch_frozen_runtime_union_proof.allocations.facts
      .map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    freeze_edges: bound_scratch_frozen_runtime_union_proof.freeze_edges.map(
      (edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      },
    ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "freeze",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_union consumes the owned " +
            "buffer as immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(bound_scratch_frozen_runtime_union);
  assert_includes(
    Emit.emit(Mod, Core.mod(bound_scratch_frozen_runtime_union)),
    "block $text_freeze_exit_",
  );

  const bound_scratch_frozen_runtime_union_aggregate = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}
const result_type = union {
  ok: user_type,
  err: Unit
}

let start = 0
let prefix: Text = slice("Ada", start, 1)

scratch {
  let temp = result_type.ok(user_type { name: append(prefix, "da"), age: 40 })
  freeze temp
}
`),
  );
  const bound_scratch_frozen_runtime_union_aggregate_proof = Core.proof(
    bound_scratch_frozen_runtime_union_aggregate,
  );
  assert_equals({
    ok: bound_scratch_frozen_runtime_union_aggregate_proof.ok,
    managed_storage:
      bound_scratch_frozen_runtime_union_aggregate_proof.managed_storage,
    issue_count:
      bound_scratch_frozen_runtime_union_aggregate_proof.issues.length,
    final_storage:
      bound_scratch_frozen_runtime_union_aggregate_proof.final_result.storage,
    scratch_return_storage: bound_scratch_frozen_runtime_union_aggregate_proof
      .cleanup
      .steps[0]?.return_value.storage,
    allocations: bound_scratch_frozen_runtime_union_aggregate_proof
      .allocations.facts.map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    freeze_edges: bound_scratch_frozen_runtime_union_aggregate_proof
      .freeze_edges.map((edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_aggregate",
          },
        },
        reason: "runtime_aggregate",
        expression: "struct_value",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "freeze",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        reason: "runtime_aggregate",
        expression: "freeze",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_union consumes the owned " +
            "buffer as immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(bound_scratch_frozen_runtime_union_aggregate);
  assert_includes(
    Emit.emit(Mod, Core.mod(bound_scratch_frozen_runtime_union_aggregate)),
    "block $text_freeze_exit_",
  );

  const bound_scratch_frozen_runtime_union_union_payload = Source.core(
    Source.parse(`
const inner_type = union {
  some: Text,
  none: Unit
}
const outer_type = union {
  ok: inner_type,
  err: Unit
}

let start = 0
let prefix: Text = slice("Ada", start, 1)

scratch {
  let temp = outer_type.ok(inner_type.some(append(prefix, "da")))
  freeze temp
}
`),
  );
  const bound_scratch_frozen_runtime_union_union_payload_proof = Core.proof(
    bound_scratch_frozen_runtime_union_union_payload,
  );
  assert_equals({
    ok: bound_scratch_frozen_runtime_union_union_payload_proof.ok,
    managed_storage:
      bound_scratch_frozen_runtime_union_union_payload_proof.managed_storage,
    issue_count:
      bound_scratch_frozen_runtime_union_union_payload_proof.issues.length,
    final_storage:
      bound_scratch_frozen_runtime_union_union_payload_proof.final_result
        .storage,
    scratch_return_storage:
      bound_scratch_frozen_runtime_union_union_payload_proof.cleanup
        .steps[0]?.return_value.storage,
    allocations: bound_scratch_frozen_runtime_union_union_payload_proof
      .allocations.facts.map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    freeze_edges: bound_scratch_frozen_runtime_union_union_payload_proof
      .freeze_edges.map((edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "freeze",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_union consumes the owned " +
            "buffer as immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(bound_scratch_frozen_runtime_union_union_payload);
  assert_includes(
    Emit.emit(
      Mod,
      Core.mod(bound_scratch_frozen_runtime_union_union_payload),
    ),
    "block $text_freeze_exit_",
  );

  const bound_scratch_frozen_runtime_aggregate_union_field = Source.core(
    Source.parse(`
const result_type = union {
  ok: Text,
  err: Unit
}
const box_type = struct {
  result: result_type,
  age: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)

scratch {
  let temp = box_type { result: result_type.ok(append(prefix, "da")), age: 40 }
  freeze temp
}
`),
  );
  const bound_scratch_frozen_runtime_aggregate_union_field_proof = Core.proof(
    bound_scratch_frozen_runtime_aggregate_union_field,
  );
  assert_equals({
    ok: bound_scratch_frozen_runtime_aggregate_union_field_proof.ok,
    managed_storage:
      bound_scratch_frozen_runtime_aggregate_union_field_proof.managed_storage,
    issue_count:
      bound_scratch_frozen_runtime_aggregate_union_field_proof.issues.length,
    final_storage:
      bound_scratch_frozen_runtime_aggregate_union_field_proof.final_result
        .storage,
    scratch_return_storage:
      bound_scratch_frozen_runtime_aggregate_union_field_proof.cleanup
        .steps[0]?.return_value.storage,
    allocations: bound_scratch_frozen_runtime_aggregate_union_field_proof
      .allocations.facts.map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    freeze_edges: bound_scratch_frozen_runtime_aggregate_union_field_proof
      .freeze_edges.map((edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        reason: "runtime_aggregate",
        expression: "freeze",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "freeze",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_aggregate consumes the " +
            "owned buffer as immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(bound_scratch_frozen_runtime_aggregate_union_field);
  assert_includes(
    Emit.emit(
      Mod,
      Core.mod(bound_scratch_frozen_runtime_aggregate_union_field),
    ),
    "block $text_freeze_exit_",
  );

  const bound_scratch_frozen_runtime_aggregate = Source.core(Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)

scratch {
  let temp: user_type = user_type { name: append(prefix, "da"), age: 40 }
  freeze temp
}
`));
  const bound_scratch_frozen_runtime_aggregate_proof = Core.proof(
    bound_scratch_frozen_runtime_aggregate,
  );
  assert_equals({
    ok: bound_scratch_frozen_runtime_aggregate_proof.ok,
    managed_storage:
      bound_scratch_frozen_runtime_aggregate_proof.managed_storage,
    issue_count: bound_scratch_frozen_runtime_aggregate_proof.issues.length,
    final_storage:
      bound_scratch_frozen_runtime_aggregate_proof.final_result.storage,
    scratch_return_storage: bound_scratch_frozen_runtime_aggregate_proof.cleanup
      .steps[0]?.return_value.storage,
    allocations: bound_scratch_frozen_runtime_aggregate_proof.allocations.facts
      .map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    freeze_edges: bound_scratch_frozen_runtime_aggregate_proof.freeze_edges.map(
      (edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      },
    ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        reason: "runtime_aggregate",
        expression: "freeze",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_aggregate consumes the " +
            "owned buffer as immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(bound_scratch_frozen_runtime_aggregate);
  assert_includes(
    Emit.emit(Mod, Core.mod(bound_scratch_frozen_runtime_aggregate)),
    "block $text_freeze_exit_",
  );

  const existing_alias_scratch_frozen_runtime_aggregate = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let start = 0
let prefix: Text = slice("Ada", start, 1)
let existing: user_type = user_type { name: append(prefix, "da"), age: 40 }

scratch {
  let temp = existing
  freeze temp
}
`),
  );
  const existing_alias_scratch_frozen_runtime_aggregate_proof = Core.proof(
    existing_alias_scratch_frozen_runtime_aggregate,
  );
  assert_equals({
    ok: existing_alias_scratch_frozen_runtime_aggregate_proof.ok,
    managed_storage:
      existing_alias_scratch_frozen_runtime_aggregate_proof.managed_storage,
    issue_count:
      existing_alias_scratch_frozen_runtime_aggregate_proof.issues.length,
    final_storage:
      existing_alias_scratch_frozen_runtime_aggregate_proof.final_result
        .storage,
    scratch_return_storage:
      existing_alias_scratch_frozen_runtime_aggregate_proof.cleanup
        .steps[0]?.return_value.storage,
    allocations: existing_alias_scratch_frozen_runtime_aggregate_proof
      .allocations.facts.map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    freeze_edges: existing_alias_scratch_frozen_runtime_aggregate_proof
      .freeze_edges.map((edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        reason: "runtime_aggregate",
        expression: "freeze",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_aggregate consumes the " +
            "owned buffer as immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(existing_alias_scratch_frozen_runtime_aggregate);
  assert_includes(
    Emit.emit(
      Mod,
      Core.mod(existing_alias_scratch_frozen_runtime_aggregate),
    ),
    "block $text_freeze_exit_",
  );

  const branch_assignment_scratch_frozen_runtime_aggregate = Source.core(
    Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let start = 0
let prefix: Text = slice("Ada", start, 1)
let existing: user_type = user_type { name: append(prefix, "da"), age: 40 }
if flag {
  existing = user_type { name: append(prefix, "!"), age: 41 }
} else {
  existing = user_type { name: append(prefix, "?"), age: 42 }
}
let user: user_type = scratch {
  let temp = existing
  freeze temp
}

len(user.name) + user.age
`),
  );
  const branch_assignment_scratch_frozen_runtime_aggregate_proof = Core.proof(
    branch_assignment_scratch_frozen_runtime_aggregate,
  );
  assert_equals({
    ok: branch_assignment_scratch_frozen_runtime_aggregate_proof.ok,
    managed_storage:
      branch_assignment_scratch_frozen_runtime_aggregate_proof.managed_storage,
    issue_count:
      branch_assignment_scratch_frozen_runtime_aggregate_proof.issues.length,
    final_storage:
      branch_assignment_scratch_frozen_runtime_aggregate_proof.final_result
        .storage,
    scratch_return_storage:
      branch_assignment_scratch_frozen_runtime_aggregate_proof.cleanup
        .steps[0]?.return_value.storage,
    freeze_allocations: branch_assignment_scratch_frozen_runtime_aggregate_proof
      .allocations.facts.filter((fact) => {
        return fact.expression === "freeze";
      }).map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    freeze_edges: branch_assignment_scratch_frozen_runtime_aggregate_proof
      .freeze_edges.map((edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return_storage: "frozen_heap",
    freeze_allocations: [
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        reason: "runtime_aggregate",
        expression: "freeze",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_aggregate consumes the " +
            "owned buffer as immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(branch_assignment_scratch_frozen_runtime_aggregate);
  assert_includes(
    Emit.emit(
      Mod,
      Core.mod(branch_assignment_scratch_frozen_runtime_aggregate),
    ),
    "block $text_freeze_exit_",
  );

  const branch_alias_scratch_frozen_runtime_union = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Int
}

let flag = 1
let start = 0
let prefix: Text = slice("Ada", start, 1)
let existing: result_type = if flag {
  result_type.ok(append(prefix, "da"))
} else {
  result_type.err(5)
}
let result: result_type = scratch {
  let temp = existing
  freeze temp
}

if let .ok(value) = result {
  len(value)
} else {
  0
}
`));
  const branch_alias_scratch_frozen_runtime_union_proof = Core.proof(
    branch_alias_scratch_frozen_runtime_union,
  );
  assert_equals({
    ok: branch_alias_scratch_frozen_runtime_union_proof.ok,
    managed_storage:
      branch_alias_scratch_frozen_runtime_union_proof.managed_storage,
    issue_count: branch_alias_scratch_frozen_runtime_union_proof.issues.length,
    final_storage:
      branch_alias_scratch_frozen_runtime_union_proof.final_result.storage,
    scratch_return_storage: branch_alias_scratch_frozen_runtime_union_proof
      .cleanup.steps[0]
      ?.return_value.storage,
    allocations: branch_alias_scratch_frozen_runtime_union_proof.allocations
      .facts.map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    freeze_edges: branch_alias_scratch_frozen_runtime_union_proof.freeze_edges
      .map((edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "freeze",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_union consumes the owned " +
            "buffer as immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(branch_alias_scratch_frozen_runtime_union);
  assert_includes(
    Emit.emit(Mod, Core.mod(branch_alias_scratch_frozen_runtime_union)),
    "block $text_freeze_exit_",
  );

  const branch_assignment_scratch_frozen_runtime_union = Source.core(
    Source.parse(`
const result_type = union {
  ok: Text,
  err: Int
}

let flag = 1
let start = 0
let prefix: Text = slice("Ada", start, 1)
let existing: result_type = result_type.err(5)

if flag {
  existing = result_type.ok(append(prefix, "da"))
} else {
  existing = result_type.err(7)
}

let result: result_type = scratch {
  let temp = existing
  freeze temp
}

if let .ok(value) = result {
  len(value)
} else {
  0
}
`),
  );
  const branch_assignment_scratch_frozen_runtime_union_proof = Core.proof(
    branch_assignment_scratch_frozen_runtime_union,
  );
  assert_equals({
    ok: branch_assignment_scratch_frozen_runtime_union_proof.ok,
    managed_storage:
      branch_assignment_scratch_frozen_runtime_union_proof.managed_storage,
    issue_count:
      branch_assignment_scratch_frozen_runtime_union_proof.issues.length,
    final_storage:
      branch_assignment_scratch_frozen_runtime_union_proof.final_result.storage,
    scratch_return_storage: branch_assignment_scratch_frozen_runtime_union_proof
      .cleanup.steps[0]
      ?.return_value.storage,
    allocations: branch_assignment_scratch_frozen_runtime_union_proof
      .allocations.facts.map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    freeze_edges: branch_assignment_scratch_frozen_runtime_union_proof
      .freeze_edges.map(
        (edge) => {
          return {
            id: edge.id,
            storage: edge.analysis.storage,
            ownership: edge.analysis.ownership,
            decision: edge.analysis.decision,
          };
        },
      ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "scalar_local",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "freeze",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_union consumes the owned " +
            "buffer as immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(branch_assignment_scratch_frozen_runtime_union);
  assert_includes(
    Emit.emit(Mod, Core.mod(branch_assignment_scratch_frozen_runtime_union)),
    "block $text_freeze_exit_",
  );

  const helper_scratch_frozen_runtime_text = Source.core(Source.parse(`
let add_bang = (value: Text) => { append(value, "!") }

scratch {
  let temp: Text = add_bang("hi")
  freeze temp
}
`));
  const helper_scratch_frozen_runtime_text_proof = Core.proof(
    helper_scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: helper_scratch_frozen_runtime_text_proof.ok,
    managed_storage: helper_scratch_frozen_runtime_text_proof.managed_storage,
    issue_count: helper_scratch_frozen_runtime_text_proof.issues.length,
    final_storage:
      helper_scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_return_storage: helper_scratch_frozen_runtime_text_proof.cleanup
      .steps[0]
      ?.return_value.storage,
    allocations: helper_scratch_frozen_runtime_text_proof.allocations.facts.map(
      (fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      },
    ),
    freeze_edges: helper_scratch_frozen_runtime_text_proof.freeze_edges.map(
      (edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      },
    ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "closure",
        },
        reason: "closure",
        expression: "lam",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#2",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#1",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(helper_scratch_frozen_runtime_text);

  const branch_scratch_frozen_runtime_text = Source.core(Source.parse(`
let flag = 1
let prefix: Text = slice("Ada", 0, 3)
scratch {
  if flag {
    freeze append(prefix, "!")
  } else {
    freeze append(prefix, "?")
  }
}
`));
  const branch_scratch_frozen_runtime_text_proof = Core.proof(
    branch_scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: branch_scratch_frozen_runtime_text_proof.ok,
    managed_storage: branch_scratch_frozen_runtime_text_proof.managed_storage,
    issue_count: branch_scratch_frozen_runtime_text_proof.issues.length,
    final_storage:
      branch_scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_return_storage: branch_scratch_frozen_runtime_text_proof.cleanup
      .steps[0]
      ?.return_value.storage,
    allocations: branch_scratch_frozen_runtime_text_proof.allocations.facts.map(
      (fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      },
    ),
    freeze_edges: branch_scratch_frozen_runtime_text_proof.freeze_edges.map(
      (edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      },
    ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#1",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#1",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
      {
        scope: "block#2",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#2",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
      {
        id: "freeze#1",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(branch_scratch_frozen_runtime_text);

  const branch_result_scratch_frozen_runtime_text = Source.core(Source.parse(`
let flag = 1
let prefix: Text = slice("Ada", 0, 3)
scratch {
  let temp: Text = if flag {
    append(prefix, "!")
  } else {
    append(prefix, "?")
  }
  freeze temp
}
`));
  const branch_result_scratch_frozen_runtime_text_proof = Core.proof(
    branch_result_scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: branch_result_scratch_frozen_runtime_text_proof.ok,
    managed_storage:
      branch_result_scratch_frozen_runtime_text_proof.managed_storage,
    issue_count: branch_result_scratch_frozen_runtime_text_proof.issues.length,
    final_storage:
      branch_result_scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_return_storage: branch_result_scratch_frozen_runtime_text_proof
      .cleanup.steps[0]
      ?.return_value.storage,
    allocations: branch_result_scratch_frozen_runtime_text_proof.allocations
      .facts.map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    freeze_edges: branch_result_scratch_frozen_runtime_text_proof.freeze_edges
      .map((edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#1",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#2",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(branch_result_scratch_frozen_runtime_text);

  const branch_assignment_scratch_frozen_runtime_text = Source.core(
    Source.parse(`
let flag = 1
let prefix: Text = slice("Ada", 0, 3)
scratch {
  let temp: Text = append(prefix, ".")
  if flag {
    temp = append(prefix, "!")
  } else {
    temp = append(prefix, "?")
  }
  freeze temp
}
`),
  );
  const branch_assignment_scratch_frozen_runtime_text_proof = Core.proof(
    branch_assignment_scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: branch_assignment_scratch_frozen_runtime_text_proof.ok,
    managed_storage:
      branch_assignment_scratch_frozen_runtime_text_proof.managed_storage,
    issue_count:
      branch_assignment_scratch_frozen_runtime_text_proof.issues.length,
    final_storage:
      branch_assignment_scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_return_storage: branch_assignment_scratch_frozen_runtime_text_proof
      .cleanup.steps[0]
      ?.return_value.storage,
    allocations: branch_assignment_scratch_frozen_runtime_text_proof.allocations
      .facts.map(
        (fact) => {
          return {
            scope: fact.scope,
            storage: fact.storage,
            ownership: fact.ownership,
            reason: fact.reason,
            expression: fact.expression,
          };
        },
      ),
    drops: branch_assignment_scratch_frozen_runtime_text_proof.drops.steps.map(
      (step) => {
        return {
          edge: step.edge,
          scope: step.scope,
          owner: step.owner,
          storage: step.storage,
          ownership: step.ownership,
        };
      },
    ),
    freeze_edges: branch_assignment_scratch_frozen_runtime_text_proof
      .freeze_edges.map(
        (edge) => {
          return {
            id: edge.id,
            storage: edge.analysis.storage,
            ownership: edge.analysis.ownership,
            decision: edge.analysis.decision,
          };
        },
      ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    drops: [
      {
        edge: "assignment_replace",
        scope: "block#1",
        owner: "temp",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
      {
        edge: "assignment_replace",
        scope: "block#2",
        owner: "temp",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
      {
        edge: "scope_exit",
        scope: "program#0",
        owner: "prefix",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(branch_assignment_scratch_frozen_runtime_text);

  const loop_assignment_scratch_frozen_runtime_text = Source.core(Source.parse(`
let prefix: Text = slice("Ada", 0, 3)
scratch {
  let temp: Text = append(prefix, ".")
  for i in 0..1 {
    temp = append(prefix, "!")
  }
  freeze temp
}
`));
  const loop_assignment_scratch_frozen_runtime_text_proof = Core.proof(
    loop_assignment_scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: loop_assignment_scratch_frozen_runtime_text_proof.ok,
    managed_storage:
      loop_assignment_scratch_frozen_runtime_text_proof.managed_storage,
    issue_count: loop_assignment_scratch_frozen_runtime_text_proof.issues
      .length,
    final_storage:
      loop_assignment_scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_return_storage: loop_assignment_scratch_frozen_runtime_text_proof
      .cleanup.steps[0]
      ?.return_value.storage,
    allocations: loop_assignment_scratch_frozen_runtime_text_proof.allocations
      .facts.map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    drops: loop_assignment_scratch_frozen_runtime_text_proof.drops.steps.map(
      (step) => {
        return {
          edge: step.edge,
          scope: step.scope,
          owner: step.owner,
          storage: step.storage,
          ownership: step.ownership,
        };
      },
    ),
    freeze_edges: loop_assignment_scratch_frozen_runtime_text_proof.freeze_edges
      .map((edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    drops: [
      {
        edge: "scope_exit",
        scope: "loop#0",
        owner: "temp",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
      {
        edge: "scope_exit",
        scope: "program#0",
        owner: "prefix",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(loop_assignment_scratch_frozen_runtime_text);

  const collection_loop_assignment_scratch_frozen_runtime_text = Source.core(
    Source.parse(`
const xs_type = struct {
  first: Int,
  second: Int
}
let prefix: Text = slice("Ada", 0, 3)
let xs: xs_type = xs_type { first: 1, second: 2 }
scratch {
  let temp: Text = append(prefix, ".")
  for x in xs {
    temp = append(prefix, "!")
  }
  freeze temp
}
`),
  );
  const collection_loop_assignment_scratch_frozen_runtime_text_proof = Core
    .proof(
      collection_loop_assignment_scratch_frozen_runtime_text,
    );
  assert_equals({
    ok: collection_loop_assignment_scratch_frozen_runtime_text_proof.ok,
    managed_storage:
      collection_loop_assignment_scratch_frozen_runtime_text_proof
        .managed_storage,
    issue_count: collection_loop_assignment_scratch_frozen_runtime_text_proof
      .issues.length,
    final_storage:
      collection_loop_assignment_scratch_frozen_runtime_text_proof.final_result
        .storage,
    scratch_return_storage:
      collection_loop_assignment_scratch_frozen_runtime_text_proof.cleanup
        .steps[0]
        ?.return_value.storage,
    allocations: collection_loop_assignment_scratch_frozen_runtime_text_proof
      .allocations
      .facts.map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    drops: collection_loop_assignment_scratch_frozen_runtime_text_proof.drops
      .steps.map((step) => {
        return {
          edge: step.edge,
          scope: step.scope,
          owner: step.owner,
          storage: step.storage,
          ownership: step.ownership,
        };
      }),
    freeze_edges: collection_loop_assignment_scratch_frozen_runtime_text_proof
      .freeze_edges
      .map((edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_aggregate",
          },
        },
        reason: "runtime_aggregate",
        expression: "var",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    drops: [
      {
        edge: "scope_exit",
        scope: "loop#0",
        owner: "temp",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
      {
        edge: "scope_exit",
        scope: "program#0",
        owner: "prefix",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(collection_loop_assignment_scratch_frozen_runtime_text);

  const if_let_assignment_scratch_frozen_runtime_text = Source.core(
    Source.parse(`
const result_type = union {
  ok: Text,
  err: Text
}
let flag = 1
let result: result_type = if flag {
  .ok("hi")
} else {
  .err("no")
}
scratch {
  let temp: Text = append("no", ".")
  if let .ok(value) = result {
    temp = append(value, "!")
  }
  if let .err(value) = result {
    temp = append(value, "?")
  }
  freeze temp
}
`),
  );
  const if_let_assignment_scratch_frozen_runtime_text_proof = Core.proof(
    if_let_assignment_scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: if_let_assignment_scratch_frozen_runtime_text_proof.ok,
    managed_storage:
      if_let_assignment_scratch_frozen_runtime_text_proof.managed_storage,
    issue_count:
      if_let_assignment_scratch_frozen_runtime_text_proof.issues.length,
    final_storage:
      if_let_assignment_scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_return_storage: if_let_assignment_scratch_frozen_runtime_text_proof
      .cleanup.steps[0]
      ?.return_value.storage,
    allocations: if_let_assignment_scratch_frozen_runtime_text_proof.allocations
      .facts.map((fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      }),
    drops: if_let_assignment_scratch_frozen_runtime_text_proof.drops.steps.map(
      (step) => {
        return {
          edge: step.edge,
          scope: step.scope,
          owner: step.owner,
          storage: step.storage,
          ownership: step.ownership,
        };
      },
    ),
    freeze_edges: if_let_assignment_scratch_frozen_runtime_text_proof
      .freeze_edges.map(
        (edge) => {
          return {
            id: edge.id,
            storage: edge.analysis.storage,
            ownership: edge.analysis.ownership,
            decision: edge.analysis.decision,
          };
        },
      ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    drops: [
      {
        edge: "assignment_replace",
        scope: "block#5",
        owner: "temp",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
      {
        edge: "assignment_replace",
        scope: "block#6",
        owner: "temp",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(if_let_assignment_scratch_frozen_runtime_text);

  const if_let_scratch_frozen_runtime_text = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Text
}
let flag = 1
let result: result_type = if flag {
  .ok("hi")
} else {
  .err("no")
}
scratch {
  if let .ok(value) = result {
    freeze append(value, "!")
  } else {
    freeze append("no", "?")
  }
}
`));
  const if_let_scratch_frozen_runtime_text_proof = Core.proof(
    if_let_scratch_frozen_runtime_text,
  );
  assert_equals({
    ok: if_let_scratch_frozen_runtime_text_proof.ok,
    managed_storage: if_let_scratch_frozen_runtime_text_proof.managed_storage,
    issue_count: if_let_scratch_frozen_runtime_text_proof.issues.length,
    final_storage:
      if_let_scratch_frozen_runtime_text_proof.final_result.storage,
    scratch_return_storage: if_let_scratch_frozen_runtime_text_proof.cleanup
      .steps[0]
      ?.return_value.storage,
    allocations: if_let_scratch_frozen_runtime_text_proof.allocations.facts.map(
      (fact) => {
        return {
          scope: fact.scope,
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      },
    ),
    freeze_edges: if_let_scratch_frozen_runtime_text_proof.freeze_edges.map(
      (edge) => {
        return {
          id: edge.id,
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      },
    ),
  }, {
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    final_storage: "frozen_heap",
    scratch_return_storage: "frozen_heap",
    allocations: [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#0",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        scope: "block#1",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#1",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
      {
        scope: "block#2",
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        reason: "runtime_text",
        expression: "app",
      },
      {
        scope: "block#2",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        reason: "runtime_text",
        expression: "freeze",
      },
    ],
    freeze_edges: [
      {
        id: "freeze#0",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
      {
        id: "freeze#1",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap text consumes the owned buffer as " +
            "immutable shareable storage",
        },
      },
    ],
  });
  Core.check_proof(if_let_scratch_frozen_runtime_text);

  const if_let_unfrozen_scratch_runtime_text = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Text
}
let flag = 1
let result: result_type = if flag {
  .ok("hi")
} else {
  .err("no")
}
scratch {
  if let .ok(value) = result {
    append(value, "!")
  } else {
    append("no", "?")
  }
}
`));
  const if_let_unfrozen_scratch_runtime_text_proof = Core.proof(
    if_let_unfrozen_scratch_runtime_text,
  );
  assert_equals({
    ok: if_let_unfrozen_scratch_runtime_text_proof.ok,
    managed_storage: if_let_unfrozen_scratch_runtime_text_proof.managed_storage,
    final_storage:
      if_let_unfrozen_scratch_runtime_text_proof.final_result.storage,
    issues: if_let_unfrozen_scratch_runtime_text_proof.issues.map((issue) => {
      return issue.message;
    }),
    scratch_return_storage: if_let_unfrozen_scratch_runtime_text_proof.cleanup
      .steps[0]
      ?.return_value.storage,
  }, {
    ok: false,
    managed_storage: "disabled",
    final_storage: "rejected",
    issues: [
      "Rejected baseline proof scratch#0 scratch_return: unique_heap text " +
      "cannot leave scratch without freeze or explicit promotion",
      "Rejected baseline proof final_result: scratch_backed over unique_heap " +
      "text may reference storage reset before the final result is used",
    ],
    scratch_return_storage: "rejected",
  });
  assert_throws(
    () => Core.check_proof(if_let_unfrozen_scratch_runtime_text),
    "Rejected baseline proof scratch#0 scratch_return: unique_heap text " +
      "cannot leave scratch without freeze or explicit promotion",
  );
  assert_throws(
    () => Typed.type(Core, if_let_unfrozen_scratch_runtime_text),
    "Cannot type core scratch block with non-scalar unique_heap text result " +
      "yet: unique_heap text cannot leave scratch without freeze or explicit " +
      "promotion",
  );

  const scratch_runtime_union_temporary = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

let flag = 1

scratch {
  if flag {
    result_type.ok(41)
  } else {
    result_type.err(5)
  }

  7
}
`));
  const scratch_runtime_union_temporary_proof = Core.proof(
    scratch_runtime_union_temporary,
  );
  assert_equals(
    scratch_runtime_union_temporary_proof.allocations.facts.map((fact) => {
      return {
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [
      {
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
      {
        storage: "scratch_arena",
        ownership: {
          tag: "scratch_backed",
          source: {
            tag: "unique_heap",
            reason: "runtime_union",
          },
        },
        reason: "runtime_union",
        expression: "union_case",
      },
    ],
  );
  Core.check_proof(scratch_runtime_union_temporary);

  const runtime_aggregate = Source.core(Source.parse(`
const user_type = struct {
  age: Int,
  score: I64
}

let user: user_type = user_type { age: 41, score: 9i64 }
user
`));
  const runtime_aggregate_proof = Core.proof(runtime_aggregate);
  assert_equals({
    ok: runtime_aggregate_proof.ok,
    issue_count: runtime_aggregate_proof.issues.length,
    final_storage: runtime_aggregate_proof.final_result.storage,
    ownership: runtime_aggregate_proof.final_result.ownership,
    allocations: runtime_aggregate_proof.allocations.facts.map((fact) => {
      return {
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
  }, {
    ok: true,
    issue_count: 0,
    final_storage: "persistent_unique_heap",
    ownership: {
      tag: "unique_heap",
      reason: "runtime_aggregate",
    },
    allocations: [
      {
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        reason: "runtime_aggregate",
        expression: "var",
      },
    ],
  });
  Core.check_proof(runtime_aggregate);

  const static_call_closure_shadow = Source.core(Source.parse(`
let choose = flag => {
  let value = 1
  value := 2i64
  if flag { value } else { 3i64 }
}

choose(1)
`));
  const static_call_closure_shadow_proof = Core.proof(
    static_call_closure_shadow,
  );
  assert_equals({
    ok: static_call_closure_shadow_proof.ok,
    issue_count: static_call_closure_shadow_proof.issues.length,
    final_storage: static_call_closure_shadow_proof.final_result.storage,
    drop_count: static_call_closure_shadow_proof.drops.steps.length,
  }, {
    ok: true,
    issue_count: 0,
    final_storage: "scalar_local",
    drop_count: 0,
  });
  Core.check_proof(static_call_closure_shadow);

  const static_call_i64_capture = Source.core(Source.parse(`
let factor: I64 = 2i64
let add_factor = (x: I64) => {
  x + factor
}

add_factor(40i64)
`));
  const static_call_i64_capture_proof = Core.proof(static_call_i64_capture);
  assert_equals({
    ok: static_call_i64_capture_proof.ok,
    issue_count: static_call_i64_capture_proof.issues.length,
    final_storage: static_call_i64_capture_proof.final_result.storage,
    drop_count: static_call_i64_capture_proof.drops.steps.length,
  }, {
    ok: true,
    issue_count: 0,
    final_storage: "scalar_local",
    drop_count: 1,
  });
  Core.check_proof(static_call_i64_capture);

  const static_tail_rec = Source.core(Source.parse(`
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
  const static_tail_rec_proof = Core.proof(static_tail_rec);
  assert_equals({
    ok: static_tail_rec_proof.ok,
    issue_count: static_tail_rec_proof.issues.length,
    final_storage: static_tail_rec_proof.final_result.storage,
    drop_count: static_tail_rec_proof.drops.steps.length,
  }, {
    ok: true,
    issue_count: 0,
    final_storage: "scalar_local",
    drop_count: 0,
  });
  Core.check_proof(static_tail_rec);

  const annotated_tail_rec = Source.core(Source.parse(`
let sum_down = rec (n: Int, total: Int) => {
  if n == 0 {
    total
  } else {
    rec(n - 1, total + n)
  }
}

sum_down(4, 0)
`));
  const annotated_tail_rec_proof = Core.proof(annotated_tail_rec);
  assert_equals({
    ok: annotated_tail_rec_proof.ok,
    issue_count: annotated_tail_rec_proof.issues.length,
    host_boundaries: annotated_tail_rec_proof.host_boundaries.edges,
    final_storage: annotated_tail_rec_proof.final_result.storage,
  }, {
    ok: true,
    issue_count: 0,
    host_boundaries: [],
    final_storage: "scalar_local",
  });
  Core.check_proof(annotated_tail_rec);

  const selected_closure_text_loop = Source.core(Source.parse(`
let flag = 1
let sum_text = if flag {
  (value: Text) => {
    let total = 0

    for i, byte in value {
      total = total + i + byte
    }

    total
  }
} else {
  (value: Text) => len(value)
}

sum_text("Ada")
`));
  const selected_closure_text_loop_proof = Core.proof(
    selected_closure_text_loop,
  );
  assert_equals({
    ok: selected_closure_text_loop_proof.ok,
    issue_count: selected_closure_text_loop_proof.issues.length,
    final_storage: selected_closure_text_loop_proof.final_result.storage,
    drop_count: selected_closure_text_loop_proof.drops.steps.length,
  }, {
    ok: true,
    issue_count: 0,
    final_storage: "scalar_local",
    drop_count: 1,
  });
  Core.check_proof(selected_closure_text_loop);

  const static_union_if_let = Source.core(Source.parse(`
let payload = 41
let result = .ok(payload)
payload = 1

if let .ok(x) = result {
  x
} else {
  0
}
`));
  const static_union_if_let_proof = Core.proof(static_union_if_let);
  assert_equals({
    ok: static_union_if_let_proof.ok,
    issue_count: static_union_if_let_proof.issues.length,
    final_storage: static_union_if_let_proof.final_result.storage,
    drop_count: static_union_if_let_proof.drops.steps.length,
  }, {
    ok: true,
    issue_count: 0,
    final_storage: "scalar_local",
    drop_count: 0,
  });
  Core.check_proof(static_union_if_let);

  const dynamic_union_if_let = Source.core(Source.parse(`
let flag = 1
let payload = 41
let result = if flag {
  .ok(payload)
} else {
  .err(7)
}

flag = 0
payload = 1
if let .ok(value) = result {
  value + 1
} else {
  0
}
`));
  const dynamic_union_if_let_proof = Core.proof(dynamic_union_if_let);
  assert_equals({
    ok: dynamic_union_if_let_proof.ok,
    issue_count: dynamic_union_if_let_proof.issues.length,
    final_storage: dynamic_union_if_let_proof.final_result.storage,
    drop_count: dynamic_union_if_let_proof.drops.steps.length,
  }, {
    ok: true,
    issue_count: 0,
    final_storage: "scalar_local",
    drop_count: 0,
  });
  Core.check_proof(dynamic_union_if_let);

  const typed_union_if_let = Source.core(Source.parse(`
const result_type = union {
  ok: I64,
  err: I64
}

let result: result_type = .err(1i64)
let value = if let .ok(found) = result {
  found + 1i64
}

value
`));
  const typed_union_if_let_proof = Core.proof(typed_union_if_let);
  assert_equals({
    ok: typed_union_if_let_proof.ok,
    issue_count: typed_union_if_let_proof.issues.length,
    final_storage: typed_union_if_let_proof.final_result.storage,
    drop_count: typed_union_if_let_proof.drops.steps.length,
  }, {
    ok: true,
    issue_count: 0,
    final_storage: "scalar_local",
    drop_count: 0,
  });
  Core.check_proof(typed_union_if_let);

  const frozen_closure = Source.core(Source.parse(`
let f = freeze ((x: Int) => x)
f(42)
`));
  const frozen_closure_proof = Core.proof(frozen_closure);
  assert_equals(
    {
      ok: frozen_closure_proof.ok,
      issue_count: frozen_closure_proof.issues.length,
      freeze_edges: frozen_closure_proof.freeze_edges.map((edge) => {
        return {
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
    },
    {
      ok: true,
      issue_count: 0,
      freeze_edges: [
        {
          ownership: {
            tag: "unique_heap",
            reason: "closure",
          },
          decision: {
            tag: "allowed",
            reason: "freeze of unique_heap closure consumes the owned " +
              "environment pointer as immutable shareable storage",
          },
        },
      ],
    },
  );
  Core.check_proof(frozen_closure);
  assert_includes(Emit.emit(Core, frozen_closure), "call_indirect");
  assert_equals(Typed.type(Core, frozen_closure), "i32");

  const scratch_frozen_closure = Source.core(Source.parse(`
let f = scratch { freeze ((x: Int) => x + 1) }
f(41)
`));
  const scratch_frozen_closure_proof = Core.proof(scratch_frozen_closure);
  assert_equals(
    {
      ok: scratch_frozen_closure_proof.ok,
      issue_count: scratch_frozen_closure_proof.issues.length,
      scratch_return_storage: scratch_frozen_closure_proof.cleanup.steps[0]
        ?.return_value.storage,
      freeze_edges: scratch_frozen_closure_proof.freeze_edges.map((edge) => {
        return {
          storage: edge.analysis.storage,
          ownership: edge.analysis.ownership,
          decision: edge.analysis.decision,
        };
      }),
      allocations: scratch_frozen_closure_proof.allocations.facts.map(
        (fact) => {
          return {
            scope: fact.scope,
            storage: fact.storage,
            ownership: fact.ownership,
            reason: fact.reason,
            expression: fact.expression,
          };
        },
      ),
    },
    {
      ok: true,
      issue_count: 0,
      scratch_return_storage: "frozen_heap",
      freeze_edges: [
        {
          storage: "persistent_unique_heap",
          ownership: {
            tag: "unique_heap",
            reason: "closure",
          },
          decision: {
            tag: "allowed",
            reason: "freeze of unique_heap closure consumes the owned " +
              "environment pointer as immutable shareable storage",
          },
        },
      ],
      allocations: [
        {
          scope: "block#0",
          storage: "persistent_unique_heap",
          ownership: {
            tag: "unique_heap",
            reason: "closure",
          },
          reason: "closure",
          expression: "lam",
        },
      ],
    },
  );
  Core.check_proof(scratch_frozen_closure);
  assert_includes(Emit.emit(Core, scratch_frozen_closure), "call_indirect");
  assert_equals(Typed.type(Core, scratch_frozen_closure), "i32");

  const block_scratch_frozen_closure = Source.core(Source.parse(`
let f = scratch {
  let inner = (x: Int) => x + 1
  freeze inner
}
f(41)
`));
  const block_scratch_frozen_closure_proof = Core.proof(
    block_scratch_frozen_closure,
  );
  assert_equals(
    {
      ok: block_scratch_frozen_closure_proof.ok,
      issue_count: block_scratch_frozen_closure_proof.issues.length,
      scratch_return_storage: block_scratch_frozen_closure_proof.cleanup
        .steps[0]?.return_value.storage,
      freeze_edges: block_scratch_frozen_closure_proof.freeze_edges.map(
        (edge) => {
          return {
            storage: edge.analysis.storage,
            ownership: edge.analysis.ownership,
            decision: edge.analysis.decision,
          };
        },
      ),
      allocations: block_scratch_frozen_closure_proof.allocations.facts.map(
        (fact) => {
          return {
            scope: fact.scope,
            storage: fact.storage,
            ownership: fact.ownership,
            reason: fact.reason,
            expression: fact.expression,
          };
        },
      ),
    },
    {
      ok: true,
      issue_count: 0,
      scratch_return_storage: "frozen_heap",
      freeze_edges: [
        {
          storage: "persistent_unique_heap",
          ownership: {
            tag: "unique_heap",
            reason: "closure",
          },
          decision: {
            tag: "allowed",
            reason: "freeze of unique_heap closure consumes the owned " +
              "environment pointer as immutable shareable storage",
          },
        },
      ],
      allocations: [
        {
          scope: "block#0",
          storage: "persistent_unique_heap",
          ownership: {
            tag: "unique_heap",
            reason: "closure",
          },
          reason: "closure",
          expression: "lam",
        },
      ],
    },
  );
  Core.check_proof(block_scratch_frozen_closure);
  assert_includes(
    Emit.emit(Core, block_scratch_frozen_closure),
    "call_indirect",
  );
  assert_equals(Typed.type(Core, block_scratch_frozen_closure), "i32");

  const branch_scratch_frozen_closure = Source.core(Source.parse(`
let flag = 1
let f = scratch {
  if flag {
    freeze ((x: Int) => x + 1)
  } else {
    freeze ((x: Int) => x + 2)
  }
}
f(41)
`));
  const branch_scratch_frozen_closure_proof = Core.proof(
    branch_scratch_frozen_closure,
  );
  assert_equals(
    {
      ok: branch_scratch_frozen_closure_proof.ok,
      issue_count: branch_scratch_frozen_closure_proof.issues.length,
      scratch_return_storage: branch_scratch_frozen_closure_proof.cleanup
        .steps[0]?.return_value.storage,
      freeze_edges: branch_scratch_frozen_closure_proof.freeze_edges.map(
        (edge) => {
          return {
            storage: edge.analysis.storage,
            ownership: edge.analysis.ownership,
            decision: edge.analysis.decision,
          };
        },
      ),
      allocations: branch_scratch_frozen_closure_proof.allocations.facts.map(
        (fact) => {
          return {
            storage: fact.storage,
            ownership: fact.ownership,
            reason: fact.reason,
            expression: fact.expression,
          };
        },
      ),
    },
    {
      ok: true,
      issue_count: 0,
      scratch_return_storage: "frozen_heap",
      freeze_edges: [
        {
          storage: "persistent_unique_heap",
          ownership: {
            tag: "unique_heap",
            reason: "closure",
          },
          decision: {
            tag: "allowed",
            reason: "freeze of unique_heap closure consumes the owned " +
              "environment pointer as immutable shareable storage",
          },
        },
        {
          storage: "persistent_unique_heap",
          ownership: {
            tag: "unique_heap",
            reason: "closure",
          },
          decision: {
            tag: "allowed",
            reason: "freeze of unique_heap closure consumes the owned " +
              "environment pointer as immutable shareable storage",
          },
        },
      ],
      allocations: [
        {
          storage: "persistent_unique_heap",
          ownership: {
            tag: "unique_heap",
            reason: "closure",
          },
          reason: "closure",
          expression: "lam",
        },
        {
          storage: "persistent_unique_heap",
          ownership: {
            tag: "unique_heap",
            reason: "closure",
          },
          reason: "closure",
          expression: "lam",
        },
      ],
    },
  );
  Core.check_proof(branch_scratch_frozen_closure);
  assert_includes(
    Emit.emit(Core, branch_scratch_frozen_closure),
    "call_indirect",
  );
  assert_equals(Typed.type(Core, branch_scratch_frozen_closure), "i32");

  const scratch_closure = Source.core(
    Source.parse("scratch { (x: Int) => x }"),
  );
  const scratch_message =
    "Rejected baseline proof scratch#0 scratch_return: unique_heap closure cannot leave scratch without freeze or explicit promotion";
  assert_equals(
    Core.proof(scratch_closure).issues.map((issue) => {
      return issue.message;
    }),
    [
      scratch_message,
      "Rejected baseline proof final_result: scratch_backed over unique_heap closure may reference storage reset before the final result is used",
    ],
  );
  assert_throws(() => Core.check_proof(scratch_closure), scratch_message);
  assert_throws(() => Emit.emit(Core, scratch_closure), scratch_message);
  assert_throws(
    () => Typed.type(Core, scratch_closure),
    "unique_heap closure cannot leave scratch without freeze or explicit promotion",
  );

  const block_scratch_closure = Source.core(Source.parse(`
scratch {
  let inner = (x: Int) => x
  inner
}
`));
  assert_throws(
    () => Typed.type(Core, block_scratch_closure),
    "unique_heap closure cannot leave scratch without freeze or explicit promotion",
  );

  const branch_scratch_closure = Source.core(Source.parse(`
let flag = 1
scratch {
  if flag {
    (x: Int) => x + 1
  } else {
    (x: Int) => x + 2
  }
}
`));
  assert_throws(
    () => Typed.type(Core, branch_scratch_closure),
    "unique_heap closure cannot leave scratch without freeze or explicit promotion",
  );

  const borrowed_closure = Source.core(Source.parse("borrow ((x: Int) => x)"));
  assert_throws(
    () => Core.check_proof(borrowed_closure),
    "Rejected borrow borrow#0 in program#0",
  );
  assert_throws(
    () => Emit.emit(Core, borrowed_closure),
    "Rejected borrow borrow#0 in program#0",
  );
});

Deno.test("Core.proof records closure capture ownership slots", () => {
  const scalar_capture_core = Source.core(Source.parse(`
let flag = 1
let n = 2
let f = if flag {
  (x: Int) => x + n
} else {
  (x: Int) => x + 1
}

f(40)
`));
  const scalar_plan = Core.closure_ownership(scalar_capture_core);

  assert_equals(scalar_plan.edges, [
    {
      id: "closure_capture#0",
      scope: "program#0/block#0",
      expression: "lam",
      captures: [
        {
          name: "n",
          ownership: { tag: "scalar_local", type: "i32" },
          decision: {
            tag: "allowed",
            reason: "scalar capture is copyable",
          },
        },
      ],
      decision: {
        tag: "allowed",
        reason: "all closure captures are copy/share safe",
      },
    },
  ]);
  assert_equals(Core.proof(scalar_capture_core).closure_ownership, scalar_plan);

  const frozen_capture_core = Source.core(Source.parse(`
let flag = 1
let message: Text = freeze append("he", "llo")
let f = if flag {
  (x: Int) => len(message) + x
} else {
  (x: Int) => x
}

f(1)
`));
  const frozen_plan = Core.closure_ownership(frozen_capture_core);

  assert_equals(frozen_plan.edges[0]?.captures[0], {
    name: "message",
    ownership: { tag: "frozen_shareable", reason: "freeze" },
    decision: {
      tag: "allowed",
      reason: "frozen/shareable capture is reusable",
    },
  });
  assert_equals(frozen_plan.edges[0]?.decision, {
    tag: "allowed",
    reason: "all closure captures are copy/share safe",
  });
  const frozen_proof = Core.proof(frozen_capture_core);

  assert_equals(frozen_proof.closure_ownership, frozen_plan);
  assert_equals(
    frozen_proof.issues.map((issue) => {
      return issue.message;
    }),
    [],
  );
  Core.check_proof(frozen_capture_core);

  const frozen_union_capture_core = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

let flag = 1
let result: result_type = freeze result_type.ok(41)
let read_result = if flag {
  (x: Int) => if let .ok(value) = result {
    value + x
  } else {
    x
  }
} else {
  (x: Int) => x
}

read_result(1)
`));
  const frozen_union_plan = Core.closure_ownership(
    frozen_union_capture_core,
  );

  assert_equals(frozen_union_plan.edges[0]?.captures[0], {
    name: "result",
    ownership: { tag: "frozen_shareable", reason: "freeze" },
    decision: {
      tag: "allowed",
      reason: "frozen/shareable capture is reusable",
    },
  });
  assert_equals(frozen_union_plan.edges[0]?.decision, {
    tag: "allowed",
    reason: "all closure captures are copy/share safe",
  });
  const frozen_union_proof = Core.proof(frozen_union_capture_core);

  assert_equals(frozen_union_proof.closure_ownership, frozen_union_plan);
  assert_equals(
    frozen_union_proof.issues.map((issue) => {
      return issue.message;
    }),
    [],
  );
  Core.check_proof(frozen_union_capture_core);
  assert_includes(Emit.emit(Core, frozen_union_capture_core), "call_indirect");

  const frozen_aggregate_text_field_capture_core = Source.core(Source.parse(`
const user_type = struct {
  name: Text,
  age: Int
}

let flag = 1
let user: user_type = freeze user_type {
  name: append("Ad", "a"),
  age: 41
}
let read_user = if flag {
  (x: Int) => len(user.name) + x
} else {
  (x: Int) => x
}

read_user(1)
`));
  const frozen_aggregate_text_field_proof = Core.proof(
    frozen_aggregate_text_field_capture_core,
  );
  const frozen_aggregate_text_field_capture = frozen_aggregate_text_field_proof
    .closure_ownership.edges[0]?.captures[0];

  if (!frozen_aggregate_text_field_capture) {
    throw new Error("Missing frozen aggregate text field capture");
  }

  if (!frozen_aggregate_text_field_capture.name.startsWith("_field_name#")) {
    throw new Error(
      "Expected frozen aggregate text field temp capture, got " +
        frozen_aggregate_text_field_capture.name,
    );
  }

  assert_equals(
    {
      ownership: frozen_aggregate_text_field_capture.ownership,
      decision: frozen_aggregate_text_field_capture.decision,
    },
    {
      ownership: { tag: "frozen_shareable", reason: "freeze" },
      decision: {
        tag: "allowed",
        reason: "frozen/shareable capture is reusable",
      },
    },
  );
  assert_equals(
    frozen_aggregate_text_field_proof.closure_ownership.edges[0]?.decision,
    {
      tag: "allowed",
      reason: "all closure captures are copy/share safe",
    },
  );
  assert_equals(
    frozen_aggregate_text_field_proof.issues.map((issue) => {
      return issue.message;
    }),
    [],
  );
  Core.check_proof(frozen_aggregate_text_field_capture_core);
  assert_equals(
    Typed.type(Core, frozen_aggregate_text_field_capture_core),
    "i32",
  );
  assert_includes(
    Emit.emit(Core, frozen_aggregate_text_field_capture_core),
    "call_indirect",
  );

  const unique_capture_core = Source.core(Source.parse(`
let flag = 1
let message: Text = append("he", "llo")
let f = if flag {
  (x: Int) => len(message) + x
} else {
  (x: Int) => x
}

f(1)
`));
  const unique_plan = Core.closure_ownership(unique_capture_core);

  assert_equals(unique_plan.edges[0]?.captures[0], {
    name: "message",
    ownership: { tag: "unique_heap", reason: "text" },
    decision: {
      tag: "reserved",
      reason: "unique_heap text capture requires linear closure ownership " +
        "support",
    },
  });
  assert_equals(unique_plan.edges[0]?.decision, {
    tag: "reserved",
    reason: "message: unique_heap text capture requires linear closure " +
      "ownership support",
  });
  assert_equals(Core.proof(unique_capture_core).closure_ownership, unique_plan);
  assert_equals(
    Core.proof(unique_capture_core).issues.map((issue) => issue.message),
    [
      "Rejected baseline proof closure_capture#0: message: unique_heap text " +
      "capture requires linear closure ownership support",
    ],
  );
  assert_throws(
    () => Core.check_proof(unique_capture_core),
    "Rejected baseline proof closure_capture#0: message: unique_heap text " +
      "capture requires linear closure ownership support",
  );
  assert_throws(
    () => Emit.emit(Core, unique_capture_core),
    "Rejected baseline proof closure_capture#0: message: unique_heap text " +
      "capture requires linear closure ownership support",
  );

  const borrow_capture_core = Source.core(Source.parse(`
let message: Text = append("he", "llo")
let view = borrow message
let f = (x: Int) => len(view) + x

f(1)
`));
  const borrow_plan = Core.closure_ownership(borrow_capture_core);

  assert_equals(borrow_plan.edges[0]?.captures[0], {
    name: "view",
    ownership: {
      tag: "borrow_view",
      source: { tag: "unique_heap", reason: "text" },
    },
    decision: {
      tag: "reserved",
      reason: "borrow_view over unique_heap text capture requires linear " +
        "closure ownership support",
    },
  });
  assert_equals(borrow_plan.edges[0]?.decision, {
    tag: "reserved",
    reason: "view: borrow_view over unique_heap text capture requires " +
      "linear closure ownership support",
  });
  assert_equals(
    Core.proof(borrow_capture_core).closure_ownership,
    borrow_plan,
  );
  assert_equals(
    Core.proof(borrow_capture_core).issues.map((issue) => issue.message),
    [
      "Rejected baseline proof closure_capture#0: view: borrow_view over " +
      "unique_heap text capture requires linear closure ownership support",
    ],
  );
  assert_throws(
    () => Core.check_proof(borrow_capture_core),
    "Rejected baseline proof closure_capture#0: view: borrow_view over " +
      "unique_heap text capture requires linear closure ownership support",
  );
  assert_throws(
    () => Emit.emit(Core, borrow_capture_core),
    "Rejected baseline proof closure_capture#0: view: borrow_view over " +
      "unique_heap text capture requires linear closure ownership support",
  );

  const direct_scratch_capture_core = Source.core(Source.parse(`
scratch {
  let message: Text = append("he", "llo")
  ((x: Int) => len(message) + x)(1)
}
`));
  const direct_scratch_plan = Core.closure_ownership(
    direct_scratch_capture_core,
  );

  assert_equals(direct_scratch_plan.edges[0]?.captures[0], {
    name: "message",
    ownership: {
      tag: "scratch_backed",
      source: { tag: "unique_heap", reason: "text" },
    },
    decision: {
      tag: "allowed",
      reason: "scratch-backed capture is valid for an immediate " +
        "non-escaping closure call inside scratchpad",
    },
  });
  assert_equals(direct_scratch_plan.edges[0]?.decision, {
    tag: "allowed",
    reason: "all closure captures are copy/share safe",
  });
  assert_equals(
    Core.proof(direct_scratch_capture_core).closure_ownership,
    direct_scratch_plan,
  );
  assert_equals(
    Core.proof(direct_scratch_capture_core).issues.map((issue) => {
      return issue.message;
    }),
    [],
  );
  Core.check_proof(direct_scratch_capture_core);
  assert_equals(Typed.type(Core, direct_scratch_capture_core), "i32");
  assert_equals(
    Emit.emit(Core, direct_scratch_capture_core).includes("call_indirect"),
    false,
  );

  const scratch_capture_core = Source.core(Source.parse(`
scratch {
  let message: Text = append("he", "llo")
  freeze ((x: Int) => len(message) + x)
}
`));
  const scratch_plan = Core.closure_ownership(scratch_capture_core);

  assert_equals(scratch_plan.edges[0]?.captures[0], {
    name: "message",
    ownership: {
      tag: "scratch_backed",
      source: { tag: "unique_heap", reason: "text" },
    },
    decision: {
      tag: "reserved",
      reason: "scratch_backed over unique_heap text capture requires linear " +
        "closure ownership support",
    },
  });
  assert_equals(scratch_plan.edges[0]?.decision, {
    tag: "reserved",
    reason: "message: scratch_backed over unique_heap text capture requires " +
      "linear closure ownership support",
  });
  assert_equals(
    Core.proof(scratch_capture_core).closure_ownership,
    scratch_plan,
  );
  assert_equals(
    Core.proof(scratch_capture_core).issues.map((issue) => issue.message),
    [
      "Rejected baseline proof closure_capture#0: message: scratch_backed " +
      "over unique_heap text capture requires linear closure ownership support",
    ],
  );
  assert_throws(
    () => Core.check_proof(scratch_capture_core),
    "Rejected baseline proof closure_capture#0: message: scratch_backed " +
      "over unique_heap text capture requires linear closure ownership support",
  );
  assert_throws(
    () => Emit.emit(Core, scratch_capture_core),
    "Rejected baseline proof closure_capture#0: message: scratch_backed " +
      "over unique_heap text capture requires linear closure ownership support",
  );

  const aggregate_capture_core = Source.core(Source.parse(`
const pair_type = struct {
  first: Int,
  second: Int
}

let flag = 1
let make_pair = if flag {
  (first: Int, second: Int) => pair_type {
    first: first,
    second: second
  }
} else {
  (first: Int, second: Int) => pair_type {
    first: second,
    second: first
  }
}
let pair: pair_type = make_pair(1, 2)
let read_pair = if flag {
  (x: Int) => pair.first + pair.second + x
} else {
  (x: Int) => x
}

read_pair(3)
`));
  const aggregate_plan = Core.closure_ownership(aggregate_capture_core);

  assert_equals(aggregate_plan.edges[0]?.captures[0], {
    name: "pair",
    ownership: { tag: "unique_heap", reason: "runtime_aggregate" },
    decision: {
      tag: "allowed",
      reason: "runtime aggregate pointer capture is supported",
    },
  });
  assert_equals(aggregate_plan.edges[0]?.decision, {
    tag: "allowed",
    reason: "all closure captures are copy/share safe",
  });
  assert_equals(
    Core.proof(aggregate_capture_core).closure_ownership,
    aggregate_plan,
  );
  assert_equals(
    Core.proof(aggregate_capture_core).issues.map((issue) => issue.message),
    [],
  );
  const aggregate_capture_wat = Emit.emit(
    Mod,
    Core.mod(aggregate_capture_core),
  );

  assert_equals(Typed.type(Core, aggregate_capture_core), "i32");
  assert_includes(aggregate_capture_wat, "call_indirect");
  assert_includes(aggregate_capture_wat, "i32.load offset=0");
  assert_includes(aggregate_capture_wat, "i32.load offset=4");

  const closure_pointer_capture_core = Source.core(Source.parse(`
let flag = 1
let add = if flag {
  (x: Int) => x + 1
} else {
  (x: Int) => x + 2
}
let run = (y: Int) => add(y) + 10

run(30)
`));
  const closure_pointer_plan = Core.closure_ownership(
    closure_pointer_capture_core,
  );

  assert_equals(closure_pointer_plan.edges[0]?.captures[0], {
    name: "add",
    ownership: { tag: "unique_heap", reason: "closure" },
    decision: {
      tag: "allowed",
      reason: "closure pointer capture is supported",
    },
  });
  assert_equals(closure_pointer_plan.edges[0]?.decision, {
    tag: "allowed",
    reason: "all closure captures are copy/share safe",
  });
  assert_equals(
    Core.proof(closure_pointer_capture_core).closure_ownership,
    closure_pointer_plan,
  );
  assert_equals(
    Core.proof(closure_pointer_capture_core).issues.map((issue) => {
      return issue.message;
    }),
    [],
  );

  const runtime_union_capture_core = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

let flag = 1
let make = if flag {
  (x: Int) => result_type.ok(x)
} else {
  (x: Int) => result_type.err(x)
}
let result: result_type = make(41)
let read_result = if flag {
  (x: Int) => {
    if let .ok(value) = result {
      value + x
    } else {
      x
    }
  }
} else {
  (x: Int) => x
}

read_result(1)
`));
  const runtime_union_capture_plan = Core.closure_ownership(
    runtime_union_capture_core,
  );

  assert_equals(runtime_union_capture_plan.edges[0]?.captures[0], {
    name: "result",
    ownership: { tag: "unique_heap", reason: "runtime_union" },
    decision: {
      tag: "allowed",
      reason: "runtime union pointer capture is supported",
    },
  });
  assert_equals(runtime_union_capture_plan.edges[0]?.decision, {
    tag: "allowed",
    reason: "all closure captures are copy/share safe",
  });
  assert_equals(
    Core.proof(runtime_union_capture_core).closure_ownership,
    runtime_union_capture_plan,
  );
  assert_equals(
    Core.proof(runtime_union_capture_core).issues.map((issue) => {
      return issue.message;
    }),
    [],
  );
  const runtime_union_capture_wat = Emit.emit(
    Mod,
    Core.mod(runtime_union_capture_core),
  );

  assert_equals(Typed.type(Core, runtime_union_capture_core), "i32");
  assert_includes(runtime_union_capture_wat, "call_indirect");
  assert_includes(runtime_union_capture_wat, "i32.load offset=4");
});

Deno.test("Core.drops plans unique heap owner cleanup", () => {
  const unique_closure = {
    tag: "unique_heap",
    reason: "closure",
  } as const;
  const unique_runtime_union = {
    tag: "unique_heap",
    reason: "runtime_union",
  } as const;
  const unique_runtime_aggregate = {
    tag: "unique_heap",
    reason: "runtime_aggregate",
  } as const;
  const unique_text = {
    tag: "unique_heap",
    reason: "text",
  } as const;

  const unused_owner = Source.core(Source.parse(`
let f = (x: Int) => x

1
`));
  const unused_owner_proof = Core.proof(unused_owner);

  assert_equals(unused_owner_proof.ok, true);
  assert_equals(unused_owner_proof.managed_storage, "disabled");
  assert_equals(
    unused_owner_proof.allocations.facts.map((fact) => {
      return {
        scope: fact.scope,
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
    ],
  );
  assert_equals(Core.drops(unused_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const captured_closure_owner = Source.core(Source.parse(`
let n = 1
let f = (x: Int) => x + n

1
`));
  const captured_closure_owner_proof = Core.proof(captured_closure_owner);
  const captured_closure_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "no_op_bump_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  };

  assert_equals(captured_closure_owner_proof.ok, true);
  assert_equals(captured_closure_owner_proof.managed_storage, "disabled");
  assert_equals(
    captured_closure_owner_proof.allocations.facts.map((fact) => {
      return {
        scope: fact.scope,
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
    ],
  );
  assert_equals(captured_closure_owner_proof.closure_ownership.edges[0], {
    id: "closure_capture#0",
    scope: "program#0",
    expression: "lam",
    captures: [
      {
        name: "n",
        ownership: {
          tag: "scalar_local",
          type: "i32",
        },
        decision: {
          tag: "allowed",
          reason: "scalar capture is copyable",
        },
      },
    ],
    decision: {
      tag: "allowed",
      reason: "all closure captures are copy/share safe",
    },
  });
  assert_equals(
    captured_closure_owner_proof.drops,
    captured_closure_owner_drops,
  );
  assert_equals(
    Core.drops(captured_closure_owner),
    captured_closure_owner_drops,
  );

  const final_closure = Source.core(Source.parse("(x: Int) => x"));
  assert_equals(Core.drops(final_closure), { steps: [] });

  const const_closure = Source.core(Source.parse(`
const f = (x: Int) => x

1
`));
  assert_equals(Core.drops(const_closure), { steps: [] });

  const const_type_constructor = Source.core(Source.parse(`
const option_type = t => union {
  some: t,
  none: Unit
}

const option_int_type = option_type(Int)

let f = (x: Int) => x

1
`));
  assert_equals(Core.drops(const_type_constructor), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const closure_body_owner = Source.core(Source.parse(`
(x: Int) => {
  let f = (y: Int) => y
  1
}
`));
  assert_equals(Core.drops(closure_body_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "closure#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const closure_return_owner = Source.core(Source.parse(`
(x: Int) => {
  let f = (y: Int) => y
  return 1
}
`));
  assert_equals(Core.drops(closure_return_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "return_exit",
        scope: "closure#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure return exit lowers to no-op with bump allocator",
      },
    ],
  });

  const final_owner = Source.core(Source.parse(`
let f = (x: Int) => x

f
`));
  assert_equals(Core.drops(final_owner), { steps: [] });

  const return_owner = Source.core(Source.parse(`
let f = (x: Int) => x

return 1
`));
  assert_equals(Core.drops(return_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "return_exit",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure return exit lowers to no-op with bump allocator",
      },
    ],
  });

  const returned_owner = Source.core(Source.parse(`
let f = (x: Int) => x

return f
`));
  assert_equals(Core.drops(returned_owner), { steps: [] });

  const replaced_owner = Source.core(Source.parse(`
let f = (x: Int) => x
f = (x: Int) => x + 1

1
`));
  assert_equals(Core.drops(replaced_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "assignment_replace",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure assignment replacement lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const discarded_closure = Source.core(Source.parse(`
((x: Int) => x)

1
`));
  const discarded_closure_proof = Core.proof(discarded_closure);
  const discarded_closure_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "discarded_expr" as const,
        scope: "program#0",
        owner: undefined,
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "no_op_bump_allocator" as const,
        reason:
          "unique_heap closure discarded expression lowers to no-op with bump allocator",
      },
    ],
  };

  assert_equals(discarded_closure_proof.ok, true);
  assert_equals(discarded_closure_proof.managed_storage, "disabled");
  assert_equals(
    discarded_closure_proof.allocations.facts.map((fact) => {
      return {
        scope: fact.scope,
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [
      {
        scope: "program#0",
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
    ],
  );
  assert_equals(discarded_closure_proof.drops, discarded_closure_drops);
  assert_equals(Core.drops(discarded_closure), discarded_closure_drops);

  const discarded_runtime_text_temporary = Source.core(Source.parse(`
(value: Text) => {
  append(value, "!")
  1
}
`));
  const discarded_runtime_text_temporary_proof = Core.proof(
    discarded_runtime_text_temporary,
  );
  const discarded_runtime_text_temporary_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "discarded_expr" as const,
        scope: "closure#0",
        owner: undefined,
        ownership: unique_text,
        storage: "persistent_unique_heap" as const,
        runtime: "no_op_bump_allocator" as const,
        reason:
          "unique_heap text discarded expression lowers to no-op with bump allocator",
      },
    ],
  };

  assert_equals(discarded_runtime_text_temporary_proof.ok, true);
  assert_equals(
    discarded_runtime_text_temporary_proof.managed_storage,
    "disabled",
  );
  assert_equals(
    discarded_runtime_text_temporary_proof.allocations.facts.map((fact) => {
      return {
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [
      {
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
      {
        storage: "persistent_unique_heap",
        ownership: unique_text,
        reason: "runtime_text",
        expression: "app",
      },
    ],
  );
  assert_equals(
    discarded_runtime_text_temporary_proof.drops,
    discarded_runtime_text_temporary_drops,
  );
  assert_equals(
    Core.drops(discarded_runtime_text_temporary),
    discarded_runtime_text_temporary_drops,
  );

  const discarded_runtime_text_slice_temporary = Source.core(Source.parse(`
(value: Text) => {
  slice(value, 0, 1)
  1
}
`));
  const discarded_runtime_text_slice_temporary_proof = Core.proof(
    discarded_runtime_text_slice_temporary,
  );
  const discarded_runtime_text_slice_temporary_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "discarded_expr" as const,
        scope: "closure#0",
        owner: undefined,
        ownership: unique_text,
        storage: "persistent_unique_heap" as const,
        runtime: "no_op_bump_allocator" as const,
        reason:
          "unique_heap text discarded expression lowers to no-op with bump allocator",
      },
    ],
  };

  assert_equals(discarded_runtime_text_slice_temporary_proof.ok, true);
  assert_equals(
    discarded_runtime_text_slice_temporary_proof.managed_storage,
    "disabled",
  );
  assert_equals(
    discarded_runtime_text_slice_temporary_proof.allocations.facts.map(
      (fact) => {
        return {
          storage: fact.storage,
          ownership: fact.ownership,
          reason: fact.reason,
          expression: fact.expression,
        };
      },
    ),
    [
      {
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
      {
        storage: "persistent_unique_heap",
        ownership: unique_text,
        reason: "runtime_text",
        expression: "app",
      },
    ],
  );
  assert_equals(
    discarded_runtime_text_slice_temporary_proof.drops,
    discarded_runtime_text_slice_temporary_drops,
  );
  assert_equals(
    Core.drops(discarded_runtime_text_slice_temporary),
    discarded_runtime_text_slice_temporary_drops,
  );

  const discarded_runtime_aggregate_temporary = Source.core(Source.parse(`
const user_type = struct {
  name: Text
}

(value: Text) => {
  user_type { name: value }
  1
}
`));
  assert_equals(Core.drops(discarded_runtime_aggregate_temporary), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "discarded_expr",
        scope: "closure#0",
        owner: undefined,
        ownership: unique_runtime_aggregate,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap runtime_aggregate discarded expression lowers to no-op with bump allocator",
      },
    ],
  });

  const discarded_runtime_union_temporary = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Text
}

(value: Text) => {
  result_type.ok(value)
  1
}
`));
  const discarded_runtime_union_temporary_proof = Core.proof(
    discarded_runtime_union_temporary,
  );
  const discarded_runtime_union_temporary_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "discarded_expr" as const,
        scope: "closure#0",
        owner: undefined,
        ownership: unique_runtime_union,
        storage: "persistent_unique_heap" as const,
        runtime: "no_op_bump_allocator" as const,
        reason:
          "unique_heap runtime_union discarded expression lowers to no-op with bump allocator",
      },
    ],
  };

  assert_equals(discarded_runtime_union_temporary_proof.ok, true);
  assert_equals(
    discarded_runtime_union_temporary_proof.managed_storage,
    "disabled",
  );
  assert_equals(
    discarded_runtime_union_temporary_proof.allocations.facts.map((fact) => {
      return {
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [
      {
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
      {
        storage: "persistent_unique_heap",
        ownership: unique_runtime_union,
        reason: "runtime_union",
        expression: "union_case",
      },
    ],
  );
  assert_equals(
    discarded_runtime_union_temporary_proof.drops,
    discarded_runtime_union_temporary_drops,
  );
  assert_equals(
    Core.drops(discarded_runtime_union_temporary),
    discarded_runtime_union_temporary_drops,
  );

  const bound_runtime_union_temporary = Source.core(Source.parse(`
const result_type = union {
  ok: Text,
  err: Text
}

(value: Text) => {
  let result: result_type = result_type.ok(value)
  1
}
`));
  const bound_runtime_union_temporary_proof = Core.proof(
    bound_runtime_union_temporary,
  );
  const bound_runtime_union_temporary_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "closure#0",
        owner: "result",
        ownership: unique_runtime_union,
        storage: "persistent_unique_heap" as const,
        runtime: "no_op_bump_allocator" as const,
        reason:
          "unique_heap runtime_union scope exit lowers to no-op with bump allocator",
      },
    ],
  };

  assert_equals(bound_runtime_union_temporary_proof.ok, true);
  assert_equals(
    bound_runtime_union_temporary_proof.managed_storage,
    "disabled",
  );
  assert_equals(
    bound_runtime_union_temporary_proof.allocations.facts.map((fact) => {
      return {
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [
      {
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
      {
        storage: "persistent_unique_heap",
        ownership: unique_runtime_union,
        reason: "runtime_union",
        expression: "union_case",
      },
    ],
  );
  assert_equals(
    bound_runtime_union_temporary_proof.drops,
    bound_runtime_union_temporary_drops,
  );
  assert_equals(
    Core.drops(bound_runtime_union_temporary),
    bound_runtime_union_temporary_drops,
  );

  const discarded_static_aggregate_materialization = Source.core(Source.parse(`
const user = {
  name: "Ada",
  age: 41
}

user
1
`));
  assert_equals(Core.drops(discarded_static_aggregate_materialization), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "discarded_expr",
        scope: "program#0",
        owner: undefined,
        ownership: unique_runtime_aggregate,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap runtime_aggregate discarded expression lowers to no-op with bump allocator",
      },
    ],
  });

  const bound_runtime_text_temporary = Source.core(Source.parse(`
(value: Text) => {
  let message: Text = append(value, "!")
  1
}
`));
  const bound_runtime_text_temporary_proof = Core.proof(
    bound_runtime_text_temporary,
  );
  const bound_runtime_text_temporary_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "closure#0",
        owner: "message",
        ownership: unique_text,
        storage: "persistent_unique_heap" as const,
        runtime: "no_op_bump_allocator" as const,
        reason:
          "unique_heap text scope exit lowers to no-op with bump allocator",
      },
    ],
  };

  assert_equals(bound_runtime_text_temporary_proof.ok, true);
  assert_equals(bound_runtime_text_temporary_proof.managed_storage, "disabled");
  assert_equals(
    bound_runtime_text_temporary_proof.allocations.facts.map((fact) => {
      return {
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [
      {
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
      {
        storage: "persistent_unique_heap",
        ownership: unique_text,
        reason: "runtime_text",
        expression: "app",
      },
    ],
  );
  assert_equals(
    bound_runtime_text_temporary_proof.drops,
    bound_runtime_text_temporary_drops,
  );
  assert_equals(
    Core.drops(bound_runtime_text_temporary),
    bound_runtime_text_temporary_drops,
  );

  const bound_runtime_text_slice_temporary = Source.core(Source.parse(`
(value: Text) => {
  let part: Text = slice(value, 0, 1)
  1
}
`));
  const bound_runtime_text_slice_temporary_proof = Core.proof(
    bound_runtime_text_slice_temporary,
  );
  const bound_runtime_text_slice_temporary_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "closure#0",
        owner: "part",
        ownership: unique_text,
        storage: "persistent_unique_heap" as const,
        runtime: "no_op_bump_allocator" as const,
        reason:
          "unique_heap text scope exit lowers to no-op with bump allocator",
      },
    ],
  };

  assert_equals(bound_runtime_text_slice_temporary_proof.ok, true);
  assert_equals(
    bound_runtime_text_slice_temporary_proof.managed_storage,
    "disabled",
  );
  assert_equals(
    bound_runtime_text_slice_temporary_proof.allocations.facts.map((fact) => {
      return {
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [
      {
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
      {
        storage: "persistent_unique_heap",
        ownership: unique_text,
        reason: "runtime_text",
        expression: "app",
      },
    ],
  );
  assert_equals(
    bound_runtime_text_slice_temporary_proof.drops,
    bound_runtime_text_slice_temporary_drops,
  );
  assert_equals(
    Core.drops(bound_runtime_text_slice_temporary),
    bound_runtime_text_slice_temporary_drops,
  );

  const discarded_named_owner = Source.core(Source.parse(`
let f = (x: Int) => x
f

1
`));
  assert_equals(Core.drops(discarded_named_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "discarded_expr",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure discarded expression lowers to no-op with bump allocator",
      },
    ],
  });

  const moved_named_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let g = f

1
`));
  assert_equals(Core.drops(moved_named_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "program#0",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const discarded_frozen_named_owner = Source.core(Source.parse(`
let f = (x: Int) => x
freeze f

1
`));
  assert_equals(Core.drops(discarded_frozen_named_owner), { steps: [] });

  const bound_frozen_named_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let frozen = freeze f

1
`));
  assert_equals(Core.drops(bound_frozen_named_owner), { steps: [] });

  const block_frozen_named_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let frozen = {
  freeze f
}

1
`));
  assert_equals(Core.drops(block_frozen_named_owner), { steps: [] });

  const returned_frozen_named_owner = Source.core(Source.parse(`
let f = (x: Int) => x

return freeze f
`));
  assert_equals(Core.drops(returned_frozen_named_owner), { steps: [] });

  const self_assigned_frozen_named_owner = Source.core(Source.parse(`
let f = (x: Int) => x
f := freeze f

1
`));
  assert_equals(Core.drops(self_assigned_frozen_named_owner), { steps: [] });

  const branch_frozen_named_owners = Source.core(Source.parse(`
let flag = 1
let f = (x: Int) => x
let g = (x: Int) => x + 1

if flag {
  freeze f
} else {
  freeze g
}

1
`));
  assert_equals(Core.drops(branch_frozen_named_owners), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "block#0",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "block#2",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const optional_branch_frozen_named_owner = Source.core(Source.parse(`
let flag = 1
let f = (x: Int) => x

if flag {
  freeze f
}

1
`));
  assert_equals(Core.drops(optional_branch_frozen_named_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const optional_if_let_frozen_named_owner = Source.core(Source.parse(`
const maybe_type = union {
  some: Int,
  none: Unit
}

let target = maybe_type.some(1)
let f = (x: Int) => x

if let .some(value) = target {
  freeze f
}

1
`));
  assert_equals(Core.drops(optional_if_let_frozen_named_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "program#0",
        owner: "target",
        ownership: unique_runtime_union,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap runtime_union scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const final_block_outer_owner = Source.core(Source.parse(`
let f = (x: Int) => x

{ f }
`));
  assert_equals(Core.drops(final_block_outer_owner), { steps: [] });

  const discarded_block_outer_owner = Source.core(Source.parse(`
let f = (x: Int) => x

{ f }

1
`));
  assert_equals(Core.drops(discarded_block_outer_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "discarded_expr",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure discarded expression lowers to no-op with bump allocator",
      },
    ],
  });

  const moved_block_outer_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let g = { f }

1
`));
  assert_equals(Core.drops(moved_block_outer_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "program#0",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const discarded_block_local_owner = Source.core(Source.parse(`
{
  let g = (x: Int) => x
  g
}

1
`));
  assert_equals(Core.drops(discarded_block_local_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "discarded_expr",
        scope: "program#0",
        owner: undefined,
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure discarded expression lowers to no-op with bump allocator",
      },
    ],
  });

  const moved_block_local_owner = Source.core(Source.parse(`
let h = {
  let g = (x: Int) => x
  g
}

1
`));
  assert_equals(Core.drops(moved_block_local_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "program#0",
        owner: "h",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const block_local_owner_dropped = Source.core(Source.parse(`
let f = (x: Int) => x

{
  let g = (x: Int) => x
  1
}

1
`));
  assert_equals(Core.drops(block_local_owner_dropped), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "block#0",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const final_branch_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let g = (x: Int) => x

if 1 { f } else { g }
`));
  assert_equals(Core.drops(final_branch_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "block#0",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "block#2",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const discarded_branch_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let g = (x: Int) => x

if 1 { f } else { g }

1
`));
  assert_equals(Core.drops(discarded_branch_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "block#0",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "block#2",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#2",
        edge: "discarded_expr",
        scope: "block#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure discarded expression lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#3",
        edge: "discarded_expr",
        scope: "block#2",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure discarded expression lowers to no-op with bump allocator",
      },
    ],
  });

  const moved_branch_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let g = (x: Int) => x
let h = if 1 { f } else { g }

1
`));
  assert_equals(Core.drops(moved_branch_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "block#0",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "block#2",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#2",
        edge: "scope_exit",
        scope: "program#0",
        owner: "h",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const moved_mixed_branch_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let h = if 1 { f } else { (x: Int) => x }

1
`));
  assert_equals(Core.drops(moved_mixed_branch_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "block#2",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "program#0",
        owner: "h",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const const_union_if_let_branch_owner = Source.core(Source.parse(`
const result_type = union {
  ok: Int,
  err: Int
}

let f = (x: Int) => x
let g = (x: Int) => x

if let .ok(value) = result_type.ok(1) { f } else { g }
`));
  assert_equals(Core.drops(const_union_if_let_branch_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "block#0",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "block#2",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const break_owner = Source.core(Source.parse(`
for i in 0..1 {
  let f = (x: Int) => x
  break
}

0
`));
  assert_equals(Core.drops(break_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "break_exit",
        scope: "loop#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure break exit lowers to no-op with bump allocator",
      },
    ],
  });

  const continue_owner = Source.core(Source.parse(`
for i in 0..1 {
  let f = (x: Int) => x
  continue
}

0
`));
  assert_equals(Core.drops(continue_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "continue_exit",
        scope: "loop#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure continue exit lowers to no-op with bump allocator",
      },
    ],
  });

  const conditional_return_owner = Source.core(Source.parse(`
let f = (x: Int) => x
if 1 {
  return 1
}

0
`));
  assert_equals(Core.drops(conditional_return_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "return_exit",
        scope: "block#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure return exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const terminal_if_owner = Source.core(Source.parse(`
let f = (x: Int) => x
if 1 {
  return 1
} else {
  return 2
}

0
`));
  assert_equals(Core.drops(terminal_if_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "return_exit",
        scope: "block#1",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure return exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "return_exit",
        scope: "block#3",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure return exit lowers to no-op with bump allocator",
      },
    ],
  });

  const mixed_if_owner = Source.core(Source.parse(`
let f = (x: Int) => x
if 1 {
  return 1
} else {
  2
}

0
`));
  assert_equals(Core.drops(mixed_if_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "return_exit",
        scope: "block#1",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure return exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const branch_replaced_owner = Source.core(Source.parse(`
let f = (x: Int) => x
if 1 {
  f = (x: Int) => x + 1
} else {
  f = (x: Int) => x + 2
}

1
`));
  assert_equals(Core.drops(branch_replaced_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "assignment_replace",
        scope: "block#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure assignment replacement lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "assignment_replace",
        scope: "block#1",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure assignment replacement lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#2",
        edge: "scope_exit",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });

  const branch_local_owners = Source.core(Source.parse(`
if 1 {
  let f = (x: Int) => x
} else {
  let f = (x: Int) => x + 1
}

1
`));
  assert_equals(Core.drops(branch_local_owners), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "scope_exit",
        scope: "block#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "block#1",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "no_op_bump_allocator",
        reason:
          "unique_heap closure scope exit lowers to no-op with bump allocator",
      },
    ],
  });
});

Deno.test("Core.proof rejects unknown host boundary ownership", () => {
  const scalar_host_call = Source.core(Source.parse(`
let value = 41
host_scalar(value)
0
`));
  const scalar_host_proof = Core.proof(scalar_host_call);

  assert_equals({
    ok: scalar_host_proof.ok,
    managed_storage: scalar_host_proof.managed_storage,
    host_boundaries: scalar_host_proof.host_boundaries.edges,
    issues: scalar_host_proof.issues.map((issue) => {
      return {
        tag: issue.tag,
        message: issue.message,
      };
    }),
  }, {
    ok: false,
    managed_storage: "disabled",
    host_boundaries: [
      {
        id: "host#0",
        callee: "host_scalar",
        signature: undefined,
        args: [
          {
            index: 0,
            ownership: {
              tag: "scalar_local",
              type: "i32",
            },
            decision: {
              tag: "allowed",
              reason: "scalar host/import arguments do not carry ownership",
            },
          },
        ],
        decision: {
          tag: "rejected",
          reason: "missing host/import signature for host_scalar",
        },
      },
    ],
    issues: [
      {
        tag: "host_boundary",
        message: "Rejected host/import boundary host#0 host_scalar: " +
          "missing host/import signature for host_scalar",
      },
    ],
  });

  assert_throws(
    () => Core.check_proof(scalar_host_call),
    "Rejected host/import boundary host#0 host_scalar",
  );

  const unique_text_host_call = Source.core(Source.parse(`
let message: Text = slice("Ada", 0, 3)
host_use(message)
0
`));
  const unique_text_host_proof = Core.proof(unique_text_host_call);

  assert_equals({
    ok: unique_text_host_proof.ok,
    managed_storage: unique_text_host_proof.managed_storage,
    host_boundaries: unique_text_host_proof.host_boundaries.edges,
    issues: unique_text_host_proof.issues.map((issue) => {
      return {
        tag: issue.tag,
        message: issue.message,
      };
    }),
  }, {
    ok: false,
    managed_storage: "disabled",
    host_boundaries: [
      {
        id: "host#0",
        callee: "host_use",
        signature: undefined,
        args: [
          {
            index: 0,
            ownership: {
              tag: "unique_heap",
              reason: "text",
            },
            decision: {
              tag: "rejected",
              reason: "unknown host/import boundary would let unique_heap " +
                "text escape without a bounded-borrow or ownership-transfer " +
                "signature",
            },
          },
        ],
        decision: {
          tag: "rejected",
          reason: "argument 0 to host_use: unknown host/import boundary " +
            "would let unique_heap text escape without a bounded-borrow or " +
            "ownership-transfer signature",
        },
      },
    ],
    issues: [
      {
        tag: "host_boundary",
        message: "Rejected host/import boundary host#0 host_use: argument 0 " +
          "to host_use: unknown host/import boundary would let unique_heap " +
          "text escape without a bounded-borrow or ownership-transfer " +
          "signature",
      },
    ],
  });

  assert_throws(
    () => Emit.emit(Core, unique_text_host_call),
    "Rejected host/import boundary host#0 host_use",
  );
});

Deno.test("Source.core lowers host-backed capability methods", () => {
  const core = Source.core(Source.parse(`
host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
io = io.print("hello")
io
`));

  assert_equals(
    Format.fmt(Core, core),
    `let !io: I32 = 1:i32
io = print(!io, "hello")
io`,
  );
  assert_equals(Core.proof(core).issues, []);
  assert_includes(Emit.emit(Core, core), "call $print");

  const captured_linear_source = `
host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let print_once = () => io.print("hello")
io = print_once()
io
`;
  const captured_linear_core = Source.core(
    Source.parse(captured_linear_source),
  );

  assert_equals(Core.proof(captured_linear_core).issues, []);
  assert_includes(Source.wat(captured_linear_source), "call $print");

  const branch_linear_source = `
host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let flag = 0
let print_once = if flag {
  () => io.print("hello")
} else {
  () => io.print("world")
}
io = print_once()
io
`;
  const branch_linear_core = Source.core(Source.parse(branch_linear_source));

  assert_equals(Core.proof(branch_linear_core).issues, []);
  assert_equals(Data.data(Core, branch_linear_core), [
    {
      offset: 0,
      bytes: [5, 0, 0, 0, 104, 101, 108, 108, 111],
    },
    {
      offset: 12,
      bytes: [5, 0, 0, 0, 119, 111, 114, 108, 100],
    },
  ]);
  assert_includes(Source.wat(branch_linear_source), "call_indirect");

  const branch_param_linear_source = `
host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let flag = 0
let print_once = if flag {
  (message: Text) => io.print(borrow message)
} else {
  (text: Text) => io.print(borrow text)
}
io = print_once("world")
io
`;
  const branch_param_linear_core = Source.core(
    Source.parse(branch_param_linear_source),
  );

  assert_equals(Core.proof(branch_param_linear_core).issues, []);
  assert_includes(Source.wat(branch_param_linear_source), "call_indirect");

  const branch_equivalent_param_linear_source = `
let !base: I32 = 40
let flag = 0
let add = if flag {
  (a: Int) => !base + a
} else {
  (b: I32) => !base + b
}
base = add(2)
base
`;
  const branch_equivalent_param_linear_core = Source.core(
    Source.parse(branch_equivalent_param_linear_source),
  );

  assert_equals(Core.proof(branch_equivalent_param_linear_core).issues, []);
  assert_includes(
    Source.wat(branch_equivalent_param_linear_source),
    "call_indirect",
  );

  const if_let_payload_linear_source = `
const result_type = union {
  ok: Text,
  err: Text
}

host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let flag = 1
let result: result_type = if flag {
  result_type.ok("world")
} else {
  result_type.err("fallback")
}
let print_once = if let .ok(value) = result {
  () => io.print(borrow value)
} else {
  () => io.print("fallback")
}
io = print_once()
io
`;
  const if_let_payload_linear_core = Source.core(
    Source.parse(if_let_payload_linear_source),
  );

  assert_equals(Core.proof(if_let_payload_linear_core).issues, []);
  assert_equals(Typed.type(Core, if_let_payload_linear_core), "i32");
  assert_equals(Data.data(Core, if_let_payload_linear_core), [
    {
      offset: 0,
      bytes: [5, 0, 0, 0, 119, 111, 114, 108, 100],
    },
    {
      offset: 12,
      bytes: [8, 0, 0, 0, 102, 97, 108, 108, 98, 97, 99, 107],
    },
  ]);
  assert_includes(Source.wat(if_let_payload_linear_source), "call_indirect");
  assert_includes(Source.wat(if_let_payload_linear_source), "call $print");

  const runtime_if_let_payload_linear_source = `
const result_type = union {
  ok: Text,
  err: Unit
}

host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let flag = 1
let make = if flag {
  (x: Text) => result_type.ok(x)
} else {
  (x: Text) => result_type.err()
}
let result: result_type = make("world")
let print_once = if let .ok(value) = result {
  () => io.print(borrow value)
} else {
  () => io.print("fallback")
}
io = print_once()
io
`;
  const runtime_if_let_payload_linear_core = Source.core(
    Source.parse(runtime_if_let_payload_linear_source),
  );
  const runtime_if_let_payload_linear_wat = Source.wat(
    runtime_if_let_payload_linear_source,
  );

  assert_equals(Core.allocations(runtime_if_let_payload_linear_core).facts, [
    {
      id: "allocation#0",
      scope: "block#0",
      storage: "persistent_unique_heap",
      ownership: { tag: "unique_heap", reason: "closure" },
      reason: "closure",
      expression: "lam",
    },
    {
      id: "allocation#1",
      scope: "closure#0",
      storage: "persistent_unique_heap",
      ownership: { tag: "unique_heap", reason: "runtime_union" },
      reason: "runtime_union",
      expression: "union_case",
    },
    {
      id: "allocation#2",
      scope: "block#1",
      storage: "persistent_unique_heap",
      ownership: { tag: "unique_heap", reason: "closure" },
      reason: "closure",
      expression: "lam",
    },
    {
      id: "allocation#3",
      scope: "closure#1",
      storage: "persistent_unique_heap",
      ownership: { tag: "unique_heap", reason: "runtime_union" },
      reason: "runtime_union",
      expression: "union_case",
    },
    {
      id: "allocation#4",
      scope: "block#2",
      storage: "persistent_unique_heap",
      ownership: { tag: "unique_heap", reason: "closure" },
      reason: "closure",
      expression: "lam",
    },
    {
      id: "allocation#5",
      scope: "block#3",
      storage: "persistent_unique_heap",
      ownership: { tag: "unique_heap", reason: "closure" },
      reason: "closure",
      expression: "lam",
    },
  ]);
  assert_equals(Core.proof(runtime_if_let_payload_linear_core).issues, []);
  assert_equals(Typed.type(Core, runtime_if_let_payload_linear_core), "i32");
  assert_includes(
    runtime_if_let_payload_linear_wat,
    "call_indirect (type $closure_i32_i32_to_i32)",
  );
  assert_includes(
    runtime_if_let_payload_linear_wat,
    "call_indirect (type $closure_i32_to_i32)",
  );
  assert_includes(runtime_if_let_payload_linear_wat, "i32.load offset=4");
  assert_includes(runtime_if_let_payload_linear_wat, "call $print");

  assert_throws(
    () =>
      Source.core(Source.parse(`
host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let flag = 0
let print_once = if flag {
  () => io.print("hello")
} else {
  () => io.print("world")
}
io = print_once()
io = print_once()
io
`)),
    "Linear closure print_once was already consumed",
  );

  assert_throws(
    () =>
      Source.core(Source.parse(`
host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let flag = 0
let print_once = if flag {
  () => io.print("hello")
} else {
  () => io.print("world")
}
let again = print_once
io = print_once()
io = again()
io
`)),
    "Linear closure again was already consumed",
  );

  assert_throws(
    () =>
      Source.core(Source.parse(`
host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let print_once = () => io.print("hello")
io = print_once()
io = print_once()
io
`)),
    "Linear closure print_once was already consumed",
  );

  assert_throws(
    () =>
      Source.core(Source.parse(`
host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let print_once = () => io.print("hello")
let again = print_once
io = print_once()
io = again()
io
`)),
    "Linear closure again was already consumed",
  );

  assert_throws(
    () =>
      Source.core(Source.parse(`
host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
let flag = 1
let print_once = () => io.print("hello")
io = if flag {
  print_once()
} else {
  io.print("world")
}
io
`)),
    "Linear branches must consume the same closures",
  );

  const reusable_linear_param_core = Source.core(Source.parse(`
let id = (!x: I32) => x
let !value: I32 = 1
value = id(!value)
value = id(!value)
value
`));
  assert_equals(Core.proof(reusable_linear_param_core).issues, []);

  assert_throws(
    () =>
      Source.core(Source.parse(`
host_import print from "env.print" (I32, bounded_borrow Text) => I32

let !io: I32 = 1
io.print("hello")
io
`)),
    "Linear value io is consumed but not rebound",
  );

  const missing_method = Source.core(Source.parse(`
let !io: I32 = 1
io = io.print("hello")
io
`));
  assert_equals(
    Core.proof(missing_method).issues[0]?.message,
    "Missing host capability method: io.print",
  );
  assert_throws(
    () => Core.check_proof(missing_method),
    "Missing host capability method: io.print",
  );
  assert_throws(
    () =>
      Source.wat(`
let !io: I32 = 1
io = io.print("hello")
io
`),
    "Missing host capability method: io.print",
  );

  const missing_lambda_method = Source.core(Source.parse(`
const main = (!io: I32) => {
  io = io.print("hello")
  io
}

main
`));
  assert_equals(
    Core.proof(missing_lambda_method).issues[0]?.message,
    "Missing host capability method: io.print",
  );

  const first_class_linear_source = `
host_import print from "env.print" (I32, bounded_borrow Text) => I32

const main = (!io: I32) => {
  let print_once = () => io.print("hello")
  io = print_once()
  io
}

let flag = 1
let run = if flag { main } else { main }
let !io: I32 = 1
io = run(!io)
io
`;
  const first_class_linear_core = Source.core(
    Source.parse(first_class_linear_source),
  );

  assert_equals(Core.proof(first_class_linear_core).issues, []);
  assert_equals(Data.data(Core, first_class_linear_core), [
    {
      offset: 0,
      bytes: [5, 0, 0, 0, 104, 101, 108, 108, 111],
    },
  ]);
  assert_includes(Source.wat(first_class_linear_source), "call_indirect");
});

Deno.test("Core.proof accepts bounded-borrow host import contracts", () => {
  const bounded_borrow_host_call: CoreNode = {
    tag: "program",
    host_imports: {
      host_len: {
        name: "host_len",
        module: "env",
        field: "host_len",
        params: ["i32"],
        result: "i32",
        args: [{ tag: "bounded_borrow" }],
      },
    },
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: "message",
        is_linear: false,
        annotation: "Text",
        value: {
          tag: "app",
          func: { tag: "var", name: "slice" },
          args: [
            { tag: "text", value: "Ada" },
            { tag: "num", type: "i32", value: 0 },
            { tag: "num", type: "i32", value: 3 },
          ],
        },
      },
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "host_len" },
          args: [
            {
              tag: "borrow",
              value: { tag: "var", name: "message" },
            },
          ],
        },
      },
    ],
  };
  const proof = Core.proof(bounded_borrow_host_call);

  assert_equals(proof.ok, true);
  assert_equals(proof.managed_storage, "disabled");
  assert_equals(proof.host_boundaries.edges.length, 1);
  assert_equals(proof.host_boundaries.edges[0], {
    id: "host#0",
    callee: "host_len",
    signature: {
      name: "host_len",
      module: "env",
      field: "host_len",
      params: ["i32"],
      result: "i32",
      args: [{ tag: "bounded_borrow" }],
    },
    args: [
      {
        index: 0,
        ownership: {
          tag: "borrow_view",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        decision: {
          tag: "allowed",
          reason: "bounded-borrow host/import contract keeps the view inside " +
            "the call",
        },
      },
    ],
    decision: {
      tag: "allowed",
      reason: "host/import signature for host_len satisfies ownership " +
        "boundary checks",
    },
  });

  const wat = Emit.emit(Mod, Core.mod(bounded_borrow_host_call));
  assert_includes(
    wat,
    '(import "env" "host_len" (func $host_len (param i32) (result i32)))',
  );
  assert_includes(wat, "call $host_len");

  const direct_unique_host_call: CoreNode = {
    ...bounded_borrow_host_call,
    statements: [
      bounded_borrow_host_call.statements[0]!,
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "host_len" },
          args: [{ tag: "var", name: "message" }],
        },
      },
    ],
  };

  assert_throws(
    () => Core.check_proof(direct_unique_host_call),
    "bounded-borrow host/import contract cannot accept unique_heap text",
  );

  const wrapper_borrow_host_call = Source.core(Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let read = msg => host_read(msg)
let message: Text = append("a", "b")
read(borrow message)
`));
  const wrapper_borrow_proof = Core.proof(wrapper_borrow_host_call);

  assert_equals(wrapper_borrow_proof.ok, true);
  assert_equals(wrapper_borrow_proof.managed_storage, "disabled");
  assert_equals(wrapper_borrow_proof.host_boundaries.edges[0], {
    id: "host#0",
    callee: "host_read",
    signature: {
      name: "host_read",
      module: "env",
      field: "read",
      params: ["i32"],
      result: "i32",
      args: [{ tag: "bounded_borrow" }],
      result_owner: undefined,
    },
    args: [
      {
        index: 0,
        ownership: {
          tag: "borrow_view",
          source: {
            tag: "unique_heap",
            reason: "text",
          },
        },
        decision: {
          tag: "allowed",
          reason: "bounded-borrow host/import contract keeps the view inside " +
            "the call",
        },
      },
    ],
    decision: {
      tag: "allowed",
      reason: "host/import signature for host_read satisfies ownership " +
        "boundary checks",
    },
  });
  assert_includes(
    Emit.emit(Mod, Core.mod(wrapper_borrow_host_call)),
    "call $host_read",
  );

  const block_wrapper_borrow_host_call = Source.core(Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let read = msg => {
  host_read(msg)
}
let message: Text = append("a", "b")
read(borrow message)
`));
  const block_wrapper_borrow_proof = Core.proof(
    block_wrapper_borrow_host_call,
  );

  assert_equals(block_wrapper_borrow_proof.ok, true);
  assert_equals(
    block_wrapper_borrow_proof.host_boundaries.edges[0],
    wrapper_borrow_proof.host_boundaries.edges[0],
  );
  assert_includes(
    Emit.emit(Mod, Core.mod(block_wrapper_borrow_host_call)),
    "call $host_read",
  );

  const local_borrow_wrapper_host_call = Source.core(Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let read = (msg: Text) => {
  let view = borrow msg
  host_read(view)
}
let message: Text = append("a", "b")
read(message)
`));
  const local_borrow_wrapper_proof = Core.proof(
    local_borrow_wrapper_host_call,
  );

  assert_equals(local_borrow_wrapper_proof.ok, true);
  assert_equals(
    local_borrow_wrapper_proof.host_boundaries.edges[0],
    wrapper_borrow_proof.host_boundaries.edges[0],
  );
  assert_includes(
    Emit.emit(Mod, Core.mod(local_borrow_wrapper_host_call)),
    "call $host_read",
  );

  const rec_wrapper_borrow_host_call = Source.core(Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let read = rec (msg: Text) => host_read(msg)
let message: Text = append("a", "b")
read(borrow message)
`));
  const rec_wrapper_borrow_proof = Core.proof(rec_wrapper_borrow_host_call);

  assert_equals(rec_wrapper_borrow_proof.ok, true);
  assert_equals(
    rec_wrapper_borrow_proof.host_boundaries.edges[0],
    wrapper_borrow_proof.host_boundaries.edges[0],
  );
  assert_includes(
    Emit.emit(Mod, Core.mod(rec_wrapper_borrow_host_call)),
    "call $host_read",
  );

  const branch_wrapper_borrow_host_call = Source.core(Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let flag = 1
let read = if flag {
  (msg: Text) => host_read(msg)
} else {
  (msg: Text) => host_read(msg)
}
let message: Text = append("a", "b")
read(borrow message)
`));
  const branch_wrapper_borrow_proof = Core.proof(
    branch_wrapper_borrow_host_call,
  );

  assert_equals(branch_wrapper_borrow_proof.ok, true);
  assert_equals(
    branch_wrapper_borrow_proof.host_boundaries.edges.map((edge) =>
      edge.args[0]
    ),
    [
      wrapper_borrow_proof.host_boundaries.edges[0].args[0],
      wrapper_borrow_proof.host_boundaries.edges[0].args[0],
    ],
  );
  assert_equals(
    branch_wrapper_borrow_proof.host_boundaries.edges.map((edge) =>
      edge.decision.tag
    ),
    ["allowed", "allowed"],
  );
  assert_includes(
    Emit.emit(Mod, Core.mod(branch_wrapper_borrow_host_call)),
    "call $host_read",
  );

  const higher_order_borrow_wrapper_host_call = Source.core(Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let read = value => host_read(value)
let relay = (const f, msg: Text) => f(borrow msg)
let message: Text = append("a", "b")
relay(read, message)
`));
  const higher_order_borrow_wrapper_proof = Core.proof(
    higher_order_borrow_wrapper_host_call,
  );

  assert_equals(higher_order_borrow_wrapper_proof.ok, true);
  assert_equals(
    higher_order_borrow_wrapper_proof.host_boundaries.edges[0],
    wrapper_borrow_proof.host_boundaries.edges[0],
  );
  assert_includes(
    Emit.emit(Mod, Core.mod(higher_order_borrow_wrapper_host_call)),
    "call $host_read",
  );

  const higher_order_alias_borrow_wrapper_host_call = Source.core(
    Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let read = value => host_read(value)
let relay = (const f, msg: Text) => {
  let g = f
  g(borrow msg)
}
let message: Text = append("a", "b")
relay(read, message)
`),
  );
  const higher_order_alias_borrow_wrapper_proof = Core.proof(
    higher_order_alias_borrow_wrapper_host_call,
  );

  assert_equals(higher_order_alias_borrow_wrapper_proof.ok, true);
  assert_equals(
    Core.borrows(higher_order_alias_borrow_wrapper_host_call)
      .skipped_closures,
    [],
  );
  assert_equals(
    higher_order_alias_borrow_wrapper_proof.host_boundaries.edges[0],
    wrapper_borrow_proof.host_boundaries.edges[0],
  );
  assert_includes(
    Emit.emit(Mod, Core.mod(higher_order_alias_borrow_wrapper_host_call)),
    "call $host_read",
  );

  const wrapper_unique_host_call = Source.core(Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let read = msg => host_read(msg)
let message: Text = append("a", "b")
read(message)
`));
  const wrapper_unique_proof = Core.proof(wrapper_unique_host_call);

  assert_equals(wrapper_unique_proof.ok, false);
  assert_equals(
    wrapper_unique_proof.issues.map((issue) => issue.message),
    [
      "Rejected host/import boundary host#0 host_read: argument 0 to " +
      "host_read: bounded-borrow host/import contract cannot accept " +
      "unique_heap text",
    ],
  );
  assert_equals(wrapper_unique_proof.host_boundaries.edges[0].args[0], {
    index: 0,
    ownership: {
      tag: "unique_heap",
      reason: "text",
    },
    decision: {
      tag: "rejected",
      reason: "bounded-borrow host/import contract cannot accept " +
        "unique_heap text",
    },
  });
  assert_throws(
    () => Core.check_proof(wrapper_unique_host_call),
    "bounded-borrow host/import contract cannot accept unique_heap text",
  );

  const local_alias_wrapper_unique_host_call = Source.core(Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let read = msg => {
  let view = msg
  host_read(view)
}
let message: Text = append("a", "b")
read(message)
`));
  const local_alias_wrapper_unique_proof = Core.proof(
    local_alias_wrapper_unique_host_call,
  );

  assert_equals(local_alias_wrapper_unique_proof.ok, false);
  assert_equals(
    local_alias_wrapper_unique_proof.issues.map((issue) => issue.message),
    [
      "Rejected host/import boundary host#0 host_read: argument 0 to " +
      "host_read: bounded-borrow host/import contract cannot accept " +
      "unique_heap text",
    ],
  );
  assert_throws(
    () => Core.check_proof(local_alias_wrapper_unique_host_call),
    "bounded-borrow host/import contract cannot accept unique_heap text",
  );

  const rec_wrapper_unique_host_call = Source.core(Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let read = rec (msg: Text) => host_read(msg)
let message: Text = append("a", "b")
read(message)
`));
  const rec_wrapper_unique_proof = Core.proof(rec_wrapper_unique_host_call);

  assert_equals(rec_wrapper_unique_proof.ok, false);
  assert_equals(
    rec_wrapper_unique_proof.issues.map((issue) => issue.message),
    [
      "Rejected host/import boundary host#0 host_read: argument 0 to " +
      "host_read: bounded-borrow host/import contract cannot accept " +
      "unique_heap text",
    ],
  );
  assert_equals(
    rec_wrapper_unique_proof.host_boundaries.edges[0].args[0],
    wrapper_unique_proof.host_boundaries.edges[0].args[0],
  );
  assert_throws(
    () => Core.check_proof(rec_wrapper_unique_host_call),
    "bounded-borrow host/import contract cannot accept unique_heap text",
  );

  const branch_wrapper_unique_host_call = Source.core(Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let flag = 1
let read = if flag {
  (msg: Text) => host_read(msg)
} else {
  (msg: Text) => host_read(msg)
}
let message: Text = append("a", "b")
read(message)
`));
  const branch_wrapper_unique_proof = Core.proof(
    branch_wrapper_unique_host_call,
  );

  assert_equals(branch_wrapper_unique_proof.ok, false);
  assert_equals(
    branch_wrapper_unique_proof.issues.map((issue) => issue.message),
    [
      "Rejected host/import boundary host#0 host_read: argument 0 to " +
      "host_read: bounded-borrow host/import contract cannot accept " +
      "unique_heap text",
      "Rejected host/import boundary host#1 host_read: argument 0 to " +
      "host_read: bounded-borrow host/import contract cannot accept " +
      "unique_heap text",
    ],
  );
  assert_equals(
    branch_wrapper_unique_proof.host_boundaries.edges.map((edge) =>
      edge.args[0]
    ),
    [
      wrapper_unique_proof.host_boundaries.edges[0].args[0],
      wrapper_unique_proof.host_boundaries.edges[0].args[0],
    ],
  );
  assert_throws(
    () => Core.check_proof(branch_wrapper_unique_host_call),
    "bounded-borrow host/import contract cannot accept unique_heap text",
  );

  const higher_order_unique_wrapper_host_call = Source.core(Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let read = value => host_read(value)
let relay = (const f, msg: Text) => f(msg)
let message: Text = append("a", "b")
relay(read, message)
`));
  const higher_order_unique_wrapper_proof = Core.proof(
    higher_order_unique_wrapper_host_call,
  );

  assert_equals(higher_order_unique_wrapper_proof.ok, false);
  assert_equals(
    higher_order_unique_wrapper_proof.issues.map((issue) => issue.message),
    [
      "Rejected host/import boundary host#0 host_read: argument 0 to " +
      "host_read: bounded-borrow host/import contract cannot accept " +
      "unique_heap text",
    ],
  );
  assert_throws(
    () => Core.check_proof(higher_order_unique_wrapper_host_call),
    "bounded-borrow host/import contract cannot accept unique_heap text",
  );

  const higher_order_alias_unique_wrapper_host_call = Source.core(
    Source.parse(`
host_import host_read from "env.read" (bounded_borrow Text) => I32

let read = value => host_read(value)
let relay = (const f, msg: Text) => {
  let g = f
  g(msg)
}
let message: Text = append("a", "b")
relay(read, message)
`),
  );
  const higher_order_alias_unique_wrapper_proof = Core.proof(
    higher_order_alias_unique_wrapper_host_call,
  );

  assert_equals(higher_order_alias_unique_wrapper_proof.ok, false);
  assert_equals(
    higher_order_alias_unique_wrapper_proof.issues.map((issue) =>
      issue.message
    ),
    [
      "Rejected host/import boundary host#0 host_read: argument 0 to " +
      "host_read: bounded-borrow host/import contract cannot accept " +
      "unique_heap text",
    ],
  );
  assert_equals(
    higher_order_alias_unique_wrapper_proof.host_boundaries.edges[0].args[0],
    wrapper_unique_proof.host_boundaries.edges[0].args[0],
  );
  assert_throws(
    () => Core.check_proof(higher_order_alias_unique_wrapper_host_call),
    "bounded-borrow host/import contract cannot accept unique_heap text",
  );
});

Deno.test("Core.proof handles scratch-backed host import arguments", () => {
  const scratch_borrow_host_call: CoreNode = {
    tag: "program",
    host_imports: {
      host_read: {
        name: "host_read",
        module: "env",
        field: "read",
        params: ["i32"],
        result: "i32",
        args: [{ tag: "bounded_borrow" }],
      },
    },
    statements: [
      {
        tag: "expr",
        expr: {
          tag: "scratch",
          body: {
            tag: "block",
            statements: [
              {
                tag: "bind",
                kind: "let",
                name: "message",
                is_linear: false,
                annotation: "Text",
                value: {
                  tag: "app",
                  func: { tag: "var", name: "append" },
                  args: [
                    { tag: "text", value: "he" },
                    { tag: "text", value: "llo" },
                  ],
                },
              },
              {
                tag: "expr",
                expr: {
                  tag: "app",
                  func: { tag: "var", name: "host_read" },
                  args: [
                    {
                      tag: "borrow",
                      value: { tag: "var", name: "message" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  };
  const proof = Core.proof(scratch_borrow_host_call);

  assert_equals(proof.ok, true);
  assert_equals(proof.host_boundaries.edges[0], {
    id: "host#0",
    callee: "host_read",
    signature: {
      name: "host_read",
      module: "env",
      field: "read",
      params: ["i32"],
      result: "i32",
      args: [{ tag: "bounded_borrow" }],
    },
    args: [
      {
        index: 0,
        ownership: {
          tag: "borrow_view",
          source: {
            tag: "scratch_backed",
            source: {
              tag: "unique_heap",
              reason: "text",
            },
          },
        },
        decision: {
          tag: "allowed",
          reason: "bounded-borrow host/import contract keeps the view inside " +
            "the call",
        },
      },
    ],
    decision: {
      tag: "allowed",
      reason: "host/import signature for host_read satisfies ownership " +
        "boundary checks",
    },
  });

  const scratch_transfer_host_call: CoreNode = {
    tag: "program",
    host_imports: {
      host_take: {
        name: "host_take",
        module: "env",
        field: "take",
        params: ["i32"],
        result: "i32",
        args: [{ tag: "ownership_transfer" }],
      },
    },
    statements: [
      {
        tag: "expr",
        expr: {
          tag: "scratch",
          body: {
            tag: "block",
            statements: [
              {
                tag: "bind",
                kind: "let",
                name: "message",
                is_linear: false,
                annotation: "Text",
                value: {
                  tag: "app",
                  func: { tag: "var", name: "append" },
                  args: [
                    { tag: "text", value: "he" },
                    { tag: "text", value: "llo" },
                  ],
                },
              },
              {
                tag: "expr",
                expr: {
                  tag: "app",
                  func: { tag: "var", name: "host_take" },
                  args: [{ tag: "var", name: "message" }],
                },
              },
            ],
          },
        },
      },
    ],
  };
  const transfer_proof = Core.proof(scratch_transfer_host_call);

  assert_equals(transfer_proof.ok, false);
  assert_equals(transfer_proof.host_boundaries.edges[0].args[0], {
    index: 0,
    ownership: {
      tag: "scratch_backed",
      source: {
        tag: "unique_heap",
        reason: "text",
      },
    },
    decision: {
      tag: "rejected",
      reason: "ownership-transfer host/import contract cannot accept " +
        "scratch_backed over unique_heap text",
    },
  });
  assert_throws(
    () => Core.check_proof(scratch_transfer_host_call),
    "ownership-transfer host/import contract cannot accept scratch_backed " +
      "over unique_heap text",
  );
  assert_throws(
    () => Emit.emit(Core, scratch_transfer_host_call),
    "ownership-transfer host/import contract cannot accept scratch_backed " +
      "over unique_heap text",
  );
});

Deno.test("Core.proof accepts frozen-shareable host import contracts", () => {
  const frozen_shareable_host_call: CoreNode = {
    tag: "program",
    host_imports: {
      host_len: {
        name: "host_len",
        module: "env",
        field: "host_len",
        params: ["i32"],
        result: "i32",
        args: [{ tag: "frozen_shareable" }],
      },
    },
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: "message",
        is_linear: false,
        annotation: "Text",
        value: {
          tag: "freeze",
          value: {
            tag: "app",
            func: { tag: "var", name: "append" },
            args: [
              { tag: "text", value: "he" },
              { tag: "text", value: "llo" },
            ],
          },
        },
      },
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "host_len" },
          args: [{ tag: "var", name: "message" }],
        },
      },
    ],
  };
  const proof = Core.proof(frozen_shareable_host_call);

  assert_equals(proof.ok, true);
  assert_equals(proof.host_boundaries.edges[0], {
    id: "host#0",
    callee: "host_len",
    signature: {
      name: "host_len",
      module: "env",
      field: "host_len",
      params: ["i32"],
      result: "i32",
      args: [{ tag: "frozen_shareable" }],
    },
    args: [
      {
        index: 0,
        ownership: {
          tag: "frozen_shareable",
          reason: "freeze",
        },
        decision: {
          tag: "allowed",
          reason: "frozen/shareable host/import contract can read without " +
            "ownership transfer",
        },
      },
    ],
    decision: {
      tag: "allowed",
      reason: "host/import signature for host_len satisfies ownership " +
        "boundary checks",
    },
  });

  const direct_unique_host_call: CoreNode = {
    ...frozen_shareable_host_call,
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: "message",
        is_linear: false,
        annotation: "Text",
        value: {
          tag: "app",
          func: { tag: "var", name: "append" },
          args: [
            { tag: "text", value: "he" },
            { tag: "text", value: "llo" },
          ],
        },
      },
      frozen_shareable_host_call.statements[1]!,
    ],
  };

  assert_throws(
    () => Core.check_proof(direct_unique_host_call),
    "frozen/shareable host/import contract cannot accept unique_heap text",
  );
});

Deno.test("Core.proof accepts ownership-transfer host import contracts", () => {
  const transfer_host_call: CoreNode = {
    tag: "program",
    host_imports: {
      host_take: {
        name: "host_take",
        module: "env",
        field: "take",
        params: ["i32"],
        result: "i32",
        args: [{ tag: "ownership_transfer" }],
      },
    },
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: "message",
        is_linear: false,
        annotation: "Text",
        value: {
          tag: "app",
          func: { tag: "var", name: "slice" },
          args: [
            { tag: "text", value: "Ada" },
            { tag: "num", type: "i32", value: 0 },
            { tag: "num", type: "i32", value: 3 },
          ],
        },
      },
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "host_take" },
          args: [{ tag: "var", name: "message" }],
        },
      },
    ],
  };
  const proof = Core.proof(transfer_host_call);

  assert_equals(proof.ok, true);
  assert_equals(proof.host_boundaries.edges[0], {
    id: "host#0",
    callee: "host_take",
    signature: {
      name: "host_take",
      module: "env",
      field: "take",
      params: ["i32"],
      result: "i32",
      args: [{ tag: "ownership_transfer" }],
    },
    args: [
      {
        index: 0,
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        decision: {
          tag: "allowed",
          reason: "ownership-transfer host/import contract consumes " +
            "unique_heap text",
        },
      },
    ],
    decision: {
      tag: "allowed",
      reason: "host/import signature for host_take satisfies ownership " +
        "boundary checks",
    },
  });
  assert_equals(proof.drops.steps, [
    {
      tag: "host_transfer",
      id: "transfer#0",
      edge: "host_transfer",
      scope: "program#0",
      callee: "host_take",
      argument: 0,
      owner: "message",
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "persistent_unique_heap",
      runtime: "host_owned",
      reason: "unique_heap text transfers ownership to host/import host_take",
    },
  ]);
  assert_equals(proof.transfers, {
    transfers: [
      {
        id: "transfer#0",
        scope: "program#0",
        owner: "message",
        callee: "host_take",
        argument: 0,
      },
    ],
    issues: [],
  });

  const borrowed_transfer_host_call: CoreNode = {
    ...transfer_host_call,
    statements: [
      transfer_host_call.statements[0]!,
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "host_take" },
          args: [
            {
              tag: "borrow",
              value: { tag: "var", name: "message" },
            },
          ],
        },
      },
    ],
  };

  assert_throws(
    () => Core.check_proof(borrowed_transfer_host_call),
    "ownership-transfer host/import contract cannot accept borrow_view over " +
      "unique_heap text",
  );

  const use_after_transfer_host_call: CoreNode = {
    ...transfer_host_call,
    statements: [
      transfer_host_call.statements[0]!,
      transfer_host_call.statements[1]!,
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "len" },
          args: [{ tag: "var", name: "message" }],
        },
      },
    ],
  };
  const use_after_transfer_proof = Core.proof(use_after_transfer_host_call);

  assert_equals(use_after_transfer_proof.ok, false);
  assert_equals(use_after_transfer_proof.transfers.issues, [
    {
      tag: "use_after_transfer",
      owner: "message",
      transfer: {
        id: "transfer#0",
        scope: "program#0",
        owner: "message",
        callee: "host_take",
        argument: 0,
      },
      use: "value use",
      message: "Use of transferred owner message after host/import transfer " +
        "transfer#0 to host_take",
    },
  ]);
  assert_throws(
    () => Core.check_proof(use_after_transfer_host_call),
    "Use of transferred owner message after host/import transfer transfer#0 " +
      "to host_take",
  );
  assert_throws(
    () => Emit.emit(Core, use_after_transfer_host_call),
    "Use of transferred owner message after host/import transfer transfer#0 " +
      "to host_take",
  );

  const wrapper_transfer_host_call = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
let message: Text = append("a", "b")
send(message)
`));
  const wrapper_transfer_proof = Core.proof(wrapper_transfer_host_call);

  assert_equals(wrapper_transfer_proof.ok, true);
  assert_equals(wrapper_transfer_proof.transfers, {
    transfers: [
      {
        id: "transfer#0",
        scope: "program#0/static_call/send",
        owner: "message",
        callee: "host_take",
        argument: 0,
      },
    ],
    issues: [],
  });
  assert_equals(wrapper_transfer_proof.drops.steps, [
    {
      tag: "host_transfer",
      id: "transfer#0",
      edge: "host_transfer",
      scope: "program#0/static_call/send",
      callee: "host_take",
      argument: 0,
      owner: "message",
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "persistent_unique_heap",
      runtime: "host_owned",
      reason: "unique_heap text transfers ownership to host/import host_take",
    },
  ]);
  Core.check_proof(wrapper_transfer_host_call);

  const temporary_wrapper_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
send(append("a", "b"))
`));
  const temporary_wrapper_transfer_proof = Core.proof(
    temporary_wrapper_transfer,
  );

  assert_equals(temporary_wrapper_transfer_proof.ok, true);
  assert_equals(temporary_wrapper_transfer_proof.transfers, {
    transfers: [
      {
        id: "transfer#0",
        scope: "program#0/static_call/send",
        owner: "temporary#0",
        callee: "host_take",
        argument: 0,
      },
    ],
    issues: [],
  });
  assert_equals(temporary_wrapper_transfer_proof.drops.steps, [
    {
      tag: "host_transfer",
      id: "transfer#0",
      edge: "host_transfer",
      scope: "program#0/static_call/send",
      callee: "host_take",
      argument: 0,
      owner: undefined,
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "persistent_unique_heap",
      runtime: "host_owned",
      reason: "unique_heap text transfers ownership to host/import host_take",
    },
  ]);
  Core.check_proof(temporary_wrapper_transfer);

  const expression_temporary_wrapper_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = (msg: Text) => host_take(append(msg, "!"))
let message: Text = append("a", "b")
send(message)
`));
  const expression_temporary_wrapper_transfer_proof = Core.proof(
    expression_temporary_wrapper_transfer,
  );

  assert_equals(expression_temporary_wrapper_transfer_proof.ok, true);
  assert_equals(
    expression_temporary_wrapper_transfer_proof.drops.steps
      .filter((step) => step.tag === "host_transfer")
      .map((step) => {
        return {
          id: step.id,
          scope: step.scope,
          callee: step.callee,
          argument: step.argument,
          owner: step.owner,
          ownership: step.ownership,
        };
      }),
    [
      {
        id: "transfer#0",
        scope: "closure#0",
        callee: "host_take",
        argument: 0,
        owner: undefined,
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
      {
        id: "transfer#1",
        scope: "program#0/static_call/send",
        callee: "host_take",
        argument: 0,
        owner: undefined,
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
    ],
  );
  Core.check_proof(expression_temporary_wrapper_transfer);

  const branch_temporary_wrapper_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
let flag = 1
send(if flag { append("a", "b") } else { append("c", "d") })
`));
  const branch_temporary_wrapper_transfer_proof = Core.proof(
    branch_temporary_wrapper_transfer,
  );

  assert_equals(branch_temporary_wrapper_transfer_proof.ok, true);
  assert_equals(branch_temporary_wrapper_transfer_proof.transfers, {
    transfers: [
      {
        id: "transfer#0",
        scope: "program#0/static_call/send",
        owner: "temporary#0",
        callee: "host_take",
        argument: 0,
      },
    ],
    issues: [],
  });
  assert_equals(branch_temporary_wrapper_transfer_proof.drops.steps, [
    {
      tag: "host_transfer",
      id: "transfer#0",
      edge: "host_transfer",
      scope: "program#0/static_call/send",
      callee: "host_take",
      argument: 0,
      owner: undefined,
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "persistent_unique_heap",
      runtime: "host_owned",
      reason: "unique_heap text transfers ownership to host/import host_take",
    },
  ]);
  Core.check_proof(branch_temporary_wrapper_transfer);

  const scalar_temporary_wrapper_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
send(1)
`));
  const scalar_temporary_wrapper_transfer_proof = Core.proof(
    scalar_temporary_wrapper_transfer,
  );

  assert_equals(scalar_temporary_wrapper_transfer_proof.ok, false);
  assert_equals(scalar_temporary_wrapper_transfer_proof.transfers.issues, [
    {
      tag: "invalid_static_transfer_argument",
      owner: "temporary#0",
      callee: "host_take",
      argument: 0,
      ownership: {
        tag: "scalar_local",
        type: "i32",
      },
      reason: "ownership-transfer wrapper argument temporary#0 must be " +
        "unique_heap, got scalar_local i32",
      message: "Rejected ownership-transfer wrapper argument temporary#0 " +
        "for host_take argument 0: ownership-transfer wrapper argument " +
        "temporary#0 must be unique_heap, got scalar_local i32",
    },
  ]);
  assert_throws(
    () => Core.check_proof(scalar_temporary_wrapper_transfer),
    "ownership-transfer wrapper argument temporary#0 must be unique_heap, " +
      "got scalar_local i32",
  );

  const scalar_named_wrapper_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
let value = 1
send(value)
`));
  const scalar_named_wrapper_transfer_proof = Core.proof(
    scalar_named_wrapper_transfer,
  );

  assert_equals(scalar_named_wrapper_transfer_proof.ok, false);
  assert_equals(scalar_named_wrapper_transfer_proof.transfers.issues, [
    {
      tag: "invalid_static_transfer_argument",
      owner: "value",
      callee: "host_take",
      argument: 0,
      ownership: {
        tag: "scalar_local",
        type: "i32",
      },
      reason: "ownership-transfer wrapper argument value must be " +
        "unique_heap, got scalar_local i32",
      message: "Rejected ownership-transfer wrapper argument value for " +
        "host_take argument 0: ownership-transfer wrapper argument value " +
        "must be unique_heap, got scalar_local i32",
    },
  ]);
  assert_throws(
    () => Core.check_proof(scalar_named_wrapper_transfer),
    "ownership-transfer wrapper argument value must be unique_heap, got " +
      "scalar_local i32",
  );

  const wrapper_use_after_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
let message: Text = append("a", "b")
send(message)
len(message)
`));
  const wrapper_use_after_transfer_proof = Core.proof(
    wrapper_use_after_transfer,
  );

  assert_equals(wrapper_use_after_transfer_proof.ok, false);
  assert_equals(wrapper_use_after_transfer_proof.transfers.issues, [
    {
      tag: "use_after_transfer",
      owner: "message",
      transfer: {
        id: "transfer#0",
        scope: "program#0/static_call/send",
        owner: "message",
        callee: "host_take",
        argument: 0,
      },
      use: "value use",
      message: "Use of transferred owner message after host/import transfer " +
        "transfer#0 to host_take",
    },
  ]);
  assert_throws(
    () => Core.check_proof(wrapper_use_after_transfer),
    "Use of transferred owner message after host/import transfer transfer#0 " +
      "to host_take",
  );

  const higher_order_wrapper_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
let relay = (const f, msg) => f(msg)
let message: Text = append("a", "b")
relay(send, message)
`));
  const higher_order_wrapper_transfer_proof = Core.proof(
    higher_order_wrapper_transfer,
  );

  assert_equals(higher_order_wrapper_transfer_proof.ok, true);
  assert_equals(higher_order_wrapper_transfer_proof.transfers, {
    transfers: [
      {
        id: "transfer#0",
        scope: "program#0/static_call/relay/static_call/f",
        owner: "message",
        callee: "host_take",
        argument: 0,
      },
    ],
    issues: [],
  });
  assert_equals(higher_order_wrapper_transfer_proof.drops.steps, [
    {
      tag: "host_transfer",
      id: "transfer#0",
      edge: "host_transfer",
      scope: "program#0/static_call/relay/static_call/f",
      callee: "host_take",
      argument: 0,
      owner: "message",
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "persistent_unique_heap",
      runtime: "host_owned",
      reason: "unique_heap text transfers ownership to host/import host_take",
    },
  ]);
  Core.check_proof(higher_order_wrapper_transfer);

  const higher_order_expression_temporary_wrapper_transfer = Source.core(
    Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = (msg: Text) => host_take(msg)
let relay = (const f, msg: Text) => f(append(msg, "!"))
let message: Text = append("a", "b")
relay(send, message)
`),
  );
  const higher_order_expression_temporary_wrapper_transfer_proof = Core.proof(
    higher_order_expression_temporary_wrapper_transfer,
  );

  assert_equals(
    higher_order_expression_temporary_wrapper_transfer_proof.ok,
    true,
  );
  assert_equals(
    higher_order_expression_temporary_wrapper_transfer_proof.transfers,
    {
      transfers: [
        {
          id: "transfer#0",
          scope: "program#0/static_call/relay/static_call/f",
          owner: "temporary#0",
          callee: "host_take",
          argument: 0,
        },
      ],
      issues: [],
    },
  );
  assert_equals(
    higher_order_expression_temporary_wrapper_transfer_proof.drops.steps
      .filter((step) => step.tag === "host_transfer"),
    [
      {
        tag: "host_transfer",
        id: "transfer#0",
        edge: "host_transfer",
        scope: "program#0/static_call/relay/static_call/f",
        callee: "host_take",
        argument: 0,
        owner: undefined,
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        storage: "persistent_unique_heap",
        runtime: "host_owned",
        reason: "unique_heap text transfers ownership to host/import host_take",
      },
    ],
  );
  Core.check_proof(higher_order_expression_temporary_wrapper_transfer);

  const higher_order_wrapper_use_after_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
let relay = (const f, msg) => f(msg)
let message: Text = append("a", "b")
relay(send, message)
len(message)
`));
  assert_throws(
    () => Core.check_proof(higher_order_wrapper_use_after_transfer),
    "Use of transferred owner message after host/import transfer transfer#0 " +
      "to host_take",
  );

  const higher_order_alias_wrapper_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
let relay = (const f, msg) => {
  let g = f
  g(msg)
}
let message: Text = append("a", "b")
relay(send, message)
0
`));
  const higher_order_alias_wrapper_transfer_proof = Core.proof(
    higher_order_alias_wrapper_transfer,
  );

  assert_equals(higher_order_alias_wrapper_transfer_proof.ok, true);
  assert_equals(
    higher_order_alias_wrapper_transfer_proof.transfers.transfers,
    [
      {
        id: "transfer#0",
        scope: "program#0/static_call/relay/block/static_call/g",
        owner: "message",
        callee: "host_take",
        argument: 0,
      },
    ],
  );
  assert_equals(higher_order_alias_wrapper_transfer_proof.drops.steps, [
    {
      tag: "host_transfer",
      id: "transfer#0",
      edge: "host_transfer",
      scope: "program#0/static_call/relay/block/static_call/g",
      callee: "host_take",
      argument: 0,
      owner: "message",
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "persistent_unique_heap",
      runtime: "host_owned",
      reason: "unique_heap text transfers ownership to host/import host_take",
    },
  ]);
  assert_includes(
    Emit.emit(Mod, Core.mod(higher_order_alias_wrapper_transfer)),
    "call $host_take",
  );

  const branch_higher_order_alias_temporary_wrapper_transfer = Source.core(
    Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = (msg: Text) => host_take(msg)
let flag = 1
let relay = if flag {
  (const f, msg: Text) => {
    let g = f
    g(append(msg, "!"))
  }
} else {
  (const f, msg: Text) => {
    let g = f
    g(append(msg, "?"))
  }
}
let message: Text = append("a", "b")
relay(send, message)
`),
  );
  const branch_higher_order_alias_temporary_wrapper_transfer_proof = Core.proof(
    branch_higher_order_alias_temporary_wrapper_transfer,
  );

  assert_equals(
    branch_higher_order_alias_temporary_wrapper_transfer_proof.ok,
    true,
  );
  assert_equals(
    branch_higher_order_alias_temporary_wrapper_transfer_proof.transfers
      .transfers,
    [
      {
        id: "transfer#0",
        scope: "program#0/static_call/relay/if_then/block/static_call/g",
        owner: "temporary#0",
        callee: "host_take",
        argument: 0,
      },
      {
        id: "transfer#1",
        scope: "program#0/static_call/relay/if_else/block/static_call/g",
        owner: "temporary#0",
        callee: "host_take",
        argument: 0,
      },
    ],
  );
  assert_equals(
    branch_higher_order_alias_temporary_wrapper_transfer_proof.drops.steps
      .filter((step) => step.tag === "host_transfer"),
    [
      {
        tag: "host_transfer",
        id: "transfer#0",
        edge: "host_transfer",
        scope: "program#0/static_call/relay/if_then/block/static_call/g",
        callee: "host_take",
        argument: 0,
        owner: undefined,
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        storage: "persistent_unique_heap",
        runtime: "host_owned",
        reason: "unique_heap text transfers ownership to host/import host_take",
      },
      {
        tag: "host_transfer",
        id: "transfer#1",
        edge: "host_transfer",
        scope: "program#0/static_call/relay/if_else/block/static_call/g",
        callee: "host_take",
        argument: 0,
        owner: undefined,
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        storage: "persistent_unique_heap",
        runtime: "host_owned",
        reason: "unique_heap text transfers ownership to host/import host_take",
      },
    ],
  );
  assert_includes(
    Emit.emit(
      Mod,
      Core.mod(branch_higher_order_alias_temporary_wrapper_transfer),
    ),
    "call $host_take",
  );

  const higher_order_alias_wrapper_use_after_transfer = Source.core(
    Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => host_take(msg)
let relay = (const f, msg) => {
  let g = f
  g(msg)
}
let message: Text = append("a", "b")
relay(send, message)
len(message)
`),
  );
  assert_throws(
    () => Core.check_proof(higher_order_alias_wrapper_use_after_transfer),
    "Use of transferred owner message after host/import transfer transfer#0 " +
      "to host_take",
  );

  const rec_wrapper_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = rec (msg: Text) => host_take(msg)
let message: Text = append("a", "b")
send(message)
`));
  const rec_wrapper_transfer_proof = Core.proof(rec_wrapper_transfer);

  assert_equals(rec_wrapper_transfer_proof.ok, true);
  assert_equals(rec_wrapper_transfer_proof.transfers, {
    transfers: [
      {
        id: "transfer#0",
        scope: "program#0/static_call/send",
        owner: "message",
        callee: "host_take",
        argument: 0,
      },
    ],
    issues: [],
  });
  assert_equals(rec_wrapper_transfer_proof.drops.steps, [
    {
      tag: "host_transfer",
      id: "transfer#0",
      edge: "host_transfer",
      scope: "program#0/static_call/send",
      callee: "host_take",
      argument: 0,
      owner: "message",
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "persistent_unique_heap",
      runtime: "host_owned",
      reason: "unique_heap text transfers ownership to host/import host_take",
    },
  ]);
  Core.check_proof(rec_wrapper_transfer);

  const rec_wrapper_use_after_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = rec (msg: Text) => host_take(msg)
let message: Text = append("a", "b")
send(message)
len(message)
`));
  assert_throws(
    () => Core.check_proof(rec_wrapper_use_after_transfer),
    "Use of transferred owner message after host/import transfer transfer#0 " +
      "to host_take",
  );

  const block_wrapper_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => {
  host_take(msg)
}
let message: Text = append("a", "b")
send(message)
`));
  const block_wrapper_transfer_proof = Core.proof(block_wrapper_transfer);

  assert_equals(block_wrapper_transfer_proof.ok, true);
  assert_equals(block_wrapper_transfer_proof.transfers.transfers, [
    {
      id: "transfer#0",
      scope: "program#0/static_call/send/block",
      owner: "message",
      callee: "host_take",
      argument: 0,
    },
  ]);
  assert_equals(block_wrapper_transfer_proof.drops.steps, [
    {
      tag: "host_transfer",
      id: "transfer#0",
      edge: "host_transfer",
      scope: "program#0/static_call/send/block",
      callee: "host_take",
      argument: 0,
      owner: "message",
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "persistent_unique_heap",
      runtime: "host_owned",
      reason: "unique_heap text transfers ownership to host/import host_take",
    },
  ]);
  Core.check_proof(block_wrapper_transfer);

  const block_wrapper_use_after_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => {
  host_take(msg)
}
let message: Text = append("a", "b")
send(message)
len(message)
`));
  assert_throws(
    () => Core.check_proof(block_wrapper_use_after_transfer),
    "Use of transferred owner message after host/import transfer transfer#0 " +
      "to host_take",
  );

  const multi_stmt_wrapper_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => {
  let code = host_take(msg)
  code
}
let message: Text = append("a", "b")
send(message)
`));
  const multi_stmt_wrapper_transfer_proof = Core.proof(
    multi_stmt_wrapper_transfer,
  );

  assert_equals(multi_stmt_wrapper_transfer_proof.ok, true);
  assert_equals(multi_stmt_wrapper_transfer_proof.transfers.transfers, [
    {
      id: "transfer#0",
      scope: "program#0/static_call/send/block",
      owner: "message",
      callee: "host_take",
      argument: 0,
    },
  ]);
  assert_equals(multi_stmt_wrapper_transfer_proof.drops.steps, [
    {
      tag: "host_transfer",
      id: "transfer#0",
      edge: "host_transfer",
      scope: "program#0/static_call/send/block",
      callee: "host_take",
      argument: 0,
      owner: "message",
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "persistent_unique_heap",
      runtime: "host_owned",
      reason: "unique_heap text transfers ownership to host/import host_take",
    },
  ]);
  Core.check_proof(multi_stmt_wrapper_transfer);

  const multi_stmt_wrapper_use_after_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let send = msg => {
  let code = host_take(msg)
  code
}
let message: Text = append("a", "b")
send(message)
len(message)
`));
  assert_throws(
    () => Core.check_proof(multi_stmt_wrapper_use_after_transfer),
    "Use of transferred owner message after host/import transfer transfer#0 " +
      "to host_take",
  );

  const branch_wrapper_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let flag = 1
let send = if flag {
  (msg: Text) => host_take(msg)
} else {
  (msg: Text) => host_take(msg)
}
let message: Text = append("a", "b")
send(message)
`));
  const branch_wrapper_transfer_proof = Core.proof(branch_wrapper_transfer);

  assert_equals(branch_wrapper_transfer_proof.ok, true);
  assert_equals(branch_wrapper_transfer_proof.transfers.transfers, [
    {
      id: "transfer#0",
      scope: "program#0/static_call/send/if_then",
      owner: "message",
      callee: "host_take",
      argument: 0,
    },
    {
      id: "transfer#1",
      scope: "program#0/static_call/send/if_else",
      owner: "message",
      callee: "host_take",
      argument: 0,
    },
  ]);
  assert_equals(
    branch_wrapper_transfer_proof.drops.steps
      .filter((step) => step.tag === "host_transfer"),
    [
      {
        tag: "host_transfer",
        id: "transfer#0",
        edge: "host_transfer",
        scope: "program#0/static_call/send/if_then",
        callee: "host_take",
        argument: 0,
        owner: "message",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        storage: "persistent_unique_heap",
        runtime: "host_owned",
        reason: "unique_heap text transfers ownership to host/import host_take",
      },
      {
        tag: "host_transfer",
        id: "transfer#1",
        edge: "host_transfer",
        scope: "program#0/static_call/send/if_else",
        callee: "host_take",
        argument: 0,
        owner: "message",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
        storage: "persistent_unique_heap",
        runtime: "host_owned",
        reason: "unique_heap text transfers ownership to host/import host_take",
      },
    ],
  );
  Core.check_proof(branch_wrapper_transfer);

  const branch_wrapper_use_after_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let flag = 1
let send = if flag {
  (msg: Text) => host_take(msg)
} else {
  (msg: Text) => host_take(msg)
}
let message: Text = append("a", "b")
send(message)
len(message)
`));
  assert_throws(
    () => Core.check_proof(branch_wrapper_use_after_transfer),
    "Use of transferred owner message after host/import transfer transfer#1 " +
      "to host_take",
  );

  const branch_local_wrapper_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let flag = 1
let message: Text = append("a", "b")
if flag {
  let send = msg => host_take(msg)
  send(message)
} else {
  host_take(message)
}
`));
  const branch_local_wrapper_transfer_proof = Core.proof(
    branch_local_wrapper_transfer,
  );

  assert_equals(branch_local_wrapper_transfer_proof.ok, true);
  assert_equals(branch_local_wrapper_transfer_proof.transfers.transfers, [
    {
      id: "transfer#0",
      scope: "program#0/if_then/block/static_call/send",
      owner: "message",
      callee: "host_take",
      argument: 0,
    },
    {
      id: "transfer#1",
      scope: "program#0/if_else/block",
      owner: "message",
      callee: "host_take",
      argument: 0,
    },
  ]);
  assert_equals(branch_local_wrapper_transfer_proof.drops.steps, [
    {
      tag: "host_transfer",
      id: "transfer#0",
      edge: "host_transfer",
      scope: "block#1/static_call/send",
      callee: "host_take",
      argument: 0,
      owner: "message",
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "persistent_unique_heap",
      runtime: "host_owned",
      reason: "unique_heap text transfers ownership to host/import host_take",
    },
    {
      tag: "host_transfer",
      id: "transfer#1",
      edge: "host_transfer",
      scope: "block#3",
      callee: "host_take",
      argument: 0,
      owner: "message",
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "persistent_unique_heap",
      runtime: "host_owned",
      reason: "unique_heap text transfers ownership to host/import host_take",
    },
  ]);
  Core.check_proof(branch_local_wrapper_transfer);

  const branch_local_wrapper_use_after_transfer = Source.core(Source.parse(`
host_import host_take from "env.take" (ownership_transfer Text) => I32

let flag = 1
let message: Text = append("a", "b")
if flag {
  let send = msg => host_take(msg)
  send(message)
} else {
  host_take(message)
}
len(message)
`));
  assert_throws(
    () => Core.check_proof(branch_local_wrapper_use_after_transfer),
    "Use of transferred owner message after host/import transfer transfer#1 " +
      "to host_take",
  );
});

Deno.test("Core.proof accepts host-returned owner contracts", () => {
  const host_returned_text: CoreNode = {
    tag: "program",
    host_imports: {
      host_make: {
        name: "host_make",
        module: "env",
        field: "make",
        params: [],
        result: "i32",
        args: [],
        result_owner: { tag: "unique_heap", reason: "text" },
      },
    },
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: "message",
        is_linear: false,
        annotation: "Text",
        value: {
          tag: "app",
          func: { tag: "var", name: "host_make" },
          args: [],
        },
      },
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "len" },
          args: [{ tag: "var", name: "message" }],
        },
      },
    ],
  };
  const proof = Core.proof(host_returned_text);

  assert_equals(Typed.type(Core, host_returned_text), "i32");
  assert_equals(proof.ok, true);
  assert_equals(proof.managed_storage, "disabled");
  assert_equals(proof.host_boundaries.edges, [
    {
      id: "host#0",
      callee: "host_make",
      signature: {
        name: "host_make",
        module: "env",
        field: "make",
        params: [],
        result: "i32",
        args: [],
        result_owner: { tag: "unique_heap", reason: "text" },
      },
      args: [],
      decision: {
        tag: "allowed",
        reason: "host/import signature for host_make satisfies ownership " +
          "boundary checks",
      },
    },
  ]);
  assert_equals(proof.drops.steps, [
    {
      tag: "heap_drop",
      id: "drop#0",
      edge: "scope_exit",
      scope: "program#0",
      owner: "message",
      ownership: {
        tag: "unique_heap",
        reason: "text",
      },
      storage: "persistent_unique_heap",
      runtime: "no_op_bump_allocator",
      reason: "unique_heap text scope exit lowers to no-op with bump allocator",
    },
  ]);

  const returned_owner: CoreNode = {
    tag: "program",
    host_imports: host_returned_text.host_imports,
    statements: [
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "host_make" },
          args: [],
        },
      },
    ],
  };
  const returned_owner_proof = Core.proof(returned_owner);

  assert_equals(returned_owner_proof.ok, true);
  assert_equals(returned_owner_proof.final_result, {
    edge: "final_result",
    escapes: true,
    storage: "persistent_unique_heap",
    ownership: {
      tag: "unique_heap",
      reason: "text",
    },
    decision: {
      tag: "allowed",
      reason: "unique_heap text escapes as the owned final result",
    },
  });
  assert_equals(returned_owner_proof.drops.steps, []);

  const invalid_owner_result: CoreNode = {
    tag: "program",
    host_imports: {
      host_make_wide: {
        name: "host_make_wide",
        module: "env",
        field: "make_wide",
        params: [],
        result: "i64",
        args: [],
        result_owner: { tag: "unique_heap", reason: "text" },
      },
    },
    statements: [
      {
        tag: "expr",
        expr: {
          tag: "app",
          func: { tag: "var", name: "host_make_wide" },
          args: [],
        },
      },
    ],
  };
  const invalid_owner_result_message =
    "Core host import host_make_wide owner result must use i32 pointer " +
    "representation";

  assert_equals(
    Core.proof(invalid_owner_result).issues.map((issue) => issue.message),
    [invalid_owner_result_message],
  );
  assert_throws(
    () => Core.check_proof(invalid_owner_result),
    invalid_owner_result_message,
  );
  assert_throws(
    () => Emit.emit(Core, invalid_owner_result),
    invalid_owner_result_message,
  );
  assert_throws(
    () => Core.mod(invalid_owner_result),
    invalid_owner_result_message,
  );
});
