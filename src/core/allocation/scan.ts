import type { CoreExpr, CoreField, CoreFnType, CoreStmt } from "../ast.ts";
import { scan_allocation_block } from "./block.ts";
import { scan_closure_body_allocations } from "./closure.ts";
import {
  freeze_copies_runtime_aggregate,
  freeze_copies_runtime_union,
  freeze_promotes_runtime_aggregate,
  freeze_promotes_runtime_closure,
  freeze_promotes_runtime_text,
  freeze_promotes_runtime_union,
  record_runtime_aggregate_freeze_copy_allocations,
  record_runtime_union_freeze_copy_allocations,
} from "./freeze.ts";
import {
  scan_allocation_if_let_expr,
  scan_allocation_if_let_stmt,
} from "./if_let.ts";
import { core_expr_ownership } from "../ownership.ts";
import { mutable_static_owner_value_materializes } from "../mutable_static_owner.ts";
import {
  runtime_aggregate_layout,
  runtime_aggregate_layout_for_type,
} from "../runtime_aggregate.ts";
import type { RuntimeAggregateField } from "../runtime_aggregate.ts";
import { core_runtime_slice_fact } from "../runtime_slice.ts";
import {
  core_bytes_generate_args,
  core_bytes_generator_call,
} from "../runtime_bytes.ts";
import {
  core_runtime_buffer_builtin,
  runtime_buffer_allocation,
} from "../runtime_buffer.ts";
import { canonical_core_expr } from "../subject_provenance.ts";
import {
  static_scratch_aggregate_alias_materializes,
  static_scratch_block_result_value,
} from "../static_values.ts";
import {
  static_block_result,
  static_type_value,
  type TypeStaticCtx,
} from "../type_static.ts";
import { record_allocation } from "./record.ts";
import {
  core_allocation_fact_subject,
  register_core_allocation_fact_destination,
  register_core_allocation_fact_emission_subject,
  register_core_allocation_fact_freeze,
  register_core_allocation_fact_lifetime_subject,
  register_core_allocation_fact_owning_parent,
  set_core_allocation_fact_external,
  unregister_core_allocation_fact_owning_parent,
} from "./metadata.ts";
import {
  record_runtime_union_allocations,
  runtime_union_allocation_value,
  runtime_union_value_materializes,
} from "./runtime_union.ts";
import {
  allocation_stmt_value_is_static_call_target,
  scoped_static_allocation_call_value,
} from "./static_call.ts";
import {
  scan_static_value_allocation_expr,
  static_value_materializes_runtime_union_owner,
} from "./static_value.ts";
import type {
  CoreAllocationHooks,
  CoreAllocationScope,
  CoreAllocationState,
} from "./types.ts";

export function scan_allocation_stmts<ctx>(
  statements: CoreStmt[],
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  for (const stmt of statements) {
    scan_allocation_stmt(stmt, scope, ctx, hooks, state);
  }
}

export function scan_allocation_scoped_stmts<ctx>(
  statements: CoreStmt[],
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  if (!hooks.block_ctx || !hooks.collect_stmt_locals) {
    scan_allocation_stmts(statements, scope, ctx, hooks, state);
    return;
  }

  const scoped_ctx = hooks.block_ctx(ctx);

  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];

    if (!stmt) {
      throw new Error("Missing allocation scoped statement");
    }

    scan_allocation_stmt(stmt, scope, scoped_ctx, hooks, state);

    if (index + 1 < statements.length) {
      hooks.collect_stmt_locals(stmt, scoped_ctx);
    }
  }
}

type AllocationBindingSnapshot = {
  bindings: Map<string, CoreAllocationState["facts"]>;
  runtime: Set<string>;
  static_closures: CoreAllocationState["static_closure_bindings"];
};

function snapshot_allocation_bindings(
  state: CoreAllocationState,
): AllocationBindingSnapshot {
  const bindings = new Map<string, CoreAllocationState["facts"]>();
  for (const [name, facts] of state.binding_allocations) {
    bindings.set(name, [...facts]);
  }
  return {
    bindings,
    runtime: new Set(state.runtime_bindings),
    static_closures: new Map(state.static_closure_bindings),
  };
}

function restore_allocation_bindings(
  state: CoreAllocationState,
  snapshot: AllocationBindingSnapshot,
): void {
  state.binding_allocations = new Map(snapshot.bindings);
  state.runtime_bindings = new Set(snapshot.runtime);
  state.static_closure_bindings = new Map(snapshot.static_closures);
}

function merge_allocation_binding_snapshots(
  state: CoreAllocationState,
  left: AllocationBindingSnapshot,
  right: AllocationBindingSnapshot,
): void {
  const names = new Set<string>();
  for (const name of left.bindings.keys()) {
    names.add(name);
  }
  for (const name of right.bindings.keys()) {
    names.add(name);
  }
  for (const name of names) {
    const facts: CoreAllocationState["facts"] = [];
    const seen = new Set<string>();
    const candidates = [
      ...(left.bindings.get(name) || []),
      ...(right.bindings.get(name) || []),
    ];
    for (const fact of candidates) {
      if (seen.has(fact.allocation_id)) {
        continue;
      }
      seen.add(fact.allocation_id);
      facts.push(fact);
    }
    if (facts.length > 0) {
      state.binding_allocations.set(name, facts);
    }
  }
  for (const name of left.runtime) {
    state.runtime_bindings.add(name);
  }
  for (const name of right.runtime) {
    state.runtime_bindings.add(name);
  }
  for (const [name, closure] of left.static_closures) {
    const right_closure = right.static_closures.get(name);
    if (right_closure === closure) {
      state.static_closure_bindings.set(name, closure);
    }
  }
}

