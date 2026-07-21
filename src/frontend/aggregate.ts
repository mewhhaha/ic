import type { Field, FrontExpr, TypeExpr } from "./ast.ts";

export function elaborate_product_expr(
  expr: Extract<FrontExpr, { tag: "product" }>,
): Extract<FrontExpr, { tag: "struct_value" }> {
  const fields: Field[] = [];
  const names = new Set<string>();
  let bracketed: "named" | "positional" = "positional";

  if (expr.entries[0]?.label !== undefined) {
    bracketed = "named";
  }

  for (let index = 0; index < expr.entries.length; index += 1) {
    const entry = expr.entries[index];

    if (!entry) {
      throw new Error("Missing product entry " + index.toString());
    }

    let name = "item_" + index.toString();

    if (entry.label !== undefined) {
      name = entry.label;
    }

    if (names.has(name)) {
      throw new Error("Duplicate product field: " + name);
    }

    names.add(name);
    fields.push({ name, value: entry.value });
  }

  return {
    tag: "struct_value",
    type_expr: { tag: "var", name: "object_type" },
    fields,
    bracketed,
  };
}

export function elaborate_fixed_array_expr(
  expr: Extract<FrontExpr, { tag: "array" }>,
): Extract<FrontExpr, { tag: "struct_value" }> {
  if (expr.rest !== undefined) {
    throw new Error(
      "Cannot lower array spread to the fixed aggregate representation",
    );
  }

  return {
    tag: "struct_value",
    type_expr: { tag: "var", name: "object_type" },
    fields: expr.items.map((value, index) => ({
      name: "item_" + index.toString(),
      value,
    })),
    bracketed: "positional",
  };
}

export function elaborate_product_as_expr(
  expr: Extract<FrontExpr, { tag: "as" }>,
  result_type_value: FrontExpr = {
    tag: "set_type",
    type_expr: expr.type_expr,
  },
): Extract<FrontExpr, { tag: "struct_value" }> {
  if (expr.value.tag !== "product") {
    throw new Error(
      "Cannot erase `as`: source must be an ordered product value",
    );
  }

  if (expr.type_expr.tag !== "product") {
    throw new Error(
      "Cannot erase `as`: target must be an ordered product type",
    );
  }

  if (expr.value.entries.length !== expr.type_expr.entries.length) {
    throw new Error(
      "Cannot erase `as`: product arity differs, source has " +
        expr.value.entries.length.toString() + " entries and target has " +
        expr.type_expr.entries.length.toString(),
    );
  }

  const target_entries = expr.type_expr.entries;
  const entries = expr.value.entries.map((source, index) => {
    const target = target_entries[index];

    if (!target) {
      throw new Error("Missing `as` target product entry " + index.toString());
    }

    const source_layout = front_expr_runtime_layout(source.value);
    const target_layout = type_expr_runtime_layout(target.type_expr);

    if (
      source_layout !== undefined && target_layout !== undefined &&
      source_layout !== target_layout
    ) {
      throw new Error(
        "Cannot erase `as`: product entry " + index.toString() +
          " has source layout " + source_layout + " and target layout " +
          target_layout,
      );
    }

    let name = "item_" + index.toString();

    if (target.label !== undefined) {
      name = target.label;
    }

    return { name, value: source.value };
  });

  return {
    tag: "struct_value",
    type_expr: result_type_value,
    fields: entries,
    bracketed: "named",
  };
}

export function elaborate_array_repeat_expr(
  expr: Extract<FrontExpr, { tag: "array_repeat" }>,
  value_name: string,
): FrontExpr {
  const length = constant_repeat_length(expr.length);

  if (length < 0) {
    throw new Error(
      "Array repeat length must be non-negative, got " + length.toString(),
    );
  }

  if (!repeat_value_is_duplicable(expr.value)) {
    throw new Error(
      "Array repeat value cannot be duplicated safely: " + expr.value.tag,
    );
  }

  const items: FrontExpr[] = [];

  for (let index = 0; index < length; index += 1) {
    items.push({ tag: "var", name: value_name });
  }

  return {
    tag: "app",
    func: {
      tag: "lam",
      params: [{
        name: value_name,
        is_const: false,
        is_linear: false,
        annotation: undefined,
      }],
      body: { tag: "array", items, rest: undefined },
    },
    args: [expr.value],
  };
}

