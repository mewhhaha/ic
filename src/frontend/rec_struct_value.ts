import type { Ic as IcNode } from "../ic.ts";
import type { Env, FrontExpr } from "./ast.ts";
import { lookup_field } from "./fields.ts";
import type { StaticRecHooks } from "./rec_hooks.ts";
import type {
  StaticRecBlockLowerer,
  StaticRecExprLowerer,
} from "./rec_contract.ts";

export function lower_rec_struct_value(
  expr: Extract<FrontExpr, { tag: "struct_value" }>,
  env: Env,
  hooks: StaticRecHooks,
  lower_static_rec_block: StaticRecBlockLowerer,
  lower_rec_result_expr: StaticRecExprLowerer,
): IcNode {
  const handler_name = hooks.fresh(env, "pick");
  let body: IcNode = { tag: "var", name: handler_name };

  for (const field of rec_struct_value_fields(expr, env, hooks)) {
    body = {
      tag: "app",
      func: body,
      arg: lower_rec_result_expr(
        field.value,
        env,
        hooks,
        lower_static_rec_block,
      ),
    };
  }

  return lower_rec_lambda_binding(handler_name, body);
}

function lower_rec_lambda_binding(name: string, body: IcNode): IcNode {
  return { tag: "lam", name, body };
}

function rec_struct_value_fields(
  expr: Extract<FrontExpr, { tag: "struct_value" }>,
  env: Env,
  hooks: StaticRecHooks,
): typeof expr.fields {
  const struct_type = hooks.resolve_struct_type_value(expr.type_expr, env);

  if (!struct_type) {
    return expr.fields;
  }

  return struct_type.fields.map((declared) => {
    const field = lookup_field(expr.fields, declared.name);
    if (!field) {
      throw new Error("Missing struct field: " + declared.name);
    }

    return field;
  });
}
