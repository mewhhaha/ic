import type { Core, CoreExpr } from "./ast.ts";
import {
  core_diagnostic_related_subject,
  find_core_diagnostic_subject,
  record_core_diagnostic_related_subject,
  record_core_diagnostic_subject,
} from "./source_origin.ts";
import { canonical_core_expr } from "./subject_provenance.ts";
import type { CoreDropPlan } from "./drop.ts";
import { scan_allocation_stmts } from "./allocation/scan.ts";
import { record_allocation } from "./allocation/record.ts";
import {
  core_allocation_fact_destinations,
  core_allocation_fact_subject,
  register_core_allocation_fact_lifetime_subject,
  set_core_allocation_fact_external,
} from "./allocation/metadata.ts";
import type {
  CoreAllocationFact,
  CoreAllocationHooks,
  CoreAllocationOwnedChild,
  CoreAllocationPlan,
  CoreAllocationState,
} from "./allocation/types.ts";
import {
  core_materialized_bindings,
  core_mutable_bindings,
} from "./mutable_bindings.ts";
import { core_expr_ownership } from "./ownership.ts";
import { static_type_value } from "./type_static.ts";

export type {
  CoreAllocationByteSize,
  CoreAllocationFact,
  CoreAllocationHooks,
  CoreAllocationLayout,
  CoreAllocationOwnedChild,
  CoreAllocationPlan,
  CoreAllocationReason,
} from "./allocation/types.ts";

const value_allocations_by_plan = new WeakMap<
  CoreAllocationPlan,
  WeakMap<CoreExpr, CoreAllocationState["facts"]>
>();

export function core_allocation_plan<ctx>(
  core: Core,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
): CoreAllocationPlan {
  const state: CoreAllocationState = {
    next_allocation: 0,
    next_block: 0,
    next_closure: 0,
    next_loop: 0,
    next_scratch: 0,
    next_static_call: 0,
    current_allocation_instance: undefined,
    facts: [],
    recorded: new WeakMap(),
    runtime_bindings: new Set(),
    binding_allocations: new Map(),
    value_allocations: new WeakMap(),
    closure_result_allocations: new Map(),
    static_closure_bindings: new Map(),
    forced_closures: new WeakSet(),
    forced_static_parameter_closure_branches: new WeakSet(),
    nonmaterialized_struct_values: new WeakSet(),
    nonmaterialized_union_values: new WeakSet(),
    materialized_bindings: core_materialized_bindings(core),
    mutable_bindings: core_mutable_bindings(core),
  };

  seed_function_parameter_allocations(core, ctx, hooks, state);

  scan_allocation_stmts(
    core.statements,
    { name: "program#0", scratch: undefined },
    ctx,
    hooks,
    state,
  );

  const plan = { facts: state.facts };
  value_allocations_by_plan.set(plan, state.value_allocations);
  return plan;
}

function seed_function_parameter_allocations<ctx>(
  core: Core,
  ctx: ctx,
  hooks: CoreAllocationHooks<ctx>,
  state: CoreAllocationState,
): void {
  if (core.function_params === undefined) {
    return;
  }

  const function_body = core.statements[core.statements.length - 1];
  if (function_body === undefined) {
    throw new Error("Function parameter allocation requires a function body");
  }

  for (const param of core.function_params) {
    if (
      param.annotation?.startsWith("&") ||
      param.annotation?.startsWith("^")
    ) {
      continue;
    }

    const parameter = { tag: "var", name: param.name } as const;
    const ownership = core_expr_ownership(parameter, ctx, hooks);

    if (ownership.tag !== "unique_heap") {
      continue;
    }

    let reason: CoreAllocationFact["reason"];

    if (ownership.reason === "runtime_aggregate") {
      reason = "runtime_aggregate";
    } else if (ownership.reason === "runtime_union") {
      reason = "runtime_union";
    } else if (ownership.reason === "closure") {
      reason = "closure";
    } else if (ownership.reason === "bytes") {
      reason = "runtime_bytes";
    } else {
      reason = "runtime_text";
    }

    const subject = function_parameter_allocation_subject(
      parameter,
      param.annotation,
      reason,
      ctx,
    );
    const fact = record_allocation(
      subject,
      reason,
      { name: "function_param:" + param.name, scratch: undefined },
      state,
      "function_param:" + param.name,
    );

    if (fact === undefined) {
      throw new Error(
        "Missing function parameter allocation fact: " + param.name,
      );
    }

    fact.owner = param.name;
    register_core_allocation_fact_lifetime_subject(fact, function_body);
    set_core_allocation_fact_external(fact);
    state.binding_allocations.set(param.name, [fact]);
    state.runtime_bindings.add(param.name);
    state.value_allocations.set(parameter, [fact]);
  }
}

