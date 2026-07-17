import { expect } from "../expect.ts";
import type {
  DuckDeclaration,
  DuckMember,
  ExtensionDeclaration,
  FrontExpr,
  Source,
  TypeDeclaration,
  TypeExpr,
} from "./ast.ts";
import {
  invalidate_source_facts,
  source_facts,
  type SourceFacts,
  type SourceTypeFact,
} from "./source_facts.ts";
import { format_type_expr, parse_type_expr } from "./type_expr.ts";
import { tokenize } from "./tokenize.ts";

type DuckMemberTarget = {
  declaration: DuckDeclaration;
  member: DuckMember;
};

type DuckRoleBinding = {
  name: string;
};

function source_with_extension_values(
  source: Source,
  selected?: Set<string>,
): Source {
  const statements = [];
  let next_extension_value = 0;

  for (const declaration of source.declarations || []) {
    if (declaration.tag !== "extend") {
      continue;
    }

    for (const field of declaration.fields) {
      const name = "_duck_extension#" + next_extension_value.toString();
      next_extension_value += 1;

      if (selected !== undefined && !selected.has(name)) {
        continue;
      }

      statements.push({
        tag: "bind" as const,
        kind: "const" as const,
        name,
        is_linear: false,
        annotation: undefined,
        value: field.value,
      });
    }
  }

  return { ...source, statements: [...statements, ...source.statements] };
}

export function elaborate_front_ducks(source: Source): Source {
  const declarations = source.declarations || [];
  const ducks = new Map<string, DuckDeclaration>();
  const extensions = new Map<string, ExtensionDeclaration[]>();
  const extension_bindings = new WeakMap<FrontExpr, string>();
  const used_extension_bindings = new Set<string>();
  const types = new Map<string, TypeDeclaration>();
  let next_extension_value = 0;

  for (const declaration of declarations) {
    if (declaration.tag === "duck") {
      ducks.set(declaration.name, declaration);
      continue;
    }

    if (declaration.tag === "type") {
      types.set(declaration.name, declaration);
    }
  }

  for (const declaration of declarations) {
    if (declaration.tag !== "extend") {
      continue;
    }

    for (const field of declaration.fields) {
      extension_bindings.set(
        field.value,
        "_duck_extension#" + next_extension_value.toString(),
      );
      next_extension_value += 1;
    }

    const normalized_type_name = normalize_type_name(
      declaration.type_name,
      types,
    );
    let targets = extensions.get(normalized_type_name);

    if (targets === undefined) {
      targets = [];
      extensions.set(normalized_type_name, targets);
    }

    for (const existing of targets) {
      for (const field of declaration.fields) {
        if (
          existing.fields.some((candidate) => candidate.name === field.name)
        ) {
          throw new Error(
            "Duplicate extension member in the same scope: " +
              normalized_type_name + "." + field.name,
          );
        }
      }
    }

    targets.push(declaration);
  }

  if (ducks.size === 0 && extensions.size === 0 && types.size === 0) {
    return source;
  }

  const facts = source_facts(source_with_extension_values(source));

  for (const expr of [...facts.expressions].reverse()) {
    if (expr.tag !== "app") {
      continue;
    }

    if (
      resolve_comptime_duck_check(
        expr,
        ducks,
        extensions,
        types,
        facts,
        source,
      )
    ) {
      continue;
    }

    if (
      resolve_duck_member_call(
        expr,
        ducks,
        extensions,
        types,
        facts,
        source,
        extension_bindings,
        used_extension_bindings,
      )
    ) {
      continue;
    }

    resolve_extension_receiver_call(
      expr,
      extensions,
      types,
      facts,
      extension_bindings,
      used_extension_bindings,
    );
  }

  invalidate_source_facts(source);
  return source_with_extension_values(source, used_extension_bindings);
}

