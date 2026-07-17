export type TypeScalar =
  | "Bool"
  | "Unit"
  | "Int"
  | "I32"
  | "U32"
  | "I64"
  | "F32"
  | "F64"
  | "F32x4"
  | "Text"
  | "Bytes"
  | "Resume"
  | "Type";

export type TypeOwnership =
  | "scalar"
  | "bounded_borrow"
  | "frozen_shareable"
  | "ownership_transfer"
  | "unique_heap";

export type TypeEffect = {
  effect: string;
  operation: string | undefined;
};

export type Type =
  | { tag: "variable"; id: number; hint: string | undefined }
  | { tag: "rigid"; id: number; name: string }
  | { tag: "forall"; quantified_variables: number[]; body: Type }
  | { tag: "top" }
  | { tag: "never" }
  | { tag: "scalar"; name: TypeScalar }
  | { tag: "integer"; signed: boolean; width: number }
  | { tag: "named"; name: string; args: Type[] }
  | { tag: "product"; fields: TypeProductField[] }
  | { tag: "record"; fields: TypeRecordField[] }
  | { tag: "fixed_array"; length: number; element: Type }
  | { tag: "sum"; cases: TypeSumCase[] }
  | {
    tag: "function";
    params: Type[];
    effects: TypeEffect[];
    result: Type;
  }
  | {
    tag: "owned";
    ownership: TypeOwnership;
    value: Type;
  }
  | { tag: "type_value"; represented: Type }
  | { tag: "union"; members: Type[] }
  | { tag: "intersection"; members: Type[] }
  | { tag: "difference"; base: Type; removed: Type };

export type TypeProductField = {
  label: string | undefined;
  type: Type;
};

export type TypeRecordField = {
  label: string;
  type: Type;
};

export type TypeSumCase = {
  label: string;
  payload: Type;
};

export type TypeAliasNormalizer = (
  type: Extract<Type, { tag: "named" }>,
) => Type | undefined;

export type TypeConstraint = {
  left: Type;
  right: Type;
  site: string;
};

export type TypeScheme = {
  quantified_variables: number[];
  type: Type;
};

export type TypeSkolemization = {
  type: Type;
  skolems: Map<number, Extract<Type, { tag: "rigid" }>>;
};

export type TypeBinding =
  | { kind: "monomorphic"; type: Type }
  | { kind: "statically_known_const"; scheme: TypeScheme };

export function monomorphic_type_binding(
  type: Type,
): TypeBinding {
  return { kind: "monomorphic", type };
}

export function statically_known_const_type_binding(
  scheme: TypeScheme,
): TypeBinding {
  return { kind: "statically_known_const", scheme };
}

export function scalar_representation_compatible(
  left: TypeScalar,
  right: TypeScalar,
): boolean {
  if (left === right) {
    return true;
  }

  const left_is_i32 = left === "Int" || left === "I32" || left === "U32";
  const right_is_i32 = right === "Int" || right === "I32" || right === "U32";

  if (left_is_i32 && right_is_i32) {
    return true;
  }

  return false;
}

export function format_type(type: Type): string {
  switch (type.tag) {
    case "variable":
      if (type.hint) {
        return "?" + type.id + "(" + type.hint + ")";
      }

      return "?" + type.id;

    case "rigid":
      return "$" + type.name + "#" + type.id.toString();

    case "forall":
      return "forall " + type.quantified_variables.map((variable) => {
        return "?" + variable.toString();
      }).join(" ") + ". " + format_type(type.body);

    case "top":
      return "Any";

    case "never":
      return "Never";

    case "scalar":
      return type.name;

    case "integer":
      return integer_type_name(type);

    case "named": {
      if (type.args.length === 0) {
        return type.name;
      }

      return type.name + "<" +
        type.args.map(format_type).join(", ") + ">";
    }

    case "product":
      return "[" + type.fields.map((field) => {
        if (field.label) {
          return "." + field.label + " = " +
            format_type(field.type);
        }

        return format_type(field.type);
      }).join(", ") + "]";

    case "record":
      return "[" + type.fields.map((field) => {
        return "." + field.label + " = " +
          format_type(field.type);
      }).join(", ") + "]";

    case "fixed_array":
      return "[" + format_type(type.element) + "; " +
        type.length + "]";

    case "sum":
      return type.cases.map((sum_case) => {
        return "." + sum_case.label + " = " +
          format_type(sum_case.payload);
      }).join(" | ");

    case "function": {
      const effects = type.effects.map(format_type_effect).join(", ");
      return "(" + type.params.map(format_type).join(", ") +
        ") -> <" + effects + "> " + format_type(type.result);
    }

    case "owned":
      return type.ownership + " " + format_type(type.value);

    case "type_value":
      return "Type<" + format_type(type.represented) + ">";

    case "union":
      return type.members.map(format_type).join(" | ");

    case "intersection":
      return type.members.map(format_type).join(" & ");

    case "difference":
      return format_type(type.base) + " \\ " + format_type(type.removed);
  }
}

function format_type_effect(effect: TypeEffect): string {
  if (effect.operation) {
    return effect.effect + "." + effect.operation;
  }

  return effect.effect;
}

export class TypeEngine {
  private next_variable_id = 0;
  private next_rigid_id = 0;
  private substitutions = new Map<number, Type>();
  private constraints: TypeConstraint[] = [];

  constructor(private normalize_alias?: TypeAliasNormalizer) {}

  fresh_variable(hint?: string): Type {
    const variable: Type = {
      tag: "variable",
      id: this.next_variable_id,
      hint,
    };
    this.next_variable_id += 1;
    return variable;
  }

  fresh_rigid(name: string): Type {
    const rigid: Type = {
      tag: "rigid",
      id: this.next_rigid_id,
      name,
    };
    this.next_rigid_id += 1;
    return rigid;
  }

  constrain(
    left: Type,
    right: Type,
    site: string,
  ): void {
    this.constraints.push({ left, right, site });
  }

