import { expect } from "../../expect.ts";
import type { CoreExpr, CoreField, CoreStmt } from "../ast.ts";
import { indent_lines } from "../emit/format.ts";
import { set_local } from "../emit/local.ts";
import type { DynamicUnionIf } from "../if_let.ts";
import { core_scratch_plan, scratch_heap_global } from "../scratch.ts";
import { record_core_expr_provenance } from "../subject_provenance.ts";
import type {
  StaticStructIfBranches,
  StaticTextIfBranches,
} from "../model/static_value.ts";
import { static_block_result } from "../type_static.ts";
import {
  plan_static_capture_expr,
  static_value_source_is_frozen,
} from "./capture.ts";
import { is_scratch_free_static_value_expr } from "./scratch_free.ts";
import { plan_static_struct_value } from "./struct.ts";
import type {
  StaticValueCtx,
  StaticValueHooks,
  StaticValuePlan,
} from "./types.ts";

export function plan_static_value_expr<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  value: CoreExpr,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): StaticValuePlan {
  const inlined = hooks.static_core_call_value(value, ctx);

  if (inlined) {
    return plan_static_value_expr(inlined, ctx, emit_ctx, hooks);
  }

  const union_case = hooks.static_union_case(value, ctx);

  if (union_case) {
    return plan_static_union_case(union_case, ctx, emit_ctx, hooks);
  }

  const text_value = hooks.static_text_value(value, ctx);

  if (text_value) {
    if (text_value.tag === "if") {
      const text_if = hooks.static_text_if_branches(text_value, ctx);
      expect(text_if, "Missing static text if branches");
      return plan_static_text_if(text_value, text_if, ctx, emit_ctx, hooks);
    }

    return { value: text_value, setup: "" };
  }

  if (value.tag === "freeze") {
    const frozen_struct = hooks.static_struct_value(value.value, ctx);

    if (frozen_struct) {
      const planned = plan_static_struct_value(
        frozen_struct,
        ctx,
        emit_ctx,
        hooks,
        true,
      );
      return {
        value: {
          tag: "freeze",
          value: planned.value,
        },
        setup: planned.setup,
      };
    }
  }

  const struct_value = hooks.static_struct_value(value, ctx);

  if (struct_value) {
    return plan_static_struct_value(
      struct_value,
      ctx,
      emit_ctx,
      hooks,
      static_value_source_is_frozen(value, ctx, hooks),
    );
  }

  if (value.tag === "text") {
    return { value, setup: "" };
  }

  if (value.tag === "struct_value") {
    return plan_static_struct_value(value, ctx, emit_ctx, hooks);
  }

  if (value.tag === "struct_update") {
    const updated = hooks.static_struct_update_value(value, ctx);
    expect(updated, "Cannot update non-static core struct value");
    return plan_static_struct_value(updated, ctx, emit_ctx, hooks);
  }

  if (value.tag === "scratch") {
    return plan_static_scratch_value(value, ctx, emit_ctx, hooks);
  }

  const dynamic_union = hooks.dynamic_union_if(value, ctx);

  if (dynamic_union) {
    return plan_static_union_if(dynamic_union, ctx, emit_ctx, hooks);
  }

  if (value.tag === "if") {
    const struct_if = hooks.static_struct_if_branches(value, ctx);

    if (struct_if) {
      return plan_static_struct_if(value, struct_if, ctx, emit_ctx, hooks);
    }

    const text_if = hooks.static_text_if_branches(value, ctx);

    if (text_if) {
      return plan_static_text_if(value, text_if, ctx, emit_ctx, hooks);
    }

    return plan_static_if(value, ctx, emit_ctx, hooks);
  }

  if (value.tag === "block") {
    return plan_static_block_value(value, ctx, emit_ctx, hooks);
  }

  const block_value = static_block_result(value);

  if (block_value) {
    return plan_static_value_expr(block_value, ctx, emit_ctx, hooks);
  }

  throw new Error("Cannot plan static core value: " + value.tag);
}

function plan_static_if<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  value: Extract<CoreExpr, { tag: "if" }>,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): StaticValuePlan {
  const planned_cond = plan_static_capture_expr(
    "if_cond",
    value.cond,
    ctx,
    emit_ctx,
    hooks,
  );
  const then_value = plan_static_value_expr(
    value.then_branch,
    ctx,
    emit_ctx,
    hooks,
  );
  const else_value = plan_static_value_expr(
    value.else_branch,
    ctx,
    emit_ctx,
    hooks,
  );
  const setup: string[] = [];

  if (planned_cond.setup !== "") {
    setup.push(planned_cond.setup);
  }

  if (emit_ctx && (then_value.setup !== "" || else_value.setup !== "")) {
    setup.push(hooks.emit_expr(planned_cond.value, emit_ctx));
    setup.push("if");
    setup.push(indent_lines(then_value.setup, 2));
    setup.push("else");
    setup.push(indent_lines(else_value.setup, 2));
    setup.push("end");
  }

  return {
    value: record_core_expr_provenance({
      tag: "if",
      cond: planned_cond.value,
      then_branch: then_value.value,
      else_branch: else_value.value,
      implicit_else: value.implicit_else,
    }, value),
    setup: setup.join("\n"),
  };
}

