import { expect } from "../expect.ts";
import {
  has_source_span,
  source_span,
  type SourceSpan,
} from "../source_span.ts";
import type { CoreExpr, CoreStmt } from "./ast.ts";

export type CoreSourceSubject = CoreExpr | CoreStmt;

const core_source_origins = new WeakMap<object, SourceSpan>();
const core_diagnostic_subjects = new WeakMap<object, CoreSourceSubject>();
const core_diagnostic_related_subjects = new WeakMap<
  object,
  CoreSourceSubject
>();

export function record_core_source_origin<core extends CoreSourceSubject>(
  value: core,
  source: object,
): core {
  core_source_origins.set(value, source_span(source));
  return value;
}

export function record_optional_core_source_origin<
  core extends CoreSourceSubject,
>(
  value: core,
  source: object,
): core {
  if (has_source_span(source)) {
    record_core_source_origin(value, source);
  }

  return value;
}

export function inherit_core_source_origin(
  value: CoreExpr,
  source: CoreSourceSubject,
): void {
  const origin = core_source_origins.get(source);

  if (!origin) {
    return;
  }

  inherit_expr_origin(value, origin);
}

export function core_source_origin(value: CoreSourceSubject): SourceSpan {
  const origin = core_source_origins.get(value);
  expect(origin, "Missing Core source origin");
  return origin;
}

export function has_core_source_origin(value: CoreSourceSubject): boolean {
  return core_source_origins.has(value);
}

export function record_core_diagnostic_subject(
  value: object,
  subject: CoreSourceSubject,
): void {
  core_diagnostic_subjects.set(value, subject);
}

export function core_diagnostic_subject(value: object): CoreSourceSubject {
  const subject = core_diagnostic_subjects.get(value);
  expect(subject, "Missing Core diagnostic subject");
  return subject;
}

export function find_core_diagnostic_subject(
  value: object,
): CoreSourceSubject | undefined {
  return core_diagnostic_subjects.get(value);
}

export function record_core_diagnostic_related_subject(
  value: object,
  subject: CoreSourceSubject,
): void {
  core_diagnostic_related_subjects.set(value, subject);
}

export function core_diagnostic_related_subject(
  value: object,
): CoreSourceSubject | undefined {
  return core_diagnostic_related_subjects.get(value);
}

function inherit_expr_origin(value: CoreExpr, origin: SourceSpan): void {
  if (!core_source_origins.has(value)) {
    core_source_origins.set(value, origin);
  }

  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      const expr = child as CoreExpr;
      if ("tag" in expr) {
        inherit_expr_origin(expr, origin);
      }
    }

    if (Array.isArray(child)) {
      for (const entry of child) {
        if (entry !== null && typeof entry === "object" && "tag" in entry) {
          inherit_expr_origin(entry as CoreExpr, origin);
        }
      }
    }
  }
}