  solve_constraints(): void {
    const pending = this.constraints;
    this.constraints = [];

    for (let index = 0; index < pending.length; index += 1) {
      const constraint = pending[index];

      if (!constraint) {
        throw new Error("Missing type constraint " + index);
      }

      try {
        this.unify(constraint.left, constraint.right, constraint.site);
      } catch (error) {
        this.constraints = pending.slice(index).concat(this.constraints);
        throw error;
      }
    }
  }

  unify(left: Type, right: Type, site: string): void {
    const substitutions_before = this.substitutions;
    this.substitutions = new Map(substitutions_before);

    try {
      this.unify_at(left, right, site);
    } catch (error) {
      this.substitutions = substitutions_before;
      throw error;
    }
  }

  substitute(type: Type): Type {
    const head = this.normalize_head(type);

    switch (head.tag) {
      case "variable":
      case "rigid":
      case "top":
      case "never":
      case "scalar":
      case "integer":
        return head;

      case "forall":
        return {
          tag: "forall",
          quantified_variables: [...head.quantified_variables],
          body: this.substitute(head.body),
        };

      case "named":
        return {
          tag: "named",
          name: head.name,
          args: head.args.map((arg) => this.substitute(arg)),
        };

      case "product":
        return {
          tag: "product",
          fields: head.fields.map((field) => {
            return { label: field.label, type: this.substitute(field.type) };
          }),
        };

      case "record":
        return {
          tag: "record",
          fields: head.fields.map((field) => {
            return { label: field.label, type: this.substitute(field.type) };
          }),
        };

      case "fixed_array":
        return {
          tag: "fixed_array",
          length: head.length,
          element: this.substitute(head.element),
        };

      case "sum":
        return {
          tag: "sum",
          cases: head.cases.map((sum_case) => {
            return {
              label: sum_case.label,
              payload: this.substitute(sum_case.payload),
            };
          }),
        };

      case "function":
        return {
          tag: "function",
          params: head.params.map((param) => this.substitute(param)),
          effects: head.effects.map((effect) => {
            return { effect: effect.effect, operation: effect.operation };
          }),
          result: this.substitute(head.result),
        };

      case "owned":
        return {
          tag: "owned",
          ownership: head.ownership,
          value: this.substitute(head.value),
        };

      case "type_value":
        return {
          tag: "type_value",
          represented: this.substitute(head.represented),
        };

      case "union":
        return {
          tag: "union",
          members: head.members.map((member) => this.substitute(member)),
        };

      case "intersection":
        return {
          tag: "intersection",
          members: head.members.map((member) => this.substitute(member)),
        };

      case "difference":
        return {
          tag: "difference",
          base: this.substitute(head.base),
          removed: this.substitute(head.removed),
        };
    }
  }

  unresolved_variables(type: Type): Type[] {
    const unresolved = new Map<number, Type>();
    this.collect_unresolved(type, unresolved);
    return [...unresolved.values()].sort((left, right) => {
      if (left.tag !== "variable" || right.tag !== "variable") {
        throw new Error("Non-variable in unresolved type variable set");
      }

      return left.id - right.id;
    });
  }

  require_resolved(type: Type, site: string): Type {
    const unresolved = this.unresolved_variables(type);

    if (unresolved.length > 0) {
      throw new Error(
        site + ": unresolved inference variables " +
          unresolved.map(format_type).join(", ") + " in " +
          format_type(this.substitute(type)),
      );
    }

    return this.substitute(type);
  }

  generalize(
    type: Type,
    environment: TypeBinding[],
  ): TypeScheme {
    const resolved = this.substitute(type);

    const environment_variables = new Set<number>();

    for (const binding of environment) {
      if (binding.kind === "monomorphic") {
        this.collect_free_variables(binding.type, environment_variables);
        continue;
      }

      const free = new Set<number>();
      this.collect_free_variables(binding.scheme.type, free);

      for (const variable of binding.scheme.quantified_variables) {
        free.delete(variable);
      }

      for (const variable of free) {
        environment_variables.add(variable);
      }
    }

    const free = new Set<number>();
    this.collect_free_variables(resolved, free);
    const quantified_variables = [...free].filter((variable) => {
      return !environment_variables.has(variable);
    }).sort((left, right) => left - right);

    return { quantified_variables, type: resolved };
  }

  instantiate(scheme: TypeScheme): Type {
    const replacements = new Map<number, Type>();

    for (const variable of scheme.quantified_variables) {
      replacements.set(variable, this.fresh_variable());
    }

    return this.instantiate_type(scheme.type, replacements);
  }

  generalize_statically_known_const(
    type: Type,
    environment: TypeBinding[],
  ): TypeScheme {
    return this.generalize(type, environment);
  }

  instantiate_statically_known_const(scheme: TypeScheme): Type {
    return this.instantiate(scheme);
  }

  instantiate_binding(binding: TypeBinding): Type {
    if (binding.kind === "monomorphic") {
      return binding.type;
    }

    return this.instantiate(binding.scheme);
  }

  skolemize(scheme: TypeScheme): Type {
    return this.skolemize_with_replacements(scheme).type;
  }

  skolemize_with_replacements(scheme: TypeScheme): TypeSkolemization {
    const replacements = new Map<number, Type>();
    const skolems = new Map<
      number,
      Extract<Type, { tag: "rigid" }>
    >();

    for (const variable of scheme.quantified_variables) {
      const skolem = this.fresh_rigid("forall_" + variable.toString());

      if (skolem.tag !== "rigid") {
        throw new Error("Fresh skolem has an invalid canonical tag");
      }

      replacements.set(variable, skolem);
      skolems.set(variable, skolem);
    }

    return {
      type: this.instantiate_type(scheme.type, replacements),
      skolems,
    };
  }

  alpha_equivalent(left: Type, right: Type): boolean {
    return type_key(this.normalize(left)) === type_key(this.normalize(right));
  }

  normalize(type: Type): Type {
    return this.normalize_type(this.substitute(type));
  }

  subtype(left: Type, right: Type): boolean {
    return this.subtype_at(this.normalize(left), this.normalize(right));
  }

