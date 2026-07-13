import type { Env, FrontExpr, FrontType, Stmt } from "../ast.ts";
import { structured_core_route } from "../diagnostic.ts";
import { implicit_fallback_expr } from "../implicit_fallback.ts";
import {
  dynamic_loop_control_app_result_type,
  dynamic_loop_control_inline_app_expr,
} from "./fallback/app.ts";
import {
  dynamic_loop_control_struct_fallback,
  dynamic_loop_control_type_fallback,
  dynamic_loop_control_union_fallback,
} from "./fallback/aggregate.ts";
import {
  dynamic_loop_control_function_fallback,
  dynamic_loop_control_function_type,
} from "./fallback/function.ts";
import type { StaticLoopHooks } from "./types.ts";

export { dynamic_loop_control_guarded_binding_value } from "./fallback/aggregate.ts";
export { dynamic_loop_control_function_value } from "./fallback/function.ts";

export function dynamic_loop_control_value_with_implicit_fallback(
  value: FrontExpr,
  type: FrontType,
  env: Env,
  hooks: StaticLoopHooks,
): FrontExpr {
  if (value.tag === "if" && value.implicit_else) {
    const fallback = implicit_fallback_expr(type, env, hooks);

    if (fallback) {
      return {
        ...value,
        else_branch: fallback,
        implicit_else: undefined,
      };
    }
  }

  if (value.tag === "if_let" && value.implicit_else) {
    const fallback = implicit_fallback_expr(type, env, hooks);

    if (fallback) {
      return {
        ...value,
        else_branch: fallback,
        implicit_else: undefined,
      };
    }
  }

  return value;
}

export function dynamic_loop_control_binding_type(
  stmt: Extract<Stmt, { tag: "bind" }>,
  env: Env,
  hooks: StaticLoopHooks,
): FrontType {
  const inferred = hooks.infer_expr(stmt.value, env);

  if (!stmt.annotation) {
    const cases = hooks.infer_union_cases(stmt.value, env);

    if (cases) {
      return { tag: "union_value", cases };
    }

    if (inferred.tag === "unknown") {
      const function_type = dynamic_loop_control_function_type(
        stmt.value,
        env,
        hooks,
      );

      if (function_type) {
        return function_type;
      }

      const app_type = dynamic_loop_control_app_result_type(
        stmt.value,
        env,
        hooks,
      );

      if (app_type) {
        return app_type;
      }
    }

    return inferred;
  }

  const annotated = hooks.resolve_annotation_type(stmt.annotation, env);

  if (!annotated) {
    return inferred;
  }

  return annotated;
}

export function dynamic_loop_control_binding_fallback(
  name: string,
  type: FrontType,
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): FrontExpr {
  if (type.tag === "bool") {
    return { tag: "bool", value: false };
  }

  if (type.tag !== "int") {
    if (type.tag === "fn") {
      const fallback = dynamic_loop_control_function_fallback(
        value,
        env,
        hooks,
      );

      if (fallback) {
        return fallback;
      }
    }

    if (type.tag === "text") {
      return { tag: "text", value: "" };
    }

    if (type.tag === "struct") {
      const target = hooks.resolve_struct_value(value, env);

      if (target) {
        return dynamic_loop_control_struct_fallback(
          name,
          target,
          hooks,
          dynamic_loop_control_binding_fallback,
        );
      }

      const fallback = dynamic_loop_control_type_fallback(
        name,
        type,
        env,
        hooks,
      );

      if (fallback) {
        return fallback;
      }
    }

    if (type.tag === "union_value" || type.tag === "union") {
      const target = hooks.resolve_union_value(value, env);

      if (target) {
        return dynamic_loop_control_union_fallback(
          name,
          target,
          hooks,
          dynamic_loop_control_binding_fallback,
        );
      }

      if (type.tag === "union_value") {
        const fallback = dynamic_loop_control_type_fallback(
          name,
          type,
          env,
          hooks,
        );

        if (fallback) {
          return fallback;
        }
      }
    }

    if (type.tag === "unknown") {
      const resolved = dynamic_loop_control_unknown_fallback(
        name,
        value,
        env,
        hooks,
      );

      if (resolved) {
        return resolved;
      }
    }

    throw new Error(
      "Cannot lower local binding after dynamic loop control yet: " + name +
        structured_core_route,
    );
  }

  if (type.type === "i64") {
    return { tag: "num", type: "i64", value: 0n };
  }

  if (type.type === "i32") {
    return { tag: "num", type: "i32", value: 0 };
  }

  throw new Error(
    "Cannot lower local binding after dynamic loop control yet: " + name +
      structured_core_route,
  );
}

function dynamic_loop_control_unknown_fallback(
  name: string,
  value: FrontExpr,
  env: Env,
  hooks: StaticLoopHooks,
): FrontExpr | undefined {
  if (value.tag === "bool") {
    return { tag: "bool", value: false };
  }

  if (value.tag === "num") {
    if (value.type === "i64") {
      return { tag: "num", type: "i64", value: 0n };
    }

    return { tag: "num", type: "i32", value: 0 };
  }

  const static_i32 = hooks.resolve_static_i32_expr(value, env);

  if (static_i32 !== undefined) {
    return { tag: "num", type: "i32", value: 0 };
  }

  const text_bytes = hooks.resolve_text_bytes(value, env);

  if (text_bytes) {
    return { tag: "text", value: "" };
  }

  const target = hooks.resolve_struct_value(value, env);

  if (target) {
    return dynamic_loop_control_struct_fallback(
      name,
      target,
      hooks,
      dynamic_loop_control_binding_fallback,
    );
  }

  const union_target = hooks.resolve_union_value(value, env);

  if (union_target) {
    return dynamic_loop_control_union_fallback(
      name,
      union_target,
      hooks,
      dynamic_loop_control_binding_fallback,
    );
  }

  const app_type = dynamic_loop_control_app_result_type(value, env, hooks);

  if (app_type) {
    const app_value = dynamic_loop_control_inline_app_expr(value, env, hooks);

    if (app_value) {
      return dynamic_loop_control_binding_fallback(
        name,
        app_type,
        app_value.expr,
        app_value.env,
        hooks,
      );
    }
  }

  return undefined;
}
