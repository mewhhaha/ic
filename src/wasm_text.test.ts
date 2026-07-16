import type { Expr as ExprNode } from "./expr.ts";
import {
  instantiate_wat,
  wat_from_core_source,
  wat_from_expr,
  wat_from_source,
} from "./wasm_test_util.ts";

Deno.test("frontend dynamic visible text get compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let rename = value => {
  value with {
    .second = "Grace"
  }
}

let flag = 1
let input = if flag {
  1
} else {
  0
}

@get(rename([.first = "Ada", .second = "Eve"])[input], 1)
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_dynamic_visible_text_get",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 114) {
    throw new Error("Expected main() -> 114, got " + result);
  }
});

Deno.test("core text literal compiles through WAT to Wasm memory", async () => {
  const wat_text = wat_from_core_source('"hi"');
  const instance = await instantiate_wat(wat_text, "core_text_literal", {});

  if (!("memory" in instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 0) {
    throw new Error("Expected main() -> 0, got " + result);
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 0, 6);

  if (bytes[0] !== 2) {
    throw new Error("Expected core text length byte 0 -> 2, got " + bytes[0]);
  }

  if (bytes[4] !== 104) {
    throw new Error("Expected core text byte 0 -> 104, got " + bytes[4]);
  }

  if (bytes[5] !== 105) {
    throw new Error("Expected core text byte 1 -> 105, got " + bytes[5]);
  }
});

Deno.test("core text concatenation compiles through WAT to Wasm memory", async () => {
  const wat_text = wat_from_core_source('"hi" + "!"');
  const instance = await instantiate_wat(wat_text, "core_text_concat", {});

  if (!("memory" in instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 0) {
    throw new Error("Expected main() -> 0, got " + result);
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 0, 7);

  if (bytes[0] !== 3) {
    throw new Error("Expected core text length byte 0 -> 3, got " + bytes[0]);
  }

  if (bytes[4] !== 104) {
    throw new Error("Expected core text byte 0 -> 104, got " + bytes[4]);
  }

  if (bytes[5] !== 105) {
    throw new Error("Expected core text byte 1 -> 105, got " + bytes[5]);
  }

  if (bytes[6] !== 33) {
    throw new Error("Expected core text byte 2 -> 33, got " + bytes[6]);
  }

  const runtime_wat = wat_from_core_source(`
let flag = 1
let append = if flag {
  (left: Text, right: Text) => left + right
} else {
  (left: Text, right: Text) => right + left
}

append("hi", "!")
`);
  const runtime_instance = await instantiate_wat(
    runtime_wat,
    "core_runtime_text_concat",
    {},
  );

  if (!("memory" in runtime_instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(runtime_instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in runtime_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof runtime_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const runtime_result = runtime_instance.exports.main();

  if (typeof runtime_result !== "number") {
    throw new Error("Expected main() to return a text pointer");
  }

  const runtime_memory = runtime_instance.exports.memory;
  const runtime_bytes = new Uint8Array(
    runtime_memory.buffer,
    runtime_result,
    7,
  );

  if (runtime_bytes[0] !== 3) {
    throw new Error(
      "Expected runtime text length byte 0 -> 3, got " + runtime_bytes[0],
    );
  }

  if (runtime_bytes[4] !== 104) {
    throw new Error(
      "Expected runtime text byte 0 -> 104, got " + runtime_bytes[4],
    );
  }

  if (runtime_bytes[5] !== 105) {
    throw new Error(
      "Expected runtime text byte 1 -> 105, got " + runtime_bytes[5],
    );
  }

  if (runtime_bytes[6] !== 33) {
    throw new Error(
      "Expected runtime text byte 2 -> 33, got " + runtime_bytes[6],
    );
  }
});

Deno.test("core visible text len compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let flag = 1
let message = if flag {
  "hi"
} else {
  "world"
}

flag = 0
@len(message)
`);
  const instance = await instantiate_wat(wat_text, "core_text_len", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 2) {
    throw new Error("Expected main() -> 2, got " + result);
  }

  const first_class_wat = wat_from_core_source(`
let flag = 1
let byte_len = if flag {
  (value: Text) => @len(value)
} else {
  (value: Text) => @len(value) + 1
}

byte_len("Ada")
`);
  const first_class_instance = await instantiate_wat(
    first_class_wat,
    "core_runtime_text_len",
    {},
  );

  if (!("main" in first_class_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof first_class_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const first_class_result = first_class_instance.exports.main();

  if (first_class_result !== 3) {
    throw new Error("Expected main() -> 3, got " + first_class_result);
  }
});

Deno.test("core dynamic text index compiles through WAT to Wasm memory", async () => {
  const wat_text = wat_from_core_source(`
let messages = [.first = "Ada", .second = "Grace"]

let i = if 1 {
  1
} else {
  0
}

messages[i]
`);
  const instance = await instantiate_wat(wat_text, "core_text_index", {});

  if (!("memory" in instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 8) {
    throw new Error("Expected main() -> 8, got " + result);
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 8, 9);

  if (bytes[0] !== 5) {
    throw new Error(
      "Expected selected text length byte 0 -> 5, got " + bytes[0],
    );
  }

  if (bytes[4] !== 71) {
    throw new Error("Expected selected text byte 0 -> 71, got " + bytes[4]);
  }

  if (bytes[8] !== 101) {
    throw new Error("Expected selected text byte 4 -> 101, got " + bytes[8]);
  }
});

Deno.test("core dynamic text index concatenation compiles through WAT to Wasm memory", async () => {
  const wat_text = wat_from_core_source(`
let messages = [.first = "Ada", .second = "Grace"]

let i = if 1 {
  1
} else {
  0
}

messages[i] + "!"
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_text_index_concat",
    {},
  );

  if (!("memory" in instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error("Expected main() to return a pointer");
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, result, 10);

  if (bytes[0] !== 6) {
    throw new Error(
      "Expected selected concatenated text length byte 0 -> 6, got " +
        bytes[0],
    );
  }

  if (bytes[4] !== 71) {
    throw new Error(
      "Expected selected concatenated text byte 0 -> 71, got " + bytes[4],
    );
  }

  if (bytes[9] !== 33) {
    throw new Error(
      "Expected selected concatenated text byte 5 -> 33, got " + bytes[9],
    );
  }
});

Deno.test("core dynamic text index len compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let messages = [.first = "Ada", .second = "Grace"]

let i = if 1 {
  1
} else {
  0
}

@len(messages[i])
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_text_index_len",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 5) {
    throw new Error("Expected main() -> 5, got " + result);
  }
});

Deno.test("core dynamic text byte index compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let message = "Ada"
let i = if 1 {
  2
} else {
  0
}

message[i]
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_text_byte_index",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 97) {
    throw new Error("Expected main() -> 97, got " + result);
  }

  const first_class_wat = wat_from_core_source(`
let flag = 1
let byte_at = if flag {
  (value: Text, i: Int) => value[i]
} else {
  (value: Text, i: Int) => @get(value, i)
}

byte_at("Ada", 2)
`);
  const first_class_instance = await instantiate_wat(
    first_class_wat,
    "core_runtime_text_byte_index",
    {},
  );

  if (!("main" in first_class_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof first_class_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const first_class_result = first_class_instance.exports.main();

  if (first_class_result !== 97) {
    throw new Error("Expected main() -> 97, got " + first_class_result);
  }
});

Deno.test("core runtime Bytes assignment compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let write_byte = (message: Bytes, i: Int, value: Int) => {
  message[i] = value
  message[i]
}

write_byte(@Utf8.encode("Ada"), 1, 111)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_runtime_text_byte_assignment",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 111) {
    throw new Error("Expected main() -> 111, got " + result);
  }

  const first_class_wat = wat_from_core_source(`
let flag = 1
let write_byte = if flag {
  (message: Bytes, i: Int, value: Int) => {
    message[i] = value
    message[i]
  }
} else {
  (message: Bytes, i: Int, value: Int) => {
    message[i] = value + 1
    message[i]
  }
}

write_byte(@Utf8.encode("Ada"), 1, 111)
`);
  const first_class_instance = await instantiate_wat(
    first_class_wat,
    "core_first_class_text_byte_assignment",
    {},
  );

  if (!("main" in first_class_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof first_class_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const first_class_result = first_class_instance.exports.main();

  if (first_class_result !== 111) {
    throw new Error(
      "Expected main() -> 111, got " + first_class_result,
    );
  }

  const trap_wat = wat_from_core_source(`
let write_byte = (message: Bytes, i: Int, value: Int) => {
  message[i] = value
  message[i]
}

write_byte(@Utf8.encode("Ada"), 3, 111)
`);
  const trap_instance = await instantiate_wat(
    trap_wat,
    "core_runtime_text_byte_assignment_oob",
    {},
  );

  if (!("main" in trap_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof trap_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    trap_instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for runtime text byte assignment");
});

Deno.test("core dynamic text get compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let message = "Ada"
let i = if 1 {
  1
} else {
  0
}

@get(message, i)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_text_get",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 100) {
    throw new Error("Expected main() -> 100, got " + result);
  }
});

Deno.test("core dynamic text get traps out of bounds", async () => {
  const wat_text = wat_from_core_source(`
let message = "Ada"
let i = 3

@get(message, i)
`);
  const instance = await instantiate_wat(
    wat_text,
    "core_text_get_trap",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for out-of-bounds text get");
});

Deno.test("frontend text literal compiles through WAT to Wasm memory", async () => {
  const wat_text = wat_from_source('"hi"');
  const instance = await instantiate_wat(wat_text, "text_literal", {});

  if (!("memory" in instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 0) {
    throw new Error("Expected main() -> 0, got " + result);
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 0, 6);

  if (bytes[0] !== 2) {
    throw new Error("Expected text length byte 0 -> 2, got " + bytes[0]);
  }

  if (bytes[1] !== 0) {
    throw new Error("Expected text length byte 1 -> 0, got " + bytes[1]);
  }

  if (bytes[2] !== 0) {
    throw new Error("Expected text length byte 2 -> 0, got " + bytes[2]);
  }

  if (bytes[3] !== 0) {
    throw new Error("Expected text length byte 3 -> 0, got " + bytes[3]);
  }

  if (bytes[4] !== 104) {
    throw new Error("Expected text byte 0 -> 104, got " + bytes[4]);
  }

  if (bytes[5] !== 105) {
    throw new Error("Expected text byte 1 -> 105, got " + bytes[5]);
  }
});

Deno.test("frontend text concatenation compiles through WAT to Wasm memory", async () => {
  const wat_text = wat_from_source('"hi" + "!"');
  const instance = await instantiate_wat(wat_text, "text_concat", {});

  if (!("memory" in instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 0) {
    throw new Error("Expected main() -> 0, got " + result);
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 0, 7);

  if (bytes[0] !== 3) {
    throw new Error("Expected text length byte 0 -> 3, got " + bytes[0]);
  }

  if (bytes[4] !== 104) {
    throw new Error("Expected text byte 0 -> 104, got " + bytes[4]);
  }

  if (bytes[5] !== 105) {
    throw new Error("Expected text byte 1 -> 105, got " + bytes[5]);
  }

  if (bytes[6] !== 33) {
    throw new Error("Expected text byte 2 -> 33, got " + bytes[6]);
  }
});

Deno.test("frontend text len compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let message = "hello"
@len(message)
`);
  const instance = await instantiate_wat(wat_text, "text_len", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 5) {
    throw new Error("Expected main() -> 5, got " + result);
  }
});

Deno.test("frontend no-else text fallback compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let flag = 0
let message = if flag {
  "hello"
}

@len(message)
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_no_else_text",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 0) {
    throw new Error("Expected main() -> 0, got " + result);
  }
});

Deno.test("frontend runtime text len compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let byte_len = (value: Text) => {
  @len(value)
}

byte_len("hello")
`);
  const instance = await instantiate_wat(wat_text, "runtime_text_len", {});

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 5) {
    throw new Error("Expected main() -> 5, got " + result);
  }
});

Deno.test("frontend runtime text append compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let add_suffix = (value: Text) => {
  @append(value, "!")
}

add_suffix("hi")
`);
  const instance = await instantiate_wat(
    wat_text,
    "frontend_runtime_text_append",
    {},
  );

  if (!("memory" in instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (typeof result !== "number") {
    throw new Error("Expected main() to return a text pointer");
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, result, 7);

  if (bytes[0] !== 3) {
    throw new Error(
      "Expected appended text length byte 0 -> 3, got " + bytes[0],
    );
  }

  if (bytes[4] !== 104) {
    throw new Error(
      "Expected appended text byte 0 -> 104, got " + bytes[4],
    );
  }

  if (bytes[5] !== 105) {
    throw new Error(
      "Expected appended text byte 1 -> 105, got " + bytes[5],
    );
  }

  if (bytes[6] !== 33) {
    throw new Error(
      "Expected appended text byte 2 -> 33, got " + bytes[6],
    );
  }
});

Deno.test("frontend runtime text equality compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let flag = 1
let same = if flag {
  (left: Text, right: Text) => left == right
} else {
  (left: Text, right: Text) => left != right
}
let different = if flag {
  (left: Text, right: Text) => left != right
} else {
  (left: Text, right: Text) => left == right
}

let same_result = if same("Ada", "Ada") { 1 } else { 0 }
let byte_mismatch = if same("Ada", "Adb") { 10 } else { 0 }
let length_mismatch = if different("Ada", "Grace") { 100 } else { 0 }
let not_same_result = if different("Ada", "Ada") { 1000 } else { 0 }

same_result + byte_mismatch + length_mismatch + not_same_result
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_equality",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 101) {
    throw new Error("Expected main() -> 101, got " + result);
  }
});

Deno.test("frontend runtime text slice compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_core_source(`
let flag = 1
let slicer = if flag {
  (value: Text, start: Int, end: Int) => @slice(value, start, end)
} else {
  (value: Text, start: Int, end: Int) => @slice(value, start, end)
}

let part: Text = slicer("Grace", 1, 4)
@len(part) * 1000 + @get(part, 0)
`);
  const instance = await instantiate_wat(
    wat_text,
    "@runtime_text_slice",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 3114) {
    throw new Error("Expected main() -> 3114, got " + result);
  }
});

Deno.test("frontend runtime text slice traps out of bounds", async () => {
  const wat_text = wat_from_core_source(`
let part: Text = @slice("Ada", 1, 4)
@len(part)
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_slice_oob",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for runtime text slice");
});

