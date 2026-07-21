import type { Core, CoreCleanupEmission, CoreExpr } from "./ast.ts";
import type { CoreStmt } from "./ast.ts";
import type { CoreDropPlan } from "./drop.ts";
import type { CoreAllocationPlan } from "./model/allocation.ts";
import {
  core_allocation_fact_emission_subjects,
  core_allocation_fact_subject,
} from "./allocation/metadata.ts";
import { find_core_diagnostic_subject } from "./source_origin.ts";

export function elaborate_core_cleanup_emission(
  core: Core,
  drops: CoreDropPlan,
  allocations: CoreAllocationPlan,
): CoreCleanupEmission[] {
  const result: CoreCleanupEmission[] = [];
  const anchors = cleanup_anchors(core.statements);
  const next_anchor = new Map<string, number>();
  const next_assignment_anchor = new Map<string, number>();
  const prior_scope = new Map<string, string>();

  for (const step of drops.steps) {
    if (step.tag !== "heap_drop") {
      continue;
    }

    if (!step.byte_size || !step.alignment || !step.layout) {
      continue;
    }

    const allocation_ids = [...(step.allocation_ids || [])];
    if (step.allocation_id) {
      allocation_ids.push(step.allocation_id);
    }

    if (allocation_ids.length === 0) {
      continue;
    }

    let anchor: CleanupAnchor | undefined;

    if (step.edge === "assignment_replace") {
      const owner = step.owner;
      if (!owner) {
        throw new Error("Assignment cleanup requires an owner");
      }
      const assignment_anchors = (anchors.get(step.edge) || []).filter(
        (candidate) => {
          return candidate.stmt.tag === "assign" &&
            candidate.stmt.name === owner && candidate.scope === step.scope;
        },
      );
      const anchor_key = step.scope + "\u0000" + owner;
      const anchor_index = next_assignment_anchor.get(anchor_key) || 0;
      anchor = assignment_anchors[anchor_index];
      next_assignment_anchor.set(anchor_key, anchor_index + 1);
    } else if (step.edge === "scope_exit") {
      anchor = (anchors.get(step.edge) || []).find((candidate) => {
        return candidate.scope === step.scope;
      });
    } else {
      let anchor_index = next_anchor.get(step.edge) || 0;
      if (prior_scope.get(step.edge) !== step.scope) {
        next_anchor.set(step.edge, anchor_index + 1);
        prior_scope.set(step.edge, step.scope);
      } else if (anchor_index > 0) {
        anchor_index -= 1;
      }
      anchor = anchors.get(step.edge)?.[anchor_index];
    }
    const row: CoreCleanupEmission = {
      step_id: step.id,
      allocation_ids,
      edge: step.edge,
      scope: step.scope,
      owner: step.owner,
      pointer_local: cleanup_pointer_local(step.id, step.owner),
      replacement_value_local: replacement_value_local(step),
      replacement_old_local: replacement_old_local(step),
      statement_index: cleanup_statement_index(
        core,
        step.owner,
        step.edge,
        step.scope,
      ),
      statement_path: anchor?.path,
      byte_size: step.byte_size,
      alignment: step.alignment,
      layout: step.layout,
      owned_children: step.owned_children || [],
    };
    const destructor_type_expr = cleanup_destructor_type_expr(
      allocation_ids,
      allocations,
    );
    if (destructor_type_expr !== undefined) {
      row.destructor_type_expr = destructor_type_expr;
    }
    result.push(row);
    const subject = find_core_diagnostic_subject(step);
    if (
      step.owner === undefined && subject && cleanup_subject_is_expr(subject)
    ) {
      const rows = expression_cleanup_rows.get(subject) || new Map();
      rows.set(row.step_id, row);
      expression_cleanup_rows.set(subject, rows);
    }
    if (anchor) {
      const rows = statement_cleanup_rows.get(anchor.stmt) || [];
      rows.push(row);
      statement_cleanup_rows.set(anchor.stmt, rows);
    }
  }

  return result;
}

function cleanup_destructor_type_expr(
  allocation_ids: string[],
  allocations: CoreAllocationPlan,
): CoreExpr | undefined {
  let result: CoreExpr | undefined;

  for (const allocation_id of allocation_ids) {
    const fact = allocations.facts.find((candidate) => {
      return candidate.allocation_id === allocation_id;
    });
    if (!fact) {
      throw new Error("Missing cleanup allocation fact: " + allocation_id);
    }
    if (
      fact.reason !== "runtime_aggregate" && fact.reason !== "runtime_union"
    ) {
      return undefined;
    }

    const candidates: CoreExpr[] = [];
    const subject = core_allocation_fact_subject(fact);
    if (subject !== undefined) {
      candidates.push(subject);
    }
    const emission_subjects = core_allocation_fact_emission_subjects(fact);
    if (emission_subjects !== undefined) {
      candidates.push(...emission_subjects);
    }

    let type_expr: CoreExpr | undefined;
    for (const candidate of candidates) {
      type_expr = owned_value_type_expr(candidate, fact.reason);
      if (type_expr !== undefined) {
        break;
      }
    }
    if (type_expr === undefined) {
      return undefined;
    }
    if (result === undefined) {
      result = type_expr;
      continue;
    }
    if (JSON.stringify(result) !== JSON.stringify(type_expr)) {
      return undefined;
    }
  }

  return result;
}