  disjoint(left: Type, right: Type): boolean {
    return this.disjoint_at(this.normalize(left), this.normalize(right));
  }

  representation_compatible(left: Type, right: Type): boolean {
    return this.representation_compatible_at(
      this.normalize(left),
      this.normalize(right),
    );
  }

  constrain_subtype(actual: Type, expected: Type, site: string): void {
    const substitutions_before = this.substitutions;
    this.substitutions = new Map(substitutions_before);

    try {
      this.constrain_subtype_at(actual, expected, site);
    } catch (error) {
      this.substitutions = substitutions_before;
      throw error;
    }
  }

  reject_skolem_escape(type: Type, site: string): Type {
    const resolved = this.substitute(type);
    const rigid_variables: Type[] = [];
    this.collect_rigid_variables(resolved, rigid_variables);

    if (rigid_variables.length > 0) {
      throw new Error(
        site + ": rigid type escaped: " +
          rigid_variables.map(format_type).join(", ") + " in " +
          format_type(resolved),
      );
    }

    return resolved;
  }

  private unify_at(
    raw_left: Type,
    raw_right: Type,
    site: string,
  ): void {
    const left = this.normalize_type(this.normalize_head(raw_left));
    const right = this.normalize_type(this.normalize_head(raw_right));

    if (left.tag === "variable") {
      if (right.tag === "variable" && left.id === right.id) {
        return;
      }

      this.bind_variable(left, right, site);
      return;
    }

    if (right.tag === "variable") {
      this.bind_variable(right, left, site);
      return;
    }

    if (left.tag !== right.tag) {
      this.fail_unification(left, right, site, "type constructors differ");
    }

    switch (left.tag) {
      case "rigid": {
        if (right.tag !== "rigid") {
          throw new Error("Expected rigid type during unification");
        }

        if (left.id !== right.id) {
          this.fail_unification(left, right, site, "rigid variables differ");
        }

        return;
      }

      case "forall": {
        if (right.tag !== "forall") {
          throw new Error("Expected forall type during unification");
        }

        if (!this.alpha_equivalent(left, right)) {
          this.fail_unification(
            left,
            right,
            site,
            "quantified types differ",
          );
        }

        return;
      }

      case "top":
      case "never":
        return;

      case "scalar": {
        if (right.tag !== "scalar") {
          throw new Error("Expected scalar type during unification");
        }

        if (left.name !== right.name) {
          this.fail_unification(left, right, site, "scalar names differ");
        }

        return;
      }

      case "integer": {
        if (right.tag !== "integer") {
          throw new Error("Expected integer type during unification");
        }

        if (left.signed !== right.signed || left.width !== right.width) {
          this.fail_unification(left, right, site, "integer types differ");
        }

        return;
      }

      case "named": {
        if (right.tag !== "named") {
          throw new Error("Expected named type during unification");
        }

        if (left.name !== right.name) {
          this.fail_unification(left, right, site, "nominal names differ");
        }

        if (left.args.length !== right.args.length) {
          this.fail_unification(
            left,
            right,
            site,
            "type argument counts differ",
          );
        }

        for (let index = 0; index < left.args.length; index += 1) {
          const left_arg = left.args[index];
          const right_arg = right.args[index];

          if (!left_arg || !right_arg) {
            throw new Error("Missing named type argument " + index);
          }

          this.unify_at(
            left_arg,
            right_arg,
            site + " type argument " + index,
          );
        }

        return;
      }

      case "product": {
        if (right.tag !== "product") {
          throw new Error("Expected product type during unification");
        }

        if (left.fields.length !== right.fields.length) {
          this.fail_unification(left, right, site, "product lengths differ");
        }

        for (let index = 0; index < left.fields.length; index += 1) {
          const left_field = left.fields[index];
          const right_field = right.fields[index];

          if (!left_field || !right_field) {
            throw new Error("Missing product field " + index);
          }

          if (left_field.label !== right_field.label) {
            this.fail_unification(
              left,
              right,
              site,
              "product labels differ at index " + index,
            );
          }

          this.unify_at(
            left_field.type,
            right_field.type,
            site + " product field " + index,
          );
        }

        return;
      }

      case "record": {
        if (right.tag !== "record") {
          throw new Error("Expected record type during unification");
        }

        if (left.fields.length !== right.fields.length) {
          this.fail_unification(
            left,
            right,
            site,
            "record field counts differ",
          );
        }

        for (let index = 0; index < left.fields.length; index += 1) {
          const left_field = left.fields[index];
          const right_field = right.fields[index];

          if (!left_field || !right_field) {
            throw new Error("Missing record field " + index);
          }

          if (left_field.label !== right_field.label) {
            this.fail_unification(
              left,
              right,
              site,
              "record labels differ at index " + index,
            );
          }

          this.unify_at(
            left_field.type,
            right_field.type,
            site + " record field " + left_field.label,
          );
        }

        return;
      }

      case "fixed_array": {
        if (right.tag !== "fixed_array") {
          throw new Error("Expected fixed array type during unification");
        }

        if (left.length !== right.length) {
          this.fail_unification(left, right, site, "array lengths differ");
        }

        this.unify_at(left.element, right.element, site + " array element");
        return;
      }

      case "sum": {
        if (right.tag !== "sum") {
          throw new Error("Expected sum type during unification");
        }

        if (left.cases.length !== right.cases.length) {
          this.fail_unification(left, right, site, "sum case counts differ");
        }

        for (let index = 0; index < left.cases.length; index += 1) {
          const left_case = left.cases[index];
          const right_case = right.cases[index];

          if (!left_case || !right_case) {
            throw new Error("Missing sum case " + index);
          }

          if (left_case.label !== right_case.label) {
            this.fail_unification(
              left,
              right,
              site,
              "sum labels differ at index " + index,
            );
          }

          this.unify_at(
            left_case.payload,
            right_case.payload,
            site + " sum case " + left_case.label,
          );
        }

        return;
      }

      case "function": {
        if (right.tag !== "function") {
          throw new Error("Expected function type during unification");
        }

        if (left.params.length !== right.params.length) {
          this.fail_unification(
            left,
            right,
            site,
            "function parameter counts differ",
          );
        }

        if (!same_effects(left.effects, right.effects)) {
          this.fail_unification(left, right, site, "function effects differ");
        }

        for (let index = 0; index < left.params.length; index += 1) {
          const left_param = left.params[index];
          const right_param = right.params[index];

          if (!left_param || !right_param) {
            throw new Error("Missing function parameter " + index);
          }

          this.unify_at(
            left_param,
            right_param,
            site + " function parameter " + index,
          );
        }

        this.unify_at(left.result, right.result, site + " function result");
        return;
      }

      case "owned": {
        if (right.tag !== "owned") {
          throw new Error("Expected ownership type during unification");
        }

        if (left.ownership !== right.ownership) {
          this.fail_unification(left, right, site, "ownership modes differ");
        }

        this.unify_at(left.value, right.value, site + " owned value");
        return;
      }

      case "type_value": {
        if (right.tag !== "type_value") {
          throw new Error("Expected type-value during unification");
        }

        this.unify_at(
          left.represented,
          right.represented,
          site + " represented type",
        );
        return;
      }

      case "union":
      case "intersection": {
        if (right.tag !== left.tag) {
          throw new Error("Expected matching type-set operator");
        }

        const normalized_left = this.normalize(left);
        const normalized_right = this.normalize(right);

        if (!this.alpha_equivalent(normalized_left, normalized_right)) {
          this.fail_unification(
            normalized_left,
            normalized_right,
            site,
            "type-set members differ",
          );
        }

        return;
      }

      case "difference": {
        if (right.tag !== "difference") {
          throw new Error("Expected type-set difference during unification");
        }

        this.unify_at(left.base, right.base, site + " difference base");
        this.unify_at(
          left.removed,
          right.removed,
          site + " difference removal",
        );
        return;
      }
    }
  }

