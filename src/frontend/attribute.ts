import { expect } from "../expect.ts";
import type {
  AttributeGroup,
  Declaration,
  FrontExpr,
  Source,
  Stmt,
} from "./ast.ts";
import { throw_source_diagnostic } from "./semantic_diagnostic.ts";
import { elaborate_front_type_sets } from "./type_set_elaborate.ts";
import { import_meta_binding_name } from "./import_meta.ts";
import { elaborate_front_effects } from "./effect_elaborate.ts";
import {
  derive_missing_source_spans,
  has_source_span,
  source_span,
} from "./syntax.ts";

type AttributeApplication = {
  drop: boolean;
  exported: boolean;
  value: FrontExpr;
};

export function expand_source_attributes(source: Source): Source {
  if (!has_source_attributes(source)) {
    return source;
  }

  const declarations: Declaration[] = [];
  const type_overrides: Stmt[] = [];
  const type_override_offsets = new Map<Stmt, number>();
  const evaluation_source: Source = {
    ...source,
    declarations: source.declarations?.filter((declaration) =>
      declaration.tag !== "effect"
    ),
    statements: source.statements.filter((statement) =>
      statement.tag === "bind" && statement.kind === "const" &&
      statement.attribute_groups === undefined
    ),
  };
  const evaluation_statements = elaborate_front_effects(evaluation_source)
    .statements;
  const declaration_context = (source.declarations || []).map(
    (declaration) => ({ ...declaration, attribute_groups: undefined }),
  );

  for (const declaration of source.declarations || []) {
    if (declaration.attribute_groups === undefined) {
      declarations.push(declaration);
      continue;
    }

    if (declaration.tag !== "type") {
      throw_source_diagnostic(
        "DUCK2102",
        "Executable attributes currently support const bindings and type declarations",
        declaration,
      );
    }

    let declaration_offset = Number.POSITIVE_INFINITY;

    if (has_source_span(declaration)) {
      declaration_offset = source_span(declaration).start;
    }

    const context = attribute_context(
      evaluation_statements,
      type_overrides,
      declaration_offset,
    );
    const applied = apply_attribute_groups(
      declaration.name,
      { tag: "var", name: declaration.name },
      declaration.attribute_groups,
      declaration_context,
      context,
    );

    if (applied.exported) {
      throw_source_diagnostic(
        "DUCK2102",
        "Type declarations cannot be runtime exports",
        declaration,
      );
    }

    if (applied.drop) {
      continue;
    }

    declarations.push({ ...declaration, attribute_groups: undefined });

    if (!is_same_type_value(applied.value, declaration.name)) {
      const override: Stmt = {
        tag: "bind",
        kind: "const",
        name: declaration.name,
        is_linear: false,
        annotation: undefined,
        value: applied.value,
      };
      let declaration_span = { start: 0, end: 0 };

      if (has_source_span(declaration)) {
        declaration_span = source_span(declaration);
      }

      derive_missing_source_spans(override, declaration_span);
      type_overrides.push(override);
      type_override_offsets.set(override, declaration_offset);
    }
  }

  const statements: Stmt[] = [];

  for (let index = 0; index < source.statements.length; index += 1) {
    const statement = source.statements[index];
    expect(statement !== undefined, "Missing attribute statement " + index);

    if (statement.tag !== "bind" || statement.attribute_groups === undefined) {
      statements.push(statement);
      continue;
    }

    if (statement.kind !== "const") {
      throw_source_diagnostic(
        "DUCK2102",
        "Executable attributes require a const binding",
        statement,
      );
    }

    let statement_offset = Number.POSITIVE_INFINITY;

    if (has_source_span(statement)) {
      statement_offset = source_span(statement).start;
    }

    const context = attribute_context(
      evaluation_statements,
      type_overrides,
      statement_offset,
    );
    const applied = apply_attribute_groups(
      statement.name,
      statement.value,
      statement.attribute_groups,
      declarations,
      context,
    );

    if (applied.drop) {
      continue;
    }

    statements.push({
      ...statement,
      kind: applied.exported ? "let" : statement.kind,
      managed_export: applied.exported || statement.managed_export,
      attribute_groups: undefined,
      value: applied.value,
    });
  }

  const import_meta = statements.find((statement) =>
    statement.tag === "bind" && statement.name === import_meta_binding_name
  );
  const body = statements.filter((statement) => statement !== import_meta);
  const expanded_statements = [...body];

  for (const override of type_overrides) {
    const override_offset = type_override_offsets.get(override);
    expect(override_offset !== undefined, "Missing type override offset");
    const insertion_index = expanded_statements.findIndex((statement) =>
      has_source_span(statement) &&
      source_span(statement).start > override_offset
    );

    if (insertion_index === -1) {
      expanded_statements.push(override);
    } else {
      expanded_statements.splice(insertion_index, 0, override);
    }
  }

  if (import_meta !== undefined) {
    expanded_statements.unshift(import_meta);
  }

  return {
    ...source,
    declarations,
    statements: expanded_statements,
  };
}

