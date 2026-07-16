import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Core, type Core as CoreNode, type CoreExpr } from "../core.ts";
import { TestSource as Source } from "../frontend/test_source.ts";
import { Mod } from "../mod.ts";
import { Data, Emit, Format, Typed } from "../trait.ts";

Deno.test("Core.proof rejects unknown host boundary ownership", () => {
  const scalar_host_call = Source.core(Source.parse(`
let value: I32 = 41
0
`));
  scalar_host_call.statements.splice(1, 0, {
    tag: "expr",
    expr: {
      tag: "app",
      func: { tag: "var", name: "host_scalar" },
      args: [{ tag: "var", name: "value" }],
    },
  });
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
0
`));
  unique_text_host_call.statements.splice(1, 0, {
    tag: "expr",
    expr: {
      tag: "app",
      func: { tag: "var", name: "host_use" },
      args: [{ tag: "var", name: "message" }],
    },
  });
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
host_import print from "env.print" (I32, &Text) => I32

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
host_import print from "env.print" (I32, &Text) => I32

let !io: I32 = 1
let print_once = () => io.print("hello")
io = print_once()
io
`;
  const captured_linear_core = Source.core(
    Source.parse(captured_linear_source),
  );

  const captured_linear_proof = Core.proof(captured_linear_core);
  assert_equals(captured_linear_proof.issues, []);
  assert_equals(captured_linear_proof.closure_ownership.edges[0], {
    id: "closure_capture#0",
    scope: "program#0",
    expression: "lam",
    captures: [
      {
        name: "io",
        ownership: { tag: "scalar_local", type: "i32" },
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
      },
    ],
    decision: {
      tag: "allowed",
      reason: "linear captures move into a one-shot closure environment",
    },
    callable: "once",
    environment_storage: "persistent_unique_heap",
  });
  assert_equals(
    captured_linear_proof.allocations.facts.some((fact) => {
      return fact.reason === "closure" &&
        fact.storage === "persistent_unique_heap";
    }),
    true,
  );
  assert_equals(
    captured_linear_proof.cleanup_rows.some((row) => {
      return row.tag === "heap_drop" && row.owner === "print_once";
    }),
    true,
  );
  const captured_linear_wat = Source.wat(captured_linear_source);
  assert_includes(captured_linear_wat, "i32.store offset=4");
  assert_includes(captured_linear_wat, "call_indirect");
  assert_includes(captured_linear_wat, "call $print");

  const branch_linear_source = `
host_import print from "env.print" (I32, &Text) => I32

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
host_import print from "env.print" (I32, &Text) => I32

let !io: I32 = 1
let flag = 0
let print_once = if flag {
  (message: Text) => io.print(&message)
} else {
  (text: Text) => io.print(&text)
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
type ResultType = | .ok = Text | .err = Text
const result_type = ResultType

host_import print from "env.print" (I32, &Text) => I32

let !io: I32 = 1
let flag = 1
let result: result_type = if flag {
  result_type.ok("world")
} else {
  result_type.err("fallback")
}
let print_once = if let .ok(value) = result {
  () => io.print(&value)
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
type ResultType = | .ok = Text | .err
const result_type = ResultType

host_import print from "env.print" (I32, &Text) => I32

let !io: I32 = 1
let flag = 1
let make = if flag {
  (x: Text) => result_type.ok(x)
} else {
  (x: Text) => result_type.err()
}
let result: result_type = make("world")
let print_once = if let .ok(value) = result {
  () => io.print(&value)
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

  const runtime_if_let_allocations = Core.allocations(
    runtime_if_let_payload_linear_core,
  ).facts;
  const runtime_if_let_payload_linear_proof = Core.proof(
    runtime_if_let_payload_linear_core,
  );
  assert_equals(
    runtime_if_let_allocations.filter((fact) => {
      return fact.owner !== "result";
    }).map((fact) => {
      const { owner: _owner, ...metadata } = fact;
      return metadata;
    }),
    [
      {
        id: "allocation#0",
        allocation_id: "allocation#0",
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: { tag: "unique_heap", reason: "closure" },
        reason: "closure",
        expression: "lam",
        byte_size: {
          tag: "runtime",
          formula: "align8(4 + capture_slot_bytes)",
        },
        alignment: 8,
        layout: "closure_env.table_index_and_capture_slots",
      },
      {
        id: "allocation#1",
        allocation_id: "allocation#1",
        scope: "closure#0",
        storage: "persistent_unique_heap",
        ownership: { tag: "unique_heap", reason: "runtime_union" },
        reason: "runtime_union",
        expression: "union_case",
        byte_size: { tag: "runtime", formula: "4 + aligned_payload_size" },
        alignment: 4,
        layout: "runtime_union.tag_and_aligned_payload",
      },
      {
        id: "allocation#2",
        allocation_id: "allocation#2",
        scope: "block#1",
        storage: "persistent_unique_heap",
        ownership: { tag: "unique_heap", reason: "closure" },
        reason: "closure",
        expression: "lam",
        byte_size: {
          tag: "runtime",
          formula: "align8(4 + capture_slot_bytes)",
        },
        alignment: 8,
        layout: "closure_env.table_index_and_capture_slots",
      },
      {
        id: "allocation#3",
        allocation_id: "allocation#3",
        scope: "closure#1",
        storage: "persistent_unique_heap",
        ownership: { tag: "unique_heap", reason: "runtime_union" },
        reason: "runtime_union",
        expression: "union_case",
        byte_size: { tag: "runtime", formula: "4 + aligned_payload_size" },
        alignment: 4,
        layout: "runtime_union.tag_and_aligned_payload",
      },
      {
        id: "allocation#4",
        allocation_id: "allocation#4",
        scope: "block#2",
        storage: "persistent_unique_heap",
        ownership: { tag: "unique_heap", reason: "closure" },
        reason: "closure",
        expression: "lam",
        byte_size: {
          tag: "runtime",
          formula: "align8(4 + capture_slot_bytes)",
        },
        alignment: 8,
        layout: "closure_env.table_index_and_capture_slots",
      },
      {
        id: "allocation#5",
        allocation_id: "allocation#5",
        scope: "block#3",
        storage: "persistent_unique_heap",
        ownership: { tag: "unique_heap", reason: "closure" },
        reason: "closure",
        expression: "lam",
        byte_size: {
          tag: "runtime",
          formula: "align8(4 + capture_slot_bytes)",
        },
        alignment: 8,
        layout: "closure_env.table_index_and_capture_slots",
      },
    ],
  );
  assert_equals(
    runtime_if_let_payload_linear_proof.drops.steps.some((step) => {
      return step.tag === "heap_drop" && step.owner === "result" &&
        step.layout === "runtime_union.tag_and_aligned_payload";
    }),
    true,
  );
  assert_equals(runtime_if_let_payload_linear_proof.issues, []);
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
host_import print from "env.print" (I32, &Text) => I32

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
host_import print from "env.print" (I32, &Text) => I32

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
host_import print from "env.print" (I32, &Text) => I32

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
host_import print from "env.print" (I32, &Text) => I32

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
host_import print from "env.print" (I32, &Text) => I32

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
host_import print from "env.print" (I32, &Text) => I32

let !io: I32 = 1
io.print("hello")
io
`)),
    "Linear value io is consumed but not rebound",
  );

  const narrowed_method_table_source = `
host_import print from "env.print" (I32, &Text) => I32
host_import read from "env.read" (I32) => I32

const output = [.print = print]
let !io: I32 = 1
io = output.print(!io, "hello")
io
`;
  const narrowed_method_table = Source.core(
    Source.parse(narrowed_method_table_source),
  );
  const narrowed_method_table_proof = Core.proof(narrowed_method_table);
  assert_equals(narrowed_method_table.capability_methods, [
    { table: "output", method: "print", host_import: "print" },
  ]);
  assert_equals(narrowed_method_table_proof.capability_method_rows, [
    { table: "output", method: "print", host_import: "print" },
  ]);
  assert_equals(narrowed_method_table_proof.host_boundary_rows.length, 1);
  assert_equals(narrowed_method_table_proof.issues, []);
  assert_includes(Source.wat(narrowed_method_table_source), "call $print");

  const narrowed_missing_method = Source.core(Source.parse(`
host_import print from "env.print" (I32, &Text) => I32
host_import read from "env.read" (I32) => I32

const output = [.print = print]
let !io: I32 = 1
io = output.read(!io)
io
`));
  assert_equals({
    missing_edge: Core.proof(narrowed_missing_method).issues[0]?.missing_edge,
    message: Core.proof(narrowed_missing_method).issues[0]?.message,
  }, {
    missing_edge: "unsupported_codegen",
    message: "Missing host capability method: output.read",
  });

  assert_throws(
    () =>
      Source.core(Source.parse(`
host_import print from "env.print" (I32, &Text) => I32

const output = [.print = print]
let !io: I32 = 1
output.print(!io, "hello")
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
host_import print from "env.print" (I32, &Text) => I32

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

Deno.test("Source.core lowers runtime capability method tables", () => {
  const source = `
host_import consume from "env.consume" (Text) => I32
let flag = 1
let output = if flag {
  [.marker = runtime_i32_slice(1, 7), .consume = consume]
} else {
  [.marker = runtime_i32_slice(1, 8), .consume = consume]
}
output.consume(append("A", "da"))
`;
  const core = Source.core(Source.parse(source));
  const proof = Core.proof(core);

  assert_equals(core.capability_methods, [{
    table: "output",
    method: "consume",
    host_import: "consume",
    representation: "runtime_aggregate",
  }]);
  const output_stmt = core.statements.find((stmt) => {
    return stmt.tag === "bind" && stmt.name === "output";
  });
  if (!output_stmt || output_stmt.tag !== "bind") {
    throw new Error("Missing runtime capability output binding");
  }
  if (output_stmt.value.tag !== "if") {
    throw new Error("Runtime capability output must remain conditional");
  }
  const branch_types: CoreExpr[] = [];
  for (
    const branch of [
      output_stmt.value.then_branch,
      output_stmt.value.else_branch,
    ]
  ) {
    if (branch.tag !== "block") {
      throw new Error("Runtime capability branch must be a block");
    }
    const final_stmt = branch.statements[branch.statements.length - 1];
    if (
      !final_stmt || final_stmt.tag !== "expr" ||
      final_stmt.expr.tag !== "struct_value"
    ) {
      throw new Error("Runtime capability branch must return a struct");
    }
    branch_types.push(final_stmt.expr.type_expr);
  }
  assert_equals(branch_types, [
    {
      tag: "struct_type",
      fields: [{ name: "marker", type_name: "I32" }],
    },
    {
      tag: "struct_type",
      fields: [{ name: "marker", type_name: "I32" }],
    },
  ]);
  assert_equals(proof.issues, []);
  assert_equals(proof.capability_method_rows, core.capability_methods);
  const output_allocation = proof.allocations.facts.find((fact) => {
    return fact.reason === "runtime_aggregate" && fact.owner === "output" &&
      fact.expression === "if";
  });
  if (!output_allocation) {
    throw new Error("Missing runtime capability owner allocation");
  }
  assert_equals(output_allocation.owned_children, [{
    allocation_ids: ["allocation#1", "allocation#2"],
    offset: 0,
    ownership: { tag: "unique_heap", reason: "runtime_aggregate" },
    layout: "runtime_slice.length_and_i32_elements",
  }]);
  const output_drop = proof.drops.steps.find((step) => {
    return step.tag === "heap_drop" && step.owner === "output";
  });
  assert_equals(output_drop?.allocation_id, output_allocation.allocation_id);
  assert_equals(output_drop?.owned_children, output_allocation.owned_children);
  assert_equals(
    proof.drops.steps.some((step) => {
      return step.tag === "host_transfer" && step.callee === "consume";
    }),
    true,
  );
  const wat = Source.wat(source);
  assert_includes(wat, "call $consume");
  assert_includes(wat, "call $__alloc");

  assert_throws(
    () =>
      Source.wat(`
host_import consume_a from "env.consume_a" (Text) => I32
host_import consume_b from "env.consume_b" (Text) => I32
let flag = 1
let output = if flag {
  [.marker = runtime_i32_slice(1, 7), .consume = consume_a]
} else {
  [.marker = runtime_i32_slice(1, 8), .consume = consume_b]
}
output.consume(append("A", "da"))
`),
    "Missing host capability method: output.consume",
  );
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
host_import host_read from "env.read" (&Text) => I32

let read = msg => host_read(msg)
let message: Text = append("a", "b")
read(&message)
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
host_import host_read from "env.read" (&Text) => I32

let read = msg => {
  host_read(msg)
}
let message: Text = append("a", "b")
read(&message)
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
host_import host_read from "env.read" (&Text) => I32

let read = (msg: Text) => {
  let view = &msg
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
host_import host_read from "env.read" (&Text) => I32

let read = rec (msg: Text) => host_read(msg)
let message: Text = append("a", "b")
read(&message)
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
host_import host_read from "env.read" (&Text) => I32

let flag = 1
let read = if flag {
  (msg: Text) => host_read(msg)
} else {
  (msg: Text) => host_read(msg)
}
let message: Text = append("a", "b")
read(&message)
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
host_import host_read from "env.read" (&Text) => I32

let read = value => host_read(value)
let relay = (const f, msg: Text) => f(&msg)
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
host_import host_read from "env.read" (&Text) => I32

let read = value => host_read(value)
let relay = (const f, msg: Text) => {
  let g = f
  g(&msg)
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
host_import host_read from "env.read" (&Text) => I32

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
host_import host_read from "env.read" (&Text) => I32

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
host_import host_read from "env.read" (&Text) => I32

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
host_import host_read from "env.read" (&Text) => I32

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
host_import host_read from "env.read" (&Text) => I32

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
host_import host_read from "env.read" (&Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
host_import host_take from "env.take" (Text) => I32

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
      runtime: "reusable_free_list_allocator",
      allocation_id: "allocation#0",
      byte_size: {
        tag: "runtime",
        formula: "4 + runtime_byte_length",
      },
      alignment: 4,
      layout: "runtime_text.length_prefixed_utf8",
      reason:
        "unique_heap text scope exit lowers to __free with reusable allocator",
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

Deno.test("Core transfers block-wrapped runtime union payload owners", () => {
  const source = `
const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .age= Int }
type ResultType = | .ok = user_type | .err
let seed = 41
let user: user_type = [.age = seed] as user_type
let result: ResultType = ResultType.ok({
  let alias = user
  alias
})
if let .ok(found) = result { found.age } else { 0 }
`;
  const core = Source.core(Source.parse(source));
  const proof = Core.proof(core);

  assert_equals(proof.issues, []);
  assert_equals(proof.transfers.transfers, [{
    id: "transfer#0",
    scope: "program#0",
    owner: "user",
    callee: "union_case.ok",
    argument: 0,
  }]);
  assert_equals(
    proof.allocations.facts.some((fact) => {
      return fact.reason === "runtime_aggregate" &&
        fact.layout === "runtime_aggregate.aligned_fields" &&
        fact.alignment === 8 &&
        fact.ownership.tag === "unique_heap";
    }),
    true,
  );
  assert_equals(
    proof.allocations.facts.some((fact) => {
      return fact.reason === "runtime_union" &&
        fact.layout === "runtime_union.tag_and_aligned_payload" &&
        fact.alignment === 4 &&
        fact.ownership.tag === "unique_heap";
    }),
    false,
  );
  assert_equals(
    proof.drops.steps.map((step) => {
      return {
        owner: step.owner,
        reason: step.ownership.reason,
        allocation_id: step.allocation_id,
      };
    }),
    [{
      owner: "user",
      reason: "runtime_aggregate",
      allocation_id: "allocation#0",
    }],
  );
  const wat = Source.wat(source);
  assert_includes(wat, "i32.store offset=4");
  assert_includes(wat, "i32.load offset=4");
  assert_includes(wat, "call $__free");

  assert_throws(
    () =>
      Core.check_proof(Source.core(Source.parse(source.replace(
        "if let .ok(found) = result { found.age } else { 0 }",
        "user.age",
      )))),
    "Use of transferred owner user after ownership transfer transfer#0 to " +
      "union_case.ok",
  );
});

Deno.test("Core proof resolves locals declared in if-let statement bodies", () => {
  const core = Source.core(Source.parse(`
type ResultType = | .ok = Text | .err = Text
const result_type = ResultType
let flag = 1
let result: result_type = if flag {
  result_type.ok("yes")
} else {
  result_type.err("no")
}
if let .ok(value) = result {
  let decorated: Text = append(value, "!")
  freeze decorated
}
0
`));
  const proof = Core.proof(core);

  assert_equals(proof.issues, []);
  assert_equals(proof.freeze_edges.length, 1);
  Core.check_proof(core);
});

Deno.test("Core checks fixed array annotation lengths and elements", () => {
  const values = Source.core(Source.parse(`
let values: [Int; 3] = [1, 2, 3]
values[2]
`));
  assert_equals(Typed.type(Core, values), "i32");
  assert_includes(
    Source.wat(`
let values: [Int; 3] = [1, 2, 3]
values[2]
`),
    "i32.const 3",
  );

  const empty = Source.core(Source.parse(`
let values: [Int; 0] = []
0
`));
  assert_equals(Typed.type(Core, empty), "i32");

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let values: [Int; 3] = [1, 2]
0
`)),
      ),
    "Core binding annotation expects [Int; 3] with 3 items, got 2",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let values: [Int; 2] = [1, 2i64]
