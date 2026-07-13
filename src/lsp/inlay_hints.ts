import type { BindingIndex, EntityId } from "../frontend/binding_index.ts";
import type {
  FrontExpr,
  FrontType,
  Param,
  Source,
  Stmt,
} from "../frontend/ast.ts";
import { name_sites } from "../frontend/name_site.ts";
import { prim_returns_bool } from "../frontend/numeric.ts";
import {
  source_span,
  type SourceSpan,
  type SourceSyntax,
} from "../frontend/syntax.ts";
import { front_type_name } from "../frontend/types.ts";
import {
  capped_format_expr,
  editor_binding_facts,
  editor_effect_analysis,
  type EditorValue,
  eval_editor_value,
  format_effects,
} from "./hover.ts";
import {
  type LspPosition,
  type PositionEncoding,
  PositionIndex,
} from "./position.ts";

export type InlayHintCategory =
  | "types"
  | "effects"
  | "ownership"
  | "comptime"
  | "loops";

export type InlayHintConfig = Record<InlayHintCategory, boolean>;

export type InlayHintData = {
  uri: string;
  category: InlayHintCategory;
  detail: string;
};

export type LspInlayHint = {
  position: LspPosition;
  label: string;
  kind?: 1 | 2;
  paddingLeft?: boolean;
  paddingRight?: boolean;
  tooltip?: { kind: "markdown"; value: string };
  data: InlayHintData;
};

type OffsetHint = LspInlayHint & { offset: number };

export function default_inlay_hint_config(): InlayHintConfig {
  return {
    types: true,
    effects: true,
    ownership: false,
    comptime: true,
    loops: false,
  };
}

export function inlay_hints(
  source: Source,
  syntax: SourceSyntax,
  index: BindingIndex,
  uri: string,
  range: SourceSpan,
  encoding: PositionEncoding,
  config: InlayHintConfig,
): LspInlayHint[] {
  const positions = new PositionIndex(syntax.text, encoding);
  const hints: OffsetHint[] = [];
  const parameter_types = inferred_parameter_types(source, index);
  const editor_facts = editor_binding_facts(source, index);
  const effects = editor_effect_analysis(source);

  const add = (
    offset: number,
    label: string,
    category: InlayHintCategory,
    detail: string,
    kind: 1 | 2 | undefined,
    padding_left: boolean,
    padding_right: boolean,
  ): void => {
    if (offset < range.start || offset >= range.end) {
      return;
    }

    if (
      hints.some((hint) =>
        hint.offset === offset && hint.label === label &&
        hint.data.category === category
      )
    ) {
      return;
    }

    const hint: OffsetHint = {
      offset,
      position: positions.position_from_offset(offset),
      label,
      data: { uri, category, detail },
    };

    if (kind !== undefined) {
      hint.kind = kind;
    }

    if (padding_left) {
      hint.paddingLeft = true;
    }

    if (padding_right) {
      hint.paddingRight = true;
    }

    hints.push(hint);
  };

  visit_statements(source.statements, (statement) => {
    if (statement.tag === "bind") {
      const entity = entity_for_owner(
        index,
        statement,
        "name",
        statement.name,
      );
      const site = site_for_owner(statement, "name", statement.name);

      if (
        config.types && statement.annotation === undefined &&
        entity !== undefined && site !== undefined
      ) {
        const inferred = entity_type_name(index, entity);

        if (inferred !== undefined && inferred !== "unknown") {
          add(
            site.end,
            ": " + inferred,
            "types",
            "Inferred binding type: " + inferred,
            1,
            false,
            false,
          );
        }
      }

      if (
        config.effects && entity !== undefined && site !== undefined &&
        (statement.value.tag === "lam" || statement.value.tag === "rec") &&
        !annotation_has_effect_row(statement.annotation)
      ) {
        const effect = effects.functions[statement.name];

        if (effect !== undefined && effect.effects.length > 0) {
          const row = format_effects(effect.effects);
          let label = " -> " + row;
          const result_type = closure_result_type(
            statement.value,
            source,
            index,
          );

          if (result_type !== undefined) {
            label += " " + result_type;
          }

          add(
            site.end,
            label,
            "effects",
            "Inferred latent effect row: " + row,
            1,
            false,
            false,
          );
        }
      }

      if (config.comptime && entity !== undefined) {
        const fact = editor_facts.get(entity);

        if (
          fact !== undefined &&
          (statement.kind === "const" || statement.value.tag === "comptime") &&
          fact.value.expr.tag !== "lam" && fact.value.expr.tag !== "rec"
        ) {
          const value = capped_format_expr(fact.value.expr);
          add(
            source_span(statement.value).end,
            " = " + value,
            "comptime",
            "Compile-time result: " + value,
            undefined,
            true,
            false,
          );
        }
      }

      visit_params(
        statement.value,
        index,
        parameter_types,
        config,
        add,
      );
    }

    if (config.loops && statement.tag === "for_range") {
      const env = editor_environment(source, source_span(statement).start);
      const count = range_iteration_count(statement, env);

      if (count !== undefined) {
        add(
          source_span(statement.end).end,
          " × " + count.toString(),
          "loops",
          "Static range expansion: " + count.toString() + " iterations",
          undefined,
          true,
          false,
        );
      }
    }

    if (config.loops && statement.tag === "for_collection") {
      const env = editor_environment(source, source_span(statement).start);
      const count = collection_iteration_count(
        statement.collection,
        env,
      );

      if (count !== undefined) {
        add(
          source_span(statement.collection).end,
          " × " + count.toString(),
          "loops",
          "Static collection expansion: " + count.toString() +
            " iterations",
          undefined,
          true,
          false,
        );
      }
    }
  }, (expr) => {
    if (config.comptime && expr.tag === "comptime") {
      const env = editor_environment(source, source_span(expr).start);
      const value = eval_editor_value(expr.expr, env, 0);
      const formatted = capped_format_expr(value.expr);
      add(
        source_span(expr).end,
        " = " + formatted,
        "comptime",
        "Compile-time expression result: " + formatted,
        undefined,
        true,
        false,
      );
    }

    if (expr.tag === "app") {
      if (config.ownership) {
        append_ownership_hints(source, index, expr, add);
      }

      if (config.comptime) {
        append_specialization_hint(source, index, expr, add);
      }
    }
  });

  hints.sort((left, right) => {
    if (left.offset !== right.offset) {
      return left.offset - right.offset;
    }

    return left.label.localeCompare(right.label);
  });
  return hints.map((hint) => {
    const result = { ...hint };
    delete (result as { offset?: number }).offset;
    return result;
  });
}

