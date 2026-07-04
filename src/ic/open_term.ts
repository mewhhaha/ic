import { emit_expr_with_env, Expr } from "../expr.ts";
import { expect } from "../expect.ts";
import { type FuncParam, Mod, type Mod as ModNode } from "../mod.ts";
import { Prim, type ValType } from "../op.ts";
import { Callable, Data, Emit, Typed } from "../trait.ts";
import { indent, type Wat } from "../wat.ts";
import type { Ic } from "./ast.ts";
import { reduce_ic_graph } from "./graph_reduce.ts";
import { lower_ic_with_env } from "./lower.ts";

export type IcOpenOptions = {
  name?: string;
  params?: Record<string, ValType>;
};

type InferCtx = {
  types: Map<string, ValType>;
  params: string[];
  bound: Set<string>;
};

type FuncInfo = {
  name: string;
  params: string[];
  param_types: Array<ValType | undefined>;
  result: ValType | undefined;
  body: Ic;
};

type RecursiveInferCtx = {
  funcs: Map<string, FuncInfo>;
  types: Map<string, ValType>;
  params: string[];
  bound: Set<string>;
  changed: boolean;
};

type EmitRecursiveCtx = {
  funcs: Map<string, FuncInfo>;
  types: Map<string, ValType>;
  aliases: Map<string, string>;
  locals: Map<string, ValType>;
};

export function ic_open_mod(ic: Ic, options?: IcOpenOptions): ModNode {
  let name = "main";
  let explicit_params: Record<string, ValType> | undefined;

  if (options) {
    if (options.name !== undefined) {
      name = options.name;
    }

    explicit_params = options.params;
  }

  const recursive = try_recursive_open_mod(ic, name, explicit_params);

  if (recursive) {
    return recursive;
  }

  const reduced = reduce_ic_graph(ic);
  const inferred = infer_open_term_params(reduced, explicit_params);
  const expr = lower_ic_with_env(reduced, inferred.types);
  const body = emit_expr_with_env(expr, inferred.types);
  const data = Data.data(Expr, expr);
  const params: FuncParam[] = inferred.params.map((param_name) => {
    const type = inferred.types.get(param_name);

    if (!type) {
      throw new Error("Missing inferred open Ic parameter type: " + param_name);
    }

    return { name: param_name, type };
  });
  const mod: ModNode = {
    funcs: {
      [name]: {
        name,
        params,
        result: Typed.type(Expr, expr),
        body,
      },
    },
    exports: [name],
  };

  if (data.length > 0) {
    mod.memory = {
      name: "memory",
      pages: 1,
      export_name: "memory",
    };
    mod.data = data;
  }

  return mod;
}

export function ic_open_wat(ic: Ic, options?: IcOpenOptions): Wat {
  return Emit.emit(Mod, ic_open_mod(ic, options));
}

function try_recursive_open_mod(
  ic: Ic,
  name: string,
  explicit_params: Record<string, ValType> | undefined,
): ModNode | undefined {
  if (ic.tag !== "fix") {
    return undefined;
  }

  const func = lambda_info(ic.name, ic.expr);

  if (func.name === name) {
    throw new Error(
      "Recursive Ic function name conflicts with exported function: " + name,
    );
  }

  const funcs = new Map<string, FuncInfo>();
  funcs.set(func.name, func);

  const ctx: RecursiveInferCtx = {
    funcs,
    types: new Map(),
    params: [],
    bound: new Set(),
    changed: false,
  };
  ctx.bound.add(func.name);

  for (const param_name of func.params) {
    ctx.bound.add(param_name);
  }

  if (explicit_params) {
    for (const param_name in explicit_params) {
      if (ctx.funcs.has(param_name)) {
        throw new Error(
          "Open Ic parameter conflicts with recursive function: " + param_name,
        );
      }

      const type = explicit_params[param_name];

      if (!type) {
        throw new Error("Missing open Ic parameter type: " + param_name);
      }

      set_recursive_var_type(
        ctx,
        param_name,
        type,
        "$.params." + param_name,
      );
    }
  }

  let main_result: ValType | undefined;

  for (let iteration = 0; iteration < 32; iteration += 1) {
    ctx.changed = false;
    const next_main_result = infer_recursive_type(
      ctx,
      ic.body,
      main_result,
      "$.body",
    );

    if (next_main_result !== undefined) {
      if (main_result === undefined) {
        main_result = next_main_result;
        ctx.changed = true;
      } else {
        expect_type(next_main_result, main_result, "$.body");
      }
    }

    infer_recursive_func(ctx, func, "$.fix." + func.name);

    if (!ctx.changed) {
      break;
    }
  }

  main_result = require_type(
    main_result,
    "Cannot infer recursive Ic main result type",
  );

  for (let index = 0; index < func.params.length; index += 1) {
    const param_name = func.params[index];
    expect(param_name, "Missing recursive Ic function parameter name");
    func.param_types[index] = require_type(
      func.param_types[index],
      "Cannot infer recursive Ic function parameter type: " + param_name,
    );
  }

  func.result = require_type(
    func.result,
    "Cannot infer recursive Ic function result type: " + func.name,
  );

  const mod_funcs: Record<string, ModNode["funcs"][string]> = {};
  mod_funcs[func.name] = {
    name: func.name,
    params: recursive_func_params(func),
    result: func.result,
    body: emit_recursive_func_body(func, ctx.types, funcs),
  };
  mod_funcs[name] = {
    name,
    params: recursive_main_params(ctx),
    result: main_result,
    body: emit_recursive_main_body(ic.body, ctx.types, funcs),
  };

  return {
    funcs: mod_funcs,
    exports: [name],
  };
}

