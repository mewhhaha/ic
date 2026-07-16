import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Core, type Core as CoreNode } from "../core.ts";
import { core_baseline_proof } from "./proof/baseline.ts";
import { TestSource as Source } from "../frontend/test_source.ts";
import { Mod } from "../mod.ts";
import { Emit, Typed } from "../trait.ts";

Deno.test("Core links drops to alternative persistent allocations", () => {
  const branch = Source.core(Source.parse(`
let flag = 1
let f = if flag { (x: Int) => x } else { (x: Int) => x + 1 }
1
`));
  const branch_proof = Core.proof(branch);

  assert_equals(branch_proof.ok, true);
  assert_equals(
    branch_proof.allocations.facts.map((fact) => fact.allocation_id),
    ["allocation#0", "allocation#1"],
  );
  assert_equals(branch_proof.drops.steps[0]?.allocation_id, undefined);
  assert_equals(branch_proof.drops.steps[0]?.allocation_ids, [
    "allocation#0",
    "allocation#1",
  ]);

  const replaced = Source.core(Source.parse(`
let flag = 1
let f = if flag { (x: Int) => x } else { (x: Int) => x + 1 }
f = (x: Int) => x + 2
1
`));
  const replaced_proof = Core.proof(replaced);

  assert_equals(replaced_proof.ok, true);
  assert_equals(replaced_proof.drops.steps[0]?.allocation_ids, [
    "allocation#0",
    "allocation#1",
  ]);
  assert_equals(replaced_proof.drops.steps[1]?.allocation_id, "allocation#2");
  assert_equals(
    new Set(replaced_proof.allocations.facts.map((fact) => fact.allocation_id))
      .size,
    replaced_proof.allocations.facts.length,
  );

  const returned = Source.core(Source.parse(`
let flag = 1
let f = if flag { (x: Int) => x } else { (x: Int) => x + 1 }
f
`));
  const returned_proof = Core.proof(returned);
  assert_equals(returned_proof.drops.steps, []);
  assert_equals(returned_proof.issues, []);

  const aliased_alternatives = Source.core(Source.parse(`
let f = (x: Int) => x
let g = (x: Int) => x + 1
let h = if 1 { f } else { g }
1
`));
  const aliased_proof = Core.proof(aliased_alternatives);

  assert_equals(aliased_proof.ok, true);
  assert_equals(aliased_proof.drops.steps.length, 1);
  assert_equals(aliased_proof.drops.steps[0]?.allocation_id, undefined);
  assert_equals(aliased_proof.drops.steps[0]?.allocation_ids, [
    "allocation#0",
    "allocation#1",
  ]);
});

Deno.test("Core links loop replacement drops across alternative exits", () => {
  const core = Source.core(Source.parse(`
host_import bound from "env.bound" () => I32
let end = bound()
let pending: Text = slice("Ada", 0, end)

for i in 0..end {
  pending = append(pending, "!")
  pending = slice(pending, 0, len(pending))

  if end {
    break
  }
}

len(pending)
`));
  const proof = Core.proof(core);

  assert_equals(proof.ok, true);
  assert_equals(proof.issues, []);
  assert_equals(
    proof.allocations.facts.map((fact) => fact.allocation_id),
    ["allocation#0", "allocation#1", "allocation#2"],
  );
  assert_equals(
    proof.drops.steps.map((step) => {
      return {
        edge: step.edge,
        allocation_id: step.allocation_id,
        allocation_ids: step.allocation_ids,
      };
    }),
    [
      {
        edge: "assignment_replace",
        allocation_id: "allocation#0",
        allocation_ids: undefined,
      },
      {
        edge: "assignment_replace",
        allocation_id: "allocation#1",
        allocation_ids: undefined,
      },
      {
        edge: "scope_exit",
        allocation_id: "allocation#2",
        allocation_ids: undefined,
      },
    ],
  );
  Core.check_proof(core);
});

Deno.test("Core emits scalar value-producing loops with nested labels", () => {
  const loop: CoreNode = {
    tag: "program",
    statements: [
      {
        tag: "expr",
        expr: {
          tag: "loop",
          body: [
            {
              tag: "expr",
              expr: {
                tag: "loop",
                body: [{
                  tag: "break",
                  value: { tag: "num", type: "i32", value: 3 },
                }],
              },
            },
            {
              tag: "break",
              value: { tag: "num", type: "i32", value: 7 },
            },
          ],
        },
      },
    ],
  };

  assert_equals(Core.type(loop), "i32");
  const wat = Emit.emit(Mod, Core.mod(loop));

  assert_includes(wat, "block $loop_exit_0 (result i32)");
  assert_includes(wat, "loop $loop_0 (result i32)");
  assert_includes(wat, "block $loop_continue_0");
  assert_includes(wat, "block $loop_exit_1 (result i32)");
  assert_includes(wat, "br $loop_exit_1");
  assert_includes(wat, "br $loop_exit_0");
});

