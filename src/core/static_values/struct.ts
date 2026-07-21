import { expect } from "../../expect.ts";
import type { CoreExpr, CoreField } from "../ast.ts";
import { record_core_expr_provenance } from "../subject_provenance.ts";
import { plan_static_capture_expr } from "./capture.ts";
import type {
  StaticValueCtx,
  StaticValueHooks,
  StaticValuePlan,
} from "./types.ts";

export function plan_static_struct_value<
  ctx extends StaticValueCtx,
  emit_ctx extends ctx,
>(
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  ctx: ctx,
  emit_ctx: emit_ctx | undefined,
  hooks: StaticValueHooks<ctx, emit_ctx>,
  frozen = false,
  visiting = new Set<CoreExpr>(),
): StaticValuePlan {
  expect(
    !visiting.has(value),
    "Cannot plan cyclic static struct value",
  );
  const nested_visiting = new Set(visiting);
  nested_visiting.add(value);
  const setup: string[] = [];
  const fields: CoreField[] = [];

  for (let index = 0; index < value.fields.length; index += 1) {
    const field = value.fields[index];
    expect(field, "Missing static struct field " + index.toString());
    const nested_value = hooks.static_struct_value(field.value, ctx);
    if (nested_value) {
      const planned = plan_static_struct_value(
        nested_value,
        ctx,
        emit_ctx,
        hooks,
        frozen,
        nested_visiting,
      );
      fields.push({ name: field.name, value: planned.value });

      if (planned.setup !== "") {
        setup.push(planned.setup);
      }
      continue;
    }
    const union_case = hooks.static_union_case(field.value, ctx);
    if (
      union_case &&
      (!union_case.value || hooks.is_stable_static_expr(union_case.value))
    ) {
      fields.push({ name: field.name, value: union_case });
      continue;
    }
    const planned = plan_static_capture_expr(
      "field_" + field.name,
      field.value,
      ctx,
      emit_ctx,
      hooks,
      frozen,
    );
    fields.push({ name: field.name, value: planned.value });

    if (planned.setup !== "") {
      setup.push(planned.setup);
    }
  }

  return {
    value: record_core_expr_provenance({
      tag: "struct_value",
      type_expr: value.type_expr,
      fields,
    }, value),
    setup: setup.join("\n"),
  };
}
