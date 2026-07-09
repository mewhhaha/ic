import { assert_equals, assert_includes, assert_throws } from "./assert.ts";
import { Mod } from "./mod.ts";
import { Source } from "./parse.ts";

Deno.test("Source.parse parses function and infix declarations", () => {
  const source = `
    infixl 4 (+);
    fn (+) : i32 -> i32 -> i32;
    fn (+) a b = @i32_add a b;
    fn test : i32 -> i32;
    fn test x = x + x;
    export let result = test 21i32;
    result;
  `;

  assert_equals(Source.parse(source), {
    statements: [
      {
        tag: "let",
        name: "+",
        value: {
          tag: "lam",
          name: "a",
          body: {
            tag: "lam",
            name: "b",
            body: {
              tag: "prim",
              prim: "i32.add",
              args: [
                { tag: "var", name: "a" },
                { tag: "var", name: "b" },
              ],
            },
          },
        },
        exported: false,
      },
      {
        tag: "let",
        name: "test",
        value: {
          tag: "lam",
          name: "x",
          body: {
            tag: "app",
            func: {
              tag: "app",
              func: { tag: "var", name: "+" },
              arg: { tag: "var", name: "x" },
            },
            arg: { tag: "var", name: "x" },
          },
        },
        exported: false,
      },
      {
        tag: "let",
        name: "result",
        exported: true,
        value: {
          tag: "app",
          func: { tag: "var", name: "test" },
          arg: { tag: "num", type: "i32", value: 21 },
        },
      },
      { tag: "expr", value: { tag: "var", name: "result" } },
    ],
  });
});

Deno.test("Source.parse applies declared precedence", () => {
  const source = `
    infixl 4 (+);
    infixl 5 (*);
    fn (+) a b = @i32_add a b;
    fn (*) a b = @i32_mul a b;
    1i32 + 2i32 * 3i32;
  `;

  const surface = Source.parse(source);
  const last = surface.statements[2];

  assert_equals(last, {
    tag: "expr",
    value: {
      tag: "app",
      func: {
        tag: "app",
        func: { tag: "var", name: "+" },
        arg: { tag: "num", type: "i32", value: 1 },
      },
      arg: {
        tag: "app",
        func: {
          tag: "app",
          func: { tag: "var", name: "*" },
          arg: { tag: "num", type: "i32", value: 2 },
        },
        arg: { tag: "num", type: "i32", value: 3 },
      },
    },
  });
});

Deno.test("Source.emit compiles compiler intrinsics", () => {
  const wat = Mod.emit(Source.emit("export big = @i64_add 1i64 2i64;"));

  assert_includes(wat, "i64.const 3");
  assert_includes(wat, '(export "big" (func $big))');
});

Deno.test("Source.emit compiles example source", async () => {
  const source = await Deno.readTextFile("examples/main.ic");
  const wat = Mod.emit(Source.emit(source));

  assert_includes(wat, '(export "result" (func $result))');
  assert_includes(wat, '(export "main" (func $main))');
  assert_includes(wat, "i32.const 21");
  assert_includes(wat, "i32.add");
});

Deno.test("Source.parse rejects untyped numeric literals", () => {
  assert_throws(
    () => Source.parse("42;"),
    "Numeric literal must end with i32 or i64",
  );
});

Deno.test("Source.parse rejects undeclared infix operators", () => {
  assert_throws(
    () => Source.parse("1i32 + 2i32;"),
    "Operator + is not declared",
  );
});

Deno.test("Source.parse rejects unknown compiler intrinsics", () => {
  assert_throws(
    () => Source.parse("@mystery 1i32 2i32;"),
    "Unknown compiler intrinsic @mystery",
  );
});