function lambda_info(name: string, expr: Ic): FuncInfo {
  const params: string[] = [];
  const param_types: Array<ValType | undefined> = [];
  let cursor = expr;

  while (cursor.tag === "lam") {
    params.push(cursor.name);
    param_types.push(undefined);
    cursor = cursor.body;
  }

  if (params.length === 0) {
    throw new Error("Recursive Ic binding must be a lambda: " + name);
  }

  return {
    name,
    params,
    param_types,
    result: undefined,
    body: cursor,
  };
}

function infer_recursive_func(
  ctx: RecursiveInferCtx,
  func: FuncInfo,
  path: string,
): void {
  for (const param_name of func.params) {
    ctx.bound.add(param_name);
  }

  const body_type = infer_recursive_type(
    ctx,
    func.body,
    func.result,
    path + ".body",
  );

  if (body_type !== undefined) {
    set_func_result_type(ctx, func, body_type, path + ".body");
  }

  for (let index = 0; index < func.params.length; index += 1) {
    const param_name = func.params[index];
    expect(param_name, path + ": Missing function parameter");
    const type = ctx.types.get(param_name);

    if (type !== undefined) {
      set_func_param_type(ctx, func, index, type, path + ".params");
    }
  }
}

function infer_recursive_type(
  ctx: RecursiveInferCtx,
  ic: Ic,
  expected: ValType | undefined,
  path: string,
): ValType | undefined {
  switch (ic.tag) {
    case "num":
      return expect_type(ic.type, expected, path);

    case "text":
      throw new Error("Cannot lower text literal in recursive Ic WAT");

    case "var": {
      if (ctx.funcs.has(ic.name)) {
        throw new Error(
          path + ": Cannot use recursive Ic function as a value: " + ic.name,
        );
      }

      const current = ctx.types.get(ic.name);

      if (expected !== undefined) {
        set_recursive_var_type(ctx, ic.name, expected, path);
        return expected;
      }

      if (current !== undefined) {
        return current;
      }

      return undefined;
    }

    case "prim": {
      if (is_memory_prim(ic.prim)) {
        throw new Error(
          path + ": Cannot lower memory primitive in recursive Ic WAT: " +
            ic.prim,
        );
      }

      const prim_type = Callable.type(Prim, ic.prim);
      const expected_arity = Callable.arity(Prim, ic.prim);

      if (ic.args.length !== expected_arity) {
        throw new Error(
          path + ": Primitive " + ic.prim + " expects " + expected_arity +
            " arguments",
        );
      }

      for (let index = 0; index < ic.args.length; index += 1) {
        const arg = ic.args[index];
        const arg_type = prim_type.args[index];

        expect(arg, path + ": Missing primitive argument " + index);
        expect(arg_type, path + ": Missing primitive argument type " + index);
        infer_recursive_type(
          ctx,
          arg,
          arg_type,
          path + ".args[" + index.toString() + "]",
        );
      }

      return expect_type(prim_type.result, expected, path);
    }

    case "dup":
      return infer_recursive_dup_type(ctx, ic, expected, path);

    case "app":
      return infer_recursive_app_type(ctx, ic, expected, path);

    case "era":
      return infer_recursive_type(ctx, ic.body, expected, path + ".body");

    case "lam":
      throw new Error("Cannot lower nested lambda in recursive Ic WAT");

    case "sup":
      throw new Error("Cannot lower superposition in recursive Ic WAT");

    case "fix":
      throw new Error("Cannot lower nested fixpoint in recursive Ic WAT");
  }
}

