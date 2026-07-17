import { expect } from "../expect.ts";
import type { FrontExpr, Param, Pattern, Token, TypeExpr } from "./ast.ts";
import { expect_snake_case } from "./names.ts";
import { binary_prim, numeric_expr_type } from "./numeric.ts";
import { integer_literal_fits, integer_type_name } from "../integer.ts";
import { ParserPrimary } from "./parser_primary.ts";
import { pattern_bindings } from "./pattern.ts";
import { parse_type_expr } from "./type_expr.ts";
import { record_annotation_name_sites, record_name_site } from "./name_site.ts";
import { inherit_source_span } from "./syntax.ts";
import {
  type InfixFixity,
  is_operator_symbol,
  type PrefixFixity,
} from "./fixity.ts";
import { wasm_intrinsic_prim } from "../op.ts";

export abstract class ParserExpr extends ParserPrimary {
  #stop_postfix_block = 0;
  #stop_arrow = 0;
  #stop_try_with = 0;

  protected parse_expr(): FrontExpr {
    const start = this.index;
    const expr = this.parse_arrow();
    return this.concrete_node(start, expr);
  }

  protected parse_expr_without_postfix_block(): FrontExpr {
    this.#stop_postfix_block += 1;

    try {
      return this.parse_expr();
    } finally {
      this.#stop_postfix_block -= 1;
    }
  }

  protected parse_expr_before_arrow(): FrontExpr {
    this.#stop_arrow += 1;

    try {
      return this.parse_expr();
    } finally {
      this.#stop_arrow -= 1;
    }
  }

  private parse_arrow(): FrontExpr {
    const start = this.index;
    const expr = this.parse_arrow_inner(start);
    return this.concrete_node(start, expr);
  }

  private parse_arrow_inner(source_offset: number): FrontExpr {
    if (
      this.#stop_arrow === 0 && this.peek().kind === "name" &&
      this.peek().text === "rec" && this.starts_pattern_arrow(1)
    ) {
      this.expect_name("Expected rec");
      const pattern = this.parse_pattern();
      this.expect_symbol("=>");
      return {
        tag: "rec",
        pattern,
        params: pattern_params(pattern, source_offset),
        body: this.parse_arrow_body(pattern),
      };
    }

    if (this.#stop_arrow === 0 && this.starts_pattern_arrow()) {
      const pattern = this.parse_pattern();
      this.expect_symbol("=>");
      return {
        tag: "lam",
        pattern,
        params: pattern_params(pattern, source_offset),
        body: this.parse_arrow_body(pattern),
      };
    }

    return this.parse_binary(0);
  }

  private parse_arrow_body(pattern: Pattern): FrontExpr {
    const previous = this.affine_call_names;
    this.affine_call_names = new Set(previous);

    for (const binding of pattern_bindings(pattern)) {
      if (binding.mode === "linear") {
        this.affine_call_names.add(binding.name);
      } else {
        this.affine_call_names.delete(binding.name);
      }
    }

    try {
      return this.parse_closure_body();
    } finally {
      this.affine_call_names = previous;
    }
  }

  private parse_closure_body(): FrontExpr {
    if (this.peek().kind === "symbol" && this.peek().text === "{") {
      return this.parse_block();
    }

    return this.parse_expr();
  }

  private parse_binary(
    min_precedence: number,
    equal_parent?: InfixFixity,
  ): FrontExpr {
    const start = this.index;
    const expr = this.parse_binary_inner(min_precedence, equal_parent);
    return this.concrete_node(start, expr);
  }

