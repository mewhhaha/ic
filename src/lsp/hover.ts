import type {
  BindingEntity,
  BindingIndex,
  EntityId,
} from "../frontend/binding_index.ts";
import type { FrontExpr, Param, Source, Stmt } from "../frontend/ast.ts";
import {
  analyze_front_effects,
  type FrontEffectAnalysis,
} from "../frontend/effect_analysis.ts";
import { format_expr, format_source } from "../frontend/format.ts";
import { name_sites } from "../frontend/name_site.ts";
import { editor_source_facts } from "../frontend/editor_source_facts.ts";
import {
  source_type_display_name,
  type SourceFacts,
} from "../frontend/source_facts.ts";
import {
  has_source_span,
  source_span,
  type SourceSyntax,
} from "../frontend/syntax.ts";
import { source_tokens } from "../frontend/tokenize.ts";
import { front_type_name } from "../frontend/types.ts";
import {
  attached_documentation,
  render_documentation,
} from "./documentation.ts";
import {
  type LspRange,
  type PositionEncoding,
  PositionIndex,
} from "./position.ts";
import { entity_type_declaration, type_entity_layout } from "./type_layout.ts";

export type LspHover = {
  contents: { kind: "markdown"; value: string };
  range: LspRange;
};

export type LspSignatureHelp = {
  signatures: LspSignatureInformation[];
  activeSignature: number;
  activeParameter: number;
};

export type LspSignatureInformation = {
  label: string;
  documentation?: { kind: "markdown"; value: string };
  parameters: { label: string }[];
  activeParameter: number;
};

export type EditorValue = {
  expr: FrontExpr;
  captures: Map<string, EditorValue> | undefined;
};

export type BindingFact = {
  statement: Extract<Stmt, { tag: "bind" | "assign" | "state_bind" }>;
  value: EditorValue;
};

const cached_editor_binding_facts = new WeakMap<
  BindingIndex,
  Map<EntityId, BindingFact>
>();
const cached_type_position_intervals = new WeakMap<
  Source,
  { start: number; end: number }[]
>();
const cached_effect_analyses = new WeakMap<
  Source,
  FrontEffectAnalysis & { available: boolean }
>();

type CallFrame = {
  token_index: number;
  commas: number;
};

type CallTarget = {
  receiver?: string;
  name: string;
};

export function hover(
  source: Source,
  syntax: SourceSyntax,
  index: BindingIndex,
  offset: number,
  encoding: PositionEncoding,
): LspHover | undefined {
  const facts = editor_source_facts(source);
  const occurrence = index.occurrence_at(offset);

  if (occurrence === undefined || occurrence.entity === undefined) {
    if (offset_in_type_position(source, offset)) {
      return undefined;
    }

    return expression_hover(source, syntax, facts, offset, encoding);
  }

  const entity = index.entities.get(occurrence.entity);

  if (entity === undefined) {
    throw new Error("Missing hover entity: " + occurrence.entity);
  }

  if (
    offset_in_type_position(source, offset) &&
    entity_type_declaration(source, entity) === undefined &&
    effect_declaration(source, entity) === undefined &&
    entity.kind !== "type_parameter"
  ) {
    return undefined;
  }

  const sections: string[] = [];
  const definition = entity_definition(index, entity);
  let referenced_type: string | undefined;

  if (occurrence.role === "member") {
    const expression = expression_at(facts, offset);

    if (expression !== undefined && expression.tag === "field") {
      referenced_type = editor_expr_type_name(expression, facts);
    }
  }

  if (definition !== undefined) {
    const documentation = attached_documentation(
      syntax.text,
      definition.span.start,
    );

    if (documentation !== undefined) {
      sections.push(render_documentation(documentation));
    }
  }

  const type_declaration = entity_type_declaration(source, entity);

  if (type_declaration !== undefined) {
    sections.unshift("**type** `" + entity.name + "`");
    sections.push(
      "```duck\n" + format_source({
        tag: "program",
        declarations: [type_declaration],
        statements: [],
      }) + "\n```",
    );
    const layout = type_entity_layout(source, entity);

    if (layout !== undefined) {
      sections.push(format_layout(layout));
    }
  } else {
    const effect = effect_declaration(source, entity);

    if (effect !== undefined) {
      sections.unshift("**effect** `" + entity.name + "`");
      sections.push(
        "```duck\n" + format_source({
          tag: "program",
          declarations: [effect],
          statements: [],
        }) + "\n```",
      );
    } else {
      append_binding_hover(
        source,
        syntax,
        index,
        facts,
        entity,
        sections,
        encoding,
        referenced_type,
      );
    }
  }

  const positions = new PositionIndex(syntax.text, encoding);
  return {
    contents: { kind: "markdown", value: sections.join("\n\n") },
    range: {
      start: positions.position_from_offset(occurrence.span.start),
      end: positions.position_from_offset(occurrence.span.end),
    },
  };
}

