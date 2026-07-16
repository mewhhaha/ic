import { assert_equals } from "../assert.ts";
import { instantiate_wat } from "../wasm_test_util.ts";
import { Source } from "./source.ts";

function occurrence_count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

Deno.test("unused direct-call arguments are not evaluated", () => {
  const wat = Source.wat(`
let ignore = value => 42
ignore(@panic("unused"))
`);

  assert_equals(occurrence_count(wat, "unreachable"), 0);
  assert_equals(occurrence_count(wat, "i32.const 42"), 1);
});

Deno.test("repeated direct-call demand evaluates an argument once", () => {
  const wat = Source.wat(`
let duplicate = value => value + value
duplicate(@panic("once"))
`);

  assert_equals(occurrence_count(wat, "unreachable"), 1);
  assert_equals(occurrence_count(wat, "local.set $_demand#0"), 1);
  assert_equals(occurrence_count(wat, "local.get $_demand#0"), 2);
});

Deno.test("conditional demand stays inside the selected branch", () => {
  const wat = Source.wat(`
let select = [flag, value] => if flag {
  value + value
} else {
  0
}
select [0, @panic("not selected")]
`);
  const branch_start = wat.indexOf("if (result i32)");
  const demand = wat.indexOf("local.set $_demand#0");
  const alternative = wat.indexOf("else", demand);

  assert_equals(branch_start >= 0, true);
  assert_equals(demand > branch_start, true);
  assert_equals(alternative > demand, true);
  assert_equals(occurrence_count(wat, "unreachable"), 1);
});

Deno.test("capture-free first-class closure selection preserves demand", async () => {
  const wat = Source.wat(`
module (!init: Init) where

declare effect Input {
  flag: () => I32
}

declare Init { input: Input }

flag <- Input.flag()
let operation = if flag {
  (value: I32) => 0
} else {
  (value: I32) => value + value
}
let result: I32 = operation(@panic("lazy"))
return { .result = result }
`);
  const main_start = wat.indexOf("(func $main");
  const allocator_start = wat.indexOf("(func $__alloc");
  const main_wat = wat.slice(main_start, allocator_start);

  assert_equals(wat.includes("call_indirect"), false);
  assert_equals(occurrence_count(main_wat, "unreachable"), 1);
  assert_equals(
    main_wat.indexOf("unreachable") > main_wat.indexOf("else"),
    true,
  );

  let flag = 1;
  const instance = await instantiate_wat(wat, "demand_selected_closure", {
    duck_init: { input: () => 0 },
    duck_effect: { "Input.flag": () => flag },
  });
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main export");
  }

  main();
  flag = 0;
  let trapped = false;

  try {
    main();
  } catch (error) {
    if (!(error instanceof WebAssembly.RuntimeError)) {
      throw error;
    }

    trapped = true;
  }

  assert_equals(trapped, true);
});
