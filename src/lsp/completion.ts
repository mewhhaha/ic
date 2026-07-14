import type {
  BindingEntity,
  BindingIndex,
  EntityId,
} from "../frontend/binding_index.ts";
import type { Declaration, Source, TypeField } from "../frontend/ast.ts";
import type { SourceSyntax } from "../frontend/syntax.ts";
import { front_type_name } from "../frontend/types.ts";
import {
  attached_documentation,
  render_documentation,
} from "./documentation.ts";
import { type_entity_layout } from "./type_layout.ts";

export type CompletionItemData = {
  uri: string;
  entity: EntityId;
};

export type LspCompletionItem = {
  label: string;
  kind: number;
  detail: string;
  sortText: string;
  insertText?: string;
  insertTextFormat?: 2;
  documentation?: { kind: "markdown"; value: string };
  data?: CompletionItemData;
};

export type LspCompletionList = {
  isIncomplete: boolean;
  items: LspCompletionItem[];
};

export type CompletionOptions = {
  import_paths?: string[];
};

const completion_kind = {
  method: 2,
  function: 3,
  field: 5,
  variable: 6,
  class: 7,
  interface: 8,
  module: 9,
  value: 12,
  enum: 13,
  keyword: 14,
  snippet: 15,
  file: 17,
  constant: 21,
  enum_member: 20,
  type_parameter: 25,
} as const;

const statement_keywords = [
  keyword("let", "runtime binding"),
  keyword("const", "compile-time binding"),
  snippet("if let", "if let .${1:case}(${2:value}) = ${3:target} {\n\t$0\n}"),
  snippet("for", "for ${1:item} in ${2:collection} {\n\t$0\n}"),
  snippet("effect", "effect ${1:Name} {\n\t${2:operation}: () => Unit\n}"),
  snippet("type", "type ${1:Name} = ${2:Int}"),
  snippet("module", "module (${1:params}) where\n$0"),
  keyword("return", "return from the current block"),
];

const expression_keywords = [
  snippet("if", "if ${1:condition} {\n\t${2:value}\n} else {\n\t$0\n}"),
  keyword("comptime", "evaluate at compile time"),
  snippet("scratch", "scratch {\n\t$0\n}"),
  keyword("freeze", "make a value shareable"),
  snippet("try", "try ${1:body} with ${2:handler}"),
];

const builtin_types = ["Bool", "Bytes", "I32", "I64", "Int", "Text", "Unit"];

export function completions(
  source: Source,
  syntax: SourceSyntax,
  index: BindingIndex,
  uri: string,
  offset: number,
  options: CompletionOptions = {},
): LspCompletionList {
  const import_prefix = import_path_prefix(syntax.text, offset);

  if (import_prefix !== undefined) {
    const paths = options.import_paths;

    if (paths === undefined) {
      return { isIncomplete: false, items: [] };
    }

    return {
      isIncomplete: false,
      items: paths.filter((path) =>
        path.startsWith(import_prefix) ||
        path.startsWith("./" + import_prefix)
      ).map((path) => ({
        label: path,
        kind: completion_kind.file,
        detail: "Ix source file",
        sortText: "00_" + path,
        insertText: path,
      })),
    };
  }

  const member = member_context(syntax.text, offset);

  if (member !== undefined) {
    return {
      isIncomplete: true,
      items: member_completions(
        source,
        index,
        uri,
        offset,
        member.receiver,
        member.prefix,
      ),
    };
  }

  const shorthand = shorthand_context(syntax.text, offset);

  if (shorthand !== undefined) {
    return {
      isIncomplete: true,
      items: shorthand_completions(
        source,
        index,
        uri,
        offset,
        shorthand.type_name,
        shorthand.prefix,
      ),
    };
  }

  const handler = handler_context(syntax.text, offset);
  let handler_effect: BindingEntity | undefined;

  if (handler !== undefined) {
    handler_effect = index.visible_at(offset).find((entity) =>
      entity.name === handler.effect && entity.kind === "effect"
    );
  }

  if (handler !== undefined && handler_effect !== undefined) {
    const handler_items = member_completions(
      source,
      index,
      uri,
      offset,
      handler.effect,
      handler.prefix,
    );

    for (const item of handler_items) {
      item.insertText = item.label + ": (${1:args}) => $0";
      item.insertTextFormat = 2;
    }

    if (completion_match("return", handler.prefix)) {
      handler_items.push({
        label: "return",
        kind: completion_kind.snippet,
        detail: "handler return clause",
        sortText: keyword_sort_text("return", handler.prefix),
        insertText: "return: ${1:value} => $0",
        insertTextFormat: 2,
      });
    }

    handler_items.sort(compare_completion_items);
    return { isIncomplete: true, items: handler_items };
  }

  const prefix = identifier_prefix(syntax.text, offset);
  const context = keyword_context(syntax.text, offset);
  let items = scope_completions(source, index, uri, offset, prefix);

  if (context === "type") {
    items = items.filter((item) => {
      const data = item.data;

      if (data === undefined) {
        return false;
      }

      const entity = index.entities.get(data.entity);

      if (entity === undefined) {
        throw new Error("Missing type-position completion entity");
      }

      return entity.kind === "type" || entity.kind === "record" ||
        entity.kind === "effect" || entity.kind === "const" ||
        entity.kind === "type_parameter";
    });

    for (const name of builtin_types) {
      if (completion_match(name, prefix)) {
        items.push({
          label: name,
          kind: completion_kind.class,
          detail: "builtin type",
          sortText: keyword_sort_text(name, prefix),
        });
      }
    }
  } else {
    let keywords = expression_keywords;

    if (context === "statement") {
      keywords = statement_keywords;
    }

    for (const item of keywords) {
      if (completion_match(item.label, prefix)) {
        items.push({
          ...item,
          sortText: keyword_sort_text(item.label, prefix),
        });
      }
    }
  }

  items.sort(compare_completion_items);
  return { isIncomplete: true, items };
}

