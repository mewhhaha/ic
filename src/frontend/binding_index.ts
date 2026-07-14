import type {
  ArrayLengthExpr,
  Declaration,
  EffectRowExpr,
  FrontExpr,
  FrontType,
  Param,
  Pattern,
  Source,
  Stmt,
  TypeExpr,
} from "./ast.ts";
import { expect } from "../expect.ts";
import { name_sites, type NameSite } from "./name_site.ts";
import type { ParseSourceResult } from "./parser.ts";
import { has_source_span, source_span, type SourceSpan } from "./syntax.ts";
import { source_facts, type SourceFacts } from "./source_facts.ts";
import { front_type_from_type_name, is_builtin_type_name } from "./types.ts";

export type EntityId = string;
export type ScopeId = string;
export type OccurrenceId = string;
export type BindingEntityKind =
  | "value"
  | "const"
  | "parameter"
  | "type_parameter"
  | "type"
  | "effect"
  | "record"
  | "field"
  | "case"
  | "operation"
  | "module_parameter";
export type BindingRole =
  | "definition"
  | "shadow"
  | "reference"
  | "consume"
  | "member";
export type UnresolvedReason =
  | "builtin"
  | "dynamic_member"
  | "unknown"
  | "recovery";

export type BindingEntity = {
  id: EntityId;
  name: string;
  kind: BindingEntityKind;
  generation: number;
  linear: boolean;
  readonly: boolean;
  scope: ScopeId;
  owner: EntityId | undefined;
  definition: OccurrenceId | undefined;
};
export type BindingScope = {
  id: ScopeId;
  parent: ScopeId | undefined;
  entities: Map<string, EntityId>;
  start: number | undefined;
  end: number | undefined;
};
export type BindingOccurrence = {
  id: OccurrenceId;
  name: string;
  span: SourceSpan;
  role: BindingRole;
  entity: EntityId | undefined;
  unresolved: UnresolvedReason | undefined;
  scope: ScopeId;
};
export type EntityFacts = {
  type: FrontType | undefined;
  nominal: EntityId | undefined;
  const_source: object | undefined;
  editor_type: string | undefined;
};
export type BindingIndex = {
  version: number;
  entities: Map<EntityId, BindingEntity>;
  scopes: Map<ScopeId, BindingScope>;
  occurrences: Map<OccurrenceId, BindingOccurrence>;
  references: Map<EntityId, OccurrenceId[]>;
  members: Map<EntityId, Map<string, EntityId>>;
  facts: Map<EntityId, EntityFacts>;
  occurrence_at(offset: number): BindingOccurrence | undefined;
  visible_at(offset: number): BindingEntity[];
  member_lookup(owner: EntityId, name: string): BindingEntity | undefined;
  dump(): string;
};

type State = {
  index: BindingIndex;
  facts: SourceFacts;
  next_entity: number;
  next_scope: number;
  next_occurrence: number;
  generations: Map<string, number>;
  sites: Set<NameSite>;
};

export function build_binding_index(
  parsed: ParseSourceResult,
  version = 0,
): BindingIndex {
  const root: BindingScope = {
    id: "scope:0",
    parent: undefined,
    entities: new Map(),
    start: 0,
    end: parsed.syntax.text.length,
  };
  const index: BindingIndex = {
    version,
    entities: new Map(),
    scopes: new Map([[root.id, root]]),
    occurrences: new Map(),
    references: new Map(),
    members: new Map(),
    facts: new Map(),
    occurrence_at(offset) {
      return [...this.occurrences.values()].find((occurrence) =>
        occurrence.span.start <= offset && offset < occurrence.span.end
      );
    },
    visible_at(offset) {
      const visible: BindingEntity[] = [];
      const names = new Set<string>();
      let innermost: ScopeId | undefined;
      let innermost_depth = -1;
      for (const candidate of this.scopes.values()) {
        if (candidate.start === undefined || candidate.end === undefined) {
          continue;
        }
        if (offset < candidate.start || offset > candidate.end) continue;
        let depth = 0;
        let parent = candidate.parent;
        while (parent !== undefined) {
          const parent_scope = this.scopes.get(parent);
          expect(parent_scope, "Missing binding index scope: " + parent);
          depth += 1;
          parent = parent_scope.parent;
        }
        if (depth > innermost_depth) {
          innermost = candidate.id;
          innermost_depth = depth;
        }
      }
      if (innermost === undefined) return visible;
      let scope: ScopeId | undefined = innermost;
      while (scope !== undefined) {
        const current = this.scopes.get(scope);
        expect(current, "Missing binding index scope: " + scope);
        const candidates = [...this.entities.values()].filter((entity) =>
          entity.scope === scope && entity.owner === undefined
        ).sort((left, right) => left.generation - right.generation);
        const current_generation = new Map<string, BindingEntity>();

        for (const entity of candidates) {
          let definition: BindingOccurrence | undefined;

          if (entity.definition !== undefined) {
            definition = this.occurrences.get(entity.definition);
          }

          if (definition !== undefined && definition.span.start <= offset) {
            current_generation.set(entity.name, entity);
          }
        }

        for (const [name, entity] of current_generation) {
          if (!names.has(name)) {
            visible.push(entity);
            names.add(name);
          }
        }

        scope = current.parent;
      }
      return visible;
    },
    member_lookup(owner, name) {
      const members = this.members.get(owner);
      if (members === undefined) return undefined;
      const member = members.get(name);
      if (member === undefined) return undefined;
      return this.entities.get(member);
    },
    dump() {
      return [...this.occurrences.values()].map((occurrence) =>
        occurrence.name + " " + occurrence.role + " " +
        (occurrence.entity || occurrence.unresolved || "unknown")
      ).join("\n");
    },
  };
  const state: State = {
    index,
    facts: source_facts(parsed.source),
    next_entity: 0,
    next_scope: 1,
    next_occurrence: 0,
    generations: new Map(),
    sites: new Set(),
  };
  predeclare(parsed.source, root.id, state);
  visit_statements(parsed.source.statements, root.id, state);
  mark_unvisited_sites(
    parsed.source,
    root.id,
    parsed.recovery_intervals,
    state,
  );
  return index;
}