function infer_recursive_app_type(
  ctx: RecursiveInferCtx,
  ic: Extract<Ic, { tag: "app" }>,
  expected: ValType | undefined,
  path: string,
): ValType | undefined {
  const app = collect_app(ic);

  if (app.func.tag !== "var") {
    throw new Error(
      path + ": Cannot lower non-symbolic call in recursive Ic WAT",
    );
  }

  const func = ctx.funcs.get(app.func.name);

  if (!func) {
    throw new Error(
      path + ": Cannot lower unknown call in recursive Ic WAT: " +
        app.func.name,
    );
  }

  if (app.args.length !== func.params.length) {
    throw new Error(
      path + ": Recursive Ic function " + func.name + " expects " +
        func.params.length.toString() + " arguments",
    );
  }

  for (let index = 0; index < app.args.length; index += 1) {
    const arg = app.args[index];
    const expected_arg = func.param_types[index];
    expect(arg, path + ": Missing call argument " + index);
    const arg_type = infer_recursive_type(
      ctx,
      arg,
      expected_arg,
      path + ".args[" + index.toString() + "]",
    );

    if (arg_type !== undefined) {
      set_func_param_type(ctx, func, index, arg_type, path);
    }
  }

  if (expected !== undefined) {
    set_func_result_type(ctx, func, expected, path);
    return expected;
  }

  if (func.result !== undefined) {
    return func.result;
  }

  return undefined;
}

function infer_recursive_dup_type(
  ctx: RecursiveInferCtx,
  ic: Extract<Ic, { tag: "dup" }>,
  expected: ValType | undefined,
  path: string,
): ValType | undefined {
  const left_name = ic.name + "0";
  const right_name = ic.name + "1";
  ctx.bound.add(left_name);
  ctx.bound.add(right_name);
  const body_type = infer_recursive_type(
    ctx,
    ic.body,
    expected,
    path + ".body",
  );
  const left_type = ctx.types.get(left_name);
  const right_type = ctx.types.get(right_name);
  let value_type = left_type;

  if (value_type === undefined) {
    value_type = right_type;
  }

  if (left_type !== undefined && right_type !== undefined) {
    if (left_type !== right_type) {
      throw new Error(
        path + ": Dup projections for " + ic.name + " have different types",
      );
    }
  }

  const expr_type = infer_recursive_type(
    ctx,
    ic.expr,
    value_type,
    path + ".expr",
  );

  if (value_type === undefined) {
    value_type = expr_type;
  }

  if (value_type !== undefined) {
    set_recursive_var_type(ctx, left_name, value_type, path + ".left");
    set_recursive_var_type(ctx, right_name, value_type, path + ".right");
  }

  return body_type;
}

function set_recursive_var_type(
  ctx: RecursiveInferCtx,
  name: string,
  type: ValType,
  path: string,
): void {
  const previous = ctx.types.get(name);

  if (previous !== undefined) {
    if (previous !== type) {
      throw new Error(
        path + ": Recursive Ic variable " + name + " inferred as both " +
          previous + " and " + type,
      );
    }

    return;
  }

  ctx.types.set(name, type);
  ctx.changed = true;

  if (!ctx.bound.has(name)) {
    ctx.params.push(name);
  }
}

function set_func_param_type(
  ctx: RecursiveInferCtx,
  func: FuncInfo,
  index: number,
  type: ValType,
  path: string,
): void {
  const current = func.param_types[index];

  if (current !== undefined) {
    if (current !== type) {
      throw new Error(
        path + ": Recursive Ic function " + func.name + " parameter " +
          index.toString() + " inferred as both " + current + " and " + type,
      );
    }

    return;
  }

  func.param_types[index] = type;
  ctx.changed = true;
}

function set_func_result_type(
  ctx: RecursiveInferCtx,
  func: FuncInfo,
  type: ValType,
  path: string,
): void {
  if (func.result !== undefined) {
    if (func.result !== type) {
      throw new Error(
        path + ": Recursive Ic function " + func.name +
          " result inferred as both " + func.result + " and " + type,
      );
    }

    return;
  }

  func.result = type;
  ctx.changed = true;
}

