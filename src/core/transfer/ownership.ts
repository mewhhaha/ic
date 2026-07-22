import type { CoreExpr } from "../ast.ts";
import { core_expr_ownership, type CoreOwnership } from "../ownership.ts";
import {
  runtime_aggregate_field_base_offset,
  runtime_aggregate_layout_for_type,
} from "../runtime_aggregate.ts";
import type { TypeStaticCtx } from "../type_static.ts";
import type { CoreTransferState } from "./types.ts";

export function bind_transfer_alias_ownership<ctx>(
  param: string,
  owner: string,
  arg: CoreExpr,
  state: CoreTransferState<ctx>,
): void {
  if (arg.tag === "var") {
    const existing = state.alias_ownership.get(arg.name);

    if (existing) {
      state.alias_ownership.set(param, existing);
      state.alias_ownership.set(owner, existing);
      state.alias_rejection_reasons.delete(param);
      state.alias_rejection_reasons.delete(owner);
      return;
    }

    const rejection = state.alias_rejection_reasons.get(arg.name);

    if (rejection) {
      state.alias_ownership.set(param, undefined);
      state.alias_ownership.set(owner, undefined);
      state.alias_rejection_reasons.set(param, rejection);
      state.alias_rejection_reasons.set(owner, rejection);
      return;
    }
  }

  try {
    const ownership = core_expr_ownership(arg, state.ctx, state.hooks);
    state.alias_ownership.set(param, ownership);
    state.alias_ownership.set(owner, ownership);
    state.alias_rejection_reasons.delete(param);
    state.alias_rejection_reasons.delete(owner);
  } catch (error) {
    let reason = "cannot prove argument ownership";

    if (error instanceof Error) {
      reason = error.message;
    }

    state.alias_ownership.set(param, undefined);
    state.alias_ownership.set(owner, undefined);
    state.alias_rejection_reasons.set(param, reason);
    state.alias_rejection_reasons.set(owner, reason);
  }
}

export function static_transfer_argument_is_unique<ctx>(
  owner: string,
  callee: string,
  argument: number,
  state: CoreTransferState<ctx>,
): boolean {
  const reason = state.alias_rejection_reasons.get(owner);

  if (reason) {
    record_invalid_static_transfer_argument(
      owner,
      callee,
      argument,
      undefined,
      reason,
      state,
    );
    return false;
  }

  const ownership = state.alias_ownership.get(owner);

  if (!ownership) {
    return true;
  }

  if (ownership.tag === "unique_heap") {
    return true;
  }

  record_invalid_static_transfer_argument(
    owner,
    callee,
    argument,
    ownership,
    "ownership-transfer wrapper argument " + owner +
      " must be unique_heap, got " + transfer_ownership_text(ownership),
    state,
  );
  return false;
}

export function bind_transfer_owner_alias<ctx>(
  name: string,
  value: CoreExpr,
  state: CoreTransferState<ctx>,
): void {
  state.aliases.delete(name);
  state.alias_ownership.delete(name);
  state.alias_rejection_reasons.delete(name);

  if (
    value.tag === "field" && value.move &&
    (value.object.tag === "var" || value.object.tag === "linear") &&
    state.hooks.runtime_aggregate_type_expr
  ) {
    const object_type = state.hooks.runtime_aggregate_type_expr(
      value.object,
      state.ctx,
    );

    if (object_type !== undefined) {
      const layout = runtime_aggregate_layout_for_type(
        object_type,
        state.ctx as ctx & TypeStaticCtx,
      );
      const field = layout.fields.find((candidate) => {
        return candidate.name === value.name;
      });

      if (
        field?.tag === "struct" &&
        runtime_aggregate_field_base_offset(field) === 0
      ) {
        const owner = resolve_transfer_owner(value.object.name, state);
        const ownership = state.alias_ownership.get(value.object.name);
        state.aliases.set(name, owner);
        state.alias_ownership.set(name, ownership);
        return;
      }
    }
  }

  if (value.tag !== "var") {
    try {
      const ownership = core_expr_ownership(value, state.ctx, state.hooks);
      state.alias_ownership.set(name, ownership);
    } catch (error) {
      state.alias_ownership.delete(name);
      if (error instanceof Error) {
        state.alias_rejection_reasons.set(name, error.message);
      }
    }
    return;
  }

  const owner = resolve_transfer_owner(value.name, state);
  if (owner === name) {
    return;
  }

  let ownership: CoreOwnership;

  try {
    ownership = core_expr_ownership(value, state.ctx, state.hooks);
  } catch {
    return;
  }

  if (ownership.tag !== "unique_heap") {
    return;
  }

  state.aliases.set(name, owner);
  state.alias_ownership.set(name, ownership);
}

export function resolve_transfer_owner<ctx>(
  owner: string,
  state: CoreTransferState<ctx>,
): string {
  const seen = new Set<string>();
  let current = owner;

  while (true) {
    if (seen.has(current)) {
      return current;
    }

    seen.add(current);
    const next = state.aliases.get(current);

    if (!next) {
      return current;
    }

    current = next;
  }
}

function record_invalid_static_transfer_argument<ctx>(
  owner: string,
  callee: string,
  argument: number,
  ownership: CoreOwnership | undefined,
  reason: string,
  state: CoreTransferState<ctx>,
): void {
  state.issues.push({
    tag: "invalid_static_transfer_argument",
    owner,
    callee,
    argument,
    ownership,
    reason,
    message: "Rejected ownership-transfer wrapper argument " + owner +
      " for " + callee + " argument " + argument.toString() + ": " +
      reason,
  });
}

function transfer_ownership_text(ownership: CoreOwnership): string {
  switch (ownership.tag) {
    case "scalar_local":
      return "scalar_local " + ownership.type;

    case "unique_heap":
      return "unique_heap " + ownership.reason;

    case "frozen_shareable":
      return "frozen_shareable " + ownership.reason;

    case "borrow_view":
      return "borrow_view over " + transfer_ownership_text(ownership.source);

    case "scratch_backed":
      return "scratch_backed over " +
        transfer_ownership_text(ownership.source);
  }
}
