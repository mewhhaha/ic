import { assertEquals, assertThrows } from "./assert.ts";
import { Mod, type Mod as ModNode } from "./mod.ts";

Deno.test("Mod.emit emits functions and exports", () => {
  const mod: ModNode = {
    funcs: {
      main: {
        name: "main",
        result: "i32",
        body: "i32.const 42",
      },
    },
    exports: ["main"],
  };

  assertEquals(
    Mod(mod).emit(),
    '(module\n  (func $main (result i32)\n    i32.const 42\n  )\n  (export "main" (func $main))\n)',
  );
});

Deno.test("Mod.emit rejects missing exports", () => {
  const mod: ModNode = {
    funcs: {},
    exports: ["main"],
  };

  assertThrows(() => Mod(mod).emit(), "Missing function for export: main");
});

Deno.test("Mod.emit rejects function key and name mismatches", () => {
  const mod: ModNode = {
    funcs: {
      main: {
        name: "other",
        result: "i32",
        body: "i32.const 42",
      },
    },
    exports: ["main"],
  };

  assertThrows(() => Mod(mod).emit(), "Function key/name mismatch: main");
});
