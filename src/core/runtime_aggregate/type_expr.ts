import { expect } from "../../expect.ts";
import type { CoreExpr, CoreField, CoreFnType, CoreStmt } from "../ast.ts";
import {
  find_runtime_aggregate_field,
  runtime_aggregate_layout_for_type,
  type RuntimeAggregateField,
  same_runtime_aggregate_type_expr,
} from "./layout.ts";
import {
  static_block_result,
  static_type_value,
  type TypeStaticCtx,
} from "../type_static.ts";
import {
  core_host_import_result_type_expr,
  type CoreHostImportCtx,
} from "../host_import.ts";

export type RuntimeAggregateFieldAccess = {
  base: CoreExpr;
  field: RuntimeAggregateField;
};

export type RuntimeAggregateTypeCtx = TypeStaticCtx & CoreHostImportCtx & {
  statics: Map<string, CoreExpr>;
  struct_locals: Map<string, CoreExpr>;
};

export type RuntimeAggregateTypeHooks<ctx extends RuntimeAggregateTypeCtx> = {
  check_closure_call_args: (
    expr: Extract<CoreExpr, { tag: "app" }>,
    fn_type: CoreFnType,
    ctx: ctx,
  ) => void;
  closure_fn_type: (
    expr: CoreExpr,
    ctx: ctx,
  ) => CoreFnType | undefined;
};

export function runtime_aggregate_type_expr<
  ctx extends RuntimeAggregateTypeCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): CoreExpr | undefined {
  if (value.tag === "struct_value") {
    return value.type_expr;
  }

  if (value.tag === "struct_update") {
    return runtime_aggregate_type_expr(value.base, ctx, hooks);
  }

  if (value.tag === "var" || value.tag === "linear") {
    const local_type = ctx.struct_locals.get(value.name);

    if (local_type) {
      return local_type;
    }

    const static_value = ctx.statics.get(value.name);

    if (static_value) {
      return runtime_aggregate_type_expr(static_value, ctx, hooks);
    }
  }

  if (value.tag === "app") {
    if (
      value.func.tag === "rec_ref" &&
      value.func.result_annotation !== undefined
    ) {
      const result_type: CoreExpr = {
        tag: "var",
        name: value.func.result_annotation,
      };
      const result_value = static_type_value(result_type, ctx);
      if (result_value?.tag === "struct_type") {
        return result_type;
      }
    }

    const host_type = core_host_import_result_type_expr(value, ctx);

    if (host_type) {
      const host_type_value = static_type_value(host_type, ctx);
      if (host_type_value && host_type_value.tag === "struct_type") {
        return host_type;
      }
    }

    const branch_type = runtime_aggregate_branch_call_type_expr(
      value,
      ctx,
      hooks,
    );

    if (branch_type) {
      return branch_type;
    }

    const fn_type = hooks.closure_fn_type(value.func, ctx);

    if (fn_type) {
      return fn_type.result_struct;
    }
  }

  if (value.tag === "field") {
    const access = runtime_aggregate_field_access(
      value.object,
      value.name,
      ctx,
      hooks,
    );

    if (access && access.field.tag === "struct") {
      return access.field.type_expr;
    }
  }

  if (
    value.tag === "index" && value.index.tag === "num" &&
    value.index.type === "i32" && typeof value.index.value === "number" &&
    Number.isInteger(value.index.value) && value.index.value >= 0
  ) {
    const object_type = runtime_aggregate_type_expr(
      value.object,
      ctx,
      hooks,
    );

    if (object_type) {
      const object_type_value = static_type_value(object_type, ctx);

      if (object_type_value?.tag !== "struct_type") {
        return undefined;
      }

      const layout = runtime_aggregate_layout_for_type(object_type, ctx);
      const field = layout.fields[value.index.value];

      if (field?.tag === "struct") {
        return field.type_expr;
      }
    }
  }

  if (value.tag === "borrow" || value.tag === "freeze") {
    return runtime_aggregate_type_expr(value.value, ctx, hooks);
  }

  if (value.tag === "scratch") {
    return runtime_aggregate_type_expr(value.body, ctx, hooks);
  }

  if (value.tag === "if") {
    const then_type = runtime_aggregate_type_expr(
      value.then_branch,
      ctx,
      hooks,
    );
    const else_type = runtime_aggregate_type_expr(
      value.else_branch,
      ctx,
      hooks,
    );
    expect(
      same_runtime_aggregate_type_expr(then_type, else_type, ctx),
      "Core runtime aggregate if branch type mismatch",
    );
    return then_type;
  }

  if (value.tag === "block") {
    return runtime_aggregate_block_result_type_expr(value, ctx, hooks);
  }

  return undefined;
}

