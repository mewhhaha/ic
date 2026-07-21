import type { CoreExpr, CoreStmt } from "../ast.ts";
import {
  bind_collection_loop_item_owner_alias,
  bind_field_owner_alias,
  bind_stored_borrow_view_alias,
  borrow_owner_name,
  canonical_owner_name,
  clear_borrow_alias,
  clone_borrow_aliases,
  clone_branch_borrow_aliases,
  direct_field_or_index_owner,
  if_let_payload_owner_ctx,
  merge_field_owner_aliases,
  merge_optional_branch_field_aliases,
  merge_required_branch_field_aliases,
  stored_borrow_view_for_value,
  stored_field_owner_for_value,
} from "./aliases.ts";
import { core_stmt_definitely_exits_sequence } from "./control.ts";
import type {
  CoreBorrowAliases,
  CoreBorrowHooks,
  CoreFieldBorrowOwner,
} from "./types.ts";

export function update_borrow_alias<ctx>(
  name: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
  annotation?: string,
): void {
  aliases.known.add(name);
  update_borrow_union_type_alias(name, annotation, ctx, hooks, aliases);
  const view = stored_borrow_view_for_value(value, aliases);

  if (view) {
    bind_stored_borrow_view_alias(name, view, aliases);
    return;
  }

  const field_owner = field_owner_result_for_value(value, ctx, hooks, aliases);

  if (field_owner) {
    bind_field_owner_alias(name, field_owner, aliases);
    return;
  }

  const owner = borrow_owner_name(value);

  if (!owner) {
    clear_borrow_alias(name, aliases);
    return;
  }

  aliases.views.delete(name);
  aliases.field_owners.delete(name);
  aliases.owners.set(name, canonical_owner_name(owner, aliases));
}

function update_borrow_union_type_alias<ctx>(
  name: string,
  annotation: string | undefined,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): void {
  if (!annotation) {
    return;
  }

  const type_value = hooks.static_value(annotation, ctx);

  if (type_value && type_value.tag === "union_type") {
    aliases.union_types.set(name, annotation);
    return;
  }

  aliases.union_types.delete(name);
}

export function field_owner_result_for_value<ctx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): CoreFieldBorrowOwner | undefined {
  if (value.tag === "block") {
    return field_owner_result_for_block(value, ctx, hooks, aliases);
  }

  const field_alias = stored_field_owner_for_value(value, aliases);

  if (field_alias) {
    return field_alias;
  }

  const field_owner = direct_field_or_index_owner(value, ctx, hooks, aliases);

  if (field_owner) {
    return field_owner;
  }

  if (value.tag === "if") {
    const owners: CoreFieldBorrowOwner[] = [];
    const then_owner = field_owner_result_for_value(
      value.then_branch,
      ctx,
      hooks,
      aliases,
    );

    if (then_owner) {
      owners.push(then_owner);
    }

    const else_owner = field_owner_result_for_value(
      value.else_branch,
      ctx,
      hooks,
      aliases,
    );

    if (else_owner) {
      owners.push(else_owner);
    }

    if (owners.length > 0) {
      return merge_field_owner_aliases(owners);
    }
  }

  if (value.tag === "if_let") {
    const owners: CoreFieldBorrowOwner[] = [];
    const then_aliases = clone_borrow_aliases(aliases);
    let then_ctx = ctx;

    if (value.value_name) {
      clear_borrow_alias(value.value_name, then_aliases);
      then_ctx = if_let_payload_owner_ctx(
        value.case_name,
        value.value_name,
        value.target,
        ctx,
        hooks,
      );
    }

    const then_owner = field_owner_result_for_value(
      value.then_branch,
      then_ctx,
      hooks,
      then_aliases,
    );

    if (then_owner) {
      owners.push(then_owner);
    }

    const else_owner = field_owner_result_for_value(
      value.else_branch,
      ctx,
      hooks,
      aliases,
    );

    if (else_owner) {
      owners.push(else_owner);
    }

    if (owners.length > 0) {
      return merge_field_owner_aliases(owners);
    }
  }

  return undefined;
}

function field_owner_result_for_block<ctx>(
  value: Extract<CoreExpr, { tag: "block" }>,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): CoreFieldBorrowOwner | undefined {
  const block_aliases = clone_borrow_aliases(aliases);
  let block_ctx = ctx;

  if (hooks.block_ctx && hooks.collect_stmt_locals) {
    block_ctx = hooks.block_ctx(ctx);
  }

  const result = update_block_field_aliases_for_result(
    value.statements,
    block_ctx,
    hooks,
    block_aliases,
  );

  if (!result) {
    return undefined;
  }

  return field_owner_result_for_value(result, block_ctx, hooks, block_aliases);
}

