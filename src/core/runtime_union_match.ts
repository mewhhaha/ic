import type { ValType } from "../op.ts";
import type { CoreExpr, CoreField, CoreFnType, CoreHostImport } from "./ast.ts";
import { fresh_temp_local } from "./emit/name.ts";
import { set_local } from "./emit/local.ts";
import { clone_core_host_imports } from "./host_import.ts";
import type { RuntimeUnionMatchInfo } from "./runtime_union/types.ts";
import type {
  RuntimeUnionPayload,
  RuntimeUnionPayloadField,
} from "./runtime_union_payload.ts";

export type RuntimeUnionMatchCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  borrowed_locals?: Set<string>;
  frozen_locals?: Set<string>;
  host_imports?: Map<string, CoreHostImport>;
  scratch_depth?: number;
  materialized_bindings?: Set<string>;
  mutable_bindings?: Set<string>;
};

export type RuntimeUnionMatchTempCtx = RuntimeUnionMatchCtx & {
  next_temp: number;
};

export type RuntimeUnionMatchCoreCtx = RuntimeUnionMatchTempCtx & {
  next_loop: number;
};

export type RuntimeUnionBoundPayloadField =
  | (Extract<RuntimeUnionPayloadField, { tag: "value" }> & {
    local_name: string;
  })
  | {
    tag: "struct";
    name: string;
    type_expr: CoreExpr;
    fields: RuntimeUnionBoundPayloadField[];
  };

export function bind_runtime_union_match_payload_fact(
  value_name: string | undefined,
  info: RuntimeUnionMatchInfo,
  ctx: RuntimeUnionMatchCtx,
): void {
  if (!value_name) {
    return;
  }

  const payload = info.payload;

  if (payload.tag === "none") {
    throw new Error("Union case has no payload: " + info.case_name);
  }

  if (payload.tag === "struct") {
    bind_runtime_union_match_static_struct_fact(value_name, payload, ctx);
    return;
  }

  if (payload.tag === "aggregate") {
    ctx.statics.delete(value_name);
    ctx.fn_types.delete(value_name);
    set_local(ctx.locals, value_name, "i32");
    ctx.text_locals.delete(value_name);
    ctx.struct_locals.set(value_name, payload.type_expr);
    ctx.union_locals.delete(value_name);
    return;
  }

  ctx.statics.delete(value_name);
  ctx.fn_types.delete(value_name);
  set_local(ctx.locals, value_name, payload.type);

  if (payload.text) {
    ctx.text_locals.add(value_name);
  } else {
    ctx.text_locals.delete(value_name);
  }

  ctx.struct_locals.delete(value_name);

  if (payload.union_type_expr) {
    ctx.union_locals.set(value_name, payload.union_type_expr);
  } else {
    ctx.union_locals.delete(value_name);
  }
}

export function bind_runtime_union_match_payload_temps(
  value_name: string | undefined,
  info: RuntimeUnionMatchInfo,
  ctx: RuntimeUnionMatchTempCtx,
): RuntimeUnionBoundPayloadField[] | undefined {
  if (!value_name) {
    return undefined;
  }

  const payload = info.payload;

  if (payload.tag === "none") {
    throw new Error("Union case has no payload: " + info.case_name);
  }

  if (payload.tag === "value") {
    ctx.statics.delete(value_name);
    ctx.fn_types.delete(value_name);
    set_local(ctx.locals, value_name, payload.type);

    if (payload.text) {
      ctx.text_locals.add(value_name);
    } else {
      ctx.text_locals.delete(value_name);
    }

    ctx.struct_locals.delete(value_name);

    if (payload.union_type_expr) {
      ctx.union_locals.set(value_name, payload.union_type_expr);
    } else {
      ctx.union_locals.delete(value_name);
    }

    return undefined;
  }

  if (payload.tag === "aggregate") {
    ctx.statics.delete(value_name);
    ctx.fn_types.delete(value_name);
    set_local(ctx.locals, value_name, "i32");
    ctx.text_locals.delete(value_name);
    ctx.struct_locals.set(value_name, payload.type_expr);
    ctx.union_locals.delete(value_name);
    return undefined;
  }

  ctx.locals.delete(value_name);
  clear_runtime_union_match_local_facts(value_name, ctx);
  const bound_fields = bind_runtime_union_match_payload_temp_fields(
    value_name,
    payload.fields,
    ctx,
    [],
  );

  ctx.statics.set(value_name, {
    tag: "struct_value",
    type_expr: payload.type_expr,
    fields: runtime_union_bound_payload_core_fields(bound_fields),
  });

  return bound_fields;
}

