import { bind_drop_owner } from "./bind_owner.ts";
import { emit_drop } from "./emit.ts";
import {
  expr_consumes_owner_name,
  moved_expr_owner,
  unique_heap_ownership,
} from "./ownership.ts";
import { canonical_core_expr } from "../subject_provenance.ts";
import { core_expr_ownership } from "../ownership.ts";
import { static_scratch_aggregate_alias_materializes } from "../static_values.ts";
import { bind_static_drop_function } from "./static_function.ts";
import {
  drop_owner_ctx_is_scratch,
  should_skip_drop_owner_assign,
  should_skip_drop_owner_bind,
} from "./static_owner.ts";
import type {
  CoreDropExitOwners,
  CoreDropHooks,
  CoreDropOwner,
  CoreDropState,
  CoreExpr,
  CoreStmt,
} from "./types.ts";

type CoreDropExprChildrenScanner<ctx> = (
  expr: CoreExpr,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
) => boolean;

export function scan_drop_bind_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "bind" }>,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  scan_drop_expr_children: CoreDropExprChildrenScanner<ctx>,
): boolean {
  const value = hooks.core_binding_value(stmt, ctx);
  const owners_before_value = new Map(owners);
  scan_drop_expr_children(
    value,
    scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );
  restore_static_union_payload_owner(
    value,
    owners_before_value,
    owners,
    ctx,
    hooks,
    state,
  );
  record_static_aggregate_fields(stmt.name, value, ctx, hooks, state);

  const previous = owners.get(stmt.name);
  if (previous) {
    emit_drop("assignment_replace", scope, previous.name, previous, state);
    owners.delete(stmt.name);
  }

  if (
    (value.tag === "var" || value.tag === "linear") &&
    owners.has(value.name)
  ) {
    bind_drop_owner(stmt.name, value, owners, ctx, hooks, state);
    bind_static_drop_function(stmt.name, value, state);
    return true;
  }

  if (
    stmt.kind === "let" && stmt.annotation &&
    static_scratch_aggregate_alias_materializes(value)
  ) {
    owners.set(stmt.name, {
      name: stmt.name,
      ownership: { tag: "unique_heap", reason: "runtime_aggregate" },
      pointer: "named",
      subject: value,
    });
    bind_static_drop_function(stmt.name, value, state);
    return true;
  }

  const skip_owner = should_skip_drop_owner_bind(
    stmt.kind,
    stmt.name,
    stmt.annotation,
    value,
    ctx,
    hooks,
  );
  if (skip_owner) {
    if (
      bind_static_union_payload_temporary_owner(
        stmt.name,
        value,
        owners,
        ctx,
        hooks,
        state,
      )
    ) {
      bind_static_drop_function(stmt.name, value, state);
      return true;
    }
    owners.delete(stmt.name);
    bind_static_drop_function(stmt.name, value, state);
    return true;
  }

  bind_drop_owner(stmt.name, value, owners, ctx, hooks, state);
  bind_static_drop_function(stmt.name, value, state);
  return true;
}

function restore_static_union_payload_owner<ctx>(
  expr: CoreExpr,
  before: Map<string, CoreDropOwner>,
  owners: Map<string, CoreDropOwner>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  if (!hooks.static_value) {
    return;
  }
  const static_value = hooks.static_value(expr, ctx);
  if (
    !static_value || static_value.tag !== "union_case" ||
    !static_value.value
  ) {
    return;
  }
  const payload_owner = moved_expr_owner(static_value.value, owners, state);
  if (!payload_owner || !payload_owner.subject) {
    return;
  }
  const payload_subject = canonical_core_expr(payload_owner.subject);
  for (const [name, owner] of before) {
    if (owner.ownership.reason !== payload_owner.ownership.reason) {
      continue;
    }
    if (!owner.subject) {
      continue;
    }
    if (canonical_core_expr(owner.subject) !== payload_subject) {
      continue;
    }
    owners.set(name, owner);
    return;
  }
}

export function scan_drop_assign_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "assign" }>,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  scan_drop_expr_children: CoreDropExprChildrenScanner<ctx>,
): boolean {
  const value = hooks.core_assignment_value(stmt, ctx);
  const previous = owners.get(stmt.name);
  if (
    previous &&
    !expr_consumes_owner_name(value, stmt.name, owners, state)
  ) {
    emit_drop(
      "assignment_replace",
      scope,
      previous.name,
      previous,
      state,
      undefined,
      stmt,
    );
    owners.delete(stmt.name);
  }

  scan_drop_expr_children(
    value,
    scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );
  record_static_aggregate_fields(stmt.name, value, ctx, hooks, state);
  if (static_scratch_aggregate_alias_materializes(value)) {
    owners.set(stmt.name, {
      name: stmt.name,
      ownership: { tag: "unique_heap", reason: "runtime_aggregate" },
      pointer: "named",
      subject: value,
    });
    bind_static_drop_function(stmt.name, value, state);
    return true;
  }
  if (should_skip_drop_owner_assign(stmt.name, value, ctx, hooks)) {
    if (
      bind_static_union_payload_temporary_owner(
        stmt.name,
        value,
        owners,
        ctx,
        hooks,
        state,
      )
    ) {
      bind_static_drop_function(stmt.name, value, state);
      return true;
    }
    owners.delete(stmt.name);
    bind_static_drop_function(stmt.name, value, state);
    return true;
  }

  bind_drop_owner(stmt.name, value, owners, ctx, hooks, state);
  bind_static_drop_function(stmt.name, value, state);
  return true;
}

