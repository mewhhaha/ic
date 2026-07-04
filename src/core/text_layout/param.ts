import type { ValType } from "../../op.ts";
import type { CoreParam } from "../ast.ts";
import { core_val_type_from_type_name } from "../type_static.ts";

export function core_text_layout_param_type(
  param: CoreParam,
): ValType | undefined {
  const annotation = param.annotation;

  if (!annotation) {
    return "i32";
  }

  return core_val_type_from_type_name(annotation);
}
