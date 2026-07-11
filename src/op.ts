import { Callable, type CallableType, Emit, Format } from "./trait.ts";

export type ValType = "i32" | "i64";
type PrimOp =
  | "add"
  | "sub"
  | "mul"
  | "div_s"
  | "rem_s"
  | "eq"
  | "ne"
  | "lt_s"
  | "le_s"
  | "gt_s"
  | "ge_s"
  | "select"
  | "load"
  | "load8_u"
  | "trap";

export type Prim = `${ValType}.${PrimOp}`;

export function Prim() {}

export function specialize_prim_for_operands(
  prim: Prim,
  left_type: ValType | undefined,
  right_type: ValType | undefined,
): Prim {
  const op = binary_numeric_op(prim);

  if (!op) {
    return prim;
  }

  if (left_type === "i64" || right_type === "i64") {
    if (left_type === "i32" || right_type === "i32") {
      throw new Error(
        "Mixed i32 and i64 operands for operator " + prim_op_text(op),
      );
    }

    return prim_for_type("i64", op);
  }

  if (left_type === "i32" && right_type === "i32") {
    return prim_for_type("i32", op);
  }

  return prim;
}

function binary_numeric_op(prim: Prim): PrimOp | undefined {
  switch (prim) {
    case "i32.add":
    case "i64.add":
      return "add";

    case "i32.sub":
    case "i64.sub":
      return "sub";

    case "i32.mul":
    case "i64.mul":
      return "mul";

    case "i32.div_s":
    case "i64.div_s":
      return "div_s";

    case "i32.rem_s":
    case "i64.rem_s":
      return "rem_s";

    case "i32.eq":
    case "i64.eq":
      return "eq";

    case "i32.ne":
    case "i64.ne":
      return "ne";

    case "i32.lt_s":
    case "i64.lt_s":
      return "lt_s";

    case "i32.le_s":
    case "i64.le_s":
      return "le_s";

    case "i32.gt_s":
    case "i64.gt_s":
      return "gt_s";

    case "i32.ge_s":
    case "i64.ge_s":
      return "ge_s";

    case "i32.select":
    case "i64.select":
    case "i32.load":
    case "i64.load":
    case "i32.load8_u":
    case "i64.load8_u":
    case "i32.trap":
    case "i64.trap":
      return undefined;
  }
}

function prim_op_text(op: PrimOp): string {
  switch (op) {
    case "add":
      return "+";
    case "sub":
      return "-";
    case "mul":
      return "*";
    case "div_s":
      return "/";
    case "rem_s":
      return "%";
    case "eq":
      return "==";
    case "ne":
      return "!=";
    case "lt_s":
      return "<";
    case "le_s":
      return "<=";
    case "gt_s":
      return ">";
    case "ge_s":
      return ">=";
    case "select":
      return "select";
    case "load":
      return "load";
    case "load8_u":
      return "load8_u";
    case "trap":
      return "trap";
  }
}

function prim_for_type(type: ValType, op: PrimOp): Prim {
  if (type === "i64") {
    switch (op) {
      case "add":
        return "i64.add";
      case "sub":
        return "i64.sub";
      case "mul":
        return "i64.mul";
      case "div_s":
        return "i64.div_s";
      case "rem_s":
        return "i64.rem_s";
      case "eq":
        return "i64.eq";
      case "ne":
        return "i64.ne";
      case "lt_s":
        return "i64.lt_s";
      case "le_s":
        return "i64.le_s";
      case "gt_s":
        return "i64.gt_s";
      case "ge_s":
        return "i64.ge_s";
      case "select":
        return "i64.select";
      case "load":
        return "i64.load";
      case "load8_u":
        return "i64.load8_u";
      case "trap":
        return "i64.trap";
    }
  }

  switch (op) {
    case "add":
      return "i32.add";
    case "sub":
      return "i32.sub";
    case "mul":
      return "i32.mul";
    case "div_s":
      return "i32.div_s";
    case "rem_s":
      return "i32.rem_s";
    case "eq":
      return "i32.eq";
    case "ne":
      return "i32.ne";
    case "lt_s":
      return "i32.lt_s";
    case "le_s":
      return "i32.le_s";
    case "gt_s":
      return "i32.gt_s";
    case "ge_s":
      return "i32.ge_s";
    case "select":
      return "i32.select";
    case "load":
      return "i32.load";
    case "load8_u":
      return "i32.load8_u";
    case "trap":
      return "i32.trap";
  }
}