Deno.test("Core preserves Bytes facts through runtime union loop bodies", () => {
  const wat = Source.wat(Source.parse(`
type ResultType = | .chunk = Bytes | .eof
const result_type = ResultType
host_import read from "env.read" () => result_type

let result: result_type = read()
if let .chunk(first_bytes) = result {
  let pending: Bytes = slice(first_bytes, 0, len(first_bytes))

  loop {
    for index, byte in pending {
      for offset in 0..len(pending) {
        ()
      }
    }

    let appended: Bytes = append(pending, first_bytes)
    pending = slice(appended, 0, len(appended))
    break len(pending)
  }
} else {
  0
}
`));

  assert_includes(wat, "block $loop_exit_");
  assert_includes(wat, "block $text_collection_exit_");
  assert_includes(wat, "block $range_exit_");
  assert_includes(wat, "block $text_slice_exit_");
  assert_includes(wat, "block $text_concat_left_exit_");
});

Deno.test("Core treats bare loop break as i32 Unit and rejects invalid exits", () => {
  const unit: CoreNode = {
    tag: "program",
    statements: [{
      tag: "expr",
      expr: { tag: "loop", body: [{ tag: "break" }] },
    }],
  };
  assert_equals(Core.type(unit), "i32");
  assert_includes(Emit.emit(Mod, Core.mod(unit)), "i32.const 0");

  const mixed: CoreNode = {
    tag: "program",
    statements: [{
      tag: "expr",
      expr: {
        tag: "loop",
        body: [
          { tag: "break" },
          { tag: "break", value: { tag: "num", type: "i64", value: 1n } },
        ],
      },
    }],
  };
  assert_throws(() => Core.type(mixed), "Core loop break value type mismatch");

  const text: CoreNode = {
    tag: "program",
    statements: [{
      tag: "expr",
      expr: {
        tag: "loop",
        body: [{ tag: "break", value: { tag: "text", value: "owned" } }],
      },
    }],
  };
  assert_throws(
    () => Core.type(text),
    "Core value-producing loop break result must be scalar",
  );
});

Deno.test("Core finds loop breaks nested in expression control flow", () => {
  const core: CoreNode = {
    tag: "program",
    statements: [{
      tag: "expr",
      expr: {
        tag: "loop",
        body: [{
          tag: "expr",
          expr: {
            tag: "if",
            cond: { tag: "num", type: "i32", value: 1 },
            then_branch: {
              tag: "block",
              statements: [{
                tag: "break",
                value: { tag: "num", type: "i32", value: 1 },
              }],
            },
            else_branch: {
              tag: "block",
              statements: [{
                tag: "break",
                value: { tag: "num", type: "i32", value: 2 },
              }],
            },
          },
        }],
      },
    }],
  };

  assert_equals(Core.type(core), "i32");
});

Deno.test("Core types match branches with terminal and fallthrough values", () => {
  const core = Source.core(Source.parse(`
let flag = 0
let value = loop {
  let chosen = match flag {
    | 1 => { break 7 }
    | _ => 42
  }
  break chosen
}
value
`));

  assert_equals(Core.type(core), "i32");
  const wat = Emit.emit(Core, core);
  assert_includes(wat, "if (result i32)");
  assert_includes(wat, "br $loop_exit_0");
});

Deno.test("Core types runtime match payloads in value-producing loops", () => {
  const core = Source.core(Source.parse(`
type ReadResultType = | .chunk = Bytes | .eof | .err = I32
const read_result_type = ReadResultType
host_import read from "env.read" () => read_result_type
host_import write from "env.write" (&Bytes) => I32
let prefix: Bytes = Utf8.encode("prefix")
let value = loop {
  let read_result: read_result_type = read()
  match read_result {
    | .chunk(bytes) => {
      let pending: Bytes = append(prefix, bytes)
      write(&pending)
      len(pending)
    }
    | .eof => { break 0 }
    | .err(code) => { break code }
  }
}
value
`));

  assert_equals(Core.type(core), "i32");
});

Deno.test("Core moves a linear runtime aggregate into one-shot closure slots", () => {
  const source = `
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .age= Int }
let make = (age: Int) => [.age = age] as user_type
let !user: user_type = make(41)
let flag = 1
let take_once = if flag { () => !user } else { () => !user }
user = take_once()
!user
`;
  const core = Source.core(Source.parse(source));
  const proof = Core.proof(core);

  assert_equals(proof.ok, true);
  assert_equals(proof.managed_storage, "disabled");
  assert_equals(proof.closure_ownership.edges.length, 2);

  for (const edge of proof.closure_ownership.edges) {
    assert_equals(edge.callable, "once");
    assert_equals(edge.environment_storage, "persistent_unique_heap");
    assert_equals(edge.captures[0], {
      name: "user",
      ownership: { tag: "unique_heap", reason: "runtime_aggregate" },
      decision: {
        tag: "allowed",
        reason: "source linear capture moves into a one-shot closure " +
          "environment slot",
      },
      environment: {
        offset: 4,
        storage: "unique_heap",
        lifetime: "persistent",
        transfer: "move",
      },
    });
  }

  assert_equals(
    proof.cleanup_rows.some((row) => {
      return row.tag === "heap_drop" && row.owner === "take_once";
    }),
    true,
  );
  Core.check_proof(core);
  assert_includes(Source.wat(source), "call_indirect");

  assert_throws(
    () =>
      Source.core(Source.parse(source.replace(
        "!user\n",
        "user = take_once()\n!user\n",
      ))),
    "Linear closure take_once was already consumed",
  );
  assert_throws(
    () =>
      Source.core(Source.parse(source.replace(
        "!user\n",
        "let alias = take_once\nuser = alias()\n!user\n",
      ))),
    "Linear closure alias was already consumed",
  );
});