  private parse_binary_inner(
    min_precedence: number,
    equal_parent?: InfixFixity,
  ): FrontExpr {
    let left = this.parse_unary();
    let previous_fixity: InfixFixity | undefined;

    while (true) {
      const token = this.peek();
      const type_operator = token.kind === "name" &&
        (token.text === "is" || token.text === "as");

      if (token.kind !== "symbol" && !type_operator) {
        break;
      }

      const fixity = this.infix_fixity(token.text);
      let precedence = -1;

      if (fixity !== undefined) {
        precedence = fixity.precedence;
      }

      if (token.text === "is") {
        precedence = 40;
      } else if (token.text === "as") {
        precedence = 80;
      }

      if (precedence < min_precedence) {
        if (
          token.kind === "symbol" && is_operator_symbol(token.text) &&
          fixity === undefined
        ) {
          throw this.error("Undeclared infix operator: " + token.text);
        }

        break;
      }

      if (type_operator) {
        this.advance();
        const type_expr = this.parse_type_operand();

        if (token.text === "is") {
          left = { tag: "is", value: left, type_expr };
        } else {
          left = { tag: "as", value: left, type_expr };
        }
        continue;
      }

      expect(fixity, "Missing infix fixity for " + token.text);
      this.reject_mixed_associativity(equal_parent, fixity);
      this.reject_mixed_associativity(previous_fixity, fixity);
      const op = this.advance().text;
      let right_precedence = precedence + 1;

      if (fixity.associativity === "right") {
        right_precedence = precedence;
      }

      const right = this.parse_binary(right_precedence, fixity);

      if (fixity.builtin && fixity.target === "@syntax.and") {
        left = {
          tag: "if",
          cond: left,
          then_branch: normalize_boolean_expr(right),
          else_branch: { tag: "bool", value: false },
        };
      } else if (fixity.builtin && fixity.target === "@syntax.or") {
        left = {
          tag: "if",
          cond: left,
          then_branch: { tag: "bool", value: true },
          else_branch: normalize_boolean_expr(right),
        };
      } else if (fixity.builtin) {
        const prim = binary_prim(
          syntax_binary_operator(fixity.target),
          left,
          right,
        );

        if (prim) {
          left = { tag: "prim", prim, left, right };
        } else {
          left = { tag: "unsupported", feature: "operator " + op, text: op };
        }
      } else {
        const application: FrontExpr = {
          tag: "app",
          func: qualified_target(fixity.target),
          arg: {
            tag: "product",
            entries: [{ value: left }, { value: right }],
          },
          args: [left, right],
          operator_syntax: {
            kind: "infix",
            operator: op,
            precedence,
            associativity: fixity.associativity,
            target: fixity.target,
          },
        };

        left = application;
      }

      previous_fixity = fixity;
    }

    return left;
  }

  private reject_mixed_associativity(
    left: InfixFixity | undefined,
    right: InfixFixity,
  ): void {
    if (left === undefined || left.precedence !== right.precedence) {
      return;
    }

    if (
      left.associativity === right.associativity &&
      left.associativity !== "none"
    ) {
      return;
    }

    throw this.error(
      "Conflicting associativity at precedence " +
        right.precedence.toString() + ": " + left.operator + " and " +
        right.operator,
    );
  }

  private parse_type_operand(): TypeExpr {
    const tokens: Token[] = [];
    let parens = 0;
    let brackets = 0;

    while (!this.is("eof")) {
      const token = this.peek();

      if (token.kind === "newline" && token.raw !== ";") {
        break;
      }

      if (
        parens === 0 && brackets === 0 && token.kind === "name" &&
        (token.text === "as" || token.text === "is" || token.text === "with")
      ) {
        break;
      }

      if (parens === 0 && brackets === 0 && token.kind === "symbol") {
        if (
          token.text === "{" || token.text === "}" || token.text === ")" ||
          token.text === "]" || token.text === "," || token.text === "=" ||
          this.infix_fixity(token.text) !== undefined
        ) {
          break;
        }
      }

      if (token.kind === "symbol" && token.text === "(") {
        parens += 1;
      } else if (token.kind === "symbol" && token.text === ")") {
        parens -= 1;
      } else if (token.kind === "symbol" && token.text === "[") {
        brackets += 1;
      } else if (token.kind === "symbol" && token.text === "]") {
        brackets -= 1;
      }

      tokens.push(this.advance());
    }

    expect(tokens.length > 0, "Expected type after type operator");
    const type_expr = parse_type_expr(tokens);
    record_annotation_name_sites(type_expr, tokens);
    return type_expr;
  }

  private parse_unary(): FrontExpr {
    const start = this.index;
    const expr = this.parse_unary_inner();
    return this.concrete_node(start, expr);
  }

