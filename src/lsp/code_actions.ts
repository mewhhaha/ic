import { is_const_expr_known } from "../frontend/const_known.ts";
import type { BindingIndex } from "../frontend/binding_index.ts";
import type { ParseSourceResult } from "../frontend/parser.ts";
import { Source } from "../frontend/source.ts";
import type {
  EffectOperation,
  FrontExpr,
  HandlerClause,
  Source as FrontSource,
  Stmt,
} from "../frontend/ast.ts";
import { name_sites } from "../frontend/name_site.ts";
import { source_span, type SourceSyntax } from "../frontend/syntax.ts";
import { front_type_name } from "../frontend/types.ts";
import { format_expr } from "../frontend/format.ts";
import type { LspDiagnostic } from "./diagnostics.ts";
import type { LspRange, PositionEncoding } from "./position.ts";
import { PositionIndex } from "./position.ts";
import type { LspTextEdit, LspWorkspaceEdit } from "./navigation.ts";

export type CodeActionKind =
  | "quickfix"
  | "refactor.rewrite"
  | "refactor.extract"
  | "refactor.inline"
  | "source.fixAll";

export type CodeActionData = {
  uri: string;
  version: number;
  title: string;
  kind: CodeActionKind;
  start: number;
  end: number;
  replacement: string;
  expected: string;
};

export type LspCodeAction = {
  title: string;
  kind: CodeActionKind;
  diagnostics?: LspDiagnostic[];
  data: CodeActionData;
  edit?: LspWorkspaceEdit;
};

export type CodeActionResolveContext = {
  analyze?: (text: string) => ReturnType<typeof Source.analyze>;
  uri: string;
  version: number;
  text: string;
  parsed: ParseSourceResult;
  index: BindingIndex;
  encoding: PositionEncoding;
};