export function resolve_completion_item(
  item: LspCompletionItem,
  source: Source,
  index: BindingIndex,
  syntax: SourceSyntax,
): LspCompletionItem {
  const data = item.data;

  if (data === undefined) {
    return item;
  }

  const entity = index.entities.get(data.entity);

  if (entity === undefined || entity.definition === undefined) {
    return item;
  }

  const definition = index.occurrences.get(entity.definition);

  if (definition === undefined) {
    throw new Error("Missing completion definition: " + entity.definition);
  }

  const sections: string[] = [];
  const documentation = attached_documentation(
    syntax.text,
    definition.span.start,
  );

  if (documentation !== undefined) {
    sections.push(render_documentation(documentation));
  }

  const layout = type_entity_layout(source, entity);

  if (layout !== undefined) {
    sections.push(
      "Layout: `size " + layout.size.toString() +
        "`, `align " + layout.align.toString() + "`.",
    );
  }

  if (sections.length === 0) {
    return item;
  }

  return {
    ...item,
    documentation: { kind: "markdown", value: sections.join("\n\n") },
  };
}

function scope_completions(
  source: Source,
  index: BindingIndex,
  uri: string,
  offset: number,
  prefix: string,
): LspCompletionItem[] {
  const visible = index.visible_at(offset);
  let maximum_depth = 0;

  for (const entity of visible) {
    maximum_depth = Math.max(maximum_depth, scope_depth(index, entity.scope));
  }

  const items: LspCompletionItem[] = [];

  for (const entity of visible) {
    if (!completion_match(entity.name, prefix)) {
      continue;
    }

    const depth = scope_depth(index, entity.scope);
    const distance = maximum_depth - depth;
    let label = entity.name;
    let insert_text: string | undefined;

    if (entity.linear) {
      label = "!" + entity.name;
      insert_text = label;
    }

    const item: LspCompletionItem = {
      label,
      kind: entity_completion_kind(entity),
      detail: entity_detail(source, index, entity),
      sortText: entity_sort_text(distance, entity.name, prefix),
      data: { uri, entity: entity.id },
    };

    if (insert_text !== undefined) {
      item.insertText = insert_text;
    }

    items.push(item);
  }

  return items;
}

function member_completions(
  source: Source,
  index: BindingIndex,
  uri: string,
  offset: number,
  receiver: string,
  prefix: string,
): LspCompletionItem[] {
  const visible = index.visible_at(offset);
  const entity = visible.find((candidate) => candidate.name === receiver);

  if (entity === undefined) {
    return [];
  }

  let owner: EntityId | undefined;

  if (
    entity.kind === "type" || entity.kind === "record" ||
    entity.kind === "effect"
  ) {
    owner = entity.id;
  } else {
    const facts = index.facts.get(entity.id);

    if (facts !== undefined) {
      owner = facts.nominal;

      if (owner === undefined && facts.type?.tag === "struct") {
        return synthetic_field_completions(facts.type.fields, prefix);
      }
    }
  }

  if (owner === undefined) {
    return [];
  }

  return owner_member_completions(source, index, uri, owner, prefix);
}

function shorthand_completions(
  source: Source,
  index: BindingIndex,
  uri: string,
  offset: number,
  type_name: string,
  prefix: string,
): LspCompletionItem[] {
  const owner = index.visible_at(offset).find((entity) =>
    entity.name === type_name && entity.kind === "type"
  );

  if (owner === undefined) {
    return [];
  }

  return owner_member_completions(source, index, uri, owner.id, prefix).filter(
    (item) => item.kind === completion_kind.enum_member,
  );
}

