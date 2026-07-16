import { expect } from "../../expect.ts";
import type { CoreExpr, CoreField } from "../ast.ts";
import { maybe_static_i32 } from "../analysis/static_i32.ts";
import { static_indexed_field } from "../analysis/field.ts";
import type { CoreTextFactCtx, CoreTextFactHooks } from "./types.ts";

type CoreTextChecker<ctx extends CoreTextFactCtx> = (
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
) => boolean;

export function core_get_app_text_fact<ctx extends CoreTextFactCtx>(
  value: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: CoreTextChecker<ctx>,
): boolean {
  if (value.tag !== "app") {
    return false;
  }

  if (value.func.tag !== "var" || value.func.name !== "get") {
    return false;
  }

  expect(value.args.length === 2, "Core get expects 2 arguments");
  const collection = value.args[0];
  const index = value.args[1];
  expect(collection, "Missing core get collection");
  expect(index, "Missing core get index");
  return core_collection_index_text_fact(
    collection,
    index,
    ctx,
    hooks,
    check_text,
  );
}

export function core_collection_index_text_fact<
  ctx extends CoreTextFactCtx,
>(
  collection: CoreExpr,
  index: CoreExpr,
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: CoreTextChecker<ctx>,
): boolean {
  const fields = hooks.static_collection_fields(collection, ctx);

  if (!fields) {
    return false;
  }

  const index_type = hooks.expr_type(index, ctx);
  expect(index_type === "i32", "Core collection text index must be i32");
  const static_index = maybe_static_i32(index);

  if (static_index !== undefined) {
    const field = static_indexed_field(fields, static_index);
    return check_text(field.value, ctx, hooks);
  }

  return core_collection_fields_have_text_fact(fields, ctx, hooks, check_text);
}

function core_collection_fields_have_text_fact<
  ctx extends CoreTextFactCtx,
>(
  fields: CoreField[],
  ctx: ctx,
  hooks: CoreTextFactHooks<ctx>,
  check_text: CoreTextChecker<ctx>,
): boolean {
  let result: boolean | undefined;

  for (const field of fields) {
    const is_text = check_text(field.value, ctx, hooks);

    if (result === undefined) {
      result = is_text;
    } else {
      expect(
        result === is_text,
        "Core collection item text fact mismatch",
      );
    }
  }

  return result === true;
}
