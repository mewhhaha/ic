import { expect } from "../expect.ts";
import type {
  DuckDeclaration,
  DuckMember,
  ExtensionDeclaration,
  FrontExpr,
  Source,
  Stmt,
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
import {
  derive_missing_source_spans,
  has_source_span,
  source_span,
} from "./syntax.ts";

type DuckMemberTarget = {
  declaration: DuckDeclaration;
  member: DuckMember;
};

type DuckRoleBinding = {
  name: string;
};

type SpecializedExtensionBinding = {
  name: string;
  type_annotation: TypeExpr | undefined;
  value: FrontExpr;
};

function source_with_extension_values(
  source: Source,
  selected?: Set<string>,
  expected_types?: Map<FrontExpr, TypeExpr>,
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
        type_annotation: expected_types?.get(field.value),
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
  const specialized_extension_bindings = new Map<
    string,
    SpecializedExtensionBinding
  >();
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

  const surface_facts = source_facts(source);

  if (
    elaborate_collection_syntax(
      surface_facts,
      ducks,
      extensions,
      types,
    )
  ) {
    invalidate_source_facts(source);
    return elaborate_front_ducks(source);
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
        specialized_extension_bindings,
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
  const elaborated = source_with_extension_values(
    source,
    used_extension_bindings,
  );

  if (specialized_extension_bindings.size === 0) {
    return elaborated;
  }

  const specialized_statements = Array.from(
    specialized_extension_bindings.values(),
  ).map((binding) => ({
    tag: "bind" as const,
    kind: "const" as const,
    name: binding.name,
    is_linear: false,
    annotation: undefined,
    type_annotation: binding.type_annotation,
    value: binding.value,
  }));
  return {
    ...elaborated,
    statements: [...specialized_statements, ...elaborated.statements],
  };
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

    bind_duck_type_members(
      declaration,
      implementation,
      role_types,
      owner,
    );

    const specialized = specialize_extension_value(
      implementation,
      declaration,
      role_types,
      owner,
    );

    validate_extension_signature(
      declaration,
      member,
      specialized || implementation.value,
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
  specialized_extension_bindings: Map<string, SpecializedExtensionBinding>,
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
  let deferred_argument = false;

  for (let index = 0; index < param_types.length; index += 1) {
    const param_type = param_types[index];
    const arg = member_args[index];
    expect(
      param_type,
      "Missing duck member parameter type " + index.toString(),
    );
    expect(arg, "Missing duck member argument " + index.toString());
    const fact = facts.editor_type_of.get(arg);

    if (fact === undefined) {
      continue;
    }

    if (
      concrete_fact_name(fact) === undefined &&
      (fact.inference_variable || fact.name === "" || fact.name === "unknown")
    ) {
      continue;
    }

    if (
      param_type.tag === "arrow" &&
      (fact.call_params === undefined || fact.call_result === undefined)
    ) {
      deferred_argument = true;
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

  const inferred_result = facts.editor_type_of.get(expr);
  const expected_result = facts.expected_type_of.get(expr);
  let contextual_result = expected_result;

  if (contextual_result === undefined) {
    contextual_result = inferred_result;
  }

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
    const argument_types = member_args.map((arg) => {
      const fact = facts.editor_type_of.get(arg);

      if (fact === undefined) {
        return "unknown";
      }

      return fact.name;
    }).join(", ");
    throw new Error(
      "Duck obligation escapes without a statically known role: " +
        target.declaration.name + "." + target.member.name + " " + owner_role +
        " from arguments [" + argument_types + "]",
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

  bind_duck_type_members(
    target.declaration,
    implementation,
    role_types,
    owner.name,
  );

  const specialized_implementation = specialize_extension_value(
    implementation,
    target.declaration,
    role_types,
    owner.name,
  );

  let result_type = resolved_contextual_result;

  if (
    !deferred_argument ||
    duck_type_roles_known(
      target.member.type_expr,
      target.declaration.roles,
      role_types,
    )
  ) {
    result_type = validate_extension_signature(
      target.declaration,
      target.member,
      specialized_implementation || implementation.value,
      role_types,
      facts,
      types,
      source,
      resolved_contextual_result,
    );
  }

  if (
    specialized_implementation !== undefined && implementation.params.length > 0
  ) {
    clear_specialized_extension_parameter_annotations(
      specialized_implementation,
    );
  }

  const extension_binding = extension_bindings.get(implementation.value);
  expect(
    extension_binding,
    "Missing lexical extension binding for " + implementation.type_name +
      "." + target.member.name,
  );
  if (specialized_implementation === undefined) {
    used_extension_bindings.add(extension_binding);
    expr.func = { tag: "var", name: extension_binding };
  } else {
    const invocation_roles = new Map(role_types);
    const owner_role = target.declaration.roles[0];
    const owner_argument = member_args[0];
    expect(owner_role, "Duck declaration requires an owner role");

    if (owner_argument !== undefined) {
      const owner_fact = facts.editor_type_of.get(owner_argument);

      if (
        owner_fact !== undefined && owner_fact.name !== "" &&
        owner_fact.name !== "unknown"
      ) {
        invocation_roles.set(owner_role, { name: owner_fact.name });
      }
    }

    const invocation_owner = invocation_roles.get(owner_role);
    expect(invocation_owner, "Missing specialized duck owner role");
    const key = extension_binding + "|" + target.member.name + "|" +
      invocation_owner.name;
    let binding = specialized_extension_bindings.get(key);

    if (binding === undefined) {
      const type_annotation = instantiate_duck_type(
        target.member.type_expr,
        invocation_roles,
      );
      expect(
        type_annotation !== undefined,
        "Missing specialized duck signature for " + target.declaration.name +
          "." + target.member.name + " at " + owner.name,
      );
      let binding_type: TypeExpr | undefined;

      if (target.member.name === "next") {
        binding_type = type_annotation;
      }

      binding = {
        name: "_duck_specialized#" +
          specialized_extension_bindings.size.toString(),
        type_annotation: binding_type,
        value: specialized_implementation,
      };
      specialized_extension_bindings.set(key, binding);
    }

    expr.func = { tag: "var", name: binding.name };
  }
  expr.args = member_args.map((arg, index) => {
    const param_type = param_types[index];
    expect(
      param_type,
      "Missing duck member parameter type " + index.toString(),
    );

    if (param_type.tag === "borrow" && arg.tag !== "borrow") {
      return { tag: "borrow" as const, value: arg };
    }

    return arg;
  });

  if (result_type !== undefined) {
    facts.editor_type_of.set(expr, result_type);
  }

  return true;
}

function clear_specialized_extension_parameter_annotations(
  value: FrontExpr,
): void {
  if (value.tag !== "lam" && value.tag !== "rec") {
    return;
  }

  for (const param of value.params) {
    param.annotation = undefined;
    param.type_annotation = undefined;
  }

  if (value.pattern?.tag === "binding") {
    value.pattern.annotation = undefined;
    value.pattern.type_annotation = undefined;
  }
}

function specialize_extension_value(
  extension: ExtensionDeclaration & { value: FrontExpr },
  declaration: DuckDeclaration,
  role_types: Map<string, DuckRoleBinding>,
  owner_type: string,
): FrontExpr | undefined {
  const substitutions = new Map(role_types);
  const extension_types = extension_type_bindings(extension, owner_type);

  for (const [name, type] of extension_types) {
    substitutions.set(name, type);
  }

  return specialize_duck_extension_value(
    extension.value,
    [
      ...declaration.roles,
      ...declaration.types.map((member) => member.name),
      ...extension.params,
    ],
    substitutions,
  );
}

function specialize_duck_extension_value(
  value: FrontExpr,
  roles: string[],
  role_types: Map<string, DuckRoleBinding>,
): FrontExpr | undefined {
  const referenced_roles = roles.filter((role) => {
    return front_value_mentions_type_role(value, role);
  });

  if (referenced_roles.length === 0) {
    return undefined;
  }

  for (const role of referenced_roles) {
    if (!role_types.has(role)) {
      return undefined;
    }
  }

  const specialized = structuredClone(value);

  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") {
      return;
    }

    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        visit(entry);
      }
      return;
    }

    const object = candidate as Record<string, unknown>;

    if (
      (object.tag === "type_name" || object.tag === "var" ||
        object.tag === "name") &&
      typeof object.name === "string" && role_types.has(object.name)
    ) {
      const role = role_types.get(object.name);
      expect(role, "Missing specialized Duck role " + object.name);
      if (object.tag !== "name") {
        object.tag = "type_name";
      }
      object.name = role.name;
    }

    if (typeof object.annotation === "string") {
      const annotation = parse_type_expr(tokenize(object.annotation));
      const instantiated = instantiate_duck_type(annotation, role_types);

      if (instantiated !== undefined) {
        object.annotation = format_type_expr(instantiated);
      }
    }

    if (
      object.type_annotation !== undefined &&
      typeof object.type_annotation === "object"
    ) {
      const instantiated = instantiate_duck_type(
        object.type_annotation as TypeExpr,
        role_types,
      );

      if (instantiated !== undefined) {
        object.type_annotation = instantiated;
      }
    }

    for (const child of Object.values(object)) {
      visit(child);
    }
  };

  visit(specialized);
  return specialized;
}

function front_value_mentions_type_role(
  value: unknown,
  role: string,
): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => front_value_mentions_type_role(entry, role));
  }

  const object = value as Record<string, unknown>;

  if (
    (object.tag === "type_name" || object.tag === "var" ||
      object.tag === "name") &&
    object.name === role
  ) {
    return true;
  }

  if (
    typeof object.annotation === "string" &&
    new RegExp("\\b" + role + "\\b").test(object.annotation)
  ) {
    return true;
  }

  return Object.values(object).some((child) => {
    return front_value_mentions_type_role(child, role);
  });
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

  if (receiver.tag === "var") {
    const associated_type_name = normalize_type_name(receiver.name, types);
    const associated_implementation = extension_member(
      associated_type_name,
      member_name,
      extensions,
    );

    if (associated_implementation !== undefined) {
      if (
        associated_implementation.value.tag === "lam" ||
        associated_implementation.value.tag === "rec"
      ) {
        for (let index = 0; index < expr.args.length; index += 1) {
          const arg = expr.args[index];
          const implementation_param =
            associated_implementation.value.params[index];

          if (
            arg === undefined || implementation_param === undefined ||
            (arg.tag !== "lam" && arg.tag !== "rec")
          ) {
            continue;
          }

          let expected = implementation_param.type_annotation;

          if (
            expected === undefined &&
            implementation_param.annotation !== undefined
          ) {
            expected = parse_type_expr(
              tokenize(implementation_param.annotation),
            );
          }

          if (expected?.tag !== "arrow") {
            continue;
          }

          const expected_params = duck_param_type_entries(expected.param);

          for (
            let param_index = 0;
            param_index < arg.params.length;
            param_index += 1
          ) {
            const param = arg.params[param_index];
            const expected_param = expected_params[param_index];

            if (
              param === undefined || expected_param === undefined ||
              param.annotation !== undefined
            ) {
              continue;
            }

            const annotation = format_type_expr(expected_param);
            param.annotation = annotation;
            param.type_annotation = expected_param;

            if (
              arg.params.length === 1 && arg.pattern?.tag === "binding"
            ) {
              arg.pattern.annotation = annotation;
              arg.pattern.type_annotation = expected_param;
            } else if (
              arg.params.length === 1 && arg.pattern?.tag === "wildcard"
            ) {
              arg.pattern = {
                tag: "binding",
                name: param.name,
                mode: arg.pattern.mode,
                annotation,
                type_annotation: expected_param,
              };
            }
          }
        }
      }

      const extension_binding = extension_bindings.get(
        associated_implementation.value,
      );
      expect(
        extension_binding,
        "Missing lexical extension binding for " + associated_type_name +
          "." + member_name,
      );
      used_extension_bindings.add(extension_binding);
      expr.func = { tag: "var", name: extension_binding };
      const unit_arg = expr.args[0];

      if (
        expr.args.length === 1 && unit_arg !== undefined &&
        unit_arg.tag === "product" && unit_arg.entries.length === 0
      ) {
        expr.args = [];
      }

      expr.arg = {
        tag: "product",
        entries: expr.args.map((value) => ({ value })),
      };
      const implementation_type = facts.editor_type_of.get(
        associated_implementation.value,
      );

      if (implementation_type?.call_result !== undefined) {
        facts.editor_type_of.set(expr, implementation_type.call_result);
      }

      return;
    }
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

  let receiver_arg = receiver;

  if (
    implementation.value.tag === "lam" || implementation.value.tag === "rec"
  ) {
    const receiver_param = implementation.value.params[0];
    expect(receiver_param, "Extension receiver requires a parameter");
    let receiver_param_type = receiver_param.type_annotation;

    if (
      receiver_param_type === undefined &&
      receiver_param.annotation !== undefined
    ) {
      receiver_param_type = parse_type_expr(
        tokenize(receiver_param.annotation),
      );
    }

    if (receiver_param_type?.tag === "borrow" && receiver.tag !== "borrow") {
      receiver_arg = { tag: "borrow", value: receiver };
    }
  }

  expr.args = [receiver_arg, ...explicit_args];
  expr.arg = {
    tag: "product",
    entries: expr.args.map((value) => ({ value })),
  };
  const implementation_type = facts.editor_type_of.get(implementation.value);

  if (implementation_type?.call_result !== undefined) {
    facts.editor_type_of.set(expr, implementation_type.call_result);
  }
}

