import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "./ast.ts";
import { fresh_temp_local, set_local } from "./backend/util.ts";
import { closure_heap_global } from "./closure_runtime.ts";
import {
  align_to,
  load_instr,
  store_instr,
  val_type_align,
  val_type_size,
} from "./memory.ts";
import { type CoreScratchHeap, scratch_heap_global } from "./scratch.ts";
import {
  declare_runtime_text_slice_locals,
  emit_runtime_text_freeze_copy,
  runtime_text_slice_plan,
} from "./runtime_text.ts";
import {
  core_val_type_from_type_name,
  resolve_core_type_name,
  static_block_result,
  static_type_value,
  type TypeStaticCtx,
} from "./type_static.ts";

export type RuntimeAggregateField =
  | {
    tag: "value";
    name: string;
    offset: number;
    type: ValType;
    text: boolean;
    union_type_expr: CoreExpr | undefined;
  }
  | {
    tag: "struct";
    name: string;
    type_expr: CoreExpr;
    fields: RuntimeAggregateField[];
  }
  | {
    tag: "unit";
    name: string;
  };

export type RuntimeAggregateLayout = {
  type_expr: CoreExpr;
  size: number;
  align: number;
  fields: RuntimeAggregateField[];
};

export type RuntimeAggregateFieldAccess = {
  base: CoreExpr;
  field: RuntimeAggregateField;
};

type RuntimeAggregateLayoutInfo = {
  size: number;
  align: number;
};

type RuntimeAggregateTempCtx = {
  locals: Map<string, ValType>;
  next_temp: number;
};

export type RuntimeAggregateTypeCtx = TypeStaticCtx & {
  statics: Map<string, CoreExpr>;
  struct_locals: Map<string, CoreExpr>;
};

export type RuntimeAggregateTypeHooks<ctx extends RuntimeAggregateTypeCtx> = {
  check_closure_call_args: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: ctx,
  ) => void;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreFnType | undefined;
};

type RuntimeAggregateEmitCtx = RuntimeAggregateTempCtx & {
  next_loop: number;
  heap: {
    needed: boolean;
  };
  scratch: CoreScratchHeap;
  scratch_return_resets: string[];
};

export type RuntimeAggregateHooks<ctx extends TypeStaticCtx> = {
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  runtime_aggregate_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  runtime_union_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  same_runtime_aggregate_type_expr: (
    left: CoreExpr | undefined,
    right: CoreExpr | undefined,
    ctx: ctx,
  ) => boolean;
  same_runtime_union_type_expr: (
    left: CoreExpr,
    right: CoreExpr,
    ctx: ctx,
  ) => boolean;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
};

export type RuntimeAggregateFreezeCopySupportHooks<
  ctx extends TypeStaticCtx,
> = {
  runtime_union_freeze_copy_supported: (
    type_expr: CoreExpr,
    ctx: ctx,
  ) => boolean;
};

export type RuntimeAggregateFreezeCopyLocalHooks<
  ctx extends TypeStaticCtx,
> =
  & RuntimeAggregateFreezeCopySupportHooks<ctx>
  & {
    declare_runtime_union_freeze_copy_locals: (
      type_expr: CoreExpr,
      ctx: ctx,
    ) => void;
  };

export type RuntimeAggregateFreezeCopyHooks<ctx extends TypeStaticCtx> =
  & RuntimeAggregateHooks<ctx>
  & {
    emit_runtime_union_freeze_copy: (
      source: CoreExpr,
      type_expr: CoreExpr,
      ctx: ctx,
      hooks: RuntimeAggregateFreezeCopyHooks<ctx>,
    ) => Wat;
  };

export type RuntimeAggregatePlan = {
  local: string;
};

export function runtime_aggregate_plan(
  ctx: RuntimeAggregateTempCtx,
): RuntimeAggregatePlan {
  return {
    local: fresh_temp_local(ctx, "aggregate"),
  };
}

