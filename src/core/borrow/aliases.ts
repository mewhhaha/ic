import type { CoreExpr } from "../ast.ts";
import { core_expr_ownership, type CoreOwnership } from "../ownership.ts";
import { core_val_type_from_type_name } from "../type_static.ts";
import type {
  CoreBorrowAliases,
  CoreBorrowHooks,
  CoreBorrowState,
  CoreFieldBorrowOwner,
  CoreStoredBorrowView,
} from "./types.ts";

export function borrow_owner_name(expr: CoreExpr): string | undefined {
  if (expr.tag === "var") {
    return expr.name;
  }

  return undefined;
}

export function borrow_owner_names_with_aliases(
  expr: CoreExpr,
  aliases: CoreBorrowAliases,
): string[] {
  if (expr.tag === "var") {
    const view = aliases.views.get(expr.name);

    if (view) {
      return [...view.owners];
    }

    const field_owner = aliases.field_owners.get(expr.name);

    if (field_owner) {
      return [...field_owner.owners];
    }

    return [canonical_value_owner_name(expr.name, aliases)];
  }

  if (expr.tag === "field") {
    return borrow_owner_names_with_aliases(expr.object, aliases);
  }

  if (expr.tag === "index") {
    return borrow_owner_names_with_aliases(expr.object, aliases);
  }

  return [];
}

export function resolve_borrow_alias_expr(
  expr: CoreExpr,
  aliases: CoreBorrowAliases,
): CoreExpr {
  if (expr.tag !== "var") {
    return expr;
  }

  const owner = canonical_value_owner_name(expr.name, aliases);

  if (owner === expr.name) {
    return expr;
  }

  return { tag: "var", name: owner };
}

export function canonical_value_owner_name(
  name: string,
  aliases: CoreBorrowAliases,
): string {
  let current = name;
  const seen = new Set<string>();

  while (true) {
    if (seen.has(current)) {
      return current;
    }

    seen.add(current);
    const view = aliases.views.get(current);

    if (view) {
      if (view.owners.length !== 1) {
        return current;
      }

      const owner = view.owners[0];

      if (!owner) {
        return current;
      }

      current = owner;
      continue;
    }

    const next = aliases.owners.get(current);

    if (!next) {
      return current;
    }

    current = next;
  }
}

export function canonical_owner_names(
  name: string,
  aliases: CoreBorrowAliases,
): string[] {
  const view = aliases.views.get(name);

  if (view) {
    return [...view.owners];
  }

  const field_owner = aliases.field_owners.get(name);

  if (field_owner) {
    return [...field_owner.owners];
  }

  return [canonical_owner_name(name, aliases)];
}

export function canonical_owner_name(
  name: string,
  aliases: CoreBorrowAliases,
): string {
  let current = name;
  const seen = new Set<string>();

  while (true) {
    if (seen.has(current)) {
      return current;
    }

    seen.add(current);
    const view = aliases.views.get(current);

    if (view) {
      if (view.owners.length !== 1) {
        return current;
      }

      const owner = view.owners[0];

      if (!owner) {
        return current;
      }

      current = owner;
      continue;
    }

    const field_owner = aliases.field_owners.get(current);

    if (field_owner) {
      if (field_owner.owners.length !== 1) {
        return current;
      }

      const owner = field_owner.owners[0];

      if (!owner) {
        return current;
      }

      current = owner;
      continue;
    }

    const next = aliases.owners.get(current);

    if (!next) {
      return current;
    }

    current = next;
  }
}

export function empty_borrow_aliases(): CoreBorrowAliases {
  return {
    owners: new Map(),
    field_owners: new Map(),
    views: new Map(),
    union_types: new Map(),
    known: new Set(),
    assigned: new Set(),
  };
}

export function clone_borrow_aliases(
  aliases: CoreBorrowAliases,
): CoreBorrowAliases {
  return {
    owners: new Map(aliases.owners),
    field_owners: clone_field_owner_aliases(aliases.field_owners),
    views: new Map(aliases.views),
    union_types: new Map(aliases.union_types),
    known: new Set(aliases.known),
    assigned: new Set(aliases.assigned),
  };
}

