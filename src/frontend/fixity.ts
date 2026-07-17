import { expect } from "../expect.ts";
import type { Token } from "./ast.ts";
import prelude_text from "./prelude.duck" with { type: "text" };
import functional_prelude_text from "./prelude_functional.duck" with {
  type: "text",
};
import runtime_prelude_text from "./prelude_runtime.duck" with { type: "text" };
import { tokenize } from "./tokenize.ts";

export type InfixAssociativity = "left" | "right" | "none";

export type InfixFixity = {
  kind: "infix";
  associativity: InfixAssociativity;
  precedence: number;
  operator: string;
  target: string;
  builtin: boolean;
};

export type PrefixFixity = {
  kind: "prefix";
  precedence: number;
  operator: string;
  target: string;
  builtin: boolean;
};

export type Fixity = InfixFixity | PrefixFixity;

export type FixityTable = {
  infix: Map<string, InfixFixity>;
  prefix: Map<string, PrefixFixity>;
};

const builtin_fixities: Fixity[] = [
  infix("infixr", 15, ":>", "@seal"),
  infix("infixr", 20, "||", "Bool.or"),
  infix("infixr", 30, "&&", "Bool.and"),
  infix("infix", 40, "==", "Eq.eq"),
  infix("infix", 40, "!=", "Eq.ne"),
  infix("infix", 40, "<", "Ord.lt"),
  infix("infix", 40, "<=", "Ord.le"),
  infix("infix", 40, ">", "Ord.gt"),
  infix("infix", 40, ">=", "Ord.ge"),
  infix("infixl", 60, "+", "Add.add"),
  infix("infixl", 60, "-", "Sub.sub"),
  infix("infixl", 70, "*", "Mul.mul"),
  infix("infixl", 70, "/", "Div.div"),
  infix("infixl", 70, "%", "Rem.rem"),
  prefix(80, "!", "Bool.not"),
  prefix(80, "-", "Neg.neg"),
];

const prelude_fixities = [
  prelude_text,
  runtime_prelude_text,
  functional_prelude_text,
]
  .flatMap((text) => declared_fixities(tokenize(text)));

export function collect_source_fixities(tokens: Token[]): FixityTable {
  const table = create_fixity_table();

  for (const fixity of declared_fixities(tokens)) {
    register_fixity(table, fixity);
  }

  return table;
}

function declared_fixities(tokens: Token[]): Fixity[] {
  const fixities: Fixity[] = [];
  let braces = 0;
  let brackets = 0;
  let parens = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    expect(token, "Missing token while collecting fixities");

    if (token.kind === "symbol") {
      if (token.text === "{") braces += 1;
      if (token.text === "[") brackets += 1;
      if (token.text === "(") parens += 1;
      if (token.text === "}") braces -= 1;
      if (token.text === "]") brackets -= 1;
      if (token.text === ")") parens -= 1;
      continue;
    }

    if (
      braces !== 0 || brackets !== 0 || parens !== 0 ||
      token.kind !== "name" || !is_fixity_keyword(token.text) ||
      !is_line_start(tokens, index)
    ) {
      continue;
    }

    const declaration = read_fixity(tokens, index);
    fixities.push(declaration.fixity);
    index = declaration.end;
  }

  return fixities;
}

function is_line_start(tokens: Token[], index: number): boolean {
  if (index === 0) {
    return true;
  }

  return tokens[index - 1]?.kind === "newline";
}

export function create_fixity_table(): FixityTable {
  const table: FixityTable = { infix: new Map(), prefix: new Map() };

  for (const fixity of builtin_fixities) {
    register_fixity(table, { ...fixity, builtin: true });
  }

  for (const fixity of prelude_fixities) {
    register_fixity(table, fixity);
  }

  return table;
}

export function register_fixity(table: FixityTable, fixity: Fixity): void {
  validate_precedence(fixity.precedence);
  let existing: Fixity | undefined;

  if (fixity.kind === "prefix") {
    existing = table.prefix.get(fixity.operator);
  } else {
    existing = table.infix.get(fixity.operator);
  }

  if (existing !== undefined && !existing.builtin) {
    if (same_fixity(existing, fixity)) {
      return;
    }

    throw new Error(
      "Duplicate " + fixity.kind + " operator declaration: " +
        fixity.operator,
    );
  }

  if (fixity.kind === "prefix") {
    table.prefix.set(fixity.operator, fixity);
  } else {
    table.infix.set(fixity.operator, fixity);
  }
}

