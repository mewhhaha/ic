import type {
  FrontExpr,
  FrontHostImportOwnerReason,
  Stmt,
  TypeExpr,
} from "../../frontend/ast.ts";
import { format_type_expr, parse_type_expr } from "../../frontend/type_expr.ts";
import { tokenize } from "../../frontend/tokenize.ts";
import type { CoreExpr, CoreHostImportOwnerReason, CoreParam } from "../ast.ts";

export type CoreNamedRecSource = {
  params: CoreParam[];
  body: CoreExpr | undefined;
};

export type CoreFromSourceCtx = {
  aliases: Map<string, string>;
  capability_methods: Map<string, Map<string, string>>;
  dynamic_capability_tables: Set<string>;
  host_import_const_names: Set<string>;
  host_import_names: Set<string>;
  host_import_type_values: Map<string, CoreHostImportOwnerReason>;
  linear_names: Set<string>;
  fresh: { next: number };
  namedRecs: Map<string, CoreNamedRecSource>;
  scalar_annotation_aliases: Map<string, string>;
  type_set_aliases: Map<string, TypeExpr>;
};

export function create_core_from_source_ctx(): CoreFromSourceCtx {
  return {
    aliases: new Map(),
    capability_methods: new Map(),
    dynamic_capability_tables: new Set(),
    host_import_const_names: new Set(),
    host_import_names: new Set(),
    host_import_type_values: new Map(),
    linear_names: new Set(),
    fresh: { next: 0 },
    namedRecs: new Map(),
    scalar_annotation_aliases: new Map(),
    type_set_aliases: new Map(),
  };
}

export function fork_core_from_source_ctx(
  ctx: CoreFromSourceCtx,
): CoreFromSourceCtx {
  return {
    aliases: new Map(ctx.aliases),
    capability_methods: clone_capability_methods(ctx.capability_methods),
    dynamic_capability_tables: new Set(ctx.dynamic_capability_tables),
    host_import_const_names: new Set(ctx.host_import_const_names),
    host_import_names: new Set(ctx.host_import_names),
    host_import_type_values: new Map(ctx.host_import_type_values),
    linear_names: new Set(ctx.linear_names),
    fresh: ctx.fresh,
    namedRecs: new Map(ctx.namedRecs),
    scalar_annotation_aliases: new Map(ctx.scalar_annotation_aliases),
    type_set_aliases: new Map(ctx.type_set_aliases),
  };
}