function scan_allocation_stmt<ctx>(
  stmt: CoreStmt,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  switch (stmt.tag) {
    case "bind": {
      const allocation_start = state.facts.length;
      const value = hooks.core_binding_value(stmt, ctx);
      if (
        bind_extracted_runtime_aggregate_resume(
          stmt,
          value,
          ctx,
          hooks,
          state,
        )
      ) {
        register_normalized_allocation_value(stmt.value, value, state);
        return;
      }
      if (bind_existing_closure_allocation(stmt.name, value, state)) {
        return;
      }
      if (
        bind_existing_closure_call_result(
          stmt.name,
          value,
          scope,
          ctx,
          hooks,
          state,
        )
      ) {
        return;
      }
      if (
        bind_existing_static_owner_allocations(
          stmt.name,
          value,
          ctx,
          hooks,
          state,
        )
      ) {
        return;
      }
      if (
        bind_static_closure_alias(
          stmt.name,
          value,
          ctx,
          hooks,
          state,
        )
      ) {
        return;
      }
      if (
        allocation_stmt_value_is_static_call_target(stmt, ctx, hooks)
      ) {
        if (value.tag !== "lam") {
          throw new Error("Static allocation call target must be a lambda");
        }
        state.static_closure_bindings.set(stmt.name, value);
        update_runtime_allocation_binding(
          stmt.name,
          value,
          allocation_start,
          state,
        );
        return;
      }

      if (
        value.tag !== "freeze" &&
        hooks.is_static_value_expr(value, ctx)
      ) {
        const static_setup = scan_static_value_allocation_setup(
          value,
          scope,
          ctx,
          hooks,
          state,
        );
        let materializes_runtime_union = false;
        const runtime_union_value = runtime_union_allocation_value(
          value,
          ctx,
          hooks,
        );
        let dynamic_runtime_union = false;
        if (runtime_union_value) {
          dynamic_runtime_union = runtime_union_value.tag === "if";
        }
        if (
          (state.mutable_bindings.has(stmt.name) ||
            hooks.mutable_binding(stmt.name, ctx) || dynamic_runtime_union) &&
          value.tag !== "scratch" &&
          static_setup?.tag !== "union_case" &&
          !state.nonmaterialized_union_values.has(value)
        ) {
          materializes_runtime_union =
            static_value_materializes_runtime_union_owner(
              value,
              !!stmt.annotation,
              ctx,
              hooks,
            );
        }
        let static_struct;
        if (!static_setup) {
          static_struct = scan_mutable_static_struct_allocation(
            stmt.name,
            value,
            "bind:" + stmt.name + ":" + allocation_start.toString(),
            scope,
            ctx,
            hooks,
            state,
            (state.materialized_bindings.has(stmt.name) ||
              hooks.materialized_binding(stmt.name, ctx)) &&
              value.tag !== "scratch" &&
              !scope.scratch,
          );
        }
        if (!static_struct) {
          static_struct = scan_static_value_allocation_expr(
            value,
            scope,
            ctx,
            hooks,
            state,
            materializes_runtime_union,
            "bind:" + stmt.name + ":" + allocation_start.toString(),
            scan_allocation_expr,
            scan_allocation_fields,
          );
        }
        scan_static_composite_closure_value(
          value,
          scope,
          ctx,
          hooks,
          state,
        );
        if (static_setup && stmt.annotation) {
          const has_scratch_aggregate = state.facts.slice(allocation_start)
            .some((fact) => {
              return fact.reason === "runtime_aggregate" &&
                fact.storage === "scratch_arena";
            });
          if (
            has_scratch_aggregate ||
            static_scratch_aggregate_alias_materializes(value)
          ) {
            const parent = record_allocation(
              value,
              "runtime_aggregate",
              { name: scope.name, scratch: undefined },
              state,
            );
            if (parent) {
              register_core_allocation_fact_emission_subject(
                parent,
                static_setup,
              );
            }
          }
        }
        if (static_struct) {
          const static_facts = state.facts.slice(allocation_start);
          if (static_facts.length > 0) {
            set_value_allocation_facts(value, static_facts, state);
          }
        } else if (
          !materializes_runtime_union &&
          hooks.runtime_union_value(value, ctx)
        ) {
          const static_facts = state.facts.slice(allocation_start);
          if (static_facts.length > 0) {
            set_value_allocation_facts(value, static_facts, state);
          }
        }
        register_normalized_allocation_value(stmt.value, value, state);
        mark_bound_allocation_owner(state, allocation_start, stmt.name);
        update_runtime_allocation_binding(
          stmt.name,
          value,
          allocation_start,
          state,
        );
        return;
      }

      const previous_instance = state.current_allocation_instance;
      state.current_allocation_instance = "bind:" + stmt.name + ":" +
        allocation_start.toString();
      try {
        scan_allocation_expr(value, scope, ctx, hooks, state);
      } finally {
        state.current_allocation_instance = previous_instance;
      }
      mark_bound_allocation_owner(state, allocation_start, stmt.name);
      record_closure_call_result_allocation(
        value,
        stmt.name,
        scope,
        ctx,
        hooks,
        state,
      );
      update_runtime_allocation_binding(
        stmt.name,
        value,
        allocation_start,
        state,
      );
      register_normalized_allocation_value(stmt.value, value, state);
      return;
    }

    case "assign": {
      const allocation_start = state.facts.length;
      const value = hooks.core_assignment_value(stmt, ctx);
      state.static_closure_bindings.delete(stmt.name);
      if (bind_existing_closure_allocation(stmt.name, value, state)) {
        return;
      }
      if (
        bind_existing_closure_call_result(
          stmt.name,
          value,
          scope,
          ctx,
          hooks,
          state,
        )
      ) {
        return;
      }
      if (
        bind_existing_static_owner_allocations(
          stmt.name,
          value,
          ctx,
          hooks,
          state,
        )
      ) {
        return;
      }

      if (
        value.tag !== "freeze" &&
        hooks.is_static_value_expr(value, ctx)
      ) {
        const previous_facts = state.binding_allocations.get(stmt.name);
        let assigns_runtime_union_owner = false;
        if (previous_facts) {
          assigns_runtime_union_owner = previous_facts.some((fact) => {
            return fact.reason === "runtime_union";
          });
        }
        const static_setup = scan_static_value_allocation_setup(
          value,
          scope,
          ctx,
          hooks,
          state,
        );
        let materializes_runtime_union = false;
        const runtime_union_value = runtime_union_allocation_value(
          value,
          ctx,
          hooks,
        );
        let dynamic_runtime_union = false;
        if (runtime_union_value) {
          dynamic_runtime_union = runtime_union_value.tag === "if";
        }
        if (
          (state.mutable_bindings.has(stmt.name) ||
            hooks.mutable_binding(stmt.name, ctx) || dynamic_runtime_union) &&
          value.tag !== "scratch" &&
          static_setup?.tag !== "union_case" &&
          !state.nonmaterialized_union_values.has(value)
        ) {
          materializes_runtime_union =
            static_value_materializes_runtime_union_owner(
              value,
              assigns_runtime_union_owner,
              ctx,
              hooks,
            );
        }
        let static_struct;
        if (!static_setup) {
          static_struct = scan_mutable_static_struct_allocation(
            stmt.name,
            value,
            "assign:" + stmt.name + ":" + allocation_start.toString(),
            scope,
            ctx,
            hooks,
            state,
          );
        }
        if (!static_struct) {
          static_struct = scan_static_value_allocation_expr(
            value,
            scope,
            ctx,
            hooks,
            state,
            materializes_runtime_union,
            "assign:" + stmt.name + ":" + allocation_start.toString(),
            scan_allocation_expr,
            scan_allocation_fields,
          );
        }
        scan_static_composite_closure_value(
          value,
          scope,
          ctx,
          hooks,
          state,
        );
        if (static_setup) {
          const has_scratch_aggregate = state.facts.slice(allocation_start)
            .some((fact) => {
              return fact.reason === "runtime_aggregate" &&
                fact.storage === "scratch_arena";
            });
          if (
            has_scratch_aggregate ||
            static_scratch_aggregate_alias_materializes(value)
          ) {
            const parent = record_allocation(
              value,
              "runtime_aggregate",
              { name: scope.name, scratch: undefined },
              state,
            );
            if (parent) {
              register_core_allocation_fact_emission_subject(
                parent,
                static_setup,
              );
            }
          }
        }
        if (static_struct) {
          const static_facts = state.facts.slice(allocation_start);
          if (static_facts.length > 0) {
            set_value_allocation_facts(value, static_facts, state);
          }
        } else if (
          !materializes_runtime_union &&
          hooks.runtime_union_value(value, ctx)
        ) {
          const static_facts = state.facts.slice(allocation_start);
          if (static_facts.length > 0) {
            set_value_allocation_facts(value, static_facts, state);
          }
        }
        register_normalized_allocation_value(stmt.value, value, state);
        mark_bound_allocation_owner(state, allocation_start, stmt.name);
        update_runtime_allocation_binding(
          stmt.name,
          value,
          allocation_start,
          state,
        );
        return;
      }

      const previous_instance = state.current_allocation_instance;
      state.current_allocation_instance = "assign:" + stmt.name + ":" +
        allocation_start.toString();
      try {
        scan_allocation_expr(value, scope, ctx, hooks, state);
      } finally {
        state.current_allocation_instance = previous_instance;
      }
      mark_bound_allocation_owner(state, allocation_start, stmt.name);
      record_closure_call_result_allocation(
        value,
        stmt.name,
        scope,
        ctx,
        hooks,
        state,
      );
      update_runtime_allocation_binding(
        stmt.name,
        value,
        allocation_start,
        state,
      );
      register_normalized_allocation_value(stmt.value, value, state);
      return;
    }

    case "index_assign": {
      scan_allocation_expr(stmt.index, scope, ctx, hooks, state);
      // Index assignment writes a static aggregate literal directly into the
      // destination slot.  Scanning it as a materialized expression would
      // invent an allocation fact for that temporary RHS, even though no
      // runtime aggregate is emitted.  Keep scanning through the existing
      // nonmaterialized path so nested runtime children are still discovered
      // for destination/ownership linking below.
      const value_allocation_start = state.facts.length;
      scan_nonmaterialized_static_struct_expr(
        stmt.value,
        scope,
        ctx,
        hooks,
        state,
      );
      const value_facts = state.facts.slice(value_allocation_start);
      if (value_facts.length > 0) {
        // Keep legitimate allocations discovered in nested fields available
        // to destination/owned-child linking, without adding a fact for the
        // nonmaterialized aggregate wrapper itself.
        set_value_allocation_facts(stmt.value, value_facts, state);
      }
      register_index_assignment_allocation_destinations(
        stmt,
        ctx,
        hooks,
        state,
      );
      return;
    }

    case "range_loop":
      scan_allocation_expr(stmt.start, scope, ctx, hooks, state);
      scan_allocation_expr(stmt.end, scope, ctx, hooks, state);
      scan_allocation_expr(stmt.step, scope, ctx, hooks, state);
      scan_allocation_loop_stmts(stmt, scope, ctx, hooks, state);
      return;

    case "collection_loop":
      scan_nonmaterialized_static_struct_expr(
        stmt.collection,
        scope,
        ctx,
        hooks,
        state,
      );
      scan_allocation_loop_stmts(stmt, scope, ctx, hooks, state);
      return;

    case "if_stmt": {
      scan_allocation_expr(stmt.cond, scope, ctx, hooks, state);
      const before = snapshot_allocation_bindings(state);
      scan_allocation_scoped_stmts(stmt.body, scope, ctx, hooks, state);
      const branch = snapshot_allocation_bindings(state);
      restore_allocation_bindings(state, before);
      merge_allocation_binding_snapshots(state, branch, before);
      return;
    }

    case "if_else_stmt": {
      scan_allocation_expr(stmt.cond, scope, ctx, hooks, state);
      const before = snapshot_allocation_bindings(state);
      scan_allocation_scoped_stmts(
        stmt.then_body,
        scope,
        ctx,
        hooks,
        state,
      );
      const then_branch = snapshot_allocation_bindings(state);
      restore_allocation_bindings(state, before);
      scan_allocation_scoped_stmts(
        stmt.else_body,
        scope,
        ctx,
        hooks,
        state,
      );
      const else_branch = snapshot_allocation_bindings(state);
      restore_allocation_bindings(state, before);
      merge_allocation_binding_snapshots(
        state,
        then_branch,
        else_branch,
      );
      return;
    }

    case "if_let_stmt":
      scan_allocation_if_let_stmt(
        stmt,
        scope,
        ctx,
        hooks,
        state,
        scan_allocation_expr,
        scan_allocation_scoped_stmts,
      );
      return;

    case "type_check":
      scan_allocation_expr(stmt.target, scope, ctx, hooks, state);
      return;

    case "return":
      scan_allocation_expr(stmt.value, scope, ctx, hooks, state);
      return;

    case "expr":
      scan_allocation_expr(stmt.expr, scope, ctx, hooks, state);
      return;

    case "break":
      if (stmt.value) {
        scan_allocation_expr(stmt.value, scope, ctx, hooks, state);
      }
      return;
    case "continue":
    case "unsupported":
      return;
  }
}

function scan_allocation_loop_stmts<ctx>(
  stmt: Extract<CoreStmt, { tag: "range_loop" | "collection_loop" }>,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  let iterations = 1;
  let static_collection = false;
  if (stmt.tag === "collection_loop") {
    const fields = hooks.static_collection_fields(stmt.collection, ctx);
    if (fields) {
      iterations = fields.length;
      static_collection = true;
    }
  }

  if (!hooks.block_ctx || !hooks.collect_stmt_locals) {
    for (let index = 0; index < iterations; index += 1) {
      scan_allocation_loop_body(
        stmt.body,
        scope,
        ctx,
        hooks,
        state,
        static_collection,
        index,
      );
    }
    return;
  }

  const loop_ctx = hooks.block_ctx(ctx);
  hooks.collect_stmt_locals(stmt, loop_ctx);
  for (let index = 0; index < iterations; index += 1) {
    scan_allocation_loop_body(
      stmt.body,
      scope,
      loop_ctx,
      hooks,
      state,
      static_collection,
      index,
    );
  }
}

function scan_allocation_loop_body<ctx>(
  statements: CoreStmt[],
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
  static_collection: boolean,
  iteration: number,
): void {
  const previous_instance = state.current_allocation_instance;
  if (static_collection) {
    let prefix = "";
    if (previous_instance) {
      prefix = previous_instance + "/";
    }
    state.current_allocation_instance = prefix + "collection_loop:" +
      iteration.toString();
  }
  try {
    scan_allocation_stmts(statements, scope, ctx, hooks, state);
  } finally {
    state.current_allocation_instance = previous_instance;
  }
}

function mark_bound_allocation_owner(
  state: CoreAllocationState,
  start: number,
  owner: string,
): void {
  for (let index = start; index < state.facts.length; index += 1) {
    const fact = state.facts[index];
    if (!fact) {
      continue;
    }

    if (fact.owner) {
      continue;
    }

    fact.owner = owner;
  }
}