export function resolve_inlay_hint(hint: LspInlayHint): LspInlayHint {
  return {
    ...hint,
    tooltip: { kind: "markdown", value: hint.data.detail },
  };
}

function visit_params(
  expr: FrontExpr,
  index: BindingIndex,
  inferred: Map<EntityId, string>,
  config: InlayHintConfig,
  add: (
    offset: number,
    label: string,
    category: InlayHintCategory,
    detail: string,
    kind: 1 | 2 | undefined,
    padding_left: boolean,
    padding_right: boolean,
  ) => void,
): void {
  if (!config.types || (expr.tag !== "lam" && expr.tag !== "rec")) {
    return;
  }

  for (const param of expr.params) {
    if (param.annotation !== undefined) {
      continue;
    }

    const entity = entity_for_owner(index, param, "name", param.name);

    if (entity === undefined) {
      continue;
    }

    const type = inferred.get(entity);
    const site = site_for_owner(param, "name", param.name);

    if (type !== undefined && site !== undefined) {
      add(
        site.end,
        ": " + type,
        "types",
        "Inferred closure parameter type: " + type,
        1,
        false,
        false,
      );
    }
  }
}

function inferred_parameter_types(
  source: Source,
  index: BindingIndex,
): Map<EntityId, string> {
  const inferred = new Map<EntityId, string>();
  const conflicts = new Set<EntityId>();

  visit_statements(source.statements, () => {}, (expr) => {
    if (expr.tag !== "app" || expr.func.tag !== "var") {
      return;
    }

    const function_entity = entity_for_owner(
      index,
      expr.func,
      "name",
      expr.func.name,
    );

    if (function_entity === undefined) {
      return;
    }

    const closure = closure_for_entity(source, index, function_entity);

    if (closure === undefined) {
      return;
    }

    for (let position = 0; position < closure.params.length; position += 1) {
      const param = closure.params[position];
      const arg = expr.args[position];

      if (
        param === undefined || arg === undefined ||
        param.annotation !== undefined
      ) {
        continue;
      }

      const param_entity = entity_for_owner(index, param, "name", param.name);
      const type = infer_expr_type(arg, index);

      if (param_entity === undefined || type === undefined) {
        continue;
      }

      const previous = inferred.get(param_entity);

      if (previous !== undefined && previous !== type) {
        conflicts.add(param_entity);
      } else {
        inferred.set(param_entity, type);
      }
    }
  });

  for (const conflict of conflicts) {
    inferred.delete(conflict);
  }

  return inferred;
}

