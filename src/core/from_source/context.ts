import type {
  FrontExpr,
  FrontHostImportOwnerReason,
  Stmt,
} from "../../frontend/ast.ts";
import type { CoreExpr, CoreHostImportOwnerReason, CoreParam } from "../ast.ts";

export type CoreFromSourceCtx = {
  aliases: Map<string, string>;
  host_import_const_names: Set<string>;
  host_import_names: Set<string>;
  host_import_type_values: Map<string, CoreHostImportOwnerReason>;
  linear_names: Set<string>;
  fresh: { next: number };
  namedRecs: Map<string, { params: CoreParam[]; body: CoreExpr }>;
};

export function create_core_from_source_ctx(): CoreFromSourceCtx {
  return {
    aliases: new Map(),
    host_import_const_names: new Set(),
    host_import_names: new Set(),
    host_import_type_values: new Map(),
    linear_names: new Set(),
    fresh: { next: 0 },
    namedRecs: new Map(),
  };
}

export function fork_core_from_source_ctx(
  ctx: CoreFromSourceCtx,
): CoreFromSourceCtx {
  return {
    aliases: new Map(ctx.aliases),
    host_import_const_names: new Set(ctx.host_import_const_names),
    host_import_names: new Set(ctx.host_import_names),
    host_import_type_values: new Map(ctx.host_import_type_values),
    linear_names: new Set(ctx.linear_names),
    fresh: ctx.fresh,
    namedRecs: new Map(ctx.namedRecs),
  };
}

export function record_core_from_source_type_value(
  stmt: Stmt,
  ctx: CoreFromSourceCtx,
): void {
  if (stmt.tag !== "bind") {
    return;
  }

  if (stmt.kind !== "const") {
    return;
  }

  ctx.host_import_const_names.add(stmt.name);
  const reason = front_host_import_type_value_reason(
    stmt.value,
    ctx,
    new Set(),
  );

  if (!reason) {
    ctx.host_import_type_values.delete(stmt.name);
    return;
  }

  ctx.host_import_type_values.set(stmt.name, reason);
}

export function core_host_import_owner_reason(
  reason: FrontHostImportOwnerReason,
  ctx: CoreFromSourceCtx,
): CoreHostImportOwnerReason {
  if (typeof reason === "string") {
    return reason;
  }

  const resolved = ctx.host_import_type_values.get(reason.name);

  if (!resolved) {
    if (ctx.host_import_const_names.has(reason.name)) {
      throw new Error(
        "Host import owner type " + reason.name +
          " must resolve to a struct or union type-value",
      );
    }

    throw new Error("Missing host import owner type value: " + reason.name);
  }

  return resolved;
}

export function resolve_core_name(
  ctx: CoreFromSourceCtx,
  name: string,
): string {
  const alias = ctx.aliases.get(name);

  if (alias) {
    return alias;
  }

  return name;
}

export function bind_core_name(
  ctx: CoreFromSourceCtx,
  name: string,
): string {
  let bound = name;

  if (ctx.aliases.has(name)) {
    bound = fresh_core_shadow_name(ctx, name);
  }

  ctx.aliases.set(name, bound);
  return bound;
}

export function shadow_core_name(
  ctx: CoreFromSourceCtx,
  name: string,
): string {
  const bound = fresh_core_shadow_name(ctx, name);
  ctx.aliases.set(name, bound);
  return bound;
}

function front_host_import_type_value_reason(
  expr: FrontExpr,
  ctx: CoreFromSourceCtx,
  seen: Set<string>,
): CoreHostImportOwnerReason | undefined {
  switch (expr.tag) {
    case "struct_type":
      return "runtime_aggregate";

    case "union_type":
      return "runtime_union";

    case "var": {
      if (seen.has(expr.name)) {
        throw new Error("Recursive host import owner type alias: " + expr.name);
      }

      const reason = ctx.host_import_type_values.get(expr.name);

      if (!reason) {
        return undefined;
      }

      seen.add(expr.name);
      return reason;
    }

    case "comptime":
      return front_host_import_type_value_reason(expr.expr, ctx, seen);

    case "captured":
      return front_host_import_type_value_reason(expr.expr, ctx, seen);

    default:
      return undefined;
  }
}

function fresh_core_shadow_name(
  ctx: CoreFromSourceCtx,
  name: string,
): string {
  const fresh = "_" + name + "#shadow" + ctx.fresh.next.toString();
  ctx.fresh.next += 1;
  return fresh;
}