function bind_extracted_runtime_aggregate_resume<ctx>(
  stmt: Extract<CoreStmt, { tag: "bind" }>,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): boolean {
  if (!stmt.is_linear || value.tag !== "field" || !value.resume_signature) {
    return false;
  }
  if (value.object.tag !== "var" && value.object.tag !== "linear") {
    return false;
  }
  if (!hooks.runtime_aggregate_type_expr) {
    return false;
  }
  const type_expr = hooks.runtime_aggregate_type_expr(value.object, ctx);
  if (!type_expr) {
    return false;
  }
  const layout = runtime_aggregate_layout_for_type(
    type_expr,
    ctx as ctx & TypeStaticCtx,
  );
  const field = layout.fields.find((candidate) => {
    return candidate.name === value.name;
  });
  if (!field || field.tag !== "value" || !field.resume) {
    return false;
  }
  const parent_facts = state.binding_allocations.get(value.object.name);
  if (!parent_facts) {
    throw new Error(
      "Missing Resume field allocation parent: " + value.object.name,
    );
  }
  const children: CoreAllocationState["facts"] = [];
  const seen = new Set<string>();
  let found_parent = false;
  for (const parent of parent_facts) {
    if (
      parent.reason !== "runtime_aggregate" ||
      parent.storage !== "persistent_unique_heap"
    ) {
      continue;
    }
    found_parent = true;
    const owned_children = parent.owned_children || [];
    const extracted = owned_children.find((candidate) => {
      return candidate.offset === field.offset &&
        candidate.ownership.reason === "closure";
    });
    if (!extracted) {
      throw new Error(
        "Missing owned Resume field allocation: " + value.name,
      );
    }
    const retained = owned_children.filter((candidate) => {
      return candidate !== extracted;
    });
    if (retained.length > 0) {
      parent.owned_children = retained;
    } else {
      delete parent.owned_children;
    }
    for (const allocation_id of extracted.allocation_ids) {
      if (seen.has(allocation_id)) {
        continue;
      }
      const child = state.facts.find((candidate) => {
        return candidate.allocation_id === allocation_id;
      });
      if (!child || child.reason !== "closure") {
        throw new Error(
          "Missing Resume closure allocation: " + allocation_id,
        );
      }
      seen.add(allocation_id);
      child.owner = stmt.name;
      children.push(child);
      unregister_core_allocation_fact_owning_parent(child, parent);
    }
  }
  if (!found_parent || children.length === 0) {
    throw new Error(
      "Missing persistent Resume field allocation parent: " +
        value.object.name,
    );
  }
  set_value_allocation_facts(value, children, state);
  state.binding_allocations.set(stmt.name, children);
  state.runtime_bindings.add(stmt.name);
  for (const child of children) {
    register_core_allocation_fact_emission_subject(child, value);
  }
  return true;
}

function bind_existing_closure_allocation(
  name: string,
  value: CoreExpr,
  state: CoreAllocationState,
): boolean {
  if (value.tag !== "lam" && value.tag !== "rec") {
    return false;
  }
  const facts = state.value_allocations.get(value);
  if (!facts || facts.length === 0) {
    return false;
  }
  state.binding_allocations.set(name, [...facts]);
  state.runtime_bindings.add(name);
  return true;
}

function bind_existing_closure_call_result<ctx>(
  name: string,
  value: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): boolean {
  if (value.tag !== "app") {
    return false;
  }
  if (!set_closure_call_result_allocations(value, state)) {
    return false;
  }
  const facts = state.value_allocations.get(value);
  if (!facts || facts.length === 0) {
    return false;
  }
  for (const arg of value.args) {
    scan_allocation_expr(arg, scope, ctx, hooks, state);
  }
  state.binding_allocations.set(name, [...facts]);
  state.runtime_bindings.add(name);
  return true;
}

function bind_existing_static_owner_allocations<ctx>(
  name: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): boolean {
  if (value.tag !== "var" && value.tag !== "linear") {
    return false;
  }
  const struct_value = hooks.static_struct_value(value, ctx);
  const union_value = hooks.runtime_union_value(value, ctx);
  if (!struct_value && !union_value) {
    return false;
  }
  const source = state.binding_allocations.get(value.name);
  if (!source || source.length === 0) {
    return false;
  }
  const facts = source.filter((fact) => fact.reason !== "closure");
  if (facts.length === 0) {
    return false;
  }
  set_value_allocation_facts(value, facts, state);
  state.binding_allocations.set(name, [...facts]);
  return true;
}

function bind_static_closure_alias<ctx>(
  name: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): boolean {
  if (state.mutable_bindings.has(name)) {
    return false;
  }
  if (value.tag !== "var" && value.tag !== "linear") {
    return false;
  }
  const source = state.binding_allocations.get(value.name);
  if (source && source.some((fact) => fact.reason === "closure")) {
    return false;
  }
  let target = state.static_closure_bindings.get(value.name);
  if (!target && hooks.static_core_call_target) {
    target = hooks.static_core_call_target(value, ctx);
  }
  if (!target) {
    return false;
  }
  state.static_closure_bindings.set(name, target);
  state.binding_allocations.delete(name);
  state.runtime_bindings.delete(name);
  return true;
}

function update_runtime_allocation_binding(
  name: string,
  value: CoreExpr,
  allocation_start: number,
  state: CoreAllocationState,
): void {
  const new_facts = state.facts.slice(allocation_start);
  let value_facts = state.value_allocations.get(value);
  if (!value_facts) {
    value_facts = direct_binding_allocation_facts(value, new_facts);
  }
  if (value_facts.length > 0) {
    state.binding_allocations.set(name, value_facts);
  } else if (
    (value.tag === "var" || value.tag === "linear") &&
    state.binding_allocations.has(value.name)
  ) {
    const source = state.binding_allocations.get(value.name);
    if (!source) {
      throw new Error("Missing allocation binding source: " + value.name);
    }
    state.binding_allocations.set(name, [...source]);
  } else if (value.tag !== "freeze") {
    state.binding_allocations.delete(name);
  }

  if (value_facts.length > 0 || state.facts.length > allocation_start) {
    state.runtime_bindings.add(name);
    return;
  }

  if (
    (value.tag === "var" || value.tag === "linear") &&
    state.runtime_bindings.has(value.name)
  ) {
    state.runtime_bindings.add(name);
    return;
  }

  state.runtime_bindings.delete(name);
}

function register_index_assignment_allocation_destinations<ctx>(
  stmt: Extract<CoreStmt, { tag: "index_assign" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  if (!hooks.runtime_aggregate_type_expr) {
    return;
  }
  const type_expr = hooks.runtime_aggregate_type_expr(
    { tag: "var", name: stmt.name },
    ctx,
  );
  if (!type_expr) {
    return;
  }
  const type_value = static_type_value(
    type_expr,
    ctx as ctx & TypeStaticCtx,
  );
  if (!type_value || type_value.tag !== "struct_type") {
    return;
  }
  const layout = runtime_aggregate_layout_for_type(
    type_expr,
    ctx as ctx & TypeStaticCtx,
  );
  const sources = state.value_allocations.get(stmt.value);
  if (!sources) {
    return;
  }
  const static_index = static_allocation_i32(
    stmt.index,
    ctx as ctx & TypeStaticCtx,
    new Set(),
  );
  let fields = layout.fields;
  if (static_index !== undefined) {
    const field = layout.fields[static_index];
    if (!field) {
      return;
    }
    fields = [field];
  }
  const parents = state.binding_allocations.get(stmt.name);
  for (const field of fields) {
    if (field.tag !== "value") {
      continue;
    }
    const child_reason = runtime_aggregate_owned_child_reason(field);
    if (!child_reason) {
      continue;
    }
    const children = sources.filter((fact) => {
      return fact.reason === child_reason &&
        fact.storage === "persistent_unique_heap" &&
        fact.ownership.tag === "unique_heap";
    });
    for (const child of children) {
      register_core_allocation_fact_destination(
        child,
        stmt.name,
        field.name,
      );
    }
    if (!parents) {
      continue;
    }
    for (const parent of parents) {
      if (
        parent.reason !== "runtime_aggregate" ||
        parent.storage !== "persistent_unique_heap"
      ) {
        continue;
      }
      for (const child of children) {
        register_core_allocation_fact_owning_parent(child, parent);
      }
      if (static_index !== undefined) {
        attach_allocation_owned_child(parent, field.offset, children);
      }
    }
  }
}

function static_allocation_i32(
  expr: CoreExpr,
  ctx: TypeStaticCtx,
  visiting: Set<string>,
): number | undefined {
  if (expr.tag === "num" && expr.type === "i32") {
    if (typeof expr.value !== "number") {
      throw new Error("Core allocation i32 value must be a number");
    }
    return expr.value;
  }
  if (expr.tag !== "var" && expr.tag !== "linear") {
    return undefined;
  }
  if (visiting.has(expr.name)) {
    return undefined;
  }
  const value = ctx.statics.get(expr.name);
  if (!value) {
    return undefined;
  }
  const next_visiting = new Set(visiting);
  next_visiting.add(expr.name);
  return static_allocation_i32(value, ctx, next_visiting);
}

function direct_binding_allocation_facts(
  value: CoreExpr,
  facts: CoreAllocationState["facts"],
): CoreAllocationState["facts"] {
  let reason: CoreAllocationState["facts"][number]["reason"] | undefined;

  if (value.tag === "lam" || value.tag === "rec") {
    reason = "closure";
  } else if (value.tag === "struct_value") {
    reason = "runtime_aggregate";
  } else if (value.tag === "union_case") {
    reason = "runtime_union";
  } else if (value.tag === "prim") {
    reason = "runtime_text";
  } else if (value.tag === "app") {
    const direct = facts.filter((fact) => {
      return fact.expression === "app";
    });
    if (direct.length > 0) {
      return direct;
    }
  }

  if (reason) {
    return facts.filter((fact) => fact.reason === reason);
  }

  return facts.filter((fact) => {
    return fact.expression === value.tag;
  });
}

function bound_freeze_allocation_facts(
  value: CoreExpr,
  state: CoreAllocationState,
): CoreAllocationState["facts"] {
  if (value.tag !== "var" && value.tag !== "linear") {
    return [];
  }

  const facts = state.binding_allocations.get(value.name);
  if (!facts) {
    return [];
  }

  return facts;
}

function register_freeze_allocation_facts(
  freeze: Extract<CoreExpr, { tag: "freeze" }>,
  allocation_start: number,
  bound_sources: CoreAllocationState["facts"],
  state: CoreAllocationState,
): void {
  const created = state.facts.slice(allocation_start);
  for (const fact of created) {
    register_core_allocation_fact_lifetime_subject(fact, freeze);
    register_core_allocation_fact_emission_subject(fact, freeze);
  }

  const candidates = bound_sources.concat(created);
  const seen = new Set<string>();

  for (const fact of candidates) {
    if (seen.has(fact.allocation_id)) {
      continue;
    }
    seen.add(fact.allocation_id);

    if (fact.storage !== "persistent_unique_heap") {
      continue;
    }
    if (fact.ownership.tag !== "unique_heap") {
      continue;
    }
    register_core_allocation_fact_freeze(fact, freeze);
  }
}

function register_bound_freeze_source_emission_subjects<ctx>(
  value: CoreExpr,
  sources: CoreAllocationState["facts"],
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): void {
  if (sources.length === 0) {
    return;
  }
  const struct_value = hooks.static_struct_value(value, ctx);
  const union_value = hooks.runtime_union_value(value, ctx);
  for (const fact of sources) {
    register_core_allocation_fact_emission_subject(fact, value);
    if (fact.reason === "runtime_aggregate" && struct_value) {
      register_core_allocation_fact_emission_subject(fact, struct_value);
    }
    if (fact.reason === "runtime_union" && union_value) {
      register_runtime_union_emission_subjects(fact, union_value);
    }
  }
}

function register_runtime_union_emission_subjects(
  fact: CoreAllocationState["facts"][number],
  value: CoreExpr,
): void {
  if (value.tag === "if") {
    register_runtime_union_emission_subjects(fact, value.then_branch);
    register_runtime_union_emission_subjects(fact, value.else_branch);
    return;
  }
  register_core_allocation_fact_emission_subject(fact, value);
}

function register_runtime_aggregate_emission_subjects<ctx>(
  fact: CoreAllocationState["facts"][number],
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): void {
  if (value.tag === "if") {
    register_runtime_aggregate_emission_subjects(
      fact,
      value.then_branch,
      ctx,
      hooks,
    );
    register_runtime_aggregate_emission_subjects(
      fact,
      value.else_branch,
      ctx,
      hooks,
    );
    return;
  }

  const block_value = static_block_result(value);

  if (block_value) {
    register_runtime_aggregate_emission_subjects(
      fact,
      block_value,
      ctx,
      hooks,
    );
    return;
  }

  const struct_value = hooks.static_struct_value(value, ctx);

  if (struct_value) {
    register_core_allocation_fact_emission_subject(fact, struct_value);
  }
}

function set_value_allocation_facts(
  value: CoreExpr,
  facts: CoreAllocationState["facts"],
  state: CoreAllocationState,
): void {
  const unique: CoreAllocationState["facts"] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    if (seen.has(fact.allocation_id)) {
      continue;
    }
    seen.add(fact.allocation_id);
    unique.push(fact);
  }
  state.value_allocations.set(value, unique);
}

