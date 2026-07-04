import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "./ast.ts";
import { fresh_temp_local, indent_lines, set_local } from "./backend/util.ts";
import { closure_heap_global } from "./closure_emit.ts";
import { load_instr, store_instr } from "./memory.ts";
import {
  declare_runtime_aggregate_freeze_copy_locals,
  emit_runtime_aggregate_freeze_copy,
  runtime_aggregate_freeze_copy_supported,
} from "./runtime_aggregate.ts";
import { type CoreScratchHeap, scratch_heap_global } from "./scratch.ts";
import {
  declare_runtime_text_slice_locals,
  emit_runtime_text_freeze_copy_from_wat,
  runtime_text_slice_plan,
} from "./runtime_text.ts";
import type {
  RuntimeUnionInfo,
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "./runtime_union.ts";
import { runtime_union_type_size } from "./runtime_union/size.ts";
import type { RuntimeUnionBoundPayloadField } from "./runtime_union_match.ts";
import {
  runtime_union_payload,
  type RuntimeUnionPayload,
  type RuntimeUnionPayloadField,
} from "./runtime_union_payload.ts";
import {
  emit_runtime_union_match_payload_setup,
  emit_runtime_union_struct_payload_stores,
} from "./runtime_union_payload_emit.ts";
import { static_type_value, type TypeStaticCtx } from "./type_static.ts";

export type RuntimeUnionEmitHeap = {
  needed: boolean;
};

export type RuntimeUnionLocalCtx = {
  locals: Map<string, ValType>;
  next_temp: number;
};

export type RuntimeUnionEmitCtx = RuntimeUnionLocalCtx & {
  heap: RuntimeUnionEmitHeap;
  scratch: CoreScratchHeap;
  scratch_return_resets: string[];
};

export type RuntimeUnionIfLetCtx = RuntimeUnionEmitCtx & {
  fn_types: Map<string, CoreFnType>;
  next_loop: number;
  statics: Map<string, CoreExpr>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  frozen_locals?: Set<string>;
};

type RuntimeUnionFreezeCopyCtx = RuntimeUnionEmitCtx & TypeStaticCtx & {
  next_loop: number;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
};

type RuntimeUnionFreezeCopyPlan = {
  source: string;
  result: string;
};

export type RuntimeUnionPayloadEmitBinding<ctx> = {
  ctx: ctx;
  fields: RuntimeUnionBoundPayloadField[] | undefined;
};

export type RuntimeUnionLocalHooks<ctx extends RuntimeUnionLocalCtx> = {
  collect_expr_locals: (expr: CoreExpr, ctx: ctx) => void;
  core_runtime_union_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  runtime_union_case_info: (
    value: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: ctx,
  ) => RuntimeUnionInfo;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
};

export type RuntimeUnionEmitHooks<ctx extends RuntimeUnionEmitCtx> = {
  core_runtime_union_value: (expr: CoreExpr, ctx: ctx) => CoreExpr | undefined;
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  runtime_union_case_info: (
    value: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: ctx,
  ) => RuntimeUnionInfo;
  static_struct_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
};

export type RuntimeUnionIfLetHooks<ctx extends RuntimeUnionIfLetCtx> = {
  core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
  match_branch_ctx: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: ctx,
  ) => RuntimeUnionPayloadEmitBinding<ctx>;
  merge_if_else_static_assignments: (
    stmt: CoreStmt,
    cond: CoreExpr,
    then_statics: Map<string, CoreExpr>,
    else_statics: Map<string, CoreExpr>,
    ctx: ctx,
    emit_ctx: ctx,
  ) => Wat;
  runtime_union_match_info: (
    case_name: string,
    target: RuntimeUnionTarget,
    ctx: ctx,
  ) => RuntimeUnionMatchInfo;
};

export type RuntimeUnionFreezeCopyHooks<
  ctx extends RuntimeUnionFreezeCopyCtx,
> =
  & Pick<
    RuntimeUnionEmitHooks<ctx>,
    "emit_expr" | "expr_type" | "static_struct_value"
  >
  & {
    core_expr_is_text: (expr: CoreExpr, ctx: ctx) => boolean;
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
  };

export function collect_runtime_union_value_locals<
  ctx extends RuntimeUnionLocalCtx,
>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: RuntimeUnionLocalHooks<ctx>,
): boolean {
  const value = hooks.core_runtime_union_value(expr, ctx);

  if (!value) {
    return false;
  }

  collect_runtime_union_materialized_value_locals(value, ctx, hooks);
  return true;
}