  private parse_unary_inner(): FrontExpr {
    if (this.match_name("try")) {
      this.#stop_try_with += 1;
      let body: FrontExpr;

      try {
        body = this.parse_expr();
      } finally {
        this.#stop_try_with -= 1;
      }

      if (!this.match_name("with")) {
        throw this.error("Expected with after try expression");
      }

      return { tag: "try_with", body, handler: this.parse_expr() };
    }

    if (this.match_symbol("&")) {
      return { tag: "borrow", value: this.parse_unary() };
    }

    if (this.match_name("freeze")) {
      return { tag: "freeze", value: this.parse_unary() };
    }

    if (this.match_name("scratch")) {
      if (this.peek().kind !== "symbol" || this.peek().text !== "{") {
        throw this.error("Expected scratch block");
      }

      return { tag: "scratch", body: this.parse_block() };
    }

    const prefix_token = this.peek();
    let fixity: PrefixFixity | undefined;

    if (prefix_token.kind === "symbol") {
      fixity = this.prefix_fixity(prefix_token.text);

      if (fixity !== undefined && !fixity.builtin) {
        this.advance();
        const value = this.parse_binary(fixity.precedence);
        return {
          tag: "app",
          func: qualified_target(fixity.target),
          arg: value,
          args: [value],
          operator_syntax: {
            kind: "prefix",
            operator: prefix_token.text,
            precedence: fixity.precedence,
            target: fixity.target,
          },
        };
      }
    }

    if (fixity?.target === "@syntax.negate") {
      this.advance();
      this.allow_signed_minimum_literal += 1;
      let right: FrontExpr;

      try {
        right = this.parse_unary();
      } finally {
        this.allow_signed_minimum_literal -= 1;
      }

      if (right.tag === "num") {
        if (right.type === "i64") {
          expect(typeof right.value === "bigint", "Expected i64 literal");
          const negated: FrontExpr = {
            tag: "num",
            type: "i64",
            value: -right.value,
            integer: right.integer,
          };
          validate_negated_integer_literal(negated);
          return negated;
        }

        if (right.type === "f32") {
          expect(typeof right.value === "number", "Expected f32 literal");
          return { tag: "num", type: "f32", value: Math.fround(-right.value) };
        }

        if (right.type === "f64") {
          expect(typeof right.value === "number", "Expected f64 literal");
          return { tag: "num", type: "f64", value: -right.value };
        }

        expect(typeof right.value === "number", "Expected i32 literal");
        const negated: FrontExpr = {
          tag: "num",
          type: "i32",
          value: -right.value,
          integer: right.integer,
        };
        validate_negated_integer_literal(negated);
        return negated;
      }

      if (numeric_expr_type(right) === "i64") {
        return {
          tag: "prim",
          prim: "i64.sub",
          left: { tag: "num", type: "i64", value: 0n },
          right,
        };
      }

      if (numeric_expr_type(right) === "f32") {
        return {
          tag: "prim",
          prim: "f32.sub",
          left: { tag: "num", type: "f32", value: 0 },
          right,
        };
      }

      if (numeric_expr_type(right) === "f64") {
        return {
          tag: "prim",
          prim: "f64.sub",
          left: { tag: "num", type: "f64", value: 0 },
          right,
        };
      }

      return {
        tag: "prim",
        prim: "i32.sub",
        left: { tag: "num", type: "i32", value: 0 },
        right,
      };
    }

    if (fixity?.target === "@syntax.not") {
      const next = this.peek(1);
      const after = this.peek(2);
      const non_affine_call = next.kind === "name" &&
        after.kind === "symbol" && after.text === "(" &&
        next.text !== "resume" &&
        !this.affine_call_names.has(next.text);
      const boolean_literal = next.kind === "name" &&
        (next.text === "true" || next.text === "false");

      if (next.kind === "symbol" || non_affine_call || boolean_literal) {
        this.advance();
        return {
          tag: "if",
          cond: this.parse_unary(),
          then_branch: { tag: "bool", value: false },
          else_branch: { tag: "bool", value: true },
        };
      }
    }

    return this.parse_application();
  }

  private parse_application(): FrontExpr {
    let expr = this.parse_postfix();

    while (this.starts_application_argument()) {
      const arg = this.parse_postfix();
      expr = this.apply_unary_product(expr, arg);
    }

    return expr;
  }

  private apply_unary_product(func: FrontExpr, arg: FrontExpr): FrontExpr {
    if (func.tag !== "var" || !func.name.startsWith("@wasm.")) {
      if (arg.tag === "unit") {
        return { tag: "app", func, arg, args: [] };
      }

      return { tag: "app", func, arg, args: [arg] };
    }

    const prim = wasm_intrinsic_prim(func.name.slice("@wasm.".length));

    if (prim === undefined) {
      throw this.error("Unknown Wasm intrinsic: " + func.name);
    }

    const args = unary_product_args(arg);

    if (args.length !== 2) {
      throw this.error(
        "Wasm intrinsic " + func.name + " expects a product of 2 values, got " +
          args.length.toString(),
      );
    }

    const left = args[0];
    const right = args[1];
    expect(left, "Missing Wasm intrinsic left operand");
    expect(right, "Missing Wasm intrinsic right operand");
    return { tag: "prim", prim, left, right };
  }