function predeclare(source: Source, scope: ScopeId, state: State): void {
  let params: Param[] = [];
  if (source.module !== undefined) params = source.module.params;
  for (const param of params) {
    define(
      param,
      "name",
      undefined,
      param.name,
      "module_parameter",
      "definition",
      scope,
      state,
    );
    visit_name_slot(param, "annotation", scope, state);
    visit_type(param.type_annotation, scope, state);
  }
  let declarations: Declaration[] = [];
  if (source.declarations !== undefined) declarations = source.declarations;
  for (const declaration of declarations) {
    let kind: BindingEntityKind = "record";
    if (declaration.tag === "type") kind = "type";
    if (declaration.tag === "effect") kind = "effect";
    const owner = define(
      declaration,
      "name",
      undefined,
      declaration.name,
      kind,
      "definition",
      scope,
      state,
    );
    if (declaration.tag === "type") {
      const declaration_scope = child_scope(scope, state, declaration);
      for (
        let index = 0;
        index < declaration.params.length;
        index += 1
      ) {
        const param = declaration.params[index];
        expect(param !== undefined, "Missing type parameter");
        define(
          declaration,
          "params",
          index,
          param,
          "type_parameter",
          "definition",
          declaration_scope,
          state,
        );
      }
      if (declaration.body.tag === "alias") {
        visit_name_slot(
          declaration.body,
          "type_name",
          declaration_scope,
          state,
        );
      }
      if (declaration.body.tag === "product") {
        for (const field of declaration.body.fields) {
          define(
            field,
            "name",
            undefined,
            field.name,
            "field",
            "definition",
            scope,
            state,
            owner,
          );
          visit_name_slot(field, "type_name", declaration_scope, state);
          visit_type(field.set_member, declaration_scope, state);
        }
      }
      if (declaration.body.tag === "sum") {
        for (const field of declaration.body.cases) {
          define(
            field,
            "name",
            undefined,
            field.name,
            "case",
            "definition",
            scope,
            state,
            owner,
          );
          visit_name_slot(field, "type_name", declaration_scope, state);
          visit_type(field.set_member, declaration_scope, state);
        }
      }
    }
    if (declaration.tag === "record") {
      for (const field of declaration.fields) {
        define(
          field,
          "name",
          undefined,
          field.name,
          "field",
          "definition",
          scope,
          state,
          owner,
        );
        visit_name_slot(field, "type_name", scope, state);
        visit_type(field.set_member, scope, state);
      }
    }
    if (declaration.tag === "effect") {
      for (const operation of declaration.operations) {
        define(
          operation,
          "name",
          undefined,
          operation.name,
          "operation",
          "definition",
          scope,
          state,
          owner,
        );
        for (const param of operation.params) {
          visit_name_slot(param, "type_name", scope, state);
        }
        visit_name_slot(operation.result, "type_name", scope, state);
      }
    }
  }
}