Deno.test("Core moves a linear runtime union into one-shot closure slots", () => {
  const source = `
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType
let !result: result_type = result_type.ok(41)
let flag = 1
let take_once = if flag { () => !result } else { () => !result }
result = take_once()
!result
`;
  const core = Source.core(Source.parse(source));
  const proof = Core.proof(core);

  assert_equals(proof.ok, true);
  assert_equals(proof.managed_storage, "disabled");
  assert_equals(proof.closure_ownership.edges.length, 2);

  for (const edge of proof.closure_ownership.edges) {
    assert_equals(edge.callable, "once");
    assert_equals(edge.environment_storage, "persistent_unique_heap");
    assert_equals(edge.captures[0], {
      name: "result",
      ownership: { tag: "unique_heap", reason: "runtime_union" },
      decision: {
        tag: "allowed",
        reason: "source linear capture moves into a one-shot closure " +
          "environment slot",
      },
      environment: {
        offset: 4,
        storage: "unique_heap",
        lifetime: "persistent",
        transfer: "move",
      },
    });
  }

  assert_equals(
    proof.allocations.facts.some((fact) => {
      return fact.owner === "take_once" &&
        fact.layout === "closure_env.table_index_and_capture_slots";
    }),
    true,
  );
  assert_equals(
    proof.cleanup_rows.some((row) => {
      return row.tag === "heap_drop" && row.owner === "take_once" &&
        Boolean(row.allocation_ids);
    }),
    true,
  );
  Core.check_proof(core);
  const wat = Source.wat(source);
  assert_includes(wat, "i32.store offset=4");
  assert_includes(wat, "i32.load offset=4");
  assert_includes(wat, "call_indirect");

  assert_throws(
    () =>
      Source.core(Source.parse(source.replace(
        "!result\n",
        "result = take_once()\n!result\n",
      ))),
    "Linear closure take_once was already consumed",
  );
  assert_throws(
    () =>
      Source.core(Source.parse(source.replace(
        "!result\n",
        "let alias = take_once\nresult = alias()\n!result\n",
      ))),
    "Linear closure alias was already consumed",
  );
});

Deno.test("Core proves promoted scratch Text closure capture slots", () => {
  const promoted = Source.core(Source.parse(`
let f = scratch {
  let message: Text = append("he", "llo")
  let persistent: Text = freeze message
  freeze ((x: Int) => len(persistent) + x)
}
f(1)
`));
  const proof = Core.proof(promoted);

  assert_equals(proof.ok, true);
  assert_equals(proof.managed_storage, "disabled");
  assert_equals(proof.closure_ownership.edges[0]?.captures[0], {
    name: "persistent",
    ownership: { tag: "frozen_shareable", reason: "freeze" },
    decision: {
      tag: "allowed",
      reason: "frozen/shareable capture is reusable",
    },
    environment: {
      offset: 4,
      storage: "unique_heap",
      lifetime: "persistent",
      transfer: "share",
    },
  });
  assert_equals(
    proof.closure_ownership.edges[0]?.environment_storage,
    "persistent_unique_heap",
  );
  assert_equals(proof.cleanup_rows[0]?.tag, "scratch_reset");
  assert_equals(proof.cleanup.steps[0]?.return_value.storage, "frozen_heap");
  Core.check_proof(promoted);
  assert_includes(Emit.emit(Mod, Core.mod(promoted)), "call_indirect");

  const raw = Source.core(Source.parse(`
scratch {
  let message: Text = append("he", "llo")
  freeze ((x: Int) => len(message) + x)
}
`));
  const raw_proof = Core.proof(raw);

  assert_equals(raw_proof.ok, false);
  assert_equals(raw_proof.managed_storage, "disabled");
  assert_equals(
    raw_proof.issues[0]?.missing_edge,
    "unsupported_ownership_bearing_closure_capture",
  );
  assert_throws(
    () => Core.check_proof(raw),
    "scratch_backed over unique_heap text capture requires linear closure " +
      "ownership support",
  );
});