export function runtime_struct_update_value<
  ctx extends RuntimeAggregateTypeCtx,
>(
  expr: Extract<CoreExpr, { tag: "struct_update" }>,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx> & {
    static_struct_value: (
      expr: CoreExpr,
      ctx: ctx,
    ) => Extract<CoreExpr, { tag: "struct_value" }> | undefined;
  },
): Extract<CoreExpr, { tag: "struct_value" }> | undefined {
  const static_value = hooks.static_struct_value(expr, ctx);

  if (static_value) {
    return static_value;
  }

  const type_expr = runtime_aggregate_type_expr(expr.base, ctx, hooks);

  if (!type_expr) {
    return undefined;
  }

  const layout = runtime_aggregate_layout_for_type(type_expr, ctx);
  const fields: CoreField[] = layout.fields.map((field) => ({
    name: field.name,
    value: {
      tag: "field",
      object: expr.base,
      name: field.name,
      move: true,
    },
  }));

  for (const update of expr.fields) {
    const field = fields.find((candidate) => candidate.name === update.name);
    expect(field, "Missing runtime aggregate field: " + update.name);
    field.value = update.value;
  }

  return { tag: "struct_value", type_expr, fields };
}

function runtime_aggregate_branch_call_type_expr<
  ctx extends RuntimeAggregateTypeCtx,
>(
  value: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): CoreExpr | undefined {
  const branch = runtime_aggregate_call_branch(value.func, ctx, hooks);

  if (!branch) {
    return undefined;
  }

  const then_type = runtime_aggregate_type_expr(
    {
      tag: "app",
      func: branch.then_branch,
      args: value.args,
    },
    ctx,
    hooks,
  );
  const else_type = runtime_aggregate_type_expr(
    {
      tag: "app",
      func: branch.else_branch,
      args: value.args,
    },
    ctx,
    hooks,
  );

  expect(
    same_runtime_aggregate_type_expr(then_type, else_type, ctx),
    "Core runtime aggregate branch call type mismatch",
  );
  return then_type;
}

function runtime_aggregate_call_branch<
  ctx extends RuntimeAggregateTypeCtx,
>(
  value: CoreExpr,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): Extract<CoreExpr, { tag: "if" }> | undefined {
  if (value.tag === "block") {
    const block_value = static_block_result(value);

    if (!block_value) {
      return undefined;
    }

    return runtime_aggregate_call_branch(block_value, ctx, hooks);
  }

  if (value.tag === "var") {
    const static_value = ctx.statics.get(value.name);

    if (!static_value) {
      return undefined;
    }

    return runtime_aggregate_call_branch(static_value, ctx, hooks);
  }

  if (value.tag !== "if") {
    return undefined;
  }

  const then_type = hooks.closure_fn_type(value.then_branch, ctx);

  if (!then_type) {
    return undefined;
  }

  const else_type = hooks.closure_fn_type(value.else_branch, ctx);

  if (!else_type) {
    return undefined;
  }

  return value;
}

function runtime_aggregate_block_result_type_expr<
  ctx extends RuntimeAggregateTypeCtx,
>(
  value: Extract<CoreExpr, { tag: "block" }>,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): CoreExpr | undefined {
  const final_stmt = value.statements[value.statements.length - 1];

  if (!final_stmt) {
    return undefined;
  }

  const final_expr = runtime_aggregate_block_final_expr(final_stmt);

  if (!final_expr) {
    return undefined;
  }

  const direct = runtime_aggregate_type_expr(final_expr, ctx, hooks);

  if (direct) {
    return direct;
  }

  const alias = runtime_aggregate_result_alias(final_expr);

  if (!alias) {
    return undefined;
  }

  return runtime_aggregate_block_alias_type_expr(
    alias,
    value.statements,
    ctx,
    hooks,
    new Set<string>(),
  );
}

