export function attached_documentation(
  text: string,
  definition_start: number,
): string | undefined {
  const definition_line = text.lastIndexOf("\n", definition_start - 1) + 1;
  let cursor = definition_line;
  const lines: string[] = [];

  while (cursor > 0) {
    const previous_end = cursor - 1;
    const previous_start = text.lastIndexOf("\n", previous_end - 1) + 1;
    const line = text.slice(previous_start, previous_end).trim();

    if (!line.startsWith("//")) {
      break;
    }

    let content = line.slice(2);

    if (content.startsWith("/")) {
      content = content.slice(1);
    }

    lines.unshift(content.trim());
    cursor = previous_start;
  }

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join("\n");
}

export function render_documentation(documentation: string): string {
  const summary: string[] = [];
  const parameters: string[] = [];
  const returns: string[] = [];
  const remarks: string[] = [];
  const other_tags: string[] = [];
  let active: string[] = summary;

  for (const line of documentation.split("\n")) {
    const parameter = line.match(/^@param\s+(\S+)\s*(.*)$/);

    if (parameter !== null) {
      const name = parameter[1];
      const description = parameter[2];
      parameters.push("- `" + name + "` — " + description);
      active = parameters;
      continue;
    }

    const returns_tag = line.match(/^@returns?\s*(.*)$/);

    if (returns_tag !== null) {
      returns.push(returns_tag[1]);
      active = returns;
      continue;
    }

    const remarks_tag = line.match(/^@remarks?\s*(.*)$/);

    if (remarks_tag !== null) {
      remarks.push(remarks_tag[1]);
      active = remarks;
      continue;
    }

    const tag = line.match(/^@(\S+)\s*(.*)$/);

    if (tag !== null) {
      other_tags.push("**@" + tag[1] + "** " + tag[2]);
      active = other_tags;
      continue;
    }

    if (line.startsWith("type:")) {
      active.push("> " + line);
      continue;
    }

    active.push(line);
  }

  const sections: string[] = [];
  append_documentation_section(sections, undefined, summary);
  append_documentation_section(sections, "Parameters", parameters);
  append_documentation_section(sections, "Returns", returns);
  append_documentation_section(sections, "Remarks", remarks);
  append_documentation_section(sections, undefined, other_tags);
  return sections.join("\n\n");
}

function append_documentation_section(
  sections: string[],
  heading: string | undefined,
  lines: string[],
): void {
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length === 0) {
    return;
  }

  if (heading !== undefined) {
    sections.push("**" + heading + "**\n\n" + lines.join("\n"));
    return;
  }

  sections.push(lines.join("\n"));
}