Deno.test("Core promotes helper-returned frozen scratch Text", () => {
  const frozen = Source.core(Source.parse(`
let freeze_suffix = (value: Text) => {
  freeze append(value, "!")
}
let prefix: Text = slice("Ada", 0, 3)
scratch { freeze_suffix(prefix) }
`));
  const proof = Core.proof(frozen);

  assert_equals(proof.ok, true);
  assert_equals(proof.managed_storage, "disabled");
  assert_equals(proof.final_result.storage, "frozen_heap");
  assert_equals(proof.cleanup.steps[0]?.tag, "scratch_reset");
  assert_equals(
    proof.cleanup.steps[0]?.return_value.storage,
    "frozen_heap",
  );
  assert_equals(
    proof.allocations.facts.some((fact) => {
      return fact.storage === "scratch_arena" &&
        fact.reason === "runtime_text";
    }),
    true,
  );
  assert_equals(
    proof.allocations.facts.some((fact) => {
      return fact.storage === "persistent_unique_heap" &&
        fact.expression === "freeze";
    }),
    true,
  );
  assert_equals(proof.freeze_edges.length, 1);
  Core.check_proof(frozen);
  assert_includes(
    Emit.emit(Mod, Core.mod(frozen)),
    "block $text_freeze_exit_",
  );

  const raw = Source.core(Source.parse(`
let suffix = (value: Text) => {
  append(value, "!")
}
let prefix: Text = slice("Ada", 0, 3)
scratch { suffix(prefix) }
`));
  const raw_proof = Core.proof(raw);

  assert_equals(raw_proof.ok, false);
  assert_equals(raw_proof.managed_storage, "disabled");
  assert_equals(raw_proof.cleanup.steps[0]?.return_value.storage, "rejected");
  assert_throws(
    () => Core.check_proof(raw),
    "unique_heap text cannot leave scratch without freeze or explicit promotion",
  );
});

Deno.test("Core promotes nested aggregate union Text out of scratch", () => {
  const source = `
type ResultType = | .ok = Text | .err
const result_type = ResultType
const { struct } = comptime (import "duck:prelude")()
const inner_type = struct { .result= result_type }
const { struct } = comptime (import "duck:prelude")()
const outer_type = struct { .inner= inner_type, .age= Int }

let start = 0
let prefix: Text = slice("Ada", start, 1)
let frozen = scratch {
  let temp = [.inner = [.result = result_type.ok(append(prefix, "da"))] as inner_type, .age = 2] as outer_type
  freeze temp
}

if let .ok(text) = frozen.inner.result { len(text) } else { 0 }
`;
  const core = Source.core(Source.parse(source));
  const proof = Core.proof(core);

  assert_equals(proof.ok, true);
  assert_equals(proof.managed_storage, "disabled");
  assert_equals(proof.issues, []);
  assert_equals(proof.final_result.storage, "scalar_local");
  assert_equals(proof.cleanup.steps[0]?.return_value.storage, "frozen_heap");
  assert_equals(
    proof.freeze_promotion_rows.map((row) => {
      return {
        storage: row.analysis.storage,
        ownership: row.analysis.ownership,
        decision: row.analysis.decision.tag,
      };
    }),
    [
      {
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_aggregate",
        },
        decision: "allowed",
      },
    ],
  );
  assert_equals(
    proof.allocations.facts.filter((fact) => {
      return fact.expression === "freeze";
    }).map((fact) => {
      return {
        reason: fact.reason,
        storage: fact.storage,
        layout: fact.layout,
      };
    }),
    [
      {
        reason: "runtime_aggregate",
        storage: "persistent_unique_heap",
        layout: "runtime_aggregate.aligned_fields",
      },
      {
        reason: "runtime_union",
        storage: "persistent_unique_heap",
        layout: "runtime_union.tag_and_aligned_payload",
      },
      {
        reason: "runtime_text",
        storage: "persistent_unique_heap",
        layout: "runtime_text.length_prefixed_utf8",
      },
    ],
  );
  Core.check_proof(core);

  const wat = Source.wat(source);
  assert_includes(wat, "block $text_freeze_exit_");
  assert_includes(wat, "i32.load offset=4");
  assert_includes(wat, "call $__alloc");
});

