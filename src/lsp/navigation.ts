import { is_const_builtin_name } from "../frontend/constness.ts";
import type {
  BindingEntity,
  BindingIndex,
  BindingOccurrence,
  EntityId,
} from "../frontend/binding_index.ts";
import { name_sites } from "../frontend/name_site.ts";
import type { Source } from "../frontend/ast.ts";
import { has_source_span, source_span } from "../frontend/syntax.ts";
import {
  type LspRange,
  type PositionEncoding,
  PositionIndex,
} from "./position.ts";

export type LspLocation = {
  uri: string;
  range: LspRange;
};

export type LspDocumentHighlight = {
  range: LspRange;
  kind: 1 | 2 | 3;
};

export type LspTextEdit = {
  range: LspRange;
  newText: string;
};

export type LspWorkspaceEdit = {
  changes: Record<string, LspTextEdit[]>;
};

export type LspPrepareRename = {
  range: LspRange;
  placeholder: string;
};

export type LspWorkspaceSymbol = {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
};

export type WorkspaceIndexEntry = {
  uri: string;
  text: string;
  index: BindingIndex;
};

const highlight_kind = {
  consume: 1,
  read: 2,
  write: 3,
} as const;

const symbol_kind = {
  module: 2,
  class: 5,
  interface: 11,
  method: 6,
  field: 8,
  function: 12,
  variable: 13,
  constant: 14,
  enum_member: 22,
} as const;

const keywords = new Set([
  "break",
  "comptime",
  "const",
  "continue",
  "declare",
  "effect",
  "else",
  "for",
  "freeze",
  "from",
  "if",
  "import",
  "in",
  "is",
  "let",
  "module",
  "rec",
  "return",
  "scratch",
  "struct",
  "try",
  "type",
  "union",
  "where",
  "with",
]);

export function definition_location(
  index: BindingIndex,
  text: string,
  uri: string,
  offset: number,
  encoding: PositionEncoding,
): LspLocation | undefined {
  const occurrence = index.occurrence_at(offset);

  if (occurrence === undefined || occurrence.entity === undefined) {
    return undefined;
  }

  return entity_definition_location(
    index,
    occurrence.entity,
    text,
    uri,
    encoding,
  );
}

export function import_definition_location(
  source: Source,
  index: BindingIndex,
  base_uri: string,
  offset: number,
): LspLocation | undefined {
  const expression_path = import_expression_path_at(source, offset);

  if (expression_path !== undefined) {
    try {
      return {
        uri: new URL(expression_path, base_uri).href,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      };
    } catch (error) {
      if (error instanceof TypeError) {
        return undefined;
      }

      throw error;
    }
  }

  const occurrence = index.occurrence_at(offset);

  if (occurrence === undefined) {
    return undefined;
  }

  if (occurrence.entity !== undefined) {
    const path = import_binding_path(source, index, occurrence.entity);

    if (path !== undefined) {
      return import_location(path, base_uri);
    }
  }

  for (const statement of source.statements) {
    if (statement.tag !== "import") {
      continue;
    }

    const site = name_sites(statement).find((candidate) =>
      candidate.slot === "name" && candidate.name === statement.name
    );

    if (site === undefined) {
      continue;
    }

    const definition = index.occurrence_at(site.span.start);

    if (
      definition === undefined || definition.entity === undefined ||
      definition.entity !== occurrence.entity
    ) {
      continue;
    }

    return import_location(statement.path, base_uri);
  }

  return undefined;
}

function import_binding_path(
  source: Source,
  index: BindingIndex,
  entity_id: string,
): string | undefined {
  for (const statement of source.statements) {
    if (statement.tag !== "bind" || statement.value.tag !== "import") {
      continue;
    }

    const site = name_sites(statement).find((candidate) =>
      candidate.slot === "name" && candidate.name === statement.name
    );

    if (site === undefined) {
      continue;
    }

    if (index.occurrence_at(site.span.start)?.entity === entity_id) {
      return statement.value.path;
    }
  }

  return undefined;
}

