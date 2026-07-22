import type { CoreExpr } from "../ast.ts";
import {
  runtime_aggregate_field_base_offset,
  runtime_aggregate_layout_for_type,
} from "../runtime_aggregate.ts";
import type { TypeStaticCtx } from "../type_static.ts";
import {
  frozen_expr_consumed_owner,
  moved_expr_owner,
  unique_heap_ownership,
} from "./ownership.ts";
import type { CoreDropHooks, CoreDropOwner, CoreDropState } from "./types.ts";

export function bind_drop_owner<ctx>(
  name: string,
  expr: CoreExpr,
  owners: Map<string, CoreDropOwner>,
  ctx: ctx,
  hooks: CoreDropHooks<ctx>,
  state: CoreDropState,
): void {
  const expr_result = state.expr_results.get(expr);
  if (expr_result && expr_result.tag === "branch") {
    const ownership = unique_heap_ownership(expr, ctx, hooks);
    if (ownership) {
      owners.set(name, {
        name,
        ownership,
        pointer: "named",
        subject: expr,
      });
      return;
    }

    owners.delete(name);
    return;
  }

  if (expr_result && expr_result.tag === "none") {
    owners.delete(name);
    return;
  }

  const frozen_owner = frozen_expr_consumed_owner(expr, owners, state);

  if (frozen_owner) {
    owners.delete(frozen_owner.name);
    owners.delete(name);
    return;
  }

  if (expr.tag === "freeze") {
    owners.delete(name);
    return;
  }

  if (expr.tag === "field" && expr.move) {
    let field_moves_base_pointer = false;
    const object_type = hooks.runtime_aggregate_type_expr?.(expr.object, ctx);
    if (object_type !== undefined) {
      const layout = runtime_aggregate_layout_for_type(
        object_type,
        ctx as ctx & TypeStaticCtx,
      );
      const field = layout.fields.find((candidate) => {
        return candidate.name === expr.name;
      });
      field_moves_base_pointer = field?.tag === "struct" &&
        runtime_aggregate_field_base_offset(field) === 0;
    }
    const object_owner = moved_expr_owner(expr.object, owners, state);

    if (
      field_moves_base_pointer &&
      object_owner?.ownership.reason === "runtime_aggregate"
    ) {
      state.aliases.set(name, object_owner.name);
      return;
    }
  }

  const moved_owner = moved_expr_owner(expr, owners, state);
  state.aliases.delete(name);

  if (moved_owner) {
    owners.delete(moved_owner.name);
    owners.set(name, {
      name,
      ownership: moved_owner.ownership,
      pointer: moved_owner.pointer,
      subject: moved_owner.subject,
    });
    return;
  }

  const ownership = unique_heap_ownership(expr, ctx, hooks);

  if (ownership) {
    owners.set(name, {
      name,
      ownership,
      pointer: "named",
      subject: expr,
    });
    return;
  }

  owners.delete(name);
}
