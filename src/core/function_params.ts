import type { CoreParam } from "./ast.ts";
import { set_local } from "./emit/local.ts";
import type { CoreCtx } from "./local_collect/types.ts";
import {
  core_val_type_from_type_name,
  resolve_core_type_name,
  static_type_value,
} from "./type_static.ts";

export function bind_core_function_params(
  params: CoreParam[],
  ctx: CoreCtx,
): void {
  for (const param of params) {
    let resolved_name = "I32";
    let annotation = param.annotation;

    if (
      annotation !== undefined &&
      (annotation.startsWith("&") || annotation.startsWith("^"))
    ) {
      annotation = annotation.slice(1);
    }

    if (annotation !== undefined) {
      resolved_name = resolve_core_type_name(annotation, ctx);
    }

    let type = core_val_type_from_type_name(resolved_name);

    if (type === undefined) {
      type = "i32";
    }

    set_local(ctx.locals, param.name, type);
    ctx.fn_types.delete(param.name);
    ctx.text_locals.delete(param.name);
    ctx.struct_locals.delete(param.name);
    ctx.union_locals.delete(param.name);

    if (ctx.borrowed_locals) {
      if (param.annotation?.startsWith("&")) {
        ctx.borrowed_locals.add(param.name);
      } else {
        ctx.borrowed_locals.delete(param.name);
      }
    }

    if (ctx.frozen_locals) {
      if (param.annotation?.startsWith("^")) {
        ctx.frozen_locals.add(param.name);
      } else {
        ctx.frozen_locals.delete(param.name);
      }
    }

    if (annotation === undefined) {
      continue;
    }

    if (resolved_name === "Text" || resolved_name === "Bytes") {
      ctx.text_locals.add(param.name);
    }

    const type_expr = { tag: "var", name: annotation } as const;
    const type_value = static_type_value(type_expr, ctx);

    if (type_value?.tag === "struct_type") {
      ctx.struct_locals.set(param.name, type_expr);
    }

    if (type_value?.tag === "union_type") {
      ctx.union_locals.set(param.name, type_expr);
    }
  }
}