  private normalize_head(type: Type): Type {
    let current = type;
    const aliases = new Set<string>();

    while (true) {
      if (current.tag === "variable") {
        const substitution = this.substitutions.get(current.id);

        if (!substitution) {
          return current;
        }

        current = substitution;
        continue;
      }

      if (current.tag !== "named" || !this.normalize_alias) {
        return current;
      }

      const alias_key = format_type(current);
      const normalized = this.normalize_alias(current);

      if (!normalized) {
        return current;
      }

      if (aliases.has(alias_key)) {
        throw new Error("Cyclic type alias normalization for " + alias_key);
      }

      aliases.add(alias_key);
      current = normalized;
    }
  }

  private bind_variable(
    variable: Extract<Type, { tag: "variable" }>,
    type: Type,
    site: string,
  ): void {
    if (this.contains_forall(type)) {
      throw new Error(
        site + ": predicative inference cannot bind " +
          format_type(variable) + " to " + format_type(type),
      );
    }

    if (this.occurs(variable.id, type)) {
      throw new Error(
        site + ": occurs check failed: " + format_type(variable) +
          " occurs in " + format_type(this.substitute(type)),
      );
    }

    this.substitutions.set(variable.id, type);
  }

  private occurs(variable: number, type: Type): boolean {
    const resolved = this.normalize_head(type);

    switch (resolved.tag) {
      case "variable":
        return resolved.id === variable;

      case "rigid":
      case "top":
      case "never":
      case "scalar":
      case "integer":
        return false;

      case "forall":
        if (resolved.quantified_variables.includes(variable)) {
          return false;
        }

        return this.occurs(variable, resolved.body);

      case "named":
        return resolved.args.some((arg) => this.occurs(variable, arg));

      case "product":
      case "record":
        return resolved.fields.some((field) => {
          return this.occurs(variable, field.type);
        });

      case "fixed_array":
        return this.occurs(variable, resolved.element);

      case "sum":
        return resolved.cases.some((sum_case) => {
          return this.occurs(variable, sum_case.payload);
        });

      case "function":
        if (resolved.params.some((param) => this.occurs(variable, param))) {
          return true;
        }

        return this.occurs(variable, resolved.result);

      case "owned":
        return this.occurs(variable, resolved.value);

      case "type_value":
        return this.occurs(variable, resolved.represented);

      case "union":
      case "intersection":
        return resolved.members.some((member) => {
          return this.occurs(variable, member);
        });

      case "difference":
        return this.occurs(variable, resolved.base) ||
          this.occurs(variable, resolved.removed);
    }
  }

  private contains_forall(type: Type): boolean {
    const resolved = this.normalize_head(type);

    if (resolved.tag === "forall") {
      return true;
    }

    if (resolved.tag === "variable") {
      return false;
    }

    let found = false;
    this.visit_children(resolved, (child) => {
      if (!found && this.contains_forall(child)) {
        found = true;
      }
    });
    return found;
  }

  private collect_rigid_variables(type: Type, rigid_variables: Type[]): void {
    const resolved = this.normalize_head(type);

    if (resolved.tag === "rigid") {
      if (
        !rigid_variables.some((rigid) => {
          return rigid.tag === "rigid" && rigid.id === resolved.id;
        })
      ) {
        rigid_variables.push(resolved);
      }
      return;
    }

    if (resolved.tag === "variable") {
      return;
    }

    this.visit_children(resolved, (child) => {
      this.collect_rigid_variables(child, rigid_variables);
    });
  }

  private collect_unresolved(
    type: Type,
    unresolved: Map<number, Type>,
  ): void {
    const resolved = this.normalize_head(type);

    if (resolved.tag === "variable") {
      unresolved.set(resolved.id, resolved);
      return;
    }

    if (resolved.tag === "forall") {
      const body_variables = new Map<number, Type>();
      this.collect_unresolved(resolved.body, body_variables);

      for (const variable of resolved.quantified_variables) {
        body_variables.delete(variable);
      }

      for (const [id, variable] of body_variables) {
        unresolved.set(id, variable);
      }

      return;
    }

    this.visit_children(resolved, (child) => {
      this.collect_unresolved(child, unresolved);
    });
  }