export function declare_runtime_aggregate_locals(
  plan: RuntimeAggregatePlan,
  ctx: { locals: Map<string, ValType> },
): void {
  set_local(ctx.locals, plan.local, "i32");
}

export function runtime_aggregate_layout<ctx extends TypeStaticCtx>(
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  ctx: ctx,
): RuntimeAggregateLayout {
  const type_value = static_type_value(value.type_expr, ctx);
  expect(
    type_value && type_value.tag === "struct_type",
    "Core runtime aggregate requires a static struct type",
  );

  return runtime_aggregate_struct_layout(value.type_expr, type_value, ctx);
}

export function runtime_aggregate_layout_for_type<ctx extends TypeStaticCtx>(
  type_expr: CoreExpr,
  ctx: ctx,
): RuntimeAggregateLayout {
  const type_value = static_type_value(type_expr, ctx);
  expect(
    type_value && type_value.tag === "struct_type",
    "Core runtime aggregate requires a static struct type",
  );

  return runtime_aggregate_struct_layout(type_expr, type_value, ctx);
}

export function runtime_aggregate_type_expr<
  ctx extends RuntimeAggregateTypeCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): CoreExpr | undefined {
  if (value.tag === "struct_value") {
    return value.type_expr;
  }

  if (value.tag === "var") {
    const local_type = ctx.struct_locals.get(value.name);

    if (local_type) {
      return local_type;
    }

    const static_value = ctx.statics.get(value.name);

    if (static_value) {
      return runtime_aggregate_type_expr(static_value, ctx, hooks);
    }
  }

  if (value.tag === "app") {
    const branch_type = runtime_aggregate_branch_call_type_expr(
      value,
      ctx,
      hooks,
    );

    if (branch_type) {
      return branch_type;
    }

    const fn_type = hooks.closure_fn_type(value.func, ctx);

    if (fn_type) {
      hooks.check_closure_call_args(value, fn_type, ctx);
      return fn_type.result_struct;
    }
  }

  if (value.tag === "field") {
    const access = runtime_aggregate_field_access(
      value.object,
      value.name,
      ctx,
      hooks,
    );

    if (access && access.field.tag === "struct") {
      return access.field.type_expr;
    }
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    return runtime_aggregate_type_expr(value.value, ctx, hooks);
  }

  if (value.tag === "scratch") {
    return runtime_aggregate_type_expr(value.body, ctx, hooks);
  }

  if (value.tag === "if") {
    const then_type = runtime_aggregate_type_expr(
      value.then_branch,
      ctx,
      hooks,
    );
    const else_type = runtime_aggregate_type_expr(
      value.else_branch,
      ctx,
      hooks,
    );
    expect(
      same_runtime_aggregate_type_expr(then_type, else_type, ctx),
      "Core runtime aggregate if branch type mismatch",
    );
    return then_type;
  }

  if (value.tag === "block") {
    return runtime_aggregate_block_result_type_expr(value, ctx, hooks);
  }

  return undefined;
}

function runtime_aggregate_branch_call_type_expr<
  ctx extends RuntimeAggregateTypeCtx,
>(
  value: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): CoreExpr | undefined {
  const branch = runtime_aggregate_call_branch(value.func, ctx, hooks);

  if (!branch) {
    return undefined;
  }

  const then_type = runtime_aggregate_type_expr(
    {
      tag: "app",
      func: branch.then_branch,
      args: value.args,
    },
    ctx,
    hooks,
  );
  const else_type = runtime_aggregate_type_expr(
    {
      tag: "app",
      func: branch.else_branch,
      args: value.args,
    },
    ctx,
    hooks,
  );

  expect(
    same_runtime_aggregate_type_expr(then_type, else_type, ctx),
    "Core runtime aggregate branch call type mismatch",
  );
  return then_type;
}