function register_normalized_allocation_value(
  source: CoreExpr,
  normalized: CoreExpr,
  state: CoreAllocationState,
): void {
  if (source === normalized) {
    return;
  }
  copy_value_allocation_facts(source, normalized, state);
}

function copy_value_allocation_facts(
  target: CoreExpr,
  source: CoreExpr,
  state: CoreAllocationState,
): void {
  const facts = state.value_allocations.get(source);
  if (!facts) {
    return;
  }
  set_value_allocation_facts(target, facts, state);
}

function register_static_call_result_allocations(
  call: Extract<CoreExpr, { tag: "app" }>,
  inlined: CoreExpr,
  state: CoreAllocationState,
): void {
  copy_value_allocation_facts(call, inlined, state);
  if (state.value_allocations.has(call)) {
    return;
  }
  set_closure_call_result_allocations(call, state);
}

function merge_value_allocation_facts(
  target: CoreExpr,
  sources: CoreExpr[],
  state: CoreAllocationState,
): void {
  const facts: CoreAllocationState["facts"] = [];
  for (const source of sources) {
    const source_facts = state.value_allocations.get(source);
    if (!source_facts) {
      continue;
    }
    facts.push(...source_facts);
  }
  if (facts.length === 0) {
    return;
  }
  set_value_allocation_facts(target, facts, state);
}

function set_closure_call_result_allocations(
  call: Extract<CoreExpr, { tag: "app" }>,
  state: CoreAllocationState,
): boolean {
  let functions = state.value_allocations.get(call.func);
  if (
    !functions &&
    (call.func.tag === "var" || call.func.tag === "linear")
  ) {
    functions = state.binding_allocations.get(call.func.name);
  }
  if (!functions) {
    return false;
  }
  const returned: CoreAllocationState["facts"] = [];
  for (const fact of functions) {
    if (fact.reason !== "closure") {
      continue;
    }
    const results = state.closure_result_allocations.get(fact.allocation_id);
    if (results) {
      returned.push(...results);
    }
  }
  if (returned.length === 0) {
    return false;
  }
  set_value_allocation_facts(call, returned, state);
  return true;
}

function block_final_allocation_expr(
  block: Extract<CoreExpr, { tag: "block" }>,
): CoreExpr | undefined {
  const final_stmt = block.statements[block.statements.length - 1];
  if (!final_stmt) {
    return undefined;
  }
  if (final_stmt.tag === "expr") {
    return final_stmt.expr;
  }
  if (final_stmt.tag === "return") {
    return final_stmt.value;
  }
  if (final_stmt.tag === "break") {
    return final_stmt.value;
  }
  return undefined;
}

function mark_expected_branch_closures<ctx>(
  expr: Extract<CoreExpr, { tag: "if" | "if_let" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  let fn_type;
  try {
    fn_type = hooks.closure_fn_type(expr, ctx);
  } catch {
    return;
  }
  if (!fn_type) {
    return;
  }
  if (
    !state.forced_static_parameter_closure_branches.has(expr) &&
    (fn_type.param_structs?.some((type_expr) => type_expr !== undefined) ||
      fn_type.param_unions?.some((type_expr) => type_expr !== undefined))
  ) {
    return;
  }
  const branches = [expr.then_branch, expr.else_branch];
  for (const branch of branches) {
    let value = branch;
    if (branch.tag === "block") {
      const final_value = block_final_allocation_expr(branch);
      if (!final_value) {
        continue;
      }
      value = final_value;
    }
    if (value.tag === "lam" || value.tag === "rec") {
      state.forced_closures.add(value);
    }
  }
}

function mark_static_call_closure_result(
  value: CoreExpr,
  state: CoreAllocationState,
): void {
  let result = value;
  if (result.tag === "block") {
    const final_value = block_final_allocation_expr(result);
    if (!final_value) {
      return;
    }
    result = final_value;
  }
  if (result.tag === "lam" || result.tag === "rec") {
    state.forced_closures.add(result);
    return;
  }
  if (result.tag === "if" || result.tag === "if_let") {
    state.forced_static_parameter_closure_branches.add(result);
  }
}

function scan_static_value_allocation_setup<ctx>(
  value: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): CoreExpr | undefined {
  if (value.tag !== "scratch" || value.body.tag !== "block") {
    return undefined;
  }
  if (value.body.statements.length <= 1) {
    return undefined;
  }
  const final_value = block_final_allocation_expr(value.body);
  if (!final_value) {
    return undefined;
  }
  const direct_value = static_scratch_block_result_value(value);
  let setup_value: CoreExpr | undefined;
  if (direct_value && direct_value.tag === "struct_value") {
    setup_value = direct_value;
  } else if (direct_value && direct_value.tag === "union_case") {
    setup_value = direct_value;
  }
  if (!setup_value && direct_value && hooks.static_union_case) {
    setup_value = hooks.static_union_case(direct_value, ctx);
  }
  if (!setup_value) {
    setup_value = hooks.static_struct_value(final_value, ctx);
  }
  if (!setup_value && hooks.static_union_case) {
    setup_value = hooks.static_union_case(final_value, ctx);
  }
  if (!setup_value) {
    return undefined;
  }
  if (setup_value.tag === "struct_value") {
    state.nonmaterialized_struct_values.add(setup_value);
    state.nonmaterialized_struct_values.add(final_value);
  } else if (setup_value.tag === "union_case") {
    state.nonmaterialized_union_values.add(setup_value);
    state.nonmaterialized_union_values.add(final_value);
    if (direct_value) {
      state.nonmaterialized_union_values.add(direct_value);
    }
  } else {
    return undefined;
  }
  scan_allocation_expr(value, scope, ctx, hooks, state);
  return setup_value;
}

function scan_static_composite_closure_value<ctx>(
  value: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  if (value.tag !== "if" && value.tag !== "if_let" && value.tag !== "block") {
    return;
  }
  if (!static_composite_contains_closure(value, ctx, hooks, state)) {
    return;
  }
  scan_allocation_expr(value, scope, ctx, hooks, state);
}

function static_composite_contains_closure<ctx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): boolean {
  if (value.tag === "lam" || value.tag === "rec") {
    return true;
  }
  if (value.tag === "var" || value.tag === "linear") {
    if (state.static_closure_bindings.has(value.name)) {
      return true;
    }
    if (hooks.static_core_call_target) {
      const target = hooks.static_core_call_target(value, ctx);
      if (target) {
        return true;
      }
    }
    try {
      const ownership = core_expr_ownership(value, ctx, hooks);
      return ownership.tag === "unique_heap" &&
        ownership.reason === "closure";
    } catch {
      return false;
    }
  }
  if (value.tag === "block") {
    const final_value = block_final_allocation_expr(value);
    if (!final_value) {
      return false;
    }
    return static_composite_contains_closure(final_value, ctx, hooks, state);
  }
  if (value.tag === "if" || value.tag === "if_let") {
    return static_composite_contains_closure(
      value.then_branch,
      ctx,
      hooks,
      state,
    ) || static_composite_contains_closure(
      value.else_branch,
      ctx,
      hooks,
      state,
    );
  }
  return false;
}

function closure_params_require_static_call<ctx>(
  value: Extract<CoreExpr, { tag: "lam" | "rec" }>,
  ctx: ctx,
): boolean {
  for (const param of value.params) {
    if (!param.annotation) {
      continue;
    }
    const type_value = static_type_value(
      { tag: "var", name: param.annotation },
      ctx as ctx & TypeStaticCtx,
    );
    if (
      type_value &&
      (type_value.tag === "struct_type" || type_value.tag === "union_type")
    ) {
      return true;
    }
  }
  return false;
}

function runtime_union_source_has_allocation(
  value: CoreExpr,
  facts: CoreAllocationState["facts"],
): boolean {
  if (value.tag === "if") {
    return runtime_union_source_has_allocation(value.then_branch, facts) &&
      runtime_union_source_has_allocation(value.else_branch, facts);
  }

  const source = canonical_core_expr(value);
  return facts.some((fact) => {
    if (fact.reason !== "runtime_union") {
      return false;
    }
    const subject = core_allocation_fact_subject(fact);
    if (!subject) {
      return false;
    }
    return canonical_core_expr(subject) === source;
  });
}