0
`)),
      ),
    "Core binding annotation [Int; 2] item 1",
  );

  assert_throws(
    () =>
      Typed.type(
        Core,
        Source.core(Source.parse(`
let width = 2
let values: [Int; width] = [1, 2]
0
`)),
      ),
    "Fixed array length requires a compile-time natural: width",
  );

  const const_length = Source.core(Source.parse(`
const width = 2
let values: [Int; width] = [1, 2]
values[1]
`));
  assert_equals(Typed.type(Core, const_length), "i32");
});

Deno.test("Core keeps branch-local aggregate union payloads allocated until their union drops", () => {
  const core = Source.core(Source.parse(`
host_import choose from "env.choose" () => I32
host_import seed from "env.seed" () => I32

const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .name= Text, .age= I32 }
type ResultType = | .ok = user_type | .err
const result_type = ResultType

let result: result_type = if choose() {
  let chosen: user_type = [.name = append("A", "da"), .age = seed()] as user_type
  result_type.ok(chosen)
} else {
  let fallback: user_type = [.name = append("Gr", "ace"), .age = seed()] as user_type
  result_type.ok(fallback)
}

if let .ok(user) = result { len(user.name) + user.age } else { 0 }
`));
  const proof = Core.proof(core);
  const aggregate_allocations = proof.allocations.facts.filter((fact) => {
    return fact.reason === "runtime_aggregate";
  });

  assert_equals(proof.issues, []);
  assert_equals(aggregate_allocations.length, 2);
  assert_equals(
    proof.drops.steps.some((step) => {
      return aggregate_allocations.some((fact) => {
        return step.allocation_id === fact.allocation_id;
      });
    }),
    false,
  );
  Core.check_proof(core);
  assert_includes(Emit.emit(Mod, Core.mod(core)), "call $__alloc");
});

Deno.test("Core materializes generated bindings in scoped static calls", () => {
  const core = Source.core(Source.parse(`
host_import seed from "env.seed" () => I32

const { struct } = comptime (import "duck:prelude")()
const user_type = struct { .name= Text, .age= I32 }
type ResultType = | .ok = user_type | .err
const result_type = ResultType

const pack = (user: user_type) => {
  let local: user_type = user
  result_type.ok(local)
}

let user: user_type = [.name = append("A", "da"), .age = seed()] as user_type
let result: result_type = pack(user)
if let .ok(found) = result { len(found.name) + found.age } else { 0 }
`));
  const proof = Core.proof(core);
  const wat = Emit.emit(Mod, Core.mod(core));

  assert_equals(proof.issues, []);
  Core.check_proof(core);
  assert_includes(
    wat,
    "local.set $_local_local#",
  );
  assert_includes(
    wat,
    "local.get $result\n" +
      "    i32.load offset=4\n" +
      "    i32.load offset=0\n" +
      "    call $__free",
  );
});
