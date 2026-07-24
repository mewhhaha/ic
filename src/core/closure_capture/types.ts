import type { ValType } from "../../op.ts";
import type { CoreExpr } from "../ast.ts";

export type CoreCaptureStaticCtx = {
  locals: Map<string, ValType>;
  statics: Map<string, CoreExpr>;
  text_locals: Set<string>;
  struct_locals: Map<string, CoreExpr>;
};

export type CoreCaptureHooks<ctx extends CoreCaptureStaticCtx> = {
  static_struct_binding: (name: string, ctx: ctx) => CoreExpr | undefined;
};

export type CoreCaptureInfo = {
  names: string[];
  invalid_assignment: boolean;
};

export type CoreCaptureState<ctx extends CoreCaptureStaticCtx> = {
  ctx: ctx;
  locals: Map<string, ValType>;
  bound: Set<string>;
  names: string[];
  seen: Set<string>;
  static_seen: Set<string>;
  invalid_assignment: boolean;
  hooks: CoreCaptureHooks<ctx>;
};
