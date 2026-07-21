import type { CoreExpr, CoreStmt } from "../ast.ts";
import type { CoreAllocationFact } from "./types.ts";

type CoreAllocationPermitMetadata = {
  emission_site: string;
  producer: "internal" | "external";
  required: boolean;
};

const subjects = new WeakMap<CoreAllocationFact, CoreExpr>();
const permits = new WeakMap<CoreAllocationFact, CoreAllocationPermitMetadata>();
const freeze_subjects = new WeakMap<CoreAllocationFact, CoreExpr>();
const lifetime_subjects = new WeakMap<
  CoreAllocationFact,
  CoreExpr | CoreStmt
>();
const emission_subjects = new WeakMap<CoreAllocationFact, Set<CoreExpr>>();
const returned_subjects = new WeakMap<CoreAllocationFact, CoreExpr>();
const scratch_scopes = new WeakMap<CoreAllocationFact, string>();
const destinations = new WeakMap<
  CoreAllocationFact,
  { owner: string; field: string }[]
>();
const owning_parents = new WeakMap<
  CoreAllocationFact,
  Set<CoreAllocationFact>
>();

export function register_core_allocation_fact(
  fact: CoreAllocationFact,
  subject: CoreExpr,
  emission_site: string,
): void {
  subjects.set(fact, subject);
  emission_subjects.set(fact, new Set([subject]));
  permits.set(fact, { emission_site, producer: "internal", required: false });
}

export function core_allocation_fact_subject(
  fact: CoreAllocationFact,
): CoreExpr | undefined;
export function core_allocation_fact_subject(
  plan: unknown,
  fact: CoreAllocationFact,
): CoreExpr | undefined;
export function core_allocation_fact_subject(
  plan_or_fact: unknown,
  maybe_fact?: CoreAllocationFact,
): CoreExpr | undefined {
  let fact: CoreAllocationFact;
  if (maybe_fact) {
    fact = maybe_fact;
  } else {
    fact = plan_or_fact as CoreAllocationFact;
  }
  return subjects.get(fact);
}

export function core_allocation_fact_permit_metadata(
  fact: CoreAllocationFact,
): CoreAllocationPermitMetadata | undefined {
  return permits.get(fact);
}

export function set_core_allocation_fact_external(
  fact: CoreAllocationFact,
): void {
  const metadata = permits.get(fact);
  if (!metadata) {
    throw new Error("Core allocation fact has no permit metadata: " + fact.id);
  }
  metadata.producer = "external";
}

export function set_core_allocation_fact_emission_site(
  fact: CoreAllocationFact,
  emission_site: string,
): void {
  const metadata = permits.get(fact);
  if (!metadata) {
    throw new Error("Core allocation fact has no permit metadata: " + fact.id);
  }
  metadata.emission_site = emission_site;
}

export function register_core_allocation_fact_freeze(
  fact: CoreAllocationFact,
  subject: Extract<CoreExpr, { tag: "freeze" }>,
): void {
  const existing = freeze_subjects.get(fact);
  if (existing && existing !== subject) {
    throw new Error(
      "Core allocation fact has more than one freeze terminal: " + fact.id,
    );
  }
  freeze_subjects.set(fact, subject);
}

export function core_allocation_fact_freeze_subject(
  fact: CoreAllocationFact,
): CoreExpr | undefined {
  return freeze_subjects.get(fact);
}

export function register_core_allocation_fact_lifetime_subject(
  fact: CoreAllocationFact,
  subject: CoreExpr | CoreStmt,
): void {
  lifetime_subjects.set(fact, subject);
}

export function core_allocation_fact_lifetime_subject(
  fact: CoreAllocationFact,
): CoreExpr | CoreStmt | undefined {
  const subject = lifetime_subjects.get(fact);
  if (subject) {
    return subject;
  }
  return subjects.get(fact);
}

export function register_core_allocation_fact_emission_subject(
  fact: CoreAllocationFact,
  subject: CoreExpr,
): void {
  const registered = emission_subjects.get(fact);
  if (!registered) {
    throw new Error(
      "Core allocation fact has no emission subjects: " + fact.id,
    );
  }
  registered.add(subject);
}

export function core_allocation_fact_emission_subjects(
  fact: CoreAllocationFact,
): ReadonlySet<CoreExpr> | undefined {
  return emission_subjects.get(fact);
}

export function register_core_allocation_fact_return(
  fact: CoreAllocationFact,
  subject: CoreExpr,
): void {
  returned_subjects.set(fact, subject);
}

export function register_core_allocation_fact_scratch_scope(
  fact: CoreAllocationFact,
  scope: string,
): void {
  scratch_scopes.set(fact, scope);
}

export function core_allocation_fact_scratch_scope(
  fact: CoreAllocationFact,
): string | undefined {
  return scratch_scopes.get(fact);
}

export function core_allocation_fact_return_subject(
  fact: CoreAllocationFact,
): CoreExpr | undefined {
  return returned_subjects.get(fact);
}

export function register_core_allocation_fact_destination(
  fact: CoreAllocationFact,
  owner: string,
  field: string,
): void {
  let registered = destinations.get(fact);
  if (!registered) {
    registered = [];
    destinations.set(fact, registered);
  }
  if (
    registered.some((candidate) => {
      return candidate.owner === owner && candidate.field === field;
    })
  ) {
    return;
  }
  registered.push({ owner, field });
}

export function core_allocation_fact_destinations(
  fact: CoreAllocationFact,
): ReadonlyArray<{ owner: string; field: string }> {
  const registered = destinations.get(fact);
  if (!registered) {
    return [];
  }
  return registered;
}

export function register_core_allocation_fact_owning_parent(
  child: CoreAllocationFact,
  parent: CoreAllocationFact,
): void {
  let registered = owning_parents.get(child);
  if (!registered) {
    registered = new Set();
    owning_parents.set(child, registered);
  }
  registered.add(parent);
}

export function unregister_core_allocation_fact_owning_parent(
  child: CoreAllocationFact,
  parent: CoreAllocationFact,
): void {
  const registered = owning_parents.get(child);
  if (!registered) {
    return;
  }
  registered.delete(parent);
}

export function core_allocation_fact_owning_parents(
  fact: CoreAllocationFact,
): ReadonlySet<CoreAllocationFact> {
  const registered = owning_parents.get(fact);
  if (!registered) {
    return new Set();
  }
  return registered;
}