Prim.fmt = function fmt(prim: Prim): string {
  switch (prim) {
    case "i32.add":
    case "i64.add":
      return "+";

    case "i32.sub":
    case "i64.sub":
      return "-";

    case "i32.mul":
    case "i64.mul":
      return "*";

    case "i32.div_s":
    case "i64.div_s":
      return "/";

    case "i32.rem_s":
    case "i64.rem_s":
      return "%";

    case "i32.eq":
    case "i64.eq":
      return "==";

    case "i32.ne":
    case "i64.ne":
      return "!=";

    case "i32.lt_s":
    case "i64.lt_s":
      return "<";

    case "i32.le_s":
    case "i64.le_s":
      return "<=";

    case "i32.gt_s":
    case "i64.gt_s":
      return ">";

    case "i32.ge_s":
    case "i64.ge_s":
      return ">=";

    case "i32.select":
    case "i64.select":
      return "select";

    case "i32.load":
    case "i64.load":
      return "load";

    case "i32.load8_u":
    case "i64.load8_u":
      return "load8_u";

    case "i32.trap":
    case "i64.trap":
      return "trap";
  }
};

Prim.type = function type(prim: Prim): CallableType<ValType> {
  switch (prim) {
    case "i32.add":
    case "i32.sub":
    case "i32.mul":
    case "i32.div_s":
    case "i32.rem_s":
      return { args: ["i32", "i32"], result: "i32" };

    case "i32.eq":
    case "i32.ne":
    case "i32.lt_s":
    case "i32.le_s":
    case "i32.gt_s":
    case "i32.ge_s":
      return { args: ["i32", "i32"], result: "i32" };

    case "i32.select":
      return { args: ["i32", "i32", "i32"], result: "i32" };

    case "i32.load":
      return { args: ["i32"], result: "i32" };

    case "i32.load8_u":
      return { args: ["i32"], result: "i32" };

    case "i32.trap":
      return { args: [], result: "i32" };

    case "i64.add":
    case "i64.sub":
    case "i64.mul":
    case "i64.div_s":
    case "i64.rem_s":
      return { args: ["i64", "i64"], result: "i64" };

    case "i64.eq":
    case "i64.ne":
    case "i64.lt_s":
    case "i64.le_s":
    case "i64.gt_s":
    case "i64.ge_s":
      return { args: ["i64", "i64"], result: "i32" };

    case "i64.select":
      return { args: ["i64", "i64", "i32"], result: "i64" };

    case "i64.load":
      return { args: ["i32"], result: "i64" };

    case "i64.load8_u":
      return { args: ["i32"], result: "i64" };

    case "i64.trap":
      return { args: [], result: "i64" };
  }
};

Prim.arity = function arity(prim: Prim): number {
  if (prim === "i32.trap" || prim === "i64.trap") {
    return 0;
  }

  if (prim === "i32.select" || prim === "i64.select") {
    return 3;
  }

  if (
    prim === "i32.load" || prim === "i64.load" ||
    prim === "i32.load8_u" || prim === "i64.load8_u"
  ) {
    return 1;
  }

  return 2;
};

Prim.emit = function emit(prim: Prim): string {
  if (prim === "i32.trap" || prim === "i64.trap") {
    return "unreachable";
  }

  if (prim === "i32.select" || prim === "i64.select") {
    return "select";
  }

  return prim;
};

Format.register<Prim>(Prim);
Callable.register<Prim, ValType>(Prim);
Emit.register<Prim, string>(Prim);