function offset_in_type_position(source: Source, offset: number): boolean {
  const cached = cached_type_position_intervals.get(source);

  if (cached !== undefined) {
    return cached.some((interval) =>
      interval.start <= offset && offset < interval.end
    );
  }

  const intervals: { start: number; end: number }[] = [];
  const seen = new WeakSet<object>();

  const type_expr_interval = (
    type_expr: object,
  ): { start: number; end: number } | undefined => {
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;

    const collect_name_spans = (value: object): void => {
      for (const site of name_sites(value)) {
        start = Math.min(start, site.span.start);
        end = Math.max(end, site.span.end);
      }

      for (const child of Object.values(value)) {
        if (child === null || typeof child !== "object") {
          continue;
        }

        if (Array.isArray(child)) {
          for (const entry of child) {
            if (entry !== null && typeof entry === "object") {
              collect_name_spans(entry);
            }
          }
        } else {
          collect_name_spans(child);
        }
      }
    };

    collect_name_spans(type_expr);
    if (start < end) {
      return { start, end };
    }

    return undefined;
  };

  const visit = (value: object): void => {
    if (seen.has(value)) {
      return;
    }

    seen.add(value);

    const node = value as Record<string, unknown>;

    if (node.tag === "is") {
      const expr = value as Extract<FrontExpr, { tag: "is" }>;
      const interval = type_expr_interval(expr.type_expr);

      if (interval !== undefined) {
        intervals.push(interval);
      }
    }

    if (typeof node.annotation === "string") {
      const annotation_sites = name_sites(value).filter((site) =>
        site.slot === "annotation"
      );

      if (annotation_sites.length > 0) {
        let start = Number.POSITIVE_INFINITY;
        let end = Number.NEGATIVE_INFINITY;

        for (const site of annotation_sites) {
          start = Math.min(start, site.span.start);
          end = Math.max(end, site.span.end);
        }

        intervals.push({ start, end });
      }
    }

    for (const child of Object.values(node)) {
      if (child === null || typeof child !== "object") {
        continue;
      }

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
  };

  visit(source);
  cached_type_position_intervals.set(source, intervals);
  return intervals.some((interval) =>
    interval.start <= offset && offset < interval.end
  );
}

function expression_hover(
  source: Source,
  syntax: SourceSyntax,
  facts: SourceFacts,
  offset: number,
  encoding: PositionEncoding,
): LspHover | undefined {
  const expr = expression_at(facts, offset);

  if (expr === undefined) {
    return undefined;
  }

  if (
    expr.tag === "var" && source.declarations !== undefined
  ) {
    const effect = source.declarations.find((declaration) => {
      return declaration.tag === "effect" && declaration.name === expr.name;
    });

    if (effect !== undefined && effect.tag === "effect") {
      const span = source_span(expr);
      const positions = new PositionIndex(syntax.text, encoding);
      return {
        contents: {
          kind: "markdown",
          value: "**effect** `" + effect.name + "`\n\n```duck\n" +
            format_source({
              tag: "program",
              declarations: [effect],
              statements: [],
            }) + "\n```",
        },
        range: {
          start: positions.position_from_offset(span.start),
          end: positions.position_from_offset(span.end),
        },
      };
    }
  }

  let operation_target: Extract<FrontExpr, { tag: "field" }> | undefined;

  if (expr.tag === "field") {
    operation_target = expr;
  } else if (expr.tag === "app" && expr.func.tag === "field") {
    operation_target = expr.func;
  }

  if (
    operation_target !== undefined && operation_target.object.tag === "var"
  ) {
    const operation = effect_operation(
      source,
      operation_target.object.name,
      operation_target.name,
    );

    if (operation !== undefined) {
      const params = operation.params.map((param) => param.type_name);
      const span = source_span(operation_target);
      const positions = new PositionIndex(syntax.text, encoding);
      return {
        contents: {
          kind: "markdown",
          value: "**operation** `" + operation.name + "`\n\ntype: `(" +
            params.join(", ") + ") -> " + operation.result.type_name +
            "`\n\nsignature: `" + operation_target.object.name + "." +
            operation.name +
            "(" + params.join(", ") + ") => " +
            operation.result.type_name + "`",
        },
        range: {
          start: positions.position_from_offset(span.start),
          end: positions.position_from_offset(span.end),
        },
      };
    }
  }

  const inferred = editor_expr_type_name(expr, facts);
  let type = "unknown";

  if (inferred !== undefined) {
    type = inferred;
  }

  const span = source_span(expr);
  const positions = new PositionIndex(syntax.text, encoding);
  return {
    contents: {
      kind: "markdown",
      value: "**expression**\n\ntype: `" + type + "`",
    },
    range: {
      start: positions.position_from_offset(span.start),
      end: positions.position_from_offset(span.end),
    },
  };
}

function expression_at(
  facts: SourceFacts,
  offset: number,
): FrontExpr | undefined {
  let result: FrontExpr | undefined;
  let result_width = Number.POSITIVE_INFINITY;

  for (const expr of facts.expressions) {
    if (!has_source_span(expr)) {
      continue;
    }

    const span = source_span(expr);

    if (offset < span.start || offset >= span.end) {
      continue;
    }

    const width = span.end - span.start;

    if (width < result_width) {
      result = expr;
      result_width = width;
    }
  }

  return result;
}

function editor_expr_type_name(
  expr: FrontExpr,
  facts: SourceFacts,
): string | undefined {
  const editor_type = facts.editor_type_of.get(expr);

  if (editor_type !== undefined) {
    return source_type_display_name(editor_type);
  }

  if (expr.tag === "bool") {
    return "Bool";
  }

  if (expr.tag === "num") {
    if (expr.character !== undefined) {
      return "Char";
    }

    if (expr.type === "i64") {
      return "I64";
    }

    return "I32";
  }

  return undefined;
}

export function signature_help(
  source: Source,
  syntax: SourceSyntax,
  index: BindingIndex,
  offset: number,
): LspSignatureHelp | undefined {
  const tokens = source_tokens(syntax);
  const frames = open_call_frames(tokens, offset);
  const values = editor_binding_facts(source, index);
  const effects = editor_effect_analysis(source);
  const unary = unary_call_frame(source, syntax.text, offset);

  if (unary !== undefined) {
    const result = signature_for_target(
      source,
      syntax,
      index,
      offset,
      values,
      effects,
      unary.target,
      unary.arguments_before,
    );

    if (result !== undefined) {
      return result;
    }
  }

  for (let cursor = frames.length - 1; cursor >= 0; cursor -= 1) {
    const frame = frames[cursor];

    if (frame === undefined) {
      throw new Error("Missing signature frame");
    }

    const target = call_target(tokens, frame.token_index);

    if (target === undefined) {
      continue;
    }

    const open = tokens[frame.token_index];
    const previous = tokens[frame.token_index - 1];
    let active_parameter = frame.commas;

    if (
      open !== undefined && previous !== undefined &&
      /[ \t]/.test(syntax.text.slice(previous.span.end, open.span.start))
    ) {
      active_parameter = 0;
    }

    const result = signature_for_target(
      source,
      syntax,
      index,
      offset,
      values,
      effects,
      target,
      active_parameter,
    );

    if (result !== undefined) {
      return result;
    }
  }

  return undefined;
}

function signature_for_target(
  source: Source,
  syntax: SourceSyntax,
  index: BindingIndex,
  offset: number,
  values: Map<EntityId, BindingFact>,
  effects: FrontEffectAnalysis & { available: boolean },
  target: CallTarget,
  active_parameter: number,
): LspSignatureHelp | undefined {
  if (target.receiver !== undefined) {
    const operation = effect_operation(source, target.receiver, target.name);

    if (operation !== undefined) {
      const labels = operation.params.map((param) => param.type_name);
      const signature: LspSignatureInformation = {
        label: target.receiver + "." + target.name + "(" +
          labels.join(", ") + ") => " + operation.result.type_name,
        parameters: labels.map((label) => ({ label })),
        activeParameter: active_parameter,
      };
      attach_signature_documentation(
        signature,
        syntax,
        index,
        target.name,
        "operation",
      );
      return signature_result(signature, active_parameter);
    }
  }

  const entity = index.visible_at(offset).find((candidate) =>
    candidate.name === target.name
  );

  if (entity === undefined) {
    return undefined;
  }

  const value = values.get(entity.id);
  let closure: Extract<FrontExpr, { tag: "lam" | "rec" }> | undefined;

  if (
    value !== undefined &&
    (value.value.expr.tag === "lam" || value.value.expr.tag === "rec")
  ) {
    closure = value.value.expr;
  } else {
    const statement = binding_statement(source, index, entity);

    if (
      statement !== undefined && statement.tag === "bind" &&
      (statement.value.tag === "lam" || statement.value.tag === "rec")
    ) {
      closure = statement.value;
    }
  }

  if (closure === undefined) {
    return undefined;
  }

  const labels = closure.params.map(format_param);
  let effect_row = "<pure>";
  const function_effects = effects.functions[entity.name];

  if (!effects.available) {
    effect_row = "<effects unavailable>";
  } else if (
    function_effects !== undefined && function_effects.effects.length > 0
  ) {
    effect_row = format_effects(function_effects.effects);
  }

  const signature: LspSignatureInformation = {
    label: entity.name + "(" + labels.join(", ") + ") " + effect_row,
    parameters: labels.map((label) => ({ label })),
    activeParameter: active_parameter,
  };
  attach_signature_documentation(
    signature,
    syntax,
    index,
    entity.name,
    entity.kind,
  );
  return signature_result(signature, active_parameter);
}

function append_binding_hover(
  source: Source,
  syntax: SourceSyntax,
  index: BindingIndex,
  facts: SourceFacts,
  entity: BindingEntity,
  sections: string[],
  encoding: PositionEncoding,
  referenced_type: string | undefined,
): void {
  if (entity.kind === "type_parameter") {
    sections.unshift("```duck\n" + entity.name + ": Type\n```");
    return;
  }

  const values = editor_binding_facts(source, index);
  const binding = values.get(entity.id);
  const declared = declared_member_hover(source, index, entity);
  let rendered_type: string | undefined;

  if (
    entity.kind === "value" || entity.kind === "const" ||
    entity.kind === "parameter" || entity.kind === "module_parameter" ||
    entity.kind === "field" || entity.kind === "case" ||
    entity.kind === "operation"
  ) {
    rendered_type = editor_entity_type_name(
      index,
      entity,
      binding,
      declared?.type,
      facts,
      referenced_type,
    );

    if (binding !== undefined) {
      let declaration_kind = "let";

      if (entity.kind === "const") {
        declaration_kind = "const";
      }

      let declaration_name = entity.name;

      if (entity.linear) {
        declaration_name = "!" + declaration_name;
      }

      sections.unshift(
        "```duck\n" + declaration_kind + " " + declaration_name + ": " +
          rendered_type + "\n```",
      );
    } else if (
      entity.kind === "parameter" || entity.kind === "module_parameter"
    ) {
      let declaration_name = entity.name;

      if (entity.linear) {
        declaration_name = "!" + declaration_name;
      }

      if (entity.readonly) {
        declaration_name = "const " + declaration_name;
      }

      sections.unshift(
        "```duck\n" + declaration_name + ": " + rendered_type + "\n```",
      );
    } else if (entity.kind === "value") {
      let declaration_name = entity.name;

      if (entity.linear) {
        declaration_name = "!" + declaration_name;
      }

      sections.unshift(
        "```duck\nlet " + declaration_name + ": " + rendered_type + "\n```",
      );
    } else {
      sections.unshift("**" + entity.kind + "** `" + entity.name + "`");
      sections.push("type: `" + rendered_type + "`");
    }
  }

  if (binding !== undefined) {
    const value = binding.value;

    if (value.expr.tag === "lam" || value.expr.tag === "rec") {
      sections.push("```duck\n" + capped_format_expr(value.expr) + "\n```");
      append_captures(value, sections);
      const effects = editor_effect_analysis(source);
      const function_effects = effects.functions[entity.name];
      let row = "<pure>";

      if (!effects.available) {
        row = "<effects unavailable>";
      } else if (
        function_effects !== undefined && function_effects.effects.length > 0
      ) {
        row = format_effects(function_effects.effects);
      }

      sections.push("latent effects: `" + row + "`");
    } else if (entity.kind === "const") {
      sections.push(
        "value:\n```duck\n" + capped_format_expr(value.expr) +
          "\n```",
      );
    }
  }

  if (entity.linear) {
    append_consume_points(index, entity, syntax.text, encoding, sections);
  }

  if (declared?.detail !== undefined && rendered_type !== "unknown") {
    sections.push(declared.detail);
  }
}

function editor_entity_type_name(
  index: BindingIndex,
  entity: BindingEntity,
  binding: BindingFact | undefined,
  declared_type: string | undefined,
  facts: SourceFacts,
  referenced_type: string | undefined,
): string {
  if (referenced_type !== undefined) {
    return referenced_type;
  }

  if (
    binding !== undefined &&
    (binding.statement.tag === "bind" ||
      binding.statement.tag === "state_bind")
  ) {
    let slot = "name";

    if (binding.statement.tag === "state_bind") {
      slot = "value_name";
    }

    const definition_type = facts.definition_type_of.get(binding.statement)
      ?.get(slot);

    if (
      definition_type !== undefined &&
      definition_type.resolved_name !== "unknown"
    ) {
      return source_type_display_name(definition_type);
    }
  }

  const inferred_definition = facts.definition_type_of.get(
    entity.definition_subject,
  )?.get(entity.definition_slot);

  if (
    inferred_definition !== undefined &&
    inferred_definition.resolved_name !== "unknown"
  ) {
    return source_type_display_name(inferred_definition);
  }

  const entity_facts = index.facts.get(entity.id);

  if (
    entity_facts !== undefined && entity_facts.editor_type !== undefined &&
    (entity_facts.editor_type !== "unknown" ||
      binding?.statement.tag !== "state_bind")
  ) {
    return entity_facts.editor_type;
  }

  if (declared_type !== undefined) {
    return declared_type;
  }

  if (entity_facts !== undefined && entity_facts.nominal !== undefined) {
    const nominal = index.entities.get(entity_facts.nominal);

    if (nominal !== undefined) {
      return nominal.name;
    }
  }

  if (
    entity_facts !== undefined && entity_facts.type !== undefined &&
    entity_facts.type.tag !== "unknown"
  ) {
    return front_type_name(entity_facts.type);
  }

  if (binding !== undefined) {
    const inferred = editor_expr_type_name(binding.value.expr, facts);

    if (inferred !== undefined) {
      return inferred;
    }
  }

  return "unknown";
}

export function editor_binding_facts(
  source: Source,
  index: BindingIndex,
): Map<EntityId, BindingFact> {
  const cached = cached_editor_binding_facts.get(index);

  if (cached !== undefined) {
    return cached;
  }

  const facts = new Map<EntityId, BindingFact>();
  const env = new Map<string, EditorValue>();

  for (const statement of source.statements) {
    if (statement.tag === "bind") {
      const entity = entity_for_owner(index, statement, "name", statement.name);
      const value = eval_editor_value(statement.value, env, 0);

      if (entity !== undefined) {
        facts.set(entity, { statement, value });
      }

      env.set(statement.name, value);
      continue;
    }

    if (statement.tag === "assign") {
      const value = eval_editor_value(statement.value, env, 0);
      const entity = entity_for_owner(index, statement, "name", statement.name);

      if (entity !== undefined) {
        facts.set(entity, { statement, value });
      }

      env.set(statement.name, value);
    }
  }

  const visited = new WeakSet<object>();
  const visit_nested_bindings = (value: object): void => {
    if (visited.has(value)) {
      return;
    }

    visited.add(value);
    const node = value as Record<string, unknown>;

    if (
      node.tag === "bind" && typeof node.name === "string" &&
      node.value !== null && typeof node.value === "object"
    ) {
      const statement = value as Extract<Stmt, { tag: "bind" }>;
      const entity = entity_for_owner(index, statement, "name", statement.name);

      if (entity !== undefined && !facts.has(entity)) {
        facts.set(entity, {
          statement,
          value: { expr: statement.value, captures: undefined },
        });
      }
    }

    if (
      node.tag === "state_bind" && typeof node.value_name === "string" &&
      node.value !== null && typeof node.value === "object"
    ) {
      const value_name = node.value_name;
      const statement = value as Extract<Stmt, { tag: "state_bind" }>;
      const entity = entity_for_owner(
        index,
        statement,
        "value_name",
        value_name,
      );

      if (entity !== undefined) {
        facts.set(entity, {
          statement,
          value: { expr: statement.value, captures: undefined },
        });
      }
    }

    for (const child of Object.values(node)) {
      if (child === null || typeof child !== "object") {
        continue;
      }

      if (Array.isArray(child)) {
        for (const entry of child) {
          if (entry !== null && typeof entry === "object") {
            visit_nested_bindings(entry);
          }
        }
      } else {
        visit_nested_bindings(child);
      }
    }
  };

  for (const statement of source.statements) {
    visit_nested_bindings(statement);
  }

  cached_editor_binding_facts.set(index, facts);
  return facts;
}

export function eval_editor_value(
  expr: FrontExpr,
  env: Map<string, EditorValue>,
  depth: number,
): EditorValue {
  if (depth >= 12) {
    return { expr, captures: undefined };
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    const value = env.get(expr.name);

    if (value !== undefined) {
      return value;
    }

    return { expr, captures: undefined };
  }

  if (expr.tag === "comptime" || expr.tag === "captured") {
    return eval_editor_value(expr.expr, env, depth + 1);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return eval_editor_value(expr.value, env, depth + 1);
  }

  if (expr.tag === "scratch") {
    return eval_editor_value(expr.body, env, depth + 1);
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    const bound = new Set(expr.params.map((param) => param.name));
    const free = free_expr_names(expr.body, bound);
    const captures = new Map<string, EditorValue>();

    for (const name of free) {
      const value = env.get(name);

      if (value !== undefined) {
        captures.set(name, value);
      }
    }

    return { expr, captures };
  }

  if (expr.tag === "app") {
    const func = eval_editor_value(expr.func, env, depth + 1);

    if (
      func.captures !== undefined &&
      (func.expr.tag === "lam" || func.expr.tag === "rec") &&
      func.expr.params.length === expr.args.length
    ) {
      const call_env = new Map(func.captures);

      for (let index = 0; index < func.expr.params.length; index += 1) {
        const param = func.expr.params[index];
        const arg = expr.args[index];

        if (param === undefined || arg === undefined) {
          throw new Error("Missing editor call argument");
        }

        call_env.set(param.name, eval_editor_value(arg, env, depth + 1));
      }

      return eval_editor_value(func.expr.body, call_env, depth + 1);
    }

    return { expr, captures: undefined };
  }

  if (expr.tag === "prim") {
    const left = eval_editor_value(expr.left, env, depth + 1);
    const right = eval_editor_value(expr.right, env, depth + 1);
    const folded = fold_editor_prim(expr.prim, left.expr, right.expr);

    if (folded !== undefined) {
      return { expr: folded, captures: undefined };
    }

    return {
      expr: { ...expr, left: left.expr, right: right.expr },
      captures: undefined,
    };
  }

  if (expr.tag === "block") {
    return eval_editor_block(expr.statements, env, depth + 1);
  }

  if (expr.tag === "if") {
    const condition = eval_editor_value(expr.cond, env, depth + 1);

    if (condition.expr.tag === "bool") {
      if (condition.expr.value) {
        return eval_editor_value(expr.then_branch, env, depth + 1);
      }

      return eval_editor_value(expr.else_branch, env, depth + 1);
    }

    if (condition.expr.tag === "num") {
      let truthy = false;

      if (typeof condition.expr.value === "bigint") {
        truthy = condition.expr.value !== 0n;
      } else {
        truthy = condition.expr.value !== 0;
      }

      if (truthy) {
        return eval_editor_value(expr.then_branch, env, depth + 1);
      }

      return eval_editor_value(expr.else_branch, env, depth + 1);
    }
  }

  if (expr.tag === "struct_value") {
    return {
      expr: {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          value: eval_editor_value(field.value, env, depth + 1).expr,
        })),
      },
      captures: undefined,
    };
  }

  if (expr.tag === "union_case" && expr.value !== undefined) {
    return {
      expr: {
        ...expr,
        value: eval_editor_value(expr.value, env, depth + 1).expr,
      },
      captures: undefined,
    };
  }

  return { expr, captures: undefined };
}

