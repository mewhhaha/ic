import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Core, type Core as CoreNode, type CoreExpr } from "../core.ts";
import { TestSource as Source } from "../frontend/test_source.ts";
import { Mod } from "../mod.ts";
import { Emit, Format, Typed } from "../trait.ts";

Deno.test("Core type sets accept raw shared scalar representations", () => {
  const raw_core: CoreNode = {
    tag: "program",
    statements: [
      {
        tag: "bind",
        kind: "const",
        name: "Scalar",
        is_linear: false,
        annotation: undefined,
        value: {
          tag: "union_type",
          cases: [
            {
              name: "set_0",
              type_name: "Bool",
              set_member: { tag: "name", name: "Bool" },
            },
            {
              name: "set_1",
              type_name: "I32",
              set_member: { tag: "name", name: "I32" },
            },
          ],
        },
      },
      {
        tag: "bind",
        kind: "let",
        name: "value",
        is_linear: false,
        annotation: "Scalar",
        value: { tag: "num", type: "i32", value: 1 },
      },
      { tag: "expr", expr: { tag: "var", name: "value" } },
    ],
  };

  assert_equals(Typed.type(Core, raw_core), "i32");
});

Deno.test("Core type sets preserve validated explicit scalar cases", () => {
  const core = Source.core(Source.parse(`
type Scalar = Bool | I32
let value: Scalar = 1
value
`));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(Format.fmt(Core, core), "let value: Scalar = .set_1(1:i32)");
});

Deno.test("Core.emit materializes runtime scalar Text and struct union values", () => {
  const direct_core = Source.core(Source.parse(`
type ResultType = | .ok = Int | .err = Int

let keep = "x"

ResultType.ok(41)
`));
  const direct_wat = Emit.emit(Mod, Core.mod(direct_core));

  assert_equals(Typed.type(Core, direct_core), "i32");
  assert_includes(
    direct_wat,
    "(global $__closure_heap (mut i32) (i32.const 0))",
  );
  assert_includes(direct_wat, "(local $_union#0 i32)");
  assert_includes(direct_wat, "i32.const 0");
  assert_includes(direct_wat, "i32.const 41");
  assert_includes(direct_wat, "i32.store offset=4");

  const scratch_union_core = Source.core(Source.parse(`
type ResultType = | .ok = Int | .err = Int

let flag = 1

scratch {
  if flag {
    ResultType.ok(41)
  } else {
    ResultType.err(5)
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
type ResultType = | .ok = Int | .err = Int

let keep = "x"
let flag = 0

if flag {
  ResultType.ok(41)
} else {
  ResultType.err(7)
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
type ResultType = | .ok = I64 | .err

let keep = "x"

ResultType.ok(41i64)
`));
  const wide_wat = Emit.emit(Mod, Core.mod(wide_core));

  assert_equals(Typed.type(Core, wide_core), "i32");
  assert_includes(wide_wat, "i32.const 16");
  assert_includes(wide_wat, "i64.const 41");
  assert_includes(wide_wat, "i64.store offset=4");

  const text_core = Source.core(Source.parse(`
type ResultType = | .ok = Text | .err

let keep = "x"

ResultType.ok("Ada")
`));
  const text_wat = Emit.emit(Mod, Core.mod(text_core));

  assert_equals(Typed.type(Core, text_core), "i32");
  assert_includes(text_wat, "i32.store offset=4");

  const struct_core = Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let keep = "x"

ResultType.ok([.age = 40, .score = 2] as user_type)
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let user: user_type = [.age = 40, .score = 2] as user_type
let result: ResultType = ResultType.ok(user)

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
      owner: "user",
      ownership: {
        tag: "unique_heap",
        reason: "runtime_aggregate",
      },
      storage: "persistent_unique_heap",
      runtime: "reusable_free_list_allocator",
      allocation_id: "allocation#0",
      byte_size: {
        tag: "runtime",
        formula: "aligned_field_layout_size",
      },
      alignment: 8,
      layout: "runtime_aggregate.aligned_fields",
      reason:
        "unique_heap runtime_aggregate scope exit lowers to __free with " +
        "reusable allocator",
    },
  ]);
  assert_includes(aggregate_payload_wat, "(local $found i32)");
  assert_includes(aggregate_payload_wat, "local.set $found");
  assert_includes(aggregate_payload_wat, "local.get $found");
  assert_includes(aggregate_payload_wat, "i32.load offset=0");
  assert_includes(aggregate_payload_wat, "i32.load offset=4");

  const use_after_payload_transfer = Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let user: user_type = [.age = 40, .score = 2] as user_type