function recursive_func_params(func: FuncInfo): FuncParam[] {
  const params: FuncParam[] = [];

  for (let index = 0; index < func.params.length; index += 1) {
    const name = func.params[index];
    expect(name, "Missing recursive Ic function parameter name");
    const type = require_type(
      func.param_types[index],
      "Missing recursive Ic function parameter type: " + name,
    );
    params.push({ name, type });
  }

  return params;
}

function recursive_main_params(ctx: RecursiveInferCtx): FuncParam[] {
  const params: FuncParam[] = [];

  for (const name of ctx.params) {
    const type = require_type(
      ctx.types.get(name),
      "Missing recursive Ic main parameter type: " + name,
    );
    params.push({ name, type });
  }

  return params;
}

function emit_recursive_func_body(
  func: FuncInfo,
  types: Map<string, ValType>,
  funcs: Map<string, FuncInfo>,
): Wat {
  const ctx: EmitRecursiveCtx = {
    funcs,
    types,
    aliases: new Map(),
    locals: new Map(),
  };
  const body = emit_recursive_ic(ctx, func.body);
  return with_local_decls(body, ctx.locals, func.params);
}

function emit_recursive_main_body(
  body_ic: Ic,
  types: Map<string, ValType>,
  funcs: Map<string, FuncInfo>,
): Wat {
  const ctx: EmitRecursiveCtx = {
    funcs,
    types,
    aliases: new Map(),
    locals: new Map(),
  };
  const body = emit_recursive_ic(ctx, body_ic);
  return with_local_decls(body, ctx.locals, []);
}

function with_local_decls(
  body: Wat,
  locals: Map<string, ValType>,
  params: string[],
): Wat {
  const lines: string[] = [];

  for (const [name, type] of locals) {
    if (!params.includes(name)) {
      lines.push("(local $" + name + " " + type + ")");
    }
  }

  lines.push(body);
  return lines.join("\n");
}

function emit_recursive_ic(ctx: EmitRecursiveCtx, ic: Ic): Wat {
  switch (ic.tag) {
    case "num":
      return ic.type + ".const " + ic.value.toString();

    case "var":
      return "local.get $" + resolved_name(ctx, ic.name);

    case "prim":
      return emit_recursive_prim(ctx, ic);

    case "app":
      return emit_recursive_app(ctx, ic);

    case "dup":
      return emit_recursive_dup(ctx, ic);

    case "era":
      return emit_recursive_ic(ctx, ic.body);

    case "text":
      throw new Error("Cannot lower text literal in recursive Ic WAT");

    case "lam":
      throw new Error("Cannot lower nested lambda in recursive Ic WAT");

    case "sup":
      throw new Error("Cannot lower superposition in recursive Ic WAT");

    case "fix":
      throw new Error("Cannot lower nested fixpoint in recursive Ic WAT");
  }
}

function emit_recursive_prim(
  ctx: EmitRecursiveCtx,
  ic: Extract<Ic, { tag: "prim" }>,
): Wat {
  if (is_memory_prim(ic.prim)) {
    throw new Error(
      "Cannot lower memory primitive in recursive Ic WAT: " + ic.prim,
    );
  }

  const expected_arity = Callable.arity(Prim, ic.prim);

  if (ic.args.length !== expected_arity) {
    throw new Error(
      "Primitive " + ic.prim + " expects " + expected_arity + " arguments",
    );
  }

  if (is_select_prim(ic.prim)) {
    const then_expr = ic.args[0];
    const else_expr = ic.args[1];
    const cond_expr = ic.args[2];
    expect(then_expr, "Missing select then branch");
    expect(else_expr, "Missing select else branch");
    expect(cond_expr, "Missing select condition");
    const prim_type = Callable.type(Prim, ic.prim);

    return [
      emit_recursive_ic(ctx, cond_expr),
      "if (result " + prim_type.result + ")",
      indent(emit_recursive_ic(ctx, then_expr), 2),
      "else",
      indent(emit_recursive_ic(ctx, else_expr), 2),
      "end",
    ].join("\n");
  }

  const lines: string[] = [];

  for (const arg of ic.args) {
    lines.push(emit_recursive_ic(ctx, arg));
  }

  lines.push(Emit.emit(Prim, ic.prim));
  return lines.join("\n");
}

