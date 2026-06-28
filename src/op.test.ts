import { assertEquals } from "./assert.ts";
import { Prim } from "./op.ts";

Deno.test("Prim.fmt formats typed primitives", () => {
  assertEquals(Prim.fmt("i32.add"), "+");
  assertEquals(Prim.fmt("i64.add"), "+");
  assertEquals(Prim.fmt("i32.sub"), "-");
  assertEquals(Prim.fmt("i64.sub"), "-");
  assertEquals(Prim.fmt("i32.mul"), "*");
  assertEquals(Prim.fmt("i64.mul"), "*");
});

Deno.test("Prim.arity returns binary primitive arity", () => {
  assertEquals(Prim.arity("i32.add"), 2);
  assertEquals(Prim.arity("i64.mul"), 2);
});

Deno.test("Prim.type returns primitive function signatures", () => {
  assertEquals(Prim.type("i32.add"), {
    args: ["i32", "i32"],
    result: "i32",
  });
  assertEquals(Prim.type("i64.mul"), {
    args: ["i64", "i64"],
    result: "i64",
  });
});

Deno.test("Prim.emit returns the typed primitive instruction", () => {
  assertEquals(Prim.emit("i32.sub"), "i32.sub");
  assertEquals(Prim.emit("i64.mul"), "i64.mul");
});