function record_closure_call_result_allocation<ctx>(
  value: CoreExpr,
  owner: string,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  if (value.tag !== "app") {
    return;
  }

  let fn_type;

  try {
    fn_type = hooks.closure_fn_type(value.func, ctx);
  } catch {
    return;
  }

  if (!fn_type) {
    return;
  }

  let ownership;

  try {
    ownership = core_expr_ownership(value, ctx, hooks);
  } catch {
    return;
  }

  if (ownership.tag !== "unique_heap") {
    return;
  }

  let reason:
    | "closure"
    | "runtime_aggregate"
    | "runtime_text"
    | "runtime_union";

  if (ownership.reason === "closure") {
    reason = "closure";
  } else if (ownership.reason === "runtime_aggregate") {
    reason = "runtime_aggregate";
  } else if (ownership.reason === "runtime_union") {
    reason = "runtime_union";
  } else {
    reason = "runtime_text";
  }

  const existing = state.value_allocations.get(value);
  if (existing && existing.some((fact) => fact.reason === reason)) {
    return;
  }

  const start = state.facts.length;
  let fact = record_allocation(value, reason, scope, state);
  if (!fact) {
    fact = state.value_allocations.get(value)?.find((candidate) => {
      return candidate.reason === reason && candidate.scope === scope.name;
    });
  }
  mark_bound_allocation_owner(state, start, owner);
  if (fact && reason === "runtime_aggregate") {
    attach_static_call_result_owned_children(
      fact,
      value,
      fn_type,
      ctx,
      hooks,
      state,
    );
  }
}

function scan_mutable_static_struct_allocation<ctx>(
  name: string,
  value: CoreExpr,
  instance: string,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
  annotated = false,
): Extract<CoreExpr, { tag: "struct_value" }> | undefined {
  const union_value = runtime_union_allocation_value(value, ctx, hooks);
  if (union_value && runtime_union_value_materializes(union_value)) {
    return undefined;
  }
  if (value.tag === "app" && value.func.tag === "field") {
    return undefined;
  }
  const ownership = core_expr_ownership(value, ctx, hooks);
  if (
    ownership.tag === "unique_heap" &&
    ownership.reason === "runtime_union"
  ) {
    return undefined;
  }
  const struct_value = hooks.static_struct_value(value, ctx);
  if (!struct_value) {
    return undefined;
  }
  let annotated_owner = annotated;
  if (
    struct_value.type_expr.tag === "var" &&
    struct_value.type_expr.name === "object_type"
  ) {
    annotated_owner = false;
  }
  const mutable_owner =
    (state.mutable_bindings.has(name) || hooks.mutable_binding(name, ctx)) &&
    mutable_static_owner_value_materializes(struct_value);
  let owned_fields_materialize = false;
  if (!scope.scratch) {
    owned_fields_materialize = static_struct_value_requires_owner(
      struct_value,
      ctx,
      hooks,
    );
  }
  if (
    !annotated_owner &&
    !mutable_owner &&
    !owned_fields_materialize
  ) {
    return undefined;
  }
  const parent = record_allocation(
    value,
    "runtime_aggregate",
    scope,
    state,
    instance,
  );
  if (parent) {
    register_core_allocation_fact_emission_subject(parent, struct_value);
    register_runtime_aggregate_emission_subjects(
      parent,
      value,
      ctx,
      hooks,
    );
  }
  scan_runtime_aggregate_fields(
    parent,
    struct_value,
    scope,
    ctx,
    hooks,
    state,
  );
  return struct_value;
}

function static_struct_value_requires_owner<ctx>(
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): boolean {
  if (
    value.type_expr.tag === "var" &&
    value.type_expr.name === "object_type"
  ) {
    return false;
  }

  for (const field of value.fields) {
    const nested = hooks.static_struct_value(field.value, ctx);
    if (nested && static_struct_value_requires_owner(nested, ctx, hooks)) {
      return true;
    }

    const ownership = core_expr_ownership(field.value, ctx, hooks);
    if (
      ownership.tag === "unique_heap" ||
      ownership.tag === "scratch_backed"
    ) {
      return true;
    }
  }

  return false;
}