let result: ResultType = ResultType.ok(user)
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let flag = 1
let user: user_type = [.age = flag, .score = 2] as user_type
let result: ResultType = ResultType.err()
if flag {
  result = ResultType.ok(user)
} else {
  result = ResultType.ok(user)
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let flag = 1
let user: user_type = [.age = flag, .score = 2] as user_type
let result: ResultType = ResultType.err()
if flag {
  result = ResultType.ok(user)
} else {
  result = ResultType.ok(user)
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let flag = 1
let user: user_type = [.age = flag, .score = 2] as user_type
let result: ResultType = ResultType.err()
if flag {
  result = ResultType.ok(user)
} else {
  result = ResultType.err()
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
  const one_sided_branch_assignment_payload_transfer_wat = Emit.emit(
    Mod,
    Core.mod(one_sided_branch_assignment_payload_transfer),
  );

  assert_equals(one_sided_branch_assignment_payload_transfer_proof.ok, true);
  assert_equals(
    one_sided_branch_assignment_payload_transfer_proof.transfers,
    {
      transfers: [
        {
          id: "transfer#0",
          scope: "program#0/if_then",
          owner: "user",
          callee: "union_case.ok",
          argument: 0,
        },
      ],
      issues: [],
    },
  );
  assert_equals(
    one_sided_branch_assignment_payload_transfer_proof.cleanup_rows.filter(
      (row) => {
        return row.tag === "heap_drop" &&
          row.edge === "conditional_cleanup";
      },
    ),
    [
      {
        tag: "heap_drop",
        id: "drop#4",
        edge: "conditional_cleanup",
        scope: "program#0/if_else",
        owner: "user",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        storage: "persistent_unique_heap",
        runtime: "reusable_free_list_allocator",
        allocation_id: "allocation#0",
        byte_size: {
          tag: "runtime",
          formula: "aligned_field_layout_size",
        },
        alignment: 8,
        layout: "runtime_aggregate.aligned_fields",
        reason: "unique_heap runtime_aggregate conditional retained-path " +
          "cleanup lowers to __free with reusable allocator",
      },
    ],
  );
  assert_includes(one_sided_branch_assignment_payload_transfer_wat, "if");
  assert_includes(
    one_sided_branch_assignment_payload_transfer_wat,
    "i32.store offset=4",
  );

  const one_sided_payload_use_after = Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .age= Int, .score= Int }
type ResultType = | .ok = user_type | .err
let flag = 1
let user: user_type = [.age = flag, .score = 2] as user_type
let result: ResultType = ResultType.err()
if flag {
  result = ResultType.ok(user)
} else {
  result = ResultType.err()
}
user.age
`));
  const one_sided_payload_use_after_proof = Core.proof(
    one_sided_payload_use_after,
  );
  assert_equals(one_sided_payload_use_after_proof.ok, false);
  assert_equals(
    one_sided_payload_use_after_proof.transfers.issues[0]?.tag,
    "use_after_transfer",
  );
  assert_throws(
    () => Core.check_proof(one_sided_payload_use_after),
    "Use of transferred owner user after ownership transfer transfer#0 to " +
      "union_case.ok",
  );

  const loop_payload_transfer = Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let xs = [.first = 1]
let user: user_type = [.age = 40, .score = 2] as user_type
let result: ResultType = ResultType.err()
for x in xs {
  result = ResultType.ok(user)
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

  const single_exit_loop_payload_transfer = Source.core(Source.parse(`
host_import loop_limit from "env.limit" () => I32

const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .age= Int }
type ResultType = | .ok = user_type | .err
let limit = loop_limit()
let user: user_type = [.age = 40] as user_type
for index in 0..limit {
  ResultType.ok(user)
  break
}
limit
`));
  const single_exit_loop_payload_transfer_proof = Core.proof(
    single_exit_loop_payload_transfer,
  );
  const single_exit_loop_payload_transfer_wat = Emit.emit(
    Mod,
    Core.mod(single_exit_loop_payload_transfer),
  );

  assert_equals(single_exit_loop_payload_transfer_proof.ok, true);
  assert_equals(single_exit_loop_payload_transfer_proof.transfers, {
    transfers: [
      {
        id: "transfer#0",
        scope: "program#0/loop",
        owner: "user",
        callee: "union_case.ok",
        argument: 0,
      },
    ],
    issues: [],
  });
  assert_equals(
    single_exit_loop_payload_transfer_proof.cleanup_rows.filter((row) => {
      return row.tag === "heap_drop" &&
        row.edge === "loop_zero_iteration_cleanup";
    }),
    [
      {
        tag: "heap_drop",
        id: "drop#2",
        edge: "loop_zero_iteration_cleanup",
        scope: "program#0/loop_zero_iteration",
        owner: "user",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        storage: "persistent_unique_heap",
        runtime: "reusable_free_list_allocator",
        allocation_id: "allocation#0",
        byte_size: {
          tag: "runtime",
          formula: "aligned_field_layout_size",
        },
        alignment: 8,
        layout: "runtime_aggregate.aligned_fields",
        reason: "unique_heap runtime_aggregate loop zero-iteration cleanup " +
          "lowers to __free with reusable allocator",
      },
    ],
  );
  assert_includes(single_exit_loop_payload_transfer_wat, "loop $range_loop_");
  assert_includes(single_exit_loop_payload_transfer_wat, "br $range_exit_");
  assert_includes(single_exit_loop_payload_transfer_wat, "i32.store offset=4");

  const single_exit_loop_use_after = Source.core(Source.parse(`
host_import loop_limit from "env.limit" () => I32
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .age= Int }
type ResultType = | .ok = user_type | .err
let limit = loop_limit()
let user: user_type = [.age = 40] as user_type
for index in 0..limit {
  ResultType.ok(user)
  break
}
user.age
`));
  const single_exit_loop_use_after_proof = Core.proof(
    single_exit_loop_use_after,
  );
  assert_equals(single_exit_loop_use_after_proof.ok, false);
  assert_equals(
    single_exit_loop_use_after_proof.transfers.issues[0]?.tag,
    "use_after_transfer",
  );
  assert_throws(
    () => Core.check_proof(single_exit_loop_use_after),
    "Use of transferred owner user after ownership transfer transfer#0 to " +
      "union_case.ok",
  );

  const alias_payload_transfer = Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let user: user_type = [.age = 40, .score = 2] as user_type
let alias: user_type = user
let result: ResultType = ResultType.ok(alias)

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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let user: user_type = [.age = 40, .score = 2] as user_type
let alias: user_type = user
let result: ResultType = ResultType.ok(alias)
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let wrap = (payload: user_type) => ResultType.ok(payload)
let user: user_type = [.age = 40, .score = 2] as user_type
let result: ResultType = wrap(user)

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
      owner: undefined,
      ownership: {
        tag: "unique_heap",
        reason: "runtime_aggregate",
      },
      storage: "persistent_unique_heap",
      runtime: "reusable_free_list_allocator",
      allocation_ids: ["allocation#0", "allocation#1"],
      byte_size: {
        tag: "runtime",
        formula: "aligned_field_layout_size",
      },
      alignment: 8,
      layout: "runtime_aggregate.aligned_fields",
      reason: "unique_heap runtime_aggregate scope exit lowers to __free " +
        "with reusable allocator",
    },
  ]);
  assert_includes(wrapper_payload_transfer_wat, "(local $found i32)");
  assert_includes(wrapper_payload_transfer_wat, "call $__free");

  const wrapper_payload_transfer_use_after = Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let wrap = (payload: user_type) => ResultType.ok(payload)
let user: user_type = [.age = 40, .score = 2] as user_type
let result: ResultType = wrap(user)
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let flag = 1
let wrap = if flag {
  (payload: user_type) => ResultType.ok(payload)
} else {
  (payload: user_type) => ResultType.ok(payload)
}
let user: user_type = [.age = 40, .score = 2] as user_type
let result: ResultType = wrap(user)

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
      runtime: "reusable_free_list_allocator",
      allocation_ids: ["allocation#0", "allocation#2"],
      byte_size: {
        tag: "runtime",
        formula: "4 + aligned_payload_size",
      },
      alignment: 4,
      layout: "runtime_union.tag_and_aligned_payload",
      owned_children: [
        {
          allocation_ids: ["allocation#1", "allocation#3"],
          offset: 4,
          ownership: {
            tag: "unique_heap",
            reason: "runtime_aggregate",
          },
          layout: "runtime_aggregate.aligned_fields",
        },
      ],
      reason: "unique_heap runtime_union scope exit lowers to __free with " +
        "reusable allocator",
    },
  ]);
  assert_includes(branch_wrapper_payload_transfer_wat, "if (result i32)");
  assert_includes(branch_wrapper_payload_transfer_wat, "i32.add");
  assert_includes(branch_wrapper_payload_transfer_wat, "call $__free");

  const branch_wrapper_payload_transfer_use_after = Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let flag = 1
let wrap = if flag {
  (payload: user_type) => ResultType.ok(payload)
} else {
  (payload: user_type) => ResultType.ok(payload)
}
let user: user_type = [.age = 40, .score = 2] as user_type
let result: ResultType = wrap(user)
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let flag = 1
let wrap = if flag {
  (payload: user_type) => ResultType.ok(payload)
} else {
  (payload: user_type) => ResultType.ok(payload)
}
let user: user_type = [.age = 40, .score = 2] as user_type
let alias: user_type = user
let result: ResultType = wrap(alias)
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let wrap = (payload: user_type) => ResultType.ok(payload)
let relay = (const f, payload: user_type) => {
  let g = f
  g(payload)
}
let user: user_type = [.age = 40, .score = 2] as user_type
let result: ResultType = relay(wrap, user)

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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let wrap = (payload: user_type) => ResultType.ok(payload)
let relay = (const f, payload: user_type) => {
  let g = f
  g(payload)
}
let user: user_type = [.age = 40, .score = 2] as user_type
let result: ResultType = relay(wrap, user)
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let wrap = (payload: user_type) => ResultType.ok(payload)
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
let user: user_type = [.age = 40, .score = 2] as user_type
let result: ResultType = relay(wrap, user)

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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err

let wrap = (payload: user_type) => ResultType.ok(payload)
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
let user: user_type = [.age = 40, .score = 2] as user_type
let result: ResultType = relay(wrap, user)
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

Deno.test("Core annotates shorthand aggregate payloads in dynamic union branches", () => {
  const core = Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err
const result_type = ResultType

let flag = 1
let result: result_type = if flag {
  result_type.ok([.age = 40, .score = 2])
} else {
  result_type.err()
}

if let .ok(user) = result {
  user.age + user.score
} else {
  0
}
`));

  Core.check_proof(core);
  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(Emit.emit(Mod, Core.mod(core)), "local.set $user");
});

