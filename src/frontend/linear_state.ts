import type { FrontExpr, Stmt } from "./ast.ts";
import type { DiagnosticCode } from "../diagnostic.ts";
import {
  related_source_diagnostic,
  SourceDiagnosticError,
  throw_source_diagnostic,
} from "./semantic_diagnostic.ts";
import { derive_source_span, source_span, type SourceSpan } from "./syntax.ts";

type LinearBinding = {
  declaration: object;
  first_consume: FrontExpr | undefined;
};

export type LinearRelatedSubject = {
  message: string;
  subject: object;
};

export class LinearState extends Set<string> {
  readonly bindings = new Map<string, LinearBinding>();

  bind(name: string, declaration: object): void {
    this.add(name);
    this.bindings.set(name, { declaration, first_consume: undefined });
  }

  consume(name: string, value: FrontExpr): void {
    const binding = this.bindings.get(name);

    if (!this.has(name)) {
      if (binding && binding.first_consume) {
        throw_reused_linear_value(name, value, binding);
      }

      throw_linear_diagnostic(
        "DUCK2201",
        "Linear value " + name + " was already consumed",
        value,
        linear_binding_related(this, name),
      );
    }

    this.delete(name);

    if (binding) {
      binding.first_consume = value;
    }
  }

  clone(): LinearState {
    const clone = new LinearState();

    for (const name of this) {
      clone.add(name);
    }

    for (const [name, binding] of this.bindings) {
      clone.bindings.set(name, { ...binding });
    }

    return clone;
  }

  replace_with(next: LinearState): void {
    this.clear();
    this.bindings.clear();

    for (const name of next) {
      this.add(name);
    }

    for (const [name, binding] of next.bindings) {
      this.bindings.set(name, { ...binding });
    }
  }
}

export function create_linear_state(): LinearState {
  return new LinearState();
}

export function inherit_linear_source_span<node extends object>(
  value: node,
  source: object,
): node {
  let span: SourceSpan;

  try {
    span = source_span(source);
  } catch {
    return value;
  }

  return derive_source_span(value, span);
}

function throw_reused_linear_value(
  name: string,
  value: FrontExpr,
  binding: LinearBinding,
): never {
  const related: LinearRelatedSubject[] = [{
    message: "First consumed here",
    subject: binding.first_consume as object,
  }, {
    message: "Linear value declared here",
    subject: binding.declaration,
  }];
  throw_linear_diagnostic(
    "DUCK2201",
    "Linear value " + name + " was already consumed",
    value,
    related,
  );
}

export function throw_unused_linear_value(
  name: string,
  declaration: object,
): never {
  throw_linear_diagnostic(
    "DUCK2202",
    "Linear value " + name + " was not consumed",
    declaration,
  );
}

export function linear_binding_related(
  state: LinearState,
  name: string,
): LinearRelatedSubject[] {
  const binding = state.bindings.get(name);
  const related: LinearRelatedSubject[] = [];

  if (!binding) {
    return related;
  }

  if (binding.first_consume) {
    related.push({
      message: "First consumed here",
      subject: binding.first_consume,
    });
  }

  related.push({
    message: "Linear value declared here",
    subject: binding.declaration,
  });
  return related;
}

export function throw_linear_diagnostic(
  code: DiagnosticCode,
  message: string,
  subject: object,
  related_subjects: LinearRelatedSubject[] = [],
): never {
  try {
    const related = [];

    for (const item of related_subjects) {
      try {
        related.push(related_source_diagnostic(item.message, item.subject));
      } catch (error) {
        if (error instanceof SourceDiagnosticError) {
          throw error;
        }
      }
    }

    if (related.length > 0) {
      throw_source_diagnostic(code, message, subject, related);
    }

    throw_source_diagnostic(code, message, subject);
  } catch (error) {
    if (error instanceof SourceDiagnosticError) {
      throw error;
    }

    throw new Error(message);
  }
}

export function linear_block_exits(stmts: Stmt[]): boolean {
  for (const stmt of stmts) {
    if (
      stmt.tag === "return" || stmt.tag === "break" ||
      stmt.tag === "continue"
    ) {
      return true;
    }
  }

  return false;
}

export function expect_same_linear_state(
  expected: LinearState,
  actual: LinearState,
  edge: string,
  subject: object,
): void {
  if (!same_name_set(expected, actual)) {
    const related: LinearRelatedSubject[] = [];

    for (const name of expected) {
      if (!actual.has(name)) {
        related.push(...linear_binding_related(actual, name));
        break;
      }
    }

    throw_linear_diagnostic(
      "DUCK2205",
      "Linear loop " + edge + " changes carried values",
      subject,
      related,
    );
  }
}

export function same_names(left: string[], right: string[]): boolean {
  return same_name_set(new Set(left), new Set(right));
}

export function same_name_set(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const name of left) {
    if (!right.has(name)) {
      return false;
    }
  }

  return true;
}
