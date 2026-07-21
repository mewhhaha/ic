import { assert_equals, assert_throws } from "./assert.ts";
import {
  f32x4_builtin_name,
  f32x4_builtin_prim,
  numeric_builtin_name,
  numeric_builtin_prim,
  Prim,
  specialize_prim_for_operands,
} from "./op.ts";
import { Callable, Emit, Format } from "./trait.ts";

Deno.test("Prim.fmt formats typed primitives", () => {
  assert_equals(Format.fmt(Prim, "i32.add"), "+");
  assert_equals(Format.fmt(Prim, "i64.add"), "+");
  assert_equals(Format.fmt(Prim, "i32.sub"), "-");
  assert_equals(Format.fmt(Prim, "i64.sub"), "-");
  assert_equals(Format.fmt(Prim, "i32.mul"), "*");
  assert_equals(Format.fmt(Prim, "i64.mul"), "*");
  assert_equals(Format.fmt(Prim, "i32.div_s"), "/");
  assert_equals(Format.fmt(Prim, "i64.rem_s"), "%");
  assert_equals(Format.fmt(Prim, "i32.eq"), "==");
  assert_equals(Format.fmt(Prim, "i64.lt_s"), "<");
  assert_equals(Format.fmt(Prim, "i32.ge_s"), ">=");
  assert_equals(Format.fmt(Prim, "i32.select"), "select");
  assert_equals(Format.fmt(Prim, "i32.load"), "load");
  assert_equals(Format.fmt(Prim, "i32.load8_u"), "load8_u");
  assert_equals(Format.fmt(Prim, "i32.trap"), "trap");
});

Deno.test("Prim.arity returns primitive arity", () => {
  assert_equals(Callable.arity(Prim, "i32.add"), 2);
  assert_equals(Callable.arity(Prim, "i64.mul"), 2);
  assert_equals(Callable.arity(Prim, "i32.rem_s"), 2);
  assert_equals(Callable.arity(Prim, "i32.lt_s"), 2);
  assert_equals(Callable.arity(Prim, "i64.select"), 3);
  assert_equals(Callable.arity(Prim, "i32.load"), 1);
  assert_equals(Callable.arity(Prim, "i32.load8_u"), 1);
  assert_equals(Callable.arity(Prim, "i32.trap"), 0);
});

Deno.test("Prim.type returns primitive function signatures", () => {
  assert_equals(Callable.type(Prim, "i32.add"), {
    args: ["i32", "i32"],
    result: "i32",
  });
  assert_equals(Callable.type(Prim, "i64.mul"), {
    args: ["i64", "i64"],
    result: "i64",
  });
  assert_equals(Callable.type(Prim, "i32.div_s"), {
    args: ["i32", "i32"],
    result: "i32",
  });
  assert_equals(Callable.type(Prim, "i64.lt_s"), {
    args: ["i64", "i64"],
    result: "i32",
  });
  assert_equals(Callable.type(Prim, "i64.select"), {
    args: ["i64", "i64", "i32"],
    result: "i64",
  });
  assert_equals(Callable.type(Prim, "i32.load"), {
    args: ["i32"],
    result: "i32",
  });
  assert_equals(Callable.type(Prim, "i32.load8_u"), {
    args: ["i32"],
    result: "i32",
  });
  assert_equals(Callable.type(Prim, "i32.trap"), {
    args: [],
    result: "i32",
  });
});

Deno.test("Prim specializes parse-time defaults from operand types", () => {
  assert_equals(
    specialize_prim_for_operands("i32.add", "i64", "i64"),
    "i64.add",
  );
  assert_equals(
    specialize_prim_for_operands("i32.lt_s", "i64", "i64"),
    "i64.lt_s",
  );
  assert_equals(
    specialize_prim_for_operands("i64.add", "i32", "i32"),
    "i32.add",
  );
  assert_equals(
    specialize_prim_for_operands("i32.select", "i64", "i64"),
    "i32.select",
  );
  assert_throws(
    () => specialize_prim_for_operands("i32.add", "i64", "i32"),
    "Mixed i32 and i64 operands for operator +",
  );
});

Deno.test("Prim.emit returns the typed primitive instruction", () => {
  assert_equals(Emit.emit(Prim, "i32.sub"), "i32.sub");
  assert_equals(Emit.emit(Prim, "i64.mul"), "i64.mul");
  assert_equals(Emit.emit(Prim, "i32.div_s"), "i32.div_s");
  assert_equals(Emit.emit(Prim, "i32.eq"), "i32.eq");
  assert_equals(Emit.emit(Prim, "i32.select"), "select");
  assert_equals(Emit.emit(Prim, "i32.load"), "i32.load");
  assert_equals(Emit.emit(Prim, "i32.load8_u"), "i32.load8_u");
  assert_equals(Emit.emit(Prim, "i32.trap"), "unreachable");
  assert_equals(Emit.all(Prim, ["i32.sub", "i64.mul", "i32.eq"]), [
    "i32.sub",
    "i64.mul",
    "i32.eq",
  ]);
});