Deno.test("Core shares frozen runtime aggregate union payloads", () => {
  const shared_payload = Source.core(Source.parse(`
host_import host_seed from "env.seed" () => I32

const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | .ok = user_type | .err
const result_type = ResultType

let seed = host_seed()
let user: user_type = [.age = seed, .score = 2] as user_type
let shared: user_type = freeze user
let result: result_type = result_type.ok(shared)
let payload_total = if let .ok(found) = result {
  found.age + found.score
} else {
  0
}

payload_total + shared.age
`));
  const shared_payload_proof = Core.proof(shared_payload);
  const shared_payload_wat = Emit.emit(Mod, Core.mod(shared_payload));

  assert_equals(shared_payload_proof.ok, true);
  assert_equals(shared_payload_proof.transfers, {
    transfers: [],
    issues: [],
  });
  assert_equals(
    shared_payload_proof.freeze_edges.map((edge) => edge.analysis),
    [
      {
        edge: "freeze",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        storage: "persistent_unique_heap",
        escapes: true,
        decision: {
          tag: "allowed",
          reason: "freeze of unique_heap runtime_aggregate consumes the " +
            "owned buffer as immutable shareable storage",
        },
      },
    ],
  );
  assert_includes(shared_payload_wat, "local.get $_aggregate#");
  assert_includes(shared_payload_wat, "local.set $_payload_ok#");
  assert_includes(shared_payload_wat, "local.set $found");
  assert_includes(shared_payload_wat, "i32.load offset=0");
  assert_includes(shared_payload_wat, "i32.load offset=4");

  const borrowed_payload = Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}
type ResultType = | .ok = user_type | .err
const result_type = ResultType

let user: user_type = [.age = 1] as user_type
let result: result_type = result_type.ok(&user)
if let .ok(found) = result {
  found.age
} else {
  0
}
`));
  const borrowed_payload_proof = Core.proof(borrowed_payload);

  assert_equals(borrowed_payload_proof.ok, false);
  assert_equals(borrowed_payload_proof.transfers.issues, [
    {
      tag: "invalid_union_payload_ownership",
      owner: undefined,
      callee: "union_case.ok",
      ownership: {
        tag: "borrow_view",
        source: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
      },
      message: "Runtime union payload for union_case.ok has borrow_view " +
        "ownership without move or freeze/promotion facts",
    },
  ]);
  assert_throws(
    () => Core.check_proof(borrowed_payload),
    "Runtime union payload for union_case.ok has borrow_view ownership " +
      "without move or freeze/promotion facts",
  );
  assert_throws(
    () => Core.mod(borrowed_payload),
    "Runtime union payload for union_case.ok has borrow_view ownership " +
      "without move or freeze/promotion facts",
  );
});

Deno.test("Core.emit materializes runtime aggregate values", () => {
  const core = Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .score= I64,
  .name= Text
}

let user: user_type = [.age = 41, .score = 9i64, .name = "Ada"] as user_type

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
const { struct } = comptime (import "duck:prelude")()
const pair_type = struct {
  .age= Int,
  .score= Int
}

let age = 41
let pair: pair_type = [.age = age, .score = 2] as pair_type
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = 1
let make = if flag {
  (name: Text) => [.name = name, .age = 40] as user_type
} else {
  (name: Text) => [.name = name, .age = 5] as user_type
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = 1
let make = if flag {
  (name: Text) => [.name = name, .age = 40] as user_type
} else {
  (name: Text) => [.name = name, .age = 5] as user_type
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = 1
let make = if flag {
  (name: Text) => [.name = name, .age = 40] as user_type
} else {
  (name: Text) => [.name = name, .age = 5] as user_type
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = 1
let make = if flag {
  (name: Text) => [.name = name, .age = 40] as user_type
} else {
  (name: Text) => [.name = name, .age = 5] as user_type
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
const { struct } = comptime (import "duck:prelude")()
const name_type = struct {
  .first= Text,
  .last= Text
}
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .name= name_type
}

let flag = 1
let make = if flag {
  (first: Text) => [.age = 40, .name = [.first = first, .last = "Lovelace"] as name_type] as user_type
} else {
  (first: Text) => [.age = 5, .name = [.first = first, .last = "Hopper"] as name_type] as user_type
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = 1
let make = if flag {
  (name: Text) => [.name = name, .age = 41] as user_type
} else {
  (name: Text) => [.name = name, .age = 5] as user_type
}
let user: user_type = make("Ada")
let frozen_user: user_type = freeze user
let get_age = if flag {
  () => frozen_user.age
} else {
  () => frozen_user.age + 1
}

get_age()
`));
  const captured_pointer_wat = Emit.emit(
    Mod,
    Core.mod(captured_pointer_core),
  );

  assert_equals(Typed.type(Core, captured_pointer_core), "i32");
  assert_includes(captured_pointer_wat, "(local $user i32)");
  assert_includes(
    captured_pointer_wat,
    "(local $__capture_2_frozen_user i32)",
  );
  assert_includes(captured_pointer_wat, "local.get $user");
  assert_includes(captured_pointer_wat, "i32.store offset=4");
  assert_includes(
    captured_pointer_wat,
    "local.set $__capture_2_frozen_user",
  );
  assert_includes(
    captured_pointer_wat,
    "local.get $__capture_2_frozen_user",
  );
  assert_includes(captured_pointer_wat, "i32.load offset=4");

  const scratch_aggregate_core = Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .name= Text
}
let flag = 1
let f = if flag {
  (x: Int) => x
} else {
  (x: Int) => x + 1
}