export function clone_branch_borrow_aliases(
  aliases: CoreBorrowAliases,
): CoreBorrowAliases {
  return {
    owners: new Map(aliases.owners),
    field_owners: clone_field_owner_aliases(aliases.field_owners),
    views: new Map(aliases.views),
    union_types: new Map(aliases.union_types),
    known: new Set(aliases.known),
    assigned: new Set(),
  };
}

function clone_field_owner_aliases(
  aliases: Map<string, CoreFieldBorrowOwner>,
): Map<string, CoreFieldBorrowOwner> {
  const cloned = new Map<string, CoreFieldBorrowOwner>();

  for (const [name, alias] of aliases) {
    cloned.set(name, {
      owners: [...alias.owners],
      ownership: alias.ownership,
    });
  }

  return cloned;
}

export function merge_optional_branch_borrow_aliases(
  aliases: CoreBorrowAliases,
  branch: CoreBorrowAliases,
  parent_scope: string,
  state: CoreBorrowState,
): void {
  for (const name of branch.assigned) {
    if (!aliases.known.has(name)) {
      continue;
    }

    const view = branch.views.get(name);

    if (!view) {
      const field_owner = branch.field_owners.get(name);

      if (!field_owner) {
        continue;
      }

      const existing = aliases.field_owners.get(name);

      if (existing) {
        bind_field_owner_alias(
          name,
          merge_field_owner_aliases([existing, field_owner]),
          aliases,
        );
      } else {
        bind_field_owner_alias(name, field_owner, aliases);
      }

      continue;
    }

    bind_stored_borrow_view_alias(
      name,
      promote_stored_borrow_view(view, parent_scope, state),
      aliases,
    );
  }
}

export function merge_required_branch_borrow_aliases(
  aliases: CoreBorrowAliases,
  then_branch: CoreBorrowAliases,
  else_branch: CoreBorrowAliases,
  parent_scope: string,
  state: CoreBorrowState,
): void {
  const names = new Set<string>();

  for (const name of then_branch.assigned) {
    names.add(name);
  }

  for (const name of else_branch.assigned) {
    names.add(name);
  }

  for (const name of names) {
    if (!aliases.known.has(name)) {
      continue;
    }

    const views: CoreStoredBorrowView[] = [];
    collect_branch_view(name, aliases, then_branch, views);
    collect_branch_view(name, aliases, else_branch, views);

    if (views.length === 0) {
      const field_owners: CoreFieldBorrowOwner[] = [];
      collect_branch_field_owner(name, aliases, then_branch, field_owners);
      collect_branch_field_owner(name, aliases, else_branch, field_owners);

      if (field_owners.length === 0) {
        aliases.views.delete(name);
        aliases.field_owners.delete(name);
        continue;
      }

      bind_field_owner_alias(
        name,
        merge_field_owner_aliases(field_owners),
        aliases,
      );
      continue;
    }

    const first = views[0];

    if (!first) {
      throw new Error("Missing merged borrow view for " + name);
    }

    for (const view of views) {
      promote_stored_borrow_view(view, parent_scope, state);
    }

    bind_stored_borrow_view_alias(
      name,
      promote_stored_borrow_view(first, parent_scope, state),
      aliases,
    );
  }
}

function collect_branch_view(
  name: string,
  parent: CoreBorrowAliases,
  branch: CoreBorrowAliases,
  views: CoreStoredBorrowView[],
): void {
  const branch_view = branch.views.get(name);

  if (branch_view) {
    views.push(branch_view);
    return;
  }

  if (branch.assigned.has(name)) {
    return;
  }

  const parent_view = parent.views.get(name);

  if (parent_view) {
    views.push(parent_view);
  }
}

function collect_branch_field_owner(
  name: string,
  parent: CoreBorrowAliases,
  branch: CoreBorrowAliases,
  field_owners: CoreFieldBorrowOwner[],
): void {
  const branch_field_owner = branch.field_owners.get(name);

  if (branch_field_owner) {
    field_owners.push(branch_field_owner);
    return;
  }

  if (branch.assigned.has(name)) {
    return;
  }

  const parent_field_owner = parent.field_owners.get(name);

  if (parent_field_owner) {
    field_owners.push(parent_field_owner);
  }
}

