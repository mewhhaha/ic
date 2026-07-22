import type { Source } from "./ast.ts";
import { resolve_bundled_source_imports } from "./load.ts";
import { infer_front_function_signatures } from "./signature_inference.ts";
import { source_facts, type SourceFacts } from "./source_facts.ts";

const cached_editor_source_facts = new WeakMap<Source, SourceFacts>();

export function editor_source_facts(source: Source): SourceFacts {
  const cached = cached_editor_source_facts.get(source);

  if (cached !== undefined) {
    return cached;
  }

  const fact_source = source_with_bundled_declarations(source);
  const base_facts = source_facts(fact_source);
  const inferred_source = infer_front_function_signatures(fact_source);

  if (inferred_source === fact_source) {
    cached_editor_source_facts.set(source, base_facts);
    return base_facts;
  }

  const facts = source_facts(inferred_source);
  const visited = new WeakSet<object>();

  for (let index = 0; index < source.statements.length; index += 1) {
    const statement = source.statements[index];
    const inferred_statement = inferred_source.statements[index];

    if (statement === undefined || inferred_statement === undefined) {
      continue;
    }

    transfer_editor_facts(
      statement,
      inferred_statement,
      facts,
      base_facts,
      visited,
      false,
    );
  }

  cached_editor_source_facts.set(source, facts);
  return facts;
}

function source_with_bundled_declarations(source: Source): Source {
  const imports_bundled_source = source.statements.some((statement) => {
    if (statement.tag !== "bind") {
      return false;
    }

    let value = statement.value;

    if (value.tag === "comptime") {
      value = value.expr;
    }

    return value.tag === "app" && value.func.tag === "import";
  });

  if (!imports_bundled_source) {
    return source;
  }

  const resolved = resolve_bundled_source_imports(source);
  return { ...source, declarations: resolved.declarations };
}

function transfer_editor_facts(
  subject: object,
  inferred_subject: object,
  facts: SourceFacts,
  base_facts: SourceFacts,
  visited: WeakSet<object>,
  prefer_inferred = true,
): void {
  if (visited.has(subject)) {
    return;
  }

  visited.add(subject);

  transfer_type_fact(
    subject,
    inferred_subject,
    facts.editor_type_of,
    base_facts.editor_type_of,
    prefer_inferred,
  );
  transfer_type_fact(
    subject,
    inferred_subject,
    facts.expected_type_of,
    base_facts.expected_type_of,
    prefer_inferred,
  );

  let front_type = base_facts.type_of.get(subject);

  if (prefer_inferred) {
    const inferred_type = facts.type_of.get(inferred_subject);

    if (inferred_type !== undefined && inferred_type.tag !== "unknown") {
      front_type = inferred_type;
    }
  }

  if (front_type !== undefined) {
    facts.type_of.set(subject, front_type);
  }

  const definitions = new Map(
    base_facts.definition_type_of.get(subject) || [],
  );

  if (prefer_inferred) {
    const inferred_definitions = facts.definition_type_of.get(
      inferred_subject,
    );

    if (inferred_definitions !== undefined) {
      for (const [slot, type] of inferred_definitions) {
        const current = definitions.get(slot);

        if (
          type.resolved_name !== "unknown" &&
          (current === undefined || current.resolved_name === "unknown")
        ) {
          definitions.set(slot, type);
        }
      }
    }
  }

  if (definitions.size > 0) {
    facts.definition_type_of.set(subject, definitions);
  }

  let nominal = base_facts.nominal_of.get(subject);

  if (prefer_inferred) {
    const inferred_nominal = facts.nominal_of.get(inferred_subject);

    if (inferred_nominal !== undefined) {
      nominal = inferred_nominal;
    }
  }

  if (nominal !== undefined) {
    facts.nominal_of.set(subject, nominal);
  }

  let const_source = base_facts.const_source_of.get(subject);

  if (prefer_inferred) {
    const inferred_const_source = facts.const_source_of.get(inferred_subject);

    if (inferred_const_source !== undefined) {
      const_source = inferred_const_source;
    }
  }

  if (const_source !== undefined) {
    facts.const_source_of.set(subject, const_source);
  }

  const subject_record = subject as Record<string, unknown>;
  const inferred_record = inferred_subject as Record<string, unknown>;

  for (const key of Object.keys(subject_record)) {
    const child = subject_record[key];
    const inferred_child = inferred_record[key];

    if (Array.isArray(child) && Array.isArray(inferred_child)) {
      const count = Math.min(child.length, inferred_child.length);

      for (let index = 0; index < count; index += 1) {
        const child_entry = child[index];
        const inferred_entry = inferred_child[index];

        if (is_object(child_entry) && is_object(inferred_entry)) {
          transfer_editor_facts(
            child_entry,
            inferred_entry,
            facts,
            base_facts,
            visited,
          );
        }
      }

      continue;
    }

    if (is_object(child) && is_object(inferred_child)) {
      transfer_editor_facts(
        child,
        inferred_child,
        facts,
        base_facts,
        visited,
      );
    }
  }
}

function transfer_type_fact(
  subject: object,
  inferred_subject: object,
  target: SourceFacts["editor_type_of"],
  base: SourceFacts["editor_type_of"],
  prefer_inferred: boolean,
): void {
  let type = base.get(subject);

  if (prefer_inferred) {
    const inferred_type = target.get(inferred_subject);

    if (
      inferred_type !== undefined && inferred_type.resolved_name !== "unknown"
    ) {
      type = inferred_type;
    }
  }

  if (type !== undefined) {
    target.set(subject, type);
  }
}

function is_object(subject: unknown): subject is object {
  return subject !== null && typeof subject === "object";
}
