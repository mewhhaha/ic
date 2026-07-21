import { expect } from "../expect.ts";
import type {
  Declaration,
  EffectDeclaration,
  Field,
  FrontExpr,
  Stmt,
  TypeDeclaration,
  TypeExpr,
  TypeField,
} from "./ast.ts";
import { is_builtin_type_reference_name } from "./parser_support.ts";
import {
  sem_type_finite_members,
  sem_type_from_expr,
  type SemType,
} from "./semantic_type.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";
import {
  integer_type_from_name,
  integer_type_name,
  type IntegerType,
} from "../integer.ts";

export function type_declaration_bindings(
  declarations: Declaration[],
  effects: Map<string, EffectDeclaration>,
): Stmt[] {
  validate_declaration_names(declarations);
  const result: Stmt[] = [];
  const type_declarations = new Map<string, TypeDeclaration>();

  for (const declaration of declarations) {
    if (declaration.tag === "type") {
      type_declarations.set(declaration.name, declaration);
    }
  }

  for (const declaration of ordered_type_declarations(declarations)) {
    result.push(
      type_declaration_binding(declaration, effects, type_declarations),
    );
  }

  return result;
}

function type_declaration_binding(
  declaration: TypeDeclaration,
  effects: Map<string, EffectDeclaration>,
  type_declarations: Map<string, TypeDeclaration>,
): Stmt {
  let fields: TypeField[] = [];

  if (
    declaration.body.tag === "product" || declaration.body.tag === "packed"
  ) {
    fields = declaration.body.fields;
  } else if (declaration.body.tag === "sum") {
    fields = declaration.body.cases;
  }

  for (const field of fields) {
    expect(
      parse_type_expr(tokenize(field.type_name)).tag !== "product",
      "Anonymous product row members are not supported yet: " +
        field.type_name,
    );
  }

  let value: FrontExpr;

  if (
    declaration.body.tag === "alias" &&
    alias_uses_type_set_surface(declaration.body.type_name)
  ) {
    const type_expr = parse_type_expr(tokenize(declaration.body.type_name));
    const semantic = semantic_type_for_expr(
      type_expr,
      type_declarations,
      new Set([declaration.name]),
    );
    value = front_type_value_for_semantic_type(
      declaration.name,
      type_expr,
      semantic,
    );
  } else if (declaration.body.tag === "product") {
    const product = declaration.body;

    if (product.initializer !== undefined) {
      let initializer = product.initializer;

      if (
        initializer.tag === "app" && initializer.arg?.tag === "shape" &&
        initializer.args.length === 1
      ) {
        const shape: Extract<FrontExpr, { tag: "shape" }> = {
          ...initializer.arg,
          entries: initializer.arg.entries.map((entry) => {
            const field = product.fields.find((candidate) => {
              return candidate.name === entry.label;
            });

            if (field === undefined) {
              return entry;
            }

            let storage_type_name = field.type_name;
            const nominal_type_name = nominal_product_type_name(
              storage_type_name,
              type_declarations,
              declaration.name,
            );

            if (nominal_type_name !== undefined) {
              storage_type_name = nominal_type_name;
            }

            if (effects.has(storage_type_name)) {
              storage_type_name = "I32";
            } else {
              const resolving = new Set<string>();

              while (!resolving.has(storage_type_name)) {
                resolving.add(storage_type_name);
                const alias = type_declarations.get(storage_type_name);

                if (
                  alias === undefined || alias.params.length !== 0 ||
                  alias.body.tag !== "alias" || alias.body.opaque === true ||
                  !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias.body.type_name)
                ) {
                  break;
                }

                storage_type_name = alias.body.type_name;
              }
            }

            return {
              ...entry,
              value: {
                tag: "set_type" as const,
                type_expr: {
                  tag: "name" as const,
                  name: storage_type_name,
                },
              },
            };
          }),
        };
        initializer = { ...initializer, arg: shape, args: [shape] };
      }

      value = {
        tag: "comptime",
        expr: initializer,
      };
    } else {
      value = {
        tag: "struct_type",
        fields: product.fields.map((field) => {
          if (effects.has(field.type_name)) {
            return { name: field.name, type_name: "I32" };
          }

          return field;
        }),
      };
    }
  } else if (declaration.body.tag === "sum") {
    value = { tag: "union_type", cases: declaration.body.cases };
  } else if (declaration.body.tag === "packed") {
    value = packed_type_value(declaration);
  } else {
    const names = declaration.body.type_name.split(" ");
    const first = names[0];
    expect(first, "Missing aliased type name");
    expect(
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(first),
      "Unsupported type alias expression: " + declaration.body.type_name,
    );
    value = { tag: "var", name: first };

    for (let index = 1; index < names.length; index += 1) {
      const name = names[index];
      expect(name, "Missing type alias argument " + index.toString());
      expect(
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
        "Unsupported type alias expression: " + declaration.body.type_name,
      );
      value = {
        tag: "app",
        func: value,
        args: [{ tag: "var", name }],
      };
    }

    if (declaration.body.opaque) {
      const representation = value;
      let nominal: FrontExpr = { tag: "var", name: declaration.name };

      for (const param of declaration.params) {
        nominal = {
          tag: "app",
          func: nominal,
          arg: { tag: "var", name: param },
          args: [{ tag: "var", name: param }],
        };
      }

      const wrap_value: FrontExpr = { tag: "var", name: "value" };
      const unwrap_value: FrontExpr = { tag: "var", name: "value" };
      value = {
        tag: "with",
        base: representation,
        fields: [
          {
            name: "wrap",
            value: {
              tag: "lam",
              params: [{
                name: "value",
                is_const: false,
                is_linear: false,
                annotation: undefined,
              }],
              body: {
                tag: "app",
                func: { tag: "var", name: "@seal" },
                args: [wrap_value, nominal],
              },
            },
          },
          {
            name: "unwrap",
            value: {
              tag: "lam",
              params: [{
                name: "value",
                is_const: false,
                is_linear: false,
                annotation: undefined,
              }],
              body: {
                tag: "app",
                func: { tag: "var", name: "@representation" },
                args: [unwrap_value, representation],
              },
            },
          },
        ],
      };
    }
  }

  for (let index = declaration.params.length - 1; index >= 0; index -= 1) {
    const name = declaration.params[index];
    expect(name, "Missing type parameter " + index.toString());
    value = {
      tag: "lam",
      params: [{
        name,
        is_const: false,
        is_linear: false,
        annotation: undefined,
      }],
      body: value,
    };
  }

  return {
    tag: "bind",
    kind: "const",
    name: declaration.name,
    is_linear: false,
    annotation: undefined,
    value,
  };
}

