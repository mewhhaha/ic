import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr, FrontType, Stmt } from "./ast.ts";
import type { StaticRecHooks } from "./rec_hooks.ts";

export type StaticRecResult =
  | { tag: "done"; value: IcNode }
  | { tag: "call"; args: FrontExpr[] };

export type StaticRecBlockLowerer = (
  stmts: Stmt[],
  env: Env,
  hooks: StaticRecHooks,
  expected_type?: FrontType,
) => StaticRecResult | undefined;

export type StaticRecExprLowerer = (
  expr: FrontExpr,
  env: Env,
  hooks: StaticRecHooks,
  lower_static_rec_block: StaticRecBlockLowerer,
) => IcNode;