  private collect_free_variables(
    type: Type,
    free: Set<number>,
  ): void {
    const resolved = this.normalize_head(type);

    if (resolved.tag === "variable") {
      free.add(resolved.id);
      return;
    }

    if (resolved.tag === "forall") {
      const body_free = new Set<number>();
      this.collect_free_variables(resolved.body, body_free);

      for (const variable of resolved.quantified_variables) {
        body_free.delete(variable);
      }

      for (const variable of body_free) {
        free.add(variable);
      }

      return;
    }

    this.visit_children(resolved, (child) => {
      this.collect_free_variables(child, free);
    });
  }

  private visit_children(
    type: Exclude<Type, { tag: "variable" }>,
    visit: (type: Type) => void,
  ): void {
    switch (type.tag) {
      case "rigid":
      case "top":
      case "never":
      case "scalar":
        return;

      case "forall":
        visit(type.body);
        return;

      case "named":
        for (const arg of type.args) {
          visit(arg);
        }
        return;

      case "product":
      case "record":
        for (const field of type.fields) {
          visit(field.type);
        }
        return;

      case "fixed_array":
        visit(type.element);
        return;

      case "sum":
        for (const sum_case of type.cases) {
          visit(sum_case.payload);
        }
        return;

      case "function":
        for (const param of type.params) {
          visit(param);
        }
        visit(type.result);
        return;

      case "owned":
        visit(type.value);
        return;

      case "type_value":
        visit(type.represented);
        return;

      case "union":
      case "intersection":
        for (const member of type.members) {
          visit(member);
        }
        return;

      case "difference":
        visit(type.base);
        visit(type.removed);
        return;
    }
  }

  private normalize_type(type: Type): Type {
    switch (type.tag) {
      case "variable":
      case "rigid":
      case "top":
      case "never":
      case "scalar":
      case "integer":
        return type;

      case "forall":
        return {
          tag: "forall",
          quantified_variables: [...type.quantified_variables],
          body: this.normalize_type(type.body),
        };

      case "named":
        return {
          tag: "named",
          name: type.name,
          args: type.args.map((arg) => this.normalize_type(arg)),
        };

      case "product":
        return {
          tag: "product",
          fields: type.fields.map((field) => {
            return {
              label: field.label,
              type: this.normalize_type(field.type),
            };
          }),
        };

      case "record":
        return {
          tag: "record",
          fields: type.fields.map((field) => {
            return {
              label: field.label,
              type: this.normalize_type(field.type),
            };
          }).sort((left, right) => left.label.localeCompare(right.label)),
        };

      case "fixed_array":
        return {
          tag: "fixed_array",
          length: type.length,
          element: this.normalize_type(type.element),
        };

      case "sum":
        return {
          tag: "sum",
          cases: type.cases.map((sum_case) => {
            return {
              label: sum_case.label,
              payload: this.normalize_type(sum_case.payload),
            };
          }).sort((left, right) => left.label.localeCompare(right.label)),
        };

      case "function": {
        const effects = new Map<string, TypeEffect>();

        for (const effect of type.effects) {
          const key = effect.effect + "." + effect.operation;
          effects.set(key, {
            effect: effect.effect,
            operation: effect.operation,
          });
        }

        return {
          tag: "function",
          params: type.params.map((param) => this.normalize_type(param)),
          effects: [...effects.values()].sort(compare_effects),
          result: this.normalize_type(type.result),
        };
      }

      case "owned":
        return {
          tag: "owned",
          ownership: type.ownership,
          value: this.normalize_type(type.value),
        };

      case "type_value":
        return {
          tag: "type_value",
          represented: this.normalize_type(type.represented),
        };

      case "union":
        return this.normalize_union(type.members);

      case "intersection":
        return this.normalize_intersection(type.members);

      case "difference": {
        const base = this.normalize_type(type.base);
        const removed = this.normalize_type(type.removed);

        if (base.tag === "never" || removed.tag === "top") {
          return { tag: "never" };
        }

        if (removed.tag === "never") {
          return base;
        }

        if (type_key(base) === type_key(removed)) {
          return { tag: "never" };
        }

        if (base.tag === "union") {
          const remaining = base.members.filter((member) => {
            return !this.subtype_at(member, removed);
          });
          return this.normalize_union(remaining);
        }

        return { tag: "difference", base, removed };
      }
    }
  }

  private normalize_union(members: Type[]): Type {
    const by_key = new Map<string, Type>();

    for (const member of members) {
      const normalized = this.normalize_type(member);

      if (normalized.tag === "top") {
        return normalized;
      }

      if (normalized.tag === "never") {
        continue;
      }

      if (normalized.tag === "union") {
        for (const nested of normalized.members) {
          by_key.set(type_key(nested), nested);
        }
        continue;
      }

      by_key.set(type_key(normalized), normalized);
    }

    const normalized = [...by_key.values()].sort((left, right) => {
      return type_key(left).localeCompare(type_key(right));
    });

    if (normalized.length === 0) {
      return { tag: "never" };
    }

    if (normalized.length === 1) {
      const member = normalized[0];

      if (member === undefined) {
        throw new Error("Missing normalized union member");
      }

      return member;
    }

    return { tag: "union", members: normalized };
  }

  private normalize_intersection(members: Type[]): Type {
    const by_key = new Map<string, Type>();

    for (const member of members) {
      const normalized = this.normalize_type(member);

      if (normalized.tag === "never") {
        return normalized;
      }

      if (normalized.tag === "top") {
        continue;
      }

      if (normalized.tag === "intersection") {
        for (const nested of normalized.members) {
          by_key.set(type_key(nested), nested);
        }
        continue;
      }

      by_key.set(type_key(normalized), normalized);
    }

    const normalized = [...by_key.values()].sort((left, right) => {
      return type_key(left).localeCompare(type_key(right));
    });

    if (normalized.length === 0) {
      return { tag: "top" };
    }

    if (normalized.length === 1) {
      const member = normalized[0];

      if (member === undefined) {
        throw new Error("Missing normalized intersection member");
      }

      return member;
    }

    return { tag: "intersection", members: normalized };
  }