export function merge_field_owner_aliases(
  aliases: CoreFieldBorrowOwner[],
): CoreFieldBorrowOwner {
  const first = aliases[0];

  if (!first) {
    throw new Error("Missing field owner alias to merge");
  }

  const owners: string[] = [];
  let ownership = first.ownership;

  for (const alias of aliases) {
    for (const owner of alias.owners) {
      if (owners.includes(owner)) {
        continue;
      }

      owners.push(owner);
    }

    if (alias.ownership.tag === "unique_heap") {
      ownership = alias.ownership;
    }
  }

  return {
    owners,
    ownership,
  };
}

export function promote_stored_borrow_view(
  view: CoreStoredBorrowView,
  scope: string,
  state: CoreBorrowState,
): CoreStoredBorrowView {
  for (const owner of view.owners) {
    ensure_active_borrow(view.borrow_id, owner, scope, state);
  }

  return {
    owners: [...view.owners],
    borrow_id: view.borrow_id,
    scope,
    ownership: view.ownership,
  };
}

function ensure_active_borrow(
  id: string,
  owner: string,
  scope: string,
  state: CoreBorrowState,
): void {
  for (const active of state.active_borrows) {
    if (active.id === id && active.owner === owner && active.scope === scope) {
      return;
    }
  }

  state.active_borrows.push({
    id,
    owner,
    scope,
  });
}

export function bind_field_owner_alias(
  name: string,
  field_owner: CoreFieldBorrowOwner,
  aliases: CoreBorrowAliases,
): void {
  aliases.known.add(name);
  aliases.views.delete(name);
  aliases.owners.delete(name);
  aliases.field_owners.set(name, {
    owners: [...field_owner.owners],
    ownership: field_owner.ownership,
  });
}

export function bind_collection_loop_item_owner_alias<ctx>(
  item: string,
  collection: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): void {
  if (!hooks.runtime_aggregate_type_expr) {
    return;
  }

  const aggregate_type = hooks.runtime_aggregate_type_expr(collection, ctx);

  if (!aggregate_type) {
    return;
  }

  const owners = borrow_owner_names_with_aliases(collection, aliases);

  if (owners.length === 0) {
    return;
  }

  const ownership = core_expr_ownership({ tag: "var", name: item }, ctx, hooks);

  if (ownership.tag === "scalar_local") {
    return;
  }

  bind_field_owner_alias(item, {
    owners,
    ownership,
  }, aliases);
}

export function bind_if_let_payload_owner_alias<ctx>(
  case_name: string,
  value_name: string | undefined,
  target: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): void {
  if (!value_name) {
    return;
  }

  const owners = borrow_owner_names_with_aliases(target, aliases);

  if (owners.length === 0) {
    clear_borrow_alias(value_name, aliases);
    return;
  }

  const aliased_ownership = if_let_payload_owner_ownership_from_alias(
    case_name,
    target,
    ctx,
    hooks,
    aliases,
  );

  if (aliased_ownership) {
    bind_if_let_payload_ownership_alias(
      value_name,
      owners,
      aliased_ownership,
      aliases,
    );
    return;
  }

  const payload_ctx = if_let_payload_owner_ctx(
    case_name,
    value_name,
    target,
    ctx,
    hooks,
  );
  const ownership = if_let_payload_owner_ownership(
    case_name,
    value_name,
    target,
    payload_ctx,
    ctx,
    hooks,
  );

  bind_if_let_payload_ownership_alias(value_name, owners, ownership, aliases);
}

function bind_if_let_payload_ownership_alias(
  value_name: string,
  owners: string[],
  ownership: CoreOwnership,
  aliases: CoreBorrowAliases,
): void {
  bind_field_owner_alias(value_name, {
    owners,
    ownership,
  }, aliases);
}