scratch {
  [.age = 41, .name = "Ada"] as user_type
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
    "(global $__scratch_heap (mut i32) (i32.const 8))",
  );
  assert_includes(scratch_aggregate_wat, "global.get $__scratch_heap");
  assert_includes(scratch_aggregate_wat, "local.set $_aggregate#2");
  assert_includes(scratch_aggregate_wat, "global.set $__scratch_heap");
  assert_includes(scratch_aggregate_wat, "local.get $_aggregate#2");
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .name= Text
}

scratch {
  [.age = 41, .name = "Ada"] as user_type
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

Deno.test("Core materializes annotated shorthand union assignments", () => {
  const core = Source.core(Source.parse(`
type ResultType = | .ok = Text | .err
const result_type = ResultType

let result: result_type = .ok("Ada")
result = .ok("Grace")

if let .ok(value) = result {
  len(value)
} else {
  0
}
`));
  const proof = Core.proof(core);
  const wat = Emit.emit(Mod, Core.mod(core));
  const union_allocations = proof.allocations.facts.filter((fact) => {
    return fact.reason === "runtime_union";
  });

  assert_equals(proof.ok, true);
  assert_equals(
    union_allocations.map((fact) => fact.allocation_id),
    ["allocation#0", "allocation#1"],
  );
  assert_equals(
    proof.drops.steps.map((step) => step.allocation_id),
    ["allocation#0", "allocation#1"],
  );
  assert_includes(wat, "call $__alloc");
  assert_includes(wat, "call $__free");
});

Deno.test("Core.emit matches stored runtime scalar Text and struct union pointers", () => {
  const core = Source.core(Source.parse(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

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
type ResultType = | .ok = Text | .err
const result_type = ResultType

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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= Int
}
type ResultType = | .ok = user_type | .err
const result_type = ResultType

let flag = 1
let make = if flag {
  (name: Text) => result_type.ok([.name = name, .age = 40] as user_type)
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
type ResultType = | .ok = user_type | .err
const result_type = ResultType

let flag = 1
let make = if flag {
  (first: Text) => result_type.ok([.name = [.first = first, .last = "Lovelace"] as name_type, .age = 40] as user_type)
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
type InnerType = | .some = Int | .none
const inner_type = InnerType
type OuterType = | .ok = inner_type | .err
const outer_type = OuterType

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
type InnerType = | .some = Int | .none
const inner_type = InnerType
const { struct } = comptime (import "duck:prelude")()
const box_type = struct {
  .inner= inner_type,
  .bonus= Int
}
type ResultType = | .ok = box_type | .err
const result_type = ResultType

let flag = 1
let make = if flag {
  (value: Int) => result_type.ok([.inner = inner_type.some(value), .bonus = 1] as box_type)
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
const { struct } = comptime (import "duck:prelude")()
const pair_type = struct {
  .first= Int,
  .second= Int
}

const sum_pair = (pair: pair_type) => {
  pair.first + pair.second
}

sum_pair([.first = 40, .second = 2])
`));

  assert_equals(Typed.type(Core, struct_core), "i32");
  assert_equals(
    Emit.emit(Core, struct_core).trim(),
    "i32.const 40\ni32.const 2\ni32.add",
  );

  const union_core = Source.core(Source.parse(`
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType

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
const { struct } = comptime (import "duck:prelude")()
const pair_type = struct {
  .first= Int,
  .second= Int
}

const sum_pair = (pair: pair_type) => {
  pair.first + pair.second
}

sum_pair([.first = 40])
`)),
      ),
    "Missing core struct field: second",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
type ResultType = | .ok = Int
const result_type = ResultType

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
type OptionType t = | .some = t | .none
const option_type = OptionType

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
type OptionType t = | .some = t | .none
const option_type = OptionType

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
type ResultType e t = | .ok = t | .err = e
const result_type = ResultType

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
type OptionType t = | .some = t | .none
const option_type = OptionType

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

Deno.test("Core resolves type values stored in extension fields", () => {
  const source = `
const { struct } = comptime (import "duck:prelude")()
const add_args_type = struct { .left = Int, .right = Int }
type NumberCalcType = | .literal = Int | .add = add_args_type
type TextCalcType = | .literal = Text

const calc_types = 0
const calc_types = calc_types with {
  .number = NumberCalcType,
  .text = TextCalcType
}

const number_calc_type = calc_types.number
const text_calc_type = calc_types.text

let expression = number_calc_type.add(
  [.left = 20, .right = 22] as add_args_type
)

if let .add(args) = expression {
  args.left + args.right
} else {
  0
}
`;
  const core = Source.core(Source.parse(source));

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(Emit.emit(Core, core), "i32.add");

  assert_throws(
    () =>
      Source.wat(`
const { struct } = comptime (import "duck:prelude")()
const add_args_type = struct { .left = Int, .right = Int }
type NumberCalcType = | .literal = Int | .add = add_args_type
type TextCalcType = | .literal = Text

const calc_types = 0
const calc_types = calc_types with {
  .number = NumberCalcType,
  .text = TextCalcType
}

const text_calc_type = calc_types.text
text_calc_type.add([.left = 20, .right = 22] as add_args_type)
`),
    "Missing union case: add",
  );
});

Deno.test("Core.emit elides type-level consts and type checks", () => {
  const core = Source.core(Source.parse(`
const int_type = Int

const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text,
  .age= int_type
}

const alias_type = user_type

let struct { .age= int_type, .. } = alias_type

41
`));

  const wat = Emit.emit(Core, core);

  assert_equals(Typed.type(Core, core), "i32");
  assert_includes(Format.fmt(Core, core), "type_check struct alias_type");
  assert_includes(wat, "i32.const 41");

  const union_core = Source.core(Source.parse(`
type ResultType = | .ok = Int | .err = Text
const result_type = ResultType

let union { .ok= Int, .. } = result_type

41
`));

  assert_equals(Typed.type(Core, union_core), "i32");
  assert_includes(Emit.emit(Core, union_core), "i32.const 41");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int
}

let struct { .name= Text, .. } = user_type

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
type ResultType = | .ok = Int
const result_type = ResultType

let struct { .ok= Int, .. } = result_type

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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .age= Int,
  .name= Text
}

let struct { .age= Int } = user_type

41
`)),
      ),
    "Struct pattern does not allow extra fields",
  );
});