function same_fixity(left: Fixity, right: Fixity): boolean {
  if (
    left.kind !== right.kind || left.precedence !== right.precedence ||
    left.operator !== right.operator || left.target !== right.target
  ) {
    return false;
  }

  if (left.kind === "prefix" && right.kind === "prefix") {
    return true;
  }

  if (left.kind === "infix" && right.kind === "infix") {
    return left.associativity === right.associativity;
  }

  return false;
}

export function fixity_keyword(fixity: Fixity): string {
  if (fixity.kind === "prefix") {
    return "prefix";
  }

  if (fixity.associativity === "left") {
    return "infixl";
  }

  if (fixity.associativity === "right") {
    return "infixr";
  }

  return "infix";
}

export function is_fixity_keyword(value: string): boolean {
  return value === "infixl" || value === "infixr" || value === "infix" ||
    value === "prefix";
}

function read_fixity(
  tokens: Token[],
  start: number,
): { fixity: Fixity; end: number } {
  const keyword = tokens[start];
  const precedence_token = tokens[start + 1];
  const operator = tokens[start + 2];
  const equals = tokens[start + 3];
  expect(keyword, "Missing fixity keyword");
  expect(
    precedence_token?.kind === "number" && /^\d+$/.test(precedence_token.text),
    "Fixity precedence must be an integer from 0 to 100",
  );
  expect(
    operator?.kind === "symbol" && is_operator_symbol(operator.text),
    "Fixity declaration requires an operator symbol",
  );
  expect(
    equals?.kind === "symbol" && equals.text === "=",
    "Fixity declaration requires `=` before its target",
  );
  const precedence = Number(precedence_token.text);
  validate_precedence(precedence);
  let index = start + 4;
  const target_parts: string[] = [];

  while (index < tokens.length) {
    const token = tokens[index];
    expect(token, "Missing fixity target token");

    if (token.kind === "newline" || token.kind === "eof") {
      break;
    }

    if (
      (target_parts.length % 2 === 0 && token.kind !== "name") ||
      (target_parts.length % 2 === 1 &&
        (token.kind !== "symbol" || token.text !== "."))
    ) {
      throw new Error("Fixity target must be a function or namespace member");
    }

    target_parts.push(token.text);
    index += 1;
  }

  expect(
    target_parts.length >= 1 && target_parts.length % 2 === 1,
    "Fixity target must be a function or namespace member",
  );
  const target = target_parts.join("");

  const trailing = tokens[index];
  expect(
    trailing?.kind === "newline" || trailing?.kind === "eof",
    "Unexpected token after fixity target: " + trailing?.text,
  );
  let fixity: Fixity;

  if (keyword.text === "prefix") {
    fixity = {
      kind: "prefix",
      precedence,
      operator: operator.text,
      target,
      builtin: false,
    };
  } else {
    fixity = infix(
      keyword.text as "infixl" | "infixr" | "infix",
      precedence,
      operator.text,
      target,
    );
  }

  return { fixity, end: index - 1 };
}

function infix(
  keyword: "infixl" | "infixr" | "infix",
  precedence: number,
  operator: string,
  target: string,
): InfixFixity {
  let associativity: InfixAssociativity = "none";

  if (keyword === "infixl") {
    associativity = "left";
  } else if (keyword === "infixr") {
    associativity = "right";
  }

  return {
    kind: "infix",
    associativity,
    precedence,
    operator,
    target,
    builtin: false,
  };
}

function prefix(
  precedence: number,
  operator: string,
  target: string,
): PrefixFixity {
  return {
    kind: "prefix",
    precedence,
    operator,
    target,
    builtin: false,
  };
}

function validate_precedence(precedence: number): void {
  expect(
    Number.isInteger(precedence) && precedence >= 0 && precedence <= 100,
    "Fixity precedence must be an integer from 0 to 100, got " + precedence,
  );
}

export function is_operator_symbol(value: string): boolean {
  return /^[:!$%&*+\/<=>?^|~\\-]+$/.test(value) &&
    value !== "=" && value !== "=>" && value !== "->" && value !== "<-" &&
    value !== "|" && value !== ":";
}