function resolve_comptime_duck_check(
  expr: Extract<FrontExpr, { tag: "app" }>,
  ducks: Map<string, DuckDeclaration>,
  extensions: Map<string, ExtensionDeclaration[]>,
  types: Map<string, TypeDeclaration>,
  facts: SourceFacts,
  source: Source,
): boolean {
  if (expr.func.tag !== "var") {
    return false;
  }

  const declaration = ducks.get(expr.func.name);

  if (declaration === undefined) {
    return false;
  }

  let role_args = expr.args;
  const packed_roles = expr.args[0];

  if (
    expr.args.length === 1 && packed_roles !== undefined &&
    packed_roles.tag === "product"
  ) {
    role_args = packed_roles.entries.map((entry) => entry.value);
  }

  if (role_args.length !== declaration.roles.length) {
    throw new Error(
      "Duck " + declaration.name + " expects " +
        declaration.roles.length.toString() + " role types, got " +
        role_args.length.toString(),
    );
  }

  const role_types = new Map<string, DuckRoleBinding>();

  for (let index = 0; index < declaration.roles.length; index += 1) {
    const role = declaration.roles[index];
    const arg = role_args[index];
    expect(role, "Missing duck role " + index.toString());
    expect(arg, "Missing duck role argument " + index.toString());

    if (arg.tag !== "var" || !/^[A-Z][A-Za-z0-9]*$/.test(arg.name)) {
      throw new Error(
        "Duck " + declaration.name + " role " + role +
          " requires a statically known type",
      );
    }

    role_types.set(role, { name: arg.name });
  }

  for (const member of declaration.members) {
    const owner = normalize_type_name(
      duck_owner_type(declaration, role_types),
      types,
    );
    const implementation = extension_member(owner, member.name, extensions);

    if (implementation === undefined) {
      throw new Error(
        "Missing duck satisfaction for " + declaration.name + "." +
          member.name + " at " + owner,
      );
    }

    bind_duck_type_members(declaration, implementation, role_types);

    validate_extension_signature(
      declaration,
      member,
      implementation.value,
      role_types,
      facts,
      types,
      source,
      undefined,
    );
  }

  const params = role_args.map((_arg, index) => ({
    name: "_duck_check#" + index.toString(),
    is_const: true,
    is_linear: false,
    annotation: undefined,
  }));
  expr.func = { tag: "lam", params, body: { tag: "unit" } };
  expr.args = role_args;
  return true;
}

function resolve_duck_member_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  ducks: Map<string, DuckDeclaration>,
  extensions: Map<string, ExtensionDeclaration[]>,
  types: Map<string, TypeDeclaration>,
  facts: SourceFacts,
  source: Source,
  extension_bindings: WeakMap<FrontExpr, string>,
  used_extension_bindings: Set<string>,
): boolean {
  const target = duck_member_target(expr.func, ducks);

  if (target === undefined) {
    return false;
  }

  const param_types = duck_member_param_types(target.member);

  let member_args = expr.args;
  const packed_args = expr.args[0];

  if (
    expr.args.length === 1 && packed_args !== undefined &&
    packed_args.tag === "product"
  ) {
    member_args = packed_args.entries.map((entry) => entry.value);
  }

  if (param_types.length !== member_args.length) {
    throw new Error(
      "Duck member " + target.declaration.name + "." + target.member.name +
        " expects " + param_types.length.toString() + " values, got " +
        member_args.length.toString(),
    );
  }

  const role_types = new Map<string, DuckRoleBinding>();

  for (let index = 0; index < param_types.length; index += 1) {
    const param_type = param_types[index];
    const arg = member_args[index];
    expect(
      param_type,
      "Missing duck member parameter type " + index.toString(),
    );
    expect(arg, "Missing duck member argument " + index.toString());
    const fact = facts.editor_type_of.get(arg);

    if (
      fact === undefined || concrete_fact_name(fact) === undefined ||
      (param_type.tag === "arrow" &&
        (fact.call_params === undefined || fact.call_result === undefined))
    ) {
      continue;
    }

    bind_duck_fact(
      target.declaration,
      target.member,
      param_type,
      fact,
      role_types,
      types,
    );
  }

  const contextual_result = facts.editor_type_of.get(expr);
  let resolved_contextual_result: SourceTypeFact | undefined;

  if (
    contextual_result !== undefined &&
    concrete_fact_name(contextual_result) !== undefined
  ) {
    resolved_contextual_result = contextual_result;
    bind_duck_fact(
      target.declaration,
      target.member,
      duck_member_result_type(target.member),
      contextual_result,
      role_types,
      types,
    );
  }

  let applied_context = false;

  for (let index = 0; index < param_types.length; index += 1) {
    const param_type = param_types[index];
    const arg = member_args[index];
    expect(
      param_type,
      "Missing duck member parameter type " + index.toString(),
    );
    expect(arg, "Missing duck member argument " + index.toString());

    if (
      apply_duck_argument_context(
        arg,
        param_type,
        target.declaration.roles,
        role_types,
      )
    ) {
      applied_context = true;
    }
  }

  if (applied_context) {
    const contextual_facts = source_facts(source_with_extension_values(source));

    for (let index = 0; index < param_types.length; index += 1) {
      const param_type = param_types[index];
      const arg = member_args[index];
      expect(
        param_type,
        "Missing contextual duck parameter " + index.toString(),
      );
      expect(arg, "Missing contextual duck argument " + index.toString());
      const fact = contextual_facts.editor_type_of.get(arg);

      if (fact === undefined || concrete_fact_name(fact) === undefined) {
        continue;
      }

      bind_duck_fact(
        target.declaration,
        target.member,
        param_type,
        fact,
        role_types,
        types,
      );
    }
  }

  const owner_role = target.declaration.roles[0];
  expect(owner_role, "Duck declaration requires an owner role");
  const owner = role_types.get(owner_role);

  if (owner === undefined) {
    throw new Error(
      "Duck obligation escapes without a statically known role: " +
        target.declaration.name + "." + target.member.name + " " + owner_role,
    );
  }

  const implementation = extension_member(
    normalize_type_name(owner.name, types),
    target.member.name,
    extensions,
  );

  if (implementation === undefined) {
    throw new Error(
      "Missing duck satisfaction for " + target.declaration.name + "." +
        target.member.name + " at " + owner.name,
    );
  }

  bind_duck_type_members(target.declaration, implementation, role_types);

  const result_type = validate_extension_signature(
    target.declaration,
    target.member,
    implementation.value,
    role_types,
    facts,
    types,
    source,
    resolved_contextual_result,
  );
  const extension_binding = extension_bindings.get(implementation.value);
  expect(
    extension_binding,
    "Missing lexical extension binding for " + implementation.type_name +
      "." + target.member.name,
  );
  used_extension_bindings.add(extension_binding);
  expr.func = { tag: "var", name: extension_binding };
  expr.args = member_args;
  facts.editor_type_of.set(expr, result_type);
  return true;
}