function fold_editor_prim(
  prim: string,
  left: FrontExpr,
  right: FrontExpr,
): FrontExpr | undefined {
  if (left.tag === "bool" && right.tag === "bool") {
    if (prim === "i32.eq") {
      return { tag: "bool", value: left.value === right.value };
    }

    if (prim === "i32.ne") {
      return { tag: "bool", value: left.value !== right.value };
    }

    return undefined;
  }

  if (left.tag !== "num" || right.tag !== "num") {
    return undefined;
  }

  if (left.type !== right.type) {
    return undefined;
  }

  const left_value = BigInt(left.value);
  const right_value = BigInt(right.value);
  const operation = prim.slice(prim.indexOf(".") + 1);
  let result: bigint;
  let comparison = false;

  if (operation === "add") {
    result = left_value + right_value;
  } else if (operation === "sub") {
    result = left_value - right_value;
  } else if (operation === "mul") {
    result = left_value * right_value;
  } else if (operation === "div_s") {
    if (right_value === 0n) {
      return undefined;
    }

    result = left_value / right_value;
  } else if (operation === "rem_s") {
    if (right_value === 0n) {
      return undefined;
    }

    result = left_value % right_value;
  } else if (operation === "eq") {
    comparison = true;
    result = 0n;

    if (left_value === right_value) {
      result = 1n;
    }
  } else if (operation === "ne") {
    comparison = true;
    result = 0n;

    if (left_value !== right_value) {
      result = 1n;
    }
  } else if (operation === "lt_s") {
    comparison = true;
    result = 0n;

    if (left_value < right_value) {
      result = 1n;
    }
  } else if (operation === "le_s") {
    comparison = true;
    result = 0n;

    if (left_value <= right_value) {
      result = 1n;
    }
  } else if (operation === "gt_s") {
    comparison = true;
    result = 0n;

    if (left_value > right_value) {
      result = 1n;
    }
  } else if (operation === "ge_s") {
    comparison = true;
    result = 0n;

    if (left_value >= right_value) {
      result = 1n;
    }
  } else {
    return undefined;
  }

  if (comparison) {
    return { tag: "bool", value: result !== 0n };
  }

  if (prim.startsWith("i64.")) {
    return { tag: "num", type: "i64", value: BigInt.asIntN(64, result) };
  }

  return { tag: "num", type: "i32", value: Number(BigInt.asIntN(32, result)) };
}

