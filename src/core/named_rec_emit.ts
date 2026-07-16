import { expect } from "../expect.ts";
import type { Func, FuncParam } from "../mod.ts";
import type { ValType } from "../op.ts";
import type { Core as CoreNode, CoreExpr, CoreParam, CoreStmt } from "./ast.ts";
import type {
  CoreArtifactEmitCtx,
  CoreArtifactEmitHooks,
  CoreArtifactEmitInput,
} from "./artifact_emit_contract.ts";
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
  const type_values = named_rec_type_values(core);
  const type_statements = named_rec_type_statements(core);

  for (const name in core.recFunctions) {
    const def = core.recFunctions[name];
    expect(def, "Missing named recursive function: " + name);

    const params = named_rec_func_params(def.params);
    const stmt: CoreStmt = { tag: "expr", expr: def.body };
    const collection_core: CoreNode = {
      tag: "program",
      statements: [
        ...type_statements,
        ...named_rec_param_seed_stmts(def.params, params, type_values),
        stmt,
      ],
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

    const ctx = hooks.create_emit_ctx({
      core_ctx,
      text_layout: input.text_layout,
      closures: input.closures,
      heap: input.heap,
      scratch: input.scratch,
      allocation_permits: input.allocation_permits,
    });

    for (const [type_name, value] of type_values) {
      ctx.statics.set(type_name, value);
    }

    for (const param of def.params) {
      if (param.annotation === "Text" || param.annotation === "Bytes") {
        ctx.text_locals.add(param.name);
      }

      if (!param.annotation) {
        continue;
      }

      const type_value = named_rec_resolved_type_value(
        param.annotation,
        type_values,
        new Set(),
      );

      if (type_value?.tag === "struct_type") {
        ctx.struct_locals.set(param.name, {
          tag: "var",
          name: param.annotation,
        });
      }

      if (type_value?.tag === "union_type") {
        ctx.union_locals.set(param.name, {
          tag: "var",
          name: param.annotation,
        });
      }
    }

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

function named_rec_param_seed_stmts(
  core_params: CoreParam[],
  params: FuncParam[],
  type_values: Map<string, CoreExpr>,
): CoreStmt[] {
  const statements: CoreStmt[] = [];

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const core_param = core_params[index];
    expect(param, "Missing named recursive Wasm parameter " + index);
    expect(core_param, "Missing named recursive Core parameter " + index);
    expect(param.name, "Named recursive function parameter must be named");
    statements.push({
      tag: "bind",
      kind: "let",
      name: param.name,
      is_linear: core_param.is_linear,
      annotation: core_param.annotation,
      value: named_rec_param_seed_value(
        core_param,
        param.type,
        type_values,
        new Set(),
      ),
    });
  }

  return statements;
}

function named_rec_param_seed_value(
  param: CoreParam,
  type: ValType,
  type_values: Map<string, CoreExpr>,
  resolving: Set<string>,
): CoreExpr {
  if (param.annotation === "Text" || param.annotation === "Bytes") {
    return { tag: "text", value: "" };
  }

  if (type === "i64") {
    return { tag: "num", type, value: 0n };
  }

  if (type === "f32") {
    return { tag: "num", type, value: 0 };
  }

  if (type === "v128") {
    return {
      tag: "prim",
      prim: "f32x4.splat",
      args: [{ tag: "num", type: "f32", value: 0 }],
    };
  }

  if (param.annotation && type_values.has(param.annotation)) {
    return named_rec_aggregate_seed_value(
      param.annotation,
      type_values,
      resolving,
    );
  }

  expect(type === "i32", "Cannot seed named recursive parameter: " + type);
  return { tag: "num", type, value: 0 };
}

function named_rec_aggregate_seed_value(
  name: string,
  type_values: Map<string, CoreExpr>,
  resolving: Set<string>,
): CoreExpr {
  expect(!resolving.has(name), "Cannot seed recursive Core type: " + name);
  const value = type_values.get(name);
  expect(value, "Missing named recursive parameter type: " + name);
  const next = new Set(resolving);
  next.add(name);

  if (value.tag === "var" || value.tag === "type_name") {
    return named_rec_type_name_seed_value(value.name, type_values, next);
  }

  if (value.tag === "struct_type") {
    return {
      tag: "struct_value",
      type_expr: { tag: "var", name },
      fields: value.fields.map((field) => {
        return {
          name: field.name,
          value: named_rec_type_name_seed_value(
            field.type_name,
            type_values,
            next,
          ),
        };
      }),
    };
  }

  if (value.tag === "union_type") {
    const union_case = value.cases[0];
    expect(union_case, "Cannot seed empty Core union type: " + name);
    let payload: CoreExpr | undefined;

    if (union_case.type_name !== "Unit") {
      payload = named_rec_type_name_seed_value(
        union_case.type_name,
        type_values,
        next,
      );
    }

    return {
      tag: "union_case",
      name: union_case.name,
      value: payload,
      type_expr: { tag: "var", name },
    };
  }

  throw new Error("Cannot seed named recursive parameter type: " + name);
}

function named_rec_type_name_seed_value(
  name: string,
  type_values: Map<string, CoreExpr>,
  resolving: Set<string>,
): CoreExpr {
  if (name === "Text" || name === "Bytes") {
    return { tag: "text", value: "" };
  }

  if (name === "I64") {
    return { tag: "num", type: "i64", value: 0n };
  }

  if (name === "F32") {
    return { tag: "num", type: "f32", value: 0 };
  }

  if (name === "F32x4") {
    return {
      tag: "prim",
      prim: "f32x4.splat",
      args: [{ tag: "num", type: "f32", value: 0 }],
    };
  }

  if (type_values.has(name)) {
    return named_rec_aggregate_seed_value(name, type_values, resolving);
  }

  return { tag: "num", type: "i32", value: 0 };
}

function named_rec_resolved_type_value(
  name: string,
  type_values: Map<string, CoreExpr>,
  resolving: Set<string>,
): CoreExpr | undefined {
  if (resolving.has(name)) {
    return undefined;
  }

  const value = type_values.get(name);

  if (!value || (value.tag !== "var" && value.tag !== "type_name")) {
    return value;
  }

  const next = new Set(resolving);
  next.add(name);
  return named_rec_resolved_type_value(value.name, type_values, next);
}

function named_rec_type_values(core: CoreNode): Map<string, CoreExpr> {
  const values = new Map<string, CoreExpr>();

  for (const stmt of core.statements) {
    if (stmt.tag === "bind" && stmt.kind === "const") {
      if (
        stmt.value.tag === "struct_type" || stmt.value.tag === "union_type" ||
        stmt.value.tag === "type_name" || stmt.value.tag === "var"
      ) {
        values.set(stmt.name, stmt.value);
      }
    }
  }

  return values;
}

function named_rec_type_statements(core: CoreNode): CoreStmt[] {
  const statements: CoreStmt[] = [];

  for (const stmt of core.statements) {
    if (
      stmt.tag === "bind" && stmt.kind === "const" &&
      (stmt.value.tag === "struct_type" || stmt.value.tag === "union_type" ||
        stmt.value.tag === "type_name" || stmt.value.tag === "var")
    ) {
      statements.push(stmt);
    }
  }

  return statements;
}

function named_rec_func_params(params: CoreParam[]): FuncParam[] {
  const result: FuncParam[] = [];

  for (const param of params) {
    const type = named_rec_param_type(param);
    result.push({ name: param.name, type });
  }

  return result;
}

function named_rec_param_type(param: CoreParam): ValType {
  if (!param.annotation) {
    return "i32";
  }

  const type = core_val_type_from_type_name(param.annotation);

  if (type) {
    return type;
  }

  return "i32";
}