function elaborate_collection_syntax(
  facts: SourceFacts,
  ducks: Map<string, DuckDeclaration>,
  extensions: Map<string, ExtensionDeclaration[]>,
  types: Map<string, TypeDeclaration>,
): boolean {
  let changed = false;
  let next_collection = 0;

  if (ducks.has("Index")) {
    for (const expr of facts.expressions) {
      if (expr.tag !== "index") {
        continue;
      }

      const owner = concrete_fact_name(facts.editor_type_of.get(expr.object));

      if (
        owner === undefined || collection_syntax_has_core_lowering(owner) ||
        extension_member(
            normalize_type_name(owner, types),
            "get",
            extensions,
          ) ===
          undefined
      ) {
        continue;
      }

      const object = expr.object;
      const index = expr.index;
      replace_node(expr, duck_call("Index", "get", [object, index]));
      changed = true;
    }
  }

  if (ducks.has("IndexSet")) {
    for (const stmt of facts.statements) {
      if (stmt.tag !== "index_assign") {
        continue;
      }

      const owner = concrete_fact_name(
        facts.definition_type_of.get(stmt)?.get("object"),
      );

      if (
        owner === undefined || collection_syntax_has_core_lowering(owner) ||
        extension_member(
            normalize_type_name(owner, types),
            "set",
            extensions,
          ) ===
          undefined
      ) {
        continue;
      }

      const value = duck_call("IndexSet", "set", [
        { tag: "var", name: stmt.name },
        stmt.index,
        stmt.value,
      ]);
      replace_node(stmt, {
        tag: "assign",
        name: stmt.name,
        mode: "same",
        value,
      });
      changed = true;
    }
  }

  if (!ducks.has("Iterator") && !ducks.has("Iterable")) {
    return changed;
  }

  for (const stmt of facts.statements) {
    if (stmt.tag !== "for_collection") {
      continue;
    }

    const owner = concrete_fact_name(
      facts.editor_type_of.get(stmt.collection),
    );

    if (owner === undefined) {
      continue;
    }

    if (collection_syntax_has_core_lowering(owner)) {
      continue;
    }

    const normalized_owner = normalize_type_name(owner, types);

    if (
      ducks.has("Iterator") &&
      extension_member(normalized_owner, "has_next", extensions) !==
        undefined &&
      extension_member(normalized_owner, "next", extensions) !== undefined
    ) {
      const next_implementation = extension_member(
        normalized_owner,
        "next",
        extensions,
      );
      expect(next_implementation, "Missing Iterator.next implementation");
      const case_name = iterator_union_case(next_implementation.value);
      let replacement: Extract<Stmt, { tag: "expr" }>;

      if (case_name !== undefined) {
        replacement = union_cursor_collection_loop(
          stmt,
          next_collection,
          case_name,
        );
      } else {
        replacement = cursor_collection_loop(stmt, next_collection);
      }

      if (has_source_span(stmt)) {
        derive_missing_source_spans(replacement, source_span(stmt));
      }

      replace_node(stmt, replacement);
      next_collection += 1;
      changed = true;
      continue;
    }

    if (
      !ducks.has("Iterable") ||
      extension_member(normalized_owner, "length", extensions) === undefined ||
      extension_member(normalized_owner, "get", extensions) === undefined
    ) {
      continue;
    }

    const id = next_collection;
    next_collection += 1;
    const collection_name = "@duck_collection#" + id.toString();
    let index_name = stmt.index;

    if (index_name === undefined) {
      index_name = "@duck_collection_index#" + id.toString();
    }

    const item_name = stmt.item;
    const collection = stmt.collection;
    const body = stmt.body;
    const length = duck_call("Iterable", "length", [{
      tag: "var",
      name: collection_name,
    }]);
    const item = duck_call("Iterable", "get", [
      { tag: "var", name: collection_name },
      { tag: "var", name: index_name },
    ]);
    replace_node(stmt, {
      tag: "expr",
      expr: {
        tag: "block",
        statements: [
          {
            tag: "bind",
            kind: "let",
            name: collection_name,
            is_linear: false,
            annotation: undefined,
            value: collection,
          },
          {
            tag: "for_range",
            index: index_name,
            start: { tag: "num", type: "i32", value: 0 },
            end: length,
            end_bound: "exclusive",
            step: { tag: "num", type: "i32", value: 1 },
            body: [
              {
                tag: "bind",
                kind: "let",
                name: item_name,
                is_linear: false,
                annotation: undefined,
                value: item,
              },
              ...body,
            ],
          },
        ],
      },
    });
    changed = true;
  }

  return changed;
}

