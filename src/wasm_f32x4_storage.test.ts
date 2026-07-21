import { assert_equals, assert_includes } from "./assert.ts";
import { instantiate_wat, wat_from_core_source } from "./wasm_test_util.ts";

function exported_main(instance: WebAssembly.Instance): CallableFunction {
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main function export");
  }

  return main;
}

Deno.test("runtime aggregates store and load 16-byte F32x4 fields", async () => {
  const wat = wat_from_core_source(`
const { struct } = import "duck:prelude" ()
const packet_type = struct {
  .prefix= I32,
  .lanes= F32x4
}

let choose = if true {
  (lanes: F32x4) => [.prefix = 7, .lanes = lanes] as packet_type
} else {
  (lanes: F32x4) => [.prefix = 8, .lanes = lanes] as packet_type
}

let packet: packet_type = choose(@f32x4(1f32, 2f32, 3f32, 4f32))
@f32x4_extract_lane(packet.lanes, 2) + @f32_from_i32(packet.prefix)
`);

  assert_includes(wat, "i32.const 32\n    i32.const 16\n    call $__alloc");
  assert_includes(wat, "v128.store offset=16");
  assert_includes(wat, "v128.load offset=16");

  const module_end = wat.lastIndexOf("\n)");
  if (module_end < 0) {
    throw new Error("Missing WAT module terminator");
  }
  const executable_wat = wat.slice(0, module_end) +
    '\n  (export "alloc" (func $__alloc))' + wat.slice(module_end);
  const instance = await instantiate_wat(
    executable_wat,
    "f32x4_aggregate",
    {},
  );
  assert_equals(exported_main(instance)(), 10);
  const alloc = instance.exports.alloc;
  if (typeof alloc !== "function") {
    throw new Error("Missing allocator function export");
  }
  const address = alloc(16, 16);
  assert_equals(Number(address) % 16, 0);
});

Deno.test("closure environments preserve captured F32x4 values", async () => {
  const wat = wat_from_core_source(`
let vector: F32x4 = @f32x4(1f32, 2f32, 3f32, 4f32)
let flag = true
let lane = if flag {
  (add: F32) => @f32x4_extract_lane(vector, 2) + add
} else {
  (add: F32) => @f32x4_extract_lane(vector, 3) + add
}

lane(39f32)
`);

  assert_includes(wat, "i32.const 32\n      i32.const 16\n      call $__alloc");
  assert_includes(wat, "v128.store offset=16");
  assert_includes(wat, "v128.load offset=16");

  const instance = await instantiate_wat(wat, "f32x4_closure_capture", {});
  assert_equals(exported_main(instance)(), 42);
});

Deno.test("runtime unions align F32x4 payloads after their tags", async () => {
  const wat = wat_from_core_source(`
type ResultType = | \`Ok F32x4 | \`Err F32x4
const result_type = ResultType

let flag = true
let result: result_type = if flag {
  \`Ok (@f32x4(1f32, 2f32, 3f32, 4f32))
} else {
  \`Err (@f32x4_splat(0f32))
}

if let \`Ok vector = result {
  @f32x4_extract_lane(vector, 3)
} else {
  0f32
}
`);

  assert_includes(wat, "i32.const 32\n      i32.const 16\n      call $__alloc");
  assert_includes(wat, "v128.store offset=16");
  assert_includes(wat, "v128.load offset=16");

  const instance = await instantiate_wat(wat, "f32x4_union_payload", {});
  assert_equals(exported_main(instance)(), 4);
});

Deno.test("named recursion accepts F32x4 parameters", async () => {
  const wat = wat_from_core_source(`
let rec lane_sum = (vector: F32x4, n: Int) => {
  if n == 0 {
    @i32_from_f32(@f32x4_extract_lane(vector, 2))
  } else {
    @i32_from_f32(@f32x4_extract_lane(vector, 0)) + lane_sum(vector, n - 1)
  }
}

lane_sum(@f32x4(1f32, 2f32, 3f32, 4f32), 2)
`);

  assert_includes(wat, "(func $lane_sum (param $vector v128)");
  assert_includes(wat, "call $lane_sum");

  const instance = await instantiate_wat(wat, "f32x4_named_recursion", {});
  assert_equals(exported_main(instance)(), 5);
});