function nominal_product_type_name(
  type_name: string,
  declarations: Map<string, TypeDeclaration>,
  excluded_name: string,
): string | undefined {
  const type = parse_type_expr(tokenize(type_name));

  if (type.tag !== "product") {
    return undefined;
  }

  const expected = format_type_expr(type);

  for (const [name, declaration] of declarations) {
    if (
      name === excluded_name || declaration.params.length !== 0 ||
      declaration.body.tag !== "product"
    ) {
      continue;
    }

    const candidate: TypeExpr = {
      tag: "product",
      entries: declaration.body.fields.map((field) => ({
        label: field.name,
        type_expr: parse_type_expr(tokenize(field.type_name)),
      })),
    };

    if (format_type_expr(candidate) === expected) {
      return name;
    }
  }

  return undefined;
}

function packed_type_value(declaration: TypeDeclaration): FrontExpr {
  expect(
    declaration.body.tag === "packed",
    "Packed type value requires a packed declaration",
  );
  expect(
    declaration.body.fields.length > 0,
    "Packed type requires at least one field: " + declaration.name,
  );
  const field_types: IntegerType[] = [];
  let total_width = 0;

  for (const field of declaration.body.fields) {
    const integer = integer_type_from_name(field.type_name);
    expect(
      integer,
      "Packed field " + field.name + " must use an I<N> or U<N> type, got " +
        field.type_name,
    );
    field_types.push(integer);
    total_width += integer.width;
    expect(
      Number.isSafeInteger(total_width),
      "Packed type width exceeds the compiler integer limit: " +
        declaration.name,
    );
  }

  const representation: IntegerType = { signed: false, width: total_width };
  const representation_name = integer_type_name(representation);
  const params = declaration.body.fields.map((field, index) => ({
    name: "packed_field_" + index.toString(),
    is_const: false,
    is_linear: false,
    annotation: field.type_name,
  }));
  const pattern_entries = params.map((param) => ({
    pattern: {
      tag: "binding" as const,
      name: param.name,
      mode: "default" as const,
      annotation: param.annotation,
    },
  }));
  const first_param = params[0];
  expect(first_param, "Missing first packed field parameter");
  const first_field_type = field_types[0];
  expect(first_field_type, "Missing first packed field type");
  let packed_value = packed_field_cast_expr(
    { tag: "var", name: first_param.name },
    first_field_type,
    representation_name,
  );

  for (let index = 1; index < params.length; index += 1) {
    const param = params[index];
    const field_type = field_types[index];
    expect(param, "Missing packed parameter " + index.toString());
    expect(field_type, "Missing packed field type " + index.toString());
    packed_value = compiler_binary_expr(
      "@bit_or",
      compiler_binary_expr(
        "@shift_left",
        packed_value,
        integer_literal_expr(representation, BigInt(field_type.width)),
      ),
      packed_field_cast_expr(
        { tag: "var", name: param.name },
        field_type,
        representation_name,
      ),
    );
  }

  const fields: Field[] = [{
    name: "pack",
    value: {
      tag: "lam" as const,
      pattern: { tag: "product" as const, entries: pattern_entries },
      params,
      body: packed_value,
    },
  }];
  let trailing_width = 0;

  for (let index = declaration.body.fields.length - 1; index >= 0; index -= 1) {
    const field = declaration.body.fields[index];
    const field_type = field_types[index];
    expect(field, "Missing packed field " + index.toString());
    expect(field_type, "Missing packed field type " + index.toString());
    let extracted: FrontExpr = { tag: "var", name: "packed_value" };

    if (trailing_width > 0) {
      extracted = compiler_binary_expr(
        "@shift_right_u",
        extracted,
        integer_literal_expr(representation, BigInt(trailing_width)),
      );
    }

    extracted = integer_cast_expr(extracted, integer_type_name(field_type));
    let field_name = field.name;

    if (field_name === "") {
      field_name = "item_" + index.toString();
    }

    fields.push({
      name: field_name,
      value: {
        tag: "lam",
        params: [{
          name: "packed_value",
          is_const: false,
          is_linear: false,
          annotation: declaration.name,
        }],
        body: extracted,
      },
    });
    const replacement_name = "packed_replacement";
    const value_name = "packed_original";
    const field_mask = (1n << BigInt(field_type.width)) - 1n;
    let shifted_mask = integer_literal_expr(representation, field_mask);
    let inserted = packed_field_cast_expr(
      { tag: "var", name: replacement_name },
      field_type,
      representation_name,
    );

    if (trailing_width > 0) {
      const shift = integer_literal_expr(
        representation,
        BigInt(trailing_width),
      );
      shifted_mask = compiler_binary_expr(
        "@shift_left",
        shifted_mask,
        shift,
      );
      inserted = compiler_binary_expr("@shift_left", inserted, shift);
    }

    const full_mask = integer_literal_expr(
      representation,
      (1n << BigInt(total_width)) - 1n,
    );
    const clear_mask = compiler_binary_expr(
      "@bit_xor",
      full_mask,
      shifted_mask,
    );
    const cleared = compiler_binary_expr(
      "@bit_and",
      { tag: "var", name: value_name },
      clear_mask,
    );
    fields.push({
      name: "with_" + field_name,
      value: {
        tag: "lam",
        pattern: {
          tag: "product",
          entries: [
            {
              pattern: {
                tag: "binding",
                name: value_name,
                mode: "default",
                annotation: declaration.name,
              },
            },
            {
              pattern: {
                tag: "binding",
                name: replacement_name,
                mode: "default",
                annotation: field.type_name,
              },
            },
          ],
        },
        params: [
          {
            name: value_name,
            is_const: false,
            is_linear: false,
            annotation: declaration.name,
          },
          {
            name: replacement_name,
            is_const: false,
            is_linear: false,
            annotation: field.type_name,
          },
        ],
        body: compiler_binary_expr("@bit_or", cleared, inserted),
      },
    });
    trailing_width += field_type.width;
  }

  return {
    tag: "with",
    base: { tag: "var", name: representation_name },
    fields,
  };
}