function emit_recursive_app(
  ctx: EmitRecursiveCtx,
  ic: Extract<Ic, { tag: "app" }>,
): Wat {
  const app = collect_app(ic);

  if (app.func.tag !== "var") {
    throw new Error("Cannot lower non-symbolic call in recursive Ic WAT");
  }

  const func = ctx.funcs.get(app.func.name);

  if (!func) {
    throw new Error(
      "Cannot lower unknown call in recursive Ic WAT: " + app.func.name,
    );
  }

  if (app.args.length !== func.params.length) {
    throw new Error(
      "Recursive Ic function " + func.name + " expects " +
        func.params.length.toString() + " arguments",
    );
  }

  const lines: string[] = [];

  for (const arg of app.args) {
    lines.push(emit_recursive_ic(ctx, arg));
  }

  lines.push("call $" + func.name);
  return lines.join("\n");
}

function emit_recursive_dup(
  ctx: EmitRecursiveCtx,
  ic: Extract<Ic, { tag: "dup" }>,
): Wat {
  const value_type = dup_value_type(ctx, ic);
  set_emit_local(ctx, ic.name, value_type);

  const left_name = ic.name + "0";
  const right_name = ic.name + "1";
  const had_left = ctx.aliases.has(left_name);
  const previous_left = ctx.aliases.get(left_name);
  const had_right = ctx.aliases.has(right_name);
  const previous_right = ctx.aliases.get(right_name);
  const expr = emit_recursive_ic(ctx, ic.expr);
  ctx.aliases.set(left_name, ic.name);
  ctx.aliases.set(right_name, ic.name);
  const body = emit_recursive_ic(ctx, ic.body);
  restore_alias(ctx, left_name, had_left, previous_left);
  restore_alias(ctx, right_name, had_right, previous_right);

  return [
    expr,
    "local.set $" + ic.name,
    body,
  ].join("\n");
}

function dup_value_type(
  ctx: EmitRecursiveCtx,
  ic: Extract<Ic, { tag: "dup" }>,
): ValType {
  const left_name = ic.name + "0";
  const right_name = ic.name + "1";
  const left_type = ctx.types.get(left_name);
  const right_type = ctx.types.get(right_name);
  let value_type = left_type;

  if (value_type === undefined) {
    value_type = right_type;
  }

  if (left_type !== undefined && right_type !== undefined) {
    if (left_type !== right_type) {
      throw new Error(
        "Dup projections for " + ic.name + " have different types",
      );
    }
  }

  return require_type(
    value_type,
    "Cannot infer recursive Ic dup value type: " + ic.name,
  );
}

function set_emit_local(
  ctx: EmitRecursiveCtx,
  name: string,
  type: ValType,
): void {
  const previous = ctx.locals.get(name);

  if (previous !== undefined) {
    if (previous !== type) {
      throw new Error(
        "Recursive Ic local " + name + " inferred as both " + previous +
          " and " + type,
      );
    }

    return;
  }

  ctx.locals.set(name, type);
}

function resolved_name(ctx: EmitRecursiveCtx, name: string): string {
  const alias = ctx.aliases.get(name);

  if (alias !== undefined) {
    return alias;
  }

  return name;
}

function restore_alias(
  ctx: EmitRecursiveCtx,
  name: string,
  had_alias: boolean,
  previous: string | undefined,
): void {
  if (had_alias) {
    expect(previous !== undefined, "Missing previous alias for " + name);
    ctx.aliases.set(name, previous);
    return;
  }

  ctx.aliases.delete(name);
}

function collect_app(ic: Ic): { func: Ic; args: Ic[] } {
  const args: Ic[] = [];
  let cursor = ic;

  while (cursor.tag === "app") {
    args.unshift(cursor.arg);
    cursor = cursor.func;
  }

  return { func: cursor, args };
}

function is_select_prim(prim: Prim): boolean {
  if (prim === "i32.select") {
    return true;
  }

  if (prim === "i64.select") {
    return true;
  }

  return false;
}

function is_memory_prim(prim: Prim): boolean {
  if (prim === "i32.load") {
    return true;
  }

  if (prim === "i64.load") {
    return true;
  }

  if (prim === "i32.load8_u") {
    return true;
  }

  if (prim === "i64.load8_u") {
    return true;
  }

  return false;
}

