import { assert_equals } from "../assert.ts";
import { build_binding_index } from "./binding_index.ts";
import { parse_source_with_diagnostics } from "./parser.ts";

function occurrences(text: string) {
  return [
    ...build_binding_index(parse_source_with_diagnostics(text), 7).occurrences
      .values(),
  ];
}

Deno.test("binding index resolves an assignment rhs before its shadow", () => {
  const indexed = occurrences("let x = 0\nx = x + 1\n");
  const xs = indexed.filter((occurrence) => occurrence.name === "x");

  assert_equals(xs.map((occurrence) => occurrence.role), [
    "definition",
    "reference",
    "shadow",
  ]);
  assert_equals(xs[0]?.entity, xs[1]?.entity);
  if (xs[0]?.entity === undefined || xs[2]?.entity === undefined) {
    throw new Error("Expected assignment entities");
  }
  assert_equals(xs[0].entity === xs[2].entity, false);
});

Deno.test("binding index keeps recursive self visible and linear repeats consumable", () => {
  const indexed = occurrences("let rec f = f\nlet !x = 0\n!x\n!x\n");
  const fs = indexed.filter((occurrence) => occurrence.name === "f");
  const xs = indexed.filter((occurrence) => occurrence.name === "x");

  assert_equals(fs[0]?.entity, fs[1]?.entity);
  assert_equals(xs.map((occurrence) => occurrence.role), [
    "definition",
    "consume",
    "consume",
  ]);
  assert_equals(xs[0]?.entity, xs[2]?.entity);
});

Deno.test("binding index resolves value-pack rest bindings", () => {
  const indexed = occurrences(
    "const first = (const ...values) => comptime match values {\n" +
      "  | () => 0\n" +
      "  | (value, ...remaining) => value + @len(remaining)\n" +
      "}\n",
  );
  const remaining = indexed.filter((occurrence) =>
    occurrence.name === "remaining"
  );

  assert_equals(remaining.map((occurrence) => occurrence.role), [
    "definition",
    "reference",
  ]);
  assert_equals(remaining[0]?.entity, remaining[1]?.entity);
});

Deno.test("binding index records members and dynamic receivers explicitly", () => {
  const indexed = build_binding_index(parse_source_with_diagnostics(
    "type Result = `Ok Unit\n" +
      "let value = `Ok ()\nlet field = value.name\n",
  ));
  const result = [...indexed.entities.values()].find((entity) =>
    entity.name === "Result"
  );
  if (result === undefined) throw new Error("Expected Result entity");
  assert_equals(indexed.member_lookup(result.id, "Ok")?.name, "Ok");
  const names = [...indexed.occurrences.values()].filter((occurrence) =>
    occurrence.name === "name"
  );
  assert_equals(names[0]?.unresolved, "dynamic_member");
});

Deno.test("binding index is deterministic and preserves recovered later names", () => {
  const parsed = parse_source_with_diagnostics("let = bad\nlet kept = kept\n");
  const first = build_binding_index(parsed, 2).dump();
  const second = build_binding_index(parsed, 2).dump();
  assert_equals(first, second);
  assert_equals(first.includes("kept definition"), true);
  assert_equals(first.includes("kept reference"), true);
});

Deno.test("binding index keeps declaration type parameters local to their declaration", () => {
  const indexed = build_binding_index(parse_source_with_diagnostics(
    "type Maybe a = | `Just a | `Nothing Unit\n" +
      "type Other = a\n0\n",
  ));
  const params = [...indexed.entities.values()].filter((entity) =>
    entity.name === "a"
  );
  const references = [...indexed.occurrences.values()].filter((occurrence) =>
    occurrence.name === "a" && occurrence.role === "reference"
  );

  assert_equals(params.length, 1);
  assert_equals(references.length, 2);
  assert_equals(references[0]?.entity, params[0]?.id);
  assert_equals(references[1]?.unresolved, "unknown");
});

Deno.test("binding index scopes effect parameters across operation signatures", () => {
  const indexed = build_binding_index(parse_source_with_diagnostics(
    "effect State value { get: () => value, put: (value) => Unit }\n0\n",
  ));
  const param = [...indexed.entities.values()].find((entity) =>
    entity.name === "value" && entity.kind === "type_parameter"
  );
  const references = [...indexed.occurrences.values()].filter((occurrence) =>
    occurrence.name === "value" && occurrence.role === "reference"
  );

  if (param === undefined) {
    throw new Error("Missing effect type parameter entity");
  }

  assert_equals(references.length, 2);
  assert_equals(references.map((reference) => reference.entity), [
    param.id,
    param.id,
  ]);
});

