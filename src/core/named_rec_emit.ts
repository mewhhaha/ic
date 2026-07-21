import { expect } from "../expect.ts";
import type { Func, FuncParam } from "../mod.ts";
import type { Core as CoreNode } from "./ast.ts";
import type {
  CoreArtifactEmitCtx,
  CoreArtifactEmitHooks,
  CoreArtifactEmitInput,
} from "./artifact_emit_contract.ts";
import { create_core_allocation_permit_state } from "./allocation_emission.ts";
import { named_rec_function_core, named_rec_type_values } from "./named_rec.ts";

type NamedRecEmitInput = Omit<
  CoreArtifactEmitInput,
  "core_ctx" | "allocation_permits"
>;

type NamedRecEmitHooks<ctx extends CoreArtifactEmitCtx> = Pick<
  CoreArtifactEmitHooks<ctx>,
  "collect_core_ctx" | "create_emit_ctx" | "emit_stmt" | "stmt_result_type"
>;

export function emit_named_rec_functions<ctx extends CoreArtifactEmitCtx>(
  core: CoreNode,
  input: NamedRecEmitInput,
  hooks: NamedRecEmitHooks<ctx>,
): Func[] {
  if (!core.recFunctions) {
    return [];
  }

  const funcs: Func[] = [];
  const type_values = named_rec_type_values(core);

  for (const name in core.recFunctions) {
    const def = core.recFunctions[name];
    expect(def, "Missing named recursive function: " + name);

    const collection_core = named_rec_function_core(core, def);
    const core_ctx = hooks.collect_core_ctx(collection_core);
    const stmt = def.body_stmt;
    expect(stmt, "Named recursive function has no prepared body: " + name);
    const params: FuncParam[] = [];
    const param_names = new Set<string>();

    for (const param of def.params) {
      const type = core_ctx.locals.get(param.name);
      expect(
        type,
        "Named recursive function parameter has no type: " + param.name,
      );
      params.push({ name: param.name, type });
      param_names.add(param.name);
    }

    let result: ReturnType<NamedRecEmitHooks<ctx>["stmt_result_type"]>;
    try {
      result = hooks.stmt_result_type(stmt, core_ctx);
    } catch (error) {
      throw new Error("Named recursive function result type failed: " + name, {
        cause: error,
      });
    }
    expect(
      def.allocation_permit_plan,
      "Named recursive function requires an allocation permit plan: " + name,
    );
    const allocation_permits = create_core_allocation_permit_state(
      def.allocation_permit_plan,
    );
    input.closures.allocation_permit_states.add(allocation_permits);

    const ctx = hooks.create_emit_ctx({
      core_ctx,
      text_layout: input.text_layout,
      closures: input.closures,
      heap: input.heap,
      scratch: input.scratch,
      allocation_permits,
    });

    for (const [type_name, value] of type_values) {
      ctx.statics.set(type_name, value);
    }

    let emitted_body: string;
    try {
      emitted_body = hooks.emit_stmt(stmt, ctx, true);
    } catch (error) {
      throw new Error("Named recursive function emission failed: " + name, {
        cause: error,
      });
    }
    const body_lines: string[] = [];
    for (const [local, type] of core_ctx.locals) {
      if (!param_names.has(local)) {
        body_lines.push("(local $" + local + " " + type + ")");
      }
    }
    body_lines.push(emitted_body);
    funcs.push({
      name,
      params,
      result,
      body: body_lines.join("\n"),
    });
  }

  return funcs;
}
