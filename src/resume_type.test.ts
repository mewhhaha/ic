import { assert_equals, assert_includes, assert_throws } from "./assert.ts";
import { build_abi_manifest } from "./abi.ts";
import type { CoreExpr } from "./core/ast.ts";
import { runtime_aggregate_layout_for_type } from "./core/runtime_aggregate.ts";
import { runtime_union_type_size } from "./core/runtime_union/size.ts";
import { runtime_union_payload } from "./core/runtime_union_payload.ts";
import {
  core_val_type_from_type_name,
  is_core_builtin_type_name,
} from "./core/type_static.ts";
import { Source } from "./frontend.ts";
import {
  front_type_from_type_name,
  is_builtin_type_name,
  val_type_from_type_name,
} from "./frontend/types.ts";

Deno.test("Resume uses an internal wasm32 pointer representation", () => {
  assert_equals(is_builtin_type_name("Resume"), true);
  assert_equals(front_type_from_type_name("Resume"), {
    tag: "int",
    type: "i32",
  });
  assert_equals(val_type_from_type_name("Resume"), "i32");
  assert_equals(is_core_builtin_type_name("Resume"), true);
  assert_equals(core_val_type_from_type_name("Resume"), "i32");

  const box_type: CoreExpr = {
    tag: "struct_type",
    fields: [{ name: "resume", type_name: "Resume" }],
  };
  const ctx = {
    statics: new Map<string, CoreExpr>([["resume_box_type", box_type]]),
  };
  const layout = runtime_aggregate_layout_for_type(
    { tag: "var", name: "resume_box_type" },
    ctx,
  );

  assert_equals(layout.size, 4);
  assert_equals(layout.align, 4);
  assert_equals(layout.fields, [{
    tag: "value",
    name: "resume",
    offset: 0,
    type: "i32",
    text: false,
    union_type_expr: undefined,
  }]);
  assert_equals(runtime_union_payload("Resume", ctx), {
    tag: "value",
    type: "i32",
    text: false,
  });
  assert_equals(
    runtime_union_type_size({
      tag: "union_type",
      cases: [
        { name: "more", type_name: "Resume" },
        { name: "done", type_name: "Unit" },
      ],
    }, ctx),
    8,
  );
});

Deno.test("runtime aggregates and unions store Resume closure pointers", () => {
  const aggregate_wat = Source.wat(`
const resume_box_type = struct { resume: Resume }
resume_box_type { resume: (value: I32) => value + 1 }
`);
  assert_includes(aggregate_wat, "(type $closure_i32_i32_to_i32");
  assert_includes(aggregate_wat, "i32.store offset=0");

  const union_wat = Source.wat(`
const suspended = union { more: Resume, done: I32 }
suspended.more((value: I32) => value + 1)
`);
  assert_includes(union_wat, "(type $closure_i32_i32_to_i32");
  assert_includes(union_wat, "i32.store offset=4");
});

Deno.test("managed ABI rejects Resume directly and through aliases", () => {
  assert_throws(
    () =>
      build_abi_manifest(Source.parse(`
declare effect Io { suspend: () => Resume }
0
`)),
    "Managed ABI cannot expose Resume values",
  );

  assert_throws(
    () =>
      build_abi_manifest(Source.parse(`
const resume_alias = Resume
const ix_entry_result_type = resume_alias
0
`)),
    "Managed ABI cannot expose Resume values",
  );
});