function union_cursor_collection_loop(
  stmt: Extract<Stmt, { tag: "for_collection" }>,
  id: number,
  case_name: string,
): Extract<Stmt, { tag: "expr" }> {
  const cursor_name = "@duck_cursor#" + id.toString();
  const payload_name = "@duck_payload#" + id.toString();
  const tail_name = "@duck_tail#" + id.toString();
  const ignored_name = "@duck_unpack#" + id.toString();
  const index_name = "@duck_cursor_index#" + id.toString();
  const iteration_body: Stmt[] = [{
    tag: "bind",
    kind: "let",
    name: ignored_name,
    is_linear: false,
    annotation: undefined,
    pattern: {
      tag: "product",
      entries: [{
        pattern: {
          tag: "binding",
          name: stmt.item,
          mode: "default",
          annotation: undefined,
        },
      }, {
        pattern: {
          tag: "binding",
          name: tail_name,
          mode: "default",
          annotation: undefined,
        },
      }],
    },
    value: { tag: "var", name: payload_name },
  }, {
    tag: "assign",
    name: cursor_name,
    mode: "same",
    value: { tag: "var", name: tail_name },
  }];

  if (stmt.index !== undefined) {
    iteration_body.push({
      tag: "bind",
      kind: "let",
      name: stmt.index,
      is_linear: false,
      annotation: undefined,
      value: { tag: "var", name: index_name },
    }, {
      tag: "assign",
      name: index_name,
      mode: "same",
      value: {
        tag: "prim",
        prim: "i32.add",
        left: { tag: "var", name: index_name },
        right: { tag: "num", type: "i32", value: 1 },
      },
    });
  }

  iteration_body.push(...stmt.body);
  const statements: Stmt[] = [{
    tag: "bind",
    kind: "let",
    name: cursor_name,
    is_linear: false,
    annotation: undefined,
    value: stmt.collection,
  }];

  if (stmt.index !== undefined) {
    statements.push({
      tag: "bind",
      kind: "let",
      name: index_name,
      is_linear: false,
      annotation: undefined,
      value: { tag: "num", type: "i32", value: 0 },
    });
  }

  statements.push({
    tag: "expr",
    expr: {
      tag: "loop",
      body: [{
        tag: "expr",
        expr: {
          tag: "if_let",
          case_name,
          value_name: payload_name,
          target: { tag: "var", name: cursor_name },
          then_branch: { tag: "block", statements: iteration_body },
          else_branch: {
            tag: "block",
            statements: [{ tag: "break" }],
          },
        },
      }],
    },
  });

  return { tag: "expr", expr: { tag: "block", statements } };
}