function update_block_field_aliases_for_result<ctx>(
  statements: CoreStmt[],
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): CoreExpr | undefined {
  if (statements.length === 0) {
    return undefined;
  }

  for (let index = 0; index + 1 < statements.length; index += 1) {
    const stmt = statements[index];

    if (!stmt) {
      throw new Error("Missing core field-owner block statement " + index);
    }

    update_field_aliases_for_stmt(stmt, ctx, hooks, aliases);

    if (core_stmt_definitely_exits_sequence(stmt)) {
      return undefined;
    }

    if (hooks.collect_stmt_locals) {
      hooks.collect_stmt_locals(stmt, ctx);
    }
  }

  const final_stmt = statements[statements.length - 1];

  if (!final_stmt) {
    throw new Error("Missing core field-owner block final statement");
  }

  if (final_stmt.tag === "expr") {
    return final_stmt.expr;
  }

  if (final_stmt.tag === "return") {
    return final_stmt.value;
  }

  update_field_aliases_for_stmt(final_stmt, ctx, hooks, aliases);
  return undefined;
}

function update_field_aliases_for_stmt<ctx>(
  stmt: CoreStmt,
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): void {
  switch (stmt.tag) {
    case "bind":
      aliases.known.add(stmt.name);
      update_borrow_alias(
        stmt.name,
        stmt.value,
        ctx,
        hooks,
        aliases,
        stmt.annotation,
      );
      return;

    case "assign":
      aliases.assigned.add(stmt.name);
      update_borrow_alias(stmt.name, stmt.value, ctx, hooks, aliases);
      return;

    case "range_loop": {
      const body_aliases = clone_branch_borrow_aliases(aliases);
      clear_borrow_alias(stmt.index, body_aliases);
      update_field_aliases_for_stmts(stmt.body, ctx, hooks, body_aliases);
      merge_optional_branch_field_aliases(aliases, body_aliases);
      return;
    }

    case "collection_loop": {
      const body_aliases = clone_branch_borrow_aliases(aliases);
      clear_borrow_alias(stmt.item, body_aliases);
      bind_collection_loop_item_owner_alias(
        stmt.item,
        stmt.collection,
        undefined,
        ctx,
        hooks,
        body_aliases,
      );

      if (stmt.index) {
        clear_borrow_alias(stmt.index, body_aliases);
      }

      update_field_aliases_for_stmts(stmt.body, ctx, hooks, body_aliases);
      merge_optional_branch_field_aliases(aliases, body_aliases);
      return;
    }

    case "if_stmt": {
      const body_aliases = clone_branch_borrow_aliases(aliases);
      update_field_aliases_for_stmts(stmt.body, ctx, hooks, body_aliases);
      merge_optional_branch_field_aliases(aliases, body_aliases);
      return;
    }

    case "if_else_stmt": {
      const then_aliases = clone_branch_borrow_aliases(aliases);
      update_field_aliases_for_stmts(
        stmt.then_body,
        ctx,
        hooks,
        then_aliases,
      );
      const else_aliases = clone_branch_borrow_aliases(aliases);
      update_field_aliases_for_stmts(
        stmt.else_body,
        ctx,
        hooks,
        else_aliases,
      );
      merge_required_branch_field_aliases(
        aliases,
        then_aliases,
        else_aliases,
      );
      return;
    }

    case "if_let_stmt": {
      const body_aliases = clone_branch_borrow_aliases(aliases);

      if (stmt.value_name) {
        clear_borrow_alias(stmt.value_name, body_aliases);
      }

      update_field_aliases_for_stmts(stmt.body, ctx, hooks, body_aliases);
      merge_optional_branch_field_aliases(aliases, body_aliases);
      return;
    }

    case "expr":
      return;

    case "type_check":
      return;

    case "return":
      return;

    case "index_assign":
    case "break":
    case "continue":
    case "unsupported":
      return;
  }
}

function update_field_aliases_for_stmts<ctx>(
  statements: CoreStmt[],
  ctx: ctx,
  hooks: CoreBorrowHooks<ctx>,
  aliases: CoreBorrowAliases,
): void {
  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];

    if (!stmt) {
      throw new Error("Missing core field-owner statement " + index);
    }

    update_field_aliases_for_stmt(stmt, ctx, hooks, aliases);

    if (core_stmt_definitely_exits_sequence(stmt)) {
      return;
    }
  }
}
