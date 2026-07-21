import { expect } from "../expect.ts";
import type { CoreExpr, CoreFnType } from "./ast.ts";
import {
  format_type_expr,
  parse_type_expr,
  tokenize,
} from "./from_source/type_contract.ts";

export type CoreLocalFactCtx = {
  fn_types: Map<string, CoreFnType>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
  union_locals: Map<string, CoreExpr>;
  borrowed_locals?: Set<string>;
  frozen_locals?: Set<string>;
};

export type CoreLocalFactHooks<ctx extends CoreLocalFactCtx> = {
  closure_fn_type: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreFnType | undefined;
  runtime_union_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  runtime_aggregate_type_expr: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
  same_runtime_aggregate_type_expr: (
    left: CoreExpr,
    right: CoreExpr,
    ctx: ctx,
  ) => boolean;
  same_runtime_union_type_expr: (
    left: CoreExpr,
    right: CoreExpr,
    ctx: ctx,
  ) => boolean;
  static_type_value: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreExpr | undefined;
};

export function core_expr_is_borrowed(
  value: CoreExpr,
  ctx: Pick<CoreLocalFactCtx, "borrowed_locals">,
): boolean {
  if (value.tag === "borrow") {
    return true;
  }

  if (value.tag === "var" || value.tag === "linear") {
    return ctx.borrowed_locals?.has(value.name) === true;
  }

  if (value.tag === "field" || value.tag === "index") {
    return core_expr_is_borrowed(value.object, ctx);
  }

  return false;
}

export function bind_core_borrowed_fact(
  name: string,
  annotation: string | undefined,
  value: CoreExpr,
  ctx: Pick<CoreLocalFactCtx, "borrowed_locals">,
): void {
  if (!ctx.borrowed_locals) {
    return;
  }

  if (annotation?.startsWith("&") || core_expr_is_borrowed(value, ctx)) {
    ctx.borrowed_locals.add(name);
    return;
  }

  ctx.borrowed_locals.delete(name);
}

export function bind_core_fn_type<ctx extends CoreLocalFactCtx>(
  name: string,
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreLocalFactHooks<ctx>,
): void {
  const fn_type = hooks.closure_fn_type(value, ctx);

  if (!fn_type) {
    ctx.fn_types.delete(name);
    return;
  }

  ctx.fn_types.set(name, fn_type);
}

export function bind_core_union_type<ctx extends CoreLocalFactCtx>(
  name: string,
  value: CoreExpr,
  annotation: string | undefined,
  ctx: ctx,
  hooks: CoreLocalFactHooks<ctx>,
): void {
  const annotation_type = core_annotation_union_type_expr(
    annotation,
    ctx,
    hooks,
  );

  if (annotation_type) {
    const actual = hooks.runtime_union_type_expr(value, ctx);
    expect(
      actual && hooks.same_runtime_union_type_expr(
        annotation_type,
        actual,
        ctx,
      ),
      "Core union annotation expects " + annotation,
    );
    ctx.union_locals.set(name, annotation_type);
    return;
  }

  const inferred = hooks.runtime_union_type_expr(value, ctx);

  if (inferred) {
    ctx.union_locals.set(name, inferred);
    return;
  }

  ctx.union_locals.delete(name);
}

export function bind_core_struct_type<ctx extends CoreLocalFactCtx>(
  name: string,
  value: CoreExpr,
  annotation: string | undefined,
  ctx: ctx,
  hooks: CoreLocalFactHooks<ctx>,
): void {
  const annotation_type = core_annotation_struct_type_expr(
    annotation,
    ctx,
    hooks,
  );

  if (annotation_type) {
    const actual = hooks.runtime_aggregate_type_expr(value, ctx);
    expect(
      actual && hooks.same_runtime_aggregate_type_expr(
        annotation_type,
        actual,
        ctx,
      ),
      "Core struct annotation expects " + annotation,
    );
    ctx.struct_locals.set(name, annotation_type);
    return;
  }

  const inferred = hooks.runtime_aggregate_type_expr(value, ctx);

  if (inferred) {
    ctx.struct_locals.set(name, inferred);
    return;
  }

  ctx.struct_locals.delete(name);
}

export function bind_core_assignment_union_type<
  ctx extends CoreLocalFactCtx,
