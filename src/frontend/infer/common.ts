import type { Env, FrontType } from "../ast.ts";
import { can_implicit_fallback_type } from "../implicit_fallback.ts";
import { common_front_type, front_type_from_type_name } from "../types.ts";
import type { InferHooks } from "./types.ts";

export function common_if_type(
  implicit_else: boolean | undefined,
  then_type: FrontType,
  else_type: FrontType,
): FrontType | undefined {
  if (implicit_else) {
    if (can_implicit_fallback_type(then_type)) {
      return then_type;
    }

    if (then_type.tag === "unknown") {
      return then_type;
    }
  }

  const result_type = common_front_type(then_type, else_type);

  if (result_type) {
    return result_type;
  }

  return undefined;
}

export function front_type_for_type_name(
  type_name: string,
  env: Env,
  hooks: InferHooks,
): FrontType {
  const resolved = hooks.resolve_annotation_type(type_name, env);

  if (resolved) {
    return resolved;
  }

  return front_type_from_type_name(type_name);
}