function bind_static_union_payload_temporary_owner<ctx>(
  name: string,
  value: CoreExpr,
  owners: Map<string, CoreDropOwner>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): boolean {
  if (drop_owner_ctx_is_scratch(ctx)) {
    return false;
  }
  if (!hooks.static_value) {
    return false;
  }
  const static_value = hooks.static_value(value, ctx);
  if (
    !static_value || static_value.tag !== "union_case" ||
    !static_value.value
  ) {
    return false;
  }
  const payload = static_value.value;
  if (moved_expr_owner(payload, owners, state)) {
    return false;
  }
  if (payload.tag === "var" || payload.tag === "linear") {
    return false;
  }
  const ownership = unique_heap_ownership(payload, ctx, hooks);
  if (!ownership) {
    return false;
  }
  const payload_subject = canonical_core_expr(payload);
  for (const owner of owners.values()) {
    if (owner.ownership.reason !== ownership.reason || !owner.subject) {
      continue;
    }
    if (canonical_core_expr(owner.subject) === payload_subject) {
      return false;
    }
  }
  owners.set(name, {
    name,
    ownership,
    pointer: "temporary",
    subject: payload,
  });
  return true;
}

export function scan_drop_index_assign_stmt<ctx>(
  stmt: Extract<CoreStmt, { tag: "index_assign" }>,
  scope: string,
  owners: Map<string, CoreDropOwner>,
  exit_owners: CoreDropExitOwners,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  scan_drop_expr_children: CoreDropExprChildrenScanner<ctx>,
): boolean {
  const assigned_ownership = unique_heap_ownership(stmt.value, ctx, hooks);
  if (
    assigned_ownership &&
    (assigned_ownership.reason === "text" ||
      assigned_ownership.reason === "bytes" ||
      assigned_ownership.reason === "runtime_union")
  ) {
    state.consumed_temporary_subjects.add(stmt.value);
    state.consumed_temporary_subjects.add(
      canonical_core_expr(stmt.value),
    );
  }
  scan_drop_expr_children(
    stmt.index,
    scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );
  scan_drop_expr_children(
    stmt.value,
    scope,
    owners,
    exit_owners,
    ctx,
    hooks,
    state,
  );
  update_static_aggregate_index_field(stmt, ctx, hooks, state);
  return true;
}

function record_static_aggregate_fields<ctx>(
  name: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  let ownership;
  try {
    ownership = core_expr_ownership(value, ctx, {
      ...hooks,
      if_let_branch_ctx: undefined,
    });
  } catch {
    ownership = undefined;
  }
  if (
    (ownership && ownership.tag === "frozen_shareable" &&
      ownership.reason === "runtime_aggregate") ||
    aggregate_value_has_final_freeze(value)
  ) {
    state.frozen_aggregate_owners.add(name);
  } else {
    state.frozen_aggregate_owners.delete(name);
  }
  if (
    ownership && ownership.tag === "frozen_shareable" &&
    hooks.core_expr_is_text(value, ctx)
  ) {
    state.frozen_text_owners.add(name);
  } else {
    state.frozen_text_owners.delete(name);
  }
  let struct_value = hooks.static_struct_value(value, ctx);
  const direct_struct = direct_static_drop_struct_value(value);
  const alias = direct_static_drop_aggregate_alias(value);
  if (alias) {
    const alias_fields = state.static_aggregate_fields.get(alias);
    if (alias_fields) {
      state.static_aggregate_fields.set(name, {
        field_names: [...alias_fields.field_names],
        static_texts: new Set(alias_fields.static_texts),
      });
      return;
    }
  }
  if (!struct_value) {
    struct_value = direct_struct;
  }
  if (!struct_value) {
    state.static_aggregate_fields.delete(name);
    return;
  }
  const field_names: string[] = [];
  const static_texts = new Set<string>();
  for (const field of struct_value.fields) {
    field_names.push(field.name);
  }
  collect_static_drop_text_fields(
    struct_value.fields,
    "",
    ctx,
    hooks,
    state,
    static_texts,
    new Set(),
  );
  if (direct_struct && direct_struct !== struct_value) {
    collect_static_drop_text_fields(
      direct_struct.fields,
      "",
      ctx,
      hooks,
      state,
      static_texts,
      new Set(),
    );
  }
  state.static_aggregate_fields.set(name, { field_names, static_texts });
}