Deno.test("Core links aggregate Text child destructors before outer cleanup", () => {
  const source = `
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .name= Text, .age= Int }
let flag = 1
let make = if flag {
  (suffix: Text) => [.name = append("A", suffix), .age = 40] as user_type
} else {
  (suffix: Text) => [.name = append("B", suffix), .age = 5] as user_type
}
let user: user_type = make("da")
len(user.name) + user.age
`;
  const core = Source.core(Source.parse(source));
  const proof = Core.proof(core);
  const drop = proof.drops.steps.find((step) => {
    return step.tag === "heap_drop" && step.owner === "user";
  });
  if (!drop || drop.tag !== "heap_drop") {
    throw new Error("Missing aggregate owner cleanup");
  }
  assert_equals(drop.layout, "runtime_aggregate.aligned_fields");
  assert_equals(drop.owned_children, [
    {
      allocation_ids: ["allocation#2", "allocation#5"],
      offset: 0,
      ownership: { tag: "unique_heap", reason: "text" },
      layout: "runtime_text.length_prefixed_utf8",
    },
  ]);
  assert_equals(
    proof.allocations.facts.filter((fact) => {
      return fact.layout === "runtime_aggregate.aligned_fields" &&
        fact.owned_children;
    }).map((fact) => fact.owned_children),
    [
      [
        {
          allocation_ids: ["allocation#2"],
          offset: 0,
          ownership: { tag: "unique_heap", reason: "text" },
          layout: "runtime_text.length_prefixed_utf8",
        },
      ],
      [
        {
          allocation_ids: ["allocation#5"],
          offset: 0,
          ownership: { tag: "unique_heap", reason: "text" },
          layout: "runtime_text.length_prefixed_utf8",
        },
      ],
    ],
  );
  assert_equals(proof.managed_storage, "disabled");
  assert_equals(proof.issues, []);
  assert_includes(
    Source.wat(source),
    "local.get $user\n" +
      "    i32.load offset=0\n" +
      "    call $__free\n" +
      "    drop\n" +
      "    local.get $user\n" +
      "    call $__free",
  );

  const frozen = Source.core(Source.parse(source.replace(
    'let user: user_type = make("da")',
    'let user: user_type = freeze make("da")',
  )));
  assert_equals(
    Core.proof(frozen).drops.steps.some((step) => step.owner === "user"),
    false,
  );
});

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

Deno.test("Core emits dynamic runtime i32 slice loops with proof facts", () => {
  const core = Source.core(Source.parse(`
let length = 2
let sum = 0

for index, value in runtime_i32_slice(length, 10, 20, 30) {
  sum = sum + index + value
}

sum
`));
  const proof = Core.proof(core);
  assert_equals(proof.runtime_slice_rows, [
    {
      element_type: "i32",
      element_ownership: "scalar_local",
      ownership: "unique_heap",
      pointer_offset: 4,
      length: { tag: "var", name: "length" },
      capacity: 3,
    },
  ]);
  assert_equals(proof.issues, []);
  const wat = Source.wat(`
let length = 2
let sum = 0
for index, value in runtime_i32_slice(length, 10, 20, 30) {
  sum = sum + index + value
}
sum
`);
  assert_includes(wat, "block $slice_exit_0");
  assert_includes(wat, "loop $slice_loop_0");
  assert_includes(wat, "i32.load offset=4");

  assert_throws(
    () =>
      Source.wat(`
let length = 1
let sum = 0
for value in runtime_i32_slice(length) {
  sum = sum + value
}
sum
`),
    "Core runtime_i32_slice needs length and at least one element",
  );
});

Deno.test("Core emits runtime frozen Text slice loops with ownership facts", () => {
  const source = `
let length = 2
let sum = 0
for value in runtime_text_slice(length, "Ada", "B") {
  sum = sum + len(value)
}
sum
`;
  const core = Source.core(Source.parse(source));
  const proof = Core.proof(core);
  assert_equals(proof.runtime_slice_rows, [
    {
      element_type: "Text",
      element_ownership: "frozen_shareable",
      ownership: "unique_heap",
      pointer_offset: 4,
      length: { tag: "var", name: "length" },
      capacity: 2,
    },
  ]);
  assert_equals(proof.issues, []);
  const allocation = proof.allocations.facts.find((fact) => {
    return fact.layout === "runtime_slice.length_and_frozen_text_pointers";
  });
  if (!allocation) {
    throw new Error("Missing runtime Text slice allocation fact");
  }
  assert_equals(allocation.byte_size, { tag: "static", value: 12 });
  assert_equals(allocation.ownership, {
    tag: "unique_heap",
    reason: "runtime_aggregate",
  });
  const cleanup = proof.drops.steps.find((step) => {
    if (step.allocation_id === allocation.allocation_id) {
      return true;
    }
    if (step.allocation_ids) {
      return step.allocation_ids.includes(allocation.allocation_id);
    }
    return false;
  });
  if (!cleanup) {
    throw new Error("Missing runtime Text slice cleanup fact");
  }
  assert_equals(cleanup.ownership, {
    tag: "unique_heap",
    reason: "runtime_aggregate",
  });

  const wat = Source.wat(source);
  assert_includes(wat, "i32.load offset=4");
  assert_includes(wat, "i32.load");
  assert_includes(wat, "call $__free");

  assert_throws(
    () =>
      Source.wat(`
let dynamic: Text = append("A", "da")
for value in runtime_text_slice(1, dynamic) {
  len(value)
}
0
`),
    "Core runtime_text_slice elements must be frozen/shareable Text",
  );
});