function if_let_payload_owner_ownership_from_alias<ctx>(
  case_name: string,
  target: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): CoreOwnership | undefined {
  if (target.tag !== "var") {
    return undefined;
  }

  const type_name = aliases.union_types.get(target.name);

  if (!type_name) {
    return undefined;
  }

  const type_value = hooks.static_value(type_name, ctx);

  if (!type_value || type_value.tag !== "union_type") {
    return undefined;
  }

  for (const union_case of type_value.cases) {
    if (union_case.name !== case_name) {
      continue;
    }

    return payload_ownership_from_type_name(
      union_case.type_name,
      ctx,
      hooks,
    );
  }

  return undefined;
}

function payload_ownership_from_type_name<ctx>(
  type_name: string,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
): CoreOwnership | undefined {
  if (type_name === "Text" || type_name === "Bytes") {
    return {
      tag: "unique_heap",
      reason: "text",
    };
  }

  const scalar = core_val_type_from_type_name(type_name);

  if (scalar) {
    return {
      tag: "scalar_local",
      type: scalar,
    };
  }

  if (type_name === "Unit") {
    return undefined;
  }

  const type_value = hooks.static_value(type_name, ctx);

  if (!type_value) {
    return undefined;
  }

  if (type_value.tag === "struct_type") {
    return {
      tag: "unique_heap",
      reason: "runtime_aggregate",
    };
  }

  if (type_value.tag === "union_type") {
    return {
      tag: "unique_heap",
      reason: "runtime_union",
    };
  }

  return undefined;
}

export function if_let_payload_owner_ctx<ctx>(
  case_name: string,
  value_name: string,
  target: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
): ctx {
  if (
    hooks.static_union_case &&
    hooks.if_let_branch_ctx &&
    hooks.bind_core_if_let_payload_fact
  ) {
    const union_case = hooks.static_union_case(target, ctx);

    if (union_case) {
      if (union_case.name !== case_name) {
        return ctx;
      }

      const branch_ctx = hooks.if_let_branch_ctx(ctx);
      hooks.bind_core_if_let_payload_fact(value_name, union_case, branch_ctx);
      return branch_ctx;
    }
  }

  if (
    hooks.dynamic_union_if &&
    hooks.if_let_branch_ctx &&
    hooks.bind_dynamic_if_let_payload
  ) {
    const dynamic_target = hooks.dynamic_union_if(target, ctx);

    if (dynamic_target) {
      if (
        dynamic_target.then_case.name !== case_name &&
        dynamic_target.else_case.name !== case_name
      ) {
        return ctx;
      }

      const branch_ctx = hooks.if_let_branch_ctx(ctx);
      hooks.bind_dynamic_if_let_payload(
        case_name,
        value_name,
        dynamic_target,
        branch_ctx,
      );
      return branch_ctx;
    }
  }

  if (
    hooks.runtime_union_target &&
    hooks.runtime_union_match_info &&
    hooks.static_runtime_union_match_branch_ctx
  ) {
    const runtime_target = hooks.runtime_union_target(target, ctx);

    if (runtime_target) {
      const info = hooks.runtime_union_match_info(
        case_name,
        runtime_target,
        ctx,
      );
      return hooks.static_runtime_union_match_branch_ctx(
        value_name,
        info,
        ctx,
      );
    }
  }

  return ctx;
}

function if_let_payload_owner_ownership<ctx>(
  case_name: string,
  value_name: string,
  target: CoreExpr,
  payload_ctx: ctx,
  original_ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
): CoreOwnership {
  try {
    return core_expr_ownership(
      { tag: "var", name: value_name },
      payload_ctx,
      hooks,
    );
  } catch {
    const fallback = runtime_union_payload_ownership(
      case_name,
      target,
      original_ctx,
      hooks,
    );

    if (fallback) {
      return fallback;
    }

    return { tag: "unique_heap", reason: "runtime_union" };
  }
}

function runtime_union_payload_ownership<ctx>(
  case_name: string,
  target: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
): CoreOwnership | undefined {
  if (!hooks.runtime_union_target || !hooks.runtime_union_match_info) {
    return undefined;
  }

  const runtime_target = hooks.runtime_union_target(target, ctx);

  if (!runtime_target) {
    return undefined;
  }

  const info = hooks.runtime_union_match_info(case_name, runtime_target, ctx);
  const payload = info.payload;

  if (payload.tag === "none") {
    return undefined;
  }

  if (payload.tag === "aggregate") {
    return { tag: "unique_heap", reason: "runtime_aggregate" };
  }

  if (payload.tag === "struct") {
    return { tag: "unique_heap", reason: "runtime_aggregate" };
  }

  if (payload.union_type_expr) {
    return { tag: "unique_heap", reason: "runtime_union" };
  }

  if (payload.text) {
    return { tag: "unique_heap", reason: "text" };
  }

  return { tag: "scalar_local", type: payload.type };
}

