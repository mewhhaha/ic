export type InferenceScalar =
  | "Bool"
  | "Unit"
  | "Int"
  | "I32"
  | "U32"
  | "I64"
  | "Text"
  | "Bytes"
  | "Resume";

export type InferenceOwnership =
  | "scalar"
  | "bounded_borrow"
  | "frozen_shareable"
  | "ownership_transfer"
  | "unique_heap";

export type InferenceEffect = {
  effect: string;
  operation: string | undefined;
};

export type InferenceType =
  | { tag: "variable"; id: number; hint: string | undefined }
  | { tag: "scalar"; name: InferenceScalar }
  | { tag: "named"; name: string; args: InferenceType[] }
  | { tag: "product"; fields: InferenceProductField[] }
  | { tag: "record"; fields: InferenceRecordField[] }
  | { tag: "fixed_array"; length: number; element: InferenceType }
  | { tag: "sum"; cases: InferenceSumCase[] }
  | {
    tag: "function";
    params: InferenceType[];
    effects: InferenceEffect[];
    result: InferenceType;
  }
  | {
    tag: "owned";
    ownership: InferenceOwnership;
    value: InferenceType;
  }
  | { tag: "type_value"; represented: InferenceType };

export type InferenceProductField = {
  label: string | undefined;
  type: InferenceType;
};

export type InferenceRecordField = {
  label: string;
  type: InferenceType;
};

export type InferenceSumCase = {
  label: string;
  payload: InferenceType;
};

export type InferenceAliasNormalizer = (
  type: Extract<InferenceType, { tag: "named" }>,
) => InferenceType | undefined;

export type TypeConstraint = {
  left: InferenceType;
  right: InferenceType;
  site: string;
};

export type TypeScheme = {
  quantified_variables: number[];
  type: Extract<InferenceType, { tag: "function" }>;
};

export type InferenceBinding =
  | { kind: "monomorphic"; type: InferenceType }
  | { kind: "statically_known_const"; scheme: TypeScheme };

export function monomorphic_type_binding(
  type: InferenceType,
): InferenceBinding {
  return { kind: "monomorphic", type };
}

export function statically_known_const_type_binding(
  scheme: TypeScheme,
): InferenceBinding {
  return { kind: "statically_known_const", scheme };
}

export function scalar_representation_compatible(
  left: InferenceScalar,
  right: InferenceScalar,
): boolean {
  if (left === right) {
    return true;
  }

  if (left === "Int" && right === "I32") {
    return true;
  }

  return left === "I32" && right === "Int";
}

export function format_inference_type(type: InferenceType): string {
  switch (type.tag) {
    case "variable":
      if (type.hint) {
        return "?" + type.id + "(" + type.hint + ")";
      }

      return "?" + type.id;

    case "scalar":
      return type.name;

    case "named": {
      if (type.args.length === 0) {
        return type.name;
      }

      return type.name + "<" +
        type.args.map(format_inference_type).join(", ") + ">";
    }

    case "product":
      return "[" + type.fields.map((field) => {
        if (field.label) {
          return "." + field.label + " = " +
            format_inference_type(field.type);
        }

        return format_inference_type(field.type);
      }).join(", ") + "]";

    case "record":
      return "{" + type.fields.map((field) => {
        return field.label + ": " + format_inference_type(field.type);
      }).join(", ") + "}";

    case "fixed_array":
      return "[" + format_inference_type(type.element) + "; " +
        type.length + "]";

    case "sum":
      return type.cases.map((sum_case) => {
        return "." + sum_case.label + " = " +
          format_inference_type(sum_case.payload);
      }).join(" | ");

    case "function": {
      const effects = type.effects.map(format_inference_effect).join(", ");
      return "(" + type.params.map(format_inference_type).join(", ") +
        ") -> <" + effects + "> " + format_inference_type(type.result);
    }

    case "owned":
      return type.ownership + " " + format_inference_type(type.value);

    case "type_value":
      return "Type<" + format_inference_type(type.represented) + ">";
  }
}

function format_inference_effect(effect: InferenceEffect): string {
  if (effect.operation) {
    return effect.effect + "." + effect.operation;
  }

  return effect.effect;
}

export class TypeInference {
  private next_variable_id = 0;
  private substitutions = new Map<number, InferenceType>();
  private constraints: TypeConstraint[] = [];

  constructor(private normalize_alias?: InferenceAliasNormalizer) {}

  fresh_variable(hint?: string): InferenceType {
    const variable: InferenceType = {
      tag: "variable",
      id: this.next_variable_id,
      hint,
    };
    this.next_variable_id += 1;
    return variable;
  }

