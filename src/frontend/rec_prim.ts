import type { Ic as IcNode } from "../ic.ts";
import { type Prim, specialize_prim_for_operands } from "../op.ts";
import type { NumType, ValType } from "../op.ts";
import type { Env, FrontExpr, FrontType } from "./ast.ts";
import type { StaticRecHooks } from "./rec_hooks.ts";
import type {
  StaticRecBlockLowerer,
  StaticRecExprLowerer,
} from "./rec_contract.ts";
import { lower_rec_expr_as_type } from "./rec_type_lower.ts";

export function lower_rec_prim(
  expr: Extract<FrontExpr, { tag: "prim" }>,
  env: Env,
  hooks: StaticRecHooks,
  lower_static_rec_block: StaticRecBlockLowerer,
  lower_rec_result_expr: StaticRecExprLowerer,
): IcNode {
  const left_type = hooks.infer_expr(expr.left, env);
  const right_type = hooks.infer_expr(expr.right, env);
  const prim = specialize_prim_for_operands(
    expr.prim,
    rec_numeric_type(left_type),
    rec_numeric_type(right_type),
  );
  const operand_type = rec_numeric_primitive_operand_type(prim);

  return {
    tag: "prim",
    prim,
    args: [
      lower_rec_expr_as_type(
        expr.left,
        { tag: "int", type: operand_type },
        env,
        hooks,
        lower_static_rec_block,
        lower_rec_result_expr,
      ),
      lower_rec_expr_as_type(
        expr.right,
        { tag: "int", type: operand_type },
        env,
        hooks,
        lower_static_rec_block,
        lower_rec_result_expr,
      ),
    ],
  };
}

function rec_numeric_type(type: FrontType): ValType | undefined {
  if (type.tag !== "int") {
    return undefined;
  }

  return type.type;
}

function rec_numeric_primitive_operand_type(prim: Prim): NumType {
  if (prim.startsWith("i64.")) {
    return "i64";
  }

  if (prim.startsWith("f32.")) {
    return "f32";
  }

  if (prim.startsWith("f64.")) {
    return "f64";
  }

  return "i32";
}
