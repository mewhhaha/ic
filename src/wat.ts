import type { NumType } from "./op.ts";

export type Wat = string;

export function wat_number(type: NumType, value: number | bigint): string {
  if (type !== "f32" && type !== "f64") {
    return value.toString();
  }

  if (typeof value !== "number") {
    throw new Error(type + " literal must use a number value");
  }

  if (Number.isNaN(value)) {
    return "nan";
  }

  if (value === Infinity) {
    return "inf";
  }

  if (value === -Infinity) {
    return "-inf";
  }

  if (Object.is(value, -0)) {
    return "-0";
  }

  if (type === "f32") {
    return Math.fround(value).toString();
  }

  return value.toString();
}

export function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);

  return text
    .split("\n")
    .map((line) => {
      if (line.length === 0) {
        return line;
      }

      return pad + line;
    })
    .join("\n");
}