  constrain(
    left: InferenceType,
    right: InferenceType,
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

  unify(left: InferenceType, right: InferenceType, site: string): void {
    const substitutions_before = this.substitutions;
    this.substitutions = new Map(substitutions_before);

    try {
      this.unify_at(left, right, site);
    } catch (error) {
      this.substitutions = substitutions_before;
      throw error;
    }
  }

  substitute(type: InferenceType): InferenceType {
    const head = this.normalize_head(type);

    switch (head.tag) {
      case "variable":
      case "scalar":
        return head;

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
    }
  }

  unresolved_variables(type: InferenceType): InferenceType[] {
    const unresolved = new Map<number, InferenceType>();
    this.collect_unresolved(type, unresolved);
    return [...unresolved.values()].sort((left, right) => {
      if (left.tag !== "variable" || right.tag !== "variable") {
        throw new Error("Non-variable in unresolved type variable set");
      }

      return left.id - right.id;
    });
  }

  require_resolved(type: InferenceType, site: string): InferenceType {
    const unresolved = this.unresolved_variables(type);

    if (unresolved.length > 0) {
      throw new Error(
        site + ": unresolved inference variables " +
          unresolved.map(format_inference_type).join(", ") + " in " +
          format_inference_type(this.substitute(type)),
      );
    }

    return this.substitute(type);
  }

  generalize_statically_known_const(
    type: InferenceType,
    environment: InferenceBinding[],
  ): TypeScheme {
    const resolved = this.substitute(type);

    if (resolved.tag !== "function") {
      throw new Error(
        "Only a statically known const function can be generalized, got " +
          format_inference_type(resolved),
      );
    }

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

  instantiate_statically_known_const(scheme: TypeScheme): InferenceType {
    const replacements = new Map<number, InferenceType>();

    for (const variable of scheme.quantified_variables) {
      replacements.set(variable, this.fresh_variable());
    }

    return this.instantiate_type(scheme.type, replacements);
  }

  instantiate_binding(binding: InferenceBinding): InferenceType {
    if (binding.kind === "monomorphic") {
      return binding.type;
    }

    return this.instantiate_statically_known_const(binding.scheme);
  }

  private unify_at(
    raw_left: InferenceType,
    raw_right: InferenceType,
    site: string,
  ): void {
    const left = this.normalize_head(raw_left);
    const right = this.normalize_head(raw_right);

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
      case "scalar": {
        if (right.tag !== "scalar") {
          throw new Error("Expected scalar type during unification");
        }

        if (left.name !== right.name) {
          this.fail_unification(left, right, site, "scalar names differ");
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
    }
  }

  private normalize_head(type: InferenceType): InferenceType {
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

      const alias_key = format_inference_type(current);
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
    variable: Extract<InferenceType, { tag: "variable" }>,
    type: InferenceType,
    site: string,
  ): void {
    if (this.occurs(variable.id, type)) {
      throw new Error(
        site + ": occurs check failed: " + format_inference_type(variable) +
          " occurs in " + format_inference_type(this.substitute(type)),
      );
    }

    this.substitutions.set(variable.id, type);
  }

  private occurs(variable: number, type: InferenceType): boolean {
    const resolved = this.normalize_head(type);

    switch (resolved.tag) {
      case "variable":
        return resolved.id === variable;

      case "scalar":
        return false;

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
    }
  }

  private collect_unresolved(
    type: InferenceType,
    unresolved: Map<number, InferenceType>,
  ): void {
    const resolved = this.normalize_head(type);

    if (resolved.tag === "variable") {
      unresolved.set(resolved.id, resolved);
      return;
    }

    this.visit_children(resolved, (child) => {
      this.collect_unresolved(child, unresolved);
    });
  }

  private collect_free_variables(
    type: InferenceType,
    free: Set<number>,
  ): void {
    const resolved = this.normalize_head(type);

    if (resolved.tag === "variable") {
      free.add(resolved.id);
      return;
    }

    this.visit_children(resolved, (child) => {
      this.collect_free_variables(child, free);
    });
  }

  private visit_children(
    type: Exclude<InferenceType, { tag: "variable" }>,
    visit: (type: InferenceType) => void,
  ): void {
    switch (type.tag) {
      case "scalar":
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
    }
  }

  private instantiate_type(
    type: InferenceType,
    replacements: Map<number, InferenceType>,
  ): InferenceType {
    if (type.tag === "variable") {
      const replacement = replacements.get(type.id);

      if (replacement) {
        return replacement;
      }
    }

    const resolved = this.normalize_head(type);

    switch (resolved.tag) {
      case "variable":
      case "scalar":
        return resolved;

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
    }
  }

  private fail_unification(
    left: InferenceType,
    right: InferenceType,
    site: string,
    reason: string,
  ): never {
    throw new Error(
      site + ": cannot unify " + format_inference_type(left) + " with " +
        format_inference_type(right) + ": " + reason,
    );
  }
}

function same_effects(
  left: InferenceEffect[],
  right: InferenceEffect[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const left_effect = left[index];
    const right_effect = right[index];

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
