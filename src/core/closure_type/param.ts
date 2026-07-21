import type { CoreParam } from "../ast.ts";
import { expect } from "../../expect.ts";
import type { TypeExpr } from "../../type_syntax.ts";
import {
  format_type_expr,
  front_type_value_for_semantic_type,
  parse_type_expr,
  sem_type_from_expr,
  tokenize,
} from "../from_source/type_contract.ts";
import type { CoreExpr, CoreFnType } from "../ast.ts";
import type { ClosureParamInfo } from "./types.ts";
import { integer_type_from_name, integer_val_type } from "../../integer.ts";

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

  const integer = integer_type_from_name(annotation);

  if (integer) {
    const type = integer_val_type(integer);

    if (type) {
      return { type, is_text: false };
    }
  }

  if (
    annotation === "Bool" || annotation === "Char" || annotation === "Int" ||
    annotation === "I32" || annotation === "U32" || annotation === "Resume"
  ) {
    return { type: "i32", is_text: false };
  }

  if (annotation === "Unit") {
    return { type: "i32", is_text: false };
  }

  if (annotation === "I64") {
    return { type: "i64", is_text: false };
  }

  if (annotation === "F32") {
    return { type: "f32", is_text: false };
  }

  if (annotation === "F64") {
    return { type: "f64", is_text: false };
  }

  if (annotation === "F32x4") {
    return { type: "v128", is_text: false };
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

  if (parsed.tag === "arrow") {
    return {
      type: "i32",
      is_text: false,
      fn_type: closure_annotation_fn_type(parsed, ctx, hooks),
    };
  }

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

function closure_annotation_fn_type<ctx>(
  annotation: Extract<TypeExpr, { tag: "arrow" }>,
  ctx: ctx,
  hooks: ClosureParamInfoHooks<ctx>,
): CoreFnType {
  let parameter_types: TypeExpr[] = [annotation.param];
  if (annotation.param.tag === "product") {
    parameter_types = annotation.param.entries.map((entry) => entry.type_expr);
  }
  const params: CoreFnType["params"] = [];
  const param_texts: CoreFnType["param_texts"] = [];
  const param_constraints: (string | undefined)[] = [];
  const param_structs: (CoreExpr | undefined)[] = [];
  const param_unions: (CoreExpr | undefined)[] = [];
  const param_fns: (CoreFnType | undefined)[] = [];

  for (let index = 0; index < parameter_types.length; index += 1) {
    const type = parameter_types[index];
    expect(type, "Missing closure annotation parameter " + index.toString());
    const info = closure_param_info(
      {
        name: "__duck_closure_param_" + index.toString(),
        is_const: false,
        is_linear: false,
        annotation: format_type_expr(type),
      },
      ctx,
      hooks,
    );
    expect(
      info,
      "Missing closure annotation parameter type " + index.toString(),
    );
    params.push(info.type);
    param_texts.push(info.is_text);
    param_constraints.push(info.constraint);
    param_structs.push(info.struct_type);
    param_unions.push(info.union_type);
    param_fns.push(info.fn_type);
  }

  const result = closure_param_info(
    {
      name: "__duck_closure_result",
      is_const: false,
      is_linear: false,
      annotation: format_type_expr(annotation.result),
    },
    ctx,
    hooks,
  );
  expect(result, "Missing closure annotation result type");

  const fn_type: CoreFnType = {
    tag: "fn",
    params,
    param_texts,
    result: result.type,
    result_text: result.is_text,
    result_struct: result.struct_type,
    result_union: result.union_type,
  };

  if (param_constraints.some((constraint) => constraint !== undefined)) {
    fn_type.param_constraints = param_constraints;
  }
  if (param_structs.some((struct_type) => struct_type !== undefined)) {
    fn_type.param_structs = param_structs;
  }
  if (param_unions.some((union_type) => union_type !== undefined)) {
    fn_type.param_unions = param_unions;
  }
  if (param_fns.some((param_fn) => param_fn !== undefined)) {
    fn_type.param_fns = param_fns;
  }

  return fn_type;
}