function cursor_collection_loop(
  stmt: Extract<Stmt, { tag: "for_collection" }>,
  id: number,
): Extract<Stmt, { tag: "expr" }> {
  const cursor_name = "@duck_cursor#" + id.toString();
  const payload_name = "@duck_payload#" + id.toString();
  const tail_name = "@duck_tail#" + id.toString();
  const index_name = "@duck_cursor_index#" + id.toString();
  const iteration_body: Stmt[] = [{
    tag: "bind",
    kind: "let",
    name: payload_name,
    is_linear: false,
    annotation: undefined,
    value: duck_call("Iterator", "next", [{
      tag: "var",
      name: cursor_name,
    }]),
  }, {
    tag: "bind",
    kind: "let",
    name: stmt.item,
    is_linear: false,
    annotation: undefined,
    value: {
      tag: "index",
      object: { tag: "var", name: payload_name },
      index: { tag: "num", type: "i32", value: 0 },
    },
  }, {
    tag: "bind",
    kind: "let",
    name: tail_name,
    is_linear: false,
    annotation: undefined,
    value: {
      tag: "index",
      object: { tag: "var", name: payload_name },
      index: { tag: "num", type: "i32", value: 1 },
    },
  }, {
    tag: "assign",
    name: cursor_name,
    mode: "same",
    value: { tag: "var", name: tail_name },
  }];

  if (stmt.index !== undefined) {
    iteration_body.push({
      tag: "bind",
      kind: "let",
      name: stmt.index,
      is_linear: false,
      annotation: undefined,
      value: { tag: "var", name: index_name },
    }, {
      tag: "assign",
      name: index_name,
      mode: "same",
      value: {
        tag: "prim",
        prim: "i32.add",
        left: { tag: "var", name: index_name },
        right: { tag: "num", type: "i32", value: 1 },
      },
    });
  }

  iteration_body.push(...stmt.body);
  const statements: Stmt[] = [{
    tag: "bind",
    kind: "let",
    name: cursor_name,
    is_linear: false,
    annotation: undefined,
    value: stmt.collection,
  }];

  if (stmt.index !== undefined) {
    statements.push({
      tag: "bind",
      kind: "let",
      name: index_name,
      is_linear: false,
      annotation: undefined,
      value: { tag: "num", type: "i32", value: 0 },
    });
  }

  statements.push({
    tag: "expr",
    expr: {
      tag: "loop",
      body: [{
        tag: "expr",
        expr: {
          tag: "if",
          cond: duck_call("Iterator", "has_next", [{
            tag: "borrow",
            value: { tag: "var", name: cursor_name },
          }]),
          then_branch: { tag: "block", statements: iteration_body },
          else_branch: {
            tag: "block",
            statements: [{ tag: "break" }],
          },
        },
      }],
    },
  });

  return { tag: "expr", expr: { tag: "block", statements } };
}