function import_location(
  path: string,
  base_uri: string,
): LspLocation | undefined {
  try {
    return {
      uri: new URL(path, base_uri).href,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    };
  } catch (error) {
    if (error instanceof TypeError) {
      return undefined;
    }

    throw error;
  }
}

function import_expression_path_at(
  source: Source,
  offset: number,
): string | undefined {
  const seen = new WeakSet<object>();
  let result: string | undefined;

  const visit = (value: object): void => {
    if (seen.has(value) || result !== undefined) {
      return;
    }

    seen.add(value);
    const record = value as { tag?: string; path?: unknown };

    if (
      record.tag === "import" && typeof record.path === "string" &&
      has_source_span(value)
    ) {
      const span = source_span(value);

      if (span.start <= offset && offset <= span.end) {
        result = record.path;
        return;
      }
    }

    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") {
        if (Array.isArray(child)) {
          for (const entry of child) {
            if (entry !== null && typeof entry === "object") {
              visit(entry);
            }
          }
        } else {
          visit(child);
        }
      }
    }
  };

  visit(source);
  return result;
}

export function type_definition_location(
  index: BindingIndex,
  text: string,
  uri: string,
  offset: number,
  encoding: PositionEncoding,
): LspLocation | undefined {
  const occurrence = index.occurrence_at(offset);

  if (occurrence === undefined || occurrence.entity === undefined) {
    return undefined;
  }

  const entity = index.entities.get(occurrence.entity);

  if (entity === undefined) {
    throw new Error("Missing binding entity: " + occurrence.entity);
  }

  const facts = index.facts.get(entity.id);
  let target: EntityId | undefined;

  if (facts !== undefined) {
    target = facts.nominal;
  }

  if (target === undefined && entity.owner !== undefined) {
    target = entity.owner;
  }

  if (target === undefined && is_type_entity(entity)) {
    target = entity.id;
  }

  if (target === undefined) {
    return undefined;
  }

  return entity_definition_location(index, target, text, uri, encoding);
}

export function reference_locations(
  index: BindingIndex,
  text: string,
  uri: string,
  offset: number,
  include_declaration: boolean,
  encoding: PositionEncoding,
): LspLocation[] {
  const occurrence = index.occurrence_at(offset);

  if (occurrence === undefined || occurrence.entity === undefined) {
    return [];
  }

  const positions = new PositionIndex(text, encoding);
  return entity_occurrences(
    index,
    occurrence.entity,
    include_declaration,
  ).map((item) => ({
    uri,
    range: range_from_occurrence(positions, item),
  }));
}

export function document_highlights(
  index: BindingIndex,
  text: string,
  offset: number,
  encoding: PositionEncoding,
): LspDocumentHighlight[] {
  const occurrence = index.occurrence_at(offset);

  if (occurrence === undefined || occurrence.entity === undefined) {
    return [];
  }

  const positions = new PositionIndex(text, encoding);
  return entity_occurrences(index, occurrence.entity, true).map((item) => {
    let kind: 1 | 2 | 3 = highlight_kind.read;

    if (item.role === "definition" || item.role === "shadow") {
      kind = highlight_kind.write;
    } else if (item.role === "consume") {
      kind = highlight_kind.consume;
    }

    return { range: range_from_occurrence(positions, item), kind };
  });
}

export function prepare_rename(
  index: BindingIndex,
  text: string,
  offset: number,
  encoding: PositionEncoding,
): LspPrepareRename | undefined {
  const occurrence = rename_occurrence(index, offset);

  if (occurrence === undefined) {
    return undefined;
  }

  const positions = new PositionIndex(text, encoding);
  return {
    range: range_from_occurrence(positions, occurrence),
    placeholder: occurrence.name,
  };
}