Deno.test("binding index uses nested annotation facts for statically known members", () => {
  const indexed = build_binding_index(parse_source_with_diagnostics(
    "type Vec = struct {.x = Int}\nif true { let point: Vec = [.x = 1]\npoint.x }\n",
  ));
  const member = [...indexed.occurrences.values()].find((occurrence) =>
    occurrence.name === "x" && occurrence.role === "member" &&
    occurrence.entity !== undefined
  );

  assert_equals(member?.unresolved, undefined);
  assert_equals(indexed.entities.get(member?.entity || "")?.kind, "field");
});

Deno.test("binding index resolves cases and reports the current lexical generation", () => {
  const text = "type Result = `Ok Int\nlet x = 0\n" +
    "{ let x = 1\nx }\nx\nlet result = `Ok (1)\n" +
    "if let `Ok value = result { value }\n";
  const indexed = build_binding_index(parse_source_with_diagnostics(text));
  const occurrences = [...indexed.occurrences.values()];
  const xs = occurrences.filter((occurrence) => occurrence.name === "x");
  const cases = occurrences.filter((occurrence) => occurrence.name === "ok");
  const references = xs.filter((occurrence) => occurrence.role === "reference");
  const inner = references[0];
  const outer = references[1];

  if (inner === undefined || outer === undefined) {
    throw new Error("Expected x references");
  }
  assert_equals(
    indexed.visible_at(inner.span.start).filter((entity) => entity.name === "x")
      .length,
    1,
  );
  assert_equals(
    indexed.visible_at(inner.span.start).find((entity) => entity.name === "x")
      ?.id,
    inner.entity,
  );
  assert_equals(
    indexed.visible_at(outer.span.start).find((entity) => entity.name === "x")
      ?.id,
    outer.entity,
  );
  assert_equals(
    cases.every((occurrence) => occurrence.entity !== undefined),
    true,
  );
});

Deno.test("binding index reference lists round-trip to their definition entities", () => {
  const indexed = build_binding_index(parse_source_with_diagnostics(
    "let x = 1\nx + x\n",
  ));

  for (const [entity, references] of indexed.references) {
    for (const reference of references) {
      assert_equals(indexed.occurrences.get(reference)?.entity, entity);
    }
  }
});

Deno.test("binding index visibility selects the generation active at the offset", () => {
  const text = "let x = 0\nx\nx = x + 1\nx\n";
  const indexed = build_binding_index(parse_source_with_diagnostics(text));
  const references = [...indexed.occurrences.values()].filter((occurrence) =>
    occurrence.name === "x" && occurrence.role === "reference"
  );
  const first = references[0];
  const last = references[2];

  if (first === undefined || last === undefined) {
    throw new Error("Expected references before and after the shadow");
  }

  assert_equals(
    indexed.visible_at(first.span.start).find((entity) => entity.name === "x")
      ?.id,
    first.entity,
  );
  assert_equals(
    indexed.visible_at(last.span.start).find((entity) => entity.name === "x")
      ?.id,
    last.entity,
  );
  assert_equals(
    indexed.visible_at(text.length).find((entity) => entity.name === "x")?.id,
    last.entity,
  );
});

Deno.test("binding index keeps owner members out of lexical visibility", () => {
  const text = "type Pair = struct {.left = Int}\nleft\n";
  const indexed = build_binding_index(parse_source_with_diagnostics(text));
  const reference = [...indexed.occurrences.values()].find((occurrence) =>
    occurrence.name === "left" && occurrence.role === "reference"
  );

  assert_equals(reference?.unresolved, "unknown");
  assert_equals(
    indexed.visible_at(text.length).some((entity) => entity.name === "left"),
    false,
  );
});

Deno.test("binding index resolves component annotation sites", () => {
  const indexed = build_binding_index(parse_source_with_diagnostics(
    "type Pair = struct {.left = Int}\nlet value: Pair = [.left = 1]\nvalue.left\n",
  ));
  const pair = [...indexed.entities.values()].find((entity) =>
    entity.name === "Pair"
  );
  const annotation = [...indexed.occurrences.values()].find((occurrence) =>
    occurrence.name === "Pair" && occurrence.role === "reference"
  );

  assert_equals(annotation?.entity, pair?.id);
});