function runtime_aggregate_call_branch<
  ctx extends RuntimeAggregateTypeCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): Extract<CoreExpr, { tag: "if" }> | undefined {
  if (value.tag === "block") {
    const block_value = static_block_result(value);

    if (!block_value) {
      return undefined;
    }

    return runtime_aggregate_call_branch(block_value, ctx, hooks);
  }

  if (value.tag === "var") {
    const static_value = ctx.statics.get(value.name);

    if (!static_value) {
      return undefined;
    }

    return runtime_aggregate_call_branch(static_value, ctx, hooks);
  }

  if (value.tag !== "if") {
    return undefined;
  }

  const then_type = hooks.closure_fn_type(value.then_branch, ctx);

  if (!then_type) {
    return undefined;
  }

  const else_type = hooks.closure_fn_type(value.else_branch, ctx);

  if (!else_type) {
    return undefined;
  }

  return value;
}

function runtime_aggregate_block_result_type_expr<
  ctx extends RuntimeAggregateTypeCtx,
>(
  value: Extract<CoreExpr, { tag: "block" }>,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): CoreExpr | undefined {
  const final_stmt = value.statements[value.statements.length - 1];

  if (!final_stmt) {
    return undefined;
  }

  const final_expr = runtime_aggregate_block_final_expr(final_stmt);

  if (!final_expr) {
    return undefined;
  }

  const direct = runtime_aggregate_type_expr(final_expr, ctx, hooks);

  if (direct) {
    return direct;
  }

  const alias = runtime_aggregate_result_alias(final_expr);

  if (!alias) {
    return undefined;
  }

  return runtime_aggregate_block_alias_type_expr(
    alias,
    value.statements,
    ctx,
    hooks,
  );
}

function runtime_aggregate_block_final_expr(
  stmt: CoreStmt,
): CoreExpr | undefined {
  if (stmt.tag === "expr") {
    return stmt.expr;
  }

  if (stmt.tag === "return") {
    return stmt.value;
  }

  return undefined;
}

function runtime_aggregate_result_alias(expr: CoreExpr): string | undefined {
  const block_value = static_block_result(expr);

  if (block_value) {
    return runtime_aggregate_result_alias(block_value);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return runtime_aggregate_result_alias(expr.value);
  }

  if (expr.tag === "var") {
    return expr.name;
  }

  return undefined;
}

function runtime_aggregate_block_alias_type_expr<
  ctx extends RuntimeAggregateTypeCtx,
>(
  alias: string,
  statements: CoreStmt[],
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): CoreExpr | undefined {
  for (let index = statements.length - 2; index >= 0; index -= 1) {
    const stmt = statements[index];
    expect(stmt, "Missing runtime aggregate block statement");

    if (stmt.tag === "bind" && stmt.name === alias) {
      const annotation_type = runtime_aggregate_annotation_type_expr(
        stmt.annotation,
        ctx,
      );

      if (annotation_type) {
        return annotation_type;
      }

      return runtime_aggregate_type_expr(stmt.value, ctx, hooks);
    }

    if (stmt.tag === "assign" && stmt.name === alias) {
      return runtime_aggregate_type_expr(stmt.value, ctx, hooks);
    }
  }

  return undefined;
}

function runtime_aggregate_annotation_type_expr<ctx extends TypeStaticCtx>(
  annotation: string | undefined,
  ctx: ctx,
): CoreExpr | undefined {
  if (!annotation) {
    return undefined;
  }

  const type_expr: CoreExpr = { tag: "var", name: annotation };
  const type_value = static_type_value(type_expr, ctx);

  if (!type_value || type_value.tag !== "struct_type") {
    return undefined;
  }

  return type_expr;
}

