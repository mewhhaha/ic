import { expect } from "./expect.ts";

/** A half-open range of UTF-16 offsets in a JavaScript source string. */
export type SourceSpan = {
  start: number;
  end: number;
};

const source_spans = new WeakMap<object, SourceSpan>();
const source_span_origins = new WeakMap<object, "concrete" | "derived">();

export function mark_source_span<node extends object>(
  value: node,
  span: SourceSpan,
): node {
  validate_span(span);
  source_spans.set(value, span);
  source_span_origins.set(value, "concrete");
  return value;
}

export function inherit_source_span<node extends object>(
  value: node,
  source: object,
): node {
  return derive_source_span(value, source_span(source));
}

export function derive_source_span<node extends object>(
  value: node,
  span: SourceSpan,
): node {
  validate_span(span);
  source_spans.set(value, span);
  source_span_origins.set(value, "derived");
  return value;
}

export function source_span(value: object): SourceSpan {
  const span = source_spans.get(value);
  expect(span !== undefined, "Missing source span");
  return span;
}

export function has_source_span(value: object): boolean {
  return source_spans.has(value);
}

export function source_span_origin(value: object): "concrete" | "derived" {
  const origin = source_span_origins.get(value);
  expect(origin !== undefined, "Missing source span origin");
  return origin;
}

export function has_concrete_source_span(value: object): boolean {
  return source_span_origin(value) === "concrete";
}

function validate_span(span: SourceSpan): void {
  expect(Number.isInteger(span.start), "Source span start must be an integer");
  expect(Number.isInteger(span.end), "Source span end must be an integer");
  expect(span.start >= 0, "Source span start must not be negative");
  expect(span.end >= span.start, "Source span end precedes start");
}