function owned_value_type_expr(
  value: CoreExpr,
  reason: "runtime_aggregate" | "runtime_union",
): CoreExpr | undefined {
  if (value.tag === "if") {
    const then_type = owned_value_type_expr(value.then_branch, reason);
    const else_type = owned_value_type_expr(value.else_branch, reason);
    if (
      then_type !== undefined && else_type !== undefined &&
      JSON.stringify(then_type) === JSON.stringify(else_type)
    ) {
      return then_type;
    }
    return undefined;
  }

  if (reason === "runtime_union" && value.tag === "union_case") {
    return value.type_expr;
  }

  if (reason === "runtime_aggregate" && value.tag === "struct_value") {
    return value.type_expr;
  }

  return undefined;
}

function cleanup_pointer_local(
  step_id: string,
  owner: string | undefined,
): string | undefined {
  if (owner) {
    return undefined;
  }

  return "_cleanup_" + step_id;
}

function replacement_value_local(
  step: CoreDropPlan["steps"][number],
): string | undefined {
  if (step.edge !== "assignment_replace") {
    return undefined;
  }

  return "_replace_value_" + step.id;
}

function replacement_old_local(
  step: CoreDropPlan["steps"][number],
): string | undefined {
  if (step.edge !== "assignment_replace") {
    return undefined;
  }

  return "_replace_old_" + step.id;
}

const statement_cleanup_rows = new WeakMap<CoreStmt, CoreCleanupEmission[]>();
const expression_cleanup_rows = new WeakMap<
  CoreExpr,
  Map<string, CoreCleanupEmission>
>();

export function core_statement_cleanup_rows(
  stmt: CoreStmt,
): CoreCleanupEmission[] {
  return statement_cleanup_rows.get(stmt) || [];
}

export function core_expression_cleanup_rows(
  expr: CoreExpr,
): CoreCleanupEmission[] {
  const rows = expression_cleanup_rows.get(expr);
  if (!rows) {
    return [];
  }

  return Array.from(rows.values());
}

function cleanup_subject_is_expr(
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

type CleanupAnchor = { stmt: CoreStmt; path: number[]; scope: string };

function cleanup_anchors(
  statements: CoreStmt[],
): Map<CoreCleanupEmission["edge"], CleanupAnchor[]> {
  const result = new Map<CoreCleanupEmission["edge"], CleanupAnchor[]>();
  let next_block = 0;
  let next_loop = 0;

  function add(edge: CoreCleanupEmission["edge"], anchor: CleanupAnchor): void {
    const values = result.get(edge) || [];
    values.push(anchor);
    result.set(edge, values);
  }

  function scan(items: CoreStmt[], parent: number[], scope: string): void {
    for (let index = 0; index < items.length; index += 1) {
      const stmt = items[index];
      if (!stmt) {
        continue;
      }
      statement_cleanup_rows.delete(stmt);
      const path = parent.concat(index);
      const anchor = { stmt, path, scope };
      if (stmt.tag === "assign") {
        add("assignment_replace", anchor);
      }
      if (stmt.tag === "expr") {
        add("discarded_expr", anchor);
      }
      if (stmt.tag === "return") {
        add("return_exit", anchor);
      }
      if (stmt.tag === "break") {
        add("break_exit", anchor);
      }
      if (stmt.tag === "continue") {
        add("continue_exit", anchor);
      }
      if (
        stmt.tag === "if_stmt" || stmt.tag === "if_else_stmt" ||
        stmt.tag === "if_let_stmt"
      ) {
        add("conditional_cleanup", anchor);
      }
      if (stmt.tag === "range_loop" || stmt.tag === "collection_loop") {
        add("loop_zero_iteration_cleanup", anchor);
      }
      if (stmt.tag === "if_stmt" || stmt.tag === "if_let_stmt") {
        const block_scope = "block#" + next_block.toString();
        next_block += 1;
        scan(stmt.body, path.concat(0), block_scope);
      } else if (stmt.tag === "if_else_stmt") {
        const then_scope = "block#" + next_block.toString();
        next_block += 1;
        scan(stmt.then_body, path.concat(0), then_scope);
        const else_scope = "block#" + next_block.toString();
        next_block += 1;
        scan(stmt.else_body, path.concat(1), else_scope);
      } else if (
        stmt.tag === "range_loop" || stmt.tag === "collection_loop"
      ) {
        const loop_scope = "loop#" + next_loop.toString();
        next_loop += 1;
        scan(stmt.body, path.concat(0), loop_scope);
      }
    }

    const final_index = items.length - 1;
    const final_stmt = items[final_index];
    if (final_stmt) {
      add("scope_exit", {
        stmt: final_stmt,
        path: parent.concat(final_index),
        scope,
      });
    }
  }

  scan(statements, [], "program#0");
  return result;
}

function cleanup_statement_index(
  core: Core,
  owner: string | undefined,
  edge: CoreCleanupEmission["edge"],
  scope: string,
): number | undefined {
  if (edge === "scope_exit") {
    if (scope !== "program#0") {
      return undefined;
    }
    return core.statements.length - 1;
  }

  if (edge === "assignment_replace") {
    return core.statements.findIndex((stmt) => {
      return stmt.tag === "assign" && stmt.name === owner;
    });
  }

  if (edge === "discarded_expr") {
    return core.statements.findIndex((stmt) => stmt.tag === "expr");
  }

  if (
    edge === "conditional_cleanup" || edge === "loop_zero_iteration_cleanup"
  ) {
    return core.statements.findIndex((stmt) => {
      return stmt.tag === "range_loop" || stmt.tag === "collection_loop" ||
        stmt.tag === "if_stmt" || stmt.tag === "if_else_stmt" ||
        stmt.tag === "if_let_stmt";
    });
  }

  return undefined;
}
