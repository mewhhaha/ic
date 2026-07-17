import { expect } from "../expect.ts";
import type {
  ArrayLengthExpr,
  EffectRowExpr,
  Token,
  TypeExpr,
  TypeProductEntry,
} from "./ast.ts";
import { is_snake_case } from "./names.ts";
import { format_effect_row } from "./effect_row.ts";

export function parse_type_expr(tokens: Token[]): TypeExpr {
  const parser = new TypeExprParser(tokens);
  const type = parser.parse_arrow();
  expect(parser.is_end(), "Unexpected token in type annotation");
  return type;
}

export function format_type_expr(type: TypeExpr): string {
  return format(type, 0);
}

export function function_type_expr(
  type: TypeExpr | undefined,
): Extract<TypeExpr, { tag: "arrow" }> | undefined {
  let current = type;

  while (current?.tag === "forall") {
    current = current.body;
  }

  if (current?.tag === "arrow") {
    return current;
  }

  return undefined;
}

class TypeExprParser {
  private index = 0;

  constructor(private tokens: Token[]) {}

  is_end(): boolean {
    const token = this.peek();
    return !token || token.kind === "eof";
  }

  parse_arrow(): TypeExpr {
    const token = this.peek();

    if (token?.kind === "name" && token.text === "forall") {
      this.index += 1;
      const params: string[] = [];

      while (true) {
        const param = this.peek();

        if (param?.kind !== "name") {
          break;
        }

        expect(
          is_snake_case(param.text) && param.text !== "_",
          "Forall type parameter must use snake_case: " + param.text,
        );
        expect(
          !params.includes(param.text),
          "Duplicate forall type parameter: " + param.text,
        );
        params.push(param.text);
        this.index += 1;
      }

      expect(params.length > 0, "Forall type requires at least one parameter");
      this.expect_symbol(".");
      return { tag: "forall", params, body: this.parse_arrow() };
    }

    const param = this.parse_union();

    if (!this.match_symbol("->")) {
      return param;
    }

    let effects: EffectRowExpr | undefined;

    if (this.match_symbol("<")) {
      effects = this.parse_effect_row_union();
      this.expect_symbol(">");
    }

    return {
      tag: "arrow",
      param,
      effects,
      result: this.parse_arrow(),
    };
  }

  private parse_union(): TypeExpr {
    let type = this.parse_intersection();

    while (this.match_set_operator("|", ":|")) {
      type = { tag: "union", left: type, right: this.parse_intersection() };
    }

    return type;
  }

  private parse_intersection(): TypeExpr {
    let type = this.parse_difference();

    while (this.match_set_operator("&", ":&")) {
      type = {
        tag: "intersection",
        left: type,
        right: this.parse_difference(),
      };
    }

    return type;
  }

  private parse_difference(): TypeExpr {
    let type = this.parse_apply();

    while (this.match_set_operator("\\", ":-")) {
      type = {
        tag: "difference",
        left: type,
        right: this.parse_apply(),
      };
    }

    return type;
  }

  private parse_apply(): TypeExpr {
    let type = this.parse_prefix();

    while (this.starts_atom()) {
      type = { tag: "apply", func: type, arg: this.parse_prefix() };
    }

    return type;
  }

  private parse_prefix(): TypeExpr {
    if (this.match_symbol("#")) {
      return this.parse_hash_type();
    }

    if (this.match_symbol("&")) {
      return { tag: "borrow", value: this.parse_prefix_value() };
    }

    return this.parse_atom();
  }

  private parse_hash_type(): TypeExpr {
    if (this.match_symbol("(")) {
      const value = this.parse_arrow();
      this.expect_symbol(")");
      return { tag: "frozen", value };
    }

    const token = this.peek();
    expect(token && token.kind === "name", "Expected type after `#`");
    this.index += 1;
    if (is_snake_case(token.text)) {
      return { tag: "atom", name: token.text };
    }

    expect(
      /^[A-Z][A-Za-z0-9]*$/.test(token.text),
      "Frozen type name must use PascalCase: " + token.text,
    );
    return { tag: "frozen", value: { tag: "name", name: token.text } };
  }

  private parse_prefix_value(): TypeExpr {
    if (this.match_symbol("(")) {
      const value = this.parse_arrow();
      this.expect_symbol(")");
      return value;
    }

    return this.parse_atom();
  }