Deno.test("Core persistent allocation facts carry reusable-layout metadata", () => {
  const core = Source.core(Source.parse(`
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .name= Text, .age= Int }
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType
let text: Text = append("A", "da")
let user: user_type = [.name = text, .age = 40] as user_type
let flag = 1
let make = if flag {
  (value: Int) => result_type.ok(value)
} else {
  (value: Int) => result_type.err(value)
}
let result: result_type = make(user.age)
let sum = 0
for value in runtime_i32_slice(2, 10, 20) {
  sum = sum + value
}
sum
`));
  const proof = Core.proof(core);
  const persistent = proof.allocations.facts.filter((fact) => {
    return fact.storage === "persistent_unique_heap";
  });
  assert_equals(persistent.length > 0, true);

  for (const fact of persistent) {
    assert_equals(fact.allocation_id, fact.id);
    assert_equals(fact.alignment === 4 || fact.alignment === 8, true);
    assert_equals(fact.layout.length > 0, true);
    if (fact.byte_size.tag === "static") {
      assert_equals(fact.byte_size.value > 0, true);
    } else {
      assert_equals(fact.byte_size.formula.length > 0, true);
    }
  }

  assert_equals(
    new Set(persistent.map((fact) => fact.layout)),
    new Set([
      "runtime_text.length_prefixed_utf8",
      "runtime_aggregate.aligned_fields",
      "closure_env.table_index_and_capture_slots",
      "runtime_union.tag_and_aligned_payload",
      "runtime_slice.length_and_i32_elements",
    ]),
  );

  const first = persistent[0];
  if (!first) {
    throw new Error("Missing persistent allocation fixture");
  }
  const malformed = {
    id: first.id,
    scope: first.scope,
    storage: first.storage,
    ownership: first.ownership,
    reason: first.reason,
    expression: first.expression,
  };
  const rejected = core_baseline_proof({
    final_result: proof.final_result,
    borrow_plan: {
      edges: proof.borrow_view_rows,
      barriers: [],
      skipped_closures: [],
    },
    borrows: proof.borrows,
    freeze_edges: proof.freeze_edges,
    cleanup: proof.cleanup,
    closure_ownership: proof.closure_ownership,
    drops: proof.drops,
    allocations: {
      facts: [malformed as typeof persistent[number]],
    },
    host_boundaries: proof.host_boundaries,
    capability_method_rows: proof.capability_method_rows,
    runtime_slice_rows: proof.runtime_slice_rows,
    transfers: proof.transfers,
    lifetimes: proof.lifetimes,
    unsupported_codegen: [],
  });
  assert_equals(rejected.issues[0]?.missing_edge, "missing_allocation_layout");
});

Deno.test("Core elaborates linked cleanup rows onto WAT anchors", () => {
  const scope_core = Source.core(Source.parse(`
let text: Text = append("A", "da")
1
`));
  const scope_wat = Emit.emit(Mod, Core.mod(scope_core));
  assert_includes(scope_wat, "local.get $text\n    call $__free\n    drop");
  assert_includes(scope_wat, "(func $__free (param $ptr i32) (result i32)");
  assert_equals(scope_core.cleanup_emission?.[0]?.edge, "scope_exit");
  assert_equals(scope_core.cleanup_emission?.[0]?.allocation_ids, [
    "allocation#0",
  ]);

  const replace_core = Source.core(Source.parse(`
let text: Text = append("A", "da")
text = append("G", "race")
len(text)
`));
  const replace_wat = Emit.emit(Mod, Core.mod(replace_core));
  const free_index = replace_wat.indexOf("call $__free");
  const replacement_index = replace_wat.lastIndexOf("local.set $text");
  assert_equals(free_index >= 0, true);
  assert_equals(free_index < replacement_index, true);
  assert_equals(
    replace_core.cleanup_emission?.some((row) => {
      return row.edge === "assignment_replace";
    }),
    true,
  );

  const returned_core = Source.core(Source.parse(`
let text: Text = append("A", "da")
text
`));
  const returned_wat = Emit.emit(Mod, Core.mod(returned_core));
  assert_equals(returned_wat.includes("call $__free"), false);
  assert_includes(returned_wat, "call $__alloc");

  const frozen_wat = Source.wat(`
let text: Text = append("A", "da")
freeze text
`);
  assert_includes(frozen_wat, "call $__alloc");
  assert_equals(frozen_wat.includes("call $__free"), false);

  const return_wat = Source.wat(`
let flag = 1
let f = if flag { (x: Int) => x } else { (x: Int) => x + 1 }
return 1
`);
  const return_free = return_wat.indexOf("call $__free");
  const return_transfer = return_wat.indexOf("return", return_free);
  assert_equals(return_free >= 0, true);
  assert_equals(return_free < return_transfer, true);

  const conditional_return_wat = Source.wat(`
let flag = 1
let f = if flag { (x: Int) => x } else { (x: Int) => x + 1 }
if flag {
  return 1
}
0
`);
  const conditional_free = conditional_return_wat.indexOf("call $__free");
  const conditional_return = conditional_return_wat.indexOf(
    "return",
    conditional_free,
  );
  assert_equals(conditional_free < conditional_return, true);

  for (const transfer of ["break", "continue"]) {
    const loop_wat = Source.wat(`
for i in 0..1 {
  let f = if i { (x: Int) => x } else { (x: Int) => x + 1 }
  ${transfer}
}
0
`);
    const loop_free = loop_wat.indexOf("call $__free");
    let branch = loop_wat.indexOf("br $range_exit", loop_free);
    if (transfer === "continue") {
      branch = loop_wat.indexOf("br $range_continue", loop_free);
    }
    assert_equals(loop_free >= 0, true);
    assert_equals(loop_free < branch, true);
  }

  const loop_scope_wat = Source.wat(`
for i in 0..1 {
  let f = (x: Int) => x
  i
}
0
`);
  const loop_scope_free = loop_scope_wat.indexOf("call $__free");
  const loop_back_edge = loop_scope_wat.indexOf(
    "br $range_loop",
    loop_scope_free,
  );
  assert_equals(loop_scope_free < loop_back_edge, true);

  const branch_scope_wat = Source.wat(`
let flag = 1
if flag {
  let f = if flag { (x: Int) => x } else { (x: Int) => x + 1 }
  2
}
0
`);
  const branch_scope_free = branch_scope_wat.indexOf("call $__free");
  const branch_end = branch_scope_wat.indexOf("end", branch_scope_free);
  assert_equals(branch_scope_free >= 0, true);
  assert_equals(branch_scope_free < branch_end, true);
});