export function rename_symbol(
  index: BindingIndex,
  text: string,
  uri: string,
  offset: number,
  new_name: string,
  encoding: PositionEncoding,
): LspWorkspaceEdit | undefined {
  const occurrence = rename_occurrence(index, offset);

  if (occurrence === undefined || occurrence.entity === undefined) {
    return undefined;
  }

  const entity = index.entities.get(occurrence.entity);

  if (entity === undefined) {
    throw new Error("Missing rename entity: " + occurrence.entity);
  }

  if (!valid_rename_name(entity, new_name)) {
    return undefined;
  }

  if (rename_conflicts(index, entity, new_name)) {
    return undefined;
  }

  const occurrences = entity_occurrences(index, entity.id, true);

  for (const item of occurrences) {
    const visible = index.visible_at(item.span.start);

    if (
      visible.some((candidate) =>
        candidate.id !== entity.id && candidate.name === new_name
      )
    ) {
      return undefined;
    }
  }

  const positions = new PositionIndex(text, encoding);
  const edits = occurrences.map((item) => ({
    range: range_from_occurrence(positions, item),
    newText: new_name,
  }));

  return { changes: { [uri]: edits } };
}

export function workspace_symbols(
  entries: WorkspaceIndexEntry[],
  query: string,
  encoding: PositionEncoding,
): LspWorkspaceSymbol[] {
  const matches: {
    score: number;
    symbol: LspWorkspaceSymbol;
    start: number;
  }[] = [];

  for (const entry of entries) {
    const positions = new PositionIndex(entry.text, encoding);

    for (const entity of entry.index.entities.values()) {
      if (entity.definition === undefined) {
        continue;
      }

      if (entity.owner === undefined && entity.scope !== "scope:0") {
        continue;
      }

      const score = fuzzy_score(entity.name, query);

      if (score === undefined) {
        continue;
      }

      const definition = entry.index.occurrences.get(entity.definition);

      if (definition === undefined) {
        throw new Error("Missing workspace symbol definition");
      }

      const symbol: LspWorkspaceSymbol = {
        name: entity.name,
        kind: entity_symbol_kind(entity),
        location: {
          uri: entry.uri,
          range: range_from_occurrence(positions, definition),
        },
      };

      if (entity.owner !== undefined) {
        const owner = entry.index.entities.get(entity.owner);

        if (owner !== undefined) {
          symbol.containerName = owner.name;
        }
      }

      matches.push({ score, symbol, start: definition.span.start });
    }
  }

  matches.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    const by_name = left.symbol.name.localeCompare(right.symbol.name);

    if (by_name !== 0) {
      return by_name;
    }

    const by_uri = left.symbol.location.uri.localeCompare(
      right.symbol.location.uri,
    );

    if (by_uri !== 0) {
      return by_uri;
    }

    return left.start - right.start;
  });

  return matches.map((match) => match.symbol);
}

function entity_definition_location(
  index: BindingIndex,
  entity_id: EntityId,
  text: string,
  uri: string,
  encoding: PositionEncoding,
): LspLocation | undefined {
  const entity = index.entities.get(entity_id);

  if (entity === undefined || entity.definition === undefined) {
    return undefined;
  }

  const occurrence = index.occurrences.get(entity.definition);

  if (occurrence === undefined) {
    throw new Error("Missing definition occurrence: " + entity.definition);
  }

  const positions = new PositionIndex(text, encoding);
  return { uri, range: range_from_occurrence(positions, occurrence) };
}

function entity_occurrences(
  index: BindingIndex,
  entity_id: EntityId,
  include_declaration: boolean,
): BindingOccurrence[] {
  const occurrences: BindingOccurrence[] = [];
  const entity = index.entities.get(entity_id);

  if (entity === undefined) {
    throw new Error("Missing occurrence entity: " + entity_id);
  }

  if (include_declaration && entity.definition !== undefined) {
    const definition = index.occurrences.get(entity.definition);

    if (definition === undefined) {
      throw new Error("Missing entity definition: " + entity.definition);
    }

    occurrences.push(definition);
  }

  const references = index.references.get(entity_id);

  if (references !== undefined) {
    for (const reference_id of references) {
      const reference = index.occurrences.get(reference_id);

      if (reference === undefined) {
        throw new Error("Missing entity reference: " + reference_id);
      }

      occurrences.push(reference);
    }
  }

  occurrences.sort((left, right) => left.span.start - right.span.start);
  return occurrences;
}