function compiler_binary_expr(
  name: string,
  left: FrontExpr,
  right: FrontExpr,
): FrontExpr {
  const arg: FrontExpr = {
    tag: "product",
    entries: [{ value: left }, { value: right }],
  };
  return {
    tag: "app",
    func: { tag: "var", name },
    arg,
    args: [left, right],
  };
}

function integer_cast_expr(value: FrontExpr, target: string): FrontExpr {
  return {
    tag: "app",
    func: { tag: "var", name: "@integer.wrap" },
    args: [value, { tag: "var", name: target }],
  };
}

function packed_field_cast_expr(
  value: FrontExpr,
  field: IntegerType,
  representation: string,
): FrontExpr {
  if (field.signed) {
    value = integer_cast_expr(value, "U" + field.width.toString());
  }

  return integer_cast_expr(value, representation);
}

function integer_literal_expr(
  integer: IntegerType,
  value: bigint,
): FrontExpr {
  if (integer.width <= 32) {
    return { tag: "num", type: "i32", value: Number(value), integer };
  }

  return { tag: "num", type: "i64", value, integer };
}

function alias_uses_type_set_surface(text: string): boolean {
  const type = parse_type_expr(tokenize(text));
  return type_expr_uses_set_surface(type);
}

function type_expr_uses_set_surface(type: TypeExpr): boolean {
  switch (type.tag) {
    case "forall":
      return type_expr_uses_set_surface(type.body);

    case "atom":
    case "literal":
    case "top":
    case "never":
    case "frozen":
    case "borrow":
    case "union":
    case "intersection":
    case "difference":
      return true;

    case "name":
      return false;

    case "apply":
      return type_expr_uses_set_surface(type.func) ||
        type_expr_uses_set_surface(type.arg);

    case "tuple":
      for (const item of type.items) {
        if (type_expr_uses_set_surface(item)) {
          return true;
        }
      }

      return false;

    case "product":
      for (const entry of type.entries) {
        if (type_expr_uses_set_surface(entry.type_expr)) {
          return true;
        }
      }

      return false;

    case "array":
      return true;

    case "arrow":
      return type_expr_uses_set_surface(type.param) ||
        type_expr_uses_set_surface(type.result);
  }
}