function scan_allocation_expr<ctx>(
  expr: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  switch (expr.tag) {
    case "num":
    case "text":
    case "type_name":
    case "struct_type":
    case "union_type":
    case "unsupported":
      return;

    case "var":
    case "linear": {
      const bound_facts = state.binding_allocations.get(expr.name);
      if (bound_facts) {
        set_value_allocation_facts(expr, bound_facts, state);
        for (const fact of bound_facts) {
          register_core_allocation_fact_emission_subject(fact, expr);
        }
      }

      if (
        state.nonmaterialized_struct_values.has(expr) ||
        state.nonmaterialized_union_values.has(expr)
      ) {
        return;
      }

      if (state.runtime_bindings.has(expr.name)) {
        return;
      }

      const static_closure = state.static_closure_bindings.get(expr.name);
      if (static_closure) {
        state.forced_closures.add(static_closure);
        scan_allocation_expr(static_closure, scope, ctx, hooks, state);
        const target_facts = state.value_allocations.get(static_closure);
        if (target_facts) {
          for (const fact of target_facts) {
            if (!fact.owner) {
              fact.owner = expr.name;
            }
          }
          state.binding_allocations.set(expr.name, target_facts);
        }
        copy_value_allocation_facts(expr, static_closure, state);
        return;
      }

      if (hooks.local_value_exists(expr.name, ctx)) {
        return;
      }

      if (hooks.static_core_call_target) {
        const target = hooks.static_core_call_target(expr, ctx);
        if (target) {
          state.forced_closures.add(target);
          scan_allocation_expr(target, scope, ctx, hooks, state);
          const target_facts = state.value_allocations.get(target);
          if (target_facts) {
            for (const fact of target_facts) {
              if (!fact.owner) {
                fact.owner = expr.name;
              }
            }
          }
          copy_value_allocation_facts(expr, target, state);
          return;
        }
      }

      if (hooks.static_text_value(expr, ctx)) {
        return;
      }

      const union_value = hooks.runtime_union_value(expr, ctx);
      if (union_value && runtime_union_value_materializes(union_value)) {
        record_runtime_union_allocations(
          union_value,
          scope,
          ctx,
          hooks,
          state,
          scan_allocation_expr,
        );
        return;
      }

      const static_struct = hooks.static_struct_value(expr, ctx);
      if (!scope.scratch && static_struct) {
        record_allocation(
          expr,
          "runtime_aggregate",
          scope,
          state,
          state.current_allocation_instance,
        );
      }

      return;
    }

    case "lam":
    case "rec": {
      if (
        !state.forced_closures.has(expr) &&
        closure_params_require_static_call(expr, ctx)
      ) {
        return;
      }
      if (
        state.forced_closures.has(expr) || hooks.closure_fn_type(expr, ctx)
      ) {
        const closure = record_allocation(
          expr,
          "closure",
          scope,
          state,
          state.current_allocation_instance,
        );
        const returned = scan_closure_body_allocations(
          expr,
          scope,
          ctx,
          hooks,
          state,
          scan_allocation_expr,
        );
        let closure_facts: CoreAllocationState["facts"] = [];
        if (closure) {
          closure_facts = [closure];
        } else {
          const existing = state.value_allocations.get(expr);
          if (existing) {
            closure_facts = existing.filter((fact) => {
              return fact.reason === "closure";
            });
          }
        }
        for (const closure_fact of closure_facts) {
          state.closure_result_allocations.set(
            closure_fact.allocation_id,
            returned,
          );
        }
      }

      return;
    }

    case "prim":
      for (const arg of expr.args) {
        scan_allocation_expr(arg, scope, ctx, hooks, state);
      }

      if (hooks.is_runtime_text_concat(expr, ctx)) {
        record_allocation(
          expr,
          "runtime_text",
          scope,
          state,
          state.current_allocation_instance,
        );
      }

      return;

    case "app": {
      const allocation_start = state.facts.length;
      if (state.nonmaterialized_union_values.has(expr)) {
        const nonmaterialized = hooks.runtime_union_value(expr, ctx);
        if (!nonmaterialized) {
          throw new Error("Missing nonmaterialized static union value");
        }
        if (nonmaterialized.tag === "union_case") {
          if (nonmaterialized.type_expr) {
            scan_allocation_expr(
              nonmaterialized.type_expr,
              scope,
              ctx,
              hooks,
              state,
            );
          }
          if (nonmaterialized.value) {
            scan_allocation_expr(
              nonmaterialized.value,
              scope,
              ctx,
              hooks,
              state,
            );
          }
        }
        return;
      }

      const bytes_generate = core_bytes_generate_args(expr);

      if (bytes_generate) {
        scan_allocation_expr(
          bytes_generate[0],
          scope,
          ctx,
          hooks,
          state,
        );
        scan_allocation_expr(
          core_bytes_generator_call(
            bytes_generate[1],
            { tag: "num", type: "i32", value: 0 },
          ),
          scope,
          ctx,
          hooks,
          state,
        );
        record_allocation(
          expr,
          "runtime_bytes",
          scope,
          state,
          state.current_allocation_instance,
        );
        return;
      }

      const runtime_buffer_builtin = core_runtime_buffer_builtin(expr);

      if (runtime_buffer_builtin) {
        scan_allocation_expr(
          runtime_buffer_builtin.arg,
          scope,
          ctx,
          hooks,
          state,
        );
        if (runtime_buffer_builtin.precision !== undefined) {
          scan_allocation_expr(
            runtime_buffer_builtin.precision,
            scope,
            ctx,
            hooks,
            state,
          );
        }
        record_allocation(
          expr,
          runtime_buffer_allocation(runtime_buffer_builtin).reason,
          scope,
          state,
          state.current_allocation_instance,
        );
        return;
      }

      set_closure_call_result_allocations(expr, state);
      if (
        expr.func.tag === "var" &&
        (expr.func.name === "@len" || expr.func.name === "@get") &&
        expr.args.length > 0
      ) {
        const collection = expr.args[0];
        if (!collection) {
          throw new Error("Missing static aggregate builtin collection");
        }
        scan_nonmaterialized_static_struct_expr(
          collection,
          scope,
          ctx,
          hooks,
          state,
        );
        for (let index = 1; index < expr.args.length; index += 1) {
          const arg = expr.args[index];
          if (!arg) {
            throw new Error("Missing static aggregate builtin argument");
          }
          scan_allocation_expr(arg, scope, ctx, hooks, state);
        }
        return;
      }

      if (
        expr.func.tag === "var" &&
        (expr.func.name === "@runtime_i32_slice" ||
          expr.func.name === "@runtime_text_slice")
      ) {
        for (const arg of expr.args) {
          scan_allocation_expr(arg, scope, ctx, hooks, state);
        }
        record_allocation(
          expr,
          "runtime_aggregate",
          scope,
          state,
          state.current_allocation_instance,
        );
        return;
      }

      const union_value = hooks.runtime_union_value(expr, ctx);
      if (union_value && runtime_union_value_materializes(union_value)) {
        record_runtime_union_allocations(
          union_value,
          scope,
          ctx,
          hooks,
          state,
          scan_allocation_expr,
          state.current_allocation_instance,
        );
        set_value_allocation_facts(
          expr,
          state.facts.slice(allocation_start).filter((fact) => {
            return fact.reason === "runtime_union";
          }),
          state,
        );
        return;
      }

      if (
        expr.func.tag === "field" &&
        hooks.static_struct_value(expr, ctx)
      ) {
        record_runtime_union_allocations(
          expr,
          scope,
          ctx,
          hooks,
          state,
          scan_allocation_expr,
          state.current_allocation_instance,
        );
        set_value_allocation_facts(
          expr,
          state.facts.slice(allocation_start).filter((fact) => {
            return fact.reason === "runtime_union";
          }),
          state,
        );
        return;
      }

      if (hooks.static_core_call_branch_app) {
        const branch_call = hooks.static_core_call_branch_app(expr, ctx);
        if (branch_call) {
          if (expr.func.tag !== "var") {
            throw new Error("Static branch allocation call requires a name");
          }
          scan_allocation_expr(branch_call.cond, scope, ctx, hooks, state);
          const branches = [
            {
              expr: branch_call.then_branch,
              suffix: "if_then",
            },
            {
              expr: branch_call.else_branch,
              suffix: "if_else",
            },
          ];
          for (const branch of branches) {
            if (branch.expr.tag !== "app") {
              throw new Error("Static branch allocation requires an app");
            }
            let branch_ctx = ctx;
            let inlined_branch: CoreExpr | undefined;
            const scoped_branch = scoped_static_allocation_call_value(
              branch.expr,
              ctx,
              hooks,
            );
            if (scoped_branch) {
              inlined_branch = scoped_branch.value;
              branch_ctx = scoped_branch.ctx;
            } else {
              inlined_branch = hooks.static_core_call_value(
                branch.expr,
                ctx,
              );
            }
            if (!inlined_branch) {
              throw new Error("Missing static branch allocation value");
            }
            mark_static_call_closure_result(inlined_branch, state);
            const branch_start = state.facts.length;
            scan_allocation_expr(
              inlined_branch,
              {
                name: scope.name + "/static_call/" + expr.func.name + "/" +
                  branch.suffix,
                scratch: scope.scratch,
              },
              branch_ctx,
              hooks,
              state,
            );
            register_call_allocation_lifetimes(
              expr,
              branch_start,
              state,
            );
            register_static_call_result_allocations(
              branch.expr,
              inlined_branch,
              state,
            );
          }
          merge_value_allocation_facts(
            expr,
            [branch_call.then_branch, branch_call.else_branch],
            state,
          );
          return;
        }
      }

      const scoped = scoped_static_allocation_call_value(expr, ctx, hooks);

      if (scoped) {
        const call_name = static_allocation_call_name(expr, state);
        const call_scope: CoreAllocationScope = {
          name: scope.name + "/static_call/" + call_name,
          scratch: scope.scratch,
        };
        let target;
        if (hooks.static_core_call_target) {
          target = hooks.static_core_call_target(expr.func, ctx);
        }
        if (!target) {
          throw new Error("Missing scoped static allocation call target");
        }
        for (let index = 0; index < expr.args.length; index += 1) {
          const arg = expr.args[index];
          const param = target.params[index];
          if (!arg || !param) {
            throw new Error("Missing scoped static allocation call argument");
          }
          let static_function_argument = false;
          if (param.is_const && hooks.static_core_call_target) {
            static_function_argument =
              hooks.static_core_call_target(arg, ctx) !== undefined;
          }
          if (static_function_argument) {
            continue;
          }
          scan_nonmaterialized_static_struct_expr(
            arg,
            scope,
            ctx,
            hooks,
            state,
          );
        }

        const call_start = state.facts.length;
        mark_static_call_closure_result(scoped.value, state);
        scan_allocation_expr(
          scoped.value,
          call_scope,
          scoped.ctx,
          hooks,
          state,
        );
        register_call_allocation_lifetimes(expr, call_start, state);
        register_static_call_result_allocations(
          expr,
          scoped.value,
          state,
        );
        return;
      }

      const inlined = hooks.static_core_call_value(expr, ctx);
      if (inlined) {
        const call_name = static_allocation_call_name(expr, state);
        const call_scope: CoreAllocationScope = {
          name: scope.name + "/static_call/" + call_name,
          scratch: scope.scratch,
        };
        const call_start = state.facts.length;
        mark_static_call_closure_result(inlined, state);
        scan_allocation_expr(inlined, call_scope, ctx, hooks, state);
        register_call_allocation_lifetimes(expr, call_start, state);
        register_static_call_result_allocations(
          expr,
          inlined,
          state,
        );
        return;
      }

      scan_allocation_expr(expr.func, scope, ctx, hooks, state);
      for (const arg of expr.args) {
        scan_allocation_expr(arg, scope, ctx, hooks, state);
      }
      set_closure_call_result_allocations(expr, state);

      if (hooks.host_import_result_ownership) {
        const result = hooks.host_import_result_ownership(expr, ctx);

        if (result && result.tag === "unique_heap") {
          let reason:
            | "closure"
            | "runtime_aggregate"
            | "runtime_text"
            | "runtime_union";

          if (result.reason === "closure") {
            reason = "closure";
          } else if (result.reason === "runtime_aggregate") {
            reason = "runtime_aggregate";
          } else if (result.reason === "runtime_union") {
            reason = "runtime_union";
          } else {
            reason = "runtime_text";
          }

          const fact = record_allocation(
            expr,
            reason,
            scope,
            state,
            state.current_allocation_instance,
          );
          if (fact) {
            set_core_allocation_fact_external(fact);
          }
        }
      }

      if (expr.func.tag === "var" && expr.func.name === "@slice") {
        record_allocation(
          expr,
          "runtime_text",
          scope,
          state,
          state.current_allocation_instance,
        );
      }

      if (
        expr.func.tag === "var" && expr.func.name === "@append" &&
        !hooks.closure_fn_type(expr.func, ctx)
      ) {
        record_allocation(
          expr,
          "runtime_text",
          scope,
          state,
          state.current_allocation_instance,
        );
      }

      return;
    }

    case "block": {
      const block = "block#" + state.next_block.toString();
      state.next_block += 1;
      scan_allocation_block(
        expr,
        { name: block, scratch: scope.scratch },
        ctx,
        hooks,
        state,
        scan_allocation_stmt,
        scan_allocation_stmts,
      );
      const final_value = block_final_allocation_expr(expr);
      if (final_value) {
        copy_value_allocation_facts(expr, final_value, state);
      }
      return;
    }

    case "loop": {
      const loop = "loop#" + state.next_loop.toString();
      state.next_loop += 1;
      scan_allocation_scoped_stmts(
        expr.body,
        { name: loop, scratch: scope.scratch },
        ctx,
        hooks,
        state,
      );
      return;
    }

    case "comptime":
      scan_allocation_expr(expr.expr, scope, ctx, hooks, state);
      copy_value_allocation_facts(expr, expr.expr, state);
      return;

    case "borrow":
      scan_allocation_expr(expr.value, scope, ctx, hooks, state);
      copy_value_allocation_facts(expr, expr.value, state);
      return;

    case "freeze": {
      const allocation_start = state.facts.length;
      const bound_sources = bound_freeze_allocation_facts(expr.value, state);
      register_bound_freeze_source_emission_subjects(
        expr.value,
        bound_sources,
        ctx,
        hooks,
      );

      if (freeze_promotes_runtime_text(expr, ctx, hooks)) {
        scan_allocation_expr(expr.value, scope, ctx, hooks, state);

        if (scope.scratch) {
          const ownership = core_expr_ownership(expr.value, ctx, hooks);
          let reason: "runtime_bytes" | "runtime_text" = "runtime_text";

          if (
            ownership.tag === "unique_heap" && ownership.reason === "bytes"
          ) {
            reason = "runtime_bytes";
          }

          record_allocation(
            expr,
            reason,
            { name: scope.name, scratch: undefined },
            state,
          );
        }

        register_freeze_allocation_facts(
          expr,
          allocation_start,
          bound_sources,
          state,
        );
        return;
      }

      if (freeze_promotes_runtime_closure(expr, ctx, hooks)) {
        scan_allocation_expr(
          expr.value,
          { name: scope.name, scratch: undefined },
          ctx,
          hooks,
          state,
        );
        copy_value_allocation_facts(expr, expr.value, state);
        register_freeze_allocation_facts(
          expr,
          allocation_start,
          bound_sources,
          state,
        );
        return;
      }

      if (freeze_promotes_runtime_aggregate(expr, ctx, hooks)) {
        const struct_value = hooks.static_struct_value(expr.value, ctx);
        if (expr.value.tag === "struct_value" && struct_value) {
          scan_allocation_expr(
            struct_value,
            { name: scope.name, scratch: undefined },
            ctx,
            hooks,
            state,
          );
          copy_value_allocation_facts(expr, struct_value, state);
          register_freeze_allocation_facts(
            expr,
            allocation_start,
            bound_sources,
            state,
          );
          return;
        }
        record_freeze_source_aggregate_rematerializations(
          expr.value,
          bound_sources,
          scope,
          state,
        );
        let emission_site:
          | "runtime_aggregate.value"
          | "runtime_aggregate.freeze_copy" = "runtime_aggregate.value";
        if (scope.scratch) {
          emission_site = "runtime_aggregate.freeze_copy";
        }
        record_runtime_aggregate_freeze_copy_allocations(
          expr,
          { name: scope.name, scratch: undefined },
          emission_site,
          ctx,
          hooks,
          state,
        );
        register_freeze_allocation_facts(
          expr,
          allocation_start,
          bound_sources,
          state,
        );
        return;
      }

      if (freeze_copies_runtime_aggregate(expr, ctx, hooks)) {
        record_runtime_aggregate_freeze_copy_allocations(
          expr,
          { name: scope.name, scratch: undefined },
          "runtime_aggregate.freeze_copy",
          ctx,
          hooks,
          state,
        );
        register_freeze_allocation_facts(
          expr,
          allocation_start,
          bound_sources,
          state,
        );
        return;
      }

      if (freeze_promotes_runtime_union(expr, ctx, hooks)) {
        scan_allocation_expr(
          expr.value,
          { name: scope.name, scratch: undefined },
          ctx,
          hooks,
          state,
        );
        register_freeze_allocation_facts(
          expr,
          allocation_start,
          bound_sources,
          state,
        );
        return;
      }

      if (freeze_copies_runtime_union(expr, ctx, hooks)) {
        if (expr.value.tag !== "var" && expr.value.tag !== "linear") {
          scan_allocation_expr(expr.value, scope, ctx, hooks, state);
        } else {
          const source_union = hooks.runtime_union_value(expr.value, ctx);
          if (!source_union) {
            const has_runtime_source = bound_sources.some((fact) => {
              return fact.reason === "runtime_union";
            });
            if (!has_runtime_source) {
              throw new Error("Missing runtime union freeze-copy source");
            }
          } else if (
            !runtime_union_source_has_allocation(source_union, bound_sources)
          ) {
            record_runtime_union_allocations(
              source_union,
              scope,
              ctx,
              hooks,
              state,
              scan_allocation_expr,
              "freeze_source:" + allocation_start.toString(),
            );
          }
        }

        record_runtime_union_freeze_copy_allocations(
          expr,
          { name: scope.name, scratch: undefined },
          ctx,
          hooks,
          state,
        );
        register_freeze_allocation_facts(
          expr,
          allocation_start,
          bound_sources,
          state,
        );
        return;
      }

      scan_allocation_expr(expr.value, scope, ctx, hooks, state);
      register_freeze_allocation_facts(
        expr,
        allocation_start,
        bound_sources,
        state,
      );
      return;
    }

    case "scratch": {
      const scratch = "scratch#" + state.next_scratch.toString();
      state.next_scratch += 1;
      mark_static_aggregate_freeze_copy_source(expr.body, state);
      scan_allocation_expr(
        expr.body,
        { name: scratch, scratch },
        ctx,
        hooks,
        state,
      );
      copy_value_allocation_facts(expr, expr.body, state);
      return;
    }

    case "with":
      scan_allocation_expr(expr.base, scope, ctx, hooks, state);
      scan_allocation_fields(expr.fields, scope, ctx, hooks, state);
      return;

    case "struct_value": {
      if (state.nonmaterialized_struct_values.has(expr)) {
        scan_allocation_expr(expr.type_expr, scope, ctx, hooks, state);
        const type_value = static_type_value(
          expr.type_expr,
          ctx as ctx & TypeStaticCtx,
        );
        if (!type_value || type_value.tag !== "struct_type") {
          scan_allocation_fields(expr.fields, scope, ctx, hooks, state);
          return;
        }
        scan_runtime_aggregate_fields(
          undefined,
          expr,
          scope,
          ctx,
          hooks,
          state,
        );
        return;
      }
      const parent = record_allocation(
        expr,
        "runtime_aggregate",
        scope,
        state,
        state.current_allocation_instance,
      );
      scan_allocation_expr(expr.type_expr, scope, ctx, hooks, state);
      const type_value = static_type_value(
        expr.type_expr,
        ctx as ctx & TypeStaticCtx,
      );
      if (!type_value || type_value.tag !== "struct_type") {
        scan_allocation_fields(expr.fields, scope, ctx, hooks, state);
        return;
      }
      scan_runtime_aggregate_fields(
        parent,
        expr,
        scope,
        ctx,
        hooks,
        state,
      );
      return;
    }

    case "struct_update":
      scan_allocation_expr(expr.base, scope, ctx, hooks, state);
      scan_allocation_fields(expr.fields, scope, ctx, hooks, state);
      return;

    case "if": {
      const allocation_start = state.facts.length;
      mark_expected_branch_closures(expr, ctx, hooks, state);
      const union_value = hooks.runtime_union_value(expr, ctx);
      if (union_value && runtime_union_value_materializes(union_value)) {
        record_runtime_union_allocations(
          union_value,
          scope,
          ctx,
          hooks,
          state,
          scan_allocation_expr,
          state.current_allocation_instance,
        );
        set_value_allocation_facts(
          expr,
          state.facts.slice(allocation_start).filter((fact) => {
            return fact.reason === "runtime_union";
          }),
          state,
        );
        return;
      }

      scan_allocation_expr(expr.cond, scope, ctx, hooks, state);
      scan_allocation_expr(expr.then_branch, scope, ctx, hooks, state);
      scan_allocation_expr(expr.else_branch, scope, ctx, hooks, state);
      merge_value_allocation_facts(
        expr,
        [expr.then_branch, expr.else_branch],
        state,
      );
      return;
    }

    case "if_let":
      mark_expected_branch_closures(expr, ctx, hooks, state);
      scan_allocation_if_let_expr(
        expr,
        scope,
        ctx,
        hooks,
        state,
        scan_allocation_expr,
      );
      merge_value_allocation_facts(
        expr,
        [expr.then_branch, expr.else_branch],
        state,
      );
      return;

    case "field": {
      const struct_value = hooks.static_struct_value(expr.object, ctx);
      if (struct_value) {
        if (allocation_expr_has_bound_aggregate(expr.object, state)) {
          scan_allocation_expr(expr.object, scope, ctx, hooks, state);
          return;
        }
        const field = struct_value.fields.find((candidate) => {
          return candidate.name === expr.name;
        });
        if (field) {
          scan_allocation_expr(field.value, scope, ctx, hooks, state);
        }
        return;
      }

      scan_allocation_expr(expr.object, scope, ctx, hooks, state);
      return;
    }

    case "index":
      scan_nonmaterialized_static_struct_expr(
        expr.object,
        scope,
        ctx,
        hooks,
        state,
      );
      scan_allocation_expr(expr.index, scope, ctx, hooks, state);
      return;

    case "union_case":
      if (
        expr.type_expr && !state.nonmaterialized_union_values.has(expr)
      ) {
        record_runtime_union_allocations(
          expr,
          scope,
          ctx,
          hooks,
          state,
          scan_allocation_expr,
          state.current_allocation_instance,
        );
        return;
      }
      if (expr.type_expr) {
        scan_allocation_expr(expr.type_expr, scope, ctx, hooks, state);
      }
      if (expr.value) {
        scan_allocation_expr(expr.value, scope, ctx, hooks, state);
      }
      return;
  }
}