function owner_member_completions(
  source: Source,
  index: BindingIndex,
  uri: string,
  owner: EntityId,
  prefix: string,
): LspCompletionItem[] {
  const members = index.members.get(owner);

  if (members === undefined) {
    return [];
  }

  const items: LspCompletionItem[] = [];

  for (const member_id of members.values()) {
    const member = index.entities.get(member_id);

    if (member === undefined) {
      throw new Error("Missing completion member: " + member_id);
    }

    if (!completion_match(member.name, prefix)) {
      continue;
    }

    items.push({
      label: member.name,
      kind: entity_completion_kind(member),
      detail: entity_detail(source, index, member),
      sortText: member_sort_text(member.name, prefix),
      data: { uri, entity: member.id },
    });
  }

  items.sort(compare_completion_items);
  return items;
}

function synthetic_field_completions(
  fields: string[],
  prefix: string,
): LspCompletionItem[] {
  return fields.filter((name) => completion_match(name, prefix)).sort().map(
    (name) => ({
      label: name,
      kind: completion_kind.field,
      detail: "struct field",
      sortText: member_sort_text(name, prefix),
    }),
  );
}

function entity_detail(
  source: Source,
  index: BindingIndex,
  entity: BindingEntity,
): string {
  const declared = declared_member_detail(source, index, entity);

  if (declared !== undefined) {
    return declared;
  }

  let label: string = entity.kind;

  if (entity.linear) {
    label = "linear !" + entity.name;
  } else if (entity.kind === "value") {
    label = "runtime binding";
  } else if (entity.kind === "const") {
    label = "const binding";
  }

  const facts = index.facts.get(entity.id);

  if (facts !== undefined) {
    if (facts.nominal !== undefined) {
      const nominal = index.entities.get(facts.nominal);

      if (nominal !== undefined) {
        label += ": " + nominal.name;
      }
    } else if (facts.type !== undefined) {
      label += ": " + front_type_name(facts.type);
    }
  }

  return label;
}

function declared_member_detail(
  source: Source,
  index: BindingIndex,
  entity: BindingEntity,
): string | undefined {
  if (entity.owner === undefined || source.declarations === undefined) {
    return undefined;
  }

  const owner = index.entities.get(entity.owner);

  if (owner === undefined) {
    throw new Error("Missing completion owner: " + entity.owner);
  }

  const declaration = source.declarations.find((candidate) =>
    candidate.name === owner.name
  );

  if (declaration === undefined) {
    return undefined;
  }

  if (declaration.tag === "effect") {
    const operation = declaration.operations.find((candidate) =>
      candidate.name === entity.name
    );

    if (operation !== undefined) {
      return "operation: (" + operation.params.map((param) => param.type_name)
        .join(", ") +
        ") => " + operation.result.type_name;
    }
  }

  const field = declaration_field(declaration, entity.name);

  if (field !== undefined) {
    if (entity.kind === "case") {
      return "case: " + field.type_name;
    }

    return "field: " + field.type_name;
  }

  return undefined;
}

function declaration_field(
  declaration: Declaration,
  name: string,
): TypeField | undefined {
  if (declaration.tag === "record") {
    return declaration.fields.find((field) => field.name === name);
  }

  if (declaration.tag === "type") {
    if (declaration.body.tag === "product") {
      return declaration.body.fields.find((field) => field.name === name);
    }

    if (declaration.body.tag === "sum") {
      return declaration.body.cases.find((field) => field.name === name);
    }
  }

  return undefined;
}

function entity_completion_kind(entity: BindingEntity): number {
  if (entity.kind === "field") {
    return completion_kind.field;
  }

  if (entity.kind === "case") {
    return completion_kind.enum_member;
  }

  if (entity.kind === "operation") {
    return completion_kind.method;
  }

  if (entity.kind === "effect") {
    return completion_kind.interface;
  }

  if (entity.kind === "type" || entity.kind === "record") {
    return completion_kind.class;
  }

  if (entity.kind === "const") {
    return completion_kind.constant;
  }

  if (entity.kind === "parameter") {
    return completion_kind.variable;
  }

  if (entity.kind === "type_parameter") {
    return completion_kind.type_parameter;
  }

  if (entity.kind === "module_parameter") {
    return completion_kind.module;
  }

  if (entity.kind === "value") {
    return completion_kind.variable;
  }

  entity.kind satisfies never;
  throw new Error("Unknown completion entity kind");
}

function scope_depth(index: BindingIndex, scope: string): number {
  let depth = 0;
  let current: string | undefined = scope;

  while (current !== undefined) {
    const item = index.scopes.get(current);

    if (item === undefined) {
      throw new Error("Missing completion scope: " + current);
    }

    current = item.parent;

    if (current !== undefined) {
      depth += 1;
    }
  }

  return depth;
}