function has_source_attributes(source: Source): boolean {
  for (const declaration of source.declarations || []) {
    if (declaration.attribute_groups !== undefined) {
      return true;
    }
  }

  return source.statements.some((statement) =>
    statement.tag === "bind" && statement.attribute_groups !== undefined
  );
}

function attribute_context(
  statements: Stmt[],
  type_overrides: Stmt[],
  target_offset: number,
): Stmt[] {
  return [...type_overrides, ...statements].filter((statement) => {
    if (statement.tag !== "bind" || statement.kind !== "const") {
      return false;
    }

    if (
      statement.name === import_meta_binding_name ||
      !has_source_span(statement)
    ) {
      return true;
    }

    return source_span(statement).start < target_offset;
  }).map((statement) => {
    if (statement.tag !== "bind") {
      throw new Error("Attribute context retained a non-binding statement");
    }

    return { ...statement, attribute_groups: undefined };
  });
}

function apply_attribute_groups(
  name: string,
  initial: FrontExpr,
  groups: AttributeGroup[],
  declarations: Declaration[],
  context: Stmt[],
): AttributeApplication {
  let value = initial;
  let exported = false;

  for (const group of groups) {
    for (const attribute of group.attributes) {
      const action = evaluate_attribute(
        name,
        attribute,
        value,
        declarations,
        context,
      );

      if (action.name === "Drop") {
        expect_unit_action(name, action, attribute);
        return {
          drop: true,
          exported: false,
          value,
        };
      }

      if (action.name === "Keep") {
        expect_unit_action(name, action, attribute);
        continue;
      }

      if (action.name === "Export") {
        expect_unit_action(name, action, attribute);
        exported = true;
        continue;
      }

      if (action.name === "Replace") {
        if (action.value === undefined) {
          throw_source_diagnostic(
            "DUCK2102",
            "Replace attribute action requires a value for " + name,
            attribute,
          );
        }

        value = action.value;
        continue;
      }

      throw_source_diagnostic(
        "DUCK2102",
        "Unknown attribute action " + action.name + " for " + name,
        attribute,
      );
    }
  }

  return { drop: false, exported, value };
}

function evaluate_attribute(
  name: string,
  attribute: FrontExpr,
  value: FrontExpr,
  declarations: Declaration[],
  context: Stmt[],
): Extract<FrontExpr, { tag: "union_case" }> {
  const call: FrontExpr = {
    tag: "app",
    func: attribute,
    args: [value],
  };

  try {
    const evaluated = elaborate_front_type_sets({
      tag: "program",
      declarations,
      statements: [...context, { tag: "expr", expr: call }],
    });
    const result = evaluated.statements.at(-1);

    if (
      result !== undefined && result.tag === "expr" &&
      result.expr.tag === "union_case"
    ) {
      if (result.expr.name !== "Replace" || result.expr.value === undefined) {
        return result.expr;
      }

      const replacement = elaborate_front_type_sets({
        tag: "program",
        declarations,
        statements: [
          ...context,
          { tag: "expr", expr: result.expr.value },
        ],
      }).statements.at(-1);

      if (replacement === undefined || replacement.tag !== "expr") {
        throw new Error("attribute replacement did not produce a value");
      }

      return { ...result.expr, value: replacement.expr };
    }

    throw new Error("attribute did not return an action");
  } catch (error) {
    if (error instanceof Error) {
      throw_source_diagnostic(
        "DUCK2102",
        "Attribute evaluation failed for " + name + ": " + error.message,
        attribute,
      );
    }

    throw error;
  }
}

function expect_unit_action(
  name: string,
  action: Extract<FrontExpr, { tag: "union_case" }>,
  attribute: FrontExpr,
): void {
  if (action.value?.tag === "unit") {
    return;
  }

  throw_source_diagnostic(
    "DUCK2102",
    action.name + " attribute action expects Unit for " + name,
    attribute,
  );
}

function is_same_type_value(value: FrontExpr, name: string): boolean {
  return value.tag === "var" && value.name === name;
}
