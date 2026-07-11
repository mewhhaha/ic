import { expect } from "../expect.ts";
import type {
  Declaration,
  EffectDeclaration,
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
import { parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";

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
  if (declaration.recursive) {
    throw new Error(
      "Recursive algebraic type declarations are not supported yet: " +
        declaration.name,
    );
  }

  let fields: TypeField[] = [];

  if (declaration.body.tag === "product") {
    fields = declaration.body.fields;
  } else if (declaration.body.tag === "sum") {
    fields = declaration.body.cases;
  }

  for (const field of fields) {
    expect(
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(field.type_name),
      "Nested and applied row member types are not supported yet: " +
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
    value = {
      tag: "struct_type",
      fields: declaration.body.fields.map((field) => {
        if (effects.has(field.type_name)) {
          return { name: field.name, type_name: "I32" };
        }

        return field;
      }),
    };
  } else if (declaration.body.tag === "sum") {
    value = { tag: "union_type", cases: declaration.body.cases };
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

function alias_uses_type_set_surface(text: string): boolean {
  const type = parse_type_expr(tokenize(text));
  return type_expr_uses_set_surface(type);
}

function type_expr_uses_set_surface(type: TypeExpr): boolean {
  switch (type.tag) {
    case "atom":
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

  if (type.tag === "atom" || type.tag === "never") {
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
      name: "set_" + index.toString(),
      type_name: runtime_type_name(member, declaration_name),
      set_member: type_expr_for_semantic_type(member),
    })),
  };
}

function runtime_type_name(type: SemType, declaration_name: string): string {
  switch (type.tag) {
    case "scalar":
      return type.name;

    case "atom":
      return "I32";

    case "named":
    case "variant":
      return type.name;

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
    case "apply":
    case "tuple":
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

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const result: TypeDeclaration[] = [];

  function visit(declaration: TypeDeclaration): void {
    const current = state.get(declaration.name);

    if (current === "done") {
      return;
    }

    if (current === "visiting") {
      const start = stack.indexOf(declaration.name);
      expect(start >= 0, "Missing recursive type stack entry");
      const cycle = stack.slice(start);
      cycle.push(declaration.name);
      throw new Error(
        "Recursive algebraic type declarations are not supported yet: " +
          cycle.join(" -> "),
      );
    }

    if (declaration.recursive) {
      throw new Error(
        "Recursive algebraic type declarations are not supported yet: " +
          declaration.name,
      );
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

function type_declaration_references(
  declaration: TypeDeclaration,
): Set<string> {
  const texts: string[] = [];

  if (declaration.body.tag === "product") {
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
