import type { Source } from "./ast.ts";
import { analyze_front_effects } from "./effect_analysis.ts";

export function source_with_host_callable_exports(source: Source): Source {
  const final_stmt = source.statements[source.statements.length - 1];

  if (
    !final_stmt || final_stmt.tag !== "return" ||
    final_stmt.value.tag !== "struct_value"
  ) {
    return source;
  }

  const bindings = new Map<
    string,
    Extract<Source["statements"][number], { tag: "bind" }>
  >();

  for (const stmt of source.statements) {
    if (stmt.tag === "bind") {
      bindings.set(stmt.name, stmt);
    }
  }

  const callable_names = new Set<string>();
  const result_fields: typeof final_stmt.value.fields = [];

  for (const field of final_stmt.value.fields) {
    if (field.value.tag !== "var") {
      result_fields.push(field);
      continue;
    }

    const binding = bindings.get(field.value.name);

    if (
      !binding || binding.type_annotation?.tag !== "arrow" ||
      (binding.value.tag !== "lam" && binding.value.tag !== "rec")
    ) {
      result_fields.push(field);
      continue;
    }

    if (field.name !== binding.name) {
      throw new Error(
        "Callable export field must match its binding name: " +
          field.name + " refers to " + binding.name,
      );
    }

    callable_names.add(binding.name);
  }

  if (callable_names.size === 0) {
    return source;
  }

  const effects = analyze_front_effects(source);

  for (const name of callable_names) {
    const binding = bindings.get(name);

    if (!binding || binding.type_annotation?.tag !== "arrow") {
      throw new Error("Missing callable binding: " + name);
    }

    const function_effects = effects.functions[name];

    if (
      binding.type_annotation.effects !== undefined ||
      (function_effects && function_effects.effects.length > 0)
    ) {
      throw new Error("Callable exports cannot use effects yet: " + name);
    }
  }

  const callable_return: typeof final_stmt = {
    ...final_stmt,
    value: { ...final_stmt.value, fields: result_fields },
  };
  const statements: Source["statements"] = source.statements.map((stmt) => {
    if (stmt === final_stmt) {
      return callable_return;
    }

    if (stmt.tag === "bind" && callable_names.has(stmt.name)) {
      return { ...stmt, kind: "let", host_export: true };
    }

    return stmt;
  });

  return { ...source, statements };
}
