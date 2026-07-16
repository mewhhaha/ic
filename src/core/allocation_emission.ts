import type {
  CoreAllocationFact,
  CoreAllocationLayout,
  CoreAllocationPlan,
  CoreAllocationReason,
} from "./model/allocation.ts";
import type { CoreStorageClass } from "./model/storage.ts";
import type { CoreExpr } from "./ast.ts";
import {
  core_allocation_fact_emission_subjects,
  core_allocation_fact_permit_metadata,
  core_allocation_fact_subject,
} from "./allocation/metadata.ts";
import { canonical_core_expr } from "./subject_provenance.ts";

export type CoreAllocationPermitRequest = {
  subject: CoreExpr;
  reason: CoreAllocationReason;
  storage: Extract<
    CoreStorageClass,
    "persistent_unique_heap" | "scratch_arena"
  >;
  layout: CoreAllocationLayout;
  emission_site: string;
};

export type CoreAllocationPermitState = {
  permits: CoreAllocationFact[];
  consumed: CoreAllocationFact[];
  consumed_subjects: Map<CoreAllocationFact, Set<CoreExpr>>;
};

export function create_core_allocation_permit_state(
  plan: CoreAllocationPlan,
): CoreAllocationPermitState {
  return {
    permits: plan.facts.filter((fact) => {
      const metadata = core_allocation_fact_permit_metadata(fact);
      if (!metadata) {
        throw new Error(
          "Core allocation emission requires permit metadata: " + fact.id,
        );
      }
      return metadata.producer !== "external";
    }),
    consumed: [],
    consumed_subjects: new Map(),
  };
}

export function consume_core_allocation_permit(
  state: CoreAllocationPermitState,
  request: CoreAllocationPermitRequest,
): void {
  const index = state.permits.findIndex((fact) => {
    const metadata = core_allocation_fact_permit_metadata(fact);
    const fact_subjects = core_allocation_fact_emission_subjects(fact);
    if (!fact_subjects) {
      return false;
    }
    const request_subject = canonical_core_expr(request.subject);
    const subject_matches = Array.from(fact_subjects).some((subject) => {
      return canonical_core_expr(subject) === request_subject;
    });
    const consumed_subjects = state.consumed_subjects.get(fact);
    const subject_available = consumed_subjects === undefined ||
      !consumed_subjects.has(request_subject);
    return subject_matches &&
      subject_available &&
      fact.reason === request.reason &&
      fact.storage === request.storage &&
      fact.layout === request.layout &&
      metadata?.emission_site === request.emission_site;
  });

  if (index < 0) {
    const remaining = state.permits.map((fact) => {
      const subject = core_allocation_fact_subject(fact);
      let detail = "missing-subject";
      if (subject) {
        detail = describe_allocation_subject(subject);
      }
      const emission_subjects = core_allocation_fact_emission_subjects(fact);
      let emissions = "missing-emission-subjects";
      if (emission_subjects) {
        emissions = Array.from(emission_subjects).map((candidate) => {
          return describe_allocation_subject(candidate);
        }).join("|");
      }
      return fact.allocation_id + "=" + detail + "[" + emissions + "]";
    }).join(", ");
    const consumed = state.consumed.map((fact) => {
      const subject = core_allocation_fact_subject(fact);
      if (!subject) {
        return fact.allocation_id + "=missing-subject";
      }
      return fact.allocation_id + "=" + describe_allocation_subject(subject);
    }).join(", ");
    throw new Error(
      "Core allocation emission has no permit for " + request.reason +
        " " + request.storage + " " + request.layout + " at " +
        request.emission_site + " (" + request.subject.tag + "); remaining: " +
        remaining + "; request: " +
        describe_allocation_subject(request.subject) + "; consumed: " +
        consumed,
    );
  }

  const fact = state.permits[index];
  if (!fact) {
    throw new Error("Core allocation permit consumption lost its fact");
  }

  const request_subject = canonical_core_expr(request.subject);
  let consumed_subjects = state.consumed_subjects.get(fact);
  if (!consumed_subjects) {
    consumed_subjects = new Set();
    state.consumed_subjects.set(fact, consumed_subjects);
    state.consumed.push(fact);
  }
  consumed_subjects.add(request_subject);

  const emission_subjects = core_allocation_fact_emission_subjects(fact);
  if (!emission_subjects) {
    throw new Error("Core allocation permit lost its emission subjects");
  }
  const has_available_subject = Array.from(emission_subjects).some(
    (subject) => {
      return !consumed_subjects.has(canonical_core_expr(subject));
    },
  );
  if (!has_available_subject) {
    state.permits.splice(index, 1);
  }
}

function describe_allocation_subject(subject: CoreExpr): string {
  const canonical = canonical_core_expr(subject);
  let detail = subject.tag + "->" + canonical.tag;
  if (subject.tag === "var" || subject.tag === "linear") {
    detail += "(" + subject.name + ")";
  }
  if (canonical.tag === "var" || canonical.tag === "linear") {
    detail += "(" + canonical.name + ")";
  }
  if (subject.tag === "struct_value") {
    detail += "{" + subject.fields.map((field) => field.name).join(",") + "}";
  }
  if (canonical.tag === "struct_value" && canonical !== subject) {
    detail += "{" + canonical.fields.map((field) => field.name).join(",") + "}";
  }
  if (subject.tag === "union_case") {
    detail += "(." + subject.name + ")";
  }
  if (canonical.tag === "union_case" && canonical !== subject) {
    detail += "(." + canonical.name + ")";
  }
  return detail;
}

export function check_core_allocation_permits(
  state: CoreAllocationPermitState,
): void {
  const required = state.permits.filter((fact) => {
    const metadata = core_allocation_fact_permit_metadata(fact);
    return metadata?.required;
  });
  if (required.length === 0) {
    return;
  }

  const remaining = required.map((fact) => fact.allocation_id).join(", ");
  throw new Error("Core allocation emission left unused permits: " + remaining);
}