function resolve_extension_receiver_call(
  expr: Extract<FrontExpr, { tag: "app" }>,
  extensions: Map<string, ExtensionDeclaration[]>,
  types: Map<string, TypeDeclaration>,
  facts: SourceFacts,
  extension_bindings: WeakMap<FrontExpr, string>,
  used_extension_bindings: Set<string>,
): void {
  if (expr.func.tag !== "field") {
    return;
  }

  const receiver = expr.func.object;
  const member_name = expr.func.name;
  const receiver_type = facts.editor_type_of.get(receiver);

  if (receiver_type?.fields?.some((field) => field.name === member_name)) {
    return;
  }

  const type_name = concrete_fact_name(receiver_type);

  if (type_name === undefined) {
    return;
  }

  const implementation = extension_member(
    normalize_type_name(type_name, types),
    member_name,
    extensions,
  );

  if (implementation === undefined) {
    return;
  }

  const extension_binding = extension_bindings.get(implementation.value);
  expect(
    extension_binding,
    "Missing lexical extension binding for " + implementation.type_name +
      "." + member_name,
  );
  used_extension_bindings.add(extension_binding);
  expr.func = { tag: "var", name: extension_binding };
  let explicit_args = expr.args;
  const unit_arg = expr.args[0];

  if (
    expr.args.length === 1 && unit_arg !== undefined &&
    unit_arg.tag === "product" && unit_arg.entries.length === 0
  ) {
    explicit_args = [];
  }

  expr.args = [receiver, ...explicit_args];
  expr.arg = {
    tag: "product",
    entries: expr.args.map((value) => ({ value })),
  };
  const implementation_type = facts.editor_type_of.get(implementation.value);

  if (implementation_type?.call_result !== undefined) {
    facts.editor_type_of.set(expr, implementation_type.call_result);
  }
}

function duck_member_target(
  func: FrontExpr,
  ducks: Map<string, DuckDeclaration>,
): DuckMemberTarget | undefined {
  if (func.tag !== "field" || func.object.tag !== "var") {
    return undefined;
  }

  const declaration = ducks.get(func.object.name);

  if (declaration === undefined) {
    return undefined;
  }

  const member = declaration.members.find((candidate) => {
    return candidate.name === func.name;
  });

  if (member === undefined) {
    throw new Error(
      "Duck " + declaration.name + " has no member " + func.name,
    );
  }

  return { declaration, member };
}

function duck_member_param_types(member: DuckMember): TypeExpr[] {
  if (member.type_expr.tag !== "arrow") {
    throw new Error("Duck member " + member.name + " must be a function type");
  }

  const param = member.type_expr.param;

  if (param.tag !== "product") {
    return [param];
  }

  return param.entries.map((entry) => entry.type_expr);
}

function duck_member_result_type(member: DuckMember): TypeExpr {
  if (member.type_expr.tag !== "arrow") {
    throw new Error("Duck member " + member.name + " must be a function type");
  }

  return member.type_expr.result;
}