function visit_statements(
  statements: Stmt[],
  scope: ScopeId,
  state: State,
): void {
  for (const statement of statements) {
    if (statement.tag === "import") {
      define(
        statement,
        "name",
        undefined,
        statement.name,
        "const",
        "definition",
        scope,
        state,
      );
      continue;
    }
    if (statement.tag === "host_import") {
      define(
        statement.value,
        "name",
        undefined,
        statement.value.name,
        "const",
        "definition",
        scope,
        state,
      );
      continue;
    }
    if (statement.tag === "bind") {
      let entity: EntityId | undefined;
      let kind: BindingEntityKind = "value";
      if (statement.kind === "const") kind = "const";
      if (statement.is_recursive) {
        if (
          statement.pattern !== undefined &&
          statement.pattern.tag !== "binding"
        ) {
          visit_pattern(statement.pattern, kind, scope, state);
        } else {
          entity = define(
            statement,
            "name",
            undefined,
            statement.name,
            kind,
            "definition",
            scope,
            state,
          );

          if (statement.pattern?.tag === "binding") {
            mark_name_slot_visited(statement.pattern, "name", state);
          }
        }
      }
      visit_expr(statement.value, scope, state);
      visit_name_slot(statement, "annotation", scope, state);
      visit_type(statement.type_annotation, scope, state);
      if (
        statement.pattern !== undefined &&
        statement.pattern.tag !== "binding" && !statement.is_recursive
      ) {
        visit_pattern(statement.pattern, kind, scope, state);
      } else if (!statement.is_recursive) {
        let kind: BindingEntityKind = "value";
        if (statement.kind === "const") kind = "const";
        define(
          statement,
          "name",
          undefined,
          statement.name,
          kind,
          "definition",
          scope,
          state,
        );

        if (statement.pattern?.tag === "binding") {
          mark_name_slot_visited(statement.pattern, "name", state);
        }
      }
      if (entity !== undefined) continue;
      continue;
    }
    if (statement.tag === "state_bind") {
      visit_expr(statement.value, scope, state);
      if (statement.value_name !== undefined) {
        define(
          statement,
          "value_name",
          undefined,
          statement.value_name,
          "value",
          "definition",
          scope,
          state,
        );
      }
      continue;
    }
    if (statement.tag === "bind_pattern") {
      visit_expr(statement.value, scope, state);
      let kind: BindingEntityKind = "value";
      if (statement.kind === "const") kind = "const";
      for (const item of statement.items) {
        define(
          item,
          "name",
          undefined,
          item.name,
          kind,
          "definition",
          scope,
          state,
        );
      }
      continue;
    }
    if (statement.tag === "resume_dup") {
      visit_expr(statement.value, scope, state);
      define(
        statement,
        "left",
        undefined,
        statement.left,
        "value",
        "definition",
        scope,
        state,
      );
      define(
        statement,
        "right",
        undefined,
        statement.right,
        "value",
        "definition",
        scope,
        state,
      );
      continue;
    }
    if (statement.tag === "assign") {
      visit_expr(statement.value, scope, state);
      define(
        statement,
        "name",
        undefined,
        statement.name,
        "value",
        "shadow",
        scope,
        state,
      );
      continue;
    }
    if (statement.tag === "index_assign") {
      reference(
        statement,
        "name",
        undefined,
        statement.name,
        "reference",
        scope,
        state,
      );
      visit_expr(statement.index, scope, state);
      visit_expr(statement.value, scope, state);
      continue;
    }
    if (statement.tag === "expr") {
      visit_expr(statement.expr, scope, state);
      continue;
    }
    if (statement.tag === "return") {
      visit_expr(statement.value, scope, state);
      continue;
    }
    if (statement.tag === "if_stmt") {
      visit_expr(statement.cond, scope, state);
      visit_statements(
        statement.body,
        child_scope(scope, state, statement),
        state,
      );
      continue;
    }
    if (statement.tag === "if_let_stmt") {
      visit_expr(statement.target, scope, state);
      case_reference(statement, "case_name", statement.case_name, scope, state);
      const branch = child_scope(scope, state, statement);
      if (statement.value_name !== undefined) {
        define(
          statement,
          "value_name",
          undefined,
          statement.value_name,
          "value",
          "definition",
          branch,
          state,
        );
      }
      visit_statements(statement.body, branch, state);
      continue;
    }
    if (statement.tag === "for_range") {
      visit_expr(statement.start, scope, state);
      visit_expr(statement.end, scope, state);
      visit_expr(statement.step, scope, state);
      const body = child_scope(scope, state, statement);
      define(
        statement,
        "index",
        undefined,
        statement.index,
        "value",
        "definition",
        body,
        state,
      );
      visit_statements(statement.body, body, state);
      continue;
    }
    if (statement.tag === "for_collection") {
      visit_expr(statement.collection, scope, state);
      const body = child_scope(scope, state, statement);
      if (statement.index !== undefined) {
        define(
          statement,
          "index",
          undefined,
          statement.index,
          "value",
          "definition",
          body,
          state,
        );
      }
      define(
        statement,
        "item",
        undefined,
        statement.item,
        "value",
        "definition",
        body,
        state,
      );
      visit_statements(statement.body, body, state);
      continue;
    }
    if (statement.tag === "type_check") {
      visit_expr(statement.target, scope, state);
      const owner = nominal_owner(statement.target, scope, state);

      for (const field of statement.pattern.fields) {
        if (owner !== undefined) {
          member_reference(field, field.name, owner, scope, state);
        } else {
          pattern_member_reference(
            field,
            field.name,
            statement.pattern.kind,
            scope,
            state,
          );
        }

        visit_name_slot(field, "type_name", scope, state);
        visit_type(field.set_member, scope, state);
      }
      continue;
    }
    if (statement.tag === "break") {
      if (statement.value !== undefined) {
        visit_expr(statement.value, scope, state);
      }
      continue;
    }
  }
}

