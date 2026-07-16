import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreField } from "./ast.ts";
import { indent_lines } from "./emit/format.ts";

export type CoreCollectionItemTypeHooks<ctx> = {
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
};

export type CoreDynamicIndexHooks<ctx> =
  & CoreCollectionItemTypeHooks<ctx>
  & {
    emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  };

export function static_collection_item_type<ctx>(
  fields: CoreField[],
  ctx: ctx,
  hooks: CoreCollectionItemTypeHooks<ctx>,
): ValType | undefined {
  let result: ValType | undefined;

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    expect(field, "Missing static collection field " + index.toString());
    const type = hooks.expr_type(field.value, ctx);

    if (!result) {
      result = type;
    } else {
      expect(
        result === type,
        "Core collection item type mismatch: " + result + ", got " + type,
      );
    }
  }

  return result;
}

export function emit_core_dynamic_index_expr<ctx>(
  fields: CoreField[],
  index_expr: CoreExpr,
  ctx: ctx,
  hooks: CoreDynamicIndexHooks<ctx>,
): Wat {
  const result_type = static_collection_item_type(fields, ctx, hooks);
  expect(result_type, "Core dynamic index requires non-empty collection");
  let result = "unreachable";

  for (let index = fields.length - 1; index >= 0; index -= 1) {
    const field = fields[index];
    expect(field, "Missing static collection field " + index.toString());
    result = [
      hooks.emit_expr(index_expr, ctx),
      "i32.const " + index.toString(),
      "i32.eq",
      "if (result " + result_type + ")",
      indent_lines(hooks.emit_expr(field.value, ctx), 2),
      "else",
      indent_lines(result, 2),
      "end",
    ].join("\n");
  }

  return result;
}