function semantic_type_for_expr(
  type: TypeExpr,
  declarations: Map<string, TypeDeclaration>,
  resolving: Set<string>,
): SemType {
  return sem_type_from_expr(type, (name) => {
    const declaration = declarations.get(name);

    if (!declaration || declaration.params.length > 0) {
      return undefined;
    }

    if (resolving.has(name)) {
      throw new Error(
        "Recursive algebraic type declarations are not supported yet: " +
          [...resolving, name].join(" -> "),
      );
    }

    const next = new Set(resolving);
    next.add(name);

    if (declaration.body.tag === "product") {
      return {
        tag: "record",
        name,
        fields: declaration.body.fields.map((field) => {
          return {
            name: field.name,
            type: semantic_type_for_expr(
              parse_type_expr(tokenize(field.type_name)),
              declarations,
              next,
            ),
          };
        }),
      };
    }

    if (declaration.body.tag === "sum") {
      return { tag: "variant", name };
    }

    if (declaration.body.tag === "packed") {
      return {
        tag: "record",
        fields: declaration.body.fields.map((field) => ({
          name: field.name,
          type: semantic_type_for_expr(
            parse_type_expr(tokenize(field.type_name)),
            declarations,
            next,
          ),
        })),
      };
    }

    return semantic_type_for_expr(
      parse_type_expr(tokenize(declaration.body.type_name)),
      declarations,
      next,
    );
  });
}

