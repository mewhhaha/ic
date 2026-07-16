import { expect } from "../../expect.ts";
import type { ValType } from "../../op.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr } from "../ast.ts";
import { fresh_temp_local } from "../emit/name.ts";
import { indent_lines } from "../emit/format.ts";
import { set_local } from "../emit/local.ts";
import { emit_persistent_alloc } from "../runtime_allocator.ts";
import { load_instr, store_instr } from "../memory.ts";
import {
  declare_runtime_aggregate_freeze_copy_locals,
  emit_runtime_aggregate_freeze_copy,
  runtime_aggregate_freeze_copy_supported,
} from "../runtime_aggregate.ts";
import type { CoreScratchHeap } from "../scratch.ts";
import {
  declare_runtime_text_slice_locals,
  emit_runtime_text_freeze_copy_from_wat,
  runtime_text_slice_plan,
} from "../runtime_text.ts";
import {
  runtime_union_payload,
  type RuntimeUnionPayload,
  type RuntimeUnionPayloadField,
} from "../runtime_union_payload.ts";
import { runtime_union_type_layout } from "./size.ts";
import { static_type_value, type TypeStaticCtx } from "../type_static.ts";

export type RuntimeUnionFreezeCopyCtx = TypeStaticCtx & {
  allocation_permits:
    import("../allocation_emission.ts").CoreAllocationPermitState;
  locals: Map<string, ValType>;
  next_temp: number;
  next_loop: number;
  heap: {
    needed: boolean;
  };
  scratch: CoreScratchHeap;
  scratch_return_resets: string[];
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
};

type RuntimeUnionFreezeCopyPlan = {
  source: string;
  result: string;
};

export type RuntimeUnionFreezeCopyHooks<
  ctx extends RuntimeUnionFreezeCopyCtx,
