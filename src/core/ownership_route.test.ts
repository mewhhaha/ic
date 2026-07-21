import { assert_equals, assert_includes, assert_throws } from "../assert.ts";
import { Core, type Core as CoreNode, type CoreExpr } from "../core.ts";
import { core_borrow_plan, core_validate_borrow_plan } from "./borrow.ts";
import { core_escape_analysis } from "./escape.ts";
import {
  core_borrow_lifetime_decision,
  core_freeze_lifetime_decision,
  core_scratch_return_lifetime_decision,
} from "./lifetime.ts";
import { core_expr_ownership } from "./ownership.ts";
import { TestSource as Source } from "../frontend/test_source.ts";
import { Mod } from "../mod.ts";
import { Emit, Format, Typed } from "../trait.ts";

function drop_plan_without_allocation_links(
  plan: ReturnType<typeof Core.drops>,
): { steps: Record<string, unknown>[] } {
  const steps: Record<string, unknown>[] = [];

  for (const step of plan.steps) {
    if (step.tag === "heap_drop") {
      const {
        allocation_id: _allocation_id,
        allocation_ids: _allocation_ids,
        byte_size: _byte_size,
        alignment: _alignment,
        layout: _layout,
        ...drop
      } = step;
      steps.push(drop);
      continue;
    }

    steps.push({ ...step });
  }

  return { steps };
}

