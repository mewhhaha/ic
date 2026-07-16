import { expect } from "../../expect.ts";
import type { CoreExpr, CoreField } from "../ast.ts";
import { fresh_temp_local } from "../emit/name.ts";
import { maybe_static_i32 } from "../analysis/static_i32.ts";
import { set_local } from "../emit/local.ts";
import { static_indexed_field } from "../analysis/field.ts";
import type {
  CoreIndexAssignCtx,
  CoreIndexAssignHooks,
  CoreIndexAssignStmt,
  StaticIndexAssignPlan,
} from "./types.ts";

export function plan_core_static_index_assign<
  ctx extends CoreIndexAssignCtx,
  emit_ctx extends ctx,
>(
  target: Extract<CoreExpr, { tag: "struct_value" }>,
  index_expr: CoreExpr,
  value: CoreExpr,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: CoreIndexAssignHooks<ctx, emit_ctx>,
): StaticIndexAssignPlan {
  const index_type = hooks.expr_type(index_expr, ctx);
  expect(index_type === "i32", "Core index assignment index must be i32");
  const value_type = hooks.expr_type(value, ctx);
  const static_index = maybe_static_i32(index_expr);
  const setup: string[] = [];
  let resolved_index = index_expr;
  let value_expr = value;

  if (static_index === undefined) {
    const index_name = fresh_temp_local(ctx, "index");
    set_local(ctx.locals, index_name, "i32");

    if (emit_ctx) {
      setup.push(hooks.emit_expr(index_expr, emit_ctx));
      setup.push("local.set $" + index_name);
    }

    resolved_index = { tag: "var", name: index_name };
  }

  const text_value = hooks.static_text_value(value, ctx);

  if (text_value) {
    const planned = hooks.plan_static_value_expr(text_value, ctx, emit_ctx);
    value_expr = planned.value;

    if (planned.setup !== "") {
      setup.push(planned.setup);
    }
  } else {
    if (!hooks.is_stable_static_expr(value)) {
      const planned = hooks.plan_static_capture_expr(
        "index_value",
        value,
        ctx,
        emit_ctx,
      );
      value_expr = planned.value;

      if (planned.setup !== "") {
        setup.push(planned.setup);
      }
    }
  }

  const fields: CoreField[] = [];

  for (let item_index = 0; item_index < target.fields.length; item_index += 1) {
    const item = target.fields[item_index];
    expect(item, "Missing static collection field " + item_index.toString());
    const field_type = hooks.expr_type(item.value, ctx);

    if (static_index !== undefined) {
      if (item_index !== static_index) {
        fields.push(item);
        continue;
      }

      expect(
        value_type === field_type,
        "Core index assignment field " + item.name + " expects " +
          field_type + ", got " + value_type,
      );
      fields.push({ name: item.name, value: value_expr });
      continue;
    }

    expect(
      value_type === field_type,
      "Core dynamic index assignment field " + item.name + " expects " +
        field_type + ", got " + value_type,
    );
    fields.push({
      name: item.name,
      value: {
        tag: "if",
        cond: {
          tag: "prim",
          prim: "i32.eq",
          args: [
            resolved_index,
            { tag: "num", type: "i32", value: item_index },
          ],
        },
        then_branch: value_expr,
        else_branch: item.value,
      },
    });
  }

  if (static_index !== undefined) {
    static_indexed_field(target.fields, static_index);
  }

  return {
    value: {
      tag: "struct_value",
      type_expr: target.type_expr,
      fields,
    },
    setup: setup.join("\n"),
  };
}

export function emit_core_static_index_assign<
  ctx extends CoreIndexAssignCtx & { statics: Map<string, CoreExpr> },
>(
  target: Extract<CoreExpr, { tag: "struct_value" }>,
  stmt: CoreIndexAssignStmt,
  ctx: ctx,
  hooks: CoreIndexAssignHooks<ctx, ctx>,
): string {
  const plan = plan_core_static_index_assign(
    target,
    stmt.index,
    stmt.value,
    ctx,
    ctx,
    hooks,
  );
  ctx.statics.set(stmt.name, plan.value);
  return plan.setup;
}