function eval_editor_block(
  statements: Stmt[],
  outer: Map<string, EditorValue>,
  depth: number,
): EditorValue {
  const env = new Map(outer);
  let result: EditorValue = {
    expr: { tag: "unit" },
    captures: undefined,
  };

  for (const statement of statements) {
    if (statement.tag === "bind") {
      const value = eval_editor_value(statement.value, env, depth + 1);
      env.set(statement.name, value);
      result = value;
      continue;
    }

    if (statement.tag === "assign") {
      const value = eval_editor_value(statement.value, env, depth + 1);
      env.set(statement.name, value);
      result = value;
      continue;
    }

    if (statement.tag === "expr") {
      result = eval_editor_value(statement.expr, env, depth + 1);
      continue;
    }

    if (statement.tag === "return") {
      return eval_editor_value(statement.value, env, depth + 1);
    }
  }

  return result;
}

function free_expr_names(expr: FrontExpr, bound: Set<string>): Set<string> {
  const names = new Set<string>();

  if (expr.tag === "var" || expr.tag === "linear") {
    if (!bound.has(expr.name)) {
      names.add(expr.name);
    }

    return names;
  }

  if (expr.tag === "lam" || expr.tag === "rec") {
    const nested = new Set(bound);

    for (const param of expr.params) {
      nested.add(param.name);
    }

    return free_expr_names(expr.body, nested);
  }

  if (expr.tag === "block") {
    return free_statement_names(expr.statements, bound);
  }

  if (expr.tag === "loop") {
    return free_statement_names(expr.body, bound);
  }

  if (expr.tag === "if_let") {
    const names = free_expr_names(expr.target, bound);
    const then_bound = new Set(bound);

    if (expr.value_name !== undefined) {
      then_bound.add(expr.value_name);
    }

    add_names(names, free_expr_names(expr.then_branch, then_bound));
    add_names(names, free_expr_names(expr.else_branch, bound));
    return names;
  }

  if (expr.tag === "handler") {
    const names = new Set<string>();
    const handler_bound = new Set(bound);

    for (const state of expr.state) {
      add_names(names, free_expr_names(state.value, handler_bound));
      handler_bound.add(state.name);
    }

    for (const clause of expr.clauses) {
      const clause_bound = new Set(handler_bound);

      for (const param of clause.params) {
        clause_bound.add(param.name);
      }

      add_names(names, free_expr_names(clause.body, clause_bound));
    }

    const return_bound = new Set(handler_bound);
    return_bound.add(expr.return_clause.param.name);
    add_names(
      names,
      free_expr_names(expr.return_clause.body, return_bound),
    );
    return names;
  }

  for (const child of expression_children(expr)) {
    for (const name of free_expr_names(child, bound)) {
      names.add(name);
    }
  }

  return names;
}