Deno.test("Core anchors no-else conditional transfer cleanup on fallthrough", () => {
  const prefix = `
host_import branch_flag from "env.flag" () => I32
type GateType = | .go = Int | .stop = Int
const gate_type = GateType
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .age= Int }
type ResultType = | .ok = user_type | .err
const result_type = ResultType
let flag = branch_flag()
let gate: gate_type = if flag {
  gate_type.go(1)
} else {
  gate_type.stop(0)
}
let make = if flag {
  (age: Int) => [.age = age] as user_type
} else {
  (age: Int) => [.age = age + 1] as user_type
}
let user: user_type = make(40)
`;
  const fixtures = [
    {
      source: prefix + "if flag { result_type.ok(user) }\n0",
      transfer_scope: "program#0/if",
      cleanup_scope: "program#0/if_fallthrough",
    },
    {
      source: prefix +
        "if let .go(value) = gate { result_type.ok(user) }\n0",
      transfer_scope: "program#0/if_let",
      cleanup_scope: "program#0/if_let_fallthrough",
    },
  ];

  for (const fixture of fixtures) {
    const core = Source.core(Source.parse(fixture.source));
    const proof = Core.proof(core);
    const wat = Emit.emit(Mod, Core.mod(core));
    const cleanup = proof.drops.steps.find((step) => {
      return step.tag === "heap_drop" &&
        step.edge === "conditional_cleanup";
    });

    assert_equals(proof.ok, true);
    assert_equals(proof.transfers.transfers[0]?.scope, fixture.transfer_scope);
    assert_equals(cleanup?.scope, fixture.cleanup_scope);
    assert_equals(cleanup?.owner, "user");
    assert_equals(cleanup?.allocation_id, undefined);
    assert_equals(cleanup?.allocation_ids, [
      "allocation#3",
      "allocation#5",
    ]);
    assert_equals(cleanup?.alignment, 8);
    assert_equals(cleanup?.layout, "runtime_aggregate.aligned_fields");
    assert_equals(
      proof.drops.steps.some((step) => {
        return step.tag === "heap_drop" && step.edge === "scope_exit" &&
          step.owner === "user";
      }),
      false,
    );
    assert_includes(
      wat,
      "else\n      local.get $user\n      call $__free\n      drop\n    end",
    );

    const use_after_source = fixture.source.slice(0, -1) + "user.age";
    const use_after = Core.proof(
      Source.core(Source.parse(use_after_source)),
    );
    assert_equals(
      use_after.transfers.issues.some((issue) => {
        return issue.tag === "use_after_transfer" && issue.owner === "user";
      }),
      true,
    );
  }
});

