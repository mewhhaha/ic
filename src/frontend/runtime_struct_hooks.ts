import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, TypeField } from "./ast.ts";

export type RuntimeStructHooks = {
  fresh: (env: Env, name: string) => string;
  lower_expr: (expr: FrontExpr, env: Env) => IcNode;
  resolve_runtime_struct_type: (
    expr: FrontExpr,
    env: Env,
  ) => { fields: TypeField[] } | undefined;
};