export function emit_runtime_union_value<ctx extends RuntimeUnionEmitCtx>(
  expr: CoreExpr,
  ctx: ctx,
  hooks: RuntimeUnionEmitHooks<ctx>,
): Wat {
  const value = hooks.core_runtime_union_value(expr, ctx);
  expect(value, "Core runtime union value requires a union case");

  if (value.tag === "if") {
    const cond_type = hooks.expr_type(value.cond, ctx);
    expect(cond_type === "i32", "Core runtime union if condition must be i32");
    return [
      hooks.emit_expr(value.cond, ctx),
      "if (result i32)",
      indent_lines(emit_runtime_union_value(value.then_branch, ctx, hooks), 2),
      "else",
      indent_lines(emit_runtime_union_value(value.else_branch, ctx, hooks), 2),
      "end",
    ].join("\n");
  }

  expect(
    value.tag === "union_case",
    "Core runtime union value requires a union case",
  );
  return emit_runtime_union_case(value, ctx, hooks);
}

export function emit_runtime_union_freeze_copy<
  ctx extends RuntimeUnionFreezeCopyCtx,
>(
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
  const plan = runtime_union_freeze_copy_plan(ctx);
  declare_runtime_union_freeze_copy_plan_locals(plan, ctx);
  ctx.heap.needed = true;
  const lines = [
    source_wat,
    "local.set $" + plan.source,
    "global.get $" + closure_heap_global,
    "local.set $" + plan.result,
    "global.get $" + closure_heap_global,
    "i32.const " + runtime_union_type_size(type_value, ctx).toString(),
    "i32.add",
    "global.set $" + closure_heap_global,
    "local.get $" + plan.result,
    "local.get $" + plan.source,
    load_instr("i32", 0),
    store_instr("i32", 0),
  ];

  emit_runtime_union_freeze_copy_cases(
    plan.source,
    plan.result,
    type_value,
    ctx,
    lines,
    hooks,
  );

  lines.push("local.get $" + plan.result);
  return lines.join("\n");
}

export function declare_runtime_union_freeze_copy_locals<
  ctx extends RuntimeUnionLocalCtx & TypeStaticCtx & { next_loop: number },
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

export function emit_runtime_union_if_let_stmt<
  ctx extends RuntimeUnionIfLetCtx,
>(
  stmt: Extract<CoreStmt, { tag: "if_let_stmt" }>,
  target: RuntimeUnionTarget,
  ctx: ctx,
  hooks: RuntimeUnionIfLetHooks<ctx>,
): Wat {
  const target_code = hooks.emit_expr(target.target, ctx);
  const local_name = fresh_temp_local(ctx, "union_match");
  set_local(ctx.locals, local_name, "i32");
  const cond_name = fresh_temp_local(ctx, "if_cond");
  set_local(ctx.locals, cond_name, "i32");
  const else_statics = new Map(ctx.statics);
  const info = hooks.runtime_union_match_info(stmt.case_name, target, ctx);
  const binding = hooks.match_branch_ctx(stmt.value_name, info, ctx);
  const branch_ctx = binding.ctx;
  const body: string[] = [];
  const payload_setup = emit_runtime_union_match_payload_setup(
    local_name,
    stmt.value_name,
    info,
    binding.fields,
  );

  if (payload_setup !== "") {
    body.push(payload_setup);
  }

  for (const item of stmt.body) {
    body.push(hooks.emit_stmt(item, branch_ctx, false));
  }

  ctx.next_loop = branch_ctx.next_loop;
  ctx.next_temp = branch_ctx.next_temp;
  const merge_setup = hooks.merge_if_else_static_assignments(
    stmt,
    { tag: "var", name: cond_name },
    branch_ctx.statics,
    else_statics,
    ctx,
    ctx,
  );
  const lines = [
    target_code,
    "local.set $" + local_name,
    "local.get $" + local_name,
    "i32.load",
    "i32.const " + info.tag_value.toString(),
    "i32.eq",
    "local.set $" + cond_name,
    "local.get $" + cond_name,
    "if",
    indent_lines(body.join("\n"), 2),
    "end",
  ];

  if (merge_setup !== "") {
    lines.push(merge_setup);
  }

  return lines.join("\n");
}

export function emit_runtime_union_if_let_expr<
  ctx extends RuntimeUnionIfLetCtx,
