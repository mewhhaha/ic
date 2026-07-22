import { expect } from "../expect.ts";
import { f32x4_builtin_prim, f32x4_lane_index, Prim } from "../op.ts";
import { Callable } from "../trait.ts";
import type { Env, FrontExpr, FrontType } from "./ast.ts";
import { lookup } from "./env.ts";
import { compiler_builtin_args } from "./compiler_builtin_args.ts";

export type F32x4BuiltinCall = {
  prim: Prim;
  args: FrontExpr[];
};

export function f32x4_builtin_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
): F32x4BuiltinCall | undefined {
  if (expr.func.tag !== "var") {
    return undefined;
  }

  const prim = f32x4_builtin_prim(expr.func.name);

  if (!prim) {
    return undefined;
  }

  return { prim, args: compiler_builtin_args(expr) };
}

export function infer_f32x4_builtin_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Env,
): FrontType | undefined {
  const call = f32x4_builtin_call(expr);

  if (!call || expr.func.tag !== "var" || lookup(env, expr.func.name)) {
    return undefined;
  }

  const signature = Callable.type(Prim, call.prim);

  if (call.args.length !== signature.args.length) {
    return { tag: "unknown" };
  }

  if (signature.result === "v128") {
    return { tag: "f32x4" };
  }

  expect(
    signature.result === "f32",
    "Unexpected f32x4 builtin result type: " + signature.result,
  );
  return { tag: "int", type: "f32" };
}

export function validate_f32x4_lane_argument(
  prim: Prim,
  args: FrontExpr[],
): void {
  if (
    prim !== "f32x4.extract_lane" && prim !== "f32x4.replace_lane"
  ) {
    return;
  }

  const lane = args[1];
  expect(lane, "Missing f32x4 lane argument");
  let value: number | undefined;

  if (
    lane.tag === "num" && lane.type === "i32" &&
    typeof lane.value === "number"
  ) {
    value = lane.value;
  }

  f32x4_lane_index(prim, value);
}