function runtime_aggregate_block_final_expr(
  stmt: CoreStmt,
): CoreExpr | undefined {
  if (stmt.tag === "expr") {
    return stmt.expr;
  }

  if (stmt.tag === "return") {
    return stmt.value;
  }

  return undefined;
}

function runtime_aggregate_result_alias(expr: CoreExpr): string | undefined {
  const block_value = static_block_result(expr);

  if (block_value) {
    return runtime_aggregate_result_alias(block_value);
  }

  if (expr.tag === "borrow" || expr.tag === "freeze") {
    return runtime_aggregate_result_alias(expr.value);
  }

  if (expr.tag === "struct_update") {
    return runtime_aggregate_result_alias(expr.base);
  }

  if (expr.tag === "var") {
    return expr.name;
  }

  return undefined;
}

function runtime_aggregate_block_alias_type_expr<
  ctx extends RuntimeAggregateTypeCtx,
>(
  alias: string,
  statements: CoreStmt[],
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
  seen: Set<string>,
): CoreExpr | undefined {
  if (seen.has(alias)) {
    return undefined;
  }

  seen.add(alias);

  for (let index = statements.length - 2; index >= 0; index -= 1) {
    const stmt = statements[index];
    expect(stmt, "Missing runtime aggregate block statement");

    if (stmt.tag === "bind" && stmt.name === alias) {
      const annotation_type = runtime_aggregate_annotation_type_expr(
        stmt.annotation,
        ctx,
      );

      if (annotation_type) {
        return annotation_type;
      }

      const nested_alias = runtime_aggregate_result_alias(stmt.value);

      if (nested_alias) {
        const nested_type = runtime_aggregate_block_alias_type_expr(
          nested_alias,
          statements.slice(0, index + 1),
          ctx,
          hooks,
          seen,
        );

        if (nested_type) {
          return nested_type;
        }
      }

      return runtime_aggregate_type_expr(stmt.value, ctx, hooks);
    }

    if (stmt.tag === "assign" && stmt.name === alias) {
      const nested_alias = runtime_aggregate_result_alias(stmt.value);

      if (nested_alias) {
        const nested_type = runtime_aggregate_block_alias_type_expr(
          nested_alias,
          statements.slice(0, index + 1),
          ctx,
          hooks,
          seen,
        );

        if (nested_type) {
          return nested_type;
        }
      }

      return runtime_aggregate_type_expr(stmt.value, ctx, hooks);
    }
  }

  return undefined;
}

function runtime_aggregate_annotation_type_expr<ctx extends TypeStaticCtx>(
  annotation: string | undefined,
  ctx: ctx,
): CoreExpr | undefined {
  if (!annotation) {
    return undefined;
  }

  const type_expr: CoreExpr = { tag: "var", name: annotation };
  const type_value = static_type_value(type_expr, ctx);

  if (!type_value || type_value.tag !== "struct_type") {
    return undefined;
  }

  return type_expr;
}

export function runtime_aggregate_field_info<
  ctx extends RuntimeAggregateTypeCtx,
>(
  object: CoreExpr,
  name: string,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): RuntimeAggregateField | undefined {
  const access = runtime_aggregate_field_access(object, name, ctx, hooks);

  if (access) {
    return access.field;
  }

  return undefined;
}

export function runtime_aggregate_field_access<
  ctx extends RuntimeAggregateTypeCtx,
>(
  object: CoreExpr,
  name: string,
  ctx: ctx,
  hooks: RuntimeAggregateTypeHooks<ctx>,
): RuntimeAggregateFieldAccess | undefined {
  if (object.tag === "field") {
    const parent = runtime_aggregate_field_access(
      object.object,
      object.name,
      ctx,
      hooks,
    );

    if (!parent || parent.field.tag !== "struct") {
      return undefined;
    }

    const nested = find_runtime_aggregate_field(parent.field.fields, name);

    if (!nested) {
      return undefined;
    }

    return {
      base: parent.base,
      field: nested,
    };
  }

  const type_expr = runtime_aggregate_type_expr(object, ctx, hooks);

  if (!type_expr) {
    return undefined;
  }

  const layout = runtime_aggregate_layout_for_type(type_expr, ctx);
  const field = find_runtime_aggregate_field(layout.fields, name);

  if (!field) {
    return undefined;
  }

  return {
    base: object,
    field,
  };
}