Deno.test("frontend runtime text byte index compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let byte_at = (value: Text, i) => {
  value[i]
}

byte_at("Ada", 2)
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_byte_index",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 97) {
    throw new Error("Expected main() -> 97, got " + result);
  }
});

Deno.test("frontend visible text argument byte index compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let byte_at = (value, i) => {
  value[i]
}

let i = 1

byte_at("Ada", i)
`);
  const instance = await instantiate_wat(
    wat_text,
    "visible_text_argument_byte_index",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 100) {
    throw new Error("Expected main() -> 100, got " + result);
  }
});

Deno.test("frontend text branch byte index traps only selected branch", async () => {
  const ok_wat_text = wat_from_source(`
let flag = 0
let message = if flag {
  "A"
} else {
  "BC"
}

message[1]
`);
  const ok_instance = await instantiate_wat(
    ok_wat_text,
    "visible_text_branch_byte_index_ok",
    {},
  );

  if (!("main" in ok_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof ok_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = ok_instance.exports.main();

  if (result !== 67) {
    throw new Error("Expected main() -> 67, got " + result);
  }

  const trap_wat_text = wat_from_source(`
let flag = 1
let message = if flag {
  "A"
} else {
  "BC"
}

message[1]
`);
  const trap_instance = await instantiate_wat(
    trap_wat_text,
    "visible_text_branch_byte_index_trap",
    {},
  );

  if (!("main" in trap_instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof trap_instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    trap_instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for selected short text branch");
});

Deno.test("frontend runtime text byte index traps out of bounds", async () => {
  const wat_text = wat_from_source(`