Deno.test("Prim exposes f32 arithmetic and explicit conversions", () => {
  assert_equals(Callable.type(Prim, "f32.add"), {
    args: ["f32", "f32"],
    result: "f32",
  });
  assert_equals(Callable.type(Prim, "f32.sqrt"), {
    args: ["f32"],
    result: "f32",
  });
  assert_equals(Callable.type(Prim, "f32.convert_i32_s"), {
    args: ["i32"],
    result: "f32",
  });
  assert_equals(Callable.type(Prim, "i32.trunc_f32_s"), {
    args: ["f32"],
    result: "i32",
  });
  assert_equals(Emit.emit(Prim, "f32.sqrt"), "f32.sqrt");
  assert_equals(Emit.emit(Prim, "i32.trunc_f32_s"), "i32.trunc_f32_s");
});

Deno.test("Prim exposes f64 arithmetic and i32 conversion", () => {
  assert_equals(Callable.type(Prim, "f64.add"), {
    args: ["f64", "f64"],
    result: "f64",
  });
  assert_equals(Callable.type(Prim, "f64.ge"), {
    args: ["f64", "f64"],
    result: "i32",
  });
  assert_equals(Callable.type(Prim, "f64.convert_i32_s"), {
    args: ["i32"],
    result: "f64",
  });
  assert_equals(Emit.emit(Prim, "f64.add"), "f64.add");
  assert_equals(Emit.emit(Prim, "f64.convert_i32_s"), "f64.convert_i32_s");
  assert_equals(Callable.type(Prim, "i32.trunc_f64_s"), {
    args: ["f64"],
    result: "i32",
  });
  assert_equals(Emit.emit(Prim, "i32.trunc_f64_s"), "i32.trunc_f64_s");
});

Deno.test("Prim maps public integer and f32 builtins", () => {
  assert_equals(numeric_builtin_prim("@bit_and"), "i32.and");
  assert_equals(numeric_builtin_prim("@shift_right_u"), "i32.shr_u");
  assert_equals(numeric_builtin_prim("@f32_sqrt"), "f32.sqrt");
  assert_equals(numeric_builtin_prim("@f32_from_i32"), "f32.convert_i32_s");
  assert_equals(numeric_builtin_prim("@i32_from_f32"), "i32.trunc_f32_s");
  assert_equals(numeric_builtin_prim("@f64_from_i32"), "f64.convert_i32_s");
  assert_equals(numeric_builtin_prim("@i32_from_f64"), "i32.trunc_f64_s");
  assert_equals(
    numeric_builtin_prim("@unsafe_i32_wrap_i64"),
    "i32.wrap_i64",
  );
  assert_equals(
    numeric_builtin_prim("@unsafe_i64_extend_i32_unsigned"),
    "i64.extend_i32_u",
  );
  assert_equals(
    numeric_builtin_prim("@unsafe_i32_reinterpret_f32"),
    "i32.reinterpret_f32",
  );
  assert_equals(
    numeric_builtin_name("f32.reinterpret_i32"),
    "@unsafe_f32_reinterpret_i32",
  );
  assert_equals(numeric_builtin_name("i64.xor"), "@bit_xor");
  assert_equals(numeric_builtin_name("i64.shl"), "@shift_left");

  assert_equals(
    specialize_prim_for_operands("i32.and", "i64", "i64"),
    "i64.and",
  );
  assert_equals(
    specialize_prim_for_operands("i32.add", "f32", "f32"),
    "f32.add",
  );
  assert_throws(
    () => specialize_prim_for_operands("i32.and", "f32", "f32"),
    "Operator @bit_and does not support f32 operands",
  );
});

Deno.test("Prim exposes typed F32x4 operations and public builtins", () => {
  assert_equals(f32x4_builtin_prim("@f32x4"), "f32x4.make");
  assert_equals(f32x4_builtin_prim("@f32x4_mul"), "f32x4.mul");
  assert_equals(
    f32x4_builtin_name("f32x4.extract_lane"),
    "@f32x4_extract_lane",
  );
  assert_equals(Callable.type(Prim, "f32x4.make"), {
    args: ["f32", "f32", "f32", "f32"],
    result: "v128",
  });
  assert_equals(Callable.type(Prim, "f32x4.replace_lane"), {
    args: ["v128", "i32", "f32"],
    result: "v128",
  });
  assert_equals(
    Callable.arity(Prim, "f32x4.replace_lane"),
    Callable.type(Prim, "f32x4.replace_lane").args.length,
  );
});
