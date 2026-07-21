import type { Env, FrontExpr, FrontType } from "./ast.ts";
import { check_binding_annotation } from "./annotation_check.ts";
import { apply_annotation_context } from "./annotation_context.ts";
import { resolve_annotation_type } from "./annotation_resolve.ts";
import type { AnnotationHooks } from "./annotation_types.ts";

export type { AnnotationHooks } from "./annotation_types.ts";
export { check_binding_annotation } from "./annotation_check.ts";
export { apply_annotation_context } from "./annotation_context.ts";
export {
  resolve_annotation_type,
  resolve_numeric_expr_type,
} from "./annotation_resolve.ts";

export function assignment_type(
  previous: FrontType,
  value_type: FrontType,
  mode: "same" | "change",
): FrontType {
  if (mode === "same" && value_type.tag === "unknown") {
    return previous;
  }

  return value_type;
}

export function apply_runtime_binding_annotation(
  annotation: string,
  value: FrontExpr,
  env: Env,
  hooks: AnnotationHooks,
): { value: FrontExpr; type: FrontType } {
  const next_value = apply_annotation_context(annotation, value, env, hooks);
  let next_type = hooks.infer_expr(next_value, env);
  const annotation_type = resolve_annotation_type(annotation, env, hooks);

  if (next_type.tag !== "unknown" || !annotation_type) {
    check_binding_annotation(annotation, next_value, env, hooks);
  }

  if (annotation_type) {
    next_type = annotation_type;
  }

  return { value: next_value, type: next_type };
}
