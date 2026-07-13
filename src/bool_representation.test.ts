import { assert_equals, assert_includes, assert_throws } from "./assert.ts";
import { build_abi_manifest } from "./abi.ts";
import { Core } from "./core.ts";
import type { Core as CoreNode } from "./core/ast.ts";
import { closure_param_info } from "./core/closure_type/param.ts";
import {
  core_val_type_from_type_name,
  is_core_builtin_type_name,
} from "./core/type_static/names.ts";
import { layout_type } from "./frontend/layout.ts";
import { parse_source } from "./frontend/parser.ts";
import { TestSource } from "./frontend/test_source.ts";
import { Source } from "./frontend.ts";
import { Typed } from "./trait.ts";

Deno.test("Bool uses the i32 Core representation", () => {
  assert_equals(is_core_builtin_type_name("Bool"), true);
  assert_equals(core_val_type_from_type_name("Bool"), "i32");
  assert_equals(
    closure_param_info(
      {
        name: "condition",
        is_const: false,
        is_linear: false,
        annotation: "Bool",
      },
      {},
      { static_annotation_type_value: () => undefined },
    ),
    { type: "i32", is_text: false },
  );

  const valid: CoreNode = {
    tag: "program",
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: "condition",
        is_linear: false,
        annotation: "Bool",
        value: { tag: "num", type: "i32", value: 1 },
      },
      { tag: "expr", expr: { tag: "var", name: "condition" } },
    ],
  };
  assert_equals(Typed.type(Core, valid), "i32");

  const invalid: CoreNode = {
    tag: "program",
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: "condition",
        is_linear: false,
        annotation: "Bool",
        value: { tag: "num", type: "i64", value: 1n },
      },
      { tag: "expr", expr: { tag: "var", name: "condition" } },
    ],
  };
  assert_throws(
    () => Typed.type(Core, invalid),
    "Core binding annotation expects Bool, got I64",
  );
});

Deno.test("Bool uses four-byte layouts and scalar host contracts", () => {
  assert_equals(layout_type({ tag: "type_name", name: "Bool" }), {
    size: 4,
    align: 4,
    fields: [],
    tag_offset: undefined,
    payload_offset: undefined,
  });

  const effect = parse_source(
    "declare effect Gate { choose: (Bool) => Bool }",
  );
  assert_equals(effect.declarations?.[0], {
    tag: "effect",
    implementation: "host",
    name: "Gate",
    operations: [{
      name: "choose",
      params: [{ type_name: "Bool", ownership: "scalar" }],
      result: { type_name: "Bool", ownership: "scalar" },
    }],
  });

  const raw = TestSource.parse(
    'host_import choose from "gate.choose" (Bool) => Bool',
  );
  assert_equals(raw.statements[0], {
    tag: "host_import",
    value: {
      name: "choose",
      module: "gate",
      field: "choose",
      params: ["i32"],
      result: "i32",
      args: [{ tag: "scalar" }],
      result_owner: undefined,
    },
  });

  const manifest = build_abi_manifest(effect);
  assert_equals(manifest.effects.Gate.operations.choose, {
    name: "choose",
    import: "__ix_effect_Gate_choose",
    params: [{ type: { tag: "i32" }, ownership: "scalar" }],
    result: { type: { tag: "i32" }, ownership: "scalar" },
  });
});

Deno.test("Bool aliases lower through Core to i32", () => {
  const wat = Source.wat(`
type Flag = Bool
let flag: Flag = true
flag
`);

  assert_includes(wat, "(func $main (result i32)");
  assert_includes(wat, "i32.const 1");
});

Deno.test("chained Bool aliases compile through a pure closure", () => {
  const wat = Source.wat(`
type Flag = Bool
type Ready = Flag
let identity: Ready -> Flag = (value: Ready) => value
identity(true)
`);

  assert_includes(wat, "(func $main (result i32)");
  assert_includes(wat, "i32.const 1");
});

Deno.test("direct and chained Bool aliases type aggregate fields", () => {
  const wat = Source.wat(`
type Flag = Bool
type Ready = Flag
type Box = [.direct = Flag, .chained = Ready]
let box: Box = [.direct = true, .chained = false]
box.direct
`);

  assert_includes(wat, "(func $main (result i32)");
  assert_includes(wat, "i32.const 1");
});

Deno.test("direct and chained I32 aliases type aggregate fields", () => {
  const wat = Source.wat(`
type Count = I32
type Total = Count
type Box = [.direct = Count, .chained = Total]
let box: Box = [.direct = 40, .chained = 2]
box.direct + box.chained
`);

  assert_includes(wat, "(func $main (result i32)");
  assert_includes(wat, "i32.add");
});

Deno.test("direct and chained I64 aliases type aggregate fields", () => {
  const wat = Source.wat(`
type Wide = I64
type Wider = Wide
type Box = [.direct = Wide, .chained = Wider]
let box: Box = [.direct = 40i64, .chained = 2i64]
box.direct + box.chained
`);

  assert_includes(wat, "(func $main (result i64)");
  assert_includes(wat, "i64.add");
});

Deno.test("Bool aliases resolve in aggregate type patterns", () => {
  const wat = Source.wat(`
type Flag = Bool
type Ready = Flag
type Box = [.direct = Flag, .chained = Ready]
let struct { direct: Flag, chained: Ready } = Box
0
`);

  assert_includes(wat, "(func $main (result i32)");
  assert_includes(wat, "i32.const 0");
});

Deno.test("Bool alias closure parameters reject I32 arguments", () => {
  assert_throws(
    () =>
      Source.wat(`
type Flag = Bool
type Ready = Flag
let identity: Ready -> Flag = (value: Ready) => value
identity(1)
`),
    "Call to identity argument 1 for parameter value expects Bool, got I32",
  );
});

Deno.test("managed ABI resolves Bool aliases to i32", () => {
  const artifact = Source.artifact(`
module (!init: Init) where

type Flag = Bool
type Ready = Flag
type Result = [.flag = Ready]
declare effect Host { get: () => Result }
declare Init { host: Host }

result <- Host.get()
return { result }
`);

  assert_equals(artifact.abi.types.Result, {
    tag: "struct",
    name: "Result",
    schema_id: 1,
    size: 4,
    align: 4,
    fields: [{ name: "flag", type: { tag: "i32" }, offset: 0 }],
  });
});

Deno.test("managed effects use scalar ownership for Bool aliases", () => {
  const artifact = Source.artifact(`
module (!init: Init) where

type Flag = Bool
type Ready = Flag
declare effect Gate { choose: (Ready) => Flag }
type Init = [.gate = Gate]

value <- Gate.choose(true)
return { value }
`);

  assert_equals(artifact.abi.effects.Gate.operations.choose, {
    name: "choose",
    import: "__ix_effect_Gate_choose",
    params: [{ type: { tag: "i32" }, ownership: "scalar" }],
    result: { type: { tag: "i32" }, ownership: "scalar" },
  });
  assert_includes(artifact.wat, "(func $__ix_abi_main");
});

Deno.test("managed Bool alias parameters reject I32 arguments", () => {
  assert_throws(
    () =>
      Source.artifact(`
module (!init: Init) where

type Flag = Bool
type Ready = Flag
declare effect Gate { choose: (Ready) => Flag }
type Init = [.gate = Gate]

value <- Gate.choose(1)
return { value }
`),
    "Call to Gate.choose argument 1 expects Bool, got I32",
  );
});