function runtime_aggregate_owned_child_reason(
  field: Extract<RuntimeAggregateField, { tag: "value" }>,
): "closure" | "runtime_text" | "runtime_union" | undefined {
  if (field.resume) {
    return "closure";
  }
  if (field.text) {
    return "runtime_text";
  }
  if (field.union_type_expr) {
    return "runtime_union";
  }
  return undefined;
}

function runtime_aggregate_field_is_runtime_slice(value: CoreExpr): boolean {
  if (core_runtime_slice_fact(value)) {
    return true;
  }
  if (value.tag === "borrow" || value.tag === "freeze") {
    return runtime_aggregate_field_is_runtime_slice(value.value);
  }
  if (value.tag === "comptime") {
    return runtime_aggregate_field_is_runtime_slice(value.expr);
  }
  if (value.tag === "scratch") {
    return runtime_aggregate_field_is_runtime_slice(value.body);
  }
  if (value.tag === "block") {
    const final_value = block_final_allocation_expr(value);
    if (!final_value) {
      return false;
    }
    return runtime_aggregate_field_is_runtime_slice(final_value);
  }
  if (value.tag === "if") {
    const then_slice = runtime_aggregate_field_is_runtime_slice(
      value.then_branch,
    );
    const else_slice = runtime_aggregate_field_is_runtime_slice(
      value.else_branch,
    );
    if (then_slice !== else_slice) {
      throw new Error(
        "Runtime aggregate field branches must agree on runtime slice ownership",
      );
    }
    return then_slice;
  }
  return false;
}

function allocation_expr_has_bound_aggregate(
  value: CoreExpr,
  state: CoreAllocationState,
): boolean {
  if (value.tag === "var" || value.tag === "linear") {
    const facts = state.binding_allocations.get(value.name);
    if (!facts) {
      return false;
    }
    return facts.some((fact) => fact.reason === "runtime_aggregate");
  }
  if (value.tag === "field" || value.tag === "index") {
    return allocation_expr_has_bound_aggregate(value.object, state);
  }
  if (value.tag === "borrow" || value.tag === "freeze") {
    return allocation_expr_has_bound_aggregate(value.value, state);
  }
  return false;
}

function scan_runtime_aggregate_fields<ctx>(
  parent: CoreAllocationState["facts"][number] | undefined,
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  const layout = runtime_aggregate_layout(
    value,
    ctx as ctx & TypeStaticCtx,
  );
  scan_runtime_aggregate_field_values(
    parent,
    value.fields,
    layout.fields,
    scope,
    ctx,
    hooks,
    state,
  );
}

function scan_runtime_aggregate_field_values<ctx>(
  parent: CoreAllocationState["facts"][number] | undefined,
  fields: CoreField[],
  layout_fields: RuntimeAggregateField[],
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  for (const field of fields) {
    const field_layout = layout_fields.find((candidate) => {
      return candidate.name === field.name;
    });
    if (!field_layout) {
      throw new Error(
        "Missing runtime aggregate allocation field: " + field.name,
      );
    }
    if (field_layout.tag === "struct") {
      const nested = hooks.static_struct_value(field.value, ctx);
      if (nested) {
        scan_runtime_aggregate_field_values(
          parent,
          nested.fields,
          field_layout.fields,
          scope,
          ctx,
          hooks,
          state,
        );
      } else {
        scan_allocation_expr(field.value, scope, ctx, hooks, state);
      }
      continue;
    }
    const start = state.facts.length;
    scan_allocation_expr(field.value, scope, ctx, hooks, state);
    if (
      !parent || parent.storage !== "persistent_unique_heap" ||
      field_layout.tag !== "value"
    ) {
      continue;
    }
    let child_reason:
      | "closure"
      | "runtime_aggregate"
      | "runtime_text"
      | "runtime_union"
      | undefined = runtime_aggregate_owned_child_reason(field_layout);
    if (
      !child_reason && runtime_aggregate_field_is_runtime_slice(field.value)
    ) {
      child_reason = "runtime_aggregate";
    }
    if (!child_reason) {
      continue;
    }
    let sources = state.value_allocations.get(field.value);
    if (!sources) {
      sources = state.facts.slice(start);
    }
    const children = sources.filter((fact) => {
      return fact.reason === child_reason &&
        fact.storage === "persistent_unique_heap" &&
        fact.ownership.tag === "unique_heap";
    });
    attach_allocation_owned_child(parent, field_layout.offset, children);
  }
}