>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  target: RuntimeUnionTarget,
  ctx: ctx,
  hooks: RuntimeUnionIfLetHooks<ctx>,
): Wat {
  const result_type = hooks.expr_type(expr, ctx);
  const target_code = hooks.emit_expr(target.target, ctx);
  const local_name = fresh_temp_local(ctx, "union_match");
  set_local(ctx.locals, local_name, "i32");
  const info = hooks.runtime_union_match_info(expr.case_name, target, ctx);
  const binding = hooks.match_branch_ctx(expr.value_name, info, ctx);
  const branch_ctx = binding.ctx;
  const then_lines: string[] = [];
  const payload_setup = emit_runtime_union_match_payload_setup(
    local_name,
    expr.value_name,
    info,
    binding.fields,
  );

  if (payload_setup !== "") {
    then_lines.push(payload_setup);
  }

  then_lines.push(hooks.emit_expr(expr.then_branch, branch_ctx));
  ctx.next_loop = branch_ctx.next_loop;
  ctx.next_temp = branch_ctx.next_temp;

  let else_branch: Wat;

  if (expr.implicit_else) {
    if (hooks.core_expr_is_text(expr, ctx)) {
      else_branch = hooks.emit_expr({ tag: "text", value: "" }, ctx);
    } else {
      else_branch = result_type + ".const 0";
    }
  } else {
    else_branch = hooks.emit_expr(expr.else_branch, ctx);
  }

  return [
    target_code,
    "local.set $" + local_name,
    "local.get $" + local_name,
    "i32.load",
    "i32.const " + info.tag_value.toString(),
    "i32.eq",
    "if (result " + result_type + ")",
    indent_lines(then_lines.join("\n"), 2),
    "else",
    indent_lines(else_branch, 2),
    "end",
  ].join("\n");
}

function collect_runtime_union_materialized_value_locals<
  ctx extends RuntimeUnionLocalCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: RuntimeUnionLocalHooks<ctx>,
): void {
  if (value.tag === "if") {
    hooks.collect_expr_locals(value.cond, ctx);
    collect_runtime_union_materialized_value_locals(
      value.then_branch,
      ctx,
      hooks,
    );
    collect_runtime_union_materialized_value_locals(
      value.else_branch,
      ctx,
      hooks,
    );
    return;
  }

  expect(
    value.tag === "union_case",
    "Core runtime union value requires a union case",
  );

  const name = fresh_temp_local(ctx, "union");
  set_local(ctx.locals, name, "i32");

  if (value.type_expr) {
    hooks.collect_expr_locals(value.type_expr, ctx);
  }

  const info = hooks.runtime_union_case_info(value, ctx);

  if (value.value) {
    if (info.payload.tag === "struct") {
      const struct_value = hooks.static_struct_value(value.value, ctx);
      expect(
        struct_value,
        "Core runtime union case " + value.name +
          " payload expects a static-shaped struct",
      );
      collect_runtime_union_struct_payload_locals(struct_value, ctx, hooks);
    } else if (info.payload.tag === "aggregate") {
      hooks.collect_expr_locals(value.value, ctx);
    } else {
      hooks.collect_expr_locals(value.value, ctx);
    }
  }
}

