import type {
  FrontExpr,
  FrontHostImportOwnerReason,
  Stmt,
  TypeExpr,
} from "../../frontend/ast.ts";
import { format_type_expr, parse_type_expr } from "../../frontend/type_expr.ts";
import { tokenize } from "../../frontend/tokenize.ts";
import type {
  CoreExpr,
  CoreHostImportOwnerReason,
  CoreParam,
  CoreStmt,
} from "../ast.ts";
import type { IntegerType } from "../../integer.ts";
import { integer_type_from_name, integer_type_name } from "../../integer.ts";
import type { ValType } from "../../op.ts";

export type CoreNamedRecSource = {
  params: CoreParam[];
  body: CoreExpr | undefined;
  result_annotation: string | undefined;
};

export type CoreFromSourceCtx = {
  aliases: Map<string, string>;
  capability_methods: Map<string, Map<string, string>>;
  dynamic_capability_tables: Set<string>;
  host_import_const_names: Set<string>;
  host_import_names: Set<string>;
  host_import_type_values: Map<string, CoreHostImportOwnerReason>;
  linear_names: Set<string>;
  integer_types: Map<string, IntegerType>;
  numeric_types: Map<string, ValType>;
  wide_integer_types: Map<string, IntegerType>;
  lower_stmt: (stmt: Stmt, ctx: CoreFromSourceCtx) => CoreStmt;
  fresh: { next: number };
  namedRecs: Map<string, CoreNamedRecSource>;
  runtime_aggregate_type_names: Set<string>;
  scalar_annotation_aliases: Map<string, string>;
  type_set_aliases: Map<string, TypeExpr>;
};

export function create_core_from_source_ctx(
  lower_stmt: (stmt: Stmt, ctx: CoreFromSourceCtx) => CoreStmt,
): CoreFromSourceCtx {
  return {
    aliases: new Map(),
    capability_methods: new Map(),
    dynamic_capability_tables: new Set(),
    host_import_const_names: new Set(),
    host_import_names: new Set(),
    host_import_type_values: new Map(),
    linear_names: new Set(),
    integer_types: new Map(),
    numeric_types: new Map(),
    wide_integer_types: new Map(),
    lower_stmt,
    fresh: { next: 0 },
    namedRecs: new Map(),
    runtime_aggregate_type_names: new Set(),
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
    integer_types: new Map(ctx.integer_types),
    numeric_types: new Map(ctx.numeric_types),
    wide_integer_types: ctx.wide_integer_types,
    lower_stmt: ctx.lower_stmt,
    fresh: ctx.fresh,
    namedRecs: ctx.namedRecs,
    runtime_aggregate_type_names: new Set(ctx.runtime_aggregate_type_names),
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

  if (
    stmt.value.tag === "struct_type" || stmt.value.tag === "union_type"
  ) {
    ctx.runtime_aggregate_type_names.add(stmt.name);
  } else if (
    stmt.value.tag === "var" &&
    ctx.runtime_aggregate_type_names.has(stmt.value.name)
  ) {
    ctx.runtime_aggregate_type_names.add(stmt.name);
  }

  const scalar_base_name = core_scalar_type_value_base(stmt.value);

  if (scalar_base_name) {
    const integer = integer_type_from_name(scalar_base_name);

    if (integer && integer.width > 64) {
      ctx.wide_integer_types.set(integer_type_name(integer), integer);
    }

    let scalar_annotation = ctx.scalar_annotation_aliases.get(
      scalar_base_name,
    );

    if (
      !scalar_annotation &&
      (core_builtin_scalar_annotation_names.has(scalar_base_name) ||
        /^([IU])([1-9][0-9]*)$/.test(scalar_base_name))
    ) {
      scalar_annotation = scalar_base_name;
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

function core_scalar_type_value_base(expr: FrontExpr): string | undefined {
  if (expr.tag === "var" || expr.tag === "type_name") {
    return expr.name;
  }

  if (expr.tag === "with") {
    return core_scalar_type_value_base(expr.base);
  }

  return undefined;
}

const core_builtin_scalar_annotation_names = new Set([
  "Bool",
  "Char",
  "I32",
  "I64",
  "F32",
  "F64",
  "F32x4",
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

  if (type.tag === "product") {
    let changed = false;
    const entries = type.entries.map((entry) => {
      const expanded = expand_core_annotation_aliases(
        entry.type_expr,
        ctx,
        resolving,
      );

      if (expanded.changed) {
        changed = true;
      }

      return { ...entry, type_expr: expanded.type };
    });

    if (!changed) {
      return { type, changed: false };
    }

    return { type: { tag: "product", entries }, changed: true };
  }

  if (type.tag === "array") {
    const element = expand_core_annotation_aliases(
      type.element,
      ctx,
      resolving,
    );

    if (!element.changed) {
      return { type, changed: false };
    }

    return { type: { ...type, element: element.type }, changed: true };
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

  if (type.tag === "forall") {
    const body = expand_core_annotation_aliases(type.body, ctx, resolving);

    if (!body.changed) {
      return { type, changed: false };
    }

    return { type: { ...type, body: body.type }, changed: true };
  }

  if (type.tag === "literal") {
    return { type, changed: false };
  }

  if (type.tag !== "arrow") {
    const unreachable: never = type;
    void unreachable;
    throw new Error("Unknown core annotation type expression");
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
  "Char",
  "@Bytes.generate",
  "@Utf8.decode",
  "@Utf8.encode",
  "I32",
  "I64",
  "F32",
  "F64",
  "Int",
  "Bytes",
  "Text",
  "Type",
  "U32",
  "Unit",
  "@append",
  "@get",
  "@format_i32",
  "@format_i64",
  "@format_f32",
  "@len",
  "object_type",
  "@panic",
  "rec",
  "@runtime_i32_slice",
  "@runtime_text_slice",
  "@slice",
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

    case "with":
      return front_host_import_type_value_reason(expr.base, ctx, seen);

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