function function_parameter_allocation_subject<ctx>(
  parameter: Extract<CoreExpr, { tag: "var" }>,
  annotation: string | undefined,
  reason: CoreAllocationFact["reason"],
  ctx: ctx,
): CoreExpr {
  if (
    annotation === undefined ||
    (reason !== "runtime_aggregate" && reason !== "runtime_union")
  ) {
    return parameter;
  }

  const type_expr = { tag: "var", name: annotation } as const;
  const type_value = static_type_value(
    type_expr,
    ctx as ctx & import("./type_static.ts").TypeStaticCtx,
  );

  if (reason === "runtime_aggregate") {
    if (type_value?.tag !== "struct_type") {
      throw new Error(
        "Function parameter " + parameter.name +
          " requires a static struct type",
      );
    }

    return { tag: "struct_value", type_expr, fields: [] };
  }

  if (type_value?.tag !== "union_type") {
    throw new Error(
      "Function parameter " + parameter.name +
        " requires a static union type",
    );
  }

  const first_case = type_value.cases[0];
  if (first_case === undefined) {
    throw new Error(
      "Function parameter " + parameter.name + " has an empty union type",
    );
  }

  return {
    tag: "union_case",
    name: first_case.name,
    value: undefined,
    type_expr,
  };
}

export function core_allocation_facts_for_value(
  plan: CoreAllocationPlan,
  value: CoreExpr,
): CoreAllocationFact[] | undefined {
  const values = value_allocations_by_plan.get(plan);
  if (!values) {
    return undefined;
  }
  const facts = values.get(value);
  if (!facts) {
    return undefined;
  }
  return [...facts];
}

export { core_allocation_fact_subject } from "./allocation/metadata.ts";

