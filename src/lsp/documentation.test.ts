import { assert_equals } from "../assert.ts";
import {
  attached_documentation,
  render_documentation,
} from "./documentation.ts";

Deno.test("attached documentation accepts triple slash comments", () => {
  const text =
    "/// Adds two values.\nconst add = (left, right) => left + right\n";

  assert_equals(
    attached_documentation(text, text.indexOf("const")),
    "Adds two values.",
  );
});

Deno.test("TSDoc tags render as structured markdown", () => {
  const documentation = "Adds two values.\n" +
    "@param left The first value.\n" +
    "@param right The second value.\n" +
    "@returns Their sum.\n" +
    "@remarks Inputs must have the same type.";

  assert_equals(
    render_documentation(documentation),
    "Adds two values.\n\n" +
      "**Parameters**\n\n" +
      "- `left` — The first value.\n" +
      "- `right` — The second value.\n\n" +
      "**Returns**\n\nTheir sum.\n\n" +
      "**Remarks**\n\nInputs must have the same type.",
  );
});