function append_ownership_hints(
  source: Source,
  index: BindingIndex,
  expr: Extract<FrontExpr, { tag: "app" }>,
  add: (
    offset: number,
    label: string,
    category: InlayHintCategory,
    detail: string,
    kind: 1 | 2 | undefined,
    padding_left: boolean,
    padding_right: boolean,
  ) => void,
): void {
  const ownership = call_ownership(source, index, expr);

  for (let position = 0; position < ownership.length; position += 1) {
    const label = ownership[position];
    const arg = expr.args[position];

    if (label === undefined || arg === undefined) {
      continue;
    }

    add(
      source_span(arg).start,
      label + " ",
      "ownership",
      "Argument ownership boundary: " + label,
      2,
      false,
      true,
    );
  }
}

function call_ownership(
  source: Source,
  index: BindingIndex,
  expr: Extract<FrontExpr, { tag: "app" }>,
): ("move" | "borrow" | "share" | undefined)[] {
  if (expr.func.tag === "field" && expr.func.object.tag === "var") {
    const operation = effect_operation(
      source,
      expr.func.object.name,
      expr.func.name,
    );

    if (operation !== undefined) {
      return operation.params.map((param) => {
        if (param.ownership === "ownership_transfer") {
          return "move";
        }

        if (param.ownership === "bounded_borrow") {
          return "borrow";
        }

        if (param.ownership === "frozen_shareable") {
          return "share";
        }

        return undefined;
      });
    }
  }

  if (expr.func.tag === "var") {
    const entity = entity_for_owner(
      index,
      expr.func,
      "name",
      expr.func.name,
    );

    if (entity !== undefined) {
      const closure = closure_for_entity(source, index, entity);

      if (closure !== undefined) {
        return closure.params.map((param, position) =>
          param_ownership(param, expr.args[position])
        );
      }
    }
  }

  return expr.args.map((arg) => param_ownership(undefined, arg));
}

function param_ownership(
  param: Param | undefined,
  arg: FrontExpr | undefined,
): "move" | "borrow" | "share" | undefined {
  if (param !== undefined) {
    if (param.is_linear) {
      return "move";
    }

    if (param.annotation !== undefined) {
      if (param.annotation.startsWith("&")) {
        return "borrow";
      }

      if (param.annotation.startsWith("#")) {
        return "share";
      }
    }
  }

  if (arg !== undefined) {
    if (arg.tag === "borrow") {
      return "borrow";
    }

    if (arg.tag === "freeze") {
      return "share";
    }

    if (arg.tag === "linear") {
      return "move";
    }
  }

  return undefined;
}

function append_specialization_hint(
  source: Source,
  index: BindingIndex,
  expr: Extract<FrontExpr, { tag: "app" }>,
  add: (
    offset: number,
    label: string,
    category: InlayHintCategory,
    detail: string,
    kind: 1 | 2 | undefined,
    padding_left: boolean,
    padding_right: boolean,
  ) => void,
): void {
  if (expr.func.tag !== "var") {
    return;
  }

  const entity = entity_for_owner(
    index,
    expr.func,
    "name",
    expr.func.name,
  );

  if (entity === undefined) {
    return;
  }

  const closure = closure_for_entity(source, index, entity);

  if (closure === undefined) {
    return;
  }

  const specializations: string[] = [];

  for (let position = 0; position < closure.params.length; position += 1) {
    const param = closure.params[position];
    const arg = expr.args[position];

    if (param !== undefined && param.is_const && arg !== undefined) {
      specializations.push(param.name + " = " + capped_format_expr(arg));
    }
  }

  if (specializations.length === 0) {
    return;
  }

  const detail = "Specialized const parameters: " +
    specializations.join(", ");
  add(
    source_span(expr).end,
    " [" + specializations.join(", ") + "]",
    "comptime",
    detail,
    undefined,
    true,
    false,
  );
}

