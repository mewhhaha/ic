export { check_static_core_call_arity } from "./static_call/arity.ts";
export {
  collect_scoped_static_core_call_locals,
  emit_scoped_static_core_call,
  scoped_static_core_call_fn_type,
  scoped_static_core_call_type,
  scoped_static_core_call_value,
} from "./static_call/scoped.ts";
export {
  static_core_call_branch_app,
  static_core_call_branch_value,
  static_core_call_requires_scope,
  static_core_call_target,
  static_core_call_value,
  static_core_rec_target,
} from "./static_call/target.ts";
export type {
  StaticCoreCallBlockCtx,
  StaticCoreCallCtx,
  StaticCoreCallHooks,
  StaticCoreCallTempCtx,
} from "./static_call/types.ts";
