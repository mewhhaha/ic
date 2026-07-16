import {
  buildFunctionalSurfaceModule,
  compileFunctionalModuleToWasm,
  type EncodedFunctionalModule,
  FunctionalBinaryOperator,
  type FunctionalCompileResult,
  type FunctionalSurfaceExpression,
  GpuFunctionalCompiler,
  type GpuFunctionalModule,
  requestWebGpuDevice,
  surface,
} from "../../../gpufuck/functional.ts";
import { Source } from "../../src/frontend.ts";
import type { FrontExpr, Param, Stmt } from "../../src/frontend/ast.ts";
import type { Prim } from "../../src/op.ts";

export class ExperimentalDuckCompiler {
  readonly #device: GPUDevice;
  readonly #compiler: GpuFunctionalCompiler;

  private constructor(device: GPUDevice, compiler: GpuFunctionalCompiler) {
    this.#device = device;
    this.#compiler = compiler;
  }

  static async create(): Promise<ExperimentalDuckCompiler> {
    const device = await requestWebGpuDevice();

    try {
      const compiler = await GpuFunctionalCompiler.create(device);
      return new ExperimentalDuckCompiler(device, compiler);
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  async compile(source: string): Promise<Uint8Array<ArrayBuffer>> {
    const modules = await this.compile_batch([source]);
    const module = modules[0];

    if (module === undefined) {
      throw new Error("gpufuck compiler omitted its only WebAssembly module");
    }

    return module;
  }

  async compile_batch(
    sources: readonly string[],
  ): Promise<readonly Uint8Array<ArrayBuffer>[]> {
    const encoded_modules = sources.map(encode_gpufuck_module);
    const results = await this.#compiler.compileBatch(encoded_modules);
    const compiled_modules = successful_modules(
      results,
      encoded_modules.length,
    );

    try {
      return await Promise.all(
        compiled_modules.map(compileFunctionalModuleToWasm),
      );
    } finally {
      for (const module of compiled_modules) {
        module.destroy();
      }
    }
  }

  destroy(): void {
    this.#device.destroy();
  }
}

export function encode_gpufuck_module(
  source_text: string,
): EncodedFunctionalModule {
  const source = Source.parse(source_text);

  if (source.module !== undefined) {
    throw new Error("gpufuck experiment does not support module headers");
  }

  if (source.declarations !== undefined && source.declarations.length > 0) {
    const declaration = source.declarations[0];

    if (declaration === undefined) {
      throw new Error("gpufuck experiment lost its first source declaration");
    }

    throw new Error(
      "gpufuck experiment does not support declarations; found " +
        declaration.tag,
    );
  }

  const body = lower_statement_sequence(source.statements, 0, undefined);
  const source_byte_length = new TextEncoder().encode(source_text).byteLength;

  return buildFunctionalSurfaceModule(
    [{ name: "main", parameters: [], annotation: null, body }],
    [],
    "main",
    source_byte_length,
  );
}

function successful_modules(
  results: readonly FunctionalCompileResult[],
  expected_module_count: number,
): GpuFunctionalModule[] {
  const modules: GpuFunctionalModule[] = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];

    if (result === undefined) {
      for (const module of modules) {
        module.destroy();
      }

      throw new Error(
        "gpufuck compiler omitted compilation result " + index.toString(),
      );
    }

    if (!result.ok) {
      for (const module of modules) {
        module.destroy();
      }

      const diagnostic = result.diagnostics[0];
      throw new Error(
        "gpufuck compilation " + index.toString() + " failed with " +
          diagnostic.code + " at bytes " +
          diagnostic.span.startByte.toString() +
          ".." + diagnostic.span.endByte.toString() + ": " +
          diagnostic.message,
      );
    }

    modules.push(result.module);
  }

  if (modules.length !== expected_module_count) {
    for (const module of modules) {
      module.destroy();
    }

    throw new Error(
      "gpufuck compiler returned " + modules.length.toString() +
        " results for " + expected_module_count.toString() + " sources",
    );
  }

  return modules;
}

function lower_statement_sequence(
  statements: readonly Stmt[],
  index: number,
  recursive_name: string | undefined,
): FunctionalSurfaceExpression {
  const statement = statements[index];

  if (statement === undefined) {
    throw new Error(
      "gpufuck experiment expected a result expression at statement " +
        index.toString(),
    );
  }

  if (statement.tag === "bind") {
    if (statement.is_linear) {
      throw new Error(
        "gpufuck experiment does not support linear binding " + statement.name,
      );
    }

    if (statement.effectful === true) {
      throw new Error(
        "gpufuck experiment does not support effectful binding " +
          statement.name,
      );
    }

    if (
      statement.annotation !== undefined ||
      statement.type_annotation !== undefined
    ) {
      throw new Error(
        "gpufuck experiment does not support type annotation on binding " +
          statement.name,
      );
    }

    if (
      statement.pattern !== undefined && statement.pattern.tag !== "binding"
    ) {
      throw new Error(
        "gpufuck experiment does not support " + statement.pattern.tag +
          " binding pattern for " + statement.name,
      );
    }

    const is_recursive = statement.is_recursive === true ||
      statement.value.tag === "rec";
    let value: FunctionalSurfaceExpression;

    if (is_recursive) {
      if (statement.value.tag !== "lam" && statement.value.tag !== "rec") {
        throw new Error(
          "gpufuck recursive binding " + statement.name +
            " must bind a function, found " + statement.value.tag,
        );
      }

      value = lower_lambda(
        statement.value.params,
        statement.value.body,
        statement.name,
      );
    } else {
      value = lower_expression(statement.value, recursive_name);
    }

    const body = lower_statement_sequence(
      statements,
      index + 1,
      recursive_name,
    );

    if (is_recursive) {
      return { kind: "let-rec", name: statement.name, value, body };
    }

    return { kind: "let", name: statement.name, value, body };
  }

  if (statement.tag === "assign") {
    const value = lower_expression(statement.value, recursive_name);
    const body = lower_statement_sequence(
      statements,
      index + 1,
      recursive_name,
    );
    return { kind: "let", name: statement.name, value, body };
  }

  if (statement.tag === "expr") {
    if (statement.effectful === true) {
      throw new Error(
        "gpufuck experiment does not support effectful expression at statement " +
          index.toString(),
      );
    }

    if (index !== statements.length - 1) {
      throw new Error(
        "gpufuck experiment does not support discarded expression at statement " +
          index.toString(),
      );
    }

    return lower_expression(statement.expr, recursive_name);
  }

  if (statement.tag === "return") {
    if (index !== statements.length - 1) {
      throw new Error(
        "gpufuck experiment does not support early return at statement " +
          index.toString(),
      );
    }

    return lower_expression(statement.value, recursive_name);
  }

  throw new Error(
    "gpufuck experiment does not support " + statement.tag +
      " statement at index " + index.toString(),
  );
}