function clone_capability_methods(
  methods: Map<string, Map<string, string>>,
): Map<string, Map<string, string>> {
  const cloned = new Map<string, Map<string, string>>();

  for (const [name, entries] of methods) {
    cloned.set(name, new Map(entries));
  }

  return cloned;
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

  if (stmt.value.tag === "set_type") {
    ctx.type_set_aliases.set(stmt.name, stmt.value.type_expr);
  } else if (
    stmt.value.tag === "var" && ctx.type_set_aliases.has(stmt.value.name)
  ) {
    const alias = ctx.type_set_aliases.get(stmt.value.name);

    if (!alias) {
      throw new Error("Missing type-set alias: " + stmt.value.name);
    }

    ctx.type_set_aliases.set(stmt.name, alias);
  }

  if (stmt.value.tag === "var") {
    let scalar_annotation = ctx.scalar_annotation_aliases.get(
      stmt.value.name,
    );

    if (
      !scalar_annotation &&
      core_builtin_scalar_annotation_names.has(stmt.value.name)
    ) {
      scalar_annotation = stmt.value.name;
    }

    if (scalar_annotation) {
      ctx.scalar_annotation_aliases.set(stmt.name, scalar_annotation);
    }
  }

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

const core_builtin_scalar_annotation_names = new Set([
  "Bool",
  "I32",
  "I64",
  "Int",
  "Resume",
  "U32",
  "Unit",
]);

export function resolve_core_annotation(
  ctx: CoreFromSourceCtx,
  annotation: string | undefined,
): string | undefined {
  if (!annotation) {
    return undefined;
  }

  const parsed = parse_type_expr(tokenize(annotation));
  const expanded = expand_core_annotation_aliases(parsed, ctx, new Set());

  if (!expanded.changed) {
    return annotation;
  }

  return format_type_expr(expanded.type);
}

function expand_core_annotation_aliases(
  type: TypeExpr,
  ctx: CoreFromSourceCtx,
  resolving: Set<string>,
): { type: TypeExpr; changed: boolean } {
  if (type.tag === "name") {
    let alias = ctx.type_set_aliases.get(type.name);

    if (!alias) {
      const scalar_annotation = ctx.scalar_annotation_aliases.get(type.name);

      if (scalar_annotation) {
        alias = { tag: "name", name: scalar_annotation };
      }
    }

    if (!alias) {
      return { type, changed: false };
    }

    if (resolving.has(type.name)) {
      throw new Error("Recursive type-set alias: " + type.name);
    }

    const next = new Set(resolving);
    next.add(type.name);
    const expanded = expand_core_annotation_aliases(alias, ctx, next);
    return { type: expanded.type, changed: true };
  }

  if (
    type.tag === "atom" || type.tag === "top" || type.tag === "never"
  ) {
    return { type, changed: false };
  }

  if (type.tag === "frozen" || type.tag === "borrow") {
    const value = expand_core_annotation_aliases(type.value, ctx, resolving);

    if (!value.changed) {
      return { type, changed: false };
    }

    return { type: { ...type, value: value.type }, changed: true };
  }

  if (type.tag === "apply") {
    const func = expand_core_annotation_aliases(type.func, ctx, resolving);
    const arg = expand_core_annotation_aliases(type.arg, ctx, resolving);

    if (!func.changed && !arg.changed) {
      return { type, changed: false };
    }

    return {
      type: { tag: "apply", func: func.type, arg: arg.type },
      changed: true,
    };
  }

  if (type.tag === "tuple") {
    let changed = false;
    const items = type.items.map((item) => {
      const expanded = expand_core_annotation_aliases(item, ctx, resolving);

      if (expanded.changed) {
        changed = true;
      }

      return expanded.type;
    });

    if (!changed) {
      return { type, changed: false };
    }

    return { type: { tag: "tuple", items }, changed: true };
  }

  if (
    type.tag === "union" || type.tag === "intersection" ||
    type.tag === "difference"
  ) {
    const left = expand_core_annotation_aliases(type.left, ctx, resolving);
    const right = expand_core_annotation_aliases(type.right, ctx, resolving);

    if (!left.changed && !right.changed) {
      return { type, changed: false };
    }

    return {
      type: { ...type, left: left.type, right: right.type },
      changed: true,
    };
  }

  const param = expand_core_annotation_aliases(type.param, ctx, resolving);
  const result = expand_core_annotation_aliases(type.result, ctx, resolving);

  if (!param.changed && !result.changed) {
    return { type, changed: false };
  }

  return {
    type: { ...type, param: param.type, result: result.type },
    changed: true,
  };
}

export function core_host_import_owner_reason(
  reason: FrontHostImportOwnerReason,
  ctx: CoreFromSourceCtx,
): CoreHostImportOwnerReason {
  if (reason === "bytes") {
    return "text";
  }

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

export function resolve_bound_core_value_name(
  ctx: CoreFromSourceCtx,
  name: string,
): string {
  const resolved = resolve_core_name(ctx, name);

  if (
    ctx.aliases.has(name) || ctx.host_import_names.has(name) ||
    ctx.namedRecs.has(name) || core_builtin_value_names.has(name)
  ) {
    return resolved;
  }

  throw new Error("Unbound core value: " + name);
}

const core_builtin_value_names = new Set([
  "Bool",
  "I32",
  "I64",
  "Int",
  "Bytes",
  "Text",
  "Type",
  "U32",
  "Unit",
  "append",
  "get",
  "len",
  "object_type",
  "panic",
  "rec",
  "runtime_i32_slice",
  "runtime_text_slice",
  "slice",
]);

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