function runtime_union_freeze_copy_plan(
  ctx: RuntimeUnionLocalCtx,
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
  ctx extends RuntimeUnionLocalCtx & TypeStaticCtx & { next_loop: number },
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
  ctx extends RuntimeUnionLocalCtx & TypeStaticCtx & { next_loop: number },
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
  ctx extends RuntimeUnionLocalCtx & TypeStaticCtx & { next_loop: number },
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
  ctx extends RuntimeUnionLocalCtx & TypeStaticCtx & { next_loop: number },
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
  ctx extends RuntimeUnionLocalCtx & TypeStaticCtx & { next_loop: number },
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
  source: string,
  result: string,
  type_value: Extract<CoreExpr, { tag: "union_type" }>,
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
      source,
      result,
      payload,
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
  source: string,
  result: string,
  payload: RuntimeUnionPayload,
  ctx: ctx,
  lines: string[],
  hooks: RuntimeUnionFreezeCopyHooks<ctx>,
): void {
  if (payload.tag === "value") {
    if (payload.union_type_expr) {
      emit_runtime_union_freeze_copy_union_pointer_store(
        source,
        result,
        4,
        payload.union_type_expr,
        ctx,
        lines,
        hooks,
      );
      return;
    }

    emit_runtime_union_freeze_copy_value_store(
      source,
      result,
      4,
      payload.type,
      payload.text,
      ctx,
      lines,
    );
    return;
  }

  if (payload.tag === "struct") {
    emit_runtime_union_freeze_copy_struct_payload_stores(
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
      source,
      result,
      payload,
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
  source: string,
  result: string,
  payload: Extract<RuntimeUnionPayload, { tag: "aggregate" }>,
  ctx: ctx,
  lines: string[],
  hooks: RuntimeUnionFreezeCopyHooks<ctx>,
): void {
  const payload_local = fresh_temp_local(ctx, "union_freeze_payload");
  set_local(ctx.locals, payload_local, "i32");
  ctx.struct_locals.set(payload_local, payload.type_expr);

  lines.push("local.get $" + source);
  lines.push(load_instr("i32", 4));
  lines.push("local.set $" + payload_local);
  lines.push("local.get $" + result);
  lines.push(
    emit_runtime_aggregate_freeze_copy(
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
  lines.push(store_instr("i32", 4));
}

function emit_runtime_union_freeze_copy_struct_payload_stores<
  ctx extends RuntimeUnionFreezeCopyCtx,
>(
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
  source: CoreExpr,
  type_expr: CoreExpr,
  ctx: ctx,
  hooks: RuntimeUnionFreezeCopyHooks<ctx>,
): Wat {
  return emit_runtime_union_freeze_copy(source, type_expr, ctx, hooks);
}

function emit_runtime_union_freeze_copy_value_store<
  ctx extends RuntimeUnionFreezeCopyCtx,
>(
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
    lines.push(emit_runtime_text_freeze_copy_from_wat(source_text, ctx));
  } else {
    lines.push("local.get $" + source);
    lines.push(load_instr(type, offset));
  }

  lines.push(store_instr(type, offset));
}

function collect_runtime_union_struct_payload_locals<
  ctx extends RuntimeUnionLocalCtx,
>(
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  ctx: ctx,
  hooks: RuntimeUnionLocalHooks<ctx>,
): void {
  for (const field of value.fields) {
    const nested = hooks.static_struct_value(field.value, ctx);

    if (nested) {
      collect_runtime_union_struct_payload_locals(nested, ctx, hooks);
      continue;
    }

    hooks.collect_expr_locals(field.value, ctx);
  }
}

function emit_runtime_union_case<ctx extends RuntimeUnionEmitCtx>(
  value: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: ctx,
  hooks: RuntimeUnionEmitHooks<ctx>,
): Wat {
  const info = hooks.runtime_union_case_info(value, ctx);
  const name = fresh_temp_local(ctx, "union");
  set_local(ctx.locals, name, "i32");
  const heap_name = runtime_union_alloc_heap(ctx);
  const lines = [
    "global.get $" + heap_name,
    "local.set $" + name,
    "global.get $" + heap_name,
    "i32.const " + info.size.toString(),
    "i32.add",
    "global.set $" + heap_name,
    "local.get $" + name,
    "i32.const " + info.tag_value.toString(),
    "i32.store",
  ];

  if (info.payload.tag === "value") {
    expect(
      value.value,
      "Core runtime union case " + value.name + " requires a payload",
    );
    lines.push("local.get $" + name);
    lines.push(hooks.emit_expr(value.value, ctx));
    lines.push(store_instr(info.payload.type, 4));
  } else if (info.payload.tag === "aggregate") {
    expect(
      value.value,
      "Core runtime union case " + value.name + " requires a payload",
    );
    lines.push("local.get $" + name);
    lines.push(hooks.emit_expr(value.value, ctx));
    lines.push(store_instr("i32", 4));
  } else if (info.payload.tag === "struct") {
    expect(
      value.value,
      "Core runtime union case " + value.name + " requires a payload",
    );
    const struct_value = hooks.static_struct_value(value.value, ctx);
    expect(
      struct_value,
      "Core runtime union case " + value.name +
        " payload expects a static-shaped struct",
    );

    emit_runtime_union_struct_payload_stores(
      name,
      value.name,
      struct_value,
      info.payload.fields,
      ctx,
      lines,
      hooks,
    );
  }

  lines.push("local.get $" + name);
  return lines.join("\n");
}

function runtime_union_alloc_heap(ctx: RuntimeUnionEmitCtx): string {
  if (ctx.scratch_return_resets.length > 0) {
    ctx.scratch.needed = true;
    return scratch_heap_global;
  }

  ctx.heap.needed = true;
  return closure_heap_global;
}
