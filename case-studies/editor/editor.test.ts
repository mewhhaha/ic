import { assert_equals } from "../../src/assert.ts";
import { main } from "./editor.ts";
import { mock_runner } from "./host.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test("editor inserts saves and renders through the terminal effect", async () => {
  const runner = mock_runner(encoder.encode("abc"), [
    encoder.encode("iX"),
    encoder.encode("\x1b"),
    encoder.encode("wq"),
  ]);

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(runner.frames.length, 3);
    assert_equals(runner.saves.map((value) => decoder.decode(value)), [
      "Xabc",
    ]);
  } finally {
    runner.dispose();
  }
});

Deno.test("editor movement and deletion respect UTF-8 code point boundaries", async () => {
  const runner = mock_runner(encoder.encode("a老b"), [encoder.encode("ldwq")]);

  try {
    assert_equals(await main(runner), { code: 0 });
    assert_equals(runner.saves.map((value) => decoder.decode(value)), ["ab"]);
  } finally {
    runner.dispose();
  }
});
