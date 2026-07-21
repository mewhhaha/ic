import { expect } from "../../expect.ts";
import type { ValType } from "../../op.ts";
import type { CoreExpr, CoreTypeField } from "../ast.ts";
import {
  check_runtime_union_aggregate_payload,
  check_runtime_union_struct_payload,
  check_runtime_union_value_payload,
  runtime_union_payload,
} from "../runtime_union_payload.ts";
import { static_type_value } from "../type_static.ts";
import { runtime_union_type_layout } from "./size.ts";
import type {
  RuntimeUnionCtx,
  RuntimeUnionHooks,
  RuntimeUnionInfo,
} from "./types.ts";

export function runtime_union_value_type<ctx extends RuntimeUnionCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: RuntimeUnionHooks<ctx>,
): ValType {
  if (value.tag === "if") {
    const cond_type = hooks.expr_type(value.cond, ctx);
    expect(cond_type === "i32", "Core runtime union if condition must be i32");
    runtime_union_value_type(value.then_branch, ctx, hooks);
    runtime_union_value_type(value.else_branch, ctx, hooks);
    return "i32";
  }

  expect(
    value.tag === "union_case",
    "Core runtime union value requires a union case",
  );
  runtime_union_case_info(value, ctx, hooks);
  return "i32";
}

export function runtime_union_case_info<ctx extends RuntimeUnionCtx>(
  value: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: ctx,
  hooks: RuntimeUnionHooks<ctx>,
): RuntimeUnionInfo {
  const type_expr = value.type_expr;
  let case_subject = value.name;
  const payload_value = value.value;
  if (
    payload_value &&
    (payload_value.tag === "var" || payload_value.tag === "linear")
  ) {
    case_subject += "(" + payload_value.name + ")";
  }
  expect(
    type_expr,
    "Core runtime union case requires a union type: " + case_subject,
  );
  const type_value = static_type_value(type_expr, ctx);
  expect(
    type_value && type_value.tag === "union_type",
    "Core runtime union case requires a union type: " + case_subject,
  );

  let declared: CoreTypeField | undefined;
  let tag_value = 0;

  for (let index = 0; index < type_value.cases.length; index += 1) {
    const union_case = type_value.cases[index];
    expect(union_case, "Missing core union case " + index.toString());

    if (union_case.name === value.name) {
      declared = union_case;
      tag_value = index;
    }
  }

  expect(declared, "Missing union case: " + value.name);
  const payload = runtime_union_payload(declared.type_name, ctx);

  if (payload.tag === "none") {
    expect(
      !value.value,
      "Core runtime union case " + value.name + " expects no payload",
    );
  } else {
    expect(
      value.value,
      "Core runtime union case " + value.name + " requires a payload",
    );

    if (payload.tag === "aggregate") {
      check_runtime_union_aggregate_payload(
        "Core runtime union case " + value.name + " payload",
        value.value,
        payload,
        ctx,
        hooks,
      );
    } else if (payload.tag === "struct") {
      const struct_value = hooks.static_struct_value(value.value, ctx);
      expect(
        struct_value,
        "Core runtime union case " + value.name +
          " payload expects a static-shaped struct",
      );
      check_runtime_union_struct_payload(
        value.name,
        struct_value,
        payload,
        ctx,
        hooks,
      );
    } else {
      check_runtime_union_value_payload(
        "Core runtime union case " + value.name + " payload",
        value.value,
        payload,
        ctx,
        hooks,
      );
    }
  }

  const layout = runtime_union_type_layout(type_value, ctx);

  return {
    tag_value,
    size: layout.size,
    align: layout.align,
    payload_offset: layout.payload_offset,
    payload,
  };
}