function free_statement_names(
  statements: Stmt[],
  outer: Set<string>,
): Set<string> {
  const bound = new Set(outer);
  const names = new Set<string>();

  for (const statement of statements) {
    if (statement.tag === "bind" || statement.tag === "assign") {
      add_names(names, free_expr_names(statement.value, bound));
      bound.add(statement.name);
      continue;
    }

    if (
      statement.tag === "state_bind" || statement.tag === "bind_pattern" ||
      statement.tag === "resume_dup"
    ) {
      add_names(names, free_expr_names(statement.value, bound));

      if (statement.tag === "state_bind") {
        if (statement.value_name !== undefined) {
          bound.add(statement.value_name);
        }
      } else if (statement.tag === "bind_pattern") {
        for (const item of statement.items) {
          bound.add(item.name);
        }
      } else {
        bound.add(statement.left);
        bound.add(statement.right);
      }

      continue;
    }

    if (statement.tag === "index_assign") {
      if (!bound.has(statement.name)) {
        names.add(statement.name);
      }

      add_names(names, free_expr_names(statement.index, bound));
      add_names(names, free_expr_names(statement.value, bound));
      continue;
    }

    if (statement.tag === "expr") {
      add_names(names, free_expr_names(statement.expr, bound));
      continue;
    }

    if (statement.tag === "return") {
      add_names(names, free_expr_names(statement.value, bound));
      continue;
    }

    if (statement.tag === "if_stmt") {
      add_names(names, free_expr_names(statement.cond, bound));
      add_names(names, free_statement_names(statement.body, bound));
      continue;
    }

    if (statement.tag === "if_let_stmt") {
      add_names(names, free_expr_names(statement.target, bound));
      const body_bound = new Set(bound);

      if (statement.value_name !== undefined) {
        body_bound.add(statement.value_name);
      }

      add_names(names, free_statement_names(statement.body, body_bound));
      continue;
    }

    if (statement.tag === "for_range") {
      add_names(names, free_expr_names(statement.start, bound));
      add_names(names, free_expr_names(statement.end, bound));
      add_names(names, free_expr_names(statement.step, bound));
      const body_bound = new Set(bound);
      body_bound.add(statement.index);
      add_names(names, free_statement_names(statement.body, body_bound));
      continue;
    }

    if (statement.tag === "for_collection") {
      add_names(names, free_expr_names(statement.collection, bound));
      const body_bound = new Set(bound);

      if (statement.index !== undefined) {
        body_bound.add(statement.index);
      }

      body_bound.add(statement.item);
      add_names(names, free_statement_names(statement.body, body_bound));
      continue;
    }

    if (statement.tag === "type_check") {
      add_names(names, free_expr_names(statement.target, bound));
      continue;
    }

    if (statement.tag === "break" && statement.value !== undefined) {
      add_names(names, free_expr_names(statement.value, bound));
    }
  }

  return names;
}

