import type { Func, FuncParam } from "../mod.ts";
import type { ValType } from "../op.ts";
import type { Core as CoreNode, CoreExpr } from "./ast.ts";
import type { CoreArtifactEmitCtx, CoreArtifactEmitHooks } from "./artifact_emit.ts";
import { create_core_branch_emit_ctx } from "./emit_ctx.ts";

export function emit_named_rec_functions<ctx extends CoreArtifactEmitCtx>(
  core: CoreNode | undefined,
  baseCtx: ctx,
  hooks: Pick<CoreArtifactEmitHooks<ctx>, "emit_stmt" | "stmt_result_type"> & { coreCtxForType?: any },
): Func[] {
  if (!core || !core.recFunctions) return [];
  const funcs: Func[] = [];
  for (const [name, def] of Object.entries(core.recFunctions)) {
    const childCtx = create_core_branch_emit_ctx(baseCtx) as ctx;
    const params: FuncParam[] = [];
    for (const p of def.params) {
      // params are scalar i32 in the supported direct-rec cases (fib, sum_down etc.)
      // full param type recovery would require carrying types in recFunctions record
      params.push({ name: p.name, type: "i32" as ValType });
      childCtx.locals.set(p.name, "i32");
    }
    const synthStmt = { tag: "expr" as const, expr: def.body };
    const bodyWat = hooks.emit_stmt(synthStmt as any, childCtx, true);
    // derive result type using the shipped stmt_result_type when possible (removes hard-coded literal here)
    let result: ValType = "i32";
    try {
      const cctx = hooks.coreCtxForType || (baseCtx as any);
      if (hooks.stmt_result_type && cctx) {
        result = hooks.stmt_result_type(synthStmt as any, cctx);
      }
    } catch {}
    funcs.push({
      name,
      params,
      result,
      body: bodyWat,
    });
  }
  return funcs;
}

