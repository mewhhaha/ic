import { expect } from "../../expect.ts";
import type { Ic as IcNode } from "../../ic.ts";
import { Ic } from "../../ic.ts";
import type { Env, FrontExpr } from "../ast.ts";
import { unwrap_ownership_wrapper_expr } from "../ownership.ts";
import { text_content_bytes } from "../text.ts";
import { lower_expr_as_front_type } from "../typed_lower.ts";
import type { TextLowerHooks } from "../text_lower_types.ts";
import { visible_text_value } from "../text_visible.ts";
import { lower_text_app_result } from "./app_result.ts";

type TextBranchBounds = "throw" | "trap";

export function lower_static_text_byte_index(
  object: FrontExpr,
  index: number,
  env: Env,
  hooks: TextLowerHooks,
): IcNode | undefined {
  if (index < 0) {
    throw new Error("Text index out of bounds: " + index.toString());
  }

  const text = visible_text_value(object, env, new Set(), hooks);

  if (!text) {
    if (object.tag === "index") {
      return lower_dynamic_text_index_byte(
        object,
        { tag: "num", type: "i32", value: index },
        env,
        hooks,
      );
    }

    return undefined;
  }

  return lower_visible_text_byte_index(text, index, env, hooks);
}

function lower_visible_text_byte_index(
  text: FrontExpr,
  index: number,
  env: Env,
  hooks: TextLowerHooks,
  bounds: TextBranchBounds = "throw",
): IcNode {
  if (text.tag === "text") {
    const bytes = text_content_bytes(text.value);

    if (index >= bytes.length) {
      if (bounds === "trap") {
        return { tag: "prim", prim: "i32.trap", args: [] };
      }

      throw new Error("Text index out of bounds: " + index.toString());
    }

    const value = bytes[index];
    expect(value !== undefined, "Missing text byte " + index.toString());
    return { tag: "num", type: "i32", value };
  }

  if (text.tag === "if") {
    const cond = Ic.reduce(hooks.lower_expr(text.cond, env));

    if (cond.tag === "num") {
      expect(cond.type === "i32", "Text byte if condition must lower to i32");
      const value = cond.value;
      expect(typeof value === "number", "Expected i32 text byte condition");

      if (value !== 0) {
        return lower_visible_text_byte_index(
          text.then_branch,
          index,
          env,
          hooks,
          bounds,
        );
      }

      return lower_visible_text_byte_index(
        text.else_branch,
        index,
        env,
        hooks,
        bounds,
      );
    }

    return {
      tag: "prim",
      prim: "i32.select",
      args: [
        lower_visible_text_byte_index(
          text.then_branch,
          index,
          env,
          hooks,
          "trap",
        ),
        lower_visible_text_byte_index(
          text.else_branch,
          index,
          env,
          hooks,
          "trap",
        ),
        cond,
      ],
    };
  }

  throw new Error(
    "Visible text byte index expected normalized text or if, got: " +
      text.tag,
  );
}

export function lower_runtime_text_byte_index(
  raw_object: FrontExpr,
  index: FrontExpr,
  env: Env,
  hooks: TextLowerHooks,
): IcNode | undefined {
  const object = normalize_text_read_object(raw_object);

  if (object.tag === "index") {
    const dynamic_text_index_byte = lower_dynamic_text_index_byte(
      object,
      index,
      env,
      hooks,
    );

    if (dynamic_text_index_byte) {
      return dynamic_text_index_byte;
    }
  }

  const visible_text = visible_text_value(object, env, new Set(), hooks);

  if (visible_text) {
    return lower_dynamic_visible_text_byte_index(
      visible_text,
      index,
      env,
      hooks,
    );
  }

  const object_type = hooks.infer_expr(object, env);
  let lowered_object: IcNode;

  if (object_type.tag === "text") {
    lowered_object = hooks.lower_expr(object, env);
  } else {
    if (object_type.tag !== "unknown") {
      return undefined;
    }

    const lowered_text_object = lower_unknown_text_object(
      object,
      env,
      hooks,
    );

    if (!lowered_text_object) {
      return undefined;
    }

    lowered_object = lowered_text_object;
  }

  const index_type = hooks.infer_expr(index, env);

  if (
    index_type.tag === "int" && index_type.type !== undefined &&
    index_type.type !== "i32"
  ) {
    throw new Error("Text index must be i32");
  }

  const static_index = hooks.resolve_static_i32_expr(index, env);

  if (static_index !== undefined && static_index < 0) {
    throw new Error("Text index out of bounds: " + static_index.toString());
  }

  const lowered_index = hooks.lower_expr(index, env);
  const length: IcNode = {
    tag: "prim",
    prim: "i32.load",
    args: [lowered_object],
  };
  const byte: IcNode = {
    tag: "prim",
    prim: "i32.load8_u",
    args: [
      {
        tag: "prim",
        prim: "i32.add",
        args: [
          {
            tag: "prim",
            prim: "i32.add",
            args: [
              lowered_object,
              { tag: "num", type: "i32", value: 4 },
            ],
          },
          lowered_index,
        ],
      },
    ],
  };
  const trap: IcNode = { tag: "prim", prim: "i32.trap", args: [] };

  return {
    tag: "prim",
    prim: "i32.select",
    args: [
      trap,
      {
        tag: "prim",
        prim: "i32.select",
        args: [
          byte,
          trap,
          {
            tag: "prim",
            prim: "i32.lt_s",
            args: [
              lowered_index,
              length,
            ],
          },
        ],
      },
      {
        tag: "prim",
        prim: "i32.lt_s",
        args: [
          lowered_index,
          { tag: "num", type: "i32", value: 0 },
        ],
      },
    ],
  };
}

