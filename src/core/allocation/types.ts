import type { CoreExpr, CoreField, CoreFnType, CoreStmt } from "../ast.ts";
import type { CoreOwnershipHooks } from "../ownership/types.ts";
import type { CoreAllocationFact } from "../model/allocation.ts";

export type {
  CoreAllocationByteSize,
  CoreAllocationFact,
  CoreAllocationLayout,
  CoreAllocationOwnedChild,
  CoreAllocationPlan,
  CoreAllocationReason,
} from "../model/allocation.ts";

export type CoreAllocationHooks<ctx> = CoreOwnershipHooks<ctx> & {
  core_assignment_value: (
    stmt: Extract<CoreStmt, { tag: "assign" }>,
    ctx: ctx,
  ) => CoreExpr;
  core_binding_value: (
    stmt: Extract<CoreStmt, { tag: "bind" }>,
    ctx: ctx,
  ) => CoreExpr;
  closure_body_ctx?: (
    expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
    ctx: ctx,
  ) => ctx | undefined;
  closure_fn_type: (expr: CoreExpr, ctx: ctx) => CoreFnType | undefined;
  is_runtime_text_concat: (
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: ctx,
  ) => boolean;
  local_value_exists: (name: string, ctx: ctx) => boolean;
  materialized_binding: (name: string, ctx: ctx) => boolean;
  mutable_binding: (name: string, ctx: ctx) => boolean;
  is_static_value_expr: (expr: CoreExpr, ctx: ctx) => boolean;
  static_collection_fields: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreField[] | undefined;
  runtime_union_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  static_core_call_branch_app?: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "if" }> | undefined;
  scoped_static_core_call_value?: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    target: Extract<CoreExpr, { tag: "lam" }>,
    ctx: ctx,
  ) => { value: CoreExpr; ctx: ctx };
  static_core_call_requires_scope?: (
    target: Extract<CoreExpr, { tag: "lam" }>,
  ) => boolean;
  static_core_call_target?: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "lam" }> | undefined;
  static_core_call_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  static_text_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
};

export type CoreAllocationState = {
  next_allocation: number;
  next_block: number;
  next_closure: number;
  next_loop: number;
  next_scratch: number;
  next_static_call: number;
  current_allocation_instance: string | undefined;
  facts: CoreAllocationFact[];
  recorded: WeakMap<CoreExpr, Set<string>>;
  runtime_bindings: Set<string>;
  binding_allocations: Map<string, CoreAllocationFact[]>;
  value_allocations: WeakMap<CoreExpr, CoreAllocationFact[]>;
  closure_result_allocations: Map<string, CoreAllocationFact[]>;
  static_closure_bindings: Map<
    string,
    Extract<CoreExpr, { tag: "lam" }>
  >;
  forced_closures: WeakSet<CoreExpr>;
  forced_static_parameter_closure_branches: WeakSet<CoreExpr>;
  nonmaterialized_struct_values: WeakSet<CoreExpr>;
  nonmaterialized_union_values: WeakSet<CoreExpr>;
  materialized_bindings: Set<string>;
  mutable_bindings: Set<string>;
};

export type CoreAllocationScope = {
  name: string;
  scratch: string | undefined;
};