  private subtype_at(left: Type, right: Type): boolean {
    if (type_key(left) === type_key(right)) {
      return true;
    }

    if (left.tag === "never" || right.tag === "top") {
      return true;
    }

    if (left.tag === "union") {
      return left.members.every((member) => this.subtype_at(member, right));
    }

    if (right.tag === "union") {
      return right.members.some((member) => this.subtype_at(left, member));
    }

    if (right.tag === "intersection") {
      return right.members.every((member) => this.subtype_at(left, member));
    }

    if (left.tag === "intersection") {
      return left.members.some((member) => this.subtype_at(member, right));
    }

    if (left.tag === "record" && right.tag === "record") {
      for (const right_field of right.fields) {
        const left_field = left.fields.find((field) => {
          return field.label === right_field.label;
        });

        if (
          left_field === undefined ||
          !this.subtype_at(left_field.type, right_field.type)
        ) {
          return false;
        }
      }

      return true;
    }

    if (left.tag === "sum" && right.tag === "sum") {
      for (const left_case of left.cases) {
        const right_case = right.cases.find((sum_case) => {
          return sum_case.label === left_case.label;
        });

        if (
          right_case === undefined ||
          !this.subtype_at(left_case.payload, right_case.payload)
        ) {
          return false;
        }
      }

      return true;
    }

    if (left.tag === "function" && right.tag === "function") {
      if (
        left.params.length !== right.params.length ||
        !same_effects(left.effects, right.effects)
      ) {
        return false;
      }

      for (let index = 0; index < left.params.length; index += 1) {
        const left_param = left.params[index];
        const right_param = right.params[index];

        if (
          left_param === undefined || right_param === undefined ||
          !this.subtype_at(right_param, left_param)
        ) {
          return false;
        }
      }

      return this.subtype_at(left.result, right.result);
    }

    if (left.tag === "owned" && right.tag === "owned") {
      return left.ownership === right.ownership &&
        this.subtype_at(left.value, right.value);
    }

    if (left.tag === "type_value" && right.tag === "type_value") {
      return this.subtype_at(left.represented, right.represented);
    }

    return false;
  }

  private disjoint_at(left: Type, right: Type): boolean {
    if (left.tag === "never" || right.tag === "never") {
      return true;
    }

    if (left.tag === "top" || right.tag === "top") {
      return false;
    }

    if (left.tag === "union") {
      return left.members.every((member) => this.disjoint_at(member, right));
    }

    if (right.tag === "union") {
      return right.members.every((member) => this.disjoint_at(left, member));
    }

    if (left.tag === "intersection") {
      return left.members.some((member) => this.disjoint_at(member, right));
    }

    if (right.tag === "intersection") {
      return right.members.some((member) => this.disjoint_at(left, member));
    }

    if (left.tag === "difference") {
      return this.disjoint_at(left.base, right) ||
        this.subtype_at(right, left.removed);
    }

    if (right.tag === "difference") {
      return this.disjoint_at(left, right.base) ||
        this.subtype_at(left, right.removed);
    }

    if (left.tag === "scalar" && right.tag === "scalar") {
      return !scalar_representation_compatible(left.name, right.name);
    }

    if (left.tag === "integer" && right.tag === "integer") {
      return left.signed !== right.signed || left.width !== right.width;
    }

    if (
      (left.tag === "integer" && right.tag === "scalar") ||
      (left.tag === "scalar" && right.tag === "integer")
    ) {
      return true;
    }

    if (left.tag === "named" && right.tag === "named") {
      if (left.name.startsWith("#") || right.name.startsWith("#")) {
        return left.name !== right.name;
      }

      return false;
    }

    if (
      (left.tag === "named" && left.name.startsWith("#") &&
        right.tag === "scalar") ||
      (right.tag === "named" && right.name.startsWith("#") &&
        left.tag === "scalar")
    ) {
      return true;
    }

    if (left.tag === "record" && right.tag === "record") {
      for (const left_field of left.fields) {
        const right_field = right.fields.find((field) => {
          return field.label === left_field.label;
        });

        if (
          right_field !== undefined &&
          this.disjoint_at(left_field.type, right_field.type)
        ) {
          return true;
        }
      }

      return false;
    }

    if (left.tag === "owned" && right.tag === "owned") {
      if (left.ownership !== right.ownership) {
        return true;
      }

      return this.disjoint_at(left.value, right.value);
    }

    return false;
  }

