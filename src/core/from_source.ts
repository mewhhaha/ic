import type { Source as SourceNode } from "../frontend/ast.ts";
import type { Core, CoreHostImport, CoreStmt } from "./ast.ts";
import {
  create_core_from_source_ctx,
  record_core_from_source_type_value,
} from "./from_source/context.ts";
import {
  core_host_import_arg_contract,
  core_host_import_result_contract,
} from "./from_source/host_import.ts";
import { core_stmt } from "./from_source/stmt.ts";
import type { CoreParam } from "./ast.ts"; // for recFunctions shape

export function core_from_source(source: SourceNode): Core {
  const ctx = create_core_from_source_ctx();
  const host_imports: Record<string, CoreHostImport> = {};
  const statements: CoreStmt[] = [];

  for (const stmt of source.statements) {
    if (stmt.tag === "host_import") {
      ctx.host_import_names.add(stmt.value.name);
      host_imports[stmt.value.name] = {
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
    } else {
      record_core_from_source_type_value(stmt, ctx);
      statements.push(core_stmt(stmt, ctx));
    }
  }

  const core: Core = {
    tag: "program",
    statements,
  };

  if (Object.keys(host_imports).length > 0) {
    core.host_imports = host_imports;
  }

  if (ctx.namedRecs.size > 0) {
    const recs: Record<string, { params: CoreParam[]; body: CoreExpr }> = {};
    for (const [k, v] of ctx.namedRecs) {
      recs[k] = v;
    }
    core.recFunctions = recs;
  }

  return core;
}