function duck_owner_type(
  declaration: DuckDeclaration,
  role_types: Map<string, DuckRoleBinding>,
): string {
  const role = declaration.roles[0];
  expect(role, "Duck declaration requires an owner role");
  const owner = role_types.get(role);
  expect(
    owner,
    "Duck owner role is not known for " + declaration.name + ": " + role,
  );
  return owner.name;
}

function extension_member(
  type_name: string,
  member_name: string,
  extensions: Map<string, ExtensionDeclaration[]>,
): (ExtensionDeclaration & { value: FrontExpr }) | undefined {
  const matches: (ExtensionDeclaration & { value: FrontExpr })[] = [];
  const declarations = extensions.get(type_name);

  if (declarations !== undefined) {
    for (const declaration of declarations) {
      const field = declaration.fields.find((candidate) => {
        return candidate.name === member_name;
      });

      if (field !== undefined) {
        matches.push({ ...declaration, value: field.value });
      }
    }
  }

  if (matches.length > 1) {
    throw new Error(
      "Ambiguous extension member: " + type_name + "." + member_name,
    );
  }

  return matches[0];
}

function bind_duck_type_members(
  declaration: DuckDeclaration,
  extension: ExtensionDeclaration,
  role_types: Map<string, DuckRoleBinding>,
): void {
  for (const member of declaration.types) {
    const implementation = extension.types.find((candidate) => {
      return candidate.name === member.name;
    });
    let type = member.default_type;

    if (implementation !== undefined) {
      type = implementation.type_expr;
    }

    expect(
      type !== undefined,
      "Missing associated type " + declaration.name + "." + member.name +
        " for " + extension.type_name,
    );
    const name = format_type_expr(type);
    const existing = role_types.get(member.name);

    if (existing !== undefined && existing.name !== name) {
      throw new Error(
        "Associated type " + declaration.name + "." + member.name +
          " is both " + existing.name + " and " + name,
      );
    }

    role_types.set(member.name, { name });
  }
}

function validate_extension_signature(
  declaration: DuckDeclaration,
  member: DuckMember,
  value: FrontExpr,
  role_types: Map<string, DuckRoleBinding>,
  facts: SourceFacts,
  types: Map<string, TypeDeclaration>,
  source: Source,
  contextual_result: SourceTypeFact | undefined,
): SourceTypeFact {
  if (value.tag !== "lam" && value.tag !== "rec") {
    throw new Error(
      "Duck member implementation must be a function: " + declaration.name +
        "." + member.name,
    );
  }

  const param_types = duck_member_param_types(member);
  const expected = param_types.length;

  if (value.params.length !== expected) {
    throw new Error(
      "Duck member implementation " + declaration.name + "." + member.name +
        " expects " + expected.toString() + " parameters, got " +
        value.params.length.toString(),
    );
  }

  for (let index = 0; index < param_types.length; index += 1) {
    const param_type = param_types[index];
    const param = value.params[index];
    expect(
      param_type,
      "Missing duck member parameter type " + index.toString(),
    );
    expect(param, "Missing extension parameter " + index.toString());
    const annotation = instantiate_duck_type(param_type, role_types);

    if (
      param.annotation === undefined && param.type_annotation === undefined &&
      annotation !== undefined
    ) {
      param.type_annotation = annotation;
    }
  }

  const implementation_facts = source_facts(
    source_with_extension_values(source),
  );
  const implementation_type = implementation_facts.editor_type_of.get(value);

  if (
    implementation_type?.call_params === undefined ||
    (implementation_type.call_result === undefined &&
      contextual_result === undefined)
  ) {
    throw new Error(
      "Duck member implementation type cannot be inferred: " +
        declaration.name + "." + member.name,
    );
  }

  const implementation_result = contextual_result ||
    implementation_type.call_result;
  expect(implementation_result, "Missing duck implementation result type");

  for (let index = 0; index < param_types.length; index += 1) {
    const param_type = param_types[index];
    const actual = implementation_type.call_params[index];
    expect(
      param_type,
      "Missing duck member parameter type " + index.toString(),
    );
    expect(actual, "Missing extension parameter type " + index.toString());
    bind_duck_fact(
      declaration,
      member,
      param_type,
      actual,
      role_types,
      types,
    );
  }

  bind_duck_fact(
    declaration,
    member,
    duck_member_result_type(member),
    implementation_result,
    role_types,
    types,
  );
  implementation_type.call_result = implementation_result;
  facts.editor_type_of.set(value, implementation_type);
  return implementation_result;
}