function attach_static_call_result_owned_children<ctx>(
  parent: CoreAllocationState["facts"][number],
  call: Extract<CoreExpr, { tag: "app" }>,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  attach_call_argument_owned_children(
    parent,
    call,
    fn_type,
    ctx,
    hooks,
    state,
  );
  const results = static_call_result_struct_values(call, ctx, hooks);
  for (const result of results) {
    const layout = runtime_aggregate_layout(
      result,
      ctx as ctx & TypeStaticCtx,
    );
    for (const field of result.fields) {
      const field_layout = layout.fields.find((candidate) => {
        return candidate.name === field.name;
      });
      if (!field_layout || field_layout.tag !== "value") {
        continue;
      }
      const child_reason = runtime_aggregate_owned_child_reason(field_layout);
      if (!child_reason) {
        continue;
      }
      const arg = call.args.find((candidate) => {
        return canonical_core_expr(candidate) ===
          canonical_core_expr(field.value);
      });
      if (!arg) {
        continue;
      }
      const sources = state.value_allocations.get(arg);
      if (!sources) {
        continue;
      }
      const children = sources.filter((fact) => {
        return fact.reason === child_reason &&
          fact.storage === "persistent_unique_heap" &&
          fact.ownership.tag === "unique_heap";
      });
      if (children.length === 0) {
        continue;
      }
      const child = children[0];
      if (!child || child.ownership.tag !== "unique_heap") {
        continue;
      }
      const child_ownership = child.ownership;
      const owned_children = parent.owned_children || [];
      const existing = owned_children.find((candidate) => {
        return candidate.offset === field_layout.offset &&
          candidate.ownership.reason === child_ownership.reason;
      });
      const allocation_ids = children.map((candidate) => {
        return candidate.allocation_id;
      });
      if (existing) {
        for (const allocation_id of allocation_ids) {
          if (!existing.allocation_ids.includes(allocation_id)) {
            existing.allocation_ids.push(allocation_id);
          }
        }
      } else {
        owned_children.push({
          allocation_ids,
          offset: field_layout.offset,
          ownership: child_ownership,
          layout: child.layout,
        });
      }
      parent.owned_children = owned_children;
    }
  }
}

function attach_call_argument_owned_children<ctx>(
  parent: CoreAllocationState["facts"][number],
  call: Extract<CoreExpr, { tag: "app" }>,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  let result_type = fn_type.result_struct;
  if (!result_type && hooks.runtime_aggregate_type_expr) {
    result_type = hooks.runtime_aggregate_type_expr(call, ctx);
  }
  if (!result_type) {
    return;
  }
  const layout = runtime_aggregate_layout_for_type(
    result_type,
    ctx as ctx & TypeStaticCtx,
  );
  for (const field of layout.fields) {
    if (field.tag !== "value") {
      continue;
    }
    const child_reason = runtime_aggregate_owned_child_reason(field);
    if (!child_reason) {
      continue;
    }
    const children: CoreAllocationState["facts"] = [];
    for (let index = 0; index < call.args.length; index += 1) {
      const arg = call.args[index];
      if (!arg) {
        throw new Error("Missing call owned-child argument");
      }
      if (
        !call_argument_can_fill_owned_field(
          fn_type,
          index,
          field,
          arg,
          ctx,
          hooks,
        )
      ) {
        continue;
      }
      const sources = state.value_allocations.get(arg);
      if (!sources) {
        continue;
      }
      for (const source of sources) {
        if (
          source.reason === child_reason &&
          source.storage === "persistent_unique_heap" &&
          source.ownership.tag === "unique_heap"
        ) {
          children.push(source);
        }
      }
    }
    attach_allocation_owned_child(parent, field.offset, children);
  }
}

function call_argument_can_fill_owned_field<ctx>(
  fn_type: CoreFnType,
  index: number,
  field: Extract<RuntimeAggregateField, { tag: "value" }>,
  arg: CoreExpr,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): boolean {
  if (field.resume) {
    return hooks.closure_fn_type(arg, ctx) !== undefined;
  }
  if (field.text) {
    if (fn_type.param_texts[index] === true) {
      return true;
    }
    return hooks.core_expr_is_text(arg, ctx);
  }
  if (!field.union_type_expr) {
    return false;
  }
  let param_union: CoreExpr | undefined;
  if (fn_type.param_unions) {
    param_union = fn_type.param_unions[index];
  }
  if (!param_union) {
    const union_value = hooks.runtime_union_value(arg, ctx);
    if (union_value && union_value.tag === "union_case") {
      param_union = union_value.type_expr;
    }
  }
  if (!param_union) {
    return false;
  }
  if (param_union === field.union_type_expr) {
    return true;
  }
  return param_union.tag === "var" && field.union_type_expr.tag === "var" &&
    param_union.name === field.union_type_expr.name;
}

function attach_allocation_owned_child(
  parent: CoreAllocationState["facts"][number],
  offset: number,
  children: CoreAllocationState["facts"],
): void {
  const child = children[0];
  if (!child || child.ownership.tag !== "unique_heap") {
    return;
  }
  const child_ownership = child.ownership;
  const allocation_ids = children.map((candidate) => {
    return candidate.allocation_id;
  });
  const owned_children = parent.owned_children || [];
  const existing = owned_children.find((candidate) => {
    return candidate.offset === offset &&
      candidate.ownership.reason === child_ownership.reason;
  });
  if (existing) {
    for (const allocation_id of allocation_ids) {
      if (!existing.allocation_ids.includes(allocation_id)) {
        existing.allocation_ids.push(allocation_id);
      }
    }
  } else {
    owned_children.push({
      allocation_ids,
      offset,
      ownership: child_ownership,
      layout: child.layout,
    });
  }
  parent.owned_children = owned_children;
}

function static_call_result_struct_values<ctx>(
  call: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): Extract<CoreExpr, { tag: "struct_value" }>[] {
  const values: Extract<CoreExpr, { tag: "struct_value" }>[] = [];
  if (hooks.static_core_call_branch_app) {
    const branch = hooks.static_core_call_branch_app(call, ctx);
    if (branch) {
      for (const branch_value of [branch.then_branch, branch.else_branch]) {
        const value = static_allocation_call_result_value(
          branch_value,
          ctx,
          hooks,
        );
        if (!value) {
          continue;
        }
        const struct_value = hooks.static_struct_value(value.value, value.ctx);
        if (struct_value) {
          values.push(struct_value);
        }
      }
      return values;
    }
  }

  const value = static_allocation_call_result_value(call, ctx, hooks);
  if (!value) {
    return values;
  }
  const struct_value = hooks.static_struct_value(value.value, value.ctx);
  if (struct_value) {
    values.push(struct_value);
  }
  return values;
}

function static_allocation_call_result_value<ctx>(
  call: CoreExpr,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): { value: CoreExpr; ctx: ctx } | undefined {
  if (call.tag !== "app") {
    return undefined;
  }
  const scoped = scoped_static_allocation_call_value(call, ctx, hooks);
  if (scoped) {
    return scoped;
  }
  const value = hooks.static_core_call_value(call, ctx);
  if (!value) {
    return undefined;
  }
  return { value, ctx };
}

function static_allocation_call_name(
  expr: Extract<CoreExpr, { tag: "app" }>,
  state: CoreAllocationState,
): string {
  if (expr.func.tag === "var") {
    return expr.func.name;
  }

  const name = "inline#" + state.next_static_call.toString();
  state.next_static_call += 1;
  return name;
}

function register_call_allocation_lifetimes(
  call: Extract<CoreExpr, { tag: "app" }>,
  start: number,
  state: CoreAllocationState,
): void {
  for (let index = start; index < state.facts.length; index += 1) {
    const fact = state.facts[index];
    if (!fact) {
      throw new Error("Missing static call allocation fact");
    }
    register_core_allocation_fact_lifetime_subject(fact, call);
  }
}

function record_freeze_source_aggregate_rematerializations(
  value: CoreExpr,
  sources: CoreAllocationState["facts"],
  scope: CoreAllocationScope,
  state: CoreAllocationState,
): void {
  for (const source of sources) {
    if (source.reason !== "runtime_aggregate") {
      continue;
    }
    record_allocation(
      value,
      "runtime_aggregate",
      scope,
      state,
      "freeze_source:" + source.allocation_id,
    );
    return;
  }
}

function scan_nonmaterialized_static_struct_expr<ctx>(
  expr: CoreExpr,
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  if (expr.tag === "var" || expr.tag === "linear") {
    if (
      state.runtime_bindings.has(expr.name) ||
      hooks.local_value_exists(expr.name, ctx)
    ) {
      scan_allocation_expr(expr, scope, ctx, hooks, state);
      return;
    }
  }

  const struct_value = hooks.static_struct_value(expr, ctx);
  if (struct_value) {
    scan_allocation_fields(struct_value.fields, scope, ctx, hooks, state);
    return;
  }

  scan_allocation_expr(expr, scope, ctx, hooks, state);
}

function mark_static_aggregate_freeze_copy_source(
  value: CoreExpr,
  state: CoreAllocationState,
): void {
  if (value.tag !== "block") {
    return;
  }
  const final_value = block_final_allocation_expr(value);
  if (!final_value || final_value.tag !== "freeze") {
    return;
  }
  if (
    final_value.value.tag !== "var" && final_value.value.tag !== "linear"
  ) {
    return;
  }
  let name = final_value.value.name;
  const visiting = new Set<string>();
  while (!visiting.has(name)) {
    visiting.add(name);
    let source: CoreExpr | undefined;
    for (let index = value.statements.length - 2; index >= 0; index -= 1) {
      const stmt = value.statements[index];
      if (!stmt) {
        throw new Error("Missing aggregate freeze-copy source statement");
      }
      if (
        (stmt.tag === "bind" || stmt.tag === "assign") &&
        stmt.name === name
      ) {
        source = stmt.value;
        break;
      }
    }
    if (!source) {
      return;
    }
    if (source.tag === "struct_value") {
      state.nonmaterialized_struct_values.add(source);
      state.nonmaterialized_struct_values.add(final_value.value);
      return;
    }
    if (source.tag !== "var" && source.tag !== "linear") {
      return;
    }
    name = source.name;
  }
}

function scan_allocation_fields<ctx>(
  fields: CoreField[],
  scope: CoreAllocationScope,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  for (const field of fields) {
    scan_allocation_expr(field.value, scope, ctx, hooks, state);
  }
}
