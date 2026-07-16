export function indent_lines(text: string, spaces: number): string {
  const padding = " ".repeat(spaces);
  return text.split("\n").map((line) => padding + line).join("\n");
}
