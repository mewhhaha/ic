import { assert_equals } from "../assert.ts";
import { parse_source } from "../frontend/parser.ts";
import { core_from_source } from "./from_source.ts";

Deno.test("integer-to-float conversions do not taint later arithmetic", () => {
  const core = core_from_source(parse_source(`
let scale: I32 -> F32 = (value: I32) => {
  let converted: F32 = @f32_from_i32(value);
  converted / 2.0f32
};
scale
`));
  const scale = core.recFunctions?.scale;

  if (scale === undefined || scale.body?.tag !== "block") {
    throw new Error("Missing lowered scale function");
  }

  const result = scale.body.statements[1];

  if (result === undefined || result.tag !== "expr") {
    throw new Error("Missing lowered scale result");
  }

  assert_equals(result.expr, {
    tag: "prim",
    prim: "f32.div",
    args: [
      { tag: "var", name: "converted" },
      { tag: "num", type: "f32", value: 2 },
    ],
    integer: undefined,
  });
});