export function front_type_value_for_semantic_type(
  declaration_name: string,
  source: TypeExpr,
  type: SemType,
): FrontExpr {
  if (type.tag === "record") {
    return {
      tag: "struct_type",
      fields: type.fields.map((field) => ({
        name: field.name,
        type_name: runtime_type_name(field.type, declaration_name),
      })),
    };
  }

  if (type.tag === "scalar" || type.tag === "named" || type.tag === "variant") {
    return { tag: "var", name: type.name };
  }

  if (
    type.tag === "atom" || type.tag === "literal" || type.tag === "never"
  ) {
    return { tag: "set_type", type_expr: source };
  }

  if (type.tag !== "union") {
    return { tag: "set_type", type_expr: source };
  }

  const members = sem_type_finite_members(type);
  expect(members, "Expected finite union members for " + declaration_name);
  return {
    tag: "union_type",
    cases: members.map((member, index) => ({
      name: "Set" + index.toString(),
      type_name: runtime_type_name(member, declaration_name),
      set_member: type_expr_for_semantic_type(member),
    })),
  };
}

function runtime_type_name(type: SemType, declaration_name: string): string {
  switch (type.tag) {
    case "forall":
      throw new Error(
        "Polymorphic type-set member has no runtime payload layout in " +
          declaration_name,
      );

    case "scalar":
      return type.name;

    case "atom":
      return "I32";

    case "literal":
      if (type.value.tag === "bool") {
        return "Bool";
      }

      if (type.value.tag === "text") {
        return "Text";
      }

      if (type.value.character !== undefined) {
        return "Char";
      }

      if (type.value.integer !== undefined) {
        return (type.value.integer.signed ? "I" : "U") +
          type.value.integer.width.toString();
      }

      if (type.value.type === "i64") {
        return "I64";
      }

      return "I32";

    case "named":
    case "variant":
      return type.name;

    case "apply":
      return format_type_expr(type_expr_for_semantic_type(type));

    case "record":
      if (type.name) {
        return type.name;
      }

      throw new Error(
        "Anonymous record member in runtime type set is not supported yet: " +
          declaration_name,
      );

    case "frozen":
    case "borrow":
      throw new Error(
        "Ownership-qualified runtime type-set members are not supported yet: " +
          declaration_name,
      );

    case "top":
    case "never":
    case "tuple":
    case "product":
    case "array":
    case "union":
    case "intersection":
    case "difference":
    case "arrow":
      throw new Error(
        "Type-set member has no runtime payload layout in " +
          declaration_name,
      );
  }
}

function type_expr_for_semantic_type(type: SemType): TypeExpr {
  switch (type.tag) {
    case "forall":
      return {
        tag: "forall",
        params: type.params,
        body: type_expr_for_semantic_type(type.body),
      };

    case "top":
      return { tag: "top" };

    case "never":
      return { tag: "never" };

    case "scalar":
    case "named":
    case "variant":
      return { tag: "name", name: type.name };

    case "atom":
      return { tag: "atom", name: type.name };

    case "literal":
      return { tag: "literal", value: type.value };

    case "frozen":
      return { tag: "frozen", value: type_expr_for_semantic_type(type.value) };

    case "borrow":
      return { tag: "borrow", value: type_expr_for_semantic_type(type.value) };

    case "apply":
      return {
        tag: "apply",
        func: type_expr_for_semantic_type(type.func),
        arg: type_expr_for_semantic_type(type.arg),
      };

    case "tuple":
      return {
        tag: "tuple",
        items: type.items.map(type_expr_for_semantic_type),
      };

    case "product":
      return {
        tag: "product",
        entries: type.entries.map((entry) => ({
          label: entry.label,
          type_expr: type_expr_for_semantic_type(entry.type),
        })),
      };

    case "array":
      return {
        tag: "array",
        element: type_expr_for_semantic_type(type.element),
        length: type.length,
      };

    case "union": {
      const first = type.members[0];
      expect(first, "Missing semantic union member");
      let result = type_expr_for_semantic_type(first);

      for (const member of type.members.slice(1)) {
        result = {
          tag: "union",
          left: result,
          right: type_expr_for_semantic_type(member),
        };
      }

      return result;
    }

    case "intersection": {
      const first = type.members[0];
      expect(first, "Missing semantic intersection member");
      let result = type_expr_for_semantic_type(first);

      for (const member of type.members.slice(1)) {
        result = {
          tag: "intersection",
          left: result,
          right: type_expr_for_semantic_type(member),
        };
      }

      return result;
    }

    case "difference":
      return {
        tag: "difference",
        left: type_expr_for_semantic_type(type.base),
        right: type_expr_for_semantic_type(type.removed),
      };

    case "arrow":
      return {
        tag: "arrow",
        param: type_expr_for_semantic_type(type.param),
        effects: type.effects,
        result: type_expr_for_semantic_type(type.result),
      };

    case "record":
      if (type.name) {
        return { tag: "name", name: type.name };
      }

      throw new Error("Anonymous semantic record cannot be written as a type");
  }
}

