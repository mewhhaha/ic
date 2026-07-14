import type {
  BindingEntity,
  BindingIndex,
  BindingOccurrence,
} from "../frontend/binding_index.ts";
import type { FrontExpr, Source } from "../frontend/ast.ts";
import {
  source_span,
  type SourceSpan,
  type SourceSyntax,
} from "../frontend/syntax.ts";
import { source_tokens } from "../frontend/tokenize.ts";
import { type PositionEncoding, PositionIndex } from "./position.ts";

export const semantic_token_types = [
  "variable",
  "type",
  "typeParameter",
  "interface",
  "method",
  "enumMember",
  "property",
  "function",
] as const;

export const semantic_token_modifiers = [
  "declaration",
  "readonly",
  "modification",
  "linear",
  "comptime",
] as const;

export type SemanticTokens = {
  resultId: string;
  data: number[];
};

export type SemanticTokensEdit = {
  start: number;
  deleteCount: number;
  data?: number[];
};

export type SemanticTokensDelta = {
  resultId: string;
  edits: SemanticTokensEdit[];
};

export type SemanticTokenDump = {
  line: number;
  character: number;
  length: number;
  type: typeof semantic_token_types[number];
  modifiers: typeof semantic_token_modifiers[number][];
};

type AbsoluteToken = {
  start: number;
  end: number;
  line: number;
  character: number;
  length: number;
  type: number;
  modifiers: number;
};

export function semantic_tokens(
  source: Source,
  syntax: SourceSyntax,
  index: BindingIndex,
  version: number,
  encoding: PositionEncoding,
  range?: SourceSpan,
): SemanticTokens {
  const tokens = absolute_tokens(source, syntax, index, encoding).filter(
    (token) => {
      if (range === undefined) {
        return true;
      }

      return token.start >= range.start && token.end <= range.end;
    },
  );
  const data = encode_tokens(tokens);
  return { resultId: token_result_id(version, data), data };
}

export function semantic_tokens_delta(
  previous: SemanticTokens,
  current: SemanticTokens,
): SemanticTokensDelta {
  let prefix = 0;
  const maximum_prefix = Math.min(previous.data.length, current.data.length);

  while (
    prefix < maximum_prefix &&
    previous.data[prefix] === current.data[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;

  while (
    suffix < previous.data.length - prefix &&
    suffix < current.data.length - prefix &&
    previous.data[previous.data.length - suffix - 1] ===
      current.data[current.data.length - suffix - 1]
  ) {
    suffix += 1;
  }

  if (prefix === previous.data.length && prefix === current.data.length) {
    return { resultId: current.resultId, edits: [] };
  }

  const edit: SemanticTokensEdit = {
    start: prefix,
    deleteCount: previous.data.length - prefix - suffix,
  };
  const replacement = current.data.slice(prefix, current.data.length - suffix);

  if (replacement.length > 0) {
    edit.data = replacement;
  }

  return { resultId: current.resultId, edits: [edit] };
}

export function dump_semantic_tokens(
  tokens: SemanticTokens,
): SemanticTokenDump[] {
  const result: SemanticTokenDump[] = [];
  let line = 0;
  let character = 0;

  for (let index = 0; index < tokens.data.length; index += 5) {
    const delta_line = tokens.data[index];
    const delta_character = tokens.data[index + 1];
    const length = tokens.data[index + 2];
    const type = tokens.data[index + 3];
    const modifier_bits = tokens.data[index + 4];

    if (
      delta_line === undefined || delta_character === undefined ||
      length === undefined || type === undefined || modifier_bits === undefined
    ) {
      throw new Error("Incomplete semantic token tuple");
    }

    line += delta_line;

    if (delta_line === 0) {
      character += delta_character;
    } else {
      character = delta_character;
    }

    const type_name = semantic_token_types[type];

    if (type_name === undefined) {
      throw new Error("Unknown semantic token type: " + type.toString());
    }

    const modifiers: typeof semantic_token_modifiers[number][] = [];

    for (let bit = 0; bit < semantic_token_modifiers.length; bit += 1) {
      if ((modifier_bits & (1 << bit)) !== 0) {
        const modifier = semantic_token_modifiers[bit];

        if (modifier === undefined) {
          throw new Error("Missing semantic token modifier");
        }

        modifiers.push(modifier);
      }
    }

    result.push({
      line,
      character,
      length,
      type: type_name,
      modifiers,
    });
  }

  return result;
}

function absolute_tokens(
  source: Source,
  syntax: SourceSyntax,
  index: BindingIndex,
  encoding: PositionEncoding,
): AbsoluteToken[] {
  const positions = new PositionIndex(syntax.text, encoding);
  const comptime = comptime_intervals(source);
  const tokens: AbsoluteToken[] = [];

  for (const occurrence of index.occurrences.values()) {
    if (occurrence.entity === undefined) {
      continue;
    }

    const entity = index.entities.get(occurrence.entity);

    if (entity === undefined) {
      throw new Error("Missing semantic token entity: " + occurrence.entity);
    }

    const start = positions.position_from_offset(occurrence.span.start);
    const end = positions.position_from_offset(occurrence.span.end);

    if (start.line !== end.line) {
      continue;
    }

    let modifiers = 0;

    if (occurrence.role === "definition" || occurrence.role === "shadow") {
      modifiers |= modifier_bit("declaration");
    }

    if (entity.readonly) {
      modifiers |= modifier_bit("readonly");
    }

    if (occurrence.role === "shadow") {
      modifiers |= modifier_bit("modification");
    }

    if (entity.linear) {
      modifiers |= modifier_bit("linear");
    }

    if (
      inside_intervals(occurrence.span, comptime) ||
      const_call_occurrence(syntax, occurrence, entity)
    ) {
      modifiers |= modifier_bit("comptime");
    }

    tokens.push({
      start: occurrence.span.start,
      end: occurrence.span.end,
      line: start.line,
      character: start.character,
      length: end.character - start.character,
      type: token_type(index, entity),
      modifiers,
    });
  }

  tokens.sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }

    return left.end - right.end;
  });
  return tokens;
}