function expression_children(expr: FrontExpr): FrontExpr[] {
  if (expr.tag === "prim") {
    return [expr.left, expr.right];
  }

  if (expr.tag === "app") {
    return [expr.func, ...expr.args];
  }

  if (expr.tag === "comptime" || expr.tag === "captured") {
    return [expr.expr];
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return [expr.value];
  }

  if (expr.tag === "scratch") {
    return [expr.body];
  }

  if (expr.tag === "field") {
    return [expr.object];
  }

  if (expr.tag === "index") {
    return [expr.object, expr.index];
  }

  if (expr.tag === "try_with") {
    return [expr.body, expr.handler];
  }

  if (expr.tag === "if") {
    return [expr.cond, expr.then_branch, expr.else_branch];
  }
  if (expr.tag === "with" || expr.tag === "struct_update") {
    return [expr.base, ...expr.fields.map((field) => field.value)];
  }
  if (expr.tag === "struct_value") {
    return expr.fields.map((field) => field.value);
  }
  if (expr.tag === "union_case") {
    const children: FrontExpr[] = [];

    if (expr.value !== undefined) {
      children.push(expr.value);
    }

    return children;
  }

  if (expr.tag === "is") {
    return [expr.value];
  }

  return [];
}

function add_names(target: Set<string>, source: Set<string>): void {
  for (const name of source) {
    target.add(name);
  }
}

function entity_for_owner(
  index: BindingIndex,
  owner: object,
  slot: string,
  name: string,
): EntityId | undefined {
  const site = name_sites(owner).find((candidate) =>
    candidate.slot === slot && candidate.name === name
  );

  if (site === undefined) {
    return undefined;
  }

  const occurrence = index.occurrence_at(site.span.start);
  return occurrence?.entity;
}