/** Enumerate actions without eagerly attaching their workspace edits. */
export function code_actions(
  source: FrontSource,
  syntax: SourceSyntax,
  index: BindingIndex,
  uri: string,
  version: number,
  range: LspRange,
  diagnostics: LspDiagnostic[],
  encoding: PositionEncoding,
): LspCodeAction[] {
  const positions = new PositionIndex(syntax.text, encoding);
  const offsets = positions.offsets_from_range(range);
  const actions: LspCodeAction[] = [];
  const diagnostic_codes = new Set<string>();

  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== undefined) {
      diagnostic_codes.add(diagnostic.code);
    }
  }

  if (diagnostic_codes.has("IX2202")) {
    const removable: Array<Extract<Stmt, { tag: "bind" }>> = [];

    for (const statement of source.statements) {
      if (statement.tag !== "bind" || !statement.is_linear) {
        continue;
      }

      if (!overlaps(source_span(statement), offsets)) {
        continue;
      }

      const site = binding_name_site(statement);

      if (site === undefined) {
        continue;
      }

      const entity = entity_at(index, site.span.start);

      if (entity === undefined) {
        continue;
      }

      const references = index.references.get(entity);

      if (references !== undefined && references.length > 0) {
        continue;
      }

      if (
        !is_const_expr_known(
          statement.value,
          { scopes: [], next: new Map() },
          new Set(),
        )
      ) {
        continue;
      }

      removable.push(statement);
      const removal = statement_removal_range(statement, syntax.text);
      add_action(
        actions,
        syntax.text,
        uri,
        version,
        "Remove unused linear binding " + statement.name,
        "quickfix",
        removal.start,
        removal.end,
        "",
        diagnostics,
      );
    }

    if (removable.length > 1) {
      const replacement = remove_statements(syntax.text, removable);
      add_action(
        actions,
        syntax.text,
        uri,
        version,
        "Consume all unused linear values",
        "source.fixAll",
        0,
        syntax.text.length,
        replacement,
        diagnostics,
      );
    }
  }

  if (diagnostic_codes.has("IX2302")) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.code !== "IX2302") {
        continue;
      }

      const span = positions.offsets_from_range(diagnostic.range);
      const expression = syntax.text.slice(span.start, span.end);
      const i32 = /([0-9]+)i32/.exec(expression);

      if (i32 === null || !expression.includes("i64")) {
        continue;
      }

      const suffix = i32.index + i32[1].length;
      add_action(
        actions,
        syntax.text,
        uri,
        version,
        "Widen i32 operand to I64",
        "quickfix",
        span.start + suffix,
        span.start + suffix + 3,
        "i64",
        diagnostics,
      );
    }
    for (const statement of source.statements) {
      if (statement.tag !== "bind" || statement.annotation !== undefined) {
        continue;
      }

      if (!overlaps(source_span(statement.value), offsets)) {
        continue;
      }

      const site = binding_name_site(statement);

      if (site === undefined) {
        continue;
      }

      add_action(
        actions,
        syntax.text,
        uri,
        version,
        "Annotate " + statement.name + " as I64",
        "quickfix",
        site.span.end,
        site.span.end,
        ": I64",
        diagnostics,
      );
    }
  }

  for (const diagnostic of diagnostics) {
    if (diagnostic.code === "IX2201") {
      const span = positions.offsets_from_range(diagnostic.range);
      const occurrence = [...index.occurrences.values()].find((candidate) =>
        overlaps(candidate.span, span)
      );

      if (occurrence === undefined || occurrence.entity === undefined) {
        continue;
      }

      const entity = index.entities.get(occurrence.entity);
      const facts = index.facts.get(occurrence.entity);

      if (
        entity === undefined || !entity.linear || facts?.type === undefined ||
        facts.type.tag !== "int"
      ) {
        continue;
      }

      const binding = source.statements.find((statement) => {
        if (statement.tag !== "bind" || !statement.is_linear) {
          return false;
        }

        const site = binding_name_site(statement);
        return site !== undefined &&
          entity_at(index, site.span.start) === entity.id;
      });

      if (binding === undefined || binding.tag !== "bind") {
        continue;
      }

      const site = binding_name_site(binding);

      if (site === undefined || syntax.text[site.span.start - 1] !== "!") {
        continue;
      }

      add_action(
        actions,
        syntax.text,
        uri,
        version,
        "Make scalar " + entity.name + " shareable",
        "quickfix",
        site.span.start - 1,
        site.span.start,
        "",
        diagnostics,
      );
    }

    if (diagnostic.code === "IX2304") {
      const missing = /^Missing struct field: ([A-Za-z_][A-Za-z0-9_]*)$/.exec(
        diagnostic.message,
      );

      if (missing === null) {
        continue;
      }

      const declaration = source.declarations?.find((
        candidate,
      ): candidate is Extract<
        typeof candidate,
        { tag: "type" }
      > =>
        candidate.tag === "type" && candidate.body.tag === "product" &&
        candidate.body.fields.some((field) => field.name === missing[1])
      );
      const binding = source.statements.find((statement): statement is Extract<
        typeof statement,
        { tag: "bind" }
      > => statement.tag === "bind" && statement.value.tag === "struct_value");
      if (
        declaration === undefined || declaration.body.tag !== "product" ||
        binding === undefined
      ) {
        continue;
      }

      const field = declaration.body.fields.find((candidate) =>
        candidate.name === missing[1]
      );

      if (field === undefined) {
        continue;
      }

      const value = default_value(field.type_name);

      if (value === undefined) {
        continue;
      }

      const value_span = source_span(binding.value);
      const close = syntax.text.lastIndexOf("]", value_span.end);

      if (close < value_span.start) {
        continue;
      }

      add_action(
        actions,
        syntax.text,
        uri,
        version,
        "Add missing field " + field.name,
        "quickfix",
        close,
        close,
        ", ." + field.name + " = " + value,
        diagnostics,
      );
    }

    if (diagnostic.code === "IX2305") {
      const mismatch =
        /^Union case [A-Za-z_][A-Za-z0-9_]* expects (Bool|Int), got /
          .exec(diagnostic.message);

      if (mismatch === null) {
        continue;
      }

      const expected_type = mismatch[1];

      if (expected_type === undefined) {
        throw new Error(
          "Missing expected type in union payload diagnostic: " +
            diagnostic.message,
        );
      }

      const value = default_value(expected_type);

      if (value === undefined) {
        throw new Error(
          "Missing default value for union payload type: " + expected_type,
        );
      }

      let display_type = expected_type;

      if (display_type === "Int") {
        display_type = "I32";
      }

      const span = positions.offsets_from_range(diagnostic.range);
      const call = syntax.text.slice(span.start, span.end);
      const open = call.indexOf("(");
      const close = call.lastIndexOf(")");

      if (open < 0 || close <= open) {
        continue;
      }

      add_action(
        actions,
        syntax.text,
        uri,
        version,
        "Replace union payload with " + display_type + " value",
        "quickfix",
        span.start + open + 1,
        span.start + close,
        value,
        diagnostics,
      );
    }

    if (diagnostic.code === "IX2404") {
      const statement = source.statements.find((candidate) =>
        candidate.tag === "index_assign" &&
        overlaps(
          source_span(candidate),
          positions.offsets_from_range(diagnostic.range),
        )
      );

      if (statement === undefined || statement.tag !== "index_assign") {
        continue;
      }

      const binding = source.statements.find((candidate) =>
        candidate.tag === "bind" && candidate.name === statement.name &&
        (candidate.annotation === "Text" || candidate.value.tag === "freeze")
      );

      if (binding === undefined || binding.tag !== "bind") {
        continue;
      }

      const span = source_span(statement);
      const mutation = syntax.text.slice(span.start, span.end);
      add_action(
        actions,
        syntax.text,
        uri,
        version,
        "Rebuild and shadow frozen " + statement.name,
        "quickfix",
        span.start,
        span.end,
        "let " + statement.name + " = append(" + statement.name +
          ', "")\n' + mutation,
        diagnostics,
      );
    }

    if (diagnostic.code === "IX2403") {
      const diagnostic_span = positions.offsets_from_range(diagnostic.range);
      const scratch = source.statements.map(statement_expression).find((expr) =>
        expr !== undefined && expr.tag === "scratch" &&
        overlaps(source_span(expr), diagnostic_span)
      );

      if (
        scratch === undefined || scratch.tag !== "scratch" ||
        scratch.body.tag !== "block" || scratch.body.statements.length !== 1
      ) {
        continue;
      }

      const inner = scratch.body.statements[0];

      if (inner === undefined || inner.tag !== "expr") {
        continue;
      }

      const scratch_span = source_span(scratch);
      add_action(
        actions,
        syntax.text,
        uri,
        version,
        "Move scratch result to owned storage",
        "quickfix",
        scratch_span.start,
        scratch_span.end,
        format_expr(inner.expr),
        diagnostics,
      );
    }
  }

  for (const statement of source.statements) {
    if (statement.tag !== "bind") {
      continue;
    }

    const span = source_span(statement);
    const site = binding_name_site(statement);

    if (
      statement.annotation === undefined && site !== undefined &&
      overlaps(span, offsets)
    ) {
      const entity = entity_at(index, site.span.start);

      if (entity !== undefined) {
        const facts = index.facts.get(entity);

        if (facts?.type !== undefined && facts.type.tag !== "unknown") {
          add_action(
            actions,
            syntax.text,
            uri,
            version,
            "Annotate " + statement.name + " with inferred type",
            "refactor.rewrite",
            site.span.end,
            site.span.end,
            ": " + front_type_name(facts.type),
            [],
          );
        }
      }
    }

    if (
      statement.kind === "let" && overlaps(span, offsets) &&
      is_const_expr_known(
        statement.value,
        { scopes: [], next: new Map() },
        new Set(),
      )
    ) {
      const keyword_end = syntax.text.indexOf("let", span.start) + 3;
      add_action(
        actions,
        syntax.text,
        uri,
        version,
        "Convert let " + statement.name + " to const",
        "refactor.rewrite",
        keyword_end - 3,
        keyword_end,
        "const",
        [],
      );
    }

    if (overlaps(source_span(statement.value), offsets)) {
      add_action(
        actions,
        syntax.text,
        uri,
        version,
        "Wrap expression in comptime",
        "refactor.rewrite",
        source_span(statement.value).start,
        source_span(statement.value).end,
        "comptime " + syntax.text.slice(
          source_span(statement.value).start,
          source_span(statement.value).end,
        ),
        [],
      );
    }
  }

  for (const statement of source.statements) {
    if (statement.tag !== "bind" || statement.is_linear) {
      continue;
    }

    const site = binding_name_site(statement);

    if (site === undefined || !overlaps(source_span(statement), offsets)) {
      continue;
    }

    const entity = entity_at(index, site.span.start);

    if (entity === undefined) {
      continue;
    }

    const references = index.references.get(entity);

    if (references === undefined || references.length !== 1) {
      continue;
    }

    const reference = index.occurrences.get(references[0]);

    if (reference === undefined) {
      continue;
    }

    const statement_span = source_span(statement);
    const value_span = source_span(statement.value);

    if (reference.span.start < statement_span.end) {
      continue;
    }

    const between = syntax.text.slice(statement_span.end, reference.span.start);

    if (between.trim() !== "") {
      continue;
    }

    add_action(
      actions,
      syntax.text,
      uri,
      version,
      "Inline single-use binding " + statement.name,
      "refactor.inline",
      statement_span.start,
      reference.span.end,
      syntax.text.slice(value_span.start, value_span.end),
      [],
    );
  }

  for (const statement of source.statements) {
    if (statement.tag !== "bind" || statement.value.tag !== "handler") {
      continue;
    }

    const handler = statement.value;

    if (!overlaps(source_span(statement), offsets)) {
      continue;
    }

    const declaration = source.declarations?.find((candidate) =>
      candidate.tag === "effect" && candidate.name === handler.effect
    );

    if (declaration !== undefined && declaration.tag === "effect") {
      const completed = complete_handler(handler, declaration.operations);

      if (completed !== undefined) {
        const handler_span = source_span(handler);
        add_action(
          actions,
          syntax.text,
          uri,
          version,
          "Complete handler for " + handler.effect,
          "refactor.rewrite",
          handler_span.start,
          handler_span.end,
          format_expr(completed),
          [],
        );
      }
    }

    if (
      declaration === undefined || declaration.tag !== "effect" ||
      handler.clauses.length < 2
    ) {
      continue;
    }
    const order = new Map<string, number>();
    for (
      let position = 0;
      position < declaration.operations.length;
      position += 1
    ) {
      const operation = declaration.operations[position];

      if (operation === undefined) {
        throw new Error("Missing effect operation");
      }

      order.set(operation.name, position);
    }
    const clauses = [...handler.clauses];
    const sorted = [...clauses].sort((left, right) => {
      const left_order = order.get(left.name);
      const right_order = order.get(right.name);

      if (left_order === undefined || right_order === undefined) {
        return 0;
      }

      return left_order - right_order;
    });
    if (clauses.every((clause, position) => clause === sorted[position])) {
      continue;
    }
    const first = clauses[0];
    const last = clauses[clauses.length - 1];
    if (first === undefined || last === undefined) {
      throw new Error("Missing handler clause");
    }
    const first_span = source_span(first);
    const last_span = source_span(last);
    const replacement = sorted.map((clause) => {
      const span = source_span(clause);
      return syntax.text.slice(span.start, span.end);
    }).join(",\n  ");
    add_action(
      actions,
      syntax.text,
      uri,
      version,
      "Reorder handler clauses for " + handler.effect,
      "refactor.rewrite",
      first_span.start,
      last_span.end,
      replacement,
      [],
    );
  }

  for (const statement of source.statements) {
    const expr = statement_expression(statement);

    if (
      expr === undefined || expr.tag !== "if_let" ||
      !overlaps(source_span(expr), offsets)
    ) {
      continue;
    }

    const declaration = source.declarations?.find((candidate) =>
      candidate.tag === "type" && candidate.body.tag === "sum" &&
      candidate.body.cases.some((item) => item.name === expr.case_name)
    );

    if (
      declaration === undefined || declaration.tag !== "type" ||
      declaration.body.tag !== "sum"
    ) {
      continue;
    }

    const handled = handled_if_let_cases(expr);
    const missing = declaration.body.cases.find((item) =>
      !handled.has(item.name)
    );

    if (missing === undefined) {
      continue;
    }

    const value_name = fresh_name(index, source_span(expr).start, "value");
    const branch: FrontExpr = {
      tag: "if_let",
      case_name: missing.name,
      value_name,
      target: expr.target,
      then_branch: expr.else_branch,
      else_branch: expr.else_branch,
    };
    const replacement: FrontExpr = { ...expr, else_branch: branch };
    const expr_span = source_span(expr);
    add_action(
      actions,
      syntax.text,
      uri,
      version,
      "Add explicit ." + missing.name + " branch",
      "refactor.rewrite",
      expr_span.start,
      expr_span.end,
      format_expr(replacement),
      [],
    );
  }

  for (const statement of source.statements) {
    if (statement.tag !== "expr") {
      continue;
    }

    const span = source_span(statement.expr);

    if (span.start !== offsets.start || span.end !== offsets.end) {
      continue;
    }

    const name = fresh_name(index, span.start, "extracted");
    add_action(
      actions,
      syntax.text,
      uri,
      version,
      "Extract expression into " + name,
      "refactor.extract",
      span.start,
      span.end,
      "let " + name + " = " + syntax.text.slice(span.start, span.end) +
        "\n" + name,
      [],
    );
  }

  return actions.filter((action) => action_is_clean(action.data, syntax.text));
}