Deno.test("Core captures ownerless discarded pointers for cleanup", () => {
  const fixtures = [
    {
      reason: "text",
      source: `
let flag = 1
append(if flag { "A" } else { "B" }, "!")
append(if flag { "C" } else { "D" }, "?")
`,
    },
    {
      reason: "runtime_aggregate",
      source: `
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .age= Int }
let flag = 1
[.age = flag] as user_type
[.age = flag + 1] as user_type
`,
    },
    {
      reason: "runtime_union",
      source: `
type ResultType = | .ok = Int | .err = Int
const result_type = ResultType
let flag = 1
result_type.ok(flag)
result_type.err(flag)
`,
    },
    {
      reason: "closure",
      source: `
let flag = 1
((x: Int) => x + flag)
((x: Int) => x + flag + 1)
`,
    },
  ];

  for (const fixture of fixtures) {
    const core = Source.core(Source.parse(fixture.source));
    const proof = Core.proof(core);
    const wat = Emit.emit(Mod, Core.mod(core));
    const drop = proof.drops.steps.find((step) => {
      return step.tag === "heap_drop" && step.edge === "discarded_expr" &&
        step.owner === undefined && step.ownership.reason === fixture.reason;
    });
    const cleanup = core.cleanup_emission?.find((row) => {
      return row.step_id === drop?.id;
    });

    assert_equals(proof.ok, true);
    assert_equals(drop?.allocation_id !== undefined, true);
    assert_equals(cleanup?.allocation_ids, [drop?.allocation_id]);
    assert_equals(cleanup?.owner, undefined);
    assert_equals(cleanup?.pointer_local, "_cleanup_" + drop?.id);
    assert_includes(wat, "(local $_cleanup_" + drop?.id + " i32)");
    assert_includes(
      wat,
      "local.set $_cleanup_" + drop?.id + "\n" +
        "    local.get $_cleanup_" + drop?.id + "\n" +
        "    call $__free",
    );
  }
});

Deno.test("Core cleanup emission keeps repeated assignment anchors isolated", () => {
  const core = Source.core(Source.parse(`
let text: Text = append("a", "b")
text = append("c", "d")
text = append("e", "f")
len(text)
`));
  const first_wat = Emit.emit(Mod, Core.mod(core));
  const first_rows = core.cleanup_emission?.map((row) => {
    return {
      step_id: row.step_id,
      allocation_ids: row.allocation_ids,
      edge: row.edge,
      statement_path: row.statement_path,
    };
  });

  assert_equals(first_rows, [
    {
      step_id: "drop#0",
      allocation_ids: ["allocation#0"],
      edge: "assignment_replace",
      statement_path: [1],
    },
    {
      step_id: "drop#1",
      allocation_ids: ["allocation#1"],
      edge: "assignment_replace",
      statement_path: [2],
    },
    {
      step_id: "drop#2",
      allocation_ids: ["allocation#2"],
      edge: "scope_exit",
      statement_path: [3],
    },
  ]);
  const first_free = first_wat.indexOf("call $__free");
  const first_replace = first_wat.indexOf("local.set $text", first_free);
  const second_free = first_wat.indexOf("call $__free", first_free + 1);
  const second_replace = first_wat.indexOf(
    "local.set $text",
    first_replace + 1,
  );
  assert_equals(first_free < first_replace, true);
  assert_equals(first_replace < second_free, true);
  assert_equals(second_free < second_replace, true);

  const second_wat = Emit.emit(Mod, Core.mod(core));
  assert_equals(second_wat, first_wat);
  assert_equals(core.cleanup_emission?.length, 3);

  const frozen = Source.core(Source.parse(`
let text: Text = append("a", "b")
let shared: Text = freeze text
len(shared)
`));
  const frozen_wat = Emit.emit(Mod, Core.mod(frozen));
  assert_equals(
    frozen.cleanup_emission?.some((row) => row.owner === "text"),
    false,
  );
  assert_equals(
    frozen_wat.includes("local.get $text\n    call $__free"),
    false,
  );
});

Deno.test("Core cleanup emission respects nested loop targets and alternatives", () => {
  const nested_source = `
for i in 0..1 {
  let outer: Text = append("a", "b")
  for j in 0..1 {
    let inner: Text = append("c", "d")
    break
  }
  len(outer)
}
0
`;
  const nested = Source.core(Source.parse(nested_source));
  const nested_wat = Emit.emit(Mod, Core.mod(nested));

  assert_equals(
    nested.cleanup_emission?.map((row) => {
      return {
        owner: row.owner,
        edge: row.edge,
        scope: row.scope,
        statement_path: row.statement_path,
      };
    }),
    [
      {
        owner: "inner",
        edge: "break_exit",
        scope: "loop#1",
        statement_path: [0, 0, 1, 0, 1],
      },
      {
        owner: "outer",
        edge: "scope_exit",
        scope: "loop#0",
        statement_path: [0, 0, 2],
      },
    ],
  );
  const inner_free = nested_wat.indexOf("local.get $inner", 0);
  const inner_break = nested_wat.indexOf("br $range_exit_2", inner_free);
  const outer_free = nested_wat.indexOf("local.get $outer", inner_break);
  assert_equals(inner_free >= 0, true);
  assert_equals(inner_free < inner_break, true);
  assert_equals(inner_break < outer_free, true);

  const alternatives = Source.core(Source.parse(`
let flag = 1
let text: Text = if flag {
  append("a", "b")
} else {
  append("c", "d")
}
1
`));
  Emit.emit(Mod, Core.mod(alternatives));
  assert_equals(alternatives.cleanup_emission?.[0]?.allocation_ids, [
    "allocation#0",
    "allocation#1",
  ]);
  assert_equals(alternatives.cleanup_emission?.[0]?.statement_path, [2]);
});