function bind_duck_fact(
  declaration: DuckDeclaration,
  member: DuckMember,
  pattern: TypeExpr,
  actual: SourceTypeFact,
  role_types: Map<string, DuckRoleBinding>,
  types: Map<string, TypeDeclaration>,
): void {
  if (pattern.tag === "name") {
    if (declaration.roles.includes(pattern.name)) {
      bind_duck_role(
        declaration,
        member,
        pattern.name,
        concrete_fact_name(actual),
        role_types,
        types,
      );
      return;
    }

    const associated = role_types.get(pattern.name);

    if (associated !== undefined) {
      expect_duck_type_name(
        declaration,
        member,
        associated.name,
        actual,
        types,
      );
      return;
    }

    expect_duck_type_name(declaration, member, pattern.name, actual, types);
    return;
  }

  if (pattern.tag === "arrow") {
    expect(
      actual.call_params !== undefined && actual.call_result !== undefined,
      "Duck member " + declaration.name + "." + member.name +
        " expects function type " + format_type_expr(pattern) + ", got " +
        actual.name,
    );
    const params = duck_param_type_entries(pattern.param);
    expect(
      params.length === actual.call_params.length,
      "Duck member " + declaration.name + "." + member.name +
        " expects function arity " + params.length.toString() + ", got " +
        actual.call_params.length.toString(),
    );

    for (let index = 0; index < params.length; index += 1) {
      const expected = params[index];
      const received = actual.call_params[index];
      expect(expected, "Missing duck callback parameter " + index.toString());
      expect(received, "Missing callback type " + index.toString());
      bind_duck_fact(
        declaration,
        member,
        expected,
        received,
        role_types,
        types,
      );
    }

    bind_duck_fact(
      declaration,
      member,
      pattern.result,
      actual.call_result,
      role_types,
      types,
    );
    return;
  }

  if (pattern.tag === "product") {
    expect(
      actual.fields !== undefined && actual.positional_fields,
      "Duck member " + declaration.name + "." + member.name +
        " expects product type " + format_type_expr(pattern) + ", got " +
        actual.name,
    );
    expect(
      pattern.entries.length === actual.fields.length,
      "Duck member " + declaration.name + "." + member.name +
        " expects product arity " + pattern.entries.length.toString() +
        ", got " + actual.fields.length.toString(),
    );

    for (let index = 0; index < pattern.entries.length; index += 1) {
      const expected = pattern.entries[index];
      const received = actual.fields[index];
      expect(expected, "Missing duck product entry " + index.toString());
      expect(received?.type, "Missing product type " + index.toString());
      bind_duck_fact(
        declaration,
        member,
        expected.type_expr,
        received.type,
        role_types,
        types,
      );
    }
    return;
  }

  if (duck_type_roles_known(pattern, declaration.roles, role_types)) {
    const instantiated = instantiate_duck_type(pattern, role_types);
    expect(instantiated, "Missing instantiated duck type");

    if (duck_type_expr_matches_fact(instantiated, actual, types)) {
      return;
    }
  }

  const actual_type = parse_duck_fact_type(declaration, member, actual);
  bind_duck_type_expr(
    declaration,
    member,
    pattern,
    actual_type,
    role_types,
    types,
  );
}