function plan_static_scratch_value<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  value: Extract<CoreExpr, { tag: "scratch" }>,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): StaticValuePlan {
  const validation_scratch_depth = ctx.scratch_depth;
  if (validation_scratch_depth === undefined) {
    ctx.scratch_depth = 1;
  } else {
    ctx.scratch_depth = validation_scratch_depth + 1;
  }
  let scratch_free: boolean;
  try {
    scratch_free = is_scratch_free_static_value_expr(value.body, ctx, hooks);
  } finally {
    ctx.scratch_depth = validation_scratch_depth;
  }
  expect(
    scratch_free,
    "Cannot plan scratch static core value that may reference scratch storage",
  );

  if (value.body.tag !== "block") {
    return plan_static_value_expr(value.body, ctx, emit_ctx, hooks);
  }

  if (value.body.statements.length <= 1) {
    return plan_static_block_value(value.body, ctx, emit_ctx, hooks);
  }

  if (!emit_ctx) {
    const scratch = core_scratch_plan(ctx);
    set_local(ctx.locals, scratch.base, "i32");
    const scratch_depth = ctx.scratch_depth;
    if (scratch_depth === undefined) {
      ctx.scratch_depth = 1;
    } else {
      ctx.scratch_depth = scratch_depth + 1;
    }
    const planned = plan_static_block_value(value.body, ctx, emit_ctx, hooks);
    ctx.scratch_depth = scratch_depth;
    return planned;
  }

  expect(
    is_static_value_scratch_emit_ctx(emit_ctx),
    "Static scratch setup emission requires scratch emit context",
  );

  const scratch = core_scratch_plan(ctx);
  set_local(ctx.locals, scratch.base, "i32");
  emit_ctx.scratch.needed = true;

  const setup: string[] = [
    "global.get $" + scratch_heap_global,
    "local.set $" + scratch.base,
  ];

  emit_ctx.scratch_return_resets.push(scratch.base);
  emit_ctx.scratch_loop_resets.push(scratch.base);
  const scratch_depth = ctx.scratch_depth;
  if (scratch_depth === undefined) {
    ctx.scratch_depth = 1;
  } else {
    ctx.scratch_depth = scratch_depth + 1;
  }
  const planned = plan_static_block_value(value.body, ctx, emit_ctx, hooks);
  ctx.scratch_depth = scratch_depth;
  const loop_reset = emit_ctx.scratch_loop_resets.pop();
  const return_reset = emit_ctx.scratch_return_resets.pop();

  expect(
    loop_reset === scratch.base,
    "Static scratch loop cleanup stack mismatch",
  );
  expect(
    return_reset === scratch.base,
    "Static scratch return cleanup stack mismatch",
  );

  if (planned.setup !== "") {
    setup.push(planned.setup);
  }

  setup.push("local.get $" + scratch.base);
  setup.push("global.set $" + scratch_heap_global);

  return {
    value: planned.value,
    setup: setup.join("\n"),
  };
}

type StaticValueScratchEmitCtx = StaticValueCtx & {
  scratch: { needed: boolean };
  scratch_loop_resets: string[];
  scratch_return_resets: string[];
};

function is_static_value_scratch_emit_ctx(
  ctx: StaticValueCtx,
): ctx is StaticValueScratchEmitCtx {
  if (!("scratch" in ctx)) {
    return false;
  }

  if (!("scratch_loop_resets" in ctx)) {
    return false;
  }

  if (!("scratch_return_resets" in ctx)) {
    return false;
  }

  return true;
}

function plan_static_block_value<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  value: Extract<CoreExpr, { tag: "block" }>,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): StaticValuePlan {
  const setup: string[] = [];

  for (let index = 0; index < value.statements.length; index += 1) {
    const stmt = value.statements[index];
    expect(stmt, "Missing static value block statement " + index.toString());
    const is_final = index + 1 >= value.statements.length;

    if (is_final) {
      const planned = plan_static_block_final_stmt(stmt, ctx, emit_ctx, hooks);

      if (planned.setup !== "") {
        setup.push(planned.setup);
      }

      return {
        value: planned.value,
        setup: setup.join("\n"),
      };
    }

    if (emit_ctx) {
      setup.push(hooks.emit_stmt(stmt, emit_ctx, false));
    } else {
      hooks.collect_stmt_locals(stmt, ctx);
    }
  }

  throw new Error("Cannot plan empty static core block value");
}

function plan_static_block_final_stmt<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  stmt: CoreStmt,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): StaticValuePlan {
  if (stmt.tag === "expr") {
    return plan_static_value_expr(stmt.expr, ctx, emit_ctx, hooks);
  }

  if (stmt.tag === "return") {
    return plan_static_value_expr(stmt.value, ctx, emit_ctx, hooks);
  }

  throw new Error("Cannot plan static core block final statement: " + stmt.tag);
}