function lower_expression(
  expression: FrontExpr,
  recursive_name: string | undefined,
): FunctionalSurfaceExpression {
  if (expression.tag === "num") {
    if (expression.type !== "i32" || typeof expression.value !== "number") {
      throw new Error(
        "gpufuck experiment supports only i32 literals; found " +
          expression.type + " literal " + expression.value.toString(),
      );
    }

    return surface.integer(expression.value);
  }

  if (expression.tag === "bool") {
    return surface.boolean(expression.value);
  }

  if (expression.tag === "var") {
    if (expression.name === "rec") {
      if (recursive_name === undefined) {
        throw new Error(
          "gpufuck experiment found rec outside a recursive binding",
        );
      }

      return surface.name(recursive_name);
    }

    return surface.name(expression.name);
  }

  if (expression.tag === "prim") {
    return surface.binary(
      lower_primitive(expression.prim),
      lower_expression(expression.left, recursive_name),
      lower_expression(expression.right, recursive_name),
    );
  }

  if (expression.tag === "lam") {
    return lower_lambda(expression.params, expression.body, recursive_name);
  }

  if (expression.tag === "rec") {
    if (recursive_name === undefined) {
      throw new Error(
        "gpufuck experiment requires a recursive expression to be directly bound",
      );
    }

    return lower_lambda(expression.params, expression.body, recursive_name);
  }

  if (expression.tag === "app") {
    const func = lower_expression(expression.func, recursive_name);
    const args = expression.args.map((argument) =>
      lower_expression(argument, recursive_name)
    );
    return surface.apply(func, ...args);
  }

  if (expression.tag === "if") {
    return {
      kind: "if",
      condition: lower_expression(expression.cond, recursive_name),
      consequent: lower_expression(expression.then_branch, recursive_name),
      alternate: lower_expression(expression.else_branch, recursive_name),
    };
  }

  if (expression.tag === "block") {
    return lower_statement_sequence(expression.statements, 0, recursive_name);
  }

  if (expression.tag === "comptime") {
    return lower_expression(expression.expr, recursive_name);
  }

  throw new Error(
    "gpufuck experiment does not support " + expression.tag + " expression",
  );
}

function lower_lambda(
  params: readonly Param[],
  body: FrontExpr,
  recursive_name: string | undefined,
): FunctionalSurfaceExpression {
  if (params.length === 0) {
    throw new Error(
      "gpufuck experiment does not support zero-parameter functions",
    );
  }

  let expression = lower_expression(body, recursive_name);

  for (let index = params.length - 1; index >= 0; index -= 1) {
    const param = params[index];

    if (param === undefined) {
      throw new Error(
        "gpufuck experiment omitted function parameter " + index.toString(),
      );
    }

    if (param.is_linear) {
      throw new Error(
        "gpufuck experiment does not support linear parameter " + param.name,
      );
    }

    if (
      param.annotation !== undefined || param.type_annotation !== undefined
    ) {
      throw new Error(
        "gpufuck experiment does not support type annotation on parameter " +
          param.name,
      );
    }

    expression = surface.lambda(param.name, expression);
  }

  return expression;
}

function lower_primitive(prim: Prim): FunctionalBinaryOperator {
  switch (prim) {
    case "i32.eq":
      return FunctionalBinaryOperator.Equal;
    case "i32.ne":
      return FunctionalBinaryOperator.NotEqual;
    case "i32.lt_s":
      return FunctionalBinaryOperator.Less;
    case "i32.le_s":
      return FunctionalBinaryOperator.LessEqual;
    case "i32.gt_s":
      return FunctionalBinaryOperator.Greater;
    case "i32.ge_s":
      return FunctionalBinaryOperator.GreaterEqual;
    case "i32.add":
      return FunctionalBinaryOperator.Add;
    case "i32.sub":
      return FunctionalBinaryOperator.Subtract;
    case "i32.mul":
      return FunctionalBinaryOperator.Multiply;
    case "i32.div_s":
      return FunctionalBinaryOperator.Divide;
    default:
      throw new Error(
        "gpufuck experiment does not support primitive " + prim,
      );
  }
}
