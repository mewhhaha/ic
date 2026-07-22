import { assert_equals } from "../assert.ts";
import { build_binding_index } from "../frontend/binding_index.ts";
import { parse_source_with_diagnostics } from "../frontend/parser.ts";
import {
  default_inlay_hint_config,
  inlay_hints,
  type InlayHintCategory,
  type InlayHintConfig,
  type LspInlayHint,
  resolve_inlay_hint,
} from "./inlay_hints.ts";

type HintDump = {
  line: number;
  character: number;
  label: string;
  kind: number | undefined;
  category: InlayHintCategory;
};

function category_config(category: InlayHintCategory): InlayHintConfig {
  return {
    types: category === "types",
    effects: category === "effects",
    ownership: category === "ownership",
    comptime: category === "comptime",
    loops: category === "loops",
  };
}

function hints(
  text: string,
  config: InlayHintConfig,
  start = 0,
  end = text.length,
): LspInlayHint[] {
  const parsed = parse_source_with_diagnostics(text);
  assert_equals(parsed.diagnostics, []);
  const index = build_binding_index(parsed, 1);
  return inlay_hints(
    parsed.source,
    parsed.syntax,
    index,
    "file:///fixture.duck",
    { start, end },
    "utf-16",
    config,
  );
}

function dump(items: LspInlayHint[]): HintDump[] {
  return items.map((hint) => ({
    line: hint.position.line,
    character: hint.position.character,
    label: hint.label,
    kind: hint.kind,
    category: hint.data.category,
  }));
}

Deno.test("inlay type hints snapshot bindings and closure parameters", () => {
  const text = "let identity = value => value\n" +
    "let answer = identity(42)\n" +
    'let message = "hello"\n';

  assert_equals(dump(hints(text, category_config("types"))), [{
    line: 0,
    character: 20,
    label: ": I32",
    kind: 1,
    category: "types",
  }, {
    line: 1,
    character: 10,
    label: ": I32",
    kind: 1,
    category: "types",
  }, {
    line: 2,
    character: 11,
    label: ": Text",
    kind: 1,
    category: "types",
  }]);
});

Deno.test("inlay type hints identify boolean values", () => {
  const text = "let ready = true\n" +
    "let compared = 1 < 2\n";

  assert_equals(dump(hints(text, category_config("types"))), [{
    line: 0,
    character: 9,
    label: ": Bool",
    kind: 1,
    category: "types",
  }, {
    line: 1,
    character: 12,
    label: ": Bool",
    kind: 1,
    category: "types",
  }]);
});

Deno.test("inlay type hints identify character values", () => {
  const text = "let letter = 'c'\n";

  assert_equals(dump(hints(text, category_config("types"))), [{
    line: 0,
    character: 10,
    label: ": Char",
    kind: 1,
    category: "types",
  }]);
});

Deno.test("inlay type hints render positional product structure", () => {
  const text = "let pair = [1, true]\n";

  assert_equals(dump(hints(text, category_config("types"))), [{
    line: 0,
    character: 8,
    label: ": [I32, Bool]",
    kind: 1,
    category: "types",
  }]);
});

Deno.test("inlay type hints resolve source-defined extension methods", () => {
  const text = 'const { struct } = import "duck:prelude" ()\n' +
    'let value: Text = "duck"\n' +
    "let length = value.length()\n";

  assert_equals(dump(hints(text, category_config("types"))), [{
    line: 2,
    character: 10,
    label: ": I32",
    kind: 1,
    category: "types",
  }]);
});

Deno.test("inlay effect hints snapshot inferred row and result", () => {
  const text = "declare effect Io { read: () => Text }\n" +
    "let greet = () => {\n" +
    "  value <- Io.read()\n" +
    "  value\n" +
    "}\n";

  assert_equals(dump(hints(text, category_config("effects"))), [{
    line: 1,
    character: 9,
    label: " -> <Io.read>...",
    kind: 1,
    category: "effects",
  }]);
});

Deno.test("inlay labels cap at sixteen characters and retain full detail", () => {
  const text = "const identity = (const specialization, value) => value\n" +
    "let answer = identity(123456789, 42)\n";
  const hint = hints(text, category_config("comptime")).find((candidate) => {
    return candidate.label.endsWith("...");
  });

  if (hint === undefined) {
    throw new Error("Missing truncated inlay hint");
  }

  assert_equals([...hint.label].length, 16);
  assert_equals(hint.label, " [specializat...");
  assert_equals(resolve_inlay_hint(hint).tooltip, {
    kind: "markdown",
    value: "Specialized const parameters: specialization = 123456789",
  });
});

Deno.test("inlay type hints annotate state binding names", () => {
  const text = "declare effect Io { read: () => Text }\n" +
    "let greet = () => {\n" +
    "  value <- Io.read()\n" +
    "  value\n" +
    "}\n";

  assert_equals(dump(hints(text, category_config("types"))), [{
    line: 2,
    character: 7,
    label: ": Text",
    kind: 1,
    category: "types",
  }]);
});