/** Resolve a previously listed action against the current document snapshot. */
export function resolve_code_action(
  action: LspCodeAction,
  context: CodeActionResolveContext,
): LspCodeAction | undefined {
  const data = action.data;
  if (data.uri !== context.uri || data.version !== context.version) {
    return undefined;
  }

  if (context.parsed.syntax.text !== context.text) {
    return undefined;
  }

  if (context.index.version !== context.version) {
    return undefined;
  }

  if (context.text.slice(data.start, data.end) !== data.expected) {
    return undefined;
  }

  if (!action_is_clean(data, context.text, context.analyze)) {
    return undefined;
  }

  const positions = new PositionIndex(context.text, context.encoding);
  const edit: LspTextEdit = {
    range: {
      start: positions.position_from_offset(data.start),
      end: positions.position_from_offset(data.end),
    },
    newText: data.replacement,
  };
  return { ...action, edit: { changes: { [context.uri]: [edit] } } };
}

function add_action(
  actions: LspCodeAction[],
  text: string,
  uri: string,
  version: number,
  title: string,
  kind: CodeActionKind,
  start: number,
  end: number,
  replacement: string,
  diagnostics: LspDiagnostic[],
): void {
  const data: CodeActionData = {
    uri,
    version,
    title,
    kind,
    start,
    end,
    replacement,
    expected: text.slice(start, end),
  };
  const action: LspCodeAction = { title, kind, data };

  if (diagnostics.length > 0) {
    action.diagnostics = diagnostics;
  }

  actions.push(action);
}