function editor_environment(
  source: Source,
  before_offset: number,
): Map<string, EditorValue> {
  const env = new Map<string, EditorValue>();

  for (const statement of source.statements) {
    if (source_span(statement).start >= before_offset) {
      break;
    }

    if (statement.tag === "bind" || statement.tag === "assign") {
      const value = eval_editor_value(statement.value, env, 0);
      env.set(statement.name, value);
    }
  }

  return env;
}

function range_iteration_count(
  statement: Extract<Stmt, { tag: "for_range" }>,
  env: Map<string, EditorValue>,
): number | undefined {
  const start = editor_number(statement.start, env);
  const end = editor_number(statement.end, env);
  const step = editor_number(statement.step, env);

  if (start === undefined || end === undefined || step === undefined) {
    return undefined;
  }

  if (step === 0) {
    return undefined;
  }

  if (step > 0 && start >= end) {
    return 0;
  }

  if (step < 0 && start <= end) {
    return 0;
  }

  return Math.max(0, Math.ceil((end - start) / step));
}

function collection_iteration_count(
  expr: FrontExpr,
  env: Map<string, EditorValue>,
): number | undefined {
  const value = eval_editor_value(expr, env, 0).expr;

  if (value.tag === "text") {
    return new TextEncoder().encode(value.value).length;
  }

  if (value.tag === "struct_value") {
    return value.fields.length;
  }

  return undefined;
}

function editor_number(
  expr: FrontExpr,
  env: Map<string, EditorValue>,
): number | undefined {
  const value = eval_editor_value(expr, env, 0).expr;

  if (value.tag !== "num") {
    return undefined;
  }

  if (typeof value.value === "bigint") {
    const number = Number(value.value);

    if (!Number.isSafeInteger(number)) {
      return undefined;
    }

    return number;
  }

  return value.value;
}

function infer_expr_type(
  expr: FrontExpr,
  index: BindingIndex,
): string | undefined {
  if (expr.tag === "bool") {
    return "Bool";
  }

  if (expr.tag === "num") {
    if (expr.type === "i64") {
      return "I64";
    }

    return "I32";
  }

  if (expr.tag === "text") {
    return "Text";
  }

  if (expr.tag === "unit") {
    return "Unit";
  }

  if (expr.tag === "atom") {
    return "#" + expr.name;
  }

  if (expr.tag === "prim") {
    if (prim_returns_bool(expr.prim)) {
      return "Bool";
    }

    if (expr.prim.startsWith("i64.")) {
      return "I64";
    }

    return "I32";
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    const entity = entity_for_owner(index, expr, "name", expr.name);

    if (entity !== undefined) {
      return entity_type_name(index, entity);
    }
  }
  return undefined;
}

function closure_result_type(
  closure: Extract<FrontExpr, { tag: "lam" | "rec" }>,
  source: Source,
  index: BindingIndex,
): string | undefined {
  const locals = new Map<string, string>();

  for (const param of closure.params) {
    if (param.annotation !== undefined) {
      locals.set(param.name, param.annotation);
    }
  }

  if (closure.body.tag !== "block") {
    return infer_expr_type_with_locals(closure.body, source, index, locals);
  }

  let result: string | undefined;

  for (const statement of closure.body.statements) {
    if (statement.tag === "bind") {
      let type = statement.annotation;

      if (type === undefined) {
        type = infer_expr_type_with_locals(
          statement.value,
          source,
          index,
          locals,
        );
      }

      if (type !== undefined) {
        locals.set(statement.name, type);
      }

      result = type;
    } else if (statement.tag === "state_bind") {
      const type = infer_expr_type_with_locals(
        statement.value,
        source,
        index,
        locals,
      );

      if (statement.value_name !== undefined && type !== undefined) {
        locals.set(statement.value_name, type);
      }

      result = type;
    } else if (statement.tag === "expr") {
      result = infer_expr_type_with_locals(
        statement.expr,
        source,
        index,
        locals,
      );
    } else if (statement.tag === "return") {
      return infer_expr_type_with_locals(
        statement.value,
        source,
        index,
        locals,
      );
    }
  }

  return result;
}