  private starts_application_argument(): boolean {
    const token = this.peek();

    if (
      token.kind === "number" || token.kind === "string" ||
      token.kind === "character"
    ) {
      return true;
    }

    if (token.kind === "name") {
      return token.text !== "as" && token.text !== "is" &&
        token.text !== "with" && token.text !== "else" &&
        token.text !== "by" && token.text !== "in" &&
        token.text !== "if" && token.text !== "where";
    }

    return token.kind === "symbol" &&
      (token.text === "(" || token.text === "[" || token.text === "." ||
        token.text === "#" || token.text === "@" ||
        (token.text === "{" && this.is_shape_literal()));
  }

  private parse_postfix(): FrontExpr {
    const start = this.index;
    const expr = this.parse_postfix_inner();
    return this.concrete_node(start, expr);
  }

  private parse_postfix_inner(): FrontExpr {
    let expr = this.parse_primary();

    while (true) {
      if (this.match_symbol("(")) {
        const call = this.parse_parenthesized_call();
        expr = { tag: "app", func: expr, arg: call.arg, args: call.args };
      } else if (this.match_symbol(".")) {
        const token = this.peek();
        const name = this.expect_name("Expected field name");

        if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
          expect_snake_case(name, "Field");
        } else if (expr.tag !== "var" || !/^[A-Z]/.test(expr.name)) {
          expect_snake_case(name, "Field");
        }

        if (expr.tag === "var" && expr.name === "Bytes") {
          if (name === "empty") {
            expr = { tag: "text", value: "", encoding: "bytes" };
          } else if (name === "generate") {
            expr = { tag: "var", name: "@Bytes.generate" };
          } else {
            const field = { tag: "field" as const, object: expr, name };
            record_name_site(field, "name", name, token.span);
            expr = field;
          }
        } else if (expr.tag === "var" && expr.name === "Utf8") {
          if (name === "encode" || name === "decode") {
            expr = { tag: "var", name: "Utf8." + name };
          } else {
            const field = { tag: "field" as const, object: expr, name };
            record_name_site(field, "name", name, token.span);
            expr = field;
          }
        } else {
          const field = { tag: "field" as const, object: expr, name };
          record_name_site(field, "name", name, token.span);
          expr = field;
        }
      } else if (
        this.peek().kind === "symbol" && this.peek().text === "[" &&
        !this.has_whitespace_before_current_token()
      ) {
        this.expect_symbol("[");
        const index = this.parse_expr();
        this.expect_symbol("]");
        expr = { tag: "index", object: expr, index };
      } else if (
        this.#stop_postfix_block === 0 && this.peek().kind === "symbol" &&
        this.peek().text === "{"
      ) {
        if (this.is_shape_literal()) {
          break;
        }

        if (
          expr.tag === "var" &&
          (this.effect_names.has(expr.name) ||
            this.effect_instance_names.has(expr.name) ||
            /^[A-Z][A-Za-z0-9]*$/.test(expr.name))
        ) {
          expr = this.parse_effect_handler_literal(expr.name);
        } else {
          throw this.error(
            "Runtime products use contextual `[...]` values; updates use " +
              "the source-defined type extension operator",
          );
        }
      } else if (
        this.#stop_try_with > 0 && this.peek().kind === "name" &&
        this.peek().text === "with"
      ) {
        break;
      } else if (
        this.peek().kind === "name" && this.peek().text === "with"
      ) {
        throw this.error("`with` is reserved for `try ... with ...`");
      } else {
        break;
      }
    }

    return expr;
  }

  private has_whitespace_before_current_token(): boolean {
    const previous = this.tokens[this.index - 1];

    if (previous === undefined) {
      return false;
    }

    return previous.span.end < this.peek().span.start;
  }
}

function validate_negated_integer_literal(expr: FrontExpr): void {
  if (expr.tag !== "num" || !expr.integer) {
    return;
  }

  let value: bigint;

  if (typeof expr.value === "bigint") {
    value = expr.value;
  } else {
    value = BigInt(expr.value);
  }

  if (!integer_literal_fits(expr.integer, value)) {
    throw new Error(
      "Integer literal " + value.toString() + " is out of range for " +
        integer_type_name(expr.integer),
    );
  }
}

function syntax_binary_operator(target: string): string {
  switch (target) {
    case "@syntax.eq":
      return "==";
    case "@syntax.ne":
      return "!=";
    case "@syntax.lt":
      return "<";
    case "@syntax.le":
      return "<=";
    case "@syntax.gt":
      return ">";
    case "@syntax.ge":
      return ">=";
    case "@syntax.add":
      return "+";
    case "@syntax.sub":
      return "-";
    case "@syntax.mul":
      return "*";
    case "@syntax.div":
      return "/";
    case "@syntax.rem":
      return "%";
    default:
      throw new Error("Unknown source operator target: " + target);
  }
}

