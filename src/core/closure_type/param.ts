import type { CoreParam } from "../ast.ts";
import type {
  ClosureParamInfo,
  CoreClosureTypeCtx,
  CoreClosureTypeHooks,
} from "./types.ts";

export function closure_param_info(
  param: CoreParam,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): ClosureParamInfo | undefined {
  const annotation = param.annotation;

  if (!annotation) {
    return undefined;
  }

  if (annotation === "Int" || annotation === "I32" || annotation === "U32") {
    return { type: "i32", is_text: false };
  }

  if (annotation === "I64") {
    return { type: "i64", is_text: false };
  }

  if (annotation === "Text") {
    return { type: "i32", is_text: true };
  }

  if (annotation === "Type") {
    throw new Error(
      "Core first-class closure parameter cannot use Type annotation",
    );
  }

  const type_value = hooks.static_annotation_type_value(annotation, ctx);

  if (type_value) {
    if (type_value.tag === "struct_type") {
      return { type: "i32", is_text: false, struct_type: type_value };
    }

    if (type_value.tag === "union_type") {
      return { type: "i32", is_text: false, union_type: type_value };
    }
  }

  throw new Error(
    "Cannot check core first-class closure parameter annotation: " +
      annotation,
  );
}
