import { assert_equals, assert_includes } from "../assert.ts";
import { Source } from "../frontend.ts";
import { Ic } from "../ic.ts";

Deno.test("character literals have the distinct Char source type", () => {
  const source = "let letter: Char = 'c';\nletter";

  assert_equals(Source.fmt(Source.parse("'c'")), "'c'");
  assert_equals(Source.analyze(source).diagnostics, []);
  assert_equals(Ic.reduce(Source.compile(source)), {
    tag: "num",
    type: "i32",
    value: 99,
  });

  const wat = Source.wat(source);
  assert_includes(wat, "(func $main (result i32)");
  assert_includes(wat, "i32.const 99");
});

Deno.test("Char and I32 annotations reject values of the other type", () => {
  const char_as_i32 = Source.analyze("let value: I32 = 'c';\nvalue");
  const i32_as_char = Source.analyze("let value: Char = 99;\nvalue");

  assert_equals(
    char_as_i32.diagnostics.map(({ code, message }) => ({ code, message })),
    [{ code: "DUCK2306", message: "Binding annotation expects I32, got Char" }],
  );
  assert_equals(
    i32_as_char.diagnostics.map(({ code, message }) => ({ code, message })),
    [{ code: "DUCK2306", message: "Binding annotation expects Char, got I32" }],
  );
});

Deno.test("checked casts expose a character's i32 representation", () => {
  const source = "let code: I32 = @cast('老', I32);\ncode";
  const runtime_character = `
let as_character = (value: I32) => {
  let character: Char = @cast(value, Char);
  character
};
as_character(68) == 'D'
`;

  assert_equals(Source.analyze(source).diagnostics, []);
  assert_includes(Source.wat(source), "i32.const 32769");
  assert_equals(Source.analyze(runtime_character).diagnostics, []);
  assert_includes(Source.wat(runtime_character), "i32.const 68");
});

Deno.test("source cast wrappers retain inferred character results", () => {
  const source = `
const cast = (value, const target) => @cast(value, target);
let is_line_break = (byte: I32) => {
  let character = cast(byte, Char);
  character == '\\n'
};
is_line_break(10)
`;

  assert_equals(Source.analyze(source).diagnostics, []);
  assert_includes(Source.wat(source), "i32.const 10");
});

Deno.test("Char equality is closed over Char and arithmetic rejects Char", () => {
  assert_equals(Source.analyze("'c' == 'C'").diagnostics, []);

  const arithmetic = Source.analyze("'c' + 1");
  const mixed_equality = Source.analyze("'c' == 99");

  assert_equals(
    arithmetic.diagnostics.map(({ code, message }) => ({ code, message })),
    [{
      code: "DUCK2302",
      message: "Primitive i32.add expects numeric operands, got Char",
    }],
  );
  assert_equals(
    mixed_equality.diagnostics.map(({ code, message }) => ({ code, message })),
    [{ code: "DUCK2302", message: "Char equality requires Char operands" }],
  );
});

Deno.test("character literals are exact types and type_of preserves them", () => {
  const direct = "const letter: 'c' = 'c';\nletter";
  const reflected = "const letter_type = @type_of('c');\n" +
    "let letter: letter_type = 'c';\nletter";
  const widened = "const char_type = @type_of(@cast('c', Char));\n" +
    "let letter: char_type = 'C';\nletter";

  assert_equals(Source.analyze(direct).diagnostics, []);
  assert_includes(Source.wat(reflected), "i32.const 99");
  assert_includes(Source.wat(widened), "i32.const 67");
  assert_equals(
    Source.fmt(Source.parse("type Letter = 'c' :| 'C'")),
    "type Letter = 'c' :| 'C'",
  );

  const mismatch = Source.analyze("const letter: 'c' = 'C';\nletter");
  assert_equals(
    mismatch.diagnostics.map(({ code, message }) => ({ code, message })),
    [{ code: "DUCK2306", message: "Binding annotation expects 'c', got 'C'" }],
  );
});

Deno.test("declared fields cases and parameters retain Char", () => {
  const aggregate = `
type Box = struct {.letter = Char}
type Option = | \`LetterValue Char | \`NoLetter Unit
let box: Box = [.letter = 'c'];
let from_box: Char = box.letter;
let option: Option = \`LetterValue ('c');
if let \`LetterValue letter = option { letter == 'c' } else { false }
`;
  const call = "let identity = (value: Char) => value;\nidentity('c')";

  assert_equals(Source.analyze(aggregate).diagnostics, []);
  assert_equals(Source.analyze(call).diagnostics, []);
  assert_includes(Source.wat(call), "i32.const 99");

  const invalid_field = Source.analyze(`
type Box = struct {.letter = Char}
let box: Box = [.letter = 99];
box.letter
`);
  const invalid_case = Source.analyze(`
type Option = | \`LetterValue Char | \`NoLetter Unit
\`LetterValue (99)
`);
  const invalid_call = Source.analyze(
    "let identity = (value: Char) => value;\nidentity(99)",
  );

  assert_equals(
    invalid_field.diagnostics.map(({ code, message }) => ({ code, message })),
    [{
      code: "DUCK2306",
      message: "Struct field letter expects Char, got I32",
    }],
  );
  assert_equals(
    invalid_case.diagnostics.map(({ code, message }) => ({ code, message })),
    [{
      code: "DUCK2305",
      message: "Union case LetterValue expects Char, got I32",
    }],
  );
  assert_equals(
    invalid_call.diagnostics.map(({ code, message }) => ({ code, message })),
    [{
      code: "DUCK2307",
      message:
        "Call to identity argument 1 for parameter value expects Char, got I32",
    }],
  );
});

Deno.test("dynamic homogeneous Char fields retain Char semantics", () => {
  const arithmetic = Source.analyze(`
let pair = [.first = 'a', .second = 'b'];
pair[input] + 1
`);

  assert_equals(
    arithmetic.diagnostics.map(({ code, message }) => ({ code, message })),
    [{
      code: "DUCK2302",
      message: "Primitive i32.add expects numeric operands, got Char",
    }],
  );
});