> = {
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

export function emit_runtime_union_freeze_copy<
  ctx extends RuntimeUnionFreezeCopyCtx,
>(
  subject: CoreExpr,
  source: CoreExpr,
  type_expr: CoreExpr,
  ctx: ctx,
  hooks: RuntimeUnionFreezeCopyHooks<ctx>,
): Wat {
  const type_value = runtime_union_freeze_copy_type_value(type_expr, ctx);
  expect(
    runtime_union_freeze_copy_supported(type_expr, ctx),
    "Core runtime union freeze copy contains unsupported payload pointers",
  );
  const source_wat = hooks.emit_expr(source, ctx);
  const layout = runtime_union_type_layout(type_value, ctx);
  const plan = runtime_union_freeze_copy_plan(ctx);
  declare_runtime_union_freeze_copy_plan_locals(plan, ctx);
  ctx.heap.needed = true;
  const lines = [
    source_wat,
    "local.set $" + plan.source,
    emit_persistent_alloc(
      ctx,
      subject,
      "i32.const " + layout.size.toString(),
      layout.align,
      "runtime_union",
      "runtime_union.tag_and_aligned_payload",
      "runtime_union.freeze_copy",
    ),
    "local.set $" + plan.result,
    "local.get $" + plan.result,
    "local.get $" + plan.source,
    load_instr("i32", 0),
    store_instr("i32", 0),
  ];

  emit_runtime_union_freeze_copy_cases(
    subject,
    plan.source,
    plan.result,
    type_value,
    layout.payload_offset,
    ctx,
    lines,
    hooks,
  );

  lines.push("local.get $" + plan.result);
  return lines.join("\n");
}

export function declare_runtime_union_freeze_copy_locals<
  ctx extends TypeStaticCtx & {
    locals: Map<string, ValType>;
    next_temp: number;
    next_loop: number;
  },
>(
  type_expr: CoreExpr,
  ctx: ctx,
): void {
  const type_value = runtime_union_freeze_copy_type_value(type_expr, ctx);
  const plan = runtime_union_freeze_copy_plan(ctx);
  declare_runtime_union_freeze_copy_plan_locals(plan, ctx);
  declare_runtime_union_freeze_copy_text_locals(type_value, ctx);
}

export function runtime_union_freeze_copy_supported<
  ctx extends TypeStaticCtx,
>(
  type_expr: CoreExpr,
  ctx: ctx,
): boolean {
  const type_value = runtime_union_freeze_copy_type_value(type_expr, ctx);

  for (const union_case of type_value.cases) {
    const payload = runtime_union_payload(union_case.type_name, ctx);

    if (!runtime_union_payload_freeze_copy_supported(payload, ctx)) {
      return false;
    }
  }

  return true;
}

function runtime_union_freeze_copy_plan(
  ctx: { next_temp: number },
): RuntimeUnionFreezeCopyPlan {
  return {
    source: fresh_temp_local(ctx, "union_freeze_source"),
    result: fresh_temp_local(ctx, "union_freeze_result"),
  };
}

function declare_runtime_union_freeze_copy_plan_locals(
  plan: RuntimeUnionFreezeCopyPlan,
  ctx: { locals: Map<string, ValType> },
): void {
  set_local(ctx.locals, plan.source, "i32");
  set_local(ctx.locals, plan.result, "i32");
}

function runtime_union_freeze_copy_type_value<ctx extends TypeStaticCtx>(
  type_expr: CoreExpr,
  ctx: ctx,
): Extract<CoreExpr, { tag: "union_type" }> {
  const type_value = static_type_value(type_expr, ctx);
  expect(
    type_value && type_value.tag === "union_type",
    "Core runtime union freeze copy requires a union type",
  );
  return type_value;
}

function runtime_union_payload_freeze_copy_supported<ctx extends TypeStaticCtx>(
  payload: RuntimeUnionPayload,
  ctx: ctx,
): boolean {
  if (payload.tag === "none") {
    return true;
  }

  if (payload.tag === "aggregate") {
    return runtime_aggregate_freeze_copy_supported(payload.type_expr, ctx, {
      runtime_union_freeze_copy_supported,
    });
  }

  if (payload.tag === "value") {
    if (payload.union_type_expr) {
      return runtime_union_freeze_copy_supported(payload.union_type_expr, ctx);
    }

    return true;
  }

  return runtime_union_struct_payload_freeze_copy_supported(
    payload.fields,
    ctx,
  );
}

function runtime_union_struct_payload_freeze_copy_supported<
  ctx extends TypeStaticCtx,
>(
  fields: RuntimeUnionPayloadField[],
  ctx: ctx,
): boolean {
  for (const field of fields) {
    if (field.tag === "struct") {
      if (
        !runtime_union_struct_payload_freeze_copy_supported(field.fields, ctx)
      ) {
        return false;
      }

      continue;
    }

    if (field.union_type_expr) {
      if (!runtime_union_freeze_copy_supported(field.union_type_expr, ctx)) {
        return false;
      }
    }
  }

  return true;
}

function declare_runtime_union_freeze_copy_text_locals<
  ctx extends TypeStaticCtx & {
    locals: Map<string, ValType>;
    next_temp: number;
    next_loop: number;
  },
>(
  type_value: Extract<CoreExpr, { tag: "union_type" }>,
  ctx: ctx,
): void {
  for (const union_case of type_value.cases) {
    const payload = runtime_union_payload(union_case.type_name, ctx);
    declare_runtime_union_payload_text_copy_locals(payload, ctx);
    declare_runtime_union_payload_aggregate_copy_locals(payload, ctx);
  }
}

function declare_runtime_union_payload_text_copy_locals<
  ctx extends TypeStaticCtx & {
    locals: Map<string, ValType>;
    next_temp: number;
    next_loop: number;
  },
>(
  payload: RuntimeUnionPayload,
  ctx: ctx,
): void {
  if (payload.tag === "value") {
    if (payload.union_type_expr) {
      declare_runtime_union_payload_union_copy_locals(
        payload.union_type_expr,
        ctx,
      );
      return;
    }

    if (payload.text) {
      const locals = runtime_text_slice_plan(ctx);
      declare_runtime_text_slice_locals(locals, ctx);
    }

    return;
  }

  if (payload.tag !== "struct") {
    return;
  }

  declare_runtime_union_payload_field_text_copy_locals(payload.fields, ctx);
}

function declare_runtime_union_payload_field_text_copy_locals<
  ctx extends TypeStaticCtx & {
    locals: Map<string, ValType>;
    next_temp: number;
    next_loop: number;
  },
>(
  fields: RuntimeUnionPayloadField[],
  ctx: ctx,
): void {
  for (const field of fields) {
    if (field.tag === "struct") {
      declare_runtime_union_payload_field_text_copy_locals(field.fields, ctx);
      continue;
    }

    if (field.union_type_expr) {
      declare_runtime_union_payload_union_copy_locals(
        field.union_type_expr,
        ctx,
      );
      continue;
    }

    if (field.text) {
      const locals = runtime_text_slice_plan(ctx);
      declare_runtime_text_slice_locals(locals, ctx);
    }
  }
}

function declare_runtime_union_payload_aggregate_copy_locals<
  ctx extends TypeStaticCtx & {
    locals: Map<string, ValType>;
    next_temp: number;
    next_loop: number;
  },
>(
  payload: RuntimeUnionPayload,
  ctx: ctx,
): void {
  if (payload.tag !== "aggregate") {
    return;
  }

  const payload_local = fresh_temp_local(ctx, "union_freeze_payload");
  set_local(ctx.locals, payload_local, "i32");
  declare_runtime_aggregate_freeze_copy_locals(payload.type_expr, ctx, {
    declare_runtime_union_freeze_copy_locals,
    runtime_union_freeze_copy_supported,
  });
}

function declare_runtime_union_payload_union_copy_locals<
  ctx extends TypeStaticCtx & {
    locals: Map<string, ValType>;
    next_temp: number;
    next_loop: number;
  },
>(
  type_expr: CoreExpr,
  ctx: ctx,
): void {
  const payload_local = fresh_temp_local(ctx, "union_freeze_payload");
  set_local(ctx.locals, payload_local, "i32");
  declare_runtime_union_freeze_copy_locals(type_expr, ctx);
}

function emit_runtime_union_freeze_copy_cases<
  ctx extends RuntimeUnionFreezeCopyCtx,
>(
  subject: CoreExpr,
  source: string,
  result: string,
  type_value: Extract<CoreExpr, { tag: "union_type" }>,
  payload_offset: number,
  ctx: ctx,
  lines: string[],
  hooks: RuntimeUnionFreezeCopyHooks<ctx>,
): void {
  for (let index = 0; index < type_value.cases.length; index += 1) {
    const union_case = type_value.cases[index];
    expect(union_case, "Missing runtime union freeze copy case");
    const payload = runtime_union_payload(union_case.type_name, ctx);

    if (payload.tag === "none") {
      continue;
    }

    const body: string[] = [];
    emit_runtime_union_freeze_copy_payload_stores(
      subject,
      source,
      result,
      payload,
      payload_offset,
      ctx,
      body,
      hooks,
    );

    lines.push("local.get $" + source);
    lines.push(load_instr("i32", 0));
    lines.push("i32.const " + index.toString());
    lines.push("i32.eq");
    lines.push("if");
    lines.push(indent_lines(body.join("\n"), 2));
    lines.push("end");
  }
}

function emit_runtime_union_freeze_copy_payload_stores<
  ctx extends RuntimeUnionFreezeCopyCtx,
>(
  subject: CoreExpr,
  source: string,
  result: string,
  payload: RuntimeUnionPayload,
  payload_offset: number,
  ctx: ctx,
  lines: string[],
  hooks: RuntimeUnionFreezeCopyHooks<ctx>,
): void {
  if (payload.tag === "value") {
    if (payload.union_type_expr) {
      emit_runtime_union_freeze_copy_union_pointer_store(
        subject,
        source,
        result,
        payload_offset,
        payload.union_type_expr,
        ctx,
        lines,
        hooks,
      );
      return;
    }

    emit_runtime_union_freeze_copy_value_store(
      subject,
      source,
      result,
      payload_offset,
      payload.type,
      payload.text,
      ctx,
      lines,
    );
    return;
  }

  if (payload.tag === "struct") {
    emit_runtime_union_freeze_copy_struct_payload_stores(
      subject,
      source,
      result,
      payload.fields,
      ctx,
      lines,
      hooks,
    );
    return;
  }

  if (payload.tag === "aggregate") {
    emit_runtime_union_freeze_copy_aggregate_payload_store(
      subject,
      source,
      result,
      payload,
      payload_offset,
      ctx,
      lines,
      hooks,
    );
    return;
  }

  throw new Error("Core runtime union freeze copy missing payload branch");
}

function emit_runtime_union_freeze_copy_aggregate_payload_store<
  ctx extends RuntimeUnionFreezeCopyCtx,
>(
  subject: CoreExpr,
  source: string,
  result: string,
  payload: Extract<RuntimeUnionPayload, { tag: "aggregate" }>,
  payload_offset: number,
  ctx: ctx,
  lines: string[],
  hooks: RuntimeUnionFreezeCopyHooks<ctx>,
): void {
  const payload_local = fresh_temp_local(ctx, "union_freeze_payload");
  set_local(ctx.locals, payload_local, "i32");
  ctx.struct_locals.set(payload_local, payload.type_expr);

  lines.push("local.get $" + source);
  lines.push(load_instr("i32", payload_offset));
  lines.push("local.set $" + payload_local);
  lines.push("local.get $" + result);
  lines.push(
    emit_runtime_aggregate_freeze_copy(
      subject,
      { tag: "var", name: payload_local },
      payload.type_expr,
      ctx,
      {
        core_expr_is_text: hooks.core_expr_is_text,
        emit_expr: hooks.emit_expr,
        expr_type: hooks.expr_type,
        runtime_aggregate_type_expr: hooks.runtime_aggregate_type_expr,
        runtime_union_type_expr: hooks.runtime_union_type_expr,
        same_runtime_aggregate_type_expr:
          hooks.same_runtime_aggregate_type_expr,
        same_runtime_union_type_expr: hooks.same_runtime_union_type_expr,
        emit_runtime_union_freeze_copy:
          emit_runtime_aggregate_nested_union_freeze_copy,
        static_struct_value: hooks.static_struct_value,
      },
    ),
  );
  lines.push(store_instr("i32", payload_offset));
}

function emit_runtime_union_freeze_copy_struct_payload_stores<
  ctx extends RuntimeUnionFreezeCopyCtx,
>(
  subject: CoreExpr,
  source: string,
  result: string,
  fields: RuntimeUnionPayloadField[],
  ctx: ctx,
  lines: string[],
  hooks: RuntimeUnionFreezeCopyHooks<ctx>,
): void {
  for (const field of fields) {
    if (field.tag === "struct") {
      emit_runtime_union_freeze_copy_struct_payload_stores(
        subject,
        source,
        result,
        field.fields,
        ctx,
        lines,
        hooks,
      );
      continue;
    }

    if (field.union_type_expr) {
      emit_runtime_union_freeze_copy_union_pointer_store(
        subject,
        source,
        result,
        field.offset,
        field.union_type_expr,
        ctx,
        lines,
        hooks,
      );
      continue;
    }

    emit_runtime_union_freeze_copy_value_store(
      subject,
      source,
      result,
      field.offset,
      field.type,
      field.text,
      ctx,
      lines,
    );
  }
}

function emit_runtime_union_freeze_copy_union_pointer_store<
  ctx extends RuntimeUnionFreezeCopyCtx,
>(
  subject: CoreExpr,
  source: string,
  result: string,
  offset: number,
  type_expr: CoreExpr,
  ctx: ctx,
  lines: string[],
  hooks: RuntimeUnionFreezeCopyHooks<ctx>,
): void {
  const payload_local = fresh_temp_local(ctx, "union_freeze_payload");
  set_local(ctx.locals, payload_local, "i32");
  ctx.union_locals.set(payload_local, type_expr);

  lines.push("local.get $" + source);
  lines.push(load_instr("i32", offset));
  lines.push("local.set $" + payload_local);
  lines.push("local.get $" + result);
  lines.push(
    emit_runtime_union_freeze_copy(
      subject,
      { tag: "var", name: payload_local },
      type_expr,
      ctx,
      hooks,
    ),
  );
  lines.push(store_instr("i32", offset));
}

function emit_runtime_aggregate_nested_union_freeze_copy<
  ctx extends RuntimeUnionFreezeCopyCtx,
>(
  subject: CoreExpr,
  source: CoreExpr,
  type_expr: CoreExpr,
  ctx: ctx,
  hooks: RuntimeUnionFreezeCopyHooks<ctx>,
): Wat {
  return emit_runtime_union_freeze_copy(subject, source, type_expr, ctx, hooks);
}

function emit_runtime_union_freeze_copy_value_store<
  ctx extends RuntimeUnionFreezeCopyCtx,
>(
  subject: CoreExpr,
  source: string,
  result: string,
  offset: number,
  type: ValType,
  text: boolean,
  ctx: ctx,
  lines: string[],
): void {
  lines.push("local.get $" + result);

  if (text) {
    const source_text = [
      "local.get $" + source,
      load_instr("i32", offset),
    ].join("\n");
    lines.push(
      emit_runtime_text_freeze_copy_from_wat(subject, source_text, ctx),
    );
  } else {
    lines.push("local.get $" + source);
    lines.push(load_instr(type, offset));
  }

  lines.push(store_instr(type, offset));
}
