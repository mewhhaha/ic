import { expect } from "../expect.ts";
import type { CoreExpr, CoreFnType } from "./ast.ts";
import { unsupported_core_captured_assignment_message } from "./closure_capture.ts";
import type {
  ClosureCapture,
  ClosureEmitCtx,
  CoreClosureEmitCtx,
  CoreClosureEmitHooks,
  LiftedClosure,
} from "./closure_runtime.ts";
import { align_to, val_type_align, val_type_size } from "./memory.ts";
import { same_runtime_aggregate_type_expr } from "./runtime_aggregate.ts";
import { same_runtime_union_type_expr } from "./runtime_union.ts";
import { clone_core_host_imports } from "./host_import.ts";

export function ensure_lifted_closure<ctx extends CoreClosureEmitCtx>(
  expr: Extract<CoreExpr, { tag: "lam" }>,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreClosureEmitHooks<ctx>,
): LiftedClosure {
  const closures = ctx.closures;
  expect(closures, "Core closures require closure emit context");
  const existing = closures.by_lam.get(expr);

  if (existing) {
    expect(
      same_closure_fn_type(existing.fn_type, fn_type),
      "Core closure emitted with inconsistent function type",
    );
    return existing;
  }

  const captures = hooks.core_lam_capture_names(expr, ctx);
  expect(captures, unsupported_core_captured_assignment_message);

  const id = closures.next_lift;
  closures.next_lift += 1;
  const func_name = "__closure_" + id.toString();
  const type_name = ensure_closure_func_type(fn_type, closures);
  const table_index = closures.table_elements.length;
  const capture_fields = closure_capture_fields(captures, id, ctx);
  const lift: LiftedClosure = {
    id,
    lam: expr,
    func_name,
    table_index,
    type_name,
    fn_type,
    captures: capture_fields,
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    materialized_bindings: clone_optional_set(ctx.materialized_bindings),
    host_imports: clone_core_host_imports(ctx.host_imports),
    allocation_permits: ctx.allocation_permits,
  };

  closures.allocation_permit_states.add(ctx.allocation_permits);
  closures.by_lam.set(expr, lift);
  closures.lifts.push(lift);
  closures.table_elements.push(func_name);
  return lift;
}

export function closure_env_size(lift: LiftedClosure): number {
  let size = 4;

  for (const capture of lift.captures) {
    size = Math.max(size, capture.offset + val_type_size(capture.type));
  }

  return align_to(size, closure_env_alignment(lift));
}

export function closure_env_alignment(lift: LiftedClosure): 8 | 16 {
  for (const capture of lift.captures) {
    if (val_type_align(capture.type) === 16) {
      return 16;
    }
  }

  return 8;
}

export function ensure_closure_func_type(
  fn_type: CoreFnType,
  closures: ClosureEmitCtx,
): string {
  const name = closure_func_type_name(fn_type);
  const existing = closures.types.get(name);

  if (existing) {
    return name;
  }

  closures.types.set(name, {
    name,
    params: ["i32", ...fn_type.params],
    result: fn_type.result,
  });
  return name;
}

function closure_capture_fields<ctx extends CoreClosureEmitCtx>(
  captures: string[],
  id: number,
  ctx: ctx,
): ClosureCapture[] {
  const result: ClosureCapture[] = [];
  let offset = 4;

  for (const name of captures) {
    const type = ctx.locals.get(name);
    expect(type, "Missing captured core local: " + name);
    offset = align_to(offset, val_type_align(type));
    result.push({
      source_name: name,
      local_name: "__capture_" + id.toString() + "_" + name,
      type,
      fn_type: ctx.fn_types.get(name),
      struct_type: ctx.struct_locals.get(name),
      union_type: ctx.union_locals.get(name),
      is_text: ctx.text_locals.has(name),
      is_frozen: ctx.frozen_locals ? ctx.frozen_locals.has(name) : false,
      offset,
    });
    offset += val_type_size(type);
  }

  return result;
}

function clone_optional_set(
  value: Set<string> | undefined,
): Set<string> | undefined {
  if (!value) {
    return undefined;
  }

  return new Set(value);
}

function closure_func_type_name(fn_type: CoreFnType): string {
  return "closure_" + ["i32", ...fn_type.params].join("_") + "_to_" +
    fn_type.result;
}

function same_closure_fn_type(left: CoreFnType, right: CoreFnType): boolean {
  if (left.result !== right.result) {
    return false;
  }

  if (left.result_text !== right.result_text) {
    return false;
  }

  if (
    !same_runtime_aggregate_type_expr(left.result_struct, right.result_struct)
  ) {
    return false;
  }

  if (left.params.length !== right.params.length) {
    return false;
  }

  for (let index = 0; index < left.params.length; index += 1) {
    const left_param = left.params[index];
    const right_param = right.params[index];
    const left_text = left.param_texts[index];
    const right_text = right.param_texts[index];
    const left_constraint = left.param_constraints?.[index];
    const right_constraint = right.param_constraints?.[index];
    const left_struct = left.param_structs?.[index];
    const right_struct = right.param_structs?.[index];
    const left_union = left.param_unions?.[index];
    const right_union = right.param_unions?.[index];
    const left_fn = left.param_fns?.[index];
    const right_fn = right.param_fns?.[index];

    if (left_param !== right_param) {
      return false;
    }

    if (left_text !== right_text) {
      return false;
    }

    if (left_constraint !== right_constraint) {
      return false;
    }

    if (!same_runtime_aggregate_type_expr(left_struct, right_struct)) {
      return false;
    }

    if (!same_runtime_union_type_expr(left_union, right_union)) {
      return false;
    }

    if (left_fn || right_fn) {
      if (!left_fn || !right_fn) {
        return false;
      }

      if (!same_closure_fn_type(left_fn, right_fn)) {
        return false;
      }
    }
  }

  return true;
}