Deno.test("Source.core rejects unbound structured values before proof", () => {
  const fixtures = [
    { source: "missing.field", name: "missing" },
    { source: "missing[0]", name: "missing" },
    { source: "missing(1)", name: "missing" },
    { source: "for value in missing { value }\n0", name: "missing" },
    {
      source: "if let .ok(value) = missing { value } else { 0 }",
      name: "missing",
    },
    { source: "missing[0] = 1\n0", name: "missing" },
  ];

  for (const fixture of fixtures) {
    assert_throws(
      () => Source.core(Source.parse(fixture.source)),
      "Unbound core value: " + fixture.name,
    );
  }
});

Deno.test("Core.emit rejects nodes that still need structured codegen", () => {
  const core = Source.core(Source.parse(`
let total = 0
let xs = 1

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

  const field_core = Source.core(Source.parse("let user = 1\nuser.name"));
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

  const index_core = Source.core(Source.parse(
    "let xs = 1\nlet i = 0\nxs[i]",
  ));
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

  assert_throws(
    () => Source.core(Source.parse("xs[0] = 2\n0")),
    "Unbound core value: xs",
  );

  const comptime_bind_core = Source.core(Source.parse(`
let x = comptime 1
x
`));
  assert_equals(
    Format.fmt(Core, comptime_bind_core),
    "let x = 1:i32\nx",
  );
  assert_equals(Core.proof(comptime_bind_core).issues, []);

  const comptime_assign_core = Source.core(Source.parse(`
let x = 0
x = comptime 1
x
`));
  assert_equals(
    Format.fmt(Core, comptime_assign_core),
    "let x = 0:i32\nx = 1:i32\nx",
  );
  assert_equals(Core.proof(comptime_assign_core).issues, []);

  const nonfinal_field_core = Source.core(Source.parse(`
let user = 1
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
let xs = 1
let i = 0
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
      feature: "len_unknown_collection_or_text",
      missing_edge: "missing_collection_or_text_fact",
      emit_message:
        "Unsupported Core len: operand has no collection or Text fact",
    },
    {
      source: "let x = 1\nget(x, 0)",
      type_message: "Cannot type core get over unknown collection",
      feature: "get_unknown_collection",
      missing_edge: "missing_collection_fact",
      emit_message: "Unsupported Core get: operand has no collection fact",
    },
  ];

  for (const item of unsupported_builtin_collection_calls) {
    const builtin_core = Source.core(Source.parse(item.source));
    const builtin_issue = Core.proof(builtin_core).issues[0];
    assert_equals(builtin_issue?.tag, "unsupported_codegen");

    if (!builtin_issue || builtin_issue.tag !== "unsupported_codegen") {
      throw new Error("Missing builtin unsupported-codegen proof issue");
    }

    assert_equals(
      {
        feature: builtin_issue.issue.feature,
        missing_edge: builtin_issue.missing_edge,
        message: builtin_issue.message,
      },
      {
        feature: item.feature,
        missing_edge: item.missing_edge,
        message: item.emit_message,
      },
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
    const nonfinal_issue = Core.proof(nonfinal_builtin_core).issues[0];
    assert_equals(nonfinal_issue?.tag, "unsupported_codegen");

    if (!nonfinal_issue || nonfinal_issue.tag !== "unsupported_codegen") {
      throw new Error(
        "Missing nonfinal builtin unsupported-codegen proof issue",
      );
    }

    assert_equals(
      {
        feature: nonfinal_issue.issue.feature,
        missing_edge: nonfinal_issue.missing_edge,
        message: nonfinal_issue.message,
      },
      {
        feature: item.feature,
        missing_edge: item.missing_edge,
        message: item.emit_message,
      },
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
let result = 1
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
let result = 1
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

  const app_core = Source.core(Source.parse("let foo = 1\nfoo(1)"));
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
const { struct } = comptime (import "duck:prelude")()
struct {
  .name= Text
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
const { struct } = comptime (import "duck:prelude")()
const user_type = struct {
  .name= Text
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
let xs = 1
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
let result = 1
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
let user = [.age = 40, .score = 2]
user with { .age = 41 }
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
let user = [.age = 40, .score = 2]
(user with { .age = 41 }).age
`));
  assert_equals(Core.proof(struct_update_projection_core).issues, []);
  assert_equals(
    Emit.emit(Core, struct_update_projection_core).trim(),
    "i32.const 41",
  );
});

Deno.test("Core rejects static values carried through dynamic loops", () => {
  const range_core = Source.core(Source.parse(`
type ResultType = | .ok = Text | .err = Int
const result_type = ResultType

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
type ResultType = | .ok = Text | .err = Int
const result_type = ResultType

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
type ResultType = | .ok = Text | .err = Int
const result_type = ResultType

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
