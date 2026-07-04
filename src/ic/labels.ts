import { expect } from "../expect.ts";

export function sanitize_label_part(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

export function ic_share_label(name: string, index: number): string {
  expect(index >= 0, "Share label index must be non-negative");
  expect(Number.isInteger(index), "Share label index must be an integer");
  return "share_" + sanitize_label_part(name) + "_" + index.toString();
}

export function expect_ic_label(label: string): void {
  expect(label.length > 0, "Ic label cannot be empty");
  expect(!/\s/.test(label), "Ic label cannot contain whitespace: " + label);
}