function duck_type_expr_matches_fact(
  expected: TypeExpr,
  actual: SourceTypeFact,
  types: Map<string, TypeDeclaration>,
): boolean {
  if (expected.tag === "name") {
    const actual_name = concrete_fact_name(actual);
    return actual_name !== undefined &&
      normalize_type_name(actual_name, types) ===
        normalize_type_name(expected.name, types);
  }

  if (expected.tag === "arrow") {
    if (actual.call_params === undefined || actual.call_result === undefined) {
      return false;
    }

    const params = duck_param_type_entries(expected.param);

    if (params.length !== actual.call_params.length) {
      return false;
    }

    for (let index = 0; index < params.length; index += 1) {
      const param = params[index];
      const received = actual.call_params[index];

      if (
        param === undefined || received === undefined ||
        !duck_type_expr_matches_fact(param, received, types)
      ) {
        return false;
      }
    }

    return duck_type_expr_matches_fact(
      expected.result,
      actual.call_result,
      types,
    );
  }

  const applied = duck_applied_type(expected);

  if (applied !== undefined) {
    const declaration = types.get(applied.name);

    if (
      declaration === undefined ||
      declaration.params.length !== applied.args.length
    ) {
      return false;
    }

    const substitutions = new Map<string, DuckRoleBinding>();

    for (let index = 0; index < declaration.params.length; index += 1) {
      const param = declaration.params[index];
      const arg = applied.args[index];

      if (param === undefined || arg === undefined) {
        return false;
      }

      substitutions.set(param, {
        name: format_type_expr(arg),
      });
    }

    if (declaration.body.tag === "alias") {
      const target = instantiate_duck_type(
        parse_type_expr(tokenize(declaration.body.type_name)),
        substitutions,
      );
      expect(target, "Missing instantiated duck alias target");
      return duck_type_expr_matches_fact(target, actual, types);
    }

    let fields;
    let actual_fields: SourceTypeFact[] | undefined;

    if (
      declaration.body.tag === "product" || declaration.body.tag === "packed"
    ) {
      fields = declaration.body.fields;
      actual_fields = source_fact_fields(actual);
    } else {
      fields = declaration.body.cases;
      actual_fields = source_fact_cases(actual);
    }

    if (actual_fields === undefined || fields.length !== actual_fields.length) {
      return false;
    }

    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      const received = actual_fields[index];

      if (field === undefined || received === undefined) {
        return false;
      }

      const field_type = instantiate_duck_type(
        parse_type_expr(tokenize(field.type_name)),
        substitutions,
      );

      if (
        field_type === undefined ||
        !duck_type_expr_matches_fact(field_type, received, types)
      ) {
        return false;
      }
    }

    return true;
  }

  if (expected.tag === "product") {
    const fields = source_fact_fields(actual);

    if (fields === undefined || fields.length !== expected.entries.length) {
      return false;
    }

    for (let index = 0; index < expected.entries.length; index += 1) {
      const entry = expected.entries[index];
      const received = fields[index];

      if (
        entry === undefined || received === undefined ||
        !duck_type_expr_matches_fact(entry.type_expr, received, types)
      ) {
        return false;
      }
    }

    return true;
  }

  return format_type_expr(expected) === concrete_fact_name(actual);
}

function duck_applied_type(
  type: TypeExpr,
): { name: string; args: TypeExpr[] } | undefined {
  const args: TypeExpr[] = [];
  let current = type;

  while (current.tag === "apply") {
    args.unshift(current.arg);
    current = current.func;
  }

  if (current.tag !== "name" || args.length === 0) {
    return undefined;
  }

  return { name: current.name, args };
}

function source_fact_fields(
  fact: SourceTypeFact,
): SourceTypeFact[] | undefined {
  let current: SourceTypeFact | undefined = fact;

  while (current !== undefined) {
    if (current.fields !== undefined) {
      const fields: SourceTypeFact[] = [];

      for (const field of current.fields) {
        if (field.type === undefined) {
          return undefined;
        }

        fields.push(field.type);
      }

      return fields;
    }

    current = current.alias_target;
  }

  return undefined;
}

function source_fact_cases(
  fact: SourceTypeFact,
): SourceTypeFact[] | undefined {
  let current: SourceTypeFact | undefined = fact;

  while (current !== undefined) {
    if (current.cases !== undefined) {
      return Array.from(current.cases.values());
    }

    current = current.alias_target;
  }

  return undefined;
}

function duck_param_type_entries(type: TypeExpr): TypeExpr[] {
  if (type.tag !== "product") {
    return [type];
  }

  return type.entries.map((entry) => entry.type_expr);
}

function bind_duck_type_expr(
  declaration: DuckDeclaration,
  member: DuckMember,
  pattern: TypeExpr,
  actual: TypeExpr,
  role_types: Map<string, DuckRoleBinding>,
  types: Map<string, TypeDeclaration>,
): void {
  if (pattern.tag === "name") {
    if (declaration.roles.includes(pattern.name)) {
      bind_duck_role(
        declaration,
        member,
        pattern.name,
        format_type_expr(actual),
        role_types,
        types,
      );
      return;
    }

    expect(
      actual.tag === "name" &&
        normalize_type_name(actual.name, types) ===
          normalize_type_name(pattern.name, types),
      duck_type_mismatch(declaration, member, pattern, actual),
    );
    return;
  }

  expect(
    pattern.tag === actual.tag,
    duck_type_mismatch(declaration, member, pattern, actual),
  );

  if (pattern.tag === "apply" && actual.tag === "apply") {
    bind_duck_type_expr(
      declaration,
      member,
      pattern.func,
      actual.func,
      role_types,
      types,
    );
    bind_duck_type_expr(
      declaration,
      member,
      pattern.arg,
      actual.arg,
      role_types,
      types,
    );
    return;
  }

  if (pattern.tag === "arrow" && actual.tag === "arrow") {
    bind_duck_type_expr(
      declaration,
      member,
      pattern.param,
      actual.param,
      role_types,
      types,
    );
    bind_duck_type_expr(
      declaration,
      member,
      pattern.result,
      actual.result,
      role_types,
      types,
    );
    return;
  }

  if (pattern.tag === "product" && actual.tag === "product") {
    expect(
      pattern.entries.length === actual.entries.length,
      duck_type_mismatch(declaration, member, pattern, actual),
    );

    for (let index = 0; index < pattern.entries.length; index += 1) {
      const expected = pattern.entries[index];
      const received = actual.entries[index];
      expect(expected, "Missing duck product entry " + index.toString());
      expect(received, "Missing actual product entry " + index.toString());
      bind_duck_type_expr(
        declaration,
        member,
        expected.type_expr,
        received.type_expr,
        role_types,
        types,
      );
    }
    return;
  }

  if (
    (pattern.tag === "borrow" && actual.tag === "borrow") ||
    (pattern.tag === "frozen" && actual.tag === "frozen")
  ) {
    bind_duck_type_expr(
      declaration,
      member,
      pattern.value,
      actual.value,
      role_types,
      types,
    );
    return;
  }

  expect(
    format_type_expr(pattern) === format_type_expr(actual),
    duck_type_mismatch(declaration, member, pattern, actual),
  );
}