function aggregate_value_has_final_freeze(value: CoreExpr): boolean {
  if (value.tag === "freeze") {
    return true;
  }
  if (value.tag === "scratch") {
    return aggregate_value_has_final_freeze(value.body);
  }
  if (value.tag === "borrow") {
    return aggregate_value_has_final_freeze(value.value);
  }
  if (value.tag === "if") {
    return aggregate_value_has_final_freeze(value.then_branch) &&
      aggregate_value_has_final_freeze(value.else_branch);
  }
  if (value.tag !== "block") {
    return false;
  }
  const final_stmt = value.statements[value.statements.length - 1];
  if (!final_stmt) {
    return false;
  }
  if (final_stmt.tag === "expr") {
    return aggregate_value_has_final_freeze(final_stmt.expr);
  }
  if (final_stmt.tag === "return") {
    return aggregate_value_has_final_freeze(final_stmt.value);
  }
  if (final_stmt.tag === "break" && final_stmt.value) {
    return aggregate_value_has_final_freeze(final_stmt.value);
  }
  return false;
}

function collect_static_drop_text_fields<ctx>(
  fields: import("../ast.ts").CoreField[],
  prefix: string,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
  static_texts: Set<string>,
  visiting: Set<string>,
): void {
  for (const field of fields) {
    let path = field.name;
    if (prefix !== "") {
      path = prefix + "." + field.name;
    }
    if (
      field.value.tag === "text" ||
      hooks.static_text_value(field.value, ctx)
    ) {
      static_texts.add(path);
    }
    let next_visiting = visiting;
    if (field.value.tag === "var" || field.value.tag === "linear") {
      if (state.frozen_text_owners.has(field.value.name)) {
        static_texts.add(path);
      }
      const nested_fields = state.static_aggregate_fields.get(field.value.name);
      if (nested_fields && !visiting.has(field.value.name)) {
        next_visiting = new Set(visiting);
        next_visiting.add(field.value.name);
        for (const nested_path of nested_fields.static_texts) {
          static_texts.add(path + "." + nested_path);
        }
      }
    }
    let nested = direct_static_drop_struct_value(field.value);
    if (!nested) {
      nested = hooks.static_struct_value(field.value, ctx);
    }
    if (nested) {
      collect_static_drop_text_fields(
        nested.fields,
        path,
        ctx,
        hooks,
        state,
        static_texts,
        next_visiting,
      );
    }
  }
}

function direct_static_drop_struct_value(
  value: CoreExpr,
): Extract<CoreExpr, { tag: "struct_value" }> | undefined {
  if (value.tag === "struct_value") {
    return value;
  }
  if (value.tag === "scratch") {
    return direct_static_drop_struct_value(value.body);
  }
  if (value.tag === "borrow" || value.tag === "freeze") {
    return direct_static_drop_struct_value(value.value);
  }
  if (value.tag !== "block") {
    return undefined;
  }
  const final_stmt = value.statements[value.statements.length - 1];
  if (!final_stmt) {
    return undefined;
  }
  if (final_stmt.tag === "expr") {
    return direct_static_drop_struct_value(final_stmt.expr);
  }
  if (final_stmt.tag === "return") {
    return direct_static_drop_struct_value(final_stmt.value);
  }
  if (final_stmt.tag === "break" && final_stmt.value) {
    return direct_static_drop_struct_value(final_stmt.value);
  }
  return undefined;
}

function direct_static_drop_aggregate_alias(
  value: CoreExpr,
): string | undefined {
  if (value.tag === "var" || value.tag === "linear") {
    return value.name;
  }
  if (value.tag === "scratch") {
    return direct_static_drop_aggregate_alias(value.body);
  }
  if (value.tag === "borrow" || value.tag === "freeze") {
    return direct_static_drop_aggregate_alias(value.value);
  }
  if (value.tag !== "block") {
    return undefined;
  }
  const final_stmt = value.statements[value.statements.length - 1];
  if (!final_stmt) {
    return undefined;
  }
  if (final_stmt.tag === "expr") {
    return direct_static_drop_aggregate_alias(final_stmt.expr);
  }
  if (final_stmt.tag === "return") {
    return direct_static_drop_aggregate_alias(final_stmt.value);
  }
  if (final_stmt.tag === "break" && final_stmt.value) {
    return direct_static_drop_aggregate_alias(final_stmt.value);
  }
  return undefined;
}

function update_static_aggregate_index_field<ctx>(
  stmt: Extract<CoreStmt, { tag: "index_assign" }>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  const fields = state.static_aggregate_fields.get(stmt.name);
  if (!fields) {
    return;
  }
  if (
    stmt.index.tag !== "num" || stmt.index.type !== "i32" ||
    typeof stmt.index.value !== "number"
  ) {
    fields.static_texts.clear();
    return;
  }
  const field_name = fields.field_names[stmt.index.value];
  if (!field_name) {
    fields.static_texts.clear();
    return;
  }
  for (const path of Array.from(fields.static_texts)) {
    if (path === field_name || path.startsWith(field_name + ".")) {
      fields.static_texts.delete(path);
    }
  }
  if (
    stmt.value.tag === "text" || hooks.static_text_value(stmt.value, ctx)
  ) {
    fields.static_texts.add(field_name);
  }
}