function visit_expr(expr: FrontExpr, scope: ScopeId, state: State): void {
  if (expr.tag === "var" || expr.tag === "linear") {
    let role: "reference" | "consume" = "reference";
    if (expr.tag === "linear") role = "consume";
    reference(
      expr,
      "name",
      undefined,
      expr.name,
      role,
      scope,
      state,
    );
    return;
  }
  if (expr.tag === "type_name") {
    reference(expr, "name", undefined, expr.name, "reference", scope, state);
    return;
  }
  if (
    expr.tag === "atom" || expr.tag === "bool" || expr.tag === "num" ||
    expr.tag === "unit" || expr.tag === "text" || expr.tag === "unsupported"
  ) return;
  if (expr.tag === "field") {
    visit_expr(expr.object, scope, state);
    const owner = nominal_owner(expr.object, scope, state);
    if (owner === undefined) {
      unresolved(
        expr,
        "name",
        undefined,
        expr.name,
        "member",
        "dynamic_member",
        scope,
        state,
      );
    } else member_reference(expr, expr.name, owner, scope, state);
    return;
  }
  if (expr.tag === "lam" || expr.tag === "rec") {
    const body = child_scope(scope, state, expr);
    for (const param of expr.params) {
      define(
        param,
        "name",
        undefined,
        param.name,
        "parameter",
        "definition",
        body,
        state,
      );
      visit_name_slot(param, "annotation", body, state);
      visit_type(param.type_annotation, body, state);
    }
    visit_expr(expr.body, body, state);
    return;
  }
  if (expr.tag === "prim") {
    visit_expr(expr.left, scope, state);
    visit_expr(expr.right, scope, state);
    return;
  }
  if (expr.tag === "app") {
    visit_expr(expr.func, scope, state);

    if (expr.arg !== undefined) {
      visit_expr(expr.arg, scope, state);
    } else {
      for (const arg of expr.args) visit_expr(arg, scope, state);
    }
    return;
  }
  if (expr.tag === "product") {
    const owner = nominal_owner(expr, scope, state);

    for (const entry of expr.entries) {
      if (entry.label !== undefined) {
        if (owner === undefined) {
          unresolved(
            entry,
            "name",
            undefined,
            entry.label,
            "member",
            "dynamic_member",
            scope,
            state,
          );
        } else {
          member_reference(entry, entry.label, owner, scope, state);
        }
      }

      visit_expr(entry.value, scope, state);
    }
    return;
  }
  if (expr.tag === "array") {
    for (const item of expr.items) {
      visit_expr(item, scope, state);
    }

    if (expr.rest !== undefined) {
      visit_expr(expr.rest, scope, state);
    }
    return;
  }
  if (expr.tag === "array_repeat") {
    visit_expr(expr.value, scope, state);
    visit_expr(expr.length, scope, state);
    return;
  }
  if (expr.tag === "import") {
    return;
  }
  if (expr.tag === "as") {
    visit_expr(expr.value, scope, state);
    visit_type(expr.type_expr, scope, state);
    return;
  }
  if (expr.tag === "match") {
    visit_expr(expr.target, scope, state);

    for (const arm of expr.arms) {
      const arm_scope = child_scope(scope, state, arm.body);
      visit_pattern(arm.pattern, "value", arm_scope, state);

      if (arm.guard !== undefined) {
        visit_expr(arm.guard, arm_scope, state);
      }

      visit_expr(arm.body, arm_scope, state);
    }
    return;
  }
  if (expr.tag === "block") {
    visit_statements(
      expr.statements,
      child_scope(scope, state, expr),
      state,
    );
    return;
  }
  if (expr.tag === "if") {
    visit_expr(expr.cond, scope, state);
    visit_expr(
      expr.then_branch,
      child_scope(scope, state, expr.then_branch),
      state,
    );
    visit_expr(
      expr.else_branch,
      child_scope(scope, state, expr.else_branch),
      state,
    );
    return;
  }
  if (expr.tag === "if_let") {
    visit_expr(expr.target, scope, state);
    case_reference(expr, "case_name", expr.case_name, scope, state);
    const branch = child_scope(scope, state, expr.then_branch);
    if (expr.value_name !== undefined) {
      define(
        expr,
        "value_name",
        undefined,
        expr.value_name,
        "value",
        "definition",
        branch,
        state,
      );
    }
    visit_expr(expr.then_branch, branch, state);
    visit_expr(
      expr.else_branch,
      child_scope(scope, state, expr.else_branch),
      state,
    );
    return;
  }
  if (expr.tag === "comptime") {
    visit_expr(expr.expr, scope, state);
    return;
  }
  if (expr.tag === "borrow" || expr.tag === "freeze") {
    visit_expr(expr.value, scope, state);
    return;
  }
  if (expr.tag === "scratch") {
    visit_expr(expr.body, child_scope(scope, state, expr.body), state);
    return;
  }
  if (expr.tag === "loop") {
    visit_statements(expr.body, child_scope(scope, state, expr), state);
    return;
  }
  if (expr.tag === "captured") {
    visit_expr(expr.expr, scope, state);
    return;
  }
  if (expr.tag === "handler") {
    reference(
      expr,
      "effect",
      undefined,
      expr.effect,
      "reference",
      scope,
      state,
    );
    const handler_scope = child_scope(scope, state, expr);
    for (const entry of expr.state) {
      visit_expr(entry.value, handler_scope, state);
      visit_name_slot(entry, "annotation", handler_scope, state);
      define(
        entry,
        "name",
        undefined,
        entry.name,
        "value",
        "definition",
        handler_scope,
        state,
      );
    }
    for (const clause of expr.clauses) {
      const clause_scope = child_scope(handler_scope, state, clause.body);
      member_or_unknown(
        clause,
        "name",
        clause.name,
        expr.effect,
        clause_scope,
        state,
      );
      for (const param of clause.params) {
        define(
          param,
          "name",
          undefined,
          param.name,
          "parameter",
          "definition",
          clause_scope,
          state,
        );
        visit_name_slot(param, "annotation", clause_scope, state);
        visit_type(param.type_annotation, clause_scope, state);
      }
      visit_expr(clause.body, clause_scope, state);
    }
    const return_scope = child_scope(
      handler_scope,
      state,
      expr.return_clause.body,
    );
    define(
      expr.return_clause.param,
      "name",
      undefined,
      expr.return_clause.param.name,
      "parameter",
      "definition",
      return_scope,
      state,
    );
    visit_name_slot(
      expr.return_clause.param,
      "annotation",
      return_scope,
      state,
    );
    visit_type(expr.return_clause.param.type_annotation, return_scope, state);
    visit_expr(expr.return_clause.body, return_scope, state);
    return;
  }
  if (expr.tag === "try_with") {
    visit_expr(expr.body, scope, state);
    visit_expr(expr.handler, scope, state);
    return;
  }
  if (expr.tag === "with" || expr.tag === "struct_update") {
    visit_expr(expr.base, scope, state);
    for (const field of expr.fields) {
      member_from_receiver(field, expr.base, field.name, scope, state);
      visit_expr(field.value, scope, state);
    }
    return;
  }
  if (expr.tag === "struct_value") {
    visit_expr(expr.type_expr, scope, state);
    let owner = nominal_owner(expr, scope, state);

    if (owner === undefined) {
      owner = nominal_owner(expr.type_expr, scope, state);
    }

    for (const field of expr.fields) {
      if (owner === undefined) {
        unresolved(
          field,
          "name",
          undefined,
          field.name,
          "member",
          "dynamic_member",
          scope,
          state,
        );
      } else member_reference(field, field.name, owner, scope, state);
      visit_expr(field.value, scope, state);
    }
    return;
  }
  if (expr.tag === "set_type") {
    visit_type(expr.type_expr, scope, state);
    return;
  }
  if (expr.tag === "struct_type") {
    for (const field of expr.fields) {
      visit_name_slot(field, "type_name", scope, state);
      visit_type(field.set_member, scope, state);
    }
    return;
  }
  if (expr.tag === "union_type") {
    for (const field of expr.cases) {
      visit_name_slot(field, "type_name", scope, state);
      visit_type(field.set_member, scope, state);
    }
    return;
  }
  if (expr.tag === "union_case") {
    case_reference(expr, "name", expr.name, scope, state);
    if (expr.value !== undefined) visit_expr(expr.value, scope, state);
    if (expr.type_expr !== undefined) visit_expr(expr.type_expr, scope, state);
    return;
  }
  if (expr.tag === "index") {
    visit_expr(expr.object, scope, state);
    visit_expr(expr.index, scope, state);
    return;
  }
  if (expr.tag === "is") {
    visit_expr(expr.value, scope, state);
    visit_type(expr.type_expr, scope, state);
    return;
  }
}