  private representation_compatible_at(left: Type, right: Type): boolean {
    if (type_key(left) === type_key(right)) {
      return true;
    }

    if (left.tag === "scalar" && right.tag === "scalar") {
      return scalar_representation_compatible(left.name, right.name);
    }

    if (left.tag === "union" || left.tag === "intersection") {
      return left.members.every((member) => {
        return this.representation_compatible_at(member, right);
      });
    }

    if (right.tag === "union" || right.tag === "intersection") {
      return right.members.every((member) => {
        return this.representation_compatible_at(left, member);
      });
    }

    if (left.tag === "difference") {
      return this.representation_compatible_at(left.base, right);
    }

    if (right.tag === "difference") {
      return this.representation_compatible_at(left, right.base);
    }

    if (left.tag === "named" && right.tag === "named") {
      if (left.name !== right.name || left.args.length !== right.args.length) {
        return false;
      }

      return left.args.every((arg, index) => {
        const right_arg = right.args[index];

        if (right_arg === undefined) {
          throw new Error("Missing representation type argument " + index);
        }

        return this.representation_compatible_at(arg, right_arg);
      });
    }

    if (left.tag === "product" && right.tag === "product") {
      if (left.fields.length !== right.fields.length) {
        return false;
      }

      return left.fields.every((field, index) => {
        const right_field = right.fields[index];

        if (
          right_field === undefined || field.label !== right_field.label
        ) {
          return false;
        }

        return this.representation_compatible_at(
          field.type,
          right_field.type,
        );
      });
    }

    if (left.tag === "record" && right.tag === "record") {
      if (left.fields.length !== right.fields.length) {
        return false;
      }

      return left.fields.every((field, index) => {
        const right_field = right.fields[index];

        if (
          right_field === undefined || field.label !== right_field.label
        ) {
          return false;
        }

        return this.representation_compatible_at(
          field.type,
          right_field.type,
        );
      });
    }

    if (left.tag === "fixed_array" && right.tag === "fixed_array") {
      return left.length === right.length &&
        this.representation_compatible_at(left.element, right.element);
    }

    if (left.tag === "sum" && right.tag === "sum") {
      if (left.cases.length !== right.cases.length) {
        return false;
      }

      return left.cases.every((sum_case, index) => {
        const right_case = right.cases[index];

        if (
          right_case === undefined || sum_case.label !== right_case.label
        ) {
          return false;
        }

        return this.representation_compatible_at(
          sum_case.payload,
          right_case.payload,
        );
      });
    }

    if (left.tag === "function" && right.tag === "function") {
      if (left.params.length !== right.params.length) {
        return false;
      }

      for (let index = 0; index < left.params.length; index += 1) {
        const left_param = left.params[index];
        const right_param = right.params[index];

        if (
          left_param === undefined || right_param === undefined ||
          !this.representation_compatible_at(left_param, right_param)
        ) {
          return false;
        }
      }

      return this.representation_compatible_at(left.result, right.result);
    }

    if (left.tag === "owned" && right.tag === "owned") {
      return left.ownership === right.ownership &&
        this.representation_compatible_at(left.value, right.value);
    }

    return false;
  }

  private constrain_subtype_at(
    raw_actual: Type,
    raw_expected: Type,
    site: string,
  ): void {
    const actual = this.normalize_type(this.normalize_head(raw_actual));
    const expected = this.normalize_type(this.normalize_head(raw_expected));

    if (expected.tag === "variable") {
      this.unify_at(expected, actual, site);
      return;
    }

    if (actual.tag === "never" || expected.tag === "top") {
      return;
    }

    if (expected.tag === "forall") {
      if (
        actual.tag !== "forall" ||
        !this.alpha_equivalent(actual, expected)
      ) {
        this.fail_unification(
          actual,
          expected,
          site,
          "polymorphic subtype does not satisfy its bound",
        );
      }

      return;
    }

    if (actual.tag === "forall") {
      const instantiated = this.instantiate({
        quantified_variables: actual.quantified_variables,
        type: actual.body,
      });
      this.constrain_subtype_at(instantiated, expected, site);
      return;
    }

    if (expected.tag === "union") {
      for (const member of expected.members) {
        const substitutions_before = this.substitutions;
        this.substitutions = new Map(substitutions_before);

        try {
          this.constrain_subtype_at(actual, member, site);
          return;
        } catch (error) {
          this.substitutions = substitutions_before;

          if (!(error instanceof Error)) {
            throw error;
          }
        }
      }

      this.fail_unification(
        actual,
        expected,
        site,
        "type is outside the union",
      );
    }

    if (expected.tag === "intersection") {
      for (const member of expected.members) {
        this.constrain_subtype_at(actual, member, site);
      }
      return;
    }

    if (expected.tag === "difference") {
      this.constrain_subtype_at(actual, expected.base, site);

      if (this.subtype_at(actual, expected.removed)) {
        this.fail_unification(
          actual,
          expected,
          site,
          "type is removed from the difference",
        );
      }

      return;
    }

    if (actual.tag === "union") {
      for (const member of actual.members) {
        this.constrain_subtype_at(member, expected, site);
      }
      return;
    }

    if (
      actual.tag === "scalar" && expected.tag === "scalar" &&
      scalar_representation_compatible(actual.name, expected.name)
    ) {
      return;
    }

    if (actual.tag === "record" && expected.tag === "record") {
      for (const expected_field of expected.fields) {
        const actual_field = actual.fields.find((field) => {
          return field.label === expected_field.label;
        });

        if (actual_field === undefined) {
          this.fail_unification(
            actual,
            expected,
            site,
            "record field is missing: " + expected_field.label,
          );
        }

        this.constrain_subtype_at(
          actual_field.type,
          expected_field.type,
          site + " record field " + expected_field.label,
        );
      }

      return;
    }

    if (actual.tag === "sum" && expected.tag === "sum") {
      for (const actual_case of actual.cases) {
        const expected_case = expected.cases.find((sum_case) => {
          return sum_case.label === actual_case.label;
        });

        if (expected_case === undefined) {
          this.fail_unification(
            actual,
            expected,
            site,
            "sum case is missing: " + actual_case.label,
          );
        }

        this.constrain_subtype_at(
          actual_case.payload,
          expected_case.payload,
          site + " sum case " + actual_case.label,
        );
      }

      return;
    }

    this.unify_at(expected, actual, site);
  }