export function same_runtime_aggregate_type_expr<ctx extends TypeStaticCtx>(
  left: CoreExpr | undefined,
  right: CoreExpr | undefined,
  ctx?: ctx,
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  if (ctx) {
    const left_type = static_type_value(left, ctx);
    const right_type = static_type_value(right, ctx);

    if (
      left_type && left_type.tag === "struct_type" &&
      right_type && right_type.tag === "struct_type"
    ) {
      return same_runtime_aggregate_type_value(left_type, right_type, ctx);
    }
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

export function runtime_aggregate_field_info<
  ctx extends RuntimeAggregateTypeCtx,
>(
  object: CoreExpr,
  name: string,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): RuntimeAggregateField | undefined {
  const access = runtime_aggregate_field_access(object, name, ctx, hooks);

  if (access) {
    return access.field;
  }

  return undefined;
}

export function runtime_aggregate_field_access<
  ctx extends RuntimeAggregateTypeCtx,
>(
  object: CoreExpr,
  name: string,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): RuntimeAggregateFieldAccess | undefined {
  if (object.tag === "field") {
    const parent = runtime_aggregate_field_access(
      object.object,
      object.name,
      ctx,
      hooks,
    );

    if (!parent || parent.field.tag !== "struct") {
      return undefined;
    }

    const nested = find_runtime_aggregate_field(parent.field.fields, name);

    if (!nested) {
      return undefined;
    }

    return {
      base: parent.base,
      field: nested,
    };
  }

  const type_expr = runtime_aggregate_type_expr(object, ctx, hooks);

  if (!type_expr) {
    return undefined;
  }

  const layout = runtime_aggregate_layout_for_type(type_expr, ctx);
  const field = find_runtime_aggregate_field(layout.fields, name);

  if (!field) {
    return undefined;
  }

  return {
    base: object,
    field,
  };
}

export function emit_runtime_aggregate_field_load<
  ctx extends RuntimeAggregateTypeCtx,
>(
  object: CoreExpr,
  name: string,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx> & {
    emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  },
): Wat {
  const access = runtime_aggregate_field_access(object, name, ctx, hooks);
  expect(access, "Missing runtime aggregate field: " + name);
  const field = access.field;
  expect(
    field.tag === "value",
    "Core runtime aggregate field " + name +
      " cannot be loaded as a standalone value yet",
  );
  return hooks.emit_expr(access.base, ctx) + "\n" + load_instr(
    field.type,
    field.offset,
  );
}

export function emit_runtime_aggregate_field_pointer<
  ctx extends RuntimeAggregateTypeCtx,
>(
  object: CoreExpr,
  name: string,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx> & {
    emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  },
): Wat {
  const access = runtime_aggregate_field_access(object, name, ctx, hooks);
  expect(access, "Missing runtime aggregate field: " + name);
  const field = access.field;
  expect(
    field.tag === "struct",
    "Core runtime aggregate field " + name +
      " cannot be emitted as an aggregate pointer",
  );

  if (field.fields.length === 0) {
    return hooks.emit_expr(access.base, ctx);
  }

  const first = field.fields[0];
  expect(first, "Missing first runtime aggregate nested field: " + name);
  const offset = runtime_aggregate_field_base_offset(first);

  if (offset === 0) {
    return hooks.emit_expr(access.base, ctx);
  }

  return [
    hooks.emit_expr(access.base, ctx),
    "i32.const " + offset.toString(),
    "i32.add",
  ].join("\n");
}

export function emit_runtime_aggregate_value<
  ctx extends RuntimeAggregateEmitCtx & TypeStaticCtx,
>(
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  ctx: ctx,
  hooks: RuntimeAggregateHooks<ctx>,
): Wat {
  const layout = runtime_aggregate_layout(value, ctx);
  const plan = runtime_aggregate_plan(ctx);
  declare_runtime_aggregate_locals(plan, ctx);
  const heap_name = runtime_aggregate_alloc_heap(ctx);
  const lines = [
    "global.get $" + heap_name,
    "local.set $" + plan.local,
    "global.get $" + heap_name,
    "i32.const " + layout.size.toString(),
    "i32.add",
    "global.set $" + heap_name,
  ];

  emit_runtime_aggregate_field_stores(
    plan.local,
    value,
    layout.fields,
    ctx,
    hooks,
    lines,
  );

  lines.push("local.get $" + plan.local);
  return lines.join("\n");
}

export function emit_runtime_aggregate_freeze_copy<
  ctx extends RuntimeAggregateEmitCtx & TypeStaticCtx,
>(
  source: CoreExpr,
  type_expr: CoreExpr,
  ctx: ctx,
  hooks: RuntimeAggregateFreezeCopyHooks<ctx>,
): Wat {
  const layout = runtime_aggregate_layout_for_type(type_expr, ctx);
  const plan = runtime_aggregate_plan(ctx);
  declare_runtime_aggregate_locals(plan, ctx);
  ctx.heap.needed = true;
  const lines = [
    "global.get $" + closure_heap_global,
    "local.set $" + plan.local,
    "global.get $" + closure_heap_global,
    "i32.const " + layout.size.toString(),
    "i32.add",
    "global.set $" + closure_heap_global,
  ];

  emit_runtime_aggregate_freeze_copy_field_stores(
    plan.local,
    source,
    layout.fields,
    ctx,
    hooks,
    lines,
  );

  lines.push("local.get $" + plan.local);
  return lines.join("\n");
}

export function declare_runtime_aggregate_freeze_copy_locals<
  ctx extends RuntimeAggregateTempCtx & TypeStaticCtx & { next_loop: number },
>(
  type_expr: CoreExpr,
  ctx: ctx,
  hooks?: RuntimeAggregateFreezeCopyLocalHooks<ctx>,
): void {
  const plan = runtime_aggregate_plan(ctx);
  declare_runtime_aggregate_locals(plan, ctx);
  const layout = runtime_aggregate_layout_for_type(type_expr, ctx);
  declare_runtime_aggregate_freeze_field_copy_locals(
    layout.fields,
    ctx,
    hooks,
  );
}

export function runtime_aggregate_freeze_copy_supported<
  ctx extends TypeStaticCtx,
>(
  type_expr: CoreExpr,
  ctx: ctx,
  hooks?: RuntimeAggregateFreezeCopySupportHooks<ctx>,
): boolean {
  const layout = runtime_aggregate_layout_for_type(type_expr, ctx);
  return runtime_aggregate_freeze_fields_supported(layout.fields, ctx, hooks);
}

function runtime_aggregate_alloc_heap(
  ctx: RuntimeAggregateEmitCtx,
): string {
  if (ctx.scratch_return_resets.length > 0) {
    ctx.scratch.needed = true;
    return scratch_heap_global;
  }

  ctx.heap.needed = true;
  return closure_heap_global;
}

function runtime_aggregate_struct_layout<ctx extends TypeStaticCtx>(
  type_expr: CoreExpr,
  type_value: Extract<CoreExpr, { tag: "struct_type" }>,
  ctx: ctx,
): RuntimeAggregateLayout {
  let offset = 0;
  let max_align = 1;
  const fields: RuntimeAggregateField[] = [];

  for (const field of type_value.fields) {
    const field_type_name = resolve_core_type_name(field.type_name, ctx);
    const field_layout = runtime_aggregate_type_layout(field_type_name, ctx);
    offset = align_to(offset, field_layout.align);
    const field_info = runtime_aggregate_field(
      field.name,
      field_type_name,
      offset,
      ctx,
    );
    fields.push(field_info);
    offset += field_layout.size;

    if (field_layout.align > max_align) {
      max_align = field_layout.align;
    }
  }

  return {
    type_expr,
    size: align_to(offset, max_align),
    align: max_align,
    fields,
  };
}

function runtime_aggregate_field<ctx extends TypeStaticCtx>(
  name: string,
  field_type_name: string,
  offset: number,
  ctx: ctx,
): RuntimeAggregateField {
  if (field_type_name === "Unit") {
    return { tag: "unit", name };
  }

  const field_type = runtime_aggregate_value_type(field_type_name);

  if (field_type) {
    return {
      tag: "value",
      name,
      offset,
      type: field_type,
      text: field_type_name === "Text",
      union_type_expr: undefined,
    };
  }

  const type_expr: CoreExpr = { tag: "var", name: field_type_name };
  const type_value = static_type_value(type_expr, ctx);

  if (type_value && type_value.tag === "union_type") {
    return {
      tag: "value",
      name,
      offset,
      type: "i32",
      text: false,
      union_type_expr: type_expr,
    };
  }

  if (!type_value || type_value.tag !== "struct_type") {
    throw new Error(
      "Core runtime aggregate field " + name +
        " must be Int, I32, U32, I64, Text, Unit, a union type, " +
        "or a static-shaped struct type",
    );
  }

  return {
    tag: "struct",
    name,
    type_expr,
    fields: runtime_aggregate_struct_layout(type_expr, type_value, ctx).fields
      .map((field) => shift_runtime_aggregate_field(field, offset)),
  };
}

function runtime_aggregate_type_layout<ctx extends TypeStaticCtx>(
  type_name: string,
  ctx: ctx,
): RuntimeAggregateLayoutInfo {
  if (type_name === "Unit") {
    return { size: 0, align: 1 };
  }

  const value_type = runtime_aggregate_value_type(type_name);

  if (value_type) {
    return {
      size: val_type_size(value_type),
      align: val_type_align(value_type),
    };
  }

  const type_expr: CoreExpr = { tag: "var", name: type_name };
  const type_value = static_type_value(type_expr, ctx);

  if (type_value && type_value.tag === "union_type") {
    return {
      size: val_type_size("i32"),
      align: val_type_align("i32"),
    };
  }

  if (!type_value || type_value.tag !== "struct_type") {
    throw new Error("Missing runtime aggregate layout for type: " + type_name);
  }

  const layout = runtime_aggregate_struct_layout(type_expr, type_value, ctx);
  return { size: layout.size, align: layout.align };
}

function runtime_aggregate_value_type(type_name: string): ValType | undefined {
  if (type_name === "Text") {
    return "i32";
  }

  return core_val_type_from_type_name(type_name);
}

function shift_runtime_aggregate_field(
  field: RuntimeAggregateField,
  base_offset: number,
): RuntimeAggregateField {
  if (field.tag === "value") {
    return {
      ...field,
      offset: field.offset + base_offset,
    };
  }

  if (field.tag === "struct") {
    return {
      ...field,
      fields: field.fields.map((nested) =>
        shift_runtime_aggregate_field(nested, base_offset)
      ),
    };
  }

  return field;
}

function runtime_aggregate_field_base_offset(
  field: RuntimeAggregateField,
): number {
  if (field.tag === "value") {
    return field.offset;
  }

  if (field.tag === "struct") {
    let offset: number | undefined;

    for (const nested of field.fields) {
      const nested_offset = runtime_aggregate_field_base_offset(nested);

      if (offset === undefined || nested_offset < offset) {
        offset = nested_offset;
      }
    }

    if (offset !== undefined) {
      return offset;
    }
  }

  return 0;
}

function find_runtime_aggregate_field(
  fields: RuntimeAggregateField[],
  name: string,
): RuntimeAggregateField | undefined {
  for (const field of fields) {
    if (field.name === name) {
      return field;
    }
  }

  return undefined;
}

function same_runtime_aggregate_type_value<ctx extends TypeStaticCtx>(
  left: Extract<CoreExpr, { tag: "struct_type" }>,
  right: Extract<CoreExpr, { tag: "struct_type" }>,
  ctx: ctx,
): boolean {
  if (left.fields.length !== right.fields.length) {
    return false;
  }

  for (let index = 0; index < left.fields.length; index += 1) {
    const left_field = left.fields[index];
    const right_field = right.fields[index];
    expect(left_field, "Missing left core struct field " + index);
    expect(right_field, "Missing right core struct field " + index);

    if (left_field.name !== right_field.name) {
      return false;
    }

    const left_type = resolve_core_type_name(left_field.type_name, ctx);
    const right_type = resolve_core_type_name(right_field.type_name, ctx);

    if (left_type !== right_type) {
      return false;
    }
  }

  return true;
}

function emit_runtime_aggregate_field_stores<
  ctx extends RuntimeAggregateEmitCtx & TypeStaticCtx,
>(
  local_name: string,
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  fields: RuntimeAggregateField[],
  ctx: ctx,
  hooks: RuntimeAggregateHooks<ctx>,
  lines: string[],
): void {
  for (const field_info of fields) {
    const field = value.fields.find((item) => item.name === field_info.name);
    expect(
      field,
      "Core runtime aggregate missing struct field " + field_info.name,
    );

    if (field_info.tag === "unit") {
      continue;
    }

    if (field_info.tag === "struct") {
      const nested_value = hooks.static_struct_value(field.value, ctx);

      if (nested_value) {
        emit_runtime_aggregate_field_stores(
          local_name,
          nested_value,
          field_info.fields,
          ctx,
          hooks,
          lines,
        );
        continue;
      }

      emit_runtime_aggregate_nested_field_copy_stores(
        local_name,
        field.value,
        field_info,
        ctx,
        hooks,
        lines,
      );
      continue;
    }

    check_runtime_aggregate_value_field(field_info, field.value, ctx, hooks);
    lines.push("local.get $" + local_name);
    lines.push(hooks.emit_expr(field.value, ctx));
    lines.push(store_instr(field_info.type, field_info.offset));
  }
}

function emit_runtime_aggregate_nested_field_copy_stores<
  ctx extends RuntimeAggregateEmitCtx & TypeStaticCtx,
>(
  local_name: string,
  source: CoreExpr,
  field_info: Extract<RuntimeAggregateField, { tag: "struct" }>,
  ctx: ctx,
  hooks: RuntimeAggregateHooks<ctx>,
  lines: string[],
): void {
  const source_type = hooks.runtime_aggregate_type_expr(source, ctx);
  expect(
    hooks.same_runtime_aggregate_type_expr(
      field_info.type_expr,
      source_type,
      ctx,
    ),
    "Core runtime aggregate field " + field_info.name +
      " expects a matching aggregate value",
  );

  emit_runtime_aggregate_field_copies(
    local_name,
    source,
    field_info.fields,
    ctx,
    hooks,
    lines,
  );
}

function emit_runtime_aggregate_field_copies<
  ctx extends RuntimeAggregateEmitCtx & TypeStaticCtx,
>(
  local_name: string,
  source: CoreExpr,
  fields: RuntimeAggregateField[],
  ctx: ctx,
  hooks: RuntimeAggregateHooks<ctx>,
  lines: string[],
): void {
  for (const field_info of fields) {
    if (field_info.tag === "unit") {
      continue;
    }

    const source_field: CoreExpr = {
      tag: "field",
      object: source,
      name: field_info.name,
    };

    if (field_info.tag === "struct") {
      emit_runtime_aggregate_field_copies(
        local_name,
        source_field,
        field_info.fields,
        ctx,
        hooks,
        lines,
      );
      continue;
    }

    lines.push("local.get $" + local_name);
    lines.push(hooks.emit_expr(source_field, ctx));
    lines.push(store_instr(field_info.type, field_info.offset));
  }
}

function emit_runtime_aggregate_freeze_copy_field_stores<
  ctx extends RuntimeAggregateEmitCtx & TypeStaticCtx,
>(
  local_name: string,
  source: CoreExpr,
  fields: RuntimeAggregateField[],
  ctx: ctx,
  hooks: RuntimeAggregateFreezeCopyHooks<ctx>,
  lines: string[],
): void {
  for (const field_info of fields) {
    if (field_info.tag === "unit") {
      continue;
    }

    const source_field: CoreExpr = {
      tag: "field",
      object: source,
      name: field_info.name,
    };

    if (field_info.tag === "struct") {
      emit_runtime_aggregate_freeze_copy_field_stores(
        local_name,
        source_field,
        field_info.fields,
        ctx,
        hooks,
        lines,
      );
      continue;
    }

    lines.push("local.get $" + local_name);

    if (field_info.union_type_expr) {
      const source_type = hooks.runtime_union_type_expr(source_field, ctx);
      expect(
        source_type &&
          hooks.same_runtime_union_type_expr(
            field_info.union_type_expr,
            source_type,
            ctx,
          ),
        "Core runtime aggregate field " + field_info.name +
          " expects a matching union value",
      );
      lines.push(
        hooks.emit_runtime_union_freeze_copy(
          source_field,
          field_info.union_type_expr,
          ctx,
          hooks,
        ),
      );
    } else if (field_info.text) {
      lines.push(
        emit_runtime_text_freeze_copy(source_field, ctx, {
          emit_expr: hooks.emit_expr,
        }),
      );
    } else {
      lines.push(hooks.emit_expr(source_field, ctx));
    }

    lines.push(store_instr(field_info.type, field_info.offset));
  }
}

function runtime_aggregate_freeze_fields_supported<ctx extends TypeStaticCtx>(
  fields: RuntimeAggregateField[],
  ctx: ctx,
  hooks: RuntimeAggregateFreezeCopySupportHooks<ctx> | undefined,
): boolean {
  for (const field of fields) {
    if (field.tag === "unit") {
      continue;
    }

    if (field.tag === "struct") {
      if (
        !runtime_aggregate_freeze_fields_supported(field.fields, ctx, hooks)
      ) {
        return false;
      }

      continue;
    }

    if (field.union_type_expr) {
      if (!hooks) {
        return false;
      }

      if (
        !hooks.runtime_union_freeze_copy_supported(field.union_type_expr, ctx)
      ) {
        return false;
      }
    }
  }

  return true;
}

function declare_runtime_aggregate_freeze_field_copy_locals<
  ctx extends {
    locals: Map<string, ValType>;
    next_temp: number;
    next_loop: number;
  } & TypeStaticCtx,
>(
  fields: RuntimeAggregateField[],
  ctx: ctx,
  hooks: RuntimeAggregateFreezeCopyLocalHooks<ctx> | undefined,
): void {
  for (const field of fields) {
    if (field.tag === "unit") {
      continue;
    }

    if (field.tag === "struct") {
      declare_runtime_aggregate_freeze_field_copy_locals(
        field.fields,
        ctx,
        hooks,
      );
      continue;
    }

    if (field.union_type_expr) {
      if (
        hooks && hooks.runtime_union_freeze_copy_supported(
          field.union_type_expr,
          ctx,
        )
      ) {
        hooks.declare_runtime_union_freeze_copy_locals(
          field.union_type_expr,
          ctx,
        );
      }

      continue;
    }

    if (field.text) {
      const locals = runtime_text_slice_plan(ctx);
      declare_runtime_text_slice_locals(locals, ctx);
    }
  }
}

function check_runtime_aggregate_value_field<ctx extends TypeStaticCtx>(
  field_info: Extract<RuntimeAggregateField, { tag: "value" }>,
  value: CoreExpr,
  ctx: ctx,
  hooks: RuntimeAggregateHooks<ctx>,
): void {
  if (field_info.union_type_expr) {
    const actual = hooks.runtime_union_type_expr(value, ctx);
    expect(
      actual &&
        hooks.same_runtime_union_type_expr(
          field_info.union_type_expr,
          actual,
          ctx,
        ),
      "Core runtime aggregate field " + field_info.name +
        " expects a matching union value",
    );
    return;
  }

  if (field_info.text) {
    expect(
      hooks.core_expr_is_text(value, ctx),
      "Core runtime aggregate field " + field_info.name + " expects Text",
    );
    return;
  }

  const actual = hooks.expr_type(value, ctx);
  expect(
    actual === field_info.type,
    "Core runtime aggregate field " + field_info.name + " expects " +
      field_info.type + ", got " + actual,
  );
}