function action_is_clean(
  action: CodeActionData,
  text: string,
  analyze?: (text: string) => ReturnType<typeof Source.analyze>,
): boolean {
  const next = text.slice(0, action.start) + action.replacement +
    text.slice(action.end);
  let analysis: ReturnType<typeof Source.analyze>;

  if (analyze === undefined) {
    analysis = Source.analyze(next);
  } else {
    analysis = analyze(next);
  }

  return analysis.syntax_diagnostics.length === 0 &&
    analysis.diagnostics.length === 0;
}

function overlaps(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function binding_name_site(statement: Extract<Stmt, { tag: "bind" }>) {
  return name_sites(statement).find((site) => site.slot === "name");
}

function entity_at(index: BindingIndex, offset: number): string | undefined {
  return index.occurrence_at(offset)?.entity;
}

function fresh_name(index: BindingIndex, offset: number, base: string): string {
  const names = new Set(index.visible_at(offset).map((entity) => entity.name));

  if (!names.has(base)) {
    return base;
  }

  let suffix = 2;

  while (names.has(base + suffix)) {
    suffix += 1;
  }

  return base + suffix;
}

function complete_handler(
  handler: Extract<FrontExpr, { tag: "handler" }>,
  operations: EffectOperation[],
): Extract<FrontExpr, { tag: "handler" }> | undefined {
  const existing = new Map(
    handler.clauses.map((clause) => [clause.name, clause]),
  );
  const clauses: HandlerClause[] = [];
  let changed = false;

  for (const operation of operations) {
    const clause = existing.get(operation.name);

    if (clause !== undefined) {
      clauses.push(clause);
      continue;
    }

    const created = default_handler_clause(operation);

    if (created === undefined) {
      return undefined;
    }

    clauses.push(created);
    changed = true;
  }

  if (!changed) {
    return undefined;
  }

  return { ...handler, clauses };
}

function default_handler_clause(
  operation: EffectOperation,
): HandlerClause | undefined {
  const params = [];

  for (let index = 0; index < operation.params.length; index += 1) {
    const effect_param = operation.params[index];

    if (effect_param === undefined) {
      throw new Error("Missing effect operation parameter");
    }

    if (effect_param.ownership === "ownership_transfer") {
      return undefined;
    }

    params.push({
      name: "arg" + (index + 1).toString(),
      is_const: false,
      is_linear: false,
      annotation: undefined,
    });
  }

  params.push({
    name: "resume",
    is_const: false,
    is_linear: true,
    annotation: undefined,
  });
  const result = default_front_expr(operation.result.type_name);

  if (result === undefined) {
    return undefined;
  }

  return {
    name: operation.name,
    params,
    body: {
      tag: "app",
      func: { tag: "linear", name: "resume" },
      args: [result],
    },
  };
}

function default_front_expr(type_name: string): FrontExpr | undefined {
  if (type_name === "Bool") {
    return { tag: "bool", value: false };
  }

  if (type_name === "Int" || type_name === "I32" || type_name === "U32") {
    return { tag: "num", type: "i32", value: 0 };
  }

  if (type_name === "I64") {
    return { tag: "num", type: "i64", value: 0n };
  }

  if (type_name === "Text") {
    return { tag: "text", value: "" };
  }

  if (type_name === "Unit") {
    return { tag: "unit" };
  }

  return undefined;
}

function statement_expression(statement: Stmt): FrontExpr | undefined {
  if (statement.tag === "expr") {
    return statement.expr;
  }

  if (statement.tag === "bind" || statement.tag === "assign") {
    return statement.value;
  }

  return undefined;
}

function handled_if_let_cases(
  expr: Extract<FrontExpr, { tag: "if_let" }>,
): Set<string> {
  const cases = new Set<string>();
  let current: FrontExpr = expr;

  while (current.tag === "if_let") {
    cases.add(current.case_name);
    current = current.else_branch;
  }

  return cases;
}

function statement_removal_range(
  statement: Stmt,
  text: string,
): { start: number; end: number } {
  const span = source_span(statement);
  let end = span.end;

  if (text[end] === "\n") {
    end += 1;
  }

  return { start: span.start, end };
}

function remove_statements(text: string, statements: Stmt[]): string {
  const ranges = statements.map((statement) =>
    statement_removal_range(statement, text)
  ).sort((left, right) => right.start - left.start);
  let result = text;

  for (const range of ranges) {
    result = result.slice(0, range.start) + result.slice(range.end);
  }

  return result;
}

function default_value(type_name: string): string | undefined {
  if (type_name === "Bool") {
    return "false";
  }

  if (type_name === "Int" || type_name === "I32" || type_name === "U32") {
    return "0";
  }
  if (type_name === "I64") {
    return "0i64";
  }

  if (type_name === "Text") {
    return '""';
  }

  if (type_name === "Unit") {
    return "()";
  }

  return undefined;
}
