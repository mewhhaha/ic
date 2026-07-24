import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { CoreExpr } from "./ast.ts";

export type CoreRuntimeBufferBuiltinName =
  | "@Utf8.encode"
  | "@Utf8.decode"
  | "@format_i32"
  | "@format_i64"
  | "@format_f32";

export type CoreRuntimeBufferBuiltin = {
  name: CoreRuntimeBufferBuiltinName;
  arg: CoreExpr;
  arg_type: ValType | "buffer";
  precision?: CoreExpr;
  result: "bytes" | "text";
};

export function is_core_runtime_buffer_builtin_name(
  name: string,
): name is CoreRuntimeBufferBuiltinName {
  if (name === "@Utf8.encode" || name === "@Utf8.decode") {
    return true;
  }

  return name === "@format_i32" || name === "@format_i64" ||
    name === "@format_f32";
}

export function core_runtime_buffer_builtin(
  expr: CoreExpr,
): CoreRuntimeBufferBuiltin | undefined {
  if (expr.tag !== "app" || expr.func.tag !== "var") {
    return undefined;
  }

  let arg_type: ValType | "buffer" | undefined;
  let result: "bytes" | "text" | undefined;
  let precision: CoreExpr | undefined;
  let expected_args = 1;

  if (expr.func.name === "@Utf8.encode") {
    arg_type = "buffer";
    result = "bytes";
  } else if (expr.func.name === "@Utf8.decode") {
    arg_type = "buffer";
    result = "text";
  } else if (expr.func.name === "@format_i32") {
    arg_type = "i32";
    result = "text";
  } else if (expr.func.name === "@format_i64") {
    arg_type = "i64";
    result = "text";
  } else if (expr.func.name === "@format_f32") {
    arg_type = "f32";
    result = "text";
    precision = expr.args[1];
    expected_args = 2;
  } else {
    return undefined;
  }

  expect(
    expr.args.length === expected_args,
    "Core " + expr.func.name + " expects " +
      expected_args.toString() + " arguments",
  );
  const arg = expr.args[0];
  expect(arg, "Missing Core " + expr.func.name + " argument");

  if (expr.func.name === "@format_f32") {
    expect(precision, "Missing Core format_f32 precision argument");
  }

  return {
    name: expr.func.name,
    arg,
    arg_type,
    precision,
    result,
  };
}
