import type { Pattern } from "./ast.ts";

export function pattern_bindings(
  pattern: Pattern,
): Extract<Pattern, { tag: "binding" }>[] {
  if (pattern.tag === "binding") {
    return [pattern];
  }

  if (
    pattern.tag === "wildcard" || pattern.tag === "unit" ||
    pattern.tag === "literal" || pattern.tag === "value" ||
    pattern.tag === "type"
  ) {
    return [];
  }

  if (pattern.tag === "union_case") {
    if (pattern.value === undefined) {
      return [];
    }

    return pattern_bindings(pattern.value);
  }

  if (pattern.tag === "product") {
    const bindings: Extract<Pattern, { tag: "binding" }>[] = [];

    for (const entry of pattern.entries) {
      bindings.push(...pattern_bindings(entry.pattern));
    }

    return bindings;
  }

  if (pattern.tag === "record") {
    const bindings: Extract<Pattern, { tag: "binding" }>[] = [];

    for (const field of pattern.fields) {
      bindings.push(...pattern_bindings(field.pattern));
    }

    if (pattern.rest !== undefined) {
      bindings.push(...pattern_bindings(pattern.rest));
    }

    return bindings;
  }

  const bindings: Extract<Pattern, { tag: "binding" }>[] = [];

  for (const item of pattern.items) {
    bindings.push(...pattern_bindings(item));
  }

  if (pattern.rest !== undefined) {
    bindings.push(...pattern_bindings(pattern.rest));
  }

  return bindings;
}

export function shadow_pattern_names(
  names: Set<string>,
  pattern: Pattern,
): Set<string> {
  const local = new Set(names);

  for (const binding of pattern_bindings(pattern)) {
    local.delete(binding.name);
  }

  return local;
}