function infer_expr_type_with_locals(
  expr: FrontExpr,
  source: Source,
  index: BindingIndex,
  locals: Map<string, string>,
): string | undefined {
  if (expr.tag === "var" || expr.tag === "linear") {
    const local = locals.get(expr.name);

    if (local !== undefined) {
      return local;
    }
  }

  if (
    expr.tag === "app" && expr.func.tag === "field" &&
    expr.func.object.tag === "var"
  ) {
    const operation = effect_operation(
      source,
      expr.func.object.name,
      expr.func.name,
    );

    if (operation !== undefined) {
      return operation.result.type_name;
    }
  }

  return infer_expr_type(expr, index);
}

function entity_type_name(
  index: BindingIndex,
  entity_id: EntityId,
): string | undefined {
  const facts = index.facts.get(entity_id);

  if (facts === undefined) {
    return undefined;
  }

  if (facts.nominal !== undefined) {
    return index.entities.get(facts.nominal)?.name;
  }

  if (facts.type !== undefined) {
    return display_front_type(facts.type);
  }

  return undefined;
}

function display_front_type(type: FrontType): string | undefined {
  if (type.tag === "unknown" || type.tag === "fn") {
    return undefined;
  }

  return front_type_name(type);
}

function closure_for_entity(
  source: Source,
  index: BindingIndex,
  entity_id: EntityId,
): Extract<FrontExpr, { tag: "lam" | "rec" }> | undefined {
  for (const statement of source.statements) {
    if (statement.tag !== "bind") {
      continue;
    }

    const entity = entity_for_owner(index, statement, "name", statement.name);

    if (
      entity === entity_id &&
      (statement.value.tag === "lam" || statement.value.tag === "rec")
    ) {
      return statement.value;
    }
  }

  return undefined;
}

function effect_operation(
  source: Source,
  effect_name: string,
  operation_name: string,
) {
  if (source.declarations === undefined) {
    return undefined;
  }

  const effect = source.declarations.find((declaration) =>
    declaration.tag === "effect" && declaration.name === effect_name
  );

  if (effect === undefined || effect.tag !== "effect") {
    return undefined;
  }

  return effect.operations.find((operation) =>
    operation.name === operation_name
  );
}

function annotation_has_effect_row(annotation: string | undefined): boolean {
  return annotation !== undefined && annotation.includes("<");
}

function site_for_owner(
  owner: object,
  slot: string,
  name: string,
): SourceSpan | undefined {
  return name_sites(owner).find((site) =>
    site.slot === slot && site.name === name
  )?.span;
}

function entity_for_owner(
  index: BindingIndex,
  owner: object,
  slot: string,
  name: string,
): EntityId | undefined {
  const site = site_for_owner(owner, slot, name);

  if (site === undefined) {
    return undefined;
  }

  return index.occurrence_at(site.start)?.entity;
}

function visit_statements(
  statements: Stmt[],
  statement_visitor: (statement: Stmt) => void,
  expression_visitor: (expr: FrontExpr) => void,
): void {
  for (const statement of statements) {
    statement_visitor(statement);

    if (statement.tag === "bind" || statement.tag === "assign") {
      visit_expr(statement.value, statement_visitor, expression_visitor);
    } else if (
      statement.tag === "state_bind" || statement.tag === "bind_pattern" ||
      statement.tag === "resume_dup"
    ) {
      visit_expr(statement.value, statement_visitor, expression_visitor);
    } else if (statement.tag === "index_assign") {
      visit_expr(statement.index, statement_visitor, expression_visitor);
      visit_expr(statement.value, statement_visitor, expression_visitor);
    } else if (statement.tag === "expr") {
      visit_expr(statement.expr, statement_visitor, expression_visitor);
    } else if (statement.tag === "return") {
      visit_expr(statement.value, statement_visitor, expression_visitor);
    } else if (statement.tag === "if_stmt") {
      visit_expr(statement.cond, statement_visitor, expression_visitor);
      visit_statements(statement.body, statement_visitor, expression_visitor);
    } else if (statement.tag === "if_let_stmt") {
      visit_expr(statement.target, statement_visitor, expression_visitor);
      visit_statements(statement.body, statement_visitor, expression_visitor);
    } else if (statement.tag === "for_range") {
      visit_expr(statement.start, statement_visitor, expression_visitor);
      visit_expr(statement.end, statement_visitor, expression_visitor);
      visit_expr(statement.step, statement_visitor, expression_visitor);
      visit_statements(statement.body, statement_visitor, expression_visitor);
    } else if (statement.tag === "for_collection") {
      visit_expr(statement.collection, statement_visitor, expression_visitor);
      visit_statements(statement.body, statement_visitor, expression_visitor);
    } else if (statement.tag === "type_check") {
      visit_expr(statement.target, statement_visitor, expression_visitor);
    } else if (statement.tag === "break" && statement.value !== undefined) {
      visit_expr(statement.value, statement_visitor, expression_visitor);
    }
  }
}