function bind_duck_role(
  declaration: DuckDeclaration,
  member: DuckMember,
  role: string,
  actual_name: string | undefined,
  role_types: Map<string, DuckRoleBinding>,
  types: Map<string, TypeDeclaration>,
): void {
  if (actual_name === undefined) {
    return;
  }

  const normalized_actual = normalize_type_name(actual_name, types);
  const existing = role_types.get(role);

  if (existing === undefined) {
    role_types.set(role, { name: normalized_actual });
    return;
  }

  if (normalize_type_name(existing.name, types) !== normalized_actual) {
    throw new Error(
      "Duck member implementation " + declaration.name + "." + member.name +
        " requires role " + role + " to be " + existing.name + ", got " +
        normalized_actual,
    );
  }
}

function expect_duck_type_name(
  declaration: DuckDeclaration,
  member: DuckMember,
  expected: string,
  actual: SourceTypeFact,
  types: Map<string, TypeDeclaration>,
): void {
  const actual_name = concrete_fact_name(actual);
  expect(
    actual_name !== undefined &&
      normalize_type_name(actual_name, types) ===
        normalize_type_name(expected, types),
    "Duck member " + declaration.name + "." + member.name + " expects " +
      expected + ", got " + actual.name,
  );
}

function parse_duck_fact_type(
  declaration: DuckDeclaration,
  member: DuckMember,
  actual: SourceTypeFact,
): TypeExpr {
  let inspected = actual;

  while (
    inspected.alias_target !== undefined &&
    inspected.alias_target.nominal !== undefined
  ) {
    inspected = inspected.alias_target;
  }

  const type_name = inspected.name;
  expect(
    type_name !== "" && type_name !== "unknown",
    "Duck member " + declaration.name + "." + member.name +
      " requires a concrete type",
  );

  try {
    return parse_type_expr(tokenize(type_name));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      "Duck member " + declaration.name + "." + member.name +
        " cannot inspect type " + type_name + ": " + message,
    );
  }
}

function duck_type_mismatch(
  declaration: DuckDeclaration,
  member: DuckMember,
  expected: TypeExpr,
  actual: TypeExpr,
): string {
  return "Duck member " + declaration.name + "." + member.name +
    " expects " + format_type_expr(expected) + ", got " +
    format_type_expr(actual);
}

function apply_duck_argument_context(
  arg: FrontExpr,
  type: TypeExpr,
  roles: string[],
  role_types: Map<string, DuckRoleBinding>,
): boolean {
  if ((arg.tag !== "lam" && arg.tag !== "rec") || type.tag !== "arrow") {
    return false;
  }

  const param_types = duck_param_type_entries(type.param);

  if (param_types.length !== arg.params.length) {
    return false;
  }

  let changed = false;

  for (let index = 0; index < param_types.length; index += 1) {
    const param_type = param_types[index];
    const param = arg.params[index];
    expect(
      param_type,
      "Missing duck lambda parameter type " + index.toString(),
    );
    expect(param, "Missing duck lambda parameter " + index.toString());

    if (
      param.annotation !== undefined || param.type_annotation !== undefined ||
      !duck_type_roles_known(param_type, roles, role_types)
    ) {
      continue;
    }

    const annotation = instantiate_duck_type(param_type, role_types);
    expect(annotation, "Missing instantiated duck parameter type");
    param.type_annotation = annotation;
    changed = true;
  }

  return changed;
}