function visit_pattern(
  pattern: Pattern,
  default_kind: "value" | "const",
  scope: ScopeId,
  state: State,
): void {
  if (pattern.tag === "binding") {
    let kind = default_kind;

    if (pattern.mode === "const") {
      kind = "const";
    }

    define(
      pattern,
      "name",
      undefined,
      pattern.name,
      kind,
      "definition",
      scope,
      state,
    );
    visit_name_slot(pattern, "annotation", scope, state);
    visit_type(pattern.type_annotation, scope, state);
    return;
  }

  if (
    pattern.tag === "wildcard" || pattern.tag === "unit" ||
    pattern.tag === "literal"
  ) {
    return;
  }

  if (pattern.tag === "union_case") {
    case_reference(pattern, "name", pattern.name, scope, state);

    if (pattern.value !== undefined) {
      visit_pattern(pattern.value, default_kind, scope, state);
    }
    return;
  }

  if (pattern.tag === "product") {
    for (const entry of pattern.entries) {
      visit_pattern(entry.pattern, default_kind, scope, state);
    }
    return;
  }

  if (pattern.tag === "record") {
    for (const field of pattern.fields) {
      visit_pattern(field.pattern, default_kind, scope, state);
    }

    if (pattern.rest !== undefined) {
      visit_pattern(pattern.rest, default_kind, scope, state);
    }
    return;
  }

  for (const item of pattern.items) {
    visit_pattern(item, default_kind, scope, state);
  }

  if (pattern.rest !== undefined) {
    visit_pattern(pattern.rest, default_kind, scope, state);
  }
}

