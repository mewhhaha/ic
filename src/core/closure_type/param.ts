import type { CoreParam } from "../ast.ts";
import { sem_type_from_expr } from "../../frontend/semantic_type.ts";
import { front_type_value_for_semantic_type } from "../../frontend/type_declaration.ts";
import { parse_type_expr } from "../../frontend/type_expr.ts";
import { tokenize } from "../../frontend/tokenize.ts";
import type { CoreExpr } from "../ast.ts";
import type { ClosureParamInfo } from "./types.ts";

type ClosureParamInfoHooks<ctx> = {
  static_annotation_type_value: (
    annotation: string,
    ctx: ctx,
  ) => CoreExpr | undefined;
};

export function closure_param_info<ctx>(
  param: CoreParam,
  ctx: ctx,
  hooks: ClosureParamInfoHooks<ctx>,
): ClosureParamInfo | undefined {
  const annotation = param.annotation;

  if (!annotation) {
    return undefined;
  }

  if (
    annotation === "Bool" || annotation === "Int" || annotation === "I32" ||
    annotation === "U32" || annotation === "Resume"
  ) {
    return { type: "i32", is_text: false };
  }

  if (annotation === "Unit") {
    return { type: "i32", is_text: false };
  }

  if (annotation === "I64") {
    return { type: "i64", is_text: false };
  }

  if (annotation === "Text" || annotation === "Bytes") {
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

  const parsed = parse_type_expr(tokenize(annotation));
  const semantic = sem_type_from_expr(parsed);

  if (semantic.tag === "atom") {
    return { type: "i32", is_text: false, constraint: annotation };
  }

  if (parsed.tag === "borrow" || parsed.tag === "frozen") {
    throw new Error(
      "First-class closure ownership-qualified parameter annotations are " +
        "not supported yet: " + annotation,
    );
  }

  if (semantic.tag === "scalar" && semantic.name !== annotation) {
    return closure_param_info(
      { ...param, annotation: semantic.name },
      ctx,
      hooks,
    );
  }

  if (
    parsed.tag === "union" || parsed.tag === "intersection" ||
    parsed.tag === "difference"
  ) {
    const front_type = front_type_value_for_semantic_type(
      "<closure parameter>",
      parsed,
      semantic,
    );

    if (front_type.tag === "union_type") {
      return {
        type: "i32",
        is_text: false,
        union_type: {
          tag: "union_type",
          cases: front_type.cases.map((union_case) => ({ ...union_case })),
        },
      };
    }
  }

  throw new Error(
    "Cannot check core first-class closure parameter annotation: " +
      annotation,
  );
}