function front_expr_runtime_layout(expr: FrontExpr): string | undefined {
  if (
    expr.tag === "bool" || expr.tag === "atom" || expr.tag === "unit"
  ) {
    return "i32";
  }

  if (expr.tag === "num") {
    return expr.type;
  }

  if (expr.tag === "text") {
    return "text";
  }

  if (expr.tag === "product") {
    const layouts = expr.entries.map((entry) => {
      return front_expr_runtime_layout(entry.value);
    });

    if (layouts.some((layout) => layout === undefined)) {
      return undefined;
    }

    return "(" + layouts.join(",") + ")";
  }

  if (expr.tag === "array" && expr.rest === undefined) {
    const layouts = expr.items.map(front_expr_runtime_layout);

    if (layouts.some((layout) => layout === undefined)) {
      return undefined;
    }

    return "(" + layouts.join(",") + ")";
  }

  if (expr.tag === "as") {
    return type_expr_runtime_layout(expr.type_expr);
  }

  return undefined;
}

function type_expr_runtime_layout(type: TypeExpr): string | undefined {
  if (type.tag === "atom") {
    return "i32";
  }

  if (type.tag === "name") {
    if (type.name === "I64") {
      return "i64";
    }

    if (type.name === "F32") {
      return "f32";
    }

    if (type.name === "F64") {
      return "f64";
    }

    if (
      type.name === "Bool" || type.name === "Char" || type.name === "Int" ||
      type.name === "I32" || type.name === "U32" || type.name === "Unit" ||
      type.name === "Resume"
    ) {
      return "i32";
    }

    if (type.name === "Text" || type.name === "Bytes") {
      return "text";
    }

    return undefined;
  }

  if (type.tag === "product") {
    const layouts = type.entries.map((entry) => {
      return type_expr_runtime_layout(entry.type_expr);
    });

    if (layouts.some((layout) => layout === undefined)) {
      return undefined;
    }

    return "(" + layouts.join(",") + ")";
  }

  return undefined;
}

export function constant_repeat_length(expr: FrontExpr): number {
  if (
    expr.tag === "num" && expr.type === "i32" &&
    expr.character === undefined
  ) {
    if (typeof expr.value !== "number" || !Number.isInteger(expr.value)) {
      throw new Error("Array repeat length must be an integer i32 constant");
    }

    return expr.value;
  }

  if (expr.tag === "comptime") {
    return constant_repeat_length(expr.expr);
  }

  if (expr.tag === "prim") {
    const left = constant_repeat_length(expr.left);
    const right = constant_repeat_length(expr.right);

    if (expr.prim === "i32.add") {
      return (left + right) | 0;
    }

    if (expr.prim === "i32.sub") {
      return (left - right) | 0;
    }

    if (expr.prim === "i32.mul") {
      return Math.imul(left, right);
    }

    if (expr.prim === "i32.div_s") {
      if (right === 0) {
        throw new Error("Array repeat length divides by zero");
      }

      return Math.trunc(left / right);
    }

    if (expr.prim === "i32.rem_s") {
      if (right === 0) {
        throw new Error("Array repeat length divides by zero");
      }

      return left % right;
    }
  }

  throw new Error(
    "Array repeat length must be a constant i32 expression, got " + expr.tag,
  );
}

function repeat_value_is_duplicable(expr: FrontExpr): boolean {
  if (
    expr.tag === "bool" || expr.tag === "num" || expr.tag === "atom" ||
    expr.tag === "unit" || expr.tag === "text" || expr.tag === "type_name" ||
    expr.tag === "set_type" || expr.tag === "struct_type" ||
    expr.tag === "union_type"
  ) {
    return true;
  }

  if (expr.tag === "prim") {
    return repeat_value_is_duplicable(expr.left) &&
      repeat_value_is_duplicable(expr.right);
  }

  if (expr.tag === "product") {
    return expr.entries.every((entry) =>
      repeat_value_is_duplicable(entry.value)
    );
  }

  if (expr.tag === "array") {
    if (!expr.items.every(repeat_value_is_duplicable)) {
      return false;
    }

    if (expr.rest !== undefined) {
      return repeat_value_is_duplicable(expr.rest);
    }

    return true;
  }

  if (expr.tag === "array_repeat") {
    return repeat_value_is_duplicable(expr.value);
  }

  if (expr.tag === "comptime" || expr.tag === "captured") {
    return repeat_value_is_duplicable(expr.expr);
  }

  if (expr.tag === "freeze") {
    return true;
  }

  if (expr.tag === "as") {
    return repeat_value_is_duplicable(expr.value);
  }

  return false;
}
