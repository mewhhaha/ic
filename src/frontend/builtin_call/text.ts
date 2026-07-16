import type { Ic as IcNode } from "../../ic.ts";
import type { Env, FrontExpr } from "../ast.ts";
import type { BuiltinCallHooks } from "./hooks.ts";
import { lower_text_operation_builtin_call } from "./text_ops.ts";
import { lower_text_read_builtin_call } from "./text_read.ts";

export function lower_text_builtin_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
  hooks: BuiltinCallHooks,
): IcNode | undefined {
  const text_read = lower_text_read_builtin_call(expr, env, hooks);

  if (text_read) {
    return text_read;
  }

  return lower_text_operation_builtin_call(expr, env, hooks);
}
