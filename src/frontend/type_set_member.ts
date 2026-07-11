import type { Env, FrontExpr, FrontType, TypeExpr, TypeField } from "./ast.ts";
import {
  sem_type_from_expr,
  sem_type_from_front_type,
  sem_type_subtype,
} from "./semantic_type.ts";

export function matching_type_set_case(
  cases: TypeField[],
  value: FrontExpr,
  env: Env,
  infer_expr: (expr: FrontExpr, env: Env) => FrontType,
): TypeField | undefined {
  for (const union_case of cases) {
    if (
      union_case.set_member &&
      value_matches_type_set_member(
        value,
        union_case.set_member,
        env,
        infer_expr,
      )
    ) {
      return union_case;
    }
  }

  return undefined;
}

export function value_matches_type_set_member(
  value: FrontExpr,
  member: TypeExpr,
  env: Env,
  infer_expr: (expr: FrontExpr, env: Env) => FrontType,
): boolean {
  if (member.tag === "frozen") {
    if (value.tag !== "freeze") {
      return false;
    }

    return value_matches_type_set_member(
      value.value,
      member.value,
      env,
      infer_expr,
    );
  }

  if (member.tag === "borrow") {
    if (value.tag !== "borrow") {
      return false;
    }

    return value_matches_type_set_member(
      value.value,
      member.value,
      env,
      infer_expr,
    );
  }

  const actual = sem_type_from_front_type(infer_expr(value, env));
  const expected = sem_type_from_expr(member);
  return sem_type_subtype(actual, expected);
}