function binding_statement(
  source: Source,
  index: BindingIndex,
  entity: BindingEntity,
): Extract<Stmt, { tag: "bind" | "assign" }> | undefined {
  for (const statement of source.statements) {
    if (statement.tag !== "bind" && statement.tag !== "assign") {
      continue;
    }

    if (
      entity_for_owner(index, statement, "name", statement.name) === entity.id
    ) {
      return statement;
    }
  }

  return undefined;
}

function entity_definition(
  index: BindingIndex,
  entity: BindingEntity,
) {
  if (entity.definition === undefined) {
    return undefined;
  }

  return index.occurrences.get(entity.definition);
}

export function editor_effect_analysis(
  source: Source,
): FrontEffectAnalysis & { available: boolean } {
  const cached = cached_effect_analyses.get(source);

  if (cached !== undefined) {
    return cached;
  }

  try {
    const analysis = { ...analyze_front_effects(source), available: true };
    cached_effect_analyses.set(source, analysis);
    return analysis;
  } catch (error) {
    if (error instanceof Error) {
      const analysis = {
        module_effects: [],
        functions: {},
        available: false,
      };
      cached_effect_analyses.set(source, analysis);
      return analysis;
    }

    throw error;
  }
}

function effect_declaration(source: Source, entity: BindingEntity) {
  if (entity.kind !== "effect" || source.declarations === undefined) {
    return undefined;
  }

  return source.declarations.find((declaration) =>
    declaration.tag === "effect" && declaration.name === entity.name
  );
}

function effect_operation(source: Source, effect: string, operation: string) {
  if (source.declarations === undefined) {
    return undefined;
  }

  for (const declaration of source.declarations) {
    if (declaration.tag === "effect" && declaration.name === effect) {
      return declaration.operations.find((candidate) =>
        candidate.name === operation
      );
    }
  }

  return undefined;
}

function declared_member_hover(
  source: Source,
  index: BindingIndex,
  entity: BindingEntity,
): { type: string; detail: string | undefined } | undefined {
  if (entity.owner === undefined || source.declarations === undefined) {
    return undefined;
  }

  const owner = index.entities.get(entity.owner);

  if (owner === undefined) {
    return undefined;
  }

  for (const declaration of source.declarations) {
    if (declaration.tag === "extend" || declaration.tag === "fixity") {
      continue;
    }

    if (declaration.name !== owner.name) {
      continue;
    }
    if (declaration.tag === "effect") {
      const operation = declaration.operations.find((candidate) =>
        candidate.name === entity.name
      );

      if (operation !== undefined) {
        const params = operation.params.map((param) => param.type_name);
        return {
          type: "(" + params.join(", ") + ") -> " +
            operation.result.type_name,
          detail: "signature: `" + owner.name + "." + operation.name + "(" +
            params.join(", ") + ") => " + operation.result.type_name + "`",
        };
      }
    }
    let fields: { name: string; type_name: string }[] = [];

    if (declaration.tag === "record") {
      fields = declaration.fields;
    } else if (declaration.tag === "type") {
      if (declaration.body.tag === "product") {
        fields = declaration.body.fields;
      } else if (declaration.body.tag === "sum") {
        const union_case = declaration.body.cases.find((candidate) =>
          candidate.name === entity.name
        );

        if (union_case !== undefined) {
          if (union_case.type_name === "Unit") {
            return { type: owner.name, detail: undefined };
          }

          return {
            type: "(" + union_case.type_name + ") -> " + owner.name,
            detail: undefined,
          };
        }
      }
    }

    const field = fields.find((candidate) => candidate.name === entity.name);

    if (field !== undefined) {
      return { type: field.type_name, detail: undefined };
    }
  }
  return undefined;
}

function format_layout(
  layout: NonNullable<ReturnType<typeof type_entity_layout>>,
): string {
  const parts = [
    "size: `" + layout.size.toString() + "`",
    "align: `" + layout.align.toString() + "`",
  ];

  if (layout.fields.length > 0) {
    const fields = layout.fields.map((field) => {
      let offset = "?";

      if (field.value.tag === "num") {
        offset = field.value.value.toString();
      }

      return "`" + field.name + " @ " + offset + "`";
    });
    parts.push("field offsets: " + fields.join(", "));
  }

  if (layout.tag_offset !== undefined) {
    parts.push("tag offset: `" + layout.tag_offset.toString() + "`");
  }

  if (layout.payload_offset !== undefined) {
    parts.push("payload offset: `" + layout.payload_offset.toString() + "`");
  }

  return "layout — " + parts.join(", ");
}

function append_captures(value: EditorValue, sections: string[]): void {
  const captures = value.captures;

  if (captures === undefined || captures.size === 0) {
    sections.push("captures: none");
    return;
  }

  const lines: string[] = [];
  let count = 0;

  for (const [name, captured] of captures) {
    if (count >= 8) {
      lines.push("- …");
      break;
    }

    lines.push("- `" + name + " = " + capped_format_expr(captured.expr) + "`");
    count += 1;
  }

  sections.push("captures:\n" + lines.join("\n"));
}

function append_consume_points(
  index: BindingIndex,
  entity: BindingEntity,
  text: string,
  encoding: PositionEncoding,
  sections: string[],
): void {
  const references = index.references.get(entity.id);
  const positions = new PositionIndex(text, encoding);
  const points: string[] = [];

  if (references !== undefined) {
    for (const reference of references) {
      const occurrence = index.occurrences.get(reference);

      if (occurrence !== undefined && occurrence.role === "consume") {
        const position = positions.position_from_offset(occurrence.span.start);
        points.push(
          "line " + (position.line + 1).toString() + ", column " +
            (position.character + 1).toString(),
        );
      }
    }
  }

  if (points.length === 0) {
    sections.push("consume status: not yet consumed");
  } else {
    sections.push("consume point: " + points.join("; "));
  }
}

