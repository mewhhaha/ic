import { expect } from "../expect.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr } from "./ast.ts";
import { find_core_field } from "./analysis/field.ts";
import { load_instr, store_instr } from "./memory.ts";
import type { RuntimeUnionMatchInfo } from "./runtime_union.ts";
import type {
  RuntimeUnionEmitCtx,
  RuntimeUnionEmitHooks,
} from "./runtime_union_emit/types.ts";
import type { RuntimeUnionBoundPayloadField } from "./runtime_union_match.ts";
import type { RuntimeUnionPayloadField } from "./runtime_union_payload.ts";

export function emit_runtime_union_match_payload_setup(
  local_name: string,
  value_name: string | undefined,
  info: RuntimeUnionMatchInfo,
  fields: RuntimeUnionBoundPayloadField[] | undefined,
): Wat {
  if (!value_name) {
    return "";
  }

  if (info.payload.tag === "none") {
    throw new Error("Union case has no payload: " + info.case_name);
  }

  if (info.payload.tag === "struct") {
    expect(fields, "Missing runtime union struct payload fields");
    const lines: string[] = [];

    emit_runtime_union_match_payload_field_setup(local_name, fields, lines);

    return lines.join("\n");
  }

  if (info.payload.tag === "aggregate") {
    return [
      "local.get $" + local_name,
      load_instr("i32", info.payload_offset),
      "local.set $" + value_name,
    ].join("\n");
  }

  return [
    "local.get $" + local_name,
    load_instr(info.payload.type, info.payload_offset),
    "local.set $" + value_name,
  ].join("\n");
}

export function emit_runtime_union_struct_payload_stores<
  ctx extends RuntimeUnionEmitCtx,
>(
  local_name: string,
  case_name: string,
  value: Extract<CoreExpr, { tag: "struct_value" }>,
  fields: RuntimeUnionPayloadField[],
  ctx: ctx,
  lines: string[],
  hooks: RuntimeUnionEmitHooks<ctx>,
): void {
  for (const field_info of fields) {
    const field = find_core_field(value.fields, field_info.name);
    expect(
      field,
      "Core runtime union case " + case_name + " missing struct field " +
        field_info.name,
    );

    if (field_info.tag === "struct") {
      const nested_value = hooks.static_struct_value(field.value, ctx);
      expect(
        nested_value,
        "Core runtime union case " + case_name + " struct field " +
          field_info.name + " expects a static-shaped struct",
      );
      emit_runtime_union_struct_payload_stores(
        local_name,
        case_name,
        nested_value,
        field_info.fields,
        ctx,
        lines,
        hooks,
      );
      continue;
    }

    lines.push("local.get $" + local_name);
    lines.push(hooks.emit_expr(field.value, ctx));
    lines.push(store_instr(field_info.type, field_info.offset));
  }
}

function emit_runtime_union_match_payload_field_setup(
  local_name: string,
  fields: RuntimeUnionBoundPayloadField[],
  lines: string[],
): void {
  for (const field of fields) {
    if (field.tag === "struct") {
      emit_runtime_union_match_payload_field_setup(
        local_name,
        field.fields,
        lines,
      );
      continue;
    }

    lines.push("local.get $" + local_name);
    lines.push(load_instr(field.type, field.offset));
    lines.push("local.set $" + field.local_name);
  }
}