export function bind_stored_borrow_view_alias(
  name: string,
  view: CoreStoredBorrowView,
  aliases: CoreBorrowAliases,
): void {
  aliases.known.add(name);
  aliases.owners.delete(name);
  aliases.field_owners.delete(name);
  aliases.views.set(name, {
    owners: [...view.owners],
    borrow_id: view.borrow_id,
    scope: view.scope,
    ownership: view.ownership,
  });
}

export function direct_field_or_index_owner<ctx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): CoreFieldBorrowOwner | undefined {
  if (value.tag === "field") {
    return field_owner_for_expr(value.object, value, ctx, hooks, aliases);
  }

  if (value.tag === "index") {
    return field_owner_for_expr(value.object, value, ctx, hooks, aliases);
  }

  return undefined;
}

function field_owner_for_expr<ctx>(
  object: CoreExpr,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): CoreFieldBorrowOwner | undefined {
  const owners = borrow_owner_names_with_aliases(object, aliases);

  if (owners.length === 0) {
    return undefined;
  }

  return {
    owners,
    ownership: core_expr_ownership(value, ctx, hooks),
  };
}

export function field_owner_for_borrow_value(
  value: CoreExpr,
  aliases: CoreBorrowAliases,
): CoreFieldBorrowOwner | undefined {
  if (value.tag !== "var") {
    return undefined;
  }

  return aliases.field_owners.get(value.name);
}

export function stored_field_owner_for_value(
  value: CoreExpr,
  aliases: CoreBorrowAliases,
): CoreFieldBorrowOwner | undefined {
  if (value.tag !== "var") {
    return undefined;
  }

  return aliases.field_owners.get(value.name);
}

export function stored_borrow_view_for_value(
  value: CoreExpr,
  aliases: CoreBorrowAliases,
): CoreStoredBorrowView | undefined {
  if (value.tag !== "var") {
    return undefined;
  }

  return aliases.views.get(value.name);
}

export function merge_optional_branch_field_aliases(
  aliases: CoreBorrowAliases,
  branch: CoreBorrowAliases,
): void {
  for (const name of branch.assigned) {
    if (!aliases.known.has(name)) {
      continue;
    }

    const field_owner = branch.field_owners.get(name);

    if (!field_owner) {
      continue;
    }

    const existing = aliases.field_owners.get(name);

    if (existing) {
      bind_field_owner_alias(
        name,
        merge_field_owner_aliases([existing, field_owner]),
        aliases,
      );
    } else {
      bind_field_owner_alias(name, field_owner, aliases);
    }
  }
}

export function merge_required_branch_field_aliases(
  aliases: CoreBorrowAliases,
  then_branch: CoreBorrowAliases,
  else_branch: CoreBorrowAliases,
): void {
  const names = new Set<string>();

  for (const name of then_branch.assigned) {
    names.add(name);
  }

  for (const name of else_branch.assigned) {
    names.add(name);
  }

  for (const name of names) {
    if (!aliases.known.has(name)) {
      continue;
    }

    const field_owners: CoreFieldBorrowOwner[] = [];
    collect_branch_field_owner(name, aliases, then_branch, field_owners);
    collect_branch_field_owner(name, aliases, else_branch, field_owners);

    if (field_owners.length === 0) {
      aliases.field_owners.delete(name);
      continue;
    }

    bind_field_owner_alias(
      name,
      merge_field_owner_aliases(field_owners),
      aliases,
    );
  }
}

export function clear_borrow_alias(
  name: string,
  aliases: CoreBorrowAliases,
): void {
  aliases.owners.delete(name);
  aliases.field_owners.delete(name);
  aliases.views.delete(name);
}
