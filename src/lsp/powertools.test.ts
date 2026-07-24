import { assert_equals, assert_includes } from "../assert.ts";
import {
  expand_comptime,
  powertools_code_lenses,
  route_execute_command,
} from "./powertools.ts";

const adder = "const make_adder = n => { x => x + n };\n" +
  "const add_three = comptime make_adder 3;\n" +
  "add_three 39\n";

Deno.test("powertools expands comptime closures with captures", () => {
  const position = {
    line: 1,
    character: adder.indexOf("make_adder 3") -
      adder.lastIndexOf("\n", adder.indexOf("make_adder 3")) - 1,
  };
  const result = expand_comptime(adder, position, "utf-16");

  assert_equals(result.ok, true);

  if (result.ok) {
    assert_includes(result.value.source, "x => x + n");
    assert_includes(result.value.source, "captured n = 3");
    assert_equals(result.value.facts, [{
      kind: "capture",
      name: "n",
      value: "3",
    }]);
    assert_equals(result.value.trace, [{
      kind: "input",
      detail: "make_adder 3",
    }, {
      kind: "capture",
      detail: "n = 3",
    }, {
      kind: "result",
      detail: "x => x + n",
    }]);
  }
});

Deno.test("powertools reports frontend evaluation failures and invalid positions", () => {
  assert_equals(
    expand_comptime(
      'comptime @fail("bad")\n',
      { line: 0, character: 5 },
      "utf-16",
    ),
    { ok: false, code: "evaluation_failed", message: "@fail: bad" },
  );
  assert_equals(
    expand_comptime(adder, { line: 99, character: 0 }, "utf-16"),
    {
      ok: false,
      code: "invalid_position",
      message: "position line is outside the document",
    },
  );
});

Deno.test("powertools trace records successful frontend fact checks", () => {
  const text = `const nonzero = value => {
  if value == 0 { @fail("zero") } else { value }
};
let checked = (const value: nonzero) => value;
comptime checked(3)
`;
  const result = expand_comptime(
    text,
    { line: 4, character: 12 },
    "utf-16",
  );

  if (!result.ok) {
    throw new Error("Expected successful checked comptime expansion");
  }

  assert_equals(
    result.value.trace.some((step) =>
      step.kind === "fact_check" && step.detail === "nonzero(3) passed"
    ),
    true,
  );
  assert_equals(result.value.source, "3");
});

Deno.test("powertools discovers compile expand and runnable code lenses", () => {
  const uri = "file:///workspace/examples/compile_time/01_comptime_adder.duck";
  const lenses = powertools_code_lenses(uri, adder, "utf-16");

  assert_equals(lenses.map((lens) => lens.title), [
    "▸ expand",
    "▸ run example",
  ]);

  const run = route_execute_command({
    command: "duck.runExample",
    uri,
    text: adder,
    encoding: "utf-16",
  });
  assert_equals(run, {
    ok: true,
    value: {
      command: "deno",
      args: [
        "test",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "examples/examples.test.ts",
        "--filter",
        "example runs: examples/compile_time/01_comptime_adder.duck",
      ],
    },
  });
});

Deno.test("powertools rejects run commands outside the example manifest", () => {
  assert_equals(
    route_execute_command({
      command: "duck.runExample",
      uri: "file:///scratch/unknown.duck",
      text: "0",
      encoding: "utf-16",
    }),
    {
      ok: false,
      code: "unsupported_route",
      message: "This file is not a runnable manifest example",
    },
  );
});