export function static_runtime_union_match_branch_ctx(
  value_name: string | undefined,
  info: RuntimeUnionMatchInfo,
  ctx: RuntimeUnionMatchCtx,
): RuntimeUnionMatchCtx {
  const branch_ctx: RuntimeUnionMatchCtx = {
    locals: new Map(ctx.locals),
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    borrowed_locals: clone_optional_set(ctx.borrowed_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    host_imports: clone_core_host_imports(ctx.host_imports),
    scratch_depth: ctx.scratch_depth,
    materialized_bindings: clone_optional_set(ctx.materialized_bindings),
    mutable_bindings: clone_optional_set(ctx.mutable_bindings),
  };

  bind_runtime_union_match_payload_fact(value_name, info, branch_ctx);
  return branch_ctx;
}

export function core_runtime_union_match_branch_ctx(
  value_name: string | undefined,
  info: RuntimeUnionMatchInfo,
  ctx: RuntimeUnionMatchCoreCtx,
): RuntimeUnionMatchCoreCtx {
  const branch_ctx: RuntimeUnionMatchCoreCtx = {
    locals: ctx.locals,
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    borrowed_locals: clone_optional_set(ctx.borrowed_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    host_imports: clone_core_host_imports(ctx.host_imports),
    scratch_depth: ctx.scratch_depth,
    materialized_bindings: clone_optional_set(ctx.materialized_bindings),
    mutable_bindings: clone_optional_set(ctx.mutable_bindings),
    next_loop: ctx.next_loop,
    next_temp: ctx.next_temp,
  };

  bind_runtime_union_match_payload_temps(value_name, info, branch_ctx);
  return branch_ctx;
}

function clone_optional_set(
  value: Set<string> | undefined,
): Set<string> | undefined {
  if (!value) {
    return undefined;
  }

  return new Set(value);
}

function bind_runtime_union_match_static_struct_fact(
  value_name: string,
  payload: Extract<RuntimeUnionPayload, { tag: "struct" }>,
  ctx: RuntimeUnionMatchCtx,
): void {
  ctx.locals.delete(value_name);
  clear_runtime_union_match_local_facts(value_name, ctx);

  ctx.statics.set(value_name, {
    tag: "struct_value",
    type_expr: payload.type_expr,
    fields: bind_runtime_union_match_static_struct_fields(
      value_name,
      payload.fields,
      ctx,
      [],
    ),
  });
}

function bind_runtime_union_match_static_struct_fields(
  value_name: string,
  payload_fields: RuntimeUnionPayloadField[],
  ctx: RuntimeUnionMatchCtx,
  path: string[],
): CoreField[] {
  const fields: CoreField[] = [];

  for (const field of payload_fields) {
    if (field.tag === "struct") {
      fields.push({
        name: field.name,
        value: {
          tag: "struct_value",
          type_expr: field.type_expr,
          fields: bind_runtime_union_match_static_struct_fields(
            value_name,
            field.fields,
            ctx,
            [...path, field.name],
          ),
        },
      });
      continue;
    }

    const path_name = [...path, field.name].join("_");
    const local_name = "_payload_" + value_name + "_" + path_name + "#type";
    set_local(ctx.locals, local_name, field.type);

    if (field.text) {
      ctx.text_locals.add(local_name);
    } else {
      ctx.text_locals.delete(local_name);
    }

    ctx.struct_locals.delete(local_name);

    if (field.union_type_expr) {
      ctx.union_locals.set(local_name, field.union_type_expr);
    } else {
      ctx.union_locals.delete(local_name);
    }

    fields.push({
      name: field.name,
      value: { tag: "var", name: local_name },
    });
  }

  return fields;
}

function bind_runtime_union_match_payload_temp_fields(
  value_name: string,
  payload_fields: RuntimeUnionPayloadField[],
  ctx: RuntimeUnionMatchTempCtx,
  path: string[],
): RuntimeUnionBoundPayloadField[] {
  const bound_fields: RuntimeUnionBoundPayloadField[] = [];

  for (const field of payload_fields) {
    if (field.tag === "struct") {
      bound_fields.push({
        tag: "struct",
        name: field.name,
        type_expr: field.type_expr,
        fields: bind_runtime_union_match_payload_temp_fields(
          value_name,
          field.fields,
          ctx,
          [...path, field.name],
        ),
      });
      continue;
    }

    const path_name = [...path, field.name].join("_");
    const local_name = fresh_temp_local(
      ctx,
      "union_payload_" + value_name + "_" + path_name,
    );
    set_local(ctx.locals, local_name, field.type);

    if (field.text) {
      ctx.text_locals.add(local_name);
    } else {
      ctx.text_locals.delete(local_name);
    }

    ctx.struct_locals.delete(local_name);

    if (field.union_type_expr) {
      ctx.union_locals.set(local_name, field.union_type_expr);
    } else {
      ctx.union_locals.delete(local_name);
    }

    bound_fields.push({ ...field, local_name });
  }

  return bound_fields;
}

function runtime_union_bound_payload_core_fields(
  bound_fields: RuntimeUnionBoundPayloadField[],
): CoreField[] {
  const fields: CoreField[] = [];

  for (const field of bound_fields) {
    if (field.tag === "struct") {
      fields.push({
        name: field.name,
        value: {
          tag: "struct_value",
          type_expr: field.type_expr,
          fields: runtime_union_bound_payload_core_fields(field.fields),
        },
      });
      continue;
    }

    fields.push({
      name: field.name,
      value: { tag: "var", name: field.local_name },
    });
  }

  return fields;
}

function clear_runtime_union_match_local_facts(
  name: string,
  ctx: RuntimeUnionMatchCtx,
): void {
  ctx.fn_types.delete(name);
  ctx.text_locals.delete(name);
  ctx.struct_locals.delete(name);
  ctx.union_locals.delete(name);
}