function token_type(index: BindingIndex, entity: BindingEntity): number {
  if (entity.kind === "type" || entity.kind === "record") {
    return type_index("type");
  }

  if (entity.kind === "type_parameter") {
    return type_index("typeParameter");
  }

  if (entity.kind === "effect") {
    return type_index("interface");
  }

  if (entity.kind === "operation") {
    return type_index("method");
  }

  if (entity.kind === "case") {
    return type_index("enumMember");
  }

  if (entity.kind === "field") {
    return type_index("property");
  }

  const facts = index.facts.get(entity.id);

  if (facts !== undefined && facts.const_source !== undefined) {
    const source = facts.const_source as FrontExpr;

    if (source.tag === "lam" || source.tag === "rec") {
      if (expression_produces_type(source.body)) {
        return type_index("type");
      }

      return type_index("function");
    }

    if (
      source.tag === "struct_type" || source.tag === "union_type" ||
      source.tag === "set_type" || source.tag === "type_name"
    ) {
      return type_index("type");
    }
  }

  return type_index("variable");
}

function expression_produces_type(expr: FrontExpr): boolean {
  if (
    expr.tag === "struct_type" || expr.tag === "union_type" ||
    expr.tag === "set_type" || expr.tag === "type_name"
  ) {
    return true;
  }

  if (
    expr.tag === "comptime" || expr.tag === "captured"
  ) {
    return expression_produces_type(expr.expr);
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    return expression_produces_type(expr.body);
  }

  if (expr.tag === "block") {
    const last = expr.statements[expr.statements.length - 1];

    if (last === undefined) {
      return false;
    }

    if (last.tag === "expr") {
      return expression_produces_type(last.expr);
    }

    if (last.tag === "return") {
      return expression_produces_type(last.value);
    }
  }

  return false;
}

function comptime_intervals(source: Source): SourceSpan[] {
  const intervals: SourceSpan[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: object): void => {
    if (seen.has(value)) {
      return;
    }

    seen.add(value);
    const record = value as { tag?: string };

    if (record.tag === "comptime") {
      intervals.push(source_span(value));
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
  return intervals;
}

function inside_intervals(span: SourceSpan, intervals: SourceSpan[]): boolean {
  return intervals.some((interval) =>
    interval.start <= span.start && span.end <= interval.end
  );
}

function const_call_occurrence(
  syntax: SourceSyntax,
  occurrence: BindingOccurrence,
  entity: BindingEntity,
): boolean {
  if (entity.kind !== "const") {
    return false;
  }

  const tokens = source_tokens(syntax);
  const next = tokens.find((token) => token.span.start >= occurrence.span.end);

  if (next === undefined || next.kind === "newline") {
    return false;
  }

  if (
    next.kind === "number" || next.kind === "string" ||
    next.kind === "character" || next.kind === "name"
  ) {
    return true;
  }

  return next.kind === "symbol" &&
    (next.text === "(" || next.text === "[" || next.text === "." ||
      next.text === "#");
}

function encode_tokens(tokens: AbsoluteToken[]): number[] {
  const data: number[] = [];
  let previous_line = 0;
  let previous_character = 0;

  for (const token of tokens) {
    const delta_line = token.line - previous_line;
    let delta_character = token.character;

    if (delta_line === 0) {
      delta_character = token.character - previous_character;
    }

    data.push(
      delta_line,
      delta_character,
      token.length,
      token.type,
      token.modifiers,
    );
    previous_line = token.line;
    previous_character = token.character;
  }

  return data;
}

function type_index(type: typeof semantic_token_types[number]): number {
  const index = semantic_token_types.indexOf(type);

  if (index < 0) {
    throw new Error("Missing semantic token type: " + type);
  }

  return index;
}

function modifier_bit(
  modifier: typeof semantic_token_modifiers[number],
): number {
  const index = semantic_token_modifiers.indexOf(modifier);

  if (index < 0) {
    throw new Error("Missing semantic token modifier: " + modifier);
  }

  return 1 << index;
}

function token_result_id(version: number, data: number[]): string {
  let hash = 2_166_136_261;

  for (const value of data) {
    hash ^= value;
    hash = Math.imul(hash, 16_777_619);
  }

  return version.toString() + ":" + (hash >>> 0).toString(16);
}
