import { assert_equals, assert_includes } from "../assert.ts";
import { layout_type } from "./layout.ts";
import { Source } from "./source.ts";
import { source_facts } from "./source_facts.ts";

Deno.test("frontend infers F32x4 builtins and records source facts", () => {
  const analysis = Source.analyze(`
let vector: F32x4 = @f32x4(1f32, 2f32, 3f32, 4f32)
let scaled = @f32x4_mul(vector, @f32x4_splat(2f32))
@f32x4_extract_lane(scaled, 2)
`);
  assert_equals(analysis.diagnostics, []);
  const facts = source_facts(analysis.source);
  const vector_stmt = analysis.source.statements[0];
  const result_stmt = analysis.source.statements[2];

  if (vector_stmt?.tag !== "bind" || result_stmt?.tag !== "expr") {
    throw new Error("Expected vector binding and scalar result");
  }

  assert_equals(facts.type_of.get(vector_stmt.value), {
    tag: "f32x4",
  });
  assert_equals(facts.type_of.get(result_stmt.expr), {
    tag: "int",
    type: "f32",
  });
});

Deno.test("frontend requires exact F32x4 builtin operands and lane literals", () => {
  const scalar_lane = Source.analyze(
    "@f32x4_extract_lane(@f32x4(1, 2f32, 3f32, 4f32), 4)",
  );
  const messages = scalar_lane.diagnostics.map((diagnostic) => {
    return diagnostic.message;
  }).join("\n");
  assert_includes(messages, "F32x4 builtin argument 0 expects F32, got I32");

  const bad_lane = Source.analyze(
    "@f32x4_extract_lane(@f32x4_splat(1f32), 4)",
  );
  assert_includes(
    bad_lane.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    "f32x4_extract_lane lane must be between 0 and 3, got 4",
  );

  const overloaded = Source.analyze(`
let left = @f32x4_splat(1f32)
let right = @f32x4_splat(2f32)
left + right
`);
  assert_includes(
    overloaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    "F32x4 values require explicit f32x4_* builtins",
  );
});

Deno.test("frontend lays out F32x4 values at 16-byte boundaries", () => {
  assert_equals(layout_type({ tag: "type_name", name: "F32x4" }), {
    size: 16,
    align: 16,
    fields: [],
    tag_offset: undefined,
    payload_offset: undefined,
  });

  assert_equals(
    layout_type({
      tag: "struct_type",
      fields: [
        { name: "prefix", type_name: "I32" },
        { name: "lanes", type_name: "F32x4" },
      ],
    }),
    {
      size: 32,
      align: 16,
      fields: [
        { name: "prefix", value: { tag: "num", type: "i32", value: 0 } },
        { name: "lanes", value: { tag: "num", type: "i32", value: 16 } },
      ],
      tag_offset: undefined,
      payload_offset: undefined,
    },
  );

  assert_equals(
    layout_type({
      tag: "union_type",
      cases: [
        { name: "some", type_name: "F32x4" },
        { name: "none", type_name: "Unit" },
      ],
    }),
    {
      size: 32,
      align: 16,
      fields: [],
      tag_offset: 0,
      payload_offset: 16,
    },
  );
});