export function link_drop_allocations(
  drops: CoreDropPlan,
  allocations: CoreAllocationPlan,
): CoreDropPlan {
  const used = new Set<string>();
  const linked = new Set<string>();
  const steps = drops.steps.map((step, step_index) => {
    if (step.tag !== "heap_drop") {
      return step;
    }

    if (step.storage !== "persistent_unique_heap") {
      return step;
    }

    const all_matching = allocations.facts.filter((fact) => {
      if (fact.storage !== "persistent_unique_heap") {
        return false;
      }

      if (fact.ownership.tag !== "unique_heap") {
        return false;
      }

      if (fact.ownership.reason !== step.ownership.reason) {
        const text_bytes_match = (fact.ownership.reason === "bytes" &&
          step.ownership.reason === "text") ||
          (fact.ownership.reason === "text" &&
            step.ownership.reason === "bytes");

        if (!text_bytes_match) {
          return false;
        }
      }

      return true;
    });
    const matching = all_matching.filter((fact) => {
      return !used.has(fact.allocation_id);
    });

    let candidates = matching;
    let exact_subject = false;
    const drop_subject = find_core_diagnostic_subject(step);
    const related_subject = core_diagnostic_related_subject(step);
    if (drop_subject && allocation_subject_is_expr(drop_subject)) {
      const explicit = core_allocation_facts_for_value(
        allocations,
        drop_subject,
      );
      const explicit_ids = new Set<string>();
      if (explicit) {
        for (const fact of explicit) {
          explicit_ids.add(fact.allocation_id);
        }
      }
      const exact_candidates = all_matching;
      let exact = exact_candidates.filter((fact) => {
        return explicit_ids.has(fact.allocation_id);
      });
      if (exact.length === 0) {
        const canonical_subject = canonical_core_expr(drop_subject);
        exact = exact_candidates.filter((fact) => {
          const fact_subject = core_allocation_fact_subject(fact);
          if (!fact_subject) {
            return false;
          }
          return canonical_core_expr(fact_subject) === canonical_subject;
        });
      }
      if (
        exact.length === 0 &&
        (drop_subject.tag === "var" || drop_subject.tag === "linear")
      ) {
        exact = exact_candidates.filter((fact) => {
          return fact.owner === drop_subject.name;
        });
      }
      if (
        exact.length === 0 && drop_subject.tag === "field" &&
        (drop_subject.object.tag === "var" ||
          drop_subject.object.tag === "linear")
      ) {
        const destination_owner = drop_subject.object.name;
        exact = all_matching.filter((fact) => {
          return core_allocation_fact_destinations(fact).some((destination) => {
            return destination.owner === destination_owner &&
              destination.field === drop_subject.name;
          });
        });
      }
      if (exact.length > 1) {
        const owned_ids = new Set<string>();
        for (const candidate of exact) {
          if (!candidate.owned_children) {
            continue;
          }
          for (const child of candidate.owned_children) {
            for (const allocation_id of child.allocation_ids) {
              owned_ids.add(allocation_id);
            }
          }
        }
        const roots = exact.filter((candidate) => {
          return !owned_ids.has(candidate.allocation_id);
        });
        if (roots.length > 0) {
          exact = roots;
        }
      }
      if (exact.length > 0) {
        candidates = exact;
        exact_subject = true;
      }
    }

    if (!exact_subject && step.owner) {
      const scoped_owner_prefix = "_local_" + step.owner + "#";
      candidates = matching.filter((fact) => {
        if (fact.owner === step.owner) {
          return true;
        }
        if (!fact.owner) {
          return false;
        }
        return fact.owner.startsWith(scoped_owner_prefix);
      });

      if (candidates.length === 0) {
        const unowned = matching.filter((fact) => !fact.owner);
        const linked_owner_allocations = all_matching.filter((fact) => {
          return fact.owner === step.owner && linked.has(fact.allocation_id);
        });

        if (unowned.length === 1) {
          candidates = unowned;
        } else if (linked_owner_allocations.length > 0) {
          candidates = linked_owner_allocations;
        } else {
          const allocation_owners = new Set(
            matching.map((fact) => fact.owner).filter((owner) => {
              return owner !== undefined;
            }),
          );

          if (allocation_owners.size === 1) {
            candidates = matching;
          } else if (
            matching.length > 1 &&
            matching.every((fact) => linked.has(fact.allocation_id))
          ) {
            candidates = matching;
          }
        }
      }
    } else if (!exact_subject) {
      const same_scope = matching.filter((fact) => fact.scope === step.scope);
      const first = same_scope[0];
      if (first) {
        candidates = [first];
      }
    }

    if (step.edge === "assignment_replace" && !exact_subject) {
      let later_replacements = 0;
      let has_later_terminal = false;

      for (const later of drops.steps.slice(step_index + 1)) {
        if (
          later.tag !== "heap_drop" ||
          later.storage !== "persistent_unique_heap" ||
          later.owner !== step.owner ||
          later.ownership.reason !== step.ownership.reason
        ) {
          continue;
        }

        if (later.edge === "assignment_replace") {
          later_replacements += 1;
        } else {
          has_later_terminal = true;
        }
      }

      let reserved = later_replacements;
      if (has_later_terminal) {
        reserved += 1;
      }
      const available = candidates.length - reserved;

      if (available > 0) {
        candidates = candidates.slice(0, available);
      } else {
        candidates = [];
      }
    }

    if (candidates.length === 0) {
      return step;
    }

    const fact = candidates[0];
    if (!fact) {
      return step;
    }

    if (candidates.length > 1) {
      if (!allocations_share_cleanup_layout(candidates)) {
        return step;
      }

      if (step.edge === "assignment_replace" || !step.owner) {
        for (const candidate of candidates) {
          used.add(candidate.allocation_id);
        }
      }

      for (const candidate of candidates) {
        linked.add(candidate.allocation_id);
      }

      const owned_children = merged_allocation_owned_children(candidates);
      const linked_step = {
        ...step,
        allocation_ids: candidates.map((candidate) => {
          return candidate.allocation_id;
        }),
        byte_size: fact.byte_size,
        alignment: fact.alignment,
        layout: fact.layout,
      };
      if (owned_children) {
        const result = { ...linked_step, owned_children };
        if (drop_subject) {
          record_core_diagnostic_subject(result, drop_subject);
        }
        if (related_subject) {
          record_core_diagnostic_related_subject(result, related_subject);
        }
        return result;
      }
      if (drop_subject) {
        record_core_diagnostic_subject(linked_step, drop_subject);
      }
      if (related_subject) {
        record_core_diagnostic_related_subject(linked_step, related_subject);
      }
      return linked_step;
    }

    if (step.edge === "assignment_replace" || !step.owner) {
      used.add(fact.allocation_id);
    }
    linked.add(fact.allocation_id);
    const owned_children = linked_allocation_owned_children(
      fact,
      allocations,
    );
    const linked_step = {
      ...step,
      allocation_id: fact.allocation_id,
      byte_size: fact.byte_size,
      alignment: fact.alignment,
      layout: fact.layout,
    };
    if (owned_children) {
      const result = { ...linked_step, owned_children };
      if (drop_subject) {
        record_core_diagnostic_subject(result, drop_subject);
      }
      if (related_subject) {
        record_core_diagnostic_related_subject(result, related_subject);
      }
      return result;
    }
    if (drop_subject) {
      record_core_diagnostic_subject(linked_step, drop_subject);
    }
    if (related_subject) {
      record_core_diagnostic_related_subject(linked_step, related_subject);
    }
    return linked_step;
  });

  const owned_allocations = new Set<string>();
  for (const fact of allocations.facts) {
    for (const child of fact.owned_children || []) {
      for (const allocation_id of child.allocation_ids) {
        owned_allocations.add(allocation_id);
      }
    }
  }

  return {
    steps: steps.filter((step) => {
      if (step.tag !== "heap_drop") {
        return true;
      }
      if (
        step.edge === "conditional_cleanup" ||
        step.edge === "loop_zero_iteration_cleanup"
      ) {
        return true;
      }
      const allocation_ids: string[] = [];
      if (step.allocation_id) {
        allocation_ids.push(step.allocation_id);
      }
      for (const allocation_id of step.allocation_ids || []) {
        allocation_ids.push(allocation_id);
      }
      if (allocation_ids.length === 0) {
        return true;
      }
      return !allocation_ids.every((allocation_id) => {
        return owned_allocations.has(allocation_id);
      });
    }),
  };
}