function visit_type(
  type: TypeExpr | undefined,
  scope: ScopeId,
  state: State,
): void {
  if (type === undefined) {
    return;
  }

  if (type.tag === "name") {
    reference(type, "name", undefined, type.name, "reference", scope, state);
    return;
  }

  if (type.tag === "atom") {
    unresolved(
      type,
      "name",
      undefined,
      type.name,
      "reference",
      "unknown",
      scope,
      state,
    );
    return;
  }

  if (type.tag === "top" || type.tag === "never") {
    return;
  }

  if (type.tag === "frozen" || type.tag === "borrow") {
    visit_type(type.value, scope, state);
    return;
  }

  if (
    type.tag === "union" || type.tag === "intersection" ||
    type.tag === "difference"
  ) {
    visit_type(type.left, scope, state);
    visit_type(type.right, scope, state);
    return;
  }

  if (type.tag === "apply") {
    visit_type(type.func, scope, state);
    visit_type(type.arg, scope, state);
    return;
  }

  if (type.tag === "tuple") {
    for (const item of type.items) {
      visit_type(item, scope, state);
    }

    return;
  }

  if (type.tag === "product") {
    for (const entry of type.entries) {
      visit_type(entry.type_expr, scope, state);
    }

    return;
  }

  if (type.tag === "array") {
    visit_type(type.element, scope, state);
    visit_array_length(type.length, scope, state);
    return;
  }

  if (type.tag === "arrow") {
    visit_type(type.param, scope, state);

    if (type.effects !== undefined) {
      visit_effect_row(type.effects, scope, state);
    }

    visit_type(type.result, scope, state);
  }
}

function visit_array_length(
  length: ArrayLengthExpr,
  scope: ScopeId,
  state: State,
): void {
  if (length.tag === "number") {
    return;
  }

  if (length.tag === "name") {
    reference(
      length,
      "name",
      undefined,
      length.name,
      "reference",
      scope,
      state,
    );
    return;
  }

  visit_array_length(length.left, scope, state);
  visit_array_length(length.right, scope, state);
}

function visit_effect_row(
  row: EffectRowExpr,
  scope: ScopeId,
  state: State,
): void {
  if (row.tag === "family" || row.tag === "variable") {
    reference(row, "name", undefined, row.name, "reference", scope, state);
    return;
  }

  if (row.tag === "operation") {
    reference(
      row,
      "effect",
      undefined,
      row.effect,
      "reference",
      scope,
      state,
    );
    member_or_unknown(
      row,
      "operation",
      row.operation,
      row.effect,
      scope,
      state,
    );
    return;
  }

  if (row.tag === "group") {
    visit_effect_row(row.value, scope, state);
    return;
  }

  visit_effect_row(row.left, scope, state);
  visit_effect_row(row.right, scope, state);
}

function define(
  owner: object,
  slot: string,
  index: number | undefined,
  name: string,
  kind: BindingEntityKind,
  role: "definition" | "shadow",
  scope: ScopeId,
  state: State,
  parent: EntityId | undefined = undefined,
): EntityId {
  let key = scope + ":" + name;

  if (parent !== undefined) {
    key = parent + ":" + name;
  }

  let generation = 0;
  const previous_generation = state.generations.get(key);

  if (previous_generation !== undefined) {
    generation = previous_generation;
  }

  state.generations.set(key, generation + 1);
  const id = "entity:" + state.next_entity++;
  let linear = false;
  let readonly = kind === "const";
  const owner_record = owner as Record<string, unknown>;

  if (owner_record.is_linear === true || owner_record.tag === "resume_dup") {
    linear = true;
  }

  if (owner_record.is_const === true) {
    readonly = true;
  }

  const occurrence = occurrence_for(
    owner,
    slot,
    index,
    name,
    role,
    id,
    undefined,
    scope,
    state,
  );
  state.index.entities.set(id, {
    id,
    name,
    kind,
    generation,
    linear,
    readonly,
    scope,
    owner: parent,
    definition: occurrence,
  });
  let type: FrontType | undefined;
  let nominal: EntityId | undefined;
  let const_source: object | undefined;
  let editor_type: string | undefined;
  const definition_types = state.facts.definition_type_of.get(owner);

  if (definition_types !== undefined) {
    editor_type = definition_types.get(slot)?.name;
  }

  if (
    "value" in owner && owner.value !== null && typeof owner.value === "object"
  ) {
    type = state.facts.type_of.get(owner.value);
    const value_editor_type = state.facts.editor_type_of.get(owner.value);

    if (editor_type === undefined && value_editor_type !== undefined) {
      editor_type = value_editor_type.name;
    }
    const nominal_name = state.facts.nominal_of.get(owner.value);
    if (nominal_name !== undefined) {
      nominal = lookup(scope, nominal_name, state);
    }
    if (state.facts.const_source_of.has(owner)) const_source = owner.value;
  } else if (
    "annotation" in owner && typeof owner.annotation === "string"
  ) {
    type = front_type_from_type_name(owner.annotation);
  }
  state.index.facts.set(id, { type, nominal, const_source, editor_type });
  if (parent === undefined) {
    const binding_scope = state.index.scopes.get(scope);
    expect(binding_scope, "Missing binding index scope: " + scope);
    binding_scope.entities.set(name, id);
  } else {
    let members = state.index.members.get(parent);
    if (members === undefined) {
      members = new Map();
      state.index.members.set(parent, members);
    }
    members.set(name, id);
  }
  return id;
}
function reference(
  owner: object,
  slot: string,
  index: number | undefined,
  name: string,
  role: "reference" | "consume",
  scope: ScopeId,
  state: State,
): void {
  const entity = lookup(scope, name, state);
  if (entity === undefined) {
    let reason: UnresolvedReason = "unknown";
    if (is_builtin(name)) reason = "builtin";
    occurrence_for(
      owner,
      slot,
      index,
      name,
      role,
      undefined,
      reason,
      scope,
      state,
    );
    return;
  }
  occurrence_for(
    owner,
    slot,
    index,
    name,
    role,
    entity,
    undefined,
    scope,
    state,
  );
}