function member_context(
  text: string,
  offset: number,
): { receiver: string; prefix: string } | undefined {
  const before = text.slice(0, offset);
  const match = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/.exec(before);

  if (match === null) {
    return undefined;
  }

  const receiver = match[1];
  const prefix = match[2];

  if (receiver === undefined || prefix === undefined) {
    throw new Error("Missing member completion context");
  }

  return { receiver, prefix };
}

function shorthand_context(
  text: string,
  offset: number,
): { type_name: string; prefix: string } | undefined {
  const line_start = text.lastIndexOf("\n", offset - 1) + 1;
  const line = text.slice(line_start, offset);
  const match =
    /\b(?:let|const)\s+[a-z][a-z0-9_]*\s*:\s*([A-Z][A-Za-z0-9]*)\s*=\s*\.([a-z0-9_]*)$/
      .exec(
        line,
      );

  if (match === null) {
    return undefined;
  }

  const type_name = match[1];
  const prefix = match[2];

  if (type_name === undefined || prefix === undefined) {
    throw new Error("Missing shorthand completion context");
  }

  return { type_name, prefix };
}

function handler_context(
  text: string,
  offset: number,
): { effect: string; prefix: string } | undefined {
  const before = text.slice(0, offset);
  const brace = before.lastIndexOf("{");

  if (brace < 0) {
    return undefined;
  }

  const header = /([A-Z][A-Za-z0-9]*)\s*$/.exec(before.slice(0, brace));

  if (header === null) {
    return undefined;
  }

  const body = before.slice(brace + 1);

  if (!/(?:^|[\n,])\s*[a-z0-9_]*$/.test(body)) {
    return undefined;
  }

  const effect = header[1];

  if (effect === undefined) {
    throw new Error("Missing handler completion effect");
  }

  return { effect, prefix: identifier_prefix(text, offset) };
}

function import_path_prefix(text: string, offset: number): string | undefined {
  const line_start = text.lastIndexOf("\n", offset - 1) + 1;
  const line = text.slice(line_start, offset);
  const match = /(?:^|\b)import\s+(?:[a-z][a-z0-9_]*\s+from\s+)?"([^"]*)$/.exec(
    line,
  );

  if (match === null) {
    return undefined;
  }

  const prefix = match[1];

  if (prefix === undefined) {
    throw new Error("Missing import completion prefix");
  }

  return prefix;
}

function identifier_prefix(text: string, offset: number): string {
  let start = offset;

  while (start > 0) {
    const character = text[start - 1];

    if (character === undefined || !/[A-Za-z0-9_]/.test(character)) {
      break;
    }

    start -= 1;
  }

  return text.slice(start, offset);
}

function keyword_context(
  text: string,
  offset: number,
): "statement" | "expression" | "type" {
  const line_start = text.lastIndexOf("\n", offset - 1) + 1;
  const before = text.slice(line_start, offset);

  if (/:[^=]*[A-Za-z0-9_]*$/.test(before)) {
    return "type";
  }

  if (/^\s*[A-Za-z0-9_]*$/.test(before)) {
    return "statement";
  }

  return "expression";
}

function completion_match(label: string, prefix: string): boolean {
  if (prefix.length === 0) {
    return true;
  }

  const candidate = label.toLowerCase();
  const needle = prefix.toLowerCase();
  let cursor = 0;

  for (const character of candidate) {
    if (character === needle[cursor]) {
      cursor += 1;

      if (cursor === needle.length) {
        return true;
      }
    }
  }

  return false;
}

function entity_sort_text(
  distance: number,
  name: string,
  prefix: string,
): string {
  return "0" + distance.toString().padStart(3, "0") + "_" +
    match_rank(name, prefix) + "_" + name;
}

function member_sort_text(name: string, prefix: string): string {
  return "0000_" + match_rank(name, prefix) + "_" + name;
}

function keyword_sort_text(name: string, prefix: string): string {
  return "9000_" + match_rank(name, prefix) + "_" + name;
}

function match_rank(name: string, prefix: string): string {
  if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
    return "0";
  }

  return "1";
}

function compare_completion_items(
  left: LspCompletionItem,
  right: LspCompletionItem,
): number {
  const sorted = left.sortText.localeCompare(right.sortText);

  if (sorted !== 0) {
    return sorted;
  }

  return left.label.localeCompare(right.label);
}

function keyword(label: string, detail: string): LspCompletionItem {
  return {
    label,
    kind: completion_kind.keyword,
    detail,
    sortText: "",
  };
}

function snippet(label: string, insert_text: string): LspCompletionItem {
  return {
    label,
    kind: completion_kind.snippet,
    detail: "Ix snippet",
    sortText: "",
    insertText: insert_text,
    insertTextFormat: 2,
  };
}
