import { expect } from "../expect.ts";
import type { Source as SourceNode } from "../frontend/ast.ts";

export type { Source as CoreSource } from "../frontend/ast.ts";
import type { Core, CoreRecFunction, CoreStmt } from "./ast.ts";
import {
  create_core_from_source_ctx,
  record_core_from_source_type_value,
} from "./from_source/context.ts";
import { core_stmt } from "./from_source/stmt.ts";
import { is_builtin_type_name } from "../frontend/types.ts";
import { integer_type_name } from "../integer.ts";

export function core_from_source(source: SourceNode): Core {
  const ctx = create_core_from_source_ctx(core_stmt);
  const host_imports: string[] = [];
  const statements: CoreStmt[] = [];

  // Effect elaboration places generated host imports before source bindings.
  // Gather global compile-time type values first so rich import contracts can
  // resolve their struct and union ownership reasons independent of order.
  for (const stmt of source.statements) {
    record_core_from_source_type_value(stmt, ctx);
  }

  for (const stmt of source.statements) {
    if (stmt.tag === "host_import") {
      ctx.host_import_names.add(stmt.value.name);
      host_imports.push(stmt.value.name);
    } else {
      record_core_from_source_type_value(stmt, ctx);

      if (
        stmt.tag === "bind" && stmt.kind === "const" &&
        (ctx.type_set_aliases.has(stmt.name) ||
          ctx.scalar_annotation_aliases.has(stmt.name))
      ) {
        continue;
      }

      if (
        stmt.tag === "bind" && stmt.kind === "const" &&
        source_type_namespace_binding(stmt.value)
      ) {
        continue;
      }

      const lowered = core_stmt(stmt, ctx);

      if (
        lowered.tag !== "bind" ||
        !ctx.capability_methods.has(lowered.name) ||
        ctx.dynamic_capability_tables.has(lowered.name)
      ) {
        statements.push(lowered);
      }
    }
  }

  const core: Core = {
    tag: "program",
    statements: [
      ...wide_integer_type_statements(ctx.wide_integer_types),
      ...statements,
    ],
  };

  if (host_imports.length > 0) {
    core.host_imports = host_imports;
  }

  if (ctx.namedRecs.size > 0) {
    const recs: Record<string, CoreRecFunction> = {};

    for (const [name, value] of ctx.namedRecs) {
      expect(value.body, "Missing named recursive body: " + name);
      recs[name] = {
        params: value.params,
        body: value.body,
        result_annotation: value.result_annotation,
      };
    }

    core.recFunctions = recs;
  }

  return core;
}

function wide_integer_type_statements(
  types: Map<string, import("../integer.ts").IntegerType>,
): CoreStmt[] {
  const statements: CoreStmt[] = [];
  const ordered = [...types.values()].sort((left, right) => {
    if (left.width !== right.width) {
      return left.width - right.width;
    }

    if (left.signed === right.signed) {
      return 0;
    }

    if (left.signed) {
      return -1;
    }

    return 1;
  });

  for (const integer of ordered) {
    const fields = [];
    const limb_count = Math.ceil(integer.width / 32);

    for (let index = 0; index < limb_count; index += 1) {
      fields.push({ name: "limb_" + index.toString(), type_name: "U32" });
    }

    statements.push({
      tag: "bind",
      kind: "const",
      name: integer_type_name(integer),
      is_linear: false,
      annotation: undefined,
      value: { tag: "struct_type", fields },
    });
  }

  return statements;
}

function source_type_namespace_binding(
  value: import("../frontend/ast.ts").FrontExpr,
): boolean {
  if (value.tag !== "with") {
    return false;
  }

  let base = value.base;

  while (base.tag === "with") {
    base = base.base;
  }

  return (base.tag === "var" || base.tag === "type_name") &&
    is_builtin_type_name(base.name);
}