Deno.test("inlay ownership hints snapshot call boundaries", () => {
  const text = "declare effect Host { send: (&Text, #Text, Text) => Unit }\n" +
    'let value = "x"\n' +
    "let frozen = freeze value\n" +
    "Host.send(&value, frozen, value)\n";

  assert_equals(dump(hints(text, category_config("ownership"))), [{
    line: 3,
    character: 10,
    label: "borrow ",
    kind: 2,
    category: "ownership",
  }, {
    line: 3,
    character: 18,
    label: "share ",
    kind: 2,
    category: "ownership",
  }, {
    line: 3,
    character: 26,
    label: "move ",
    kind: 2,
    category: "ownership",
  }]);
});

Deno.test("inlay comptime hints snapshot folds and specializations", () => {
  const text = "const choose = (const n, value) => value\n" +
    "const folded = comptime 40 + 2\n" +
    "let result = choose(3, folded)\n";

  assert_equals(dump(hints(text, category_config("comptime"))), [{
    line: 1,
    character: 30,
    label: " = 42",
    kind: undefined,
    category: "comptime",
  }, {
    line: 2,
    character: 30,
    label: " [n = 3]",
    kind: undefined,
    category: "comptime",
  }]);
});

Deno.test("inlay comptime hints use the environment before each binding", () => {
  const text = "const n = 1\n" +
    "const before = comptime n\n" +
    "n = 2\n" +
    "const after = comptime n\n";

  assert_equals(dump(hints(text, category_config("comptime"))), [{
    line: 0,
    character: 11,
    label: " = 1",
    kind: undefined,
    category: "comptime",
  }, {
    line: 1,
    character: 25,
    label: " = 1",
    kind: undefined,
    category: "comptime",
  }, {
    line: 3,
    character: 24,
    label: " = 2",
    kind: undefined,
    category: "comptime",
  }]);
});

Deno.test("inlay loop hints snapshot static expansion counts", () => {
  const text = "for index in 1..5 {\n" +
    "  index\n" +
    "}\n" +
    'for byte in "abc" {\n' +
    "  byte\n" +
    "}\n";

  assert_equals(dump(hints(text, category_config("loops"))), [{
    line: 0,
    character: 17,
    label: " × 4",
    kind: undefined,
    category: "loops",
  }, {
    line: 3,
    character: 17,
    label: " × 3",
    kind: undefined,
    category: "loops",
  }]);
});

Deno.test("inlay category configuration removes exactly that category", () => {
  const text = "const choose = (const n, value) => value\n" +
    "const folded = comptime 40 + 2\n" +
    "let result = choose(3, folded)\n";
  const enabled = default_inlay_hint_config();
  const all = hints(text, enabled);
  const disabled = { ...enabled, comptime: false };
  const without_comptime = hints(text, disabled);

  assert_equals(
    all.filter((hint) => hint.data.category !== "comptime"),
    without_comptime,
  );
  assert_equals(
    all.some((hint) => hint.data.category === "comptime"),
    true,
  );
});

Deno.test("inlay ranges and reparses preserve positions after earlier edits", () => {
  const original = "let first = 1\nlet second = 2\n";
  const shifted = "// inserted\n" + original;
  const range_start = original.indexOf("let second");
  const ranged = dump(
    hints(original, category_config("types"), range_start, original.length),
  );
  const shifted_hints = dump(hints(shifted, category_config("types")));

  assert_equals(ranged, [{
    line: 1,
    character: 10,
    label: ": I32",
    kind: 1,
    category: "types",
  }]);
  assert_equals(shifted_hints, [{
    line: 1,
    character: 9,
    label: ": I32",
    kind: 1,
    category: "types",
  }, {
    line: 2,
    character: 10,
    label: ": I32",
    kind: 1,
    category: "types",
  }]);
});

Deno.test("inlay ranges exclude a hint exactly at the range end", () => {
  const text = "let answer = 42\n";
  const hint_offset = text.indexOf("answer") + "answer".length;

  assert_equals(
    hints(text, category_config("types"), 0, hint_offset),
    [],
  );
  assert_equals(
    dump(hints(text, category_config("types"), hint_offset, text.length)),
    [{
      line: 0,
      character: 10,
      label: ": I32",
      kind: 1,
      category: "types",
    }],
  );
});

Deno.test("inlay resolve supplies deferred category detail", () => {
  const text = "let answer = 42\n";
  const hint = hints(text, category_config("types"))[0];

  if (hint === undefined) {
    throw new Error("Missing type hint");
  }

  assert_equals(resolve_inlay_hint(hint).tooltip, {
    kind: "markdown",
    value: "Inferred binding type: I32",
  });
});