  private parse_atom(): TypeExpr {
    if (this.match_symbol("[")) {
      if (this.match_symbol("]")) {
        return { tag: "product", entries: [] };
      }

      const first = this.parse_product_entry();

      if (this.match_array_separator()) {
        expect(
          first.label === undefined,
          "Repeated product element cannot have a label",
        );
        const length = this.parse_array_length(0);
        this.expect_symbol("]");
        return { tag: "array", element: first.type_expr, length };
      }

      const entries = [first];

      if (this.match_symbol("]")) {
        return { tag: "product", entries };
      }

      this.expect_symbol(",");

      while (true) {
        entries.push(this.parse_product_entry());

        if (this.match_symbol("]")) {
          break;
        }

        this.expect_symbol(",");
      }

      return { tag: "product", entries };
    }

    if (this.match_symbol("(")) {
      if (this.match_symbol(")")) {
        return { tag: "product", entries: [] };
      }

      const first = this.parse_product_entry();

      if (this.match_symbol(")")) {
        if (first.label === undefined) {
          return first.type_expr;
        }

        return { tag: "product", entries: [first] };
      }

      this.expect_symbol(",");
      const entries = [first];

      while (true) {
        entries.push(this.parse_product_entry());

        if (this.match_symbol(")")) {
          break;
        }

        this.expect_symbol(",");
      }

      return { tag: "product", entries };
    }

    const token = this.peek();
    expect(token && token.kind === "name", "Expected type name");
    this.index += 1;
    if (token.text === "Never") {
      return { tag: "never" };
    }

    if (token.text === "_") {
      return { tag: "top" };
    }

    return { tag: "name", name: token.text };
  }

  private parse_product_entry(): TypeProductEntry {
    let label: string | undefined;

    if (this.match_symbol(".")) {
      const token = this.peek();
      expect(token && token.kind === "name", "Expected product type label");
      expect(
        is_snake_case(token.text),
        "Product type label must use snake_case",
      );
      this.index += 1;
      label = token.text;
      this.expect_symbol("=");
    }

    const entry: TypeProductEntry = { type_expr: this.parse_arrow() };

    if (label !== undefined) {
      entry.label = label;
    }

    return entry;
  }

  private parse_array_length(min_precedence: number): ArrayLengthExpr {
    let left = this.parse_array_length_atom();

    while (true) {
      const token = this.peek();

      if (!token || token.kind !== "symbol") {
        break;
      }

      const precedence = array_length_precedence(token.text);

      if (precedence < min_precedence) {
        break;
      }

      expect(
        token.text === "+" || token.text === "-" || token.text === "*" ||
          token.text === "/" || token.text === "%",
        "Unsupported array length operator",
      );
      this.index += 1;
      left = {
        tag: "binary",
        op: token.text,
        left,
        right: this.parse_array_length(precedence + 1),
      };
    }

    return left;
  }

  private parse_array_length_atom(): ArrayLengthExpr {
    if (this.match_symbol("(")) {
      const length = this.parse_array_length(0);
      this.expect_symbol(")");
      return length;
    }

    const token = this.peek();
    expect(token, "Expected fixed array length");

    if (token.kind === "number") {
      expect(
        /^\d+$/.test(token.text),
        "Array length must be an unsigned integer",
      );
      this.index += 1;
      return { tag: "number", value: Number(token.text) };
    }

    expect(token.kind === "name", "Expected fixed array length");
    expect(token.text !== "_", "Fixed array length cannot be inferred");
    this.index += 1;
    return { tag: "name", name: token.text };
  }

  private match_array_separator(): boolean {
    const token = this.peek();

    if (!token || token.kind !== "newline" || token.raw !== ";") {
      return false;
    }

    this.index += 1;
    return true;
  }

  private parse_effect_row_union(): EffectRowExpr {
    let row = this.parse_effect_row_intersection();

    while (this.match_set_operator("|", ":|")) {
      row = {
        tag: "union",
        left: row,
        right: this.parse_effect_row_intersection(),
      };
    }

    return row;
  }

  private parse_effect_row_intersection(): EffectRowExpr {
    let row = this.parse_effect_row_difference();

    while (this.match_set_operator("&", ":&")) {
      row = {
        tag: "intersection",
        left: row,
        right: this.parse_effect_row_difference(),
      };
    }

    return row;
  }

  private parse_effect_row_difference(): EffectRowExpr {
    let row = this.parse_effect_row_atom();

    while (this.match_set_operator("\\", ":-")) {
      row = {
        tag: "difference",
        left: row,
        right: this.parse_effect_row_atom(),
      };
    }

    return row;
  }