function allocation_subject_is_expr(
  subject: import("./source_origin.ts").CoreSourceSubject,
): subject is CoreExpr {
  switch (subject.tag) {
    case "bind":
    case "assign":
    case "index_assign":
    case "range_loop":
    case "collection_loop":
    case "if_stmt":
    case "if_else_stmt":
    case "if_let_stmt":
    case "type_check":
    case "break":
    case "continue":
    case "return":
    case "expr":
      return false;
    default:
      return true;
  }
}

function linked_allocation_owned_children(
  parent: CoreAllocationPlan["facts"][number],
  allocations: CoreAllocationPlan,
): CoreAllocationPlan["facts"][number]["owned_children"] {
  if (parent.owned_children) {
    return nested_allocation_owned_children(
      parent.owned_children,
      allocations,
      new Set([parent.allocation_id]),
    );
  }
  return undefined;
}

function nested_allocation_owned_children(
  children: CoreAllocationOwnedChild[],
  allocations: CoreAllocationPlan,
  ancestors: ReadonlySet<string>,
): CoreAllocationOwnedChild[] {
  return children.map((child) => {
    const child_facts = allocations.facts.filter((fact) => {
      return child.allocation_ids.includes(fact.allocation_id) &&
        !ancestors.has(fact.allocation_id);
    });
    const owned_children = merged_allocation_owned_children(child_facts);
    if (!owned_children) {
      return { ...child };
    }

    const next_ancestors = new Set(ancestors);
    for (const fact of child_facts) {
      next_ancestors.add(fact.allocation_id);
    }
    return {
      ...child,
      owned_children: nested_allocation_owned_children(
        owned_children,
        allocations,
        next_ancestors,
      ),
    };
  });
}

function merged_allocation_owned_children(
  parents: CoreAllocationPlan["facts"],
): CoreAllocationOwnedChild[] | undefined {
  const result: CoreAllocationOwnedChild[] = [];
  for (const parent of parents) {
    if (!parent.owned_children) {
      continue;
    }
    for (const child of parent.owned_children) {
      merge_allocation_owned_child(result, child);
    }
  }
  if (result.length === 0) {
    return undefined;
  }
  return result;
}

function merge_allocation_owned_child(
  children: CoreAllocationOwnedChild[],
  child: CoreAllocationOwnedChild,
): void {
  const existing = children.find((candidate) => {
    return candidate.offset === child.offset &&
      candidate.layout === child.layout &&
      candidate.ownership.reason === child.ownership.reason;
  });
  if (!existing) {
    const owned_children: CoreAllocationOwnedChild[] = [];
    for (const owned_child of child.owned_children || []) {
      merge_allocation_owned_child(owned_children, owned_child);
    }
    const copy: CoreAllocationOwnedChild = {
      allocation_ids: [...child.allocation_ids],
      offset: child.offset,
      ownership: child.ownership,
      layout: child.layout,
    };
    if (owned_children.length > 0) {
      copy.owned_children = owned_children;
    }
    children.push(copy);
    return;
  }

  for (const allocation_id of child.allocation_ids) {
    if (!existing.allocation_ids.includes(allocation_id)) {
      existing.allocation_ids.push(allocation_id);
    }
  }
  if (!child.owned_children) {
    return;
  }
  const owned_children = existing.owned_children || [];
  for (const owned_child of child.owned_children) {
    merge_allocation_owned_child(owned_children, owned_child);
  }
  existing.owned_children = owned_children;
}

function allocations_share_cleanup_layout(
  facts: CoreAllocationPlan["facts"],
): boolean {
  const first = facts[0];

  if (!first) {
    return false;
  }

  for (const fact of facts) {
    if (fact.alignment !== first.alignment || fact.layout !== first.layout) {
      return false;
    }

    if (fact.byte_size.tag !== first.byte_size.tag) {
      return false;
    }

    if (
      fact.byte_size.tag === "static" &&
      first.byte_size.tag === "static" &&
      fact.byte_size.value !== first.byte_size.value
    ) {
      return false;
    }

    if (
      fact.byte_size.tag === "runtime" &&
      first.byte_size.tag === "runtime" &&
      fact.byte_size.formula !== first.byte_size.formula
    ) {
      return false;
    }
  }

  return true;
}
