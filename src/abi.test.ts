import { assert_equals, assert_throws } from "./assert.ts";
import { abi_fixed_array_schema_name, build_abi_manifest } from "./abi.ts";
import { source_with_host_callable_exports } from "./frontend/host_exports.ts";
import { Source } from "./frontend/source.ts";

Deno.test("gpufuck ABI describes declared effects and Init fields", () => {
  const manifest = build_abi_manifest({
    tag: "program",
    declarations: [
      {
        tag: "effect",
        implementation: "host",
        name: "Io",
        params: [],
        operations: [{
          name: "print",
          type_params: [],
          params: [{ type_name: "Text", ownership: "bounded_borrow" }],
          result: { type_name: "Unit", ownership: "scalar" },
        }],
      },
      {
        tag: "record",
        name: "Init",
        fields: [{ name: "io", type_name: "Io" }],
      },
    ],
    statements: [],
  });

  assert_equals(manifest.init, {
    name: "Init",
    fields: [{
      name: "io",
      type: { tag: "resource", effect: "Io" },
      import: "__duck_init_io",
    }],
  });
  assert_equals(manifest.effects.Io?.operations.print, {
    name: "print",
    execution: "synchronous",
    import: "__duck_effect_Io_print",
    params: [{ type: { tag: "text" }, ownership: "bounded_borrow" }],
    result: { type: { tag: "unit" }, ownership: "scalar" },
  });
  assert_equals(manifest.imports.__duck_effect_Io_print?.effect, {
    name: "Io",
    operation: "print",
    resource_param: 0,
  });
  assert_equals(manifest.imports.__duck_init_io, {
    name: "__duck_init_io",
    module: "duck_init",
    field: "io",
    params: [],
    result: {
      type: { tag: "resource", effect: "Io" },
      ownership: "scalar",
    },
    init: { field: "io", effect: "Io" },
  });
});

Deno.test("gpufuck ABI rejects source-defined effects in Init", () => {
  assert_throws(
    () =>
      build_abi_manifest(Source.parse(`
effect Counter { get: () => I32 }
declare Init { counter: Counter }
return {};
`)),
    "Init field must name a declared effect: counter: Counter",
  );
});

Deno.test("gpufuck ABI builds deterministic fixed array schemas", () => {
  const manifest = build_abi_manifest({
    tag: "program",
    declarations: [
      {
        tag: "record",
        name: "pair",
        fields: [{ name: "values", type_name: "[I32; 2]" }],
      },
      {
        tag: "effect",
        implementation: "host",
        name: "Host",
        params: [],
        operations: [{
          name: "read",
          type_params: [],
          params: [],
          result: { type_name: "pair", ownership: "unique_heap" },
        }],
      },
    ],
    statements: [],
  });
  const array_name = abi_fixed_array_schema_name({ tag: "i32" }, 2);

  assert_equals(manifest.types[array_name], {
    tag: "array",
    name: array_name,
    element: { tag: "i32" },
    length: 2,
  });
  assert_equals(manifest.types.pair, {
    tag: "struct",
    name: "pair",
    fields: [{
      name: "values",
      type: { tag: "named", name: array_name },
    }],
  });
});

Deno.test("gpufuck ABI builds recursive type schemas", () => {
  const manifest = build_abi_manifest({
    tag: "program",
    statements: [
      {
        tag: "bind",
        kind: "const",
        name: "ListNode",
        is_linear: false,
        annotation: undefined,
        value: {
          tag: "struct_type",
          fields: [
            { name: "value", type_name: "I32" },
            { name: "next", type_name: "List" },
          ],
        },
      },
      {
        tag: "bind",
        kind: "const",
        name: "List",
        is_linear: false,
        annotation: undefined,
        value: {
          tag: "union_type",
          cases: [
            { name: "Nil", type_name: "Unit" },
            { name: "Cons", type_name: "ListNode" },
          ],
        },
      },
    ],
    declarations: [{
      tag: "effect",
      implementation: "host",
      name: "Host",
      params: [],
      operations: [{
        name: "read",
        type_params: [],
        params: [],
        result: { type_name: "List", ownership: "unique_heap" },
      }],
    }],
  });

  assert_equals(manifest.types.List, {
    tag: "union",
    name: "List",
    cases: [
      { name: "Nil", payload: { tag: "unit" } },
      { name: "Cons", payload: { tag: "named", name: "ListNode" } },
    ],
  });
  assert_equals(manifest.types.ListNode, {
    tag: "struct",
    name: "ListNode",
    fields: [
      { name: "value", type: { tag: "i32" } },
      { name: "next", type: { tag: "named", name: "List" } },
    ],
  });
});

Deno.test("gpufuck ABI records scalar float effect contracts", () => {
  const manifest = build_abi_manifest(Source.parse(`
declare effect FloatMath { scale: (F32) => F32, widen: (F64) => F64 }
return {};
`));

  assert_equals(manifest.effects.FloatMath?.operations.scale, {
    name: "scale",
    execution: "synchronous",
    import: "__duck_effect_FloatMath_scale",
    params: [{ type: { tag: "f32" }, ownership: "scalar" }],
    result: { type: { tag: "f32" }, ownership: "scalar" },
  });
  assert_equals(manifest.effects.FloatMath?.operations.widen, {
    name: "widen",
    execution: "synchronous",
    import: "__duck_effect_FloatMath_widen",
    params: [{ type: { tag: "f64" }, ownership: "scalar" }],
    result: { type: { tag: "f64" }, ownership: "scalar" },
  });
});

Deno.test("gpufuck ABI records host callable contracts", () => {
  const source = source_with_host_callable_exports(Source.parse(`
module () where

let add: (I32, I32) -> I32 = (left, right) => left + right;
return { .add = add };
`));
  const manifest = build_abi_manifest(source);

  assert_equals(manifest.callables, {
    add: {
      name: "add",
      export: "__duck_abi_call_add",
      params: [
        { type: { tag: "i32" }, ownership: "scalar" },
        { type: { tag: "i32" }, ownership: "scalar" },
      ],
      result: { type: { tag: "i32" }, ownership: "scalar" },
    },
  });
});