function visit_name_slot(
  owner: object,
  slot: string,
  scope: ScopeId,
  state: State,
): void {
  for (const site of name_sites(owner)) {
    if (site.slot === slot && !state.sites.has(site)) {
      reference(
        owner,
        slot,
        site.index,
        site.name,
        "reference",
        scope,
        state,
      );
    }
  }
}

function mark_name_slot_visited(
  owner: object,
  slot: string,
  state: State,
): void {
  for (const site of name_sites(owner)) {
    if (site.slot === slot) {
      state.sites.add(site);
    }
  }
}

function member_reference(
  owner: object,
  name: string,
  parent: EntityId,
  scope: ScopeId,
  state: State,
): void {
  const members = state.index.members.get(parent);
  let entity: EntityId | undefined;
  if (members !== undefined) entity = members.get(name);
  if (entity === undefined) {
    occurrence_for(
      owner,
      "name",
      undefined,
      name,
      "member",
      undefined,
      "unknown",
      scope,
      state,
    );
    return;
  }
  occurrence_for(
    owner,
    "name",
    undefined,
    name,
    "member",
    entity,
    undefined,
    scope,
    state,
  );
}
function case_reference(
  owner: object,
  slot: string,
  name: string,
  scope: ScopeId,
  state: State,
): void {
  unambiguous_member_reference(
    owner,
    slot,
    name,
    "case",
    scope,
    state,
  );
}

function pattern_member_reference(
  owner: object,
  name: string,
  pattern: "struct" | "union",
  scope: ScopeId,
  state: State,
): void {
  let kind: "field" | "case" = "field";

  if (pattern === "union") {
    kind = "case";
  }

  unambiguous_member_reference(
    owner,
    "name",
    name,
    kind,
    scope,
    state,
  );
}

