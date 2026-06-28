import { assertEquals, assertIncludes, assertThrows } from "./assert.ts";
import { Mod } from "./mod.ts";
import { Source } from "./parse.ts";

Deno.test("Source.parse parses executable top-level source", () => {
  const source = `
    export let answer = 11i32 + 22i32;
    (fn x => x)(&Z{100i32, 200i32});
    answer;
  `;

  assertEquals(Source.parse(source), {
    statements: [
      {
        tag: "let",
        name: "answer",
        exported: true,
        value: {
          tag: "prim",
          prim: "i32.add",
          args: [
            { tag: "num", type: "i32", value: 11 },
            { tag: "num", type: "i32", value: 22 },
          ],
        },
      },
      {
        tag: "expr",
        value: {
          tag: "app",
          func: {
            tag: "lam",
            name: "x",
            body: { tag: "var", name: "x" },
          },
          arg: {
            tag: "sup",
            label: "Z",
            left: { tag: "num", type: "i32", value: 100 },
            right: { tag: "num", type: "i32", value: 200 },
          },
        },
      },
      { tag: "expr", value: { tag: "var", name: "answer" } },
    ],
  });
});

Deno.test("Source.parse preserves precedence", () => {
  const surface = Source.parse("1i32 + 2i32 * 3i32;");

  assertEquals(surface, {
    statements: [
      {
        tag: "expr",
        value: {
          tag: "prim",
          prim: "i32.add",
          args: [
            { tag: "num", type: "i32", value: 1 },
            {
              tag: "prim",
              prim: "i32.mul",
              args: [
                { tag: "num", type: "i32", value: 2 },
                { tag: "num", type: "i32", value: 3 },
              ],
            },
          ],
        },
      },
    ],
  });
});

Deno.test("Source.parse supports typed primitive calls", () => {
  const surface = Source.parse("export big = i64.add(1i64, 2i64);");
  const wat = Mod.emit(Source.emit("export big = i64.add(1i64, 2i64);"));

  assertEquals(surface.statements.length, 1);
  assertIncludes(wat, "i64.const 3");
  assertIncludes(wat, '(export "big" (func $big))');
});

Deno.test("Source.emit compiles example source", async () => {
  const source = await Deno.readTextFile("examples/main.ic");
  const wat = Mod.emit(Source.emit(source));

  assertIncludes(wat, '(export "answer" (func $answer))');
  assertIncludes(wat, '(export "main" (func $main))');
  assertIncludes(wat, "i32.const 33");
});

Deno.test("Source.parse rejects untyped numeric literals", () => {
  assertThrows(
    () => Source.parse("42;"),
    "Numeric literal must end with i32 or i64",
  );
});

Deno.test("Source.parse rejects primitive arity mismatches", () => {
  assertThrows(
    () => Source.parse("i32.add(1i32);"),
    "Primitive i32.add expects 2 arguments",
  );
});