function plan_static_union_case<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  value: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): StaticValuePlan {
  if (!value.value) {
    return { value, setup: "" };
  }

  const planned = plan_static_capture_expr(
    "payload_" + value.name,
    value.value,
    ctx,
    emit_ctx,
    hooks,
  );

  return {
    value: record_core_expr_provenance({
      tag: "union_case",
      name: value.name,
      value: planned.value,
      type_expr: value.type_expr,
      resume_payload: value.resume_payload,
    }, value),
    setup: planned.setup,
  };
}

function plan_static_struct_if<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  value: Extract<CoreExpr, { tag: "if" }>,
  branches: StaticStructIfBranches,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): StaticValuePlan {
  const planned_cond = plan_static_capture_expr(
    "if_cond",
    value.cond,
    ctx,
    emit_ctx,
    hooks,
  );
  const fields: CoreField[] = [];

  for (let index = 0; index < branches.then_struct.fields.length; index += 1) {
    const then_field = branches.then_struct.fields[index];
    const else_field = branches.else_struct.fields[index];
    expect(then_field, "Missing then struct field " + index.toString());
    expect(else_field, "Missing else struct field " + index.toString());
    fields.push({
      name: then_field.name,
      value: {
        tag: "if",
        cond: planned_cond.value,
        then_branch: then_field.value,
        else_branch: else_field.value,
      },
    });
  }

  const planned_struct = plan_static_struct_value(
    {
      tag: "struct_value",
      type_expr: branches.then_struct.type_expr,
      fields,
    },
    ctx,
    emit_ctx,
    hooks,
  );
  const setup: string[] = [];

  if (planned_cond.setup !== "") {
    setup.push(planned_cond.setup);
  }

  if (planned_struct.setup !== "") {
    setup.push(planned_struct.setup);
  }

  return {
    value: planned_struct.value,
    setup: setup.join("\n"),
  };
}

function plan_static_union_if<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  target: DynamicUnionIf,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): StaticValuePlan {
  const planned_cond = plan_static_capture_expr(
    "if_cond",
    target.cond,
    ctx,
    emit_ctx,
    hooks,
  );
  const then_case = plan_static_union_if_case(
    target.then_case,
    ctx,
    emit_ctx,
    hooks,
  );
  const else_case = plan_static_union_if_case(
    target.else_case,
    ctx,
    emit_ctx,
    hooks,
  );
  const setup: string[] = [];

  if (planned_cond.setup !== "") {
    setup.push(planned_cond.setup);
  }

  if (emit_ctx && (then_case.setup !== "" || else_case.setup !== "")) {
    setup.push(hooks.emit_expr(planned_cond.value, emit_ctx));
    setup.push("if");
    setup.push(indent_lines(then_case.setup, 2));
    setup.push("else");
    setup.push(indent_lines(else_case.setup, 2));
    setup.push("end");
  }

  return {
    value: {
      tag: "if",
      cond: planned_cond.value,
      then_branch: then_case.value,
      else_branch: else_case.value,
    },
    setup: setup.join("\n"),
  };
}

function plan_static_union_if_case<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): StaticValuePlan {
  if (!union_case.value) {
    return { value: union_case, setup: "" };
  }

  const text_value = hooks.static_text_value(union_case.value, ctx);

  if (text_value) {
    const planned = plan_static_value_expr(text_value, ctx, emit_ctx, hooks);
    return {
      value: record_core_expr_provenance({
        tag: "union_case",
        name: union_case.name,
        value: planned.value,
        type_expr: union_case.type_expr,
        resume_payload: union_case.resume_payload,
      }, union_case),
      setup: planned.setup,
    };
  }

  const struct_value = hooks.static_struct_value(union_case.value, ctx);

  if (struct_value) {
    const planned = plan_static_struct_value(
      struct_value,
      ctx,
      emit_ctx,
      hooks,
    );
    return {
      value: record_core_expr_provenance({
        tag: "union_case",
        name: union_case.name,
        value: planned.value,
        type_expr: union_case.type_expr,
        resume_payload: union_case.resume_payload,
      }, union_case),
      setup: planned.setup,
    };
  }

  if (hooks.is_stable_static_expr(union_case.value)) {
    return { value: union_case, setup: "" };
  }

  const planned = plan_static_capture_expr(
    "payload_" + union_case.name,
    union_case.value,
    ctx,
    emit_ctx,
    hooks,
  );

  return {
    value: record_core_expr_provenance({
      tag: "union_case",
      name: union_case.name,
      value: planned.value,
      type_expr: union_case.type_expr,
      resume_payload: union_case.resume_payload,
    }, union_case),
    setup: planned.setup,
  };
}

function plan_static_text_if<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  value: Extract<CoreExpr, { tag: "if" }>,
  branches: StaticTextIfBranches,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticValueHooks<ctx, emit_ctx>,
): StaticValuePlan {
  const planned_cond = plan_static_capture_expr(
    "if_cond",
    value.cond,
    ctx,
    emit_ctx,
    hooks,
  );
  const setup: string[] = [];

  if (planned_cond.setup !== "") {
    setup.push(planned_cond.setup);
  }

  return {
    value: {
      tag: "if",
      cond: planned_cond.value,
      then_branch: branches.then_text,
      else_branch: branches.else_text,
    },
    setup: setup.join("\n"),
  };
}
