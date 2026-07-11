import { assert_equals, assert_throws } from "../assert.ts";
import { format_source } from "./format.ts";
import { parse_source } from "./parser.ts";
import { TestSource } from "./test_source.ts";

Deno.test("effect ownership sigils parse and format canonically", () => {
  const source = parse_source(`
declare effect Io {
  write: (&Text, #Bytes, Text, Packet, I32) => #Text
  read: () => Text
}
`);

  assert_equals(source.declarations, [{
    tag: "effect",
    implementation: "host",
    name: "Io",
    operations: [
      {
        name: "write",
        params: [
          { type_name: "Text", ownership: "bounded_borrow" },
          { type_name: "Bytes", ownership: "frozen_shareable" },
          { type_name: "Text", ownership: "ownership_transfer" },
          { type_name: "Packet", ownership: "ownership_transfer" },
          { type_name: "I32", ownership: "scalar" },
        ],
        result: { type_name: "Text", ownership: "frozen_shareable" },
      },
      {
        name: "read",
        params: [],
        result: { type_name: "Text", ownership: "unique_heap" },
      },
    ],
  }]);
  assert_equals(
    format_source(source),
    "declare effect Io { write: (&Text, #Bytes, Text, Packet, I32) => #Text, read: () => Text }",
  );
});

Deno.test("legacy effect ownership words remain accepted aliases", () => {
  const source = parse_source(
    "declare effect Io { write: (bounded_borrow Text, frozen_shareable Bytes, ownership_transfer Text) => frozen_shareable Text }",
  );

  assert_equals(
    format_source(source),
    "declare effect Io { write: (&Text, #Bytes, Text) => #Text }",
  );
});

Deno.test("effect results reject bounded borrow sigils", () => {
  assert_throws(
    () => parse_source("declare effect Io { read: () => &Text }"),
    "Effect results cannot use bounded borrow ownership",
  );
});

Deno.test("raw host import ownership sigils parse and format canonically", () => {
  const source = TestSource.parse(
    'host_import transfer from "host.transfer" (&Text, #Bytes, Text, I32) => #Text',
  );

  assert_equals(source.statements, [{
    tag: "host_import",
    value: {
      name: "transfer",
      module: "host",
      field: "transfer",
      params: ["i32", "i32", "i32", "i32"],
      result: "i32",
      args: [
        { tag: "bounded_borrow", reason: "text" },
        { tag: "frozen_shareable", reason: "bytes" },
        { tag: "ownership_transfer", reason: "text" },
        { tag: "scalar" },
      ],
      result_owner: { tag: "frozen_shareable", reason: "text" },
    },
  }]);
  assert_equals(
    format_source(source),
    'host_import transfer from "host.transfer" (&Text, #Bytes, Text, I32) => #Text',
  );
});

Deno.test("raw host import plain rich values retain legacy transfer semantics", () => {
  const source = TestSource.parse(
    'host_import copy from "host.copy" (ownership_transfer Packet) => unique_heap Packet',
  );

  assert_equals(
    format_source(source),
    'host_import copy from "host.copy" (Packet) => Packet',
  );
  assert_throws(
    () => TestSource.parse('host_import bad from "host.bad" () => &Text'),
    "Host import results cannot use bounded borrow ownership",
  );
});