function lower_unknown_text_object(
  object: FrontExpr,
  env: Env,
  hooks: TextLowerHooks,
): IcNode | undefined {
  if (object.tag === "if_let") {
    return lower_expr_as_front_type(
      object,
      { tag: "text" },
      env,
      hooks,
    );
  }

  if (object.tag === "app") {
    return lower_text_app_result(object, env, hooks);
  }

  return undefined;
}

function normalize_text_read_object(expr: FrontExpr): FrontExpr {
  let current = expr;

  while (true) {
    const unwrapped = unwrap_ownership_wrapper_expr(current);

    if (unwrapped !== current) {
      current = unwrapped;
      continue;
    }

    if (current.tag === "block" && current.statements.length === 1) {
      const stmt = current.statements[0];
      expect(stmt, "Missing text read block statement");

      if (stmt.tag === "expr") {
        current = stmt.expr;
        continue;
      }
    }

    return current;
  }
}

function lower_dynamic_text_index_byte(
  expr: Extract<FrontExpr, { tag: "index" }>,
  byte_index: FrontExpr,
  env: Env,
  hooks: TextLowerHooks,
): IcNode | undefined {
  check_text_index_type(byte_index, env, hooks);

  if (hooks.resolve_static_i32_expr(expr.index, env) !== undefined) {
    return undefined;
  }

  const target = hooks.resolve_struct_value(expr.object, env);

  if (!target) {
    return undefined;
  }

  const bytes: IcNode[] = [];

  for (const field of target.expr.fields) {
    const text = visible_text_value(field.value, target.env, new Set(), hooks);

    if (!text) {
      return undefined;
    }

    bytes.push(
      lower_dynamic_visible_text_byte_index(
        text,
        byte_index,
        env,
        hooks,
      ),
    );
  }

  let result: IcNode = { tag: "prim", prim: "i32.trap", args: [] };

  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const byte = bytes[index];
    expect(byte, "Missing visible text byte branch " + index.toString());
    result = {
      tag: "prim",
      prim: "i32.select",
      args: [
        byte,
        result,
        {
          tag: "prim",
          prim: "i32.eq",
          args: [
            hooks.lower_expr(expr.index, env),
            { tag: "num", type: "i32", value: index },
          ],
        },
      ],
    };
  }

  return result;
}

function lower_dynamic_visible_text_byte_index(
  text: FrontExpr,
  index: FrontExpr,
  env: Env,
  hooks: TextLowerHooks,
): IcNode {
  check_text_index_type(index, env, hooks);

  if (text.tag === "text") {
    const bytes = text_content_bytes(text.value);
    let result: IcNode = { tag: "prim", prim: "i32.trap", args: [] };

    for (let pos = bytes.length - 1; pos >= 0; pos -= 1) {
      const byte = bytes[pos];
      expect(byte !== undefined, "Missing text byte " + pos.toString());
      result = {
        tag: "prim",
        prim: "i32.select",
        args: [
          { tag: "num", type: "i32", value: byte },
          result,
          {
            tag: "prim",
            prim: "i32.eq",
            args: [
              hooks.lower_expr(index, env),
              { tag: "num", type: "i32", value: pos },
            ],
          },
        ],
      };
    }

    return result;
  }

  if (text.tag === "if") {
    return {
      tag: "prim",
      prim: "i32.select",
      args: [
        lower_dynamic_visible_text_byte_index(
          text.then_branch,
          index,
          env,
          hooks,
        ),
        lower_dynamic_visible_text_byte_index(
          text.else_branch,
          index,
          env,
          hooks,
        ),
        hooks.lower_expr(text.cond, env),
      ],
    };
  }

  throw new Error(
    "Visible text byte index expected normalized text or if, got: " +
      text.tag,
  );
}

function check_text_index_type(
  index: FrontExpr,
  env: Env,
  hooks: TextLowerHooks,
): void {
  const index_type = hooks.infer_expr(index, env);

  if (
    index_type.tag === "int" && index_type.type !== undefined &&
    index_type.type !== "i32"
  ) {
    throw new Error("Text index must be i32");
  }
}