function iterator_union_case(value: FrontExpr): string | undefined {
  if (
    (value.tag !== "lam" && value.tag !== "rec") ||
    value.body.tag !== "if_let"
  ) {
    return undefined;
  }

  return value.body.case_name;
}

function collection_syntax_has_core_lowering(type_name: string): boolean {
  return type_name === "Bytes" || type_name === "Text";
}

function duck_call(
  duck: string,
  member: string,
  args: FrontExpr[],
): Extract<FrontExpr, { tag: "app" }> {
  return {
    tag: "app",
    func: {
      tag: "field",
      object: { tag: "var", name: duck },
      name: member,
    },
    args,
  };
}

function replace_node(
  target: FrontExpr | Stmt,
  replacement: FrontExpr | Stmt,
): void {
  for (const key of Object.keys(target)) {
    delete (target as unknown as Record<string, unknown>)[key];
  }

  Object.assign(target, replacement);
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
  let declarations = extensions.get(type_name);

  if (declarations === undefined) {
    const applied = duck_applied_type(parse_type_expr(tokenize(type_name)));

    if (applied !== undefined) {
      declarations = extensions.get(applied.name);
    }
  }

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
  owner_type: string,
): void {
  const extension_types = extension_type_bindings(extension, owner_type);

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
    const instantiated = instantiate_duck_type(type, extension_types);
    expect(
      instantiated !== undefined,
      "Cannot instantiate associated type " + declaration.name + "." +
        member.name + " for " + owner_type,
    );
    const name = format_type_expr(instantiated);
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

function extension_type_bindings(
  extension: ExtensionDeclaration,
  owner_type: string,
): Map<string, DuckRoleBinding> {
  const bindings = new Map<string, DuckRoleBinding>();

  if (extension.params.length === 0) {
    return bindings;
  }

  const applied = duck_applied_type(parse_type_expr(tokenize(owner_type)));
  expect(
    applied !== undefined && applied.name === extension.type_name,
    "Generic extension " + extension.type_name +
      " requires an applied type, got " +
      owner_type,
  );
  expect(
    applied.args.length === extension.params.length,
    "Generic extension " + extension.type_name + " expects " +
      extension.params.length.toString() + " type arguments, got " +
      applied.args.length.toString(),
  );

  for (let index = 0; index < extension.params.length; index += 1) {
    const param = extension.params[index];
    const arg = applied.args[index];
    expect(param, "Missing extension parameter " + index.toString());
    expect(arg, "Missing extension type argument " + index.toString());
    bindings.set(param, { name: format_type_expr(arg) });
  }

  return bindings;
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
): SourceTypeFact | undefined {
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

  const expected_types = new Map<FrontExpr, TypeExpr>();

  if (
    duck_type_roles_known(
      member.type_expr,
      declaration.roles,
      role_types,
    )
  ) {
    const expected_type = instantiate_duck_type(member.type_expr, role_types);
    expect(expected_type, "Missing instantiated duck member type");
    expected_types.set(value, expected_type);
  }

  let implementation_facts = source_facts(
    source_with_validation_value(source, value),
  );
  let implementation_type = implementation_facts.editor_type_of.get(value);

  if (
    implementation_type?.call_result === undefined &&
    expected_types.size !== 0
  ) {
    implementation_facts = source_facts(
      source_with_validation_value(source, value, expected_types),
    );
    implementation_type = implementation_facts.editor_type_of.get(value);
  }

  if (implementation_type?.call_params === undefined) {
    const expected_type = expected_types.get(value);
    let expected_text = "unknown";

    if (expected_type !== undefined) {
      expected_text = format_type_expr(expected_type);
    }

    throw new Error(
      "Duck member implementation parameters cannot be inferred: " +
        declaration.name + "." + member.name + " expects " + expected_text,
    );
  }

  const implementation_result = contextual_result ||
    implementation_type.call_result;

  for (let index = 0; index < param_types.length; index += 1) {
    const param_type = param_types[index];
    const param = value.params[index];
    const actual = implementation_type.call_params[index];
    expect(
      param_type,
      "Missing duck member parameter type " + index.toString(),
    );
    expect(param, "Missing extension parameter " + index.toString());
    expect(actual, "Missing extension parameter type " + index.toString());

    if (param.type_annotation !== undefined) {
      bind_duck_type_expr(
        declaration,
        member,
        param_type,
        param.type_annotation,
        role_types,
        types,
      );
      continue;
    }

    if (param.annotation !== undefined) {
      bind_duck_type_expr(
        declaration,
        member,
        param_type,
        parse_type_expr(tokenize(param.annotation)),
        role_types,
        types,
      );
      continue;
    }

    bind_duck_fact(
      declaration,
      member,
      param_type,
      actual,
      role_types,
      types,
    );
  }

  if (implementation_result !== undefined) {
    bind_duck_fact(
      declaration,
      member,
      duck_member_result_type(member),
      implementation_result,
      role_types,
      types,
    );
    implementation_type.call_result = implementation_result;
  }

  facts.editor_type_of.set(value, implementation_type);
  return implementation_result;
}

function source_with_validation_value(
  source: Source,
  value: FrontExpr,
  expected_types?: Map<FrontExpr, TypeExpr>,
): Source {
  const contextual = source_with_extension_values(
    source,
    undefined,
    expected_types,
  );

  if (
    contextual.statements.some((statement) =>
      statement.tag === "bind" && statement.value === value
    )
  ) {
    return contextual;
  }

  return {
    ...contextual,
    statements: [{
      tag: "bind",
      kind: "const",
      name: "_duck_validation",
      is_linear: false,
      annotation: undefined,
      type_annotation: expected_types?.get(value),
      value,
    }, ...contextual.statements],
  };
}

function bind_duck_fact(
  declaration: DuckDeclaration,
  member: DuckMember,
  pattern: TypeExpr,
  actual: SourceTypeFact,
  role_types: Map<string, DuckRoleBinding>,
  types: Map<string, TypeDeclaration>,
): void {
  if (pattern.tag === "top") {
    return;
  }

  if (pattern.tag === "borrow") {
    const actual_type = parse_duck_fact_type(declaration, member, actual);

    if (actual_type.tag === "borrow") {
      bind_duck_type_expr(
        declaration,
        member,
        pattern.value,
        actual_type.value,
        role_types,
        types,
      );
      return;
    }

    bind_duck_fact(
      declaration,
      member,
      pattern.value,
      actual,
      role_types,
      types,
    );
    return;
  }

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

    if (
      declaration.types.some((member) => member.name === pattern.name)
    ) {
      return;
    }

    expect_duck_type_name(declaration, member, pattern.name, actual, types);
    return;
  }

  if (pattern.tag === "arrow") {
    if (
      (actual.call_params === undefined || actual.call_result === undefined) &&
      (actual.inference_variable || actual.name === "function")
    ) {
      return;
    }

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
  seen: WeakMap<SourceTypeFact, Set<string>> = new WeakMap(),
): boolean {
  const expected_name = format_type_expr(expected);
  let expected_types = seen.get(actual);

  if (expected_types?.has(expected_name)) {
    return true;
  }

  if (expected_types === undefined) {
    expected_types = new Set();
    seen.set(actual, expected_types);
  }

  expected_types.add(expected_name);

  if (expected.tag === "top") {
    return true;
  }

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
        !duck_type_expr_matches_fact(param, received, types, seen)
      ) {
        return false;
      }
    }

    return duck_type_expr_matches_fact(
      expected.result,
      actual.call_result,
      types,
      seen,
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
      return duck_type_expr_matches_fact(target, actual, types, seen);
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
        !duck_type_expr_matches_fact(field_type, received, types, seen)
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
        !duck_type_expr_matches_fact(entry.type_expr, received, types, seen)
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

    const associated = role_types.get(pattern.name);

    if (associated !== undefined) {
      expect(
        actual.tag === "name" &&
          normalize_type_name(actual.name, types) ===
            normalize_type_name(associated.name, types),
        duck_type_mismatch(declaration, member, pattern, actual),
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