function duck_type_roles_known(
  type: TypeExpr,
  roles: string[],
  role_types: Map<string, DuckRoleBinding>,
): boolean {
  if (type.tag === "name") {
    return !roles.includes(type.name) || role_types.has(type.name);
  }

  if (type.tag === "apply") {
    return duck_type_roles_known(type.func, roles, role_types) &&
      duck_type_roles_known(type.arg, roles, role_types);
  }

  if (type.tag === "arrow") {
    return duck_type_roles_known(type.param, roles, role_types) &&
      duck_type_roles_known(type.result, roles, role_types);
  }

  if (type.tag === "product") {
    return type.entries.every((entry) =>
      duck_type_roles_known(entry.type_expr, roles, role_types)
    );
  }

  if (type.tag === "tuple") {
    return type.items.every((item) =>
      duck_type_roles_known(item, roles, role_types)
    );
  }

  if (type.tag === "array") {
    return duck_type_roles_known(type.element, roles, role_types);
  }

  if (type.tag === "borrow" || type.tag === "frozen") {
    return duck_type_roles_known(type.value, roles, role_types);
  }

  if (
    type.tag === "union" || type.tag === "intersection" ||
    type.tag === "difference"
  ) {
    return duck_type_roles_known(type.left, roles, role_types) &&
      duck_type_roles_known(type.right, roles, role_types);
  }

  return true;
}

function instantiate_duck_type(
  type: TypeExpr,
  role_types: Map<string, DuckRoleBinding>,
): TypeExpr | undefined {
  if (type.tag === "name") {
    const role = role_types.get(type.name);

    if (role === undefined) {
      return type;
    }

    return parse_type_expr(tokenize(role.name));
  }

  if (type.tag === "apply") {
    const func = instantiate_duck_type(type.func, role_types);
    const arg = instantiate_duck_type(type.arg, role_types);

    if (func === undefined || arg === undefined) {
      return undefined;
    }

    return { tag: "apply", func, arg };
  }

  if (type.tag === "arrow") {
    const param = instantiate_duck_type(type.param, role_types);
    const result = instantiate_duck_type(type.result, role_types);

    if (param === undefined || result === undefined) {
      return undefined;
    }

    return { ...type, param, result };
  }

  if (type.tag === "product") {
    const entries = [];

    for (const entry of type.entries) {
      const entry_type = instantiate_duck_type(entry.type_expr, role_types);

      if (entry_type === undefined) {
        return undefined;
      }

      entries.push({ ...entry, type_expr: entry_type });
    }

    if (type.value_pack === true) {
      return { tag: "product", entries, value_pack: true };
    }

    return { tag: "product", entries };
  }

  if (type.tag === "tuple") {
    const items = [];

    for (const item of type.items) {
      const item_type = instantiate_duck_type(item, role_types);

      if (item_type === undefined) {
        return undefined;
      }

      items.push(item_type);
    }

    return { tag: "tuple", items };
  }

  if (type.tag === "array") {
    const element = instantiate_duck_type(type.element, role_types);

    if (element === undefined) {
      return undefined;
    }

    return { ...type, element };
  }

  if (type.tag === "borrow" || type.tag === "frozen") {
    const value = instantiate_duck_type(type.value, role_types);

    if (value === undefined) {
      return undefined;
    }

    return { ...type, value };
  }

  if (
    type.tag === "union" || type.tag === "intersection" ||
    type.tag === "difference"
  ) {
    const left = instantiate_duck_type(type.left, role_types);
    const right = instantiate_duck_type(type.right, role_types);

    if (left === undefined || right === undefined) {
      return undefined;
    }

    return { ...type, left, right };
  }

  return type;
}

function normalize_type_name(
  type_name: string,
  types: Map<string, TypeDeclaration>,
): string {
  const visited = new Set<string>();
  let current = type_name;

  while (!visited.has(current)) {
    visited.add(current);
    const declaration = types.get(current);

    if (
      declaration === undefined || declaration.params.length !== 0 ||
      declaration.body.tag !== "alias" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(declaration.body.type_name)
    ) {
      return current;
    }

    current = declaration.body.type_name;
  }

  throw new Error(
    "Recursive type alias while resolving extensions: " +
      [...visited, current].join(" -> "),
  );
}

function concrete_fact_name(
  fact: SourceTypeFact | undefined,
): string | undefined {
  if (
    fact === undefined || fact.inference_variable ||
    fact.resolved_name === "" ||
    fact.resolved_name === "unknown" || fact.resolved_name === "Type"
  ) {
    return undefined;
  }

  return fact.resolved_name;
}