export function capped_format_expr(expr: FrontExpr): string {
  let text = format_expr(expr);
  const depth = expression_depth(expr, 0);

  if (text.length > 480) {
    text = text.slice(0, 480) + "…";
  }

  if (depth > 8) {
    text += "\n… depth truncated at 8";
  }

  return text;
}

function expression_depth(expr: FrontExpr, depth: number): number {
  let maximum = depth;

  for (const child of expression_children(expr)) {
    maximum = Math.max(maximum, expression_depth(child, depth + 1));
  }

  return maximum;
}

function format_param(param: Param): string {
  let text = param.name;

  if (param.is_linear) {
    text = "!" + text;
  }

  if (param.is_const) {
    text = "const " + text;
  }

  if (param.annotation !== undefined) {
    text += ": " + param.annotation;
  }

  return text;
}

export function format_effects(
  effects: { effect: string; operation: string }[],
): string {
  return "<" +
    effects.map((effect) => effect.effect + "." + effect.operation).join(", ") +
    ">";
}

function open_call_frames(
  tokens: ReturnType<typeof source_tokens>,
  offset: number,
): CallFrame[] {
  const stack: { symbol: "(" | "[" | "{"; frame?: CallFrame }[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === undefined || token.span.start >= offset) {
      break;
    }

    if (token.kind !== "symbol") {
      continue;
    }

    if (token.text === "(") {
      stack.push({ symbol: "(", frame: { token_index: index, commas: 0 } });
    } else if (token.text === "[") {
      stack.push({ symbol: "[" });
    } else if (token.text === "{") {
      stack.push({ symbol: "{" });
    } else if (token.text === ",") {
      const top = stack[stack.length - 1];

      if (top !== undefined && top.frame !== undefined) {
        top.frame.commas += 1;
      }
    } else if (token.text === ")") {
      pop_delimiter(stack, "(");
    } else if (token.text === "]") {
      pop_delimiter(stack, "[");
    } else if (token.text === "}") {
      pop_delimiter(stack, "{");
    }
  }

  const frames: CallFrame[] = [];

  for (const item of stack) {
    if (item.frame !== undefined) {
      frames.push(item.frame);
    }
  }

  return frames;
}

function unary_call_frame(
  source: Source,
  text: string,
  offset: number,
): { target: CallTarget; arguments_before: number } | undefined {
  let candidate:
    | { expr: Extract<FrontExpr, { tag: "app" }>; end: number }
    | undefined;
  const seen = new WeakSet<object>();

  const visit = (value: object): void => {
    if (seen.has(value)) {
      return;
    }

    seen.add(value);

    if (has_source_span(value)) {
      const span = source_span(value);
      const expr = value as Partial<FrontExpr>;

      if (
        expr.tag === "app" && span.end <= offset &&
        /^[ \t]*$/.test(text.slice(span.end, offset)) &&
        (candidate === undefined || candidate.end < span.end)
      ) {
        candidate = {
          expr: value as Extract<FrontExpr, { tag: "app" }>,
          end: span.end,
        };
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

  if (candidate !== undefined) {
    let func: FrontExpr = candidate.expr.func;
    let arguments_before = 1;

    while (func.tag === "app") {
      arguments_before += 1;
      func = func.func;
    }

    const target = expression_call_target(func);

    if (target !== undefined) {
      return { target, arguments_before };
    }
  }

  const prefix = text.slice(0, offset);
  const initial =
    /([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?[ \t]+$/.exec(
      prefix,
    );

  if (initial === null) {
    return undefined;
  }

  const receiver = initial[1];
  const name = initial[2];

  if (receiver === undefined) {
    throw new Error("Missing unary call target");
  }

  if (name !== undefined) {
    return { target: { receiver, name }, arguments_before: 0 };
  }

  return { target: { name: receiver }, arguments_before: 0 };
}

function expression_call_target(expr: FrontExpr): CallTarget | undefined {
  if (expr.tag === "var") {
    return { name: expr.name };
  }

  if (expr.tag === "field" && expr.object.tag === "var") {
    return { receiver: expr.object.name, name: expr.name };
  }

  return undefined;
}

function pop_delimiter(
  stack: { symbol: "(" | "[" | "{"; frame?: CallFrame }[],
  symbol: "(" | "[" | "{",
): void {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const item = stack[index];

    if (item !== undefined && item.symbol === symbol) {
      stack.splice(index);
      return;
    }
  }
}

function call_target(
  tokens: ReturnType<typeof source_tokens>,
  open_index: number,
): CallTarget | undefined {
  let cursor = open_index - 1;

  while (cursor >= 0 && tokens[cursor]?.kind === "newline") {
    cursor -= 1;
  }

  const name = tokens[cursor];

  if (name === undefined || name.kind !== "name") {
    return undefined;
  }

  const dot = tokens[cursor - 1];
  const receiver = tokens[cursor - 2];

  if (
    dot !== undefined && dot.kind === "symbol" && dot.text === "." &&
    receiver !== undefined && receiver.kind === "name"
  ) {
    return { receiver: receiver.text, name: name.text };
  }

  return { name: name.text };
}

function attach_signature_documentation(
  signature: LspSignatureInformation,
  syntax: SourceSyntax,
  index: BindingIndex,
  name: string,
  kind: string,
): void {
  const entity = [...index.entities.values()].find((candidate) =>
    candidate.name === name && candidate.kind === kind
  );

  if (entity === undefined) {
    return;
  }

  const definition = entity_definition(index, entity);

  if (definition === undefined) {
    return;
  }

  const documentation = attached_documentation(
    syntax.text,
    definition.span.start,
  );

  if (documentation !== undefined) {
    signature.documentation = {
      kind: "markdown",
      value: render_documentation(documentation),
    };
  }
}

function signature_result(
  signature: LspSignatureInformation,
  active_parameter: number,
): LspSignatureHelp {
  return {
    signatures: [signature],
    activeSignature: 0,
    activeParameter: active_parameter,
  };
}
