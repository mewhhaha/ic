import { expect } from "../expect.ts";
import type { Func, FuncParam } from "../mod.ts";
import type { ValType } from "../op.ts";
import type { Core as CoreNode, CoreParam, CoreStmt } from "./ast.ts";
import type {
  CoreArtifactEmitCtx,
  CoreArtifactEmitHooks,
  CoreArtifactEmitInput,
} from "./artifact_emit.ts";
import { core_val_type_from_type_name } from "./type_static.ts";

type NamedRecEmitInput = Omit<CoreArtifactEmitInput, "core_ctx">;

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

  for (const name in core.recFunctions) {
    const def = core.recFunctions[name];
    expect(def, "Missing named recursive function: " + name);

    const params = named_rec_func_params(name, def.params);
    const stmt: CoreStmt = { tag: "expr", expr: def.body };
    const collection_core: CoreNode = {
      tag: "program",
      statements: [...named_rec_param_seed_stmts(params), stmt],
    };

    if (core.host_imports) {
      collection_core.host_imports = core.host_imports;
    }

    const core_ctx = hooks.collect_core_ctx(collection_core);
    const param_names = new Set<string>();

    for (const param of params) {
      expect(param.name, "Named recursive function parameter must be named");
      param_names.add(param.name);
      core_ctx.locals.set(param.name, param.type);
    }

    const result = hooks.stmt_result_type(stmt, core_ctx);
    expect(
      result === "i32",
      "Named recursive Core functions only support i32 results for now: " +
        name,
    );

    const ctx = hooks.create_emit_ctx({
      core_ctx,
      text_layout: input.text_layout,
      closures: input.closures,
      heap: input.heap,
      scratch: input.scratch,
    });
    const body_lines: string[] = [];

    for (const [local, type] of core_ctx.locals) {
      if (!param_names.has(local)) {
        body_lines.push("(local $" + local + " " + type + ")");
      }
    }

    body_lines.push(hooks.emit_stmt(stmt, ctx, true));
    funcs.push({
      name,
      params,
      result,
      body: body_lines.join("\n"),
    });
  }

  return funcs;
}

function named_rec_param_seed_stmts(params: FuncParam[]): CoreStmt[] {
  const statements: CoreStmt[] = [];

  for (const param of params) {
    expect(param.name, "Named recursive function parameter must be named");
    statements.push({
      tag: "bind",
      kind: "let",
      name: param.name,
      is_linear: false,
      annotation: undefined,
      value: { tag: "num", type: param.type, value: 0 },
    });
  }

  return statements;
}

function named_rec_func_params(name: string, params: CoreParam[]): FuncParam[] {
  const result: FuncParam[] = [];

  for (const param of params) {
    const type = named_rec_param_type(param);
    expect(
      type === "i32",
      "Named recursive Core function " + name +
        " only supports i32 params for now: " + param.name,
    );
    result.push({ name: param.name, type });
  }

  return result;
}

function named_rec_param_type(param: CoreParam): ValType {
  if (!param.annotation) {
    return "i32";
  }

  const type = core_val_type_from_type_name(param.annotation);
  expect(
    type,
    "Cannot emit named recursive parameter annotation: " + param.annotation,
  );
  return type;
}