function validate_declaration_names(declarations: Declaration[]): void {
  const names = new Set<string>();

  for (const declaration of declarations) {
    if (declaration.tag === "extend" || declaration.tag === "fixity") {
      continue;
    }

    expect(
      !is_builtin_type_reference_name(declaration.name),
      "Declaration name conflicts with builtin type: " + declaration.name,
    );
    expect(
      !names.has(declaration.name),
      "Duplicate declaration name: " + declaration.name,
    );
    names.add(declaration.name);
  }
}

function ordered_type_declarations(
  declarations: Declaration[],
): TypeDeclaration[] {
  const types = new Map<string, TypeDeclaration>();

  for (const declaration of declarations) {
    if (declaration.tag === "type") {
      types.set(declaration.name, declaration);
    }
  }

  validate_recursive_type_graph(types);

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const result: TypeDeclaration[] = [];

  function visit(declaration: TypeDeclaration): void {
    const current = state.get(declaration.name);

    if (current === "done") {
      return;
    }

    if (current === "visiting") {
      return;
    }

    state.set(declaration.name, "visiting");
    stack.push(declaration.name);

    for (const name of type_declaration_references(declaration)) {
      const referenced = types.get(name);

      if (referenced) {
        visit(referenced);
      }
    }

    const popped = stack.pop();
    expect(popped === declaration.name, "Mismatched type declaration stack");
    state.set(declaration.name, "done");
    result.push(declaration);
  }

  for (const declaration of types.values()) {
    visit(declaration);
  }

  return result;
}

function validate_recursive_type_graph(
  types: Map<string, TypeDeclaration>,
): void {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function visit(declaration: TypeDeclaration): void {
    const current = state.get(declaration.name);

    if (current === "done") {
      return;
    }

    if (current === "visiting") {
      const start = stack.indexOf(declaration.name);
      expect(start >= 0, "Missing inline recursive type stack entry");
      const cycle = stack.slice(start);
      cycle.push(declaration.name);
      throw new Error(
        "Recursive type requires an indirect sum edge: " + cycle.join(" -> "),
      );
    }

    state.set(declaration.name, "visiting");
    stack.push(declaration.name);

    for (const name of type_declaration_references(declaration)) {
      const referenced = types.get(name);

      if (!referenced) {
        continue;
      }

      if (
        declaration.body.tag === "sum" || referenced.body.tag === "sum"
      ) {
        continue;
      }

      visit(referenced);
    }

    const popped = stack.pop();
    expect(popped === declaration.name, "Mismatched inline type stack");
    state.set(declaration.name, "done");
  }

  for (const declaration of types.values()) {
    visit(declaration);
  }
}

function type_declaration_references(
  declaration: TypeDeclaration,
): Set<string> {
  const texts: string[] = [];

  if (
    declaration.body.tag === "product" || declaration.body.tag === "packed"
  ) {
    for (const field of declaration.body.fields) {
      texts.push(field.type_name);
    }
  } else if (declaration.body.tag === "sum") {
    for (const union_case of declaration.body.cases) {
      texts.push(union_case.type_name);
    }
  } else {
    texts.push(declaration.body.type_name);
  }

  const result = new Set<string>();

  for (const text of texts) {
    for (const match of text.matchAll(/[A-Z][A-Za-z0-9]*/g)) {
      const name = match[0];
      expect(name, "Missing referenced type name");
      result.add(name);
    }
  }

  return result;
}