function unambiguous_member_reference(
  owner: object,
  slot: string,
  name: string,
  kind: "field" | "case",
  scope: ScopeId,
  state: State,
): void {
  let match: EntityId | undefined;
  for (const members of state.index.members.values()) {
    const entity = members.get(name);

    if (entity !== undefined) {
      const definition = state.index.entities.get(entity);

      if (definition === undefined) {
        throw new Error("Missing member entity: " + entity);
      }

      if (definition.kind !== kind) {
        continue;
      }

      if (match !== undefined) {
        unresolved(
          owner,
          slot,
          undefined,
          name,
          "member",
          "unknown",
          scope,
          state,
        );
        return;
      }
      match = entity;
    }
  }
  if (match !== undefined) {
    occurrence_for(
      owner,
      slot,
      undefined,
      name,
      "member",
      match,
      undefined,
      scope,
      state,
    );
    return;
  }
  unresolved(owner, slot, undefined, name, "member", "unknown", scope, state);
}
function member_from_receiver(
  owner: object,
  receiver: FrontExpr,
  name: string,
  scope: ScopeId,
  state: State,
): void {
  const parent = nominal_owner(receiver, scope, state);
  if (parent === undefined) {
    unresolved(
      owner,
      "name",
      undefined,
      name,
      "member",
      "dynamic_member",
      scope,
      state,
    );
    return;
  }
  member_reference(owner, name, parent, scope, state);
}
function member_or_unknown(
  owner: object,
  slot: string,
  name: string,
  effect: string,
  scope: ScopeId,
  state: State,
): void {
  const parent = lookup(scope, effect, state);
  if (parent === undefined) {
    unresolved(owner, slot, undefined, name, "member", "unknown", scope, state);
    return;
  }
  const members = state.index.members.get(parent);
  let entity: EntityId | undefined;
  if (members !== undefined) entity = members.get(name);
  if (entity === undefined) {
    unresolved(owner, slot, undefined, name, "member", "unknown", scope, state);
    return;
  }
  occurrence_for(
    owner,
    slot,
    undefined,
    name,
    "member",
    entity,
    undefined,
    scope,
    state,
  );
}
function unresolved(
  owner: object,
  slot: string,
  index: number | undefined,
  name: string,
  role: BindingRole,
  reason: UnresolvedReason,
  scope: ScopeId,
  state: State,
): void {
  occurrence_for(
    owner,
    slot,
    index,
    name,
    role,
    undefined,
    reason,
    scope,
    state,
  );
}
function occurrence_for(
  owner: object,
  slot: string,
  index: number | undefined,
  name: string,
  role: BindingRole,
  entity: EntityId | undefined,
  unresolved_reason: UnresolvedReason | undefined,
  scope: ScopeId,
  state: State,
): OccurrenceId | undefined {
  const site = name_sites(owner).find((candidate) =>
    !state.sites.has(candidate) && candidate.slot === slot &&
    candidate.index === index && candidate.name === name
  );
  if (site === undefined) return undefined;
  state.sites.add(site);
  const id = "occurrence:" + state.next_occurrence++;
  state.index.occurrences.set(id, {
    id,
    name,
    span: site.span,
    role,
    entity,
    unresolved: unresolved_reason,
    scope,
  });
  record_scope_span(scope, site.span, state);
  if (
    entity !== undefined &&
    (role === "reference" || role === "consume" || role === "member")
  ) {
    let references = state.index.references.get(entity);

    if (references === undefined) {
      references = [];
    }

    references.push(id);
    state.index.references.set(entity, references);
  }
  return id;
}
function child_scope(
  parent: ScopeId,
  state: State,
  subject: object,
): ScopeId {
  const id = "scope:" + state.next_scope++;
  let start: number | undefined;
  let end: number | undefined;

  if (has_source_span(subject)) {
    const span = source_span(subject);
    start = span.start;
    end = span.end;
  }

  state.index.scopes.set(id, {
    id,
    parent,
    entities: new Map(),
    start,
    end,
  });
  return id;
}
function record_scope_span(
  scope: ScopeId,
  span: SourceSpan,
  state: State,
): void {
  let current: ScopeId | undefined = scope;
  while (current !== undefined) {
    const item = state.index.scopes.get(current);
    expect(item, "Missing binding index scope: " + current);
    if (item.start === undefined || span.start < item.start) {
      item.start = span.start;
    }
    if (item.end === undefined || span.end > item.end) item.end = span.end;
    current = item.parent;
  }
}
function lookup(
  scope: ScopeId,
  name: string,
  state: State,
): EntityId | undefined {
  let current: ScopeId | undefined = scope;
  while (current !== undefined) {
    const item = state.index.scopes.get(current);
    expect(item, "Missing binding index scope: " + current);
    const entity = item.entities.get(name);
    if (entity !== undefined) return entity;
    current = item.parent;
  }
  return undefined;
}
function nominal_owner(
  expr: FrontExpr,
  scope: ScopeId,
  state: State,
): EntityId | undefined {
  const fact = state.facts.nominal_of.get(expr);
  if (fact !== undefined) return lookup(scope, fact, state);
  if (expr.tag === "var") {
    const entity = lookup(scope, expr.name, state);
    if (entity !== undefined) {
      const definition = state.index.entities.get(entity);
      if (definition !== undefined) {
        const facts = state.index.facts.get(entity);
        if (facts !== undefined && facts.nominal !== undefined) {
          return facts.nominal;
        }
        if (
          definition.kind === "type" || definition.kind === "record" ||
          definition.kind === "effect"
        ) return entity;
      }
    }
  }
  return undefined;
}
function is_builtin(name: string): boolean {
  return name === "true" || name === "false" ||
    is_builtin_type_name(name);
}
function mark_unvisited_sites(
  source: object,
  scope: ScopeId,
  recovery: { skipped: SourceSpan }[],
  state: State,
): void {
  const seen = new WeakSet<object>();
  const visit = (owner: object): void => {
    if (seen.has(owner)) return;
    seen.add(owner);
    const record = owner as { tag?: string };
    if (record.tag === "atom") return;
    for (const site of name_sites(owner)) {
      if (!state.sites.has(site)) {
        const poisoned = recovery.some((interval) =>
          interval.skipped.start <= site.span.start &&
          site.span.end <= interval.skipped.end
        );
        let reason: UnresolvedReason = "unknown";
        if (poisoned) reason = "recovery";
        if (!poisoned && is_builtin(site.name)) reason = "builtin";
        occurrence_for(
          owner,
          site.slot,
          site.index,
          site.name,
          "reference",
          undefined,
          reason,
          scope,
          state,
        );
      }
    }
    for (const value of Object.values(owner)) {
      if (value !== null && typeof value === "object") {
        if (Array.isArray(value)) {
          for (const entry of value) {
            if (entry !== null && typeof entry === "object") {
              visit(entry);
            }
          }
        } else visit(value);
      }
    }
  };
  visit(source);
}
