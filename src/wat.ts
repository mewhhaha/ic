import type { ValType } from "./op.ts";

export type Wat = string;

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

export function main(body: Wat, result: ValType): Wat {
  return `
(module
  (func $main (result ${result})
${indent(body, 4)}
  )

  (export "main" (func $main))
)
`.trimStart();
}
