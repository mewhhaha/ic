import { expect } from "../expect.ts";
import type {
  FrontHostImportResultContract,
  Source as SourceNode,
} from "../frontend/ast.ts";
import type {
  Core,
  CoreExpr,
  CoreHostImport,
  CoreRecFunction,
  CoreStmt,
} from "./ast.ts";
import {
  create_core_from_source_ctx,
  record_core_from_source_type_value,
} from "./from_source/context.ts";
import {
  core_host_import_arg_contract,
  core_host_import_result_contract,
} from "./from_source/host_import.ts";
import { core_stmt } from "./from_source/stmt.ts";

export function core_from_source(source: SourceNode): Core {
  const ctx = create_core_from_source_ctx();
  const host_imports: Record<string, CoreHostImport> = {};
  const statements: CoreStmt[] = [];

  for (const stmt of source.statements) {
    if (stmt.tag === "host_import") {
      ctx.host_import_names.add(stmt.value.name);
      const host_import: CoreHostImport = {
        name: stmt.value.name,
        module: stmt.value.module,
        field: stmt.value.field,
        params: stmt.value.params,
        result: stmt.value.result,
        args: stmt.value.args.map((arg) =>
          core_host_import_arg_contract(arg, ctx)
        ),
        result_owner: core_host_import_result_contract(
          stmt.value.result_owner,
          ctx,
        ),
      };
      const result_type_expr = host_import_result_type_expr(
        stmt.value.result_owner,
      );

      if (result_type_expr) {
        host_import.result_type_expr = result_type_expr;
      }

      host_imports[stmt.value.name] = host_import;
    } else {
      record_core_from_source_type_value(stmt, ctx);
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
    statements,
  };

  const capability_methods = [];

  for (const [table, methods] of ctx.capability_methods) {
    for (const [method, host_import] of methods) {
      if (ctx.dynamic_capability_tables.has(table)) {
        capability_methods.push({
          table,
          method,
          host_import,
          representation: "runtime_aggregate" as const,
        });
      } else {
        capability_methods.push({ table, method, host_import });
      }
    }
  }

  if (capability_methods.length > 0) {
    core.capability_methods = capability_methods;
  }

  if (Object.keys(host_imports).length > 0) {
    core.host_imports = host_imports;
  }

  if (ctx.namedRecs.size > 0) {
    const recs: Record<string, CoreRecFunction> = {};

    for (const [name, value] of ctx.namedRecs) {
      expect(value.body, "Missing named recursive body: " + name);
      recs[name] = { params: value.params, body: value.body };
    }

    core.recFunctions = recs;
  }

  return core;
}

function host_import_result_type_expr(
  contract: FrontHostImportResultContract | undefined,
): CoreExpr | undefined {
  if (!contract || contract.tag === "scalar" || contract.reason === "freeze") {
    return undefined;
  }

  if (typeof contract.reason === "string") {
    return undefined;
  }

  return { tag: "var", name: contract.reason.name };
}
