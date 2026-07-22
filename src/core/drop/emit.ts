import { core_storage_class } from "../escape.ts";
import { core_ownership_result_text } from "../ownership.ts";
import type {
  CoreDropEdge,
  CoreDropOwner,
  CoreDropState,
  CoreUniqueHeapOwnership,
} from "./types.ts";
import type { CoreExpr } from "../ast.ts";
import {
  type CoreSourceSubject,
  record_core_diagnostic_related_subject,
  record_core_diagnostic_subject,
} from "../source_origin.ts";

export function drop_scope_owners(
  scope: string,
  owners: Map<string, CoreDropOwner>,
  state: CoreDropState,
): void {
  const remaining = Array.from(owners.values());

  for (let index = remaining.length - 1; index >= 0; index -= 1) {
    const owner = remaining[index];
    emit_drop("scope_exit", scope, owner.name, owner, state);
  }

  owners.clear();
}

export function drop_exit_owners(
  edge: Extract<
    CoreDropEdge,
    "return_exit" | "break_exit" | "continue_exit"
  >,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  inherited: CoreDropOwner[],
  retained_owners: Set<string> | undefined,
  escaped_owner: string | undefined,
  state: CoreDropState,
): void {
  const all_owners = inherited.concat(Array.from(owners.values()));
  const seen = new Set<string>();

  for (let index = all_owners.length - 1; index >= 0; index -= 1) {
    const owner = all_owners[index];

    if (retained_owners?.has(owner.name)) {
      continue;
    }

    if (owner.name === escaped_owner) {
      continue;
    }

    if (seen.has(owner.name)) {
      continue;
    }

    seen.add(owner.name);
    emit_drop(edge, scope, owner.name, owner, state);
  }

  if (!retained_owners) {
    owners.clear();
    return;
  }

  for (const name of Array.from(owners.keys())) {
    if (!retained_owners.has(name)) {
      owners.delete(name);
    }
  }
}

export function emit_drop(
  edge: CoreDropEdge,
  scope: string,
  owner_name: string | undefined,
  owner: CoreDropOwner,
  state: CoreDropState,
  subject?: CoreExpr,
  related_subject?: CoreSourceSubject,
): void {
  const storage = core_storage_class(owner.ownership);
  let emitted_owner = owner_name;
  if (owner.pointer === "temporary") {
    emitted_owner = undefined;
  }
  const step = {
    tag: "heap_drop",
    id: "drop#" + state.next_drop.toString(),
    edge,
    scope,
    owner: emitted_owner,
    ownership: owner.ownership,
    storage,
    runtime: "reusable_free_list_allocator",
    reason: core_ownership_result_text(owner.ownership) + " " +
      drop_edge_text(edge) + " lowers to __free with reusable allocator",
  } as const;
  state.steps.push(step);
  let diagnostic_subject = subject;
  if (!diagnostic_subject) {
    diagnostic_subject = owner.subject;
  }
  if (diagnostic_subject) {
    record_core_diagnostic_subject(step, diagnostic_subject);
  }
  if (related_subject) {
    record_core_diagnostic_related_subject(step, related_subject);
  }
  state.next_drop += 1;
}

export function emit_host_transfer(
  scope: string,
  callee: string,
  argument: number,
  owner: string | undefined,
  ownership: CoreUniqueHeapOwnership,
  subject: CoreExpr,
  state: CoreDropState,
): void {
  const storage = core_storage_class(ownership);
  const step = {
    tag: "host_transfer",
    id: "transfer#" + state.next_transfer.toString(),
    edge: "host_transfer",
    scope,
    callee,
    argument,
    owner,
    ownership,
    storage,
    runtime: "host_owned",
    reason: core_ownership_result_text(ownership) +
      " transfers ownership to host/import " + callee,
  } as const;
  state.steps.push(step);
  record_core_diagnostic_subject(step, subject);
  state.next_transfer += 1;
}

function drop_edge_text(edge: CoreDropEdge): string {
  switch (edge) {
    case "scope_exit":
      return "scope exit";

    case "return_exit":
      return "return exit";

    case "break_exit":
      return "break exit";

    case "continue_exit":
      return "continue exit";

    case "conditional_cleanup":
      return "conditional retained-path cleanup";

    case "loop_zero_iteration_cleanup":
      return "loop zero-iteration cleanup";

    case "assignment_replace":
      return "assignment replacement";

    case "discarded_expr":
      return "discarded expression";
  }
}