function qualified_target(target: string): FrontExpr {
  if (target.startsWith("@")) {
    return { tag: "var", name: target };
  }

  const names = target.split(".");
  const first = names[0];
  expect(first, "Missing qualified operator target");
  let expr: FrontExpr = { tag: "var", name: first };

  for (const name of names.slice(1)) {
    expect(name.length > 0, "Empty qualified operator target member");
    expr = { tag: "field", object: expr, name };
  }

  return expr;
}

function normalize_boolean_expr(expr: FrontExpr): FrontExpr {
  return {
    tag: "if",
    cond: expr,
    then_branch: { tag: "bool", value: true },
    else_branch: { tag: "bool", value: false },
  };
}

function pattern_params(pattern: Pattern, source_offset: number): Param[] {
  if (pattern.tag === "unit") {
    return [];
  }

  if (
    pattern.tag === "binding" ||
    (pattern.tag === "product" &&
      (pattern.value_pack === true ||
        product_pattern_binds_every_leaf(pattern)))
  ) {
    if (pattern.tag === "product") {
      return product_pattern_params(pattern, source_offset, { next: 0 });
    }

    return pattern_bindings(pattern).map((binding) => {
      const param: Param = {
        name: binding.name,
        is_const: binding.mode === "const",
        is_linear: binding.mode === "linear",
        annotation: binding.annotation,
      };

      if (binding.type_annotation) {
        param.type_annotation = binding.type_annotation;
      }

      return inherit_source_span(param, binding);
    });
  }

  if (
    pattern.tag === "literal" || pattern.tag === "value" ||
    pattern.tag === "wildcard" || pattern.tag === "type" ||
    pattern.tag === "union_case" || pattern.tag === "product" ||
    pattern.tag === "record" || pattern.tag === "array"
  ) {
    const param: Param = {
      name: "_pattern#param" + source_offset.toString(),
      is_const: pattern.tag === "value" || pattern.tag === "type",
      is_linear: false,
      annotation: undefined,
    };
    return [inherit_source_span(param, pattern)];
  }

  pattern satisfies never;
  throw new Error("Unsupported function pattern");
}

function product_pattern_params(
  pattern: Extract<Pattern, { tag: "product" }>,
  source_offset: number,
  ignored: { next: number },
): Param[] {
  const params: Param[] = [];

  for (const entry of pattern.entries) {
    if (entry.pattern.tag === "binding") {
      const param: Param = {
        name: entry.pattern.name,
        is_const: entry.pattern.mode === "const",
        is_linear: entry.pattern.mode === "linear",
        annotation: entry.pattern.annotation,
      };

      if (entry.pattern.type_annotation !== undefined) {
        param.type_annotation = entry.pattern.type_annotation;
      }

      params.push(inherit_source_span(param, entry.pattern));
      continue;
    }

    if (entry.pattern.tag === "wildcard") {
      const param: Param = {
        name: "_pattern#ignored" + source_offset.toString() + "#" +
          ignored.next.toString(),
        is_const: entry.pattern.mode === "const",
        is_linear: false,
        annotation: undefined,
      };
      ignored.next += 1;
      params.push(inherit_source_span(param, entry.pattern));
      continue;
    }

    if (entry.pattern.tag === "product") {
      params.push(
        ...product_pattern_params(entry.pattern, source_offset, ignored),
      );
      continue;
    }

    throw new Error("Unsupported flattened product function pattern");
  }

  return params;
}

function product_pattern_binds_every_leaf(
  pattern: Extract<Pattern, { tag: "product" }>,
): boolean {
  return pattern.entries.every((entry) => {
    if (entry.pattern.tag === "binding") {
      return true;
    }

    if (entry.pattern.tag === "wildcard") {
      return true;
    }

    if (entry.pattern.tag === "product") {
      return product_pattern_binds_every_leaf(entry.pattern);
    }

    return false;
  });
}

function unary_product_args(arg: FrontExpr): FrontExpr[] {
  if (arg.tag === "unit") {
    return [];
  }

  if (arg.tag === "product") {
    if (arg.entries.some((entry) => entry.label !== undefined)) {
      return [arg];
    }

    return arg.entries.map((entry) => entry.value);
  }

  return [arg];
}
