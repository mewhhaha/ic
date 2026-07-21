import type { CoreExpr } from "../ast.ts";
import {
  bind_field_owner_alias,
  bind_stored_borrow_view_alias,
  clear_borrow_alias,
  stored_borrow_view_for_value,
} from "./aliases.ts";
import {
  field_owner_result_for_value,
  update_borrow_alias,
} from "./field_alias.ts";
import { update_borrow_alias_from_record } from "./record.ts";
import type {
  CoreBorrowAliases,
  CoreBorrowHooks,
  CoreBorrowState,
} from "./types.ts";
import {
  type CoreBorrowViewResultScanner,
  stored_borrow_view_result_for_value,
} from "./view_result.ts";

export function scan_borrow_binding_value<ctx>(
  name: string,
  annotation: string | undefined,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  parent: string,
  state: CoreBorrowState,
  aliases: CoreBorrowAliases,
  scanner: CoreBorrowViewResultScanner<ctx>,
): void {
  const active_borrow_start = state.active_borrows.length;

  if (value.tag === "borrow") {
    const recorded = scanner.record_borrow(
      value,
      ctx,
      hooks,
      parent,
      state,
      "bounded",
      aliases,
    );
    update_borrow_alias_from_record(name, recorded, aliases);
    remove_unstored_active_borrows(state, aliases, active_borrow_start);
    return;
  }

  const view = stored_borrow_view_for_value(value, aliases);

  if (view) {
    scanner.scan_expr(value, ctx, hooks, parent, state, "bounded", aliases);
    bind_stored_borrow_view_alias(name, view, aliases);
    remove_unstored_active_borrows(state, aliases, active_borrow_start);
    return;
  }

  const view_result = stored_borrow_view_result_for_value(
    value,
    ctx,
    hooks,
    parent,
    state,
    aliases,
    scanner,
  );

  if (view_result.view) {
    bind_stored_borrow_view_alias(name, view_result.view, aliases);
    remove_unstored_active_borrows(state, aliases, active_borrow_start);
    return;
  }

  const field_owner = field_owner_result_for_value(value, ctx, hooks, aliases);

  if (field_owner) {
    if (!view_result.scanned) {
      scanner.scan_expr(value, ctx, hooks, parent, state, "bounded", aliases);
    }

    bind_field_owner_alias(name, field_owner, aliases);
    remove_unstored_active_borrows(state, aliases, active_borrow_start);
    return;
  }

  if (view_result.scanned) {
    clear_borrow_alias(name, aliases);
    remove_unstored_active_borrows(state, aliases, active_borrow_start);
    return;
  }

  scanner.scan_expr(value, ctx, hooks, parent, state, "escaping", aliases);
  update_borrow_alias(name, value, ctx, hooks, aliases, annotation);
  remove_unstored_active_borrows(state, aliases, active_borrow_start);
}

function remove_unstored_active_borrows(
  state: CoreBorrowState,
  aliases: CoreBorrowAliases,
  start: number,
): void {
  const stored_ids = new Set<string>();

  for (const view of aliases.views.values()) {
    stored_ids.add(view.borrow_id);
  }

  for (
    let index = state.active_borrows.length - 1;
    index >= start;
    index -= 1
  ) {
    const active = state.active_borrows[index];

    if (!active) {
      throw new Error("Missing active borrow " + index.toString());
    }

    if (!stored_ids.has(active.id)) {
      state.active_borrows.splice(index, 1);
    }
  }
}