>(
  name: string,
  value: CoreExpr,
  mode: "same" | "change",
  ctx: ctx,
  hooks: CoreLocalFactHooks<ctx>,
): void {
  const expected = ctx.union_locals.get(name);
  const actual = hooks.runtime_union_type_expr(value, ctx);

  if (expected && mode === "same") {
    expect(
      actual && hooks.same_runtime_union_type_expr(expected, actual, ctx),
      "Core union assignment expects the same union type",
    );
    ctx.union_locals.set(name, expected);
    return;
  }

  if (actual) {
    ctx.union_locals.set(name, actual);
    return;
  }

  ctx.union_locals.delete(name);
}

export function bind_core_assignment_struct_type<
  ctx extends CoreLocalFactCtx,
>(
  name: string,
  value: CoreExpr,
  mode: "same" | "change",
  ctx: ctx,
  hooks: CoreLocalFactHooks<ctx>,
): void {
  const expected = ctx.struct_locals.get(name);
  const actual = hooks.runtime_aggregate_type_expr(value, ctx);

  if (expected && mode === "same") {
    expect(
      actual && hooks.same_runtime_aggregate_type_expr(expected, actual, ctx),
      "Core struct assignment expects the same struct type",
    );
    ctx.struct_locals.set(name, expected);
    return;
  }

  if (actual) {
    ctx.struct_locals.set(name, actual);
    return;
  }

  ctx.struct_locals.delete(name);
}

export function core_annotation_union_type_expr<
  ctx extends CoreLocalFactCtx,
>(
  annotation: string | undefined,
  ctx: ctx,
  hooks: CoreLocalFactHooks<ctx>,
): CoreExpr | undefined {
  if (!annotation) {
    return undefined;
  }

  const type_value = hooks.static_type_value(
    { tag: "var", name: annotation },
    ctx,
  );

  if (!type_value || type_value.tag !== "union_type") {
    return undefined;
  }

  return { tag: "var", name: annotation };
}

export function core_annotation_struct_type_expr<
  ctx extends CoreLocalFactCtx,
>(
  annotation: string | undefined,
  ctx: ctx,
  hooks: CoreLocalFactHooks<ctx>,
): CoreExpr | undefined {
  if (!annotation) {
    return undefined;
  }

  const parsed = parse_type_expr(tokenize(annotation));

  if (parsed.tag === "product" || parsed.tag === "tuple") {
    const fields: Extract<CoreExpr, { tag: "struct_type" }>["fields"] = [];

    if (parsed.tag === "product") {
      for (let index = 0; index < parsed.entries.length; index += 1) {
        const entry = parsed.entries[index];
        expect(entry, "Missing inline Core struct annotation entry");
        let name = entry.label;

        if (name === undefined) {
          name = "item_" + index.toString();
        }

        fields.push({
          name,
          type_name: format_type_expr(entry.type_expr),
          set_member: entry.type_expr,
        });
      }
    } else {
      for (let index = 0; index < parsed.items.length; index += 1) {
        const item = parsed.items[index];
        expect(item, "Missing inline Core tuple annotation item");
        fields.push({
          name: "item_" + index.toString(),
          type_name: format_type_expr(item),
          set_member: item,
        });
      }
    }

    return { tag: "struct_type", fields };
  }

  const type_value = hooks.static_type_value(
    { tag: "var", name: annotation },
    ctx,
  );

  if (!type_value || type_value.tag !== "struct_type") {
    return undefined;
  }

  return { tag: "var", name: annotation };
}

export function clear_core_local_facts<ctx extends CoreLocalFactCtx>(
  name: string,
  ctx: ctx,
): void {
  ctx.fn_types.delete(name);
  ctx.text_locals.delete(name);
  ctx.struct_locals.delete(name);
  ctx.union_locals.delete(name);
  if (ctx.borrowed_locals) {
    ctx.borrowed_locals.delete(name);
  }
  if (ctx.frozen_locals) {
    ctx.frozen_locals.delete(name);
  }
}

export function clear_optional_core_union_local<
  ctx extends CoreLocalFactCtx,
>(
  name: string | undefined,
  ctx: ctx,
): void {
  if (!name) {
    return;
  }

  ctx.union_locals.delete(name);
}