let byte_at = (value: Text, i) => {
  value[i]
}

byte_at("Ada", 3)
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_byte_index_oob",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for runtime text byte index");
});

Deno.test("frontend runtime text get compiles through WAT to Wasm", async () => {
  const wat_text = wat_from_source(`
let byte_at = (value: Text, i) => {
  @get(value, i)
}

byte_at("Ada", 2)
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_get",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 97) {
    throw new Error("Expected main() -> 97, got " + result);
  }
});

Deno.test("frontend runtime text get traps out of bounds", async () => {
  const wat_text = wat_from_source(`
let byte_at = (value: Text, i) => {
  @get(value, i)
}

byte_at("Ada", 3)
`);
  const instance = await instantiate_wat(
    wat_text,
    "runtime_text_get_oob",
    {},
  );

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  try {
    instance.exports.main();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      return;
    }

    throw error;
  }

  throw new Error("Expected main() to trap for runtime text get");
});

Deno.test("text pointer select compiles through WAT to Wasm memory", async () => {
  const expr: ExprNode = {
    tag: "let",
    name: "flag",
    value: { tag: "num", type: "i32", value: 0 },
    body: {
      tag: "prim",
      type: "i32",
      prim: "i32.select",
      args: [
        { tag: "text", value: "yes" },
        { tag: "text", value: "no" },
        { tag: "var", type: "i32", name: "flag" },
      ],
    },
  };
  const instance = await instantiate_wat(
    wat_from_expr(expr),
    "text_select",
    {},
  );

  if (!("memory" in instance.exports)) {
    throw new Error("Missing memory export");
  }

  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("memory export is not a WebAssembly.Memory");
  }

  if (!("main" in instance.exports)) {
    throw new Error("Missing main export");
  }

  if (typeof instance.exports.main !== "function") {
    throw new Error("main export is not a function");
  }

  const result = instance.exports.main();

  if (result !== 8) {
    throw new Error("Expected main() -> 8, got " + result);
  }

  const memory = instance.exports.memory;
  const bytes = new Uint8Array(memory.buffer, 8, 6);

  if (bytes[0] !== 2) {
    throw new Error(
      "Expected selected text length byte 0 -> 2, got " + bytes[0],
    );
  }

  if (bytes[4] !== 110) {
    throw new Error("Expected selected text byte 0 -> 110, got " + bytes[4]);
  }

  if (bytes[5] !== 111) {
    throw new Error("Expected selected text byte 1 -> 111, got " + bytes[5]);
  }
});
