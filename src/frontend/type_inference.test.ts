import { assert_equals, assert_throws } from "../assert.ts";
import {
  format_inference_type,
  type InferenceBinding,
  type InferenceEffect,
  type InferenceType,
  monomorphic_type_binding,
  scalar_representation_compatible,
  statically_known_const_type_binding,
  TypeInference,
} from "./type_inference.ts";

const int: InferenceType = { tag: "scalar", name: "Int" };
const i32: InferenceType = { tag: "scalar", name: "I32" };
const bool: InferenceType = { tag: "scalar", name: "Bool" };
const text: InferenceType = { tag: "scalar", name: "Text" };

function function_type(
  params: InferenceType[],
  result: InferenceType,
  effects: InferenceEffect[] = [],
): InferenceType {
  return { tag: "function", params, effects, result };
}

Deno.test("type inference rejects infinite types with an occurs check", () => {
  const inference = new TypeInference();
  const element = inference.fresh_variable("element");

  assert_throws(
    () => {
      inference.unify(
        element,
        { tag: "fixed_array", length: 4, element },
        "array literal",
      );
    },
    "array literal: occurs check failed: ?0(element) occurs in [?0(element); 4]",
  );
});

Deno.test("statically known const identity functions instantiate freshly", () => {
  const inference = new TypeInference();
  const value = inference.fresh_variable("value");
  const identity = function_type([value], value);
  const scheme = inference.generalize_statically_known_const(identity, []);
  const binding = statically_known_const_type_binding(scheme);
  const int_identity = inference.instantiate_binding(binding);
  const bool_identity = inference.instantiate_binding(binding);

  assert_equals(scheme.quantified_variables, [0]);
  assert_equals(
    format_inference_type(int_identity) ===
      format_inference_type(bool_identity),
    false,
  );

  inference.unify(
    int_identity,
    function_type([int], int),
    "first identity use",
  );
  inference.unify(
    bool_identity,
    function_type([bool], bool),
    "second identity use",
  );

  assert_equals(
    inference.require_resolved(int_identity, "first identity use"),
    function_type([int], int),
  );
  assert_equals(
    inference.require_resolved(bool_identity, "second identity use"),
    function_type([bool], bool),
  );
});

Deno.test("ordinary bindings remain monomorphic across uses", () => {
  const inference = new TypeInference();
  const value = inference.fresh_variable("binding");
  const binding = monomorphic_type_binding(value);

  inference.unify(
    inference.instantiate_binding(binding),
    int,
    "first binding use",
  );

  assert_throws(
    () => {
      inference.unify(
        inference.instantiate_binding(binding),
        bool,
        "second binding use",
      );
    },
    "second binding use: cannot unify Int with Bool: scalar names differ",
  );
});

Deno.test("generalization preserves variables free in the environment", () => {
  const inference = new TypeInference();
  const captured = inference.fresh_variable("captured");
  const environment: InferenceBinding[] = [monomorphic_type_binding(captured)];
  const scheme = inference.generalize_statically_known_const(
    function_type([captured], captured),
    environment,
  );

  assert_equals(scheme.quantified_variables, []);
});

Deno.test("arrays require equal fixed lengths", () => {
  const inference = new TypeInference();

  assert_throws(
    () => {
      inference.unify(
        { tag: "fixed_array", length: 2, element: int },
        { tag: "fixed_array", length: 3, element: int },
        "array annotation",
      );
    },
    "array annotation: cannot unify [Int; 2] with [Int; 3]: array lengths differ",
  );
});

Deno.test("records require the same labels in declaration order", () => {
  const inference = new TypeInference();

  assert_throws(
    () => {
      inference.unify(
        {
          tag: "record",
          fields: [
            { label: "name", type: text },
            { label: "enabled", type: bool },
          ],
        },
        {
          tag: "record",
          fields: [
            { label: "enabled", type: bool },
            { label: "name", type: text },
          ],
        },
        "record annotation",
      );
    },
    "record labels differ at index 0",
  );
});

Deno.test("products require the same positional labels", () => {
  const inference = new TypeInference();

  assert_throws(
    () => {
      inference.unify(
        {
          tag: "product",
          fields: [{ label: "x", type: int }],
        },
        {
          tag: "product",
          fields: [{ label: undefined, type: int }],
        },
        "product annotation",
      );
    },
    "product labels differ at index 0",
  );
});

Deno.test("functions require exactly equal effect rows", () => {
  const inference = new TypeInference();

  assert_throws(
    () => {
      inference.unify(
        function_type([text], text, [
          { effect: "Io", operation: "read" },
        ]),
        function_type([text], text, [
          { effect: "Io", operation: "write" },
        ]),
        "function annotation",
      );
    },
    "function effects differ",
  );
});

Deno.test("ownership modes do not unify implicitly", () => {
  const inference = new TypeInference();

  assert_throws(
    () => {
      inference.unify(
        { tag: "owned", ownership: "bounded_borrow", value: text },
        { tag: "owned", ownership: "frozen_shareable", value: text },
        "effect parameter",
      );
    },
    "ownership modes differ",
  );
});

Deno.test("unresolved type diagnostics name every inference variable", () => {
  const inference = new TypeInference();
  const input = inference.fresh_variable("input");
  const output = inference.fresh_variable("output");

  assert_throws(
    () => {
      inference.require_resolved(
        function_type([input], output),
        "const transform",
      );
    },
    "const transform: unresolved inference variables ?0(input), ?1(output)",
  );
});

Deno.test("alias normalization participates in unification", () => {
  const inference = new TypeInference((type) => {
    if (type.name === "MachineInt") {
      return i32;
    }

    return undefined;
  });

  inference.unify(
    { tag: "named", name: "MachineInt", args: [] },
    i32,
    "alias annotation",
  );
});

Deno.test("Int and I32 are distinct types with compatible representations", () => {
  const inference = new TypeInference();

  assert_throws(
    () => {
      inference.unify(int, i32, "integer annotation");
    },
    "integer annotation: cannot unify Int with I32: scalar names differ",
  );
  assert_equals(scalar_representation_compatible("Int", "I32"), true);
  assert_equals(scalar_representation_compatible("Bool", "Int"), false);
});