  private parse_effect_row_atom(): EffectRowExpr {
    if (this.match_symbol("(")) {
      const value = this.parse_effect_row_union();
      this.expect_symbol(")");
      return { tag: "group", value };
    }

    const token = this.peek();
    expect(token && token.kind === "name", "Expected effect row member");
    this.index += 1;

    if (is_snake_case(token.text)) {
      return { tag: "variable", name: token.text };
    }

    expect(
      /^[A-Z][A-Za-z0-9]*$/.test(token.text),
      "Effect name must use PascalCase: " + token.text,
    );

    if (!this.match_symbol(".")) {
      return { tag: "family", name: token.text };
    }

    const operation = this.peek();
    expect(
      operation && operation.kind === "name" && is_snake_case(operation.text),
      "Effect operation must use snake_case",
    );
    this.index += 1;
    return { tag: "operation", effect: token.text, operation: operation.text };
  }

  private starts_atom(): boolean {
    const token = this.peek();

    return token !== undefined &&
      (token.kind === "name" ||
        (token.kind === "symbol" &&
          (token.text === "(" || token.text === "#" || token.text === "[")));
  }

  private match_symbol(text: string): boolean {
    const token = this.peek();

    if (!token || token.kind !== "symbol" || token.text !== text) {
      return false;
    }

    this.index += 1;
    return true;
  }

  private match_set_operator(legacy: string, canonical: string): boolean {
    return this.match_symbol(canonical) || this.match_symbol(legacy);
  }

  private expect_symbol(text: string): void {
    expect(
      this.match_symbol(text),
      "Expected `" + text + "` in type annotation",
    );
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }
}

function format(type: TypeExpr, parent_precedence: number): string {
  if (type.tag === "name") {
    return type.name;
  }

  if (type.tag === "forall") {
    const precedence = 0;
    const text = "forall " + type.params.join(" ") + ". " +
      format(type.body, precedence);
    return parenthesize(text, precedence, parent_precedence);
  }

  if (type.tag === "atom") {
    return "#" + type.name;
  }

  if (type.tag === "top") {
    return "_";
  }

  if (type.tag === "never") {
    return "Never";
  }

  if (type.tag === "frozen" || type.tag === "borrow") {
    let prefix = "&";
    if (type.tag === "frozen") {
      prefix = "#";
    }
    const value = type.value;
    if (
      value.tag === "name" &&
      (type.tag === "borrow" || /^[A-Z][A-Za-z0-9]*$/.test(value.name))
    ) {
      return prefix + value.name;
    }

    return prefix + "(" + format(value, 0) + ")";
  }

  if (type.tag === "product") {
    const entries = type.entries.map((entry) => {
      let text = format(entry.type_expr, 0);

      if (entry.label !== undefined) {
        text = "." + entry.label + " = " + text;
      }

      return text;
    });
    return "[" + entries.join(", ") + "]";
  }

  if (type.tag === "tuple") {
    return "(" + type.items.map((item) => format(item, 0)).join(", ") + ")";
  }

  if (type.tag === "array") {
    return "[" + format(type.element, 0) + "; " +
      format_array_length(type.length, 0) + "]";
  }

  if (
    type.tag === "union" || type.tag === "intersection" ||
    type.tag === "difference"
  ) {
    let precedence = 1;
    let operator = " :| ";

    if (type.tag === "intersection") {
      precedence = 2;
      operator = " :& ";
    }

    if (type.tag === "difference") {
      precedence = 3;
      operator = " :- ";
    }

    const text = format(type.left, precedence) + operator +
      format(type.right, precedence + 1);
    return parenthesize(text, precedence, parent_precedence);
  }

  if (type.tag === "apply") {
    const precedence = 4;
    const text = format(type.func, precedence) + " " +
      format(type.arg, precedence + 1);
    return parenthesize(text, precedence, parent_precedence);
  }

  const precedence = 0;
  let text = format(type.param, precedence + 1) + " ->";

  if (type.effects) {
    text += " <" + format_effect_row(type.effects) + ">";
  }

  text += " " + format(type.result, precedence);
  return parenthesize(text, precedence, parent_precedence);
}

function array_length_precedence(op: string): number {
  if (op === "+" || op === "-") {
    return 1;
  }

  if (op === "*" || op === "/" || op === "%") {
    return 2;
  }

  return -1;
}

function format_array_length(
  length: ArrayLengthExpr,
  parent_precedence: number,
): string {
  if (length.tag === "number") {
    return length.value.toString();
  }

  if (length.tag === "name") {
    return length.name;
  }

  const precedence = array_length_precedence(length.op);
  const text = format_array_length(length.left, precedence) + " " +
    length.op + " " + format_array_length(length.right, precedence + 1);
  return parenthesize(text, precedence, parent_precedence);
}

function parenthesize(
  text: string,
  precedence: number,
  parent_precedence: number,
): string {
  if (precedence < parent_precedence) {
    return "(" + text + ")";
  }

  return text;
}