Deno.test("Core.emit preserves scalar ownership and scratchpad nodes", () => {
  const borrowed = Source.core(Source.parse("&(1 + 2)"));
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
@len(message)
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
    Source.parse('scratch { &"temp" }'),
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
  if true {
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
let scale = x => &(x + factor)
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
    Source.parse("(message: Text) => @len(&message)"),
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
    Source.parse("(message: Text) => &message"),
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
(message: Bytes) => {
  &message
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
(message: Bytes) => {
  let alias = message
  &alias
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let user: user_type = [.name = "A", .age = 1] as user_type
&user.name
user = [.name = "B", .age = 2] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let user: user_type = [.name = "A", .age = 1] as user_type
let name = user.name
let other = name
&other
user = [.name = "B", .age = 2] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let user: user_type = [.name = "A", .age = 1] as user_type
let name = {
  let inner = user.name
  inner
}
&name
user = [.name = "B", .age = 2] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let user: user_type = [.name = "A", .age = 1] as user_type
let view = {
  let inner = &user.name
  inner
}
user = [.name = "B", .age = 2] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = true
let user: user_type = [.name = "A", .age = 1] as user_type
let name = {
  let inner: Text = "fallback"
  if flag {
    inner = user.name
  }
  inner
}
&name
user = [.name = "B", .age = 2] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = true
let user: user_type = [.name = "A", .age = 1] as user_type
let other: user_type = [.name = "C", .age = 3] as user_type
let name = {
  let inner: Text = "fallback"
  if flag {
    inner = user.name
  } else {
    inner = other.name
  }
  inner
}
&name
user = [.name = "B", .age = 2] as user_type
other = [.name = "D", .age = 4] as user_type
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
type MaybeText = | \`Some Text | \`None Unit
const maybe_text = MaybeText
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let target: maybe_text = \`Some ("hit")
let user: user_type = [.name = "A", .age = 1] as user_type
let name = {
  let inner: Text = "fallback"
  if let \`Some value = target {
    inner = user.name
  }
  inner
}
&name
user = [.name = "B", .age = 2] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let n = 1
let user: user_type = [.name = "A", .age = 1] as user_type
let name = {
  let inner: Text = "fallback"
  for i in 0..n {
    inner = user.name
  }
  inner
}
&name
user = [.name = "B", .age = 2] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Bytes,
  .age= Int
}

let user: user_type = [.name = @Utf8.encode("A"), .age = 1] as user_type
let name = user.name
&name
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = true
let user: user_type = [.name = "A", .age = 1] as user_type
let name: Text = "fallback"
if flag {
  name = user.name
}
&name
user = [.name = "B", .age = 2] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let n = 1
let user: user_type = [.name = "A", .age = 1] as user_type
let name: Text = "fallback"
for i in 0..n {
  name = user.name
}
&name
user = [.name = "B", .age = 2] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let user: user_type = [.name = "A", .age = 1] as user_type
let name: Text = "fallback"
for i in 0..1 {
  break
  name = user.name
}
&name
user = [.name = "B", .age = 2] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = true
let user: user_type = [.name = "A", .age = 1] as user_type
let other: user_type = [.name = "C", .age = 3] as user_type
let name: Text = "fallback"
if flag {
  name = user.name
} else {
  name = other.name
}
&name
user = [.name = "B", .age = 2] as user_type
other = [.name = "D", .age = 4] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = true
let user: user_type = [.name = "A", .age = 1] as user_type
let other: user_type = [.name = "C", .age = 3] as user_type
let name = if flag { user.name } else { other.name }
&name
user = [.name = "B", .age = 2] as user_type
other = [.name = "D", .age = 4] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = true
let user: user_type = [.name = "A", .age = 1] as user_type
let name = if flag { user.name } else { "fallback" }
&name
user = [.name = "B", .age = 2] as user_type
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
type MaybeText = | \`Some Text | \`None Unit
const maybe_text = MaybeText
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let target: maybe_text = \`Some ("hit")
let user: user_type = [.name = "A", .age = 1] as user_type
let name = if let \`Some value = target { user.name } else { "fallback" }
&name
user = [.name = "B", .age = 2] as user_type
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
type MaybeText = | \`Some Text | \`None Unit
const maybe_text = MaybeText
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let target: maybe_text = \`Some ("hit")
let user: user_type = [.name = "A", .age = 1] as user_type
let other: user_type = [.name = "C", .age = 3] as user_type
let name = if let \`Some value = target { user.name } else { other.name }
&name
user = [.name = "B", .age = 2] as user_type
other = [.name = "D", .age = 4] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = true
let user: user_type = [.name = "A", .age = 1] as user_type
let view = if flag { &user.name } else { "fallback" }
user = [.name = "B", .age = 2] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = true
let user: user_type = [.name = "A", .age = 1] as user_type
let other: user_type = [.name = "C", .age = 3] as user_type
let view = if flag { &user.name } else { &other.name }
user = [.name = "B", .age = 2] as user_type
other = [.name = "D", .age = 4] as user_type
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
type MaybeText = | \`Some Text | \`None Unit
const maybe_text = MaybeText
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let target: maybe_text = \`Some ("hit")
let user: user_type = [.name = "A", .age = 1] as user_type
let view = if let \`Some value = target { &user.name } else { "fallback" }
user = [.name = "B", .age = 2] as user_type
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
type MaybeText = | \`Some Text | \`None Unit
const maybe_text = MaybeText
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let target: maybe_text = \`Some ("hit")
let user: user_type = [.name = "A", .age = 1] as user_type
let name: Text = "fallback"
if let \`Some value = target {
  name = user.name
}
&name
user = [.name = "B", .age = 2] as user_type
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
type MaybeText = | \`Some Text | \`None Unit
const maybe_text = MaybeText
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let target: maybe_text = \`Some ("hit")
let user: user_type = [.name = "A", .age = 1] as user_type
let name: Text = "fallback"
if let \`Some value = target {
  name = &user.name
}
user = [.name = "B", .age = 2] as user_type
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

  const if_let_payload_borrow_blocks_union_owner_assignment = Source.core(
    Source.parse(`
type ResultType = | \`Ok Text | \`Err Unit
const result_type = ResultType

let result: result_type = \`Ok ("Ada")
let view: Text = "fallback"
if let \`Ok value = result {
  view = &value
}
result = \`Ok ("Grace")
@len(view)
`),
  );
  assert_equals(
    Core.validate_borrows(if_let_payload_borrow_blocks_union_owner_assignment),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "result",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () =>
      Core.check_borrows(
        if_let_payload_borrow_blocks_union_owner_assignment,
      ),
    "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
  );
  assert_equals(
    Core.proof(if_let_payload_borrow_blocks_union_owner_assignment).issues.map(
      (issue) => issue.message,
    ),
    [
      "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
    ],
  );
  assert_throws(
    () => Core.check_proof(if_let_payload_borrow_blocks_union_owner_assignment),
    "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
  );
  assert_throws(
    () => Emit.emit(Core, if_let_payload_borrow_blocks_union_owner_assignment),
    "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
  );

  const if_let_aggregate_payload_borrow_blocks_union_owner_assignment = Source
    .core(
      Source.parse(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .score= Int
}
type ResultType = | \`Ok user_type | \`Err Unit
const result_type = ResultType

let start = 1
let user: user_type = [.age = 40, .score = start] as user_type
let result: result_type = \`Ok (user)
let view = if let \`Ok value = result {
  &value
} else {
  [.age = 0, .score = 0] as user_type
}
result = \`Ok ([.age = 5, .score = start] as user_type)
0
`),
    );
  assert_equals(
    Core.validate_borrows(
      if_let_aggregate_payload_borrow_blocks_union_owner_assignment,
    ),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "result",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_equals(
    Core.proof(
      if_let_aggregate_payload_borrow_blocks_union_owner_assignment,
    ).issues.map((issue) => issue.message),
    [
      "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
    ],
  );
  assert_throws(
    () =>
      Core.check_proof(
        if_let_aggregate_payload_borrow_blocks_union_owner_assignment,
      ),
    "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
  );
  assert_throws(
    () =>
      Emit.emit(
        Core,
        if_let_aggregate_payload_borrow_blocks_union_owner_assignment,
      ),
    "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
  );

  const if_let_nested_union_payload_borrow_blocks_union_owner_assignment =
    Source.core(
      Source.parse(`
type InnerType = | \`Some Int | \`None Unit
const inner_type = InnerType
type ResultType = | \`Ok inner_type | \`Err Unit
const result_type = ResultType

let start = 1
let inner: inner_type = \`Some (start)
let result: result_type = \`Ok (inner)
let view = if let \`Ok value = result {
  &value
} else {
  \`None ()
}
result = \`Ok (\`Some (start + 1))
0
`),
    );
  assert_equals(
    Core.validate_borrows(
      if_let_nested_union_payload_borrow_blocks_union_owner_assignment,
    ),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "program#0",
            owner: "result",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_equals(
    Core.proof(
      if_let_nested_union_payload_borrow_blocks_union_owner_assignment,
    ).issues.map((issue) => issue.message),
    [
      "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
    ],
  );
  assert_throws(
    () =>
      Core.check_proof(
        if_let_nested_union_payload_borrow_blocks_union_owner_assignment,
      ),
    "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
  );
  assert_throws(
    () =>
      Emit.emit(
        Core,
        if_let_nested_union_payload_borrow_blocks_union_owner_assignment,
      ),
    "Cannot move or replace borrowed owner result in program#0 while borrow#0 is active",
  );

  const if_let_scalar_payload_borrow_allows_union_owner_assignment = Source
    .core(
      Source.parse(`
type ResultType = | \`Ok Int | \`Err Unit
const result_type = ResultType

(start: Int) => {
  let result: result_type = \`Ok (start)
  let view: Int = if let \`Ok value = result { &value } else { 0 }
  result = \`Ok (start + 1)
  view
}
`),
    );
  assert_equals(
    Core.validate_borrows(
      if_let_scalar_payload_borrow_allows_union_owner_assignment,
    ),
    {
      ok: true,
      issues: [],
    },
  );
  assert_equals(
    Core.proof(
      if_let_scalar_payload_borrow_allows_union_owner_assignment,
    ).ok,
    true,
  );
  assert_equals(
    Typed.type(
      Core,
      if_let_scalar_payload_borrow_allows_union_owner_assignment,
    ),
    "i32",
  );
  assert_includes(
    Emit.emit(
      Mod,
      Core.mod(if_let_scalar_payload_borrow_allows_union_owner_assignment),
    ),
    "local.set $view",
  );

  const if_let_payload_borrow_result_blocks_union_owner_assignment = Source
    .core(
      Source.parse(`
type ResultType = | \`Ok Text | \`Err Unit
const result_type = ResultType

(start: Int) => {
  let result: result_type = \`Ok (@slice("Ada", start, 3))
  let view: Text = if let \`Ok value = result { &value } else { "fallback" }
  result = \`Ok (@slice("Grace", start, 5))
  @len(view)
}
`),
    );
  assert_equals(
    Core.validate_borrows(
      if_let_payload_borrow_result_blocks_union_owner_assignment,
    ),
    {
      ok: false,
      issues: [
        {
          tag: "borrowed_owner_barrier",
          barrier: {
            scope: "block#0",
            owner: "result",
            action: "assign",
            borrow_id: "borrow#0",
            message:
              "Cannot move or replace borrowed owner result in block#0 while borrow#0 is active",
          },
          message:
            "Cannot move or replace borrowed owner result in block#0 while borrow#0 is active",
        },
      ],
    },
  );
  assert_throws(
    () =>
      Core.check_borrows(
        if_let_payload_borrow_result_blocks_union_owner_assignment,
      ),
    "Cannot move or replace borrowed owner result in block#0 while borrow#0 is active",
  );
  assert_equals(
    Core.proof(
      if_let_payload_borrow_result_blocks_union_owner_assignment,
    ).issues.map((issue) => issue.message),
    [
      "Cannot move or replace borrowed owner result in block#0 while borrow#0 is active",
    ],
  );
  assert_throws(
    () =>
      Core.check_proof(
        if_let_payload_borrow_result_blocks_union_owner_assignment,
      ),
    "Cannot move or replace borrowed owner result in block#0 while borrow#0 is active",
  );
  assert_throws(
    () =>
      Emit.emit(
        Core,
        if_let_payload_borrow_result_blocks_union_owner_assignment,
      ),
    "Cannot move or replace borrowed owner result in block#0 while borrow#0 is active",
  );

  const stored_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  let view = &message
  @len(view)
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
(message: Bytes) => {
  let view = &message
  @len(view)
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

  const freeze_stored_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  let view = &message
  let frozen = freeze message
  @len(view)
}
`));
  assert_equals(Core.validate_borrows(freeze_stored_borrowed_text), {
    ok: false,
    issues: [
      {
        tag: "borrowed_owner_barrier",
        barrier: {
          scope: "block#0",
          owner: "message",
          action: "freeze",
          borrow_id: "borrow#0",
          message:
            "Cannot freeze borrowed owner message in block#0 while borrow#0 is active",
        },
        message:
          "Cannot freeze borrowed owner message in block#0 while borrow#0 is active",
      },
    ],
  });
  assert_equals(
    Core.proof(freeze_stored_borrowed_text).issues.map((issue) =>
      issue.message
    ),
    [
      "Cannot freeze borrowed owner message in block#0 while borrow#0 is active",
    ],
  );
  assert_throws(
    () => Core.check_proof(freeze_stored_borrowed_text),
    "Cannot freeze borrowed owner message in block#0 while borrow#0 is active",
  );
  assert_throws(
    () => Emit.emit(Core, freeze_stored_borrowed_text),
    "Cannot freeze borrowed owner message in block#0 while borrow#0 is active",
  );

  const transfer_stored_borrowed_text = Source.core(Source.parse(`
host_import host_take from "env.take" (Text) => I32

(message: Text) => {
  let view = &message
  host_take(message)
  @len(view)
}
`));
  assert_equals(Core.validate_borrows(transfer_stored_borrowed_text), {
    ok: false,
    issues: [
      {
        tag: "borrowed_owner_barrier",
        barrier: {
          scope: "function_call#0",
          owner: "message",
          action: "transfer",
          borrow_id: "borrow#0",
          message:
            "Cannot transfer borrowed owner message in function_call#0 while borrow#0 is active",
        },
        message:
          "Cannot transfer borrowed owner message in function_call#0 while borrow#0 is active",
      },
    ],
  });
  assert_equals(
    Core.proof(transfer_stored_borrowed_text).issues.map((issue) =>
      issue.message
    ),
    [
      "Cannot transfer borrowed owner message in function_call#0 while borrow#0 is active",
    ],
  );
  assert_throws(
    () => Core.check_proof(transfer_stored_borrowed_text),
    "Cannot transfer borrowed owner message in function_call#0 while borrow#0 is active",
  );
  assert_throws(
    () => Emit.emit(Core, transfer_stored_borrowed_text),
    "Cannot transfer borrowed owner message in function_call#0 while borrow#0 is active",
  );

  const mutate_collection_item_borrow_owner = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const names_type = struct {
  .first= Text,
  .second= Text
}

let start = 0
let first: Text = @slice("Ada", start, 3)
let second: Text = @slice("Grace", start, 5)
let flag = true
let make_names = if flag {
  () => [.first = first, .second = second] as names_type
} else {
  () => [.first = first, .second = second] as names_type
}
let names: names_type = make_names()
let view: Text = ""

for index, name in names {
  view = &name
}

names[0] = "Edsger"
@len(view)
`));
  assert_equals(Core.validate_borrows(mutate_collection_item_borrow_owner), {
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
    "borrow view rooted in collection iteration loop#0 cannot escape to " +
      "program#0",
  );

  const returned_stored_borrowed_text = Source.core(Source.parse(`
(message: Text) => {
  let view = &message
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
  let view = &message
  (x: Int) => @len(view)
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
    view = &message
  }
  @len(view)
}
`));
  assert_equals(Core.validate_borrows(branch_stored_borrowed_text), {
    ok: true,
    issues: [],
  });
  Core.check_borrows(branch_stored_borrowed_text);
  assert_equals(Typed.type(Core, branch_stored_borrowed_text), "i32");

  const mutate_branch_stored_borrowed_text = Source.core(Source.parse(`
(flag: Int, message: Bytes) => {
  let view: Bytes = Bytes.empty
  if flag {
    view = &message
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
    view = &message
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
(message: Bytes) => {
  let view: Bytes = Bytes.empty
  for i in 0..1 {
    view = &message
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
(message: Bytes) => {
  for i in 0..1 {
    &message
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
(message: Bytes) => {
  let view: Bytes = Bytes.empty
  for i in 0..1 {
    break
    view = &message
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
(message: Bytes) => {
  let view: Bytes = Bytes.empty
  for i in 0..1 {
    continue
    view = &message
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
(message: Bytes) => {
  let view: Bytes = Bytes.empty
  for i in 0..1 {
    view = &message
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

  const borrowed_text = Source.core(Source.parse('&"text"'));
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
    Source.parse("x => &x"),
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

  const borrowed_closure = Source.core(Source.parse("&((x: Int) => x)"));
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
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let result: result_type = freeze \`Ok (41)

if let \`Ok value = result {
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
    target_profile: proof.target_profile,
    managed_storage: proof.managed_storage,
    ok: proof.ok,
    issue_count: proof.issues.length,
    final_storage: proof.final_result.storage,
    cleanup_scopes: proof.cleanup.steps.map((step) => step.scope),
    storage_row_tags: proof.storage_rows.map((row) => row.tag),
    lifetime_row_kinds: proof.lifetime_rows.map((row) => row.kind),
    borrow_view_count: proof.borrow_view_rows.length,
    scratch_result_scopes: proof.scratch_result_rows.map((row) => row.scope),
    freeze_promotion_count: proof.freeze_promotion_rows.length,
    cleanup_row_tags: proof.cleanup_rows.map((row) => row.tag),
    host_boundary_count: proof.host_boundary_rows.length,
    drop_count: proof.drops.steps.length,
  }, {
    target: "core-3-nonweb",
    target_profile: "core-3-nonweb",
    managed_storage: "disabled",
    ok: true,
    issue_count: 0,
    final_storage: "scalar_local",
    cleanup_scopes: ["scratch#0"],
    storage_row_tags: ["final_result"],
    lifetime_row_kinds: ["program", "scratch", "block"],
    borrow_view_count: 0,
    scratch_result_scopes: ["scratch#0"],
    freeze_promotion_count: 0,
    cleanup_row_tags: ["scratch_reset"],
    host_boundary_count: 0,
    drop_count: 0,
  });
  Core.check_proof(scalar_scratch);
  assert_equals(Typed.type(Core, scalar_scratch), "i32");

  const static_aggregate = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const user_type = struct { .name = Text, .age = Int }
let xs = [10, 20]
let user: user_type = ["Ada", 41]
let total = 0

for i, x in xs {
  total = total + i + x
}

total + xs[1] + @len(user.name)
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
let user = freeze [.age = 41, .bonus = 1]
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
let user = scratch { [.age = x + 1, .bonus = 1] }
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .name= Text
}
let user: user_type = scratch {
  let temp: Text = freeze @append("Ada", "!")
  [.age = 40, .name = temp] as user_type
}
user.age + @len(user.name)
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .name= Text
}
let user: user_type = scratch {
  let name: Text = freeze @append("Ada", "!")
  let temp: user_type = [.age = 41, .name = name] as user_type
  temp
}
user.age + @len(user.name)
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
const { struct } = import "duck:prelude" ()
const name_type = struct {
  .first= Text,
  .last= Text
}
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .name= name_type
}
let user: user_type = scratch {
  let first: Text = freeze @append("A", "da")
  let name: name_type = [.first = first, .last = "Lovelace"] as name_type
  let temp: user_type = [.age = 40, .name = name] as user_type
  temp
}
@len(user.name.first) + @len(user.name.last) + user.age
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
    ok: true,
    managed_storage: "disabled",
    issue_count: 0,
    scratch_return: [
      {
        scope: "scratch#0",
        return_detail: undefined,
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
  Core.check_proof(scratch_static_nested_aggregate_block_alias);
  const scratch_static_nested_aggregate_block_alias_wat = Emit.emit(
    Mod,
    Core.mod(scratch_static_nested_aggregate_block_alias),
  );
  assert_includes(
    scratch_static_nested_aggregate_block_alias_wat,
    "global.set $__scratch_heap",
  );

  const raw_scratch_static_nested_aggregate_block_alias = Source.core(
    Source.parse(`
const { struct } = import "duck:prelude" ()
const name_type = struct {
  .first= Text,
  .last= Text
}
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .name= name_type
}
scratch {
  let first: Text = @append("A", "da")
  let name: name_type = [.first = first, .last = "Lovelace"] as name_type
  let temp: user_type = [.age = 41, .name = name] as user_type
  temp
}
`),
  );
  const raw_scratch_static_nested_aggregate_block_alias_proof = Core.proof(
    raw_scratch_static_nested_aggregate_block_alias,
  );
  assert_equals(
    raw_scratch_static_nested_aggregate_block_alias_proof.ok,
    false,
  );
  assert_equals(
    raw_scratch_static_nested_aggregate_block_alias_proof.issues[0]
      ?.missing_edge,
    "scratch_backed_result",
  );
  assert_throws(
    () =>
      Emit.emit(Mod, Core.mod(raw_scratch_static_nested_aggregate_block_alias)),
    "Rejected baseline proof scratch#0 scratch_return",
  );

  const scratch_static_union = Source.core(Source.parse(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType
let value = scratch { \`Ok (41) }
if let \`Ok x = value { x } else { 0 }
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
type ResultType = | \`Ok Text | \`Err Int
const result_type = ResultType
let result: result_type = scratch {
  let temp: Text = freeze @append("Ada", "!")
  \`Ok (temp)
}
if let \`Ok value = result { @len(value) } else { 0 }
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
type ResultType = | \`Ok Text | \`Err Int
const result_type = ResultType
let result: result_type = scratch {
  let name: Text = freeze @append("Ada", "!")
  let temp: result_type = \`Ok (name)
  temp
}
if let \`Ok value = result { @len(value) } else { 0 }
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
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType
let flag = true
let value = scratch {
  if flag {
    \`Ok (41)
  } else {
    \`Err (9)
  }
}
if let \`Ok x = value { x } else { 0 }
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
let part: Text = @slice("Grace", 1, 4)
@len(part)
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
let prefix: Text = @slice("Grace", 0, 3)
let part: Text = @append(prefix, "ce")
@len(part)
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
let prefix: Text = @slice("Grace", 0, 3)
let part: Text = freeze @append(prefix, "ce")
@len(part)
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
let prefix: Bytes = @slice(@Utf8.encode("Ada"), 0, 3)
let part: Bytes = freeze @append(prefix, @Utf8.encode("!"))
part[0] = 65
@len(part)
`));
  assert_throws(
    () => Emit.emit(Core, mutating_frozen_runtime_text),
    "Cannot mutate frozen/shareable core binding: part",
  );

  const scratch_frozen_runtime_text = Source.core(Source.parse(`
let prefix: Text = @slice("Ada", 0, 3)
scratch { freeze @append(prefix, "!") }
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
let prefix: Text = @slice("Ada", 0, 3)
scratch {
  let temp: Text = @append(prefix, "!")
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
let prefix: Text = @slice("Ada", 0, 3)
scratch {
  let temp: Text = @append(prefix, "!")
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
let prefix: Text = @slice("Ada", 0, 3)
scratch {
  let temp: Text = {
    let inner: Text = @append(prefix, "!")
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
    let temp: Text = @append(value, "!")
    temp = @append(temp, "?")
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
let flag = true
let freeze_suffix = if flag {
  (value: Text) => {
    scratch {
      let temp: Text = @append(value, "!")
      freeze temp
    }
  }
} else {
  (value: Text) => {
    scratch {
      let temp: Text = @append(value, "?")
      freeze temp
    }
  }
}

let result: Text = freeze_suffix("hi")
@len(result)
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let start = 0
let prefix: Text = @slice("Ada", start, 1)
let user: user_type = scratch {
  freeze ([.name = @append(prefix, "da"), .age = 40] as user_type)
}

@len(user.name) + user.age
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
type ResultType = | \`Ok Text | \`Err Unit
const result_type = ResultType

let start = 0
let prefix: Text = @slice("Ada", start, 1)
let result: result_type = scratch {
  freeze \`Ok (@append(prefix, "da"))
}

if let \`Ok value = result {
  @len(value)
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
type ResultType = | \`Ok Text | \`Err Unit
const result_type = ResultType

let start = 0
let prefix: Text = @slice("Ada", start, 1)

scratch {
  let temp = \`Ok (@append(prefix, "da"))
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}
type ResultType = | \`Ok user_type | \`Err Unit
const result_type = ResultType

let start = 0
let prefix: Text = @slice("Ada", start, 1)

scratch {
  let temp = \`Ok ([.name = @append(prefix, "da"), .age = 40] as user_type)
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
    // The payload aggregate is allocated before its dynamic Text field.
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
type InnerType = | \`Some Text | \`None Unit
const inner_type = InnerType
type OuterType = | \`Ok inner_type | \`Err Unit
const outer_type = OuterType

let start = 0
let prefix: Text = @slice("Ada", start, 1)

scratch {
  let temp = \`Ok (\`Some (@append(prefix, "da")))
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
type ResultType = | \`Ok Text | \`Err Unit
const result_type = ResultType
const { struct } = import "duck:prelude" ()
const box_type = struct {
  .result= result_type,
  .age= Int
}

let start = 0
let prefix: Text = @slice("Ada", start, 1)

scratch {
  let temp = [.result = \`Ok (@append(prefix, "da")), .age = 40] as box_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let start = 0
let prefix: Text = @slice("Ada", start, 1)

scratch {
  let temp: user_type = [.name = @append(prefix, "da"), .age = 40] as user_type
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let start = 0
let prefix: Text = @slice("Ada", start, 1)
let existing: user_type = [.name = @append(prefix, "da"), .age = 40] as user_type

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
          reason: "runtime_aggregate",
        },
        reason: "runtime_aggregate",
        expression: "struct_value",
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

  const chained_alias_scratch_frozen_runtime_aggregate = Source.core(
    Source.parse(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let start = 0
let prefix: Text = @slice("Ada", start, 1)
let existing: user_type = [.name = @append(prefix, "da"), .age = 40] as user_type
let user: user_type = scratch {
  let first = existing
  let second = first
  freeze second
}

@len(user.name) + user.age
`),
  );
  const chained_alias_proof = Core.proof(
    chained_alias_scratch_frozen_runtime_aggregate,
  );
  assert_equals({
    ok: chained_alias_proof.ok,
    scratch_storage: chained_alias_proof.scratch_result_rows[0]?.return_value
      .storage,
    freeze_storage: chained_alias_proof.freeze_promotion_rows[0]?.analysis
      .storage,
    promotion_allocations: chained_alias_proof.storage_rows.filter((row) => {
      return row.tag === "allocation" && row.fact.expression === "freeze";
    }).length,
  }, {
    ok: true,
    scratch_storage: "frozen_heap",
    freeze_storage: "persistent_unique_heap",
    promotion_allocations: 2,
  });
  Core.check_proof(chained_alias_scratch_frozen_runtime_aggregate);
  assert_includes(
    Emit.emit(Mod, Core.mod(chained_alias_scratch_frozen_runtime_aggregate)),
    "block $text_freeze_exit_",
  );

  const chained_alias_unfrozen_runtime_aggregate = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let start = 0
let prefix: Text = @slice("Ada", start, 1)
let existing: user_type = [.name = @append(prefix, "da"), .age = 40] as user_type
let user: user_type = scratch {
  let first = existing
  let second = first
  second
}

@len(user.name) + user.age
`));
  const chained_alias_unfrozen_proof = Core.proof(
    chained_alias_unfrozen_runtime_aggregate,
  );
  assert_equals({
    ok: chained_alias_unfrozen_proof.ok,
    missing_edge: chained_alias_unfrozen_proof.issues[0]?.missing_edge,
  }, {
    ok: false,
    missing_edge: "scratch_backed_result",
  });
  assert_throws(
    () => Core.check_proof(chained_alias_unfrozen_runtime_aggregate),
    "unique_heap runtime_aggregate cannot leave scratch without freeze or " +
      "explicit promotion",
  );

  const branch_assignment_scratch_frozen_runtime_aggregate = Source.core(
    Source.parse(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = true
let start = 0
let prefix: Text = @slice("Ada", start, 1)
let existing: user_type = [.name = @append(prefix, "da"), .age = 40] as user_type
if flag {
  existing = [.name = @append(prefix, "!"), .age = 41] as user_type
} else {
  existing = [.name = @append(prefix, "?"), .age = 42] as user_type
}
let user: user_type = scratch {
  let temp = existing
  freeze temp
}

@len(user.name) + user.age
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
type ResultType = | \`Ok Text | \`Err Int
const result_type = ResultType

let flag = true
let start = 0
let prefix: Text = @slice("Ada", start, 1)
let existing: result_type = if flag {
  \`Ok (@append(prefix, "da"))
} else {
  \`Err (5)
}
let result: result_type = scratch {
  let temp = existing
  freeze temp
}

if let \`Ok value = result {
  @len(value)
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
type ResultType = | \`Ok Text | \`Err Int
const result_type = ResultType

let flag = true
let start = 0
let prefix: Text = @slice("Ada", start, 1)
let existing: result_type = \`Err (5)

if flag {
  existing = \`Ok (@append(prefix, "da"))
} else {
  existing = \`Err (7)
}

let result: result_type = scratch {
  let temp = existing
  freeze temp
}

if let \`Ok value = result {
  @len(value)
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
let add_bang = (value: Text) => { @append(value, "!") }

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
  Core.check_proof(helper_scratch_frozen_runtime_text);

  const branch_scratch_frozen_runtime_text = Source.core(Source.parse(`
let flag = true
let prefix: Text = @slice("Ada", 0, 3)
scratch {
  if flag {
    freeze @append(prefix, "!")
  } else {
    freeze @append(prefix, "?")
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
let flag = true
let prefix: Text = @slice("Ada", 0, 3)
scratch {
  let temp: Text = if flag {
    @append(prefix, "!")
  } else {
    @append(prefix, "?")
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
let flag = true
let prefix: Text = @slice("Ada", 0, 3)
scratch {
  let temp: Text = @append(prefix, ".")
  if flag {
    temp = @append(prefix, "!")
  } else {
    temp = @append(prefix, "?")
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
let prefix: Text = @slice("Ada", 0, 3)
scratch {
  let temp: Text = @append(prefix, ".")
  for i in 0..1 {
    temp = @append(prefix, "!")
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
        edge: "assignment_replace",
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
const { struct } = import "duck:prelude" ()
const xs_type = struct {
  .first= Int,
  .second= Int
}
let prefix: Text = @slice("Ada", 0, 3)
let xs: xs_type = [.first = 1, .second = 2] as xs_type
scratch {
  let temp: Text = @append(prefix, ".")
  for x in xs {
    temp = @append(prefix, "!")
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
type ResultType = | \`Ok Text | \`Err Text
const result_type = ResultType
let flag = true
let result: result_type = if flag {
  \`Ok ("hi")
} else {
  \`Err ("no")
}
scratch {
  let temp: Text = @append("no", ".")
  if let \`Ok value = result {
    temp = @append(value, "!")
  }
  if let \`Err value = result {
    temp = @append(value, "?")
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
        scope: "block#3",
        owner: "temp",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "text",
        },
      },
      {
        edge: "assignment_replace",
        scope: "block#4",
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
        owner: "result",
        storage: "persistent_unique_heap",
        ownership: {
          tag: "unique_heap",
          reason: "runtime_union",
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
type ResultType = | \`Ok Text | \`Err Text
const result_type = ResultType
let flag = true
let result: result_type = if flag {
  \`Ok ("hi")
} else {
  \`Err ("no")
}
scratch {
  if let \`Ok value = result {
    freeze @append(value, "!")
  } else {
    freeze @append("no", "?")
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
type ResultType = | \`Ok Text | \`Err Text
const result_type = ResultType
let flag = true
let result: result_type = if flag {
  \`Ok ("hi")
} else {
  \`Err ("no")
}
scratch {
  if let \`Ok value = result {
    @append(value, "!")
  } else {
    @append("no", "?")
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
      return {
        missing_edge: issue.missing_edge,
        message: issue.message,
      };
    }),
    scratch_return_storage: if_let_unfrozen_scratch_runtime_text_proof.cleanup
      .steps[0]
      ?.return_value.storage,
  }, {
    ok: false,
    managed_storage: "disabled",
    final_storage: "rejected",
    issues: [
      {
        missing_edge: "scratch_backed_result",
        message:
          "Rejected baseline proof scratch#0 scratch_return: unique_heap text " +
          "cannot leave scratch without freeze or explicit promotion",
      },
      {
        missing_edge: "scratch_backed_result",
        message: "Rejected baseline proof final_result: scratch_backed over " +
          "unique_heap text may reference storage reset before the final " +
          "result is used",
      },
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
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let flag = true

scratch {
  if flag {
    \`Ok (41)
  } else {
    \`Err (5)
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .age= Int,
  .score= I64
}

let user: user_type = [.age = 41, .score = 9i64] as user_type
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
    drop_count: 0,
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
let result = \`Ok (payload)
payload = 1

if let \`Ok x = result {
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
    drop_count: 1,
  });
  Core.check_proof(dynamic_union_if_let);

  const typed_union_if_let = Source.core(Source.parse(`
type ResultType = | \`Ok I64 | \`Err I64
const result_type = ResultType

let result: result_type = \`Err (1i64)
let value = if let \`Ok found = result {
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
let flag = true
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
let flag = true
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

  const borrowed_closure = Source.core(Source.parse("&((x: Int) => x)"));
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
let flag = true
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
let flag = true
let message: Text = freeze @append("he", "llo")
let f = if flag {
  (x: Int) => @len(message) + x
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
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let flag = true
let result: result_type = freeze \`Ok (41)
let read_result = if flag {
  (x: Int) => if let \`Ok value = result {
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
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text,
  .age= Int
}

let flag = true
let user: user_type = freeze (
  [.name = @append("Ad", "a"), .age = 41] as user_type
)
let read_user = if flag {
  (x: Int) => @len(user.name) + x
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
let flag = true
let message: Text = @append("he", "llo")
let f = if flag {
  (x: Int) => @len(message) + x
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
let message: Text = @append("he", "llo")
let view = &message
let f = (x: Int) => @len(view) + x

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
  let message: Text = @append("he", "llo")
  ((x: Int) => @len(message) + x)(1)
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
  let message: Text = @append("he", "llo")
  freeze ((x: Int) => @len(message) + x)
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
    Core.proof(scratch_capture_core).issues.map((issue) => {
      return { missing_edge: issue.missing_edge, message: issue.message };
    }),
    [
      {
        missing_edge: "unsupported_ownership_bearing_closure_capture",
        message: "Rejected baseline proof closure_capture#0: message: " +
          "scratch_backed over unique_heap text capture requires linear " +
          "closure ownership support",
      },
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
const { struct } = import "duck:prelude" ()
const pair_type = struct {
  .first= Int,
  .second= Int
}

let flag = true
let make_pair = if flag {
  (first: Int, second: Int) => [.first = first, .second = second] as pair_type
} else {
  (first: Int, second: Int) => [.first = second, .second = first] as pair_type
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
      tag: "reserved",
      reason: "unique_heap runtime_aggregate capture requires linear closure " +
        "ownership support",
    },
  });
  assert_equals(aggregate_plan.edges[0]?.decision, {
    tag: "reserved",
    reason: "pair: unique_heap runtime_aggregate capture requires linear " +
      "closure ownership support",
  });
  assert_equals(
    Core.proof(aggregate_capture_core).closure_ownership,
    aggregate_plan,
  );
  assert_equals(
    Core.proof(aggregate_capture_core).issues.map((issue) => issue.message),
    [
      "Rejected baseline proof closure_capture#0: pair: unique_heap " +
      "runtime_aggregate capture requires linear closure ownership support",
    ],
  );
  assert_throws(
    () => Core.check_proof(aggregate_capture_core),
    "Rejected baseline proof closure_capture#0: pair: unique_heap " +
      "runtime_aggregate capture requires linear closure ownership support",
  );
  assert_throws(
    () => Emit.emit(Mod, Core.mod(aggregate_capture_core)),
    "Rejected baseline proof closure_capture#0: pair: unique_heap " +
      "runtime_aggregate capture requires linear closure ownership support",
  );

  const closure_pointer_capture_core = Source.core(Source.parse(`
let flag = true
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
      tag: "reserved",
      reason: "unique_heap closure capture requires linear closure ownership " +
        "support",
    },
  });
  assert_equals(closure_pointer_plan.edges[0]?.decision, {
    tag: "reserved",
    reason: "add: unique_heap closure capture requires linear closure " +
      "ownership support",
  });
  assert_equals(
    Core.proof(closure_pointer_capture_core).closure_ownership,
    closure_pointer_plan,
  );
  assert_equals(
    Core.proof(closure_pointer_capture_core).issues.map((issue) => {
      return issue.message;
    }),
    [
      "Rejected baseline proof closure_capture#0: add: unique_heap closure " +
      "capture requires linear closure ownership support",
    ],
  );
  assert_throws(
    () => Core.check_proof(closure_pointer_capture_core),
    "Rejected baseline proof closure_capture#0: add: unique_heap closure " +
      "capture requires linear closure ownership support",
  );
  assert_throws(
    () => Emit.emit(Mod, Core.mod(closure_pointer_capture_core)),
    "Rejected baseline proof closure_capture#0: add: unique_heap closure " +
      "capture requires linear closure ownership support",
  );

  const runtime_union_capture_core = Source.core(Source.parse(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let flag = true
let make = if flag {
  (x: Int) => \`Ok (x)
} else {
  (x: Int) => \`Err (x)
}
let result: result_type = make(41)
let read_result = if flag {
  (x: Int) => {
    if let \`Ok value = result {
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
      tag: "reserved",
      reason: "unique_heap runtime_union capture requires linear closure " +
        "ownership support",
    },
  });
  assert_equals(runtime_union_capture_plan.edges[0]?.decision, {
    tag: "reserved",
    reason: "result: unique_heap runtime_union capture requires linear " +
      "closure ownership support",
  });
  assert_equals(
    Core.proof(runtime_union_capture_core).closure_ownership,
    runtime_union_capture_plan,
  );
  assert_equals(
    Core.proof(runtime_union_capture_core).issues.map((issue) => {
      return issue.message;
    }),
    [
      "Rejected baseline proof closure_capture#0: result: unique_heap " +
      "runtime_union capture requires linear closure ownership support",
    ],
  );
  assert_throws(
    () => Core.check_proof(runtime_union_capture_core),
    "Rejected baseline proof closure_capture#0: result: unique_heap " +
      "runtime_union capture requires linear closure ownership support",
  );
  assert_throws(
    () => Emit.emit(Mod, Core.mod(runtime_union_capture_core)),
    "Rejected baseline proof closure_capture#0: result: unique_heap " +
      "runtime_union capture requires linear closure ownership support",
  );
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
  const _unused_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "program#0",
        owner: undefined,
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  };

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
    [],
  );
  assert_equals(
    unused_owner_proof.drops.steps[0]?.allocation_id,
    undefined,
  );
  assert_equals(Core.drops(unused_owner), { steps: [] });

  const captured_closure_owner = Source.core(Source.parse(`
let n = 1
let f = (x: Int) => x + n

1
`));
  const captured_closure_owner_proof = Core.proof(captured_closure_owner);
  const _captured_closure_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
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
    [],
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
    captured_closure_owner_proof.drops.steps[0]?.allocation_id,
    undefined,
  );
  assert_equals(
    Core.drops(captured_closure_owner),
    { steps: [] },
  );

  const final_closure = Source.core(Source.parse("(x: Int) => x"));
  assert_equals(Core.drops(final_closure), { steps: [] });

  const const_closure = Source.core(Source.parse(`
const f = (x: Int) => x

1
`));
  assert_equals(Core.drops(const_closure), { steps: [] });

  const const_type_constructor = Source.core(Source.parse(`
type OptionType t = | \`Some t | \`None Unit
const option_type = OptionType

const option_int_type = option_type(Int)

let f = (x: Int) => x

1
`));
  assert_equals(Core.drops(const_type_constructor), { steps: [] });

  const closure_body_owner = Source.core(Source.parse(`
(x: Int) => {
  let f = (y: Int) => y
  1
}
`));
  const closure_body_owner_proof = Core.proof(closure_body_owner);
  const closure_body_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "closure#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(closure_body_owner_proof.ok, true);
  assert_equals(closure_body_owner_proof.managed_storage, "disabled");
  assert_equals(
    closure_body_owner_proof.allocations.facts.map((fact) => {
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
  assert_equals(
    closure_body_owner_proof.drops.steps[0]?.allocation_id,
    "allocation#0",
  );
  assert_equals(Core.drops(closure_body_owner), closure_body_owner_drops);

  const closure_return_owner = Source.core(Source.parse(`
(x: Int) => {
  let f = (y: Int) => y
  return 1
}
`));
  const closure_return_owner_proof = Core.proof(closure_return_owner);
  const closure_return_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "return_exit" as const,
        scope: "closure#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure return exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(closure_return_owner_proof.ok, true);
  assert_equals(closure_return_owner_proof.managed_storage, "disabled");
  assert_equals(
    closure_return_owner_proof.allocations.facts.map((fact) => {
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
  assert_equals(
    closure_return_owner_proof.drops.steps[0]?.allocation_id,
    "allocation#0",
  );
  assert_equals(Core.drops(closure_return_owner), closure_return_owner_drops);

  const final_owner = Source.core(Source.parse(`
let f = (x: Int) => x

f
`));
  assert_equals(Core.drops(final_owner), { steps: [] });

  const return_owner = Source.core(Source.parse(`
let f = (x: Int) => x

return 1
`));
  const return_owner_proof = Core.proof(return_owner);
  const _return_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "return_exit" as const,
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure return exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(return_owner_proof.ok, true);
  assert_equals(return_owner_proof.managed_storage, "disabled");
  assert_equals(
    return_owner_proof.allocations.facts.map((fact) => {
      return {
        scope: fact.scope,
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [],
  );
  assert_equals(
    return_owner_proof.drops.steps[0]?.allocation_id,
    undefined,
  );
  assert_equals(Core.drops(return_owner), { steps: [] });

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
  const replaced_owner_proof = Core.proof(replaced_owner);
  const replaced_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "assignment_replace" as const,
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure assignment replacement lowers to __free with reusable allocator",
      },
      {
        tag: "heap_drop" as const,
        id: "drop#1",
        edge: "scope_exit" as const,
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(replaced_owner_proof.ok, false);
  assert_equals(replaced_owner_proof.managed_storage, "disabled");
  assert_equals(
    replaced_owner_proof.allocations.facts.map((fact) => {
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
    ],
  );
  assert_equals(
    replaced_owner_proof.drops.steps.map((step) => {
      if ("allocation_id" in step) {
        return step.allocation_id;
      }

      return undefined;
    }),
    [undefined, "allocation#0"],
  );
  assert_equals(Core.drops(replaced_owner), replaced_owner_drops);

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
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure discarded expression lowers to __free with reusable allocator",
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
  assert_equals(
    discarded_closure_proof.drops.steps[0]?.allocation_id,
    "allocation#0",
  );
  assert_equals(Core.drops(discarded_closure), discarded_closure_drops);

  const discarded_runtime_text_temporary = Source.core(Source.parse(`
(value: Text) => {
  @append(value, "!")
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
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap text discarded expression lowers to __free with reusable allocator",
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
    discarded_runtime_text_temporary_proof.drops.steps[0]?.allocation_id,
    "allocation#1",
  );
  assert_equals(
    Core.drops(discarded_runtime_text_temporary),
    discarded_runtime_text_temporary_drops,
  );

  const discarded_runtime_text_slice_temporary = Source.core(Source.parse(`
(value: Text) => {
  @slice(value, 0, 1)
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
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap text discarded expression lowers to __free with reusable allocator",
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
    discarded_runtime_text_slice_temporary_proof.drops.steps[0]?.allocation_id,
    "allocation#1",
  );
  assert_equals(
    Core.drops(discarded_runtime_text_slice_temporary),
    discarded_runtime_text_slice_temporary_drops,
  );

  const discarded_runtime_aggregate_temporary = Source.core(Source.parse(`
const { struct } = import "duck:prelude" ()
const user_type = struct {
  .name= Text
}

(value: Text) => {
  [.name = value] as user_type
  1
}
`));
  const discarded_runtime_aggregate_temporary_proof = Core.proof(
    discarded_runtime_aggregate_temporary,
  );
  const discarded_runtime_aggregate_temporary_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "discarded_expr" as const,
        scope: "closure#0",
        owner: undefined,
        ownership: unique_runtime_aggregate,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap runtime_aggregate discarded expression lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(discarded_runtime_aggregate_temporary_proof.ok, true);
  assert_equals(
    discarded_runtime_aggregate_temporary_proof.managed_storage,
    "disabled",
  );
  assert_equals(
    discarded_runtime_aggregate_temporary_proof.allocations.facts.map(
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
        ownership: unique_runtime_aggregate,
        reason: "runtime_aggregate",
        expression: "struct_value",
      },
    ],
  );
  assert_equals(
    discarded_runtime_aggregate_temporary_proof.drops.steps[0]?.allocation_id,
    "allocation#1",
  );
  assert_equals(
    Core.drops(discarded_runtime_aggregate_temporary),
    discarded_runtime_aggregate_temporary_drops,
  );

  const discarded_runtime_union_temporary = Source.core(Source.parse(`
type ResultType = | \`Ok Text | \`Err Text
const result_type = ResultType

(value: Text) => {
  \`Ok (value)
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
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap runtime_union discarded expression lowers to __free with reusable allocator",
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
    discarded_runtime_union_temporary_proof.drops.steps[0]?.allocation_id,
    "allocation#1",
  );
  assert_equals(
    Core.drops(discarded_runtime_union_temporary),
    discarded_runtime_union_temporary_drops,
  );

  const bound_runtime_union_temporary = Source.core(Source.parse(`
type ResultType = | \`Ok Text | \`Err Text
const result_type = ResultType

(value: Text) => {
  let result: result_type = \`Ok (value)
  1
}
`));
  const bound_runtime_union_temporary_proof = Core.proof(
    bound_runtime_union_temporary,
  );

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
    ],
  );
  assert_equals(bound_runtime_union_temporary_proof.drops.steps, []);
  assert_equals(
    Core.drops(bound_runtime_union_temporary),
    { steps: [] },
  );

  const discarded_static_aggregate_materialization = Source.core(Source.parse(`
const user = [.name = "Ada", .age = 41]

user
1
`));
  const discarded_static_aggregate_materialization_proof = Core.proof(
    discarded_static_aggregate_materialization,
  );
  const discarded_static_aggregate_materialization_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "discarded_expr" as const,
        scope: "program#0",
        owner: undefined,
        ownership: unique_runtime_aggregate,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap runtime_aggregate discarded expression lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(discarded_static_aggregate_materialization_proof.ok, true);
  assert_equals(
    discarded_static_aggregate_materialization_proof.managed_storage,
    "disabled",
  );
  assert_equals(
    discarded_static_aggregate_materialization_proof.allocations.facts.map(
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
        ownership: unique_runtime_aggregate,
        reason: "runtime_aggregate",
        expression: "var",
      },
    ],
  );
  assert_equals(
    discarded_static_aggregate_materialization_proof.drops.steps[0]
      ?.allocation_id,
    "allocation#0",
  );
  assert_equals(
    Core.drops(discarded_static_aggregate_materialization),
    discarded_static_aggregate_materialization_drops,
  );

  const bound_runtime_text_temporary = Source.core(Source.parse(`
(value: Text) => {
  let message: Text = @append(value, "!")
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
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap text scope exit lowers to __free with reusable allocator",
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
    bound_runtime_text_temporary_proof.drops.steps[0]?.allocation_id,
    "allocation#1",
  );
  assert_equals(
    Core.drops(bound_runtime_text_temporary),
    bound_runtime_text_temporary_drops,
  );

  const bound_runtime_text_slice_temporary = Source.core(Source.parse(`
(value: Text) => {
  let part: Text = @slice(value, 0, 1)
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
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap text scope exit lowers to __free with reusable allocator",
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
    bound_runtime_text_slice_temporary_proof.drops.steps[0]?.allocation_id,
    "allocation#1",
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
  const discarded_named_owner_proof = Core.proof(discarded_named_owner);
  const discarded_named_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "discarded_expr" as const,
        scope: "program#0",
        owner: undefined,
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure discarded expression lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(discarded_named_owner_proof.ok, true);
  assert_equals(discarded_named_owner_proof.managed_storage, "disabled");
  assert_equals(
    discarded_named_owner_proof.allocations.facts.map((fact) => {
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
  assert_equals(
    drop_plan_without_allocation_links(discarded_named_owner_proof.drops),
    discarded_named_owner_drops,
  );
  assert_equals(Core.drops(discarded_named_owner), discarded_named_owner_drops);

  const moved_named_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let g = f

1
`));
  const moved_named_owner_proof = Core.proof(moved_named_owner);
  const _moved_named_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "program#0",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(moved_named_owner_proof.ok, true);
  assert_equals(moved_named_owner_proof.managed_storage, "disabled");
  assert_equals(
    moved_named_owner_proof.allocations.facts.map((fact) => {
      return {
        scope: fact.scope,
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [],
  );
  assert_equals(
    drop_plan_without_allocation_links(moved_named_owner_proof.drops),
    { steps: [] },
  );
  assert_equals(Core.drops(moved_named_owner), { steps: [] });

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
let flag = true
let f = (x: Int) => x
let g = (x: Int) => x + 1

if flag {
  freeze f
} else {
  freeze g
}

1
`));
  assert_equals(Core.drops(branch_frozen_named_owners), { steps: [] });

  const optional_branch_frozen_named_owner = Source.core(Source.parse(`
let flag = true
let f = (x: Int) => x

if flag {
  freeze f
}

1
`));
  assert_equals(Core.drops(optional_branch_frozen_named_owner), { steps: [] });

  const optional_if_let_frozen_named_owner = Source.core(Source.parse(`
type MaybeType = | \`Some Int | \`None Unit
const maybe_type = MaybeType

let target = \`Some (1)
let f = (x: Int) => x

if let \`Some value = target {
  freeze f
}

1
`));
  assert_equals(Core.drops(optional_if_let_frozen_named_owner), {
    steps: [],
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
  const discarded_block_outer_owner_proof = Core.proof(
    discarded_block_outer_owner,
  );
  const _discarded_block_outer_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "discarded_expr" as const,
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure discarded expression lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(discarded_block_outer_owner_proof.ok, true);
  assert_equals(
    discarded_block_outer_owner_proof.managed_storage,
    "disabled",
  );
  assert_equals(
    discarded_block_outer_owner_proof.allocations.facts.map((fact) => {
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
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
    ],
  );
  assert_equals(
    drop_plan_without_allocation_links(discarded_block_outer_owner_proof.drops),
    {
      steps: [
        {
          tag: "heap_drop",
          id: "drop#0",
          edge: "discarded_expr",
          scope: "program#0",
          owner: undefined,
          ownership: unique_closure,
          storage: "persistent_unique_heap",
          runtime: "reusable_free_list_allocator",
          reason:
            "unique_heap closure discarded expression lowers to __free with reusable allocator",
        },
      ],
    },
  );
  assert_equals(
    Core.drops(discarded_block_outer_owner),
    {
      steps: [
        {
          tag: "heap_drop",
          id: "drop#0",
          edge: "discarded_expr",
          scope: "program#0",
          owner: undefined,
          ownership: unique_closure,
          storage: "persistent_unique_heap",
          runtime: "reusable_free_list_allocator",
          reason:
            "unique_heap closure discarded expression lowers to __free with reusable allocator",
        },
      ],
    },
  );

  const moved_block_outer_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let g = { f }

1
`));
  const moved_block_outer_owner_proof = Core.proof(moved_block_outer_owner);
  const _moved_block_outer_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "program#0",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(moved_block_outer_owner_proof.ok, false);
  assert_equals(moved_block_outer_owner_proof.managed_storage, "disabled");
  assert_equals(
    moved_block_outer_owner_proof.allocations.facts.map((fact) => {
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
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
    ],
  );
  assert_equals(
    drop_plan_without_allocation_links(moved_block_outer_owner_proof.drops),
    { steps: [] },
  );
  assert_equals(
    Core.drops(moved_block_outer_owner),
    { steps: [] },
  );

  const discarded_block_local_owner = Source.core(Source.parse(`
{
  let g = (x: Int) => x
  g
}

1
`));
  const discarded_block_local_owner_proof = Core.proof(
    discarded_block_local_owner,
  );
  const discarded_block_local_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "discarded_expr" as const,
        scope: "program#0",
        owner: undefined,
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure discarded expression lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(discarded_block_local_owner_proof.ok, true);
  assert_equals(discarded_block_local_owner_proof.managed_storage, "disabled");
  assert_equals(
    discarded_block_local_owner_proof.allocations.facts.map((fact) => {
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
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
    ],
  );
  assert_equals(
    drop_plan_without_allocation_links(discarded_block_local_owner_proof.drops),
    discarded_block_local_owner_drops,
  );
  assert_equals(
    Core.drops(discarded_block_local_owner),
    discarded_block_local_owner_drops,
  );

  const moved_block_local_owner = Source.core(Source.parse(`
let h = {
  let g = (x: Int) => x
  g
}

1
`));
  const moved_block_local_owner_proof = Core.proof(moved_block_local_owner);
  const _moved_block_local_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "program#0",
        owner: "h",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(moved_block_local_owner_proof.ok, false);
  assert_equals(moved_block_local_owner_proof.managed_storage, "disabled");
  assert_equals(
    moved_block_local_owner_proof.allocations.facts.map((fact) => {
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
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
    ],
  );
  assert_equals(
    drop_plan_without_allocation_links(moved_block_local_owner_proof.drops),
    { steps: [] },
  );
  assert_equals(
    Core.drops(moved_block_local_owner),
    { steps: [] },
  );

  const block_local_owner_dropped = Source.core(Source.parse(`
let f = (x: Int) => x

{
  let g = (x: Int) => x
  1
}

1
`));
  const block_local_owner_dropped_proof = Core.proof(
    block_local_owner_dropped,
  );
  const _block_local_owner_dropped_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "block#0",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
      {
        tag: "heap_drop" as const,
        id: "drop#1",
        edge: "scope_exit" as const,
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(block_local_owner_dropped_proof.ok, true);
  assert_equals(block_local_owner_dropped_proof.managed_storage, "disabled");
  assert_equals(
    block_local_owner_dropped_proof.allocations.facts.map((fact) => {
      return {
        scope: fact.scope,
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [],
  );
  assert_equals(
    drop_plan_without_allocation_links(block_local_owner_dropped_proof.drops),
    {
      steps: [
        {
          tag: "heap_drop",
          id: "drop#0",
          edge: "scope_exit",
          scope: "block#0",
          owner: "g",
          ownership: unique_closure,
          storage: "persistent_unique_heap",
          runtime: "reusable_free_list_allocator",
          reason:
            "unique_heap closure scope exit lowers to __free with reusable allocator",
        },
      ],
    },
  );
  assert_equals(
    Core.drops(block_local_owner_dropped),
    {
      steps: [
        {
          tag: "heap_drop",
          id: "drop#0",
          edge: "scope_exit",
          scope: "block#0",
          owner: "g",
          ownership: unique_closure,
          storage: "persistent_unique_heap",
          runtime: "reusable_free_list_allocator",
          reason:
            "unique_heap closure scope exit lowers to __free with reusable allocator",
        },
      ],
    },
  );

  const final_branch_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let g = (x: Int) => x

if true { f } else { g }
`));
  assert_equals(Core.drops(final_branch_owner), { steps: [] });

  const discarded_branch_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let g = (x: Int) => x

if true { f } else { g }

1
`));
  assert_equals(Core.drops(discarded_branch_owner), {
    steps: [
      {
        tag: "heap_drop",
        id: "drop#0",
        edge: "discarded_expr",
        scope: "block#0",
        owner: undefined,
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "reusable_free_list_allocator",
        reason:
          "unique_heap closure discarded expression lowers to __free with reusable allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "discarded_expr",
        scope: "block#2",
        owner: undefined,
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "reusable_free_list_allocator",
        reason:
          "unique_heap closure discarded expression lowers to __free with reusable allocator",
      },
    ],
  });

  const moved_branch_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let g = (x: Int) => x
let h = if true { f } else { g }

1
`));
  const moved_branch_owner_proof = Core.proof(moved_branch_owner);
  const moved_branch_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "program#0",
        owner: "h",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(moved_branch_owner_proof.ok, true);
  assert_equals(moved_branch_owner_proof.managed_storage, "disabled");
  assert_equals(
    moved_branch_owner_proof.allocations.facts.map((fact) => {
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
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
      {
        scope: "block#1",
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
    ],
  );
  assert_equals(
    drop_plan_without_allocation_links(moved_branch_owner_proof.drops),
    moved_branch_owner_drops,
  );
  assert_equals(Core.drops(moved_branch_owner), moved_branch_owner_drops);

  const moved_mixed_branch_owner = Source.core(Source.parse(`
let f = (x: Int) => x
let h = if true { f } else { (x: Int) => x }

1
`));
  const moved_mixed_branch_owner_proof = Core.proof(
    moved_mixed_branch_owner,
  );
  const moved_mixed_branch_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "program#0",
        owner: "h",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(moved_mixed_branch_owner_proof.ok, true);
  assert_equals(moved_mixed_branch_owner_proof.managed_storage, "disabled");
  assert_equals(
    moved_mixed_branch_owner_proof.allocations.facts.map((fact) => {
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
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
      {
        scope: "block#1",
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
    ],
  );
  assert_equals(
    drop_plan_without_allocation_links(moved_mixed_branch_owner_proof.drops),
    moved_mixed_branch_owner_drops,
  );
  assert_equals(
    Core.drops(moved_mixed_branch_owner),
    moved_mixed_branch_owner_drops,
  );

  const const_union_if_let_branch_owner = Source.core(Source.parse(`
type ResultType = | \`Ok Int | \`Err Int
const result_type = ResultType

let f = (x: Int) => x
let g = (x: Int) => x

if let \`Ok value = \`Ok (1) { f } else { g }
`));
  const const_union_if_let_branch_owner_proof = Core.proof(
    const_union_if_let_branch_owner,
  );
  const _const_union_if_let_branch_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "scope_exit" as const,
        scope: "block#0",
        owner: "g",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
      {
        tag: "heap_drop" as const,
        id: "drop#1",
        edge: "scope_exit" as const,
        scope: "block#2",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(const_union_if_let_branch_owner_proof.ok, true);
  assert_equals(
    const_union_if_let_branch_owner_proof.managed_storage,
    "disabled",
  );
  assert_equals(
    const_union_if_let_branch_owner_proof.allocations.facts.map((fact) => {
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
        scope: "block#0",
        storage: "persistent_unique_heap",
        ownership: unique_closure,
        reason: "closure",
        expression: "lam",
      },
    ],
  );
  assert_equals(
    drop_plan_without_allocation_links(
      const_union_if_let_branch_owner_proof.drops,
    ),
    { steps: [] },
  );
  assert_equals(
    Core.drops(const_union_if_let_branch_owner),
    { steps: [] },
  );

  const break_owner = Source.core(Source.parse(`
for i in 0..1 {
  let f = (x: Int) => x
  break
}

0
`));
  const break_owner_proof = Core.proof(break_owner);
  const _break_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "break_exit" as const,
        scope: "loop#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure break exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(break_owner_proof.ok, true);
  assert_equals(break_owner_proof.managed_storage, "disabled");
  assert_equals(
    break_owner_proof.allocations.facts.map((fact) => {
      return {
        scope: fact.scope,
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [],
  );
  assert_equals(
    drop_plan_without_allocation_links(break_owner_proof.drops),
    { steps: [] },
  );
  assert_equals(Core.drops(break_owner), { steps: [] });

  const continue_owner = Source.core(Source.parse(`
for i in 0..1 {
  let f = (x: Int) => x
  continue
}

0
`));
  const continue_owner_proof = Core.proof(continue_owner);
  const _continue_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "continue_exit" as const,
        scope: "loop#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure continue exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(continue_owner_proof.ok, true);
  assert_equals(continue_owner_proof.managed_storage, "disabled");
  assert_equals(
    continue_owner_proof.allocations.facts.map((fact) => {
      return {
        scope: fact.scope,
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [],
  );
  assert_equals(
    drop_plan_without_allocation_links(continue_owner_proof.drops),
    { steps: [] },
  );
  assert_equals(Core.drops(continue_owner), { steps: [] });

  const conditional_return_owner = Source.core(Source.parse(`
let f = (x: Int) => x
if true {
  return 1
}

0
`));
  const conditional_return_owner_proof = Core.proof(
    conditional_return_owner,
  );
  const _conditional_return_owner_drops = {
    steps: [
      {
        tag: "heap_drop" as const,
        id: "drop#0",
        edge: "return_exit" as const,
        scope: "block#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure return exit lowers to __free with reusable allocator",
      },
      {
        tag: "heap_drop" as const,
        id: "drop#1",
        edge: "scope_exit" as const,
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap" as const,
        runtime: "reusable_free_list_allocator" as const,
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  };

  assert_equals(conditional_return_owner_proof.ok, true);
  assert_equals(conditional_return_owner_proof.managed_storage, "disabled");
  assert_equals(
    conditional_return_owner_proof.allocations.facts.map((fact) => {
      return {
        scope: fact.scope,
        storage: fact.storage,
        ownership: fact.ownership,
        reason: fact.reason,
        expression: fact.expression,
      };
    }),
    [],
  );
  assert_equals(
    drop_plan_without_allocation_links(conditional_return_owner_proof.drops),
    { steps: [] },
  );
  assert_equals(
    Core.drops(conditional_return_owner),
    { steps: [] },
  );

  const terminal_if_owner = Source.core(Source.parse(`
let f = (x: Int) => x
if true {
  return 1
} else {
  return 2
}

0
`));
  assert_equals(Core.drops(terminal_if_owner), { steps: [] });

  const mixed_if_owner = Source.core(Source.parse(`
let f = (x: Int) => x
if true {
  return 1
} else {
  2
}

0
`));
  assert_equals(Core.drops(mixed_if_owner), { steps: [] });

  const branch_replaced_owner = Source.core(Source.parse(`
let f = (x: Int) => x
if true {
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
        runtime: "reusable_free_list_allocator",
        reason:
          "unique_heap closure assignment replacement lowers to __free with reusable allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "assignment_replace",
        scope: "block#1",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "reusable_free_list_allocator",
        reason:
          "unique_heap closure assignment replacement lowers to __free with reusable allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#2",
        edge: "scope_exit",
        scope: "program#0",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "reusable_free_list_allocator",
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  });

  const branch_local_owners = Source.core(Source.parse(`
if true {
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
        runtime: "reusable_free_list_allocator",
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
      {
        tag: "heap_drop",
        id: "drop#1",
        edge: "scope_exit",
        scope: "block#1",
        owner: "f",
        ownership: unique_closure,
        storage: "persistent_unique_heap",
        runtime: "reusable_free_list_allocator",
        reason:
          "unique_heap closure scope exit lowers to __free with reusable allocator",
      },
    ],
  });
});