function require_type(
  type: ValType | undefined,
  message: string,
): ValType {
  expect(type !== undefined, message);
  return type;
}

function infer_open_term_params(
  ic: Ic,
  explicit_params: Record<string, ValType> | undefined,
): { types: Map<string, ValType>; params: string[] } {
  const ctx: InferCtx = {
    types: new Map(),
    params: [],
    bound: new Set(),
  };

  if (explicit_params) {
    for (const name in explicit_params) {
      const type = explicit_params[name];

      if (!type) {
        throw new Error("Missing open Ic parameter type: " + name);
      }

      set_var_type(ctx, name, type, "$.params." + name);
    }
  }

  infer_type(ctx, ic, undefined, "$");
  return { types: ctx.types, params: ctx.params };
}

function set_var_type(
  ctx: InferCtx,
  name: string,
  type: ValType,
  path: string,
): void {
  const previous = ctx.types.get(name);

  if (previous !== undefined) {
    if (previous !== type) {
      throw new Error(
        path + ": Open Ic variable " + name + " inferred as both " +
          previous + " and " + type,
      );
    }

    return;
  }

  ctx.types.set(name, type);

  if (!ctx.bound.has(name)) {
    ctx.params.push(name);
  }
}

function expect_type(
  actual: ValType,
  expected: ValType | undefined,
  path: string,
): ValType {
  if (expected !== undefined && actual !== expected) {
    throw new Error(
      path + ": Expected " + expected + ", got " + actual,
    );
  }

  return actual;
}

function infer_type(
  ctx: InferCtx,
  ic: Ic,
  expected: ValType | undefined,
  path: string,
): ValType {
  switch (ic.tag) {
    case "num":
      return expect_type(ic.type, expected, path);

    case "text":
      return expect_type("i32", expected, path);

    case "var": {
      const current = ctx.types.get(ic.name);

      if (expected !== undefined) {
        set_var_type(ctx, ic.name, expected, path);
        return expected;
      }

      if (current !== undefined) {
        return current;
      }

      throw new Error("Cannot infer open Ic variable type: " + ic.name);
    }

    case "prim": {
      const prim_type = Callable.type(Prim, ic.prim);
      const expected_arity = Callable.arity(Prim, ic.prim);

      if (ic.args.length !== expected_arity) {
        throw new Error(
          path + ": Primitive " + ic.prim + " expects " + expected_arity +
            " arguments",
        );
      }

      for (let index = 0; index < ic.args.length; index += 1) {
        const arg = ic.args[index];
        const arg_type = prim_type.args[index];

        if (!arg) {
          throw new Error(path + ": Missing primitive argument " + index);
        }

        if (!arg_type) {
          throw new Error(path + ": Missing primitive argument type " + index);
        }

        infer_type(
          ctx,
          arg,
          arg_type,
          path + ".args[" + index.toString() + "]",
        );
      }

      return expect_type(prim_type.result, expected, path);
    }

    case "dup":
      return infer_dup_type(ctx, ic, expected, path);

    case "lam":
      throw new Error("Cannot bridge unreduced Ic lambda to open-term Wasm");

    case "app":
      throw new Error(
        "Cannot bridge unreduced Ic application to open-term Wasm",
      );

    case "sup":
      throw new Error(
        "Cannot bridge unreduced Ic superposition to open-term Wasm",
      );

    case "era":
      throw new Error("Cannot bridge unreduced Ic erasure to open-term Wasm");

    case "fix":
      throw new Error(
        "Cannot bridge unreduced Ic recursive binding to open-term Wasm",
      );
  }
}

function infer_dup_type(
  ctx: InferCtx,
  ic: Extract<Ic, { tag: "dup" }>,
  expected: ValType | undefined,
  path: string,
): ValType {
  const left_name = ic.name + "0";
  const right_name = ic.name + "1";
  ctx.bound.add(left_name);
  ctx.bound.add(right_name);
  const body_type = infer_type(ctx, ic.body, expected, path + ".body");
  const left_type = ctx.types.get(left_name);
  const right_type = ctx.types.get(right_name);
  let value_type = left_type;

  if (value_type === undefined) {
    value_type = right_type;
  }

  if (left_type !== undefined && right_type !== undefined) {
    if (left_type !== right_type) {
      throw new Error(
        path + ": Dup projections for " + ic.name + " have different types",
      );
    }
  }

  infer_type(ctx, ic.expr, value_type, path + ".expr");
  return body_type;
}
