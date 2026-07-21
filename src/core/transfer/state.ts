import type { CoreTransferEdge, CoreTransferState } from "./types.ts";

export function clone_transfer_state<ctx>(
  state: CoreTransferState<ctx>,
): CoreTransferState<ctx> {
  return {
    collect_local_facts: state.collect_local_facts,
    next_transfer: state.next_transfer,
    next_temporary: state.next_temporary,
    transfers: state.transfers.slice(),
    issues: state.issues.slice(),
    transferred: new Map(state.transferred),
    functions: state.functions,
    aliases: new Map(state.aliases),
    declared_owners: new Set(state.declared_owners),
    alias_subjects: new Map(state.alias_subjects),
    alias_ownership: new Map(state.alias_ownership),
    alias_rejection_reasons: new Map(state.alias_rejection_reasons),
    active_functions: new Set(state.active_functions),
    ctx: state.ctx,
    hooks: state.hooks,
  };
}

export function merge_transfer_state<ctx>(
  target: CoreTransferState<ctx>,
  source: CoreTransferState<ctx>,
): void {
  merge_transfer_edges(target, source);
  merge_transfer_issues(target, source);
  target.next_transfer = source.next_transfer;
  target.next_temporary = source.next_temporary;

  for (const entry of source.transferred.entries()) {
    target.transferred.set(entry[0], entry[1]);
  }

  for (const entry of source.alias_ownership.entries()) {
    target.alias_ownership.set(entry[0], entry[1]);
  }

  for (const entry of source.alias_subjects.entries()) {
    target.alias_subjects.set(entry[0], entry[1]);
  }

  for (const entry of source.alias_rejection_reasons.entries()) {
    target.alias_rejection_reasons.set(entry[0], entry[1]);
  }

  for (const owner of source.declared_owners) {
    target.declared_owners.add(owner);
  }
}

export function merge_conditional_transfer_states<ctx>(
  target: CoreTransferState<ctx>,
  sources: CoreTransferState<ctx>[],
  path_count: number,
): void {
  const base_transferred = new Map(target.transferred);
  let next_temporary = target.next_temporary;

  record_conditional_transfer_issues(
    target,
    sources,
    path_count,
    base_transferred,
  );

  for (const source of sources) {
    if (source.next_temporary > next_temporary) {
      next_temporary = source.next_temporary;
    }
    merge_transfer_state(target, source);
  }

  target.next_temporary = next_temporary;
}

export function merge_transfer_issues<ctx>(
  target: CoreTransferState<ctx>,
  source: CoreTransferState<ctx>,
): void {
  const seen = new Set<string>();

  for (const issue of target.issues) {
    seen.add(issue.message);
  }

  for (const issue of source.issues) {
    if (seen.has(issue.message)) {
      continue;
    }

    target.issues.push(issue);
    seen.add(issue.message);
  }
}

export function child_scope(scope: string, kind: string): string {
  return scope + "/" + kind;
}

export function transfer_edge_text(edge: CoreTransferEdge): string {
  if (edge.callee.startsWith("union_case.")) {
    return "ownership transfer";
  }

  return "host/import transfer";
}

function record_conditional_transfer_issues<ctx>(
  target: CoreTransferState<ctx>,
  sources: CoreTransferState<ctx>[],
  path_count: number,
  base_transferred: Map<string, CoreTransferEdge>,
): void {
  const counts = new Map<string, {
    count: number;
    transfer: CoreTransferEdge;
  }>();

  for (const source of sources) {
    const seen = new Set<string>();

    for (const entry of source.transferred.entries()) {
      const owner = entry[0];
      const transfer = entry[1];

      if (seen.has(owner)) {
        continue;
      }

      if (owner.startsWith("temporary#")) {
        continue;
      }

      const base = base_transferred.get(owner);

      if (base && base.id === transfer.id) {
        continue;
      }

      seen.add(owner);
      const previous = counts.get(owner);

      if (previous) {
        previous.count += 1;
        continue;
      }

      counts.set(owner, {
        count: 1,
        transfer,
      });
    }
  }

  for (const entry of counts.entries()) {
    const owner = entry[0];
    const info = entry[1];

    if (info.count >= path_count) {
      continue;
    }

    if (!target.declared_owners.has(owner)) {
      continue;
    }

    record_conditional_transfer_requires_cleanup(
      owner,
      info.transfer,
      target,
    );
  }
}

function record_conditional_transfer_requires_cleanup<ctx>(
  owner: string,
  transfer: CoreTransferEdge,
  state: CoreTransferState<ctx>,
): void {
  const message = "Conditional transfer of owner " + owner + " through " +
    transfer.id + " to " + transfer.callee +
    " requires conditional cleanup/drop facts";

  for (const issue of state.issues) {
    if (issue.message === message) {
      return;
    }
  }

  state.issues.push({
    tag: "conditional_transfer_requires_cleanup",
    owner,
    transfer,
    message,
  });
}

function merge_transfer_edges<ctx>(
  target: CoreTransferState<ctx>,
  source: CoreTransferState<ctx>,
): void {
  const seen = new Set<string>();

  for (const edge of target.transfers) {
    seen.add(edge.id);
  }

  for (const edge of source.transfers) {
    if (seen.has(edge.id)) {
      continue;
    }

    target.transfers.push(edge);
    seen.add(edge.id);
  }
}