function rename_occurrence(
  index: BindingIndex,
  offset: number,
): BindingOccurrence | undefined {
  const occurrence = index.occurrence_at(offset);

  if (
    occurrence === undefined || occurrence.entity === undefined ||
    occurrence.unresolved !== undefined
  ) {
    return undefined;
  }

  return occurrence;
}

function rename_conflicts(
  index: BindingIndex,
  entity: BindingEntity,
  new_name: string,
): boolean {
  if (entity.owner !== undefined) {
    const members = index.members.get(entity.owner);
    let existing: EntityId | undefined;

    if (members !== undefined) {
      existing = members.get(new_name);
    }

    return existing !== undefined && existing !== entity.id;
  }

  return [...index.entities.values()].some((candidate) =>
    candidate.id !== entity.id && candidate.owner === undefined &&
    candidate.scope === entity.scope && candidate.name === new_name
  );
}

function valid_rename_name(entity: BindingEntity, name: string): boolean {
  if (keywords.has(name) || is_builtin_name(name)) {
    return false;
  }

  if (is_type_entity(entity)) {
    return /^[A-Z][A-Za-z0-9]*$/.test(name);
  }

  return /^[a-z][a-z0-9_]*$/.test(name);
}

function is_builtin_name(name: string): boolean {
  return name === "true" || name === "false" || name === "Bool" ||
    name === "Char" || name.startsWith("@") || is_const_builtin_name(name);
}

function is_type_entity(entity: BindingEntity): boolean {
  return entity.kind === "type" || entity.kind === "record" ||
    entity.kind === "effect" || entity.kind === "case";
}

function range_from_occurrence(
  positions: PositionIndex,
  occurrence: BindingOccurrence,
): LspRange {
  return {
    start: positions.position_from_offset(occurrence.span.start),
    end: positions.position_from_offset(occurrence.span.end),
  };
}

function fuzzy_score(name: string, query: string): number | undefined {
  const candidate = name.toLowerCase();
  const needle = query.toLowerCase();

  if (needle.length === 0) {
    return 0;
  }

  let cursor = 0;
  let score = 0;
  let previous = -2;

  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== needle[cursor]) {
      continue;
    }

    score += 1;

    if (index === previous + 1) {
      score += 2;
    }

    if (index === 0 || candidate[index - 1] === "_") {
      score += 3;
    }

    previous = index;
    cursor += 1;

    if (cursor === needle.length) {
      if (candidate.startsWith(needle)) {
        score += 5;
      }

      return score;
    }
  }

  return undefined;
}

function entity_symbol_kind(entity: BindingEntity): number {
  if (entity.kind === "type" || entity.kind === "record") {
    return symbol_kind.class;
  }

  if (entity.kind === "field") {
    return symbol_kind.field;
  }

  if (entity.kind === "case") {
    return symbol_kind.enum_member;
  }

  if (entity.kind === "operation") {
    return symbol_kind.method;
  }

  if (entity.kind === "effect") {
    return symbol_kind.interface;
  }

  if (entity.kind === "const") {
    return symbol_kind.constant;
  }

  if (entity.kind === "module_parameter") {
    return symbol_kind.module;
  }

  if (entity.kind === "parameter") {
    return symbol_kind.variable;
  }

  if (entity.kind === "type_parameter") {
    return symbol_kind.variable;
  }

  if (entity.kind === "value") {
    return symbol_kind.variable;
  }

  entity.kind satisfies never;
  throw new Error("Unknown binding entity kind");
}