  private instantiate_type(
    type: Type,
    replacements: Map<number, Type>,
  ): Type {
    if (type.tag === "variable") {
      const replacement = replacements.get(type.id);

      if (replacement) {
        return replacement;
      }
    }

    const resolved = this.normalize_head(type);

    switch (resolved.tag) {
      case "variable":
      case "rigid":
      case "top":
      case "never":
      case "scalar":
      case "integer":
        return resolved;

      case "forall": {
        const scoped = new Map(replacements);

        for (const variable of resolved.quantified_variables) {
          scoped.delete(variable);
        }

        return {
          tag: "forall",
          quantified_variables: [...resolved.quantified_variables],
          body: this.instantiate_type(resolved.body, scoped),
        };
      }

      case "named":
        return {
          tag: "named",
          name: resolved.name,
          args: resolved.args.map((arg) => {
            return this.instantiate_type(arg, replacements);
          }),
        };

      case "product":
        return {
          tag: "product",
          fields: resolved.fields.map((field) => {
            return {
              label: field.label,
              type: this.instantiate_type(field.type, replacements),
            };
          }),
        };

      case "record":
        return {
          tag: "record",
          fields: resolved.fields.map((field) => {
            return {
              label: field.label,
              type: this.instantiate_type(field.type, replacements),
            };
          }),
        };

      case "fixed_array":
        return {
          tag: "fixed_array",
          length: resolved.length,
          element: this.instantiate_type(resolved.element, replacements),
        };

      case "sum":
        return {
          tag: "sum",
          cases: resolved.cases.map((sum_case) => {
            return {
              label: sum_case.label,
              payload: this.instantiate_type(
                sum_case.payload,
                replacements,
              ),
            };
          }),
        };

      case "function":
        return {
          tag: "function",
          params: resolved.params.map((param) => {
            return this.instantiate_type(param, replacements);
          }),
          effects: resolved.effects.map((effect) => {
            return { effect: effect.effect, operation: effect.operation };
          }),
          result: this.instantiate_type(resolved.result, replacements),
        };

      case "owned":
        return {
          tag: "owned",
          ownership: resolved.ownership,
          value: this.instantiate_type(resolved.value, replacements),
        };

      case "type_value":
        return {
          tag: "type_value",
          represented: this.instantiate_type(
            resolved.represented,
            replacements,
          ),
        };

      case "union":
        return {
          tag: "union",
          members: resolved.members.map((member) => {
            return this.instantiate_type(member, replacements);
          }),
        };

      case "intersection":
        return {
          tag: "intersection",
          members: resolved.members.map((member) => {
            return this.instantiate_type(member, replacements);
          }),
        };

      case "difference":
        return {
          tag: "difference",
          base: this.instantiate_type(resolved.base, replacements),
          removed: this.instantiate_type(resolved.removed, replacements),
        };
    }
  }

  private fail_unification(
    left: Type,
    right: Type,
    site: string,
    reason: string,
  ): never {
    throw new Error(
      site + ": cannot unify " + format_type(left) + " with " +
        format_type(right) + ": " + reason,
    );
  }
}

function same_effects(
  left: TypeEffect[],
  right: TypeEffect[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const normalized_left = [...left].sort(compare_effects);
  const normalized_right = [...right].sort(compare_effects);

  for (let index = 0; index < normalized_left.length; index += 1) {
    const left_effect = normalized_left[index];
    const right_effect = normalized_right[index];

    if (!left_effect || !right_effect) {
      throw new Error("Missing inference effect " + index);
    }

    if (
      left_effect.effect !== right_effect.effect ||
      left_effect.operation !== right_effect.operation
    ) {
      return false;
    }
  }

  return true;
}

function compare_effects(left: TypeEffect, right: TypeEffect): number {
  const effect = left.effect.localeCompare(right.effect);

  if (effect !== 0) {
    return effect;
  }

  let left_operation = "";
  let right_operation = "";

  if (left.operation !== undefined) {
    left_operation = left.operation;
  }

  if (right.operation !== undefined) {
    right_operation = right.operation;
  }

  return left_operation.localeCompare(right_operation);
}

export function type_key(type: Type): string {
  return type_key_at(type, new Map(), { next_binder: 0 });
}

function type_key_at(
  type: Type,
  bound_variables: Map<number, number>,
  binders: { next_binder: number },
): string {
  switch (type.tag) {
    case "variable": {
      const bound = bound_variables.get(type.id);

      if (bound !== undefined) {
        return "bound(" + bound.toString() + ")";
      }

      return "variable(" + type.id.toString() + ")";
    }

    case "rigid":
      return "rigid(" + type.id.toString() + ")";

    case "forall": {
      const scoped = new Map(bound_variables);

      for (const variable of type.quantified_variables) {
        scoped.set(variable, binders.next_binder);
        binders.next_binder += 1;
      }

      return "forall(" + type.quantified_variables.length.toString() + "," +
        type_key_at(type.body, scoped, binders) + ")";
    }

    case "top":
    case "never":
      return type.tag;

    case "scalar":
      return "scalar(" + type.name + ")";

    case "integer":
      return "integer(" + integer_type_name(type) + ")";

    case "named":
      return "named(" + type.name + "," + type.args.map((arg) => {
        return type_key_at(arg, bound_variables, binders);
      }).join(",") + ")";

    case "product":
      return "product(" + type.fields.map((field) => {
        let label = "";

        if (field.label !== undefined) {
          label = field.label;
        }

        return label + ":" +
          type_key_at(field.type, bound_variables, binders);
      }).join(",") + ")";

    case "record":
      return "record(" + type.fields.map((field) => {
        return field.label + ":" +
          type_key_at(field.type, bound_variables, binders);
      }).join(",") + ")";

    case "fixed_array":
      return "array(" + type.length.toString() + "," +
        type_key_at(type.element, bound_variables, binders) + ")";

    case "sum":
      return "sum(" + type.cases.map((sum_case) => {
        return sum_case.label + ":" +
          type_key_at(sum_case.payload, bound_variables, binders);
      }).join(",") + ")";

    case "function":
      return "function(" + type.params.map((param) => {
        return type_key_at(param, bound_variables, binders);
      }).join(",") + ";" + type.effects.map((effect) => {
        return effect.effect + "." + effect.operation;
      }).join(",") + ";" +
        type_key_at(type.result, bound_variables, binders) + ")";

    case "owned":
      return "owned(" + type.ownership + "," +
        type_key_at(type.value, bound_variables, binders) + ")";

    case "type_value":
      return "type_value(" +
        type_key_at(type.represented, bound_variables, binders) + ")";

    case "union":
    case "intersection":
      return type.tag + "(" + type.members.map((member) => {
        return type_key_at(member, bound_variables, binders);
      }).join(",") + ")";

    case "difference":
      return "difference(" +
        type_key_at(type.base, bound_variables, binders) + "," +
        type_key_at(type.removed, bound_variables, binders) + ")";
  }
}
import { integer_type_name } from "../integer.ts";