function visit_expr(
  expr: FrontExpr,
  statement_visitor: (statement: Stmt) => void,
  expression_visitor: (expr: FrontExpr) => void,
): void {
  expression_visitor(expr);

  if (expr.tag === "block") {
    visit_statements(expr.statements, statement_visitor, expression_visitor);
    return;
  }

  if (expr.tag === "loop") {
    visit_statements(expr.body, statement_visitor, expression_visitor);
    return;
  }

  if (expr.tag === "lam" || expr.tag === "rec" || expr.tag === "scratch") {
    visit_expr(expr.body, statement_visitor, expression_visitor);
    return;
  }

  if (expr.tag === "prim") {
    visit_expr(expr.left, statement_visitor, expression_visitor);
    visit_expr(expr.right, statement_visitor, expression_visitor);
    return;
  }

  if (expr.tag === "app") {
    visit_expr(expr.func, statement_visitor, expression_visitor);

    for (const arg of expr.args) {
      visit_expr(arg, statement_visitor, expression_visitor);
    }

    return;
  }

  if (expr.tag === "comptime" || expr.tag === "captured") {
    visit_expr(expr.expr, statement_visitor, expression_visitor);
    return;
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    visit_expr(expr.value, statement_visitor, expression_visitor);
    return;
  }

  if (expr.tag === "field") {
    visit_expr(expr.object, statement_visitor, expression_visitor);
    return;
  }

  if (expr.tag === "index") {
    visit_expr(expr.object, statement_visitor, expression_visitor);
    visit_expr(expr.index, statement_visitor, expression_visitor);
    return;
  }

  if (expr.tag === "if") {
    visit_expr(expr.cond, statement_visitor, expression_visitor);
    visit_expr(expr.then_branch, statement_visitor, expression_visitor);
    visit_expr(expr.else_branch, statement_visitor, expression_visitor);
    return;
  }

  if (expr.tag === "if_let") {
    visit_expr(expr.target, statement_visitor, expression_visitor);
    visit_expr(expr.then_branch, statement_visitor, expression_visitor);
    visit_expr(expr.else_branch, statement_visitor, expression_visitor);
    return;
  }

  if (expr.tag === "with" || expr.tag === "struct_update") {
    visit_expr(expr.base, statement_visitor, expression_visitor);

    for (const field of expr.fields) {
      visit_expr(field.value, statement_visitor, expression_visitor);
    }

    return;
  }

  if (expr.tag === "struct_value") {
    visit_expr(expr.type_expr, statement_visitor, expression_visitor);

    for (const field of expr.fields) {
      visit_expr(field.value, statement_visitor, expression_visitor);
    }

    return;
  }

  if (expr.tag === "union_case") {
    if (expr.type_expr !== undefined) {
      visit_expr(expr.type_expr, statement_visitor, expression_visitor);
    }

    if (expr.value !== undefined) {
      visit_expr(expr.value, statement_visitor, expression_visitor);
    }

    return;
  }

  if (expr.tag === "try_with") {
    visit_expr(expr.body, statement_visitor, expression_visitor);
    visit_expr(expr.handler, statement_visitor, expression_visitor);
    return;
  }

  if (expr.tag === "is") {
    visit_expr(expr.value, statement_visitor, expression_visitor);
    return;
  }

  if (expr.tag === "handler") {
    for (const state of expr.state) {
      visit_expr(state.value, statement_visitor, expression_visitor);
    }

    for (const clause of expr.clauses) {
      visit_expr(clause.body, statement_visitor, expression_visitor);
    }

    visit_expr(
      expr.return_clause.body,
      statement_visitor,
      expression_visitor,
    );
  }
}
