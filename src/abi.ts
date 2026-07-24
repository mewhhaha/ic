import type { FrontExpr, Source, TypeExpr, TypeField } from "./frontend/ast.ts";
import { resolve_front_type_value } from "./frontend/type_set_elaborate.ts";
import { tokenize } from "./frontend/tokenize.ts";
import { format_type_expr, parse_type_expr } from "./frontend/type_expr.ts";
import { substitute_front_expr } from "./frontend/substitute.ts";
import { fixed_array_length } from "./frontend/fixed_array_type.ts";
import { integer_type_from_name, integer_val_type } from "./integer.ts";

export type AbiOwnership =
  | "scalar"
  | "bounded_borrow"
  | "frozen_shareable"
  | "ownership_transfer"
  | "unique_heap";

export type AbiTypeRef =
  | { tag: "i32" }
  | { tag: "i64" }
  | { tag: "f32" }
  | { tag: "f64" }
  | { tag: "unit" }
  | { tag: "text" }
  | { tag: "bytes" }
  | { tag: "i32_slice" }
  | { tag: "text_slice" }
  | { tag: "resource"; effect: string }
  | { tag: "named"; name: string };

export type AbiValueContract = {
  type: AbiTypeRef;
  ownership: AbiOwnership;
};

export type AbiStructField = {
  name: string;
  type: AbiTypeRef;
};

export type AbiType =
  | {
    tag: "struct";
    name: string;
    fields: AbiStructField[];
  }
  | {
    tag: "union";
    name: string;
    cases: { name: string; payload: AbiTypeRef }[];
  }
  | {
    tag: "array";
    name: string;
    element: AbiTypeRef;
    length: number;
  };

export type AbiImport = {
  name: string;
  module: string;
  field: string;
  params: AbiValueContract[];
  result: AbiValueContract;
  effect?: {
    name: string;
    operation: string;
    resource_param: number;
  };
  init?: {
    field: string;
    effect: string;
  };
};

export type AbiEffectOperation = {
  name: string;
  execution: "synchronous" | "suspending";
  import: string;
  params: AbiValueContract[];
  result: AbiValueContract;
};

export type AbiEffect = {
  name: string;
  operations: Record<string, AbiEffectOperation>;
};

export type AbiInitField = {
  name: string;
  type: Extract<AbiTypeRef, { tag: "resource" }>;
  import: string;
};

export type AbiInit = {
  name: string;
  fields: AbiInitField[];
};

export type AbiEntry = {
  result: AbiValueContract | undefined;
};

export type AbiCallableValueContract = {
  type: AbiTypeRef;
  ownership: "scalar" | "move";
};

export type AbiCallable = {
  name: string;
  export: string;
  params: AbiCallableValueContract[];
  result: AbiCallableValueContract;
};

export type AbiManifest = {
  types: Record<string, AbiType>;
  imports: Record<string, AbiImport>;
  effects: Record<string, AbiEffect>;
  init: AbiInit | undefined;
  entry: AbiEntry | undefined;
  callables?: Record<string, AbiCallable>;
};

export function abi_fixed_array_schema_name(
  element: AbiTypeRef,
  length: number,
): string {
  if (!Number.isInteger(length) || length < 0) {
    throw new Error("ABI fixed array length must be a non-negative integer");
  }

  return "__duck_array_" + abi_type_ref_identity(element) + "_" +
    length.toString();
}

function abi_type_ref_identity(type: AbiTypeRef): string {
  if (type.tag === "resource") {
    return "resource_" + encodeURIComponent(type.effect);
  }

  if (type.tag === "named") {
    return "named_" + encodeURIComponent(type.name);
  }

  return type.tag;
}

export function build_abi_manifest(
  source: Source,
  compiled_source: Source = source,
): AbiManifest {
  const values = collect_type_values(source);
  const compiled_values = collect_type_values(compiled_source);

  for (const [name, value] of compiled_values) {
    values.set(name, value);
  }
  const types: Record<string, AbiType> = {};
  const fixed_arrays = new Map<
    string,
    { element: AbiTypeRef; length: number }
  >();
  const resolving = new Set<string>();

  function resolve_fixed_array(
    element: AbiTypeRef,
    length: number,
  ): AbiType {
    const name = abi_fixed_array_schema_name(element, length);
    const existing = fixed_arrays.get(name);

    if (!existing) {
      fixed_arrays.set(name, { element, length });
    }

    return resolve_named(name);
  }

  function resolve_named(name: string): AbiType {
    reject_resume_abi_type(name);
    materialize_applied_abi_type_value(name, values);
    const existing = types[name];

    if (existing) {
      return existing;
    }

    if (resolving.has(name)) {
      throw new Error("Recursive ABI type is not supported: " + name);
    }

    const fixed_array = fixed_arrays.get(name);

    if (fixed_array) {
      const result: AbiType = {
        tag: "array",
        name,
        element: fixed_array.element,
        length: fixed_array.length,
      };
      types[name] = result;
      return result;
    }

    const value = values.get(name);

    if (!value) {
      throw new Error("Missing ABI type value: " + name);
    }

    resolving.add(name);
    try {
      if (value.tag === "var") {
        const target = resolve_named(value.name);
        const alias: AbiType = {
          ...target,
          name,
        };
        types[name] = alias;
        return alias;
      }

      let resolved_value: FrontExpr = value;
      const specialized = resolve_front_type_value(
        value,
        values,
        new Set(resolving),
      );

      if (specialized) {
        resolved_value = specialized;
      }

      if (resolved_value.tag === "struct_type") {
        const fields: AbiStructField[] = [];

        for (const field of resolved_value.fields) {
          const type = abi_type_ref(
            field.type_name,
            values,
            resolve_named,
            resolve_fixed_array,
            resolving,
          );
          fields.push({ name: field.name, type });
        }

        const result: AbiType = {
          tag: "struct",
          name,
          fields,
        };
        types[name] = result;
        return result;
      }

      if (resolved_value.tag === "union_type") {
        const cases = [];

        for (const union_case of resolved_value.cases) {
          const payload = abi_type_ref(
            union_case.type_name,
            values,
            resolve_named,
            resolve_fixed_array,
            resolving,
          );

          cases.push({
            name: union_case.name,
            payload,
          });
        }

        const result: AbiType = {
          tag: "union",
          name,
          cases,
        };
        types[name] = result;
        return result;
      }

      throw new Error("ABI type value must be a struct or union: " + name);
    } finally {
      resolving.delete(name);
    }
  }

  const imports: Record<string, AbiImport> = {};
  const effects: Record<string, AbiEffect> = {};

  const declarations = source.declarations || [];

  for (const declaration of declarations) {
    if (declaration.tag !== "effect") {
      continue;
    }

    if (declaration.implementation !== "host") {
      continue;
    }

    if (effects[declaration.name]) {
      throw new Error("Duplicate ABI effect declaration: " + declaration.name);
    }

    const operations: Record<string, AbiEffectOperation> = {};

    for (const operation of declaration.operations) {
      if (operations[operation.name]) {
        throw new Error(
          "Duplicate ABI effect operation: " + declaration.name + "." +
            operation.name,
        );
      }

      const import_name = effect_import_name(declaration.name, operation.name);
      const operation_params = [];

      for (const param of operation.params) {
        operation_params.push(
          abi_effect_param_contract(
            param.type_name,
            param.ownership,
            values,
            resolve_named,
            resolve_fixed_array,
          ),
        );
      }

      const result = abi_effect_result_contract(
        operation.result.type_name,
        operation.result.ownership,
        values,
        resolve_named,
        resolve_fixed_array,
      );
      let execution: AbiEffectOperation["execution"] = "synchronous";
      if (operation.execution === "suspending") {
        execution = "suspending";
      }
      operations[operation.name] = {
        name: operation.name,
        execution,
        import: import_name,
        params: operation_params,
        result,
      };
      imports[import_name] = {
        name: import_name,
        module: "duck_effect",
        field: declaration.name + "." + operation.name,
        params: [
          {
            type: { tag: "resource", effect: declaration.name },
            ownership: "scalar",
          },
          ...operation_params,
        ],
        result,
        effect: {
          name: declaration.name,
          operation: operation.name,
          resource_param: 0,
        },
      };
    }

    effects[declaration.name] = { name: declaration.name, operations };
  }

  const init = abi_init(source, effects, imports);
  const callables = abi_callables(
    source,
    values,
    resolve_named,
    resolve_fixed_array,
  );

  return {
    types,
    imports,
    effects,
    init,
    entry: abi_entry(init, values, resolve_named),
    callables,
  };
}

function abi_callables(
  source: Source,
  values: Map<string, FrontExpr>,
  resolve_named: (name: string) => AbiType,
  resolve_fixed_array: (element: AbiTypeRef, length: number) => AbiType,
): Record<string, AbiCallable> {
  const callables: Record<string, AbiCallable> = {};

  for (const stmt of source.statements) {
    if (stmt.tag !== "bind" || !stmt.host_export) {
      continue;
    }

    if (
      stmt.type_annotation?.tag !== "arrow" ||
      (stmt.value.tag !== "lam" && stmt.value.tag !== "rec")
    ) {
      throw new Error(
        "Host callable requires an annotated function: " + stmt.name,
      );
    }

    if (callables[stmt.name]) {
      throw new Error("Duplicate host callable: " + stmt.name);
    }

    const param_types = abi_callable_param_types(
      stmt.name,
      stmt.type_annotation.param,
    );
    const params = param_types.map((type, index) => {
      return abi_callable_contract(
        stmt.name + " parameter " + index.toString(),
        type,
        values,
        resolve_named,
        resolve_fixed_array,
      );
    });
    const result = abi_callable_contract(
      stmt.name + " result",
      stmt.type_annotation.result,
      values,
      resolve_named,
      resolve_fixed_array,
    );

    callables[stmt.name] = {
      name: stmt.name,
      export: "__duck_abi_call_" + stmt.name,
      params,
      result,
    };
  }

  return callables;
}

function abi_callable_param_types(
  name: string,
  type: TypeExpr,
): TypeExpr[] {
  if (type.tag === "product") {
    for (const entry of type.entries) {
      if (entry.label !== undefined) {
        throw new Error(
          "Host callable named product parameters are not supported: " +
            name,
        );
      }
    }

    return type.entries.map((entry) => entry.type_expr);
  }

  if (type.tag === "tuple") {
    return type.items;
  }

  return [type];
}

function abi_callable_contract(
  location: string,
  type: TypeExpr,
  values: Map<string, FrontExpr>,
  resolve_named: (name: string) => AbiType,
  resolve_fixed_array: (element: AbiTypeRef, length: number) => AbiType,
): AbiCallableValueContract {
  if (type.tag === "borrow" || type.tag === "frozen") {
    throw new Error(
      "Host callable cannot expose borrowed or frozen values: " +
        location,
    );
  }

  if (type.tag === "arrow") {
    throw new Error(
      "Host callable cannot expose function values: " + location,
    );
  }

  if (type.tag !== "name") {
    throw new Error(
      "Host callable uses an unsupported type shape: " + location,
    );
  }

  if (type.name === "F32x4") {
    throw new Error("Host callable cannot expose F32x4: " + location);
  }

  const ref = abi_type_ref(
    type.name,
    values,
    resolve_named,
    resolve_fixed_array,
  );

  if (is_scalar_abi_type(ref)) {
    return { type: ref, ownership: "scalar" };
  }

  if (
    ref.tag === "text" || ref.tag === "bytes" || ref.tag === "named"
  ) {
    return { type: ref, ownership: "move" };
  }

  throw new Error(
    "Host callable uses an unsupported pointer type: " + location,
  );
}

function effect_import_name(effect: string, operation: string): string {
  return "__duck_effect_" + effect + "_" + operation;
}

function abi_effect_param_contract(
  type_name: string,
  ownership: AbiOwnership,
  values: Map<string, FrontExpr>,
  resolve_named: (name: string) => AbiType,
  resolve_fixed_array: (element: AbiTypeRef, length: number) => AbiType,
): AbiValueContract {
  const type = abi_type_ref(
    type_name,
    values,
    resolve_named,
    resolve_fixed_array,
  );

  validate_effect_ownership(type_name, type, ownership, false);
  return { type, ownership };
}

function abi_effect_result_contract(
  type_name: string,
  ownership: AbiOwnership,
  values: Map<string, FrontExpr>,
  resolve_named: (name: string) => AbiType,
  resolve_fixed_array: (element: AbiTypeRef, length: number) => AbiType,
): AbiValueContract {
  const type = abi_type_ref(
    type_name,
    values,
    resolve_named,
    resolve_fixed_array,
  );

  validate_effect_ownership(type_name, type, ownership, true);
  return { type, ownership };
}

function validate_effect_ownership(
  type_name: string,
  type: AbiTypeRef,
  ownership: AbiOwnership,
  is_result: boolean,
): void {
  const scalar = is_scalar_abi_type(type);

  if (ownership === "scalar" && !scalar) {
    throw new Error(
      "Effect contract uses scalar ownership for rich type: " + type_name,
    );
  }

  if (ownership !== "scalar" && scalar) {
    throw new Error(
      "Effect contract uses heap ownership for scalar type: " + type_name,
    );
  }

  if (is_result && ownership === "ownership_transfer") {
    throw new Error("Effect result cannot use ownership_transfer");
  }

  if (!is_result && ownership === "unique_heap") {
    throw new Error("Effect parameter cannot use unique_heap");
  }
}

function is_scalar_abi_type(type: AbiTypeRef): boolean {
  return type.tag === "i32" || type.tag === "i64" || type.tag === "f32" ||
    type.tag === "f64" || type.tag === "unit";
}

function abi_init(
  source: Source,
  effects: Record<string, AbiEffect>,
  imports: Record<string, AbiImport>,
): AbiInit | undefined {
  const declarations = source.declarations || [];
  const declaration = declarations.find((item) =>
    (item.tag === "record" ||
      (item.tag === "type" && item.params.length === 0 &&
        item.body.tag === "product" && !item.body.positional)) &&
    item.name === "Init"
  );

  if (!declaration) {
    return undefined;
  }

  let declaration_fields: TypeField[];

  if (declaration.tag === "record") {
    declaration_fields = declaration.fields;
  } else if (declaration.tag === "type" && declaration.body.tag === "product") {
    declaration_fields = declaration.body.fields;
  } else {
    throw new Error("Init must be a named product type");
  }

  const fields: AbiInitField[] = [];
  const field_names = new Set<string>();

  for (const field of declaration_fields) {
    if (field_names.has(field.name)) {
      throw new Error("Duplicate Init field: " + field.name);
    }

    field_names.add(field.name);

    if (!effects[field.type_name]) {
      throw new Error(
        "Init field must name a declared effect: " + field.name + ": " +
          field.type_name,
      );
    }

    const import_name = "__duck_init_" + field.name;

    if (imports[import_name]) {
      throw new Error("Duplicate ABI import name: " + import_name);
    }

    const resource_type = { tag: "resource" as const, effect: field.type_name };
    fields.push({
      name: field.name,
      type: resource_type,
      import: import_name,
    });
    imports[import_name] = {
      name: import_name,
      module: "duck_init",
      field: field.name,
      params: [],
      result: { type: resource_type, ownership: "scalar" },
      init: { field: field.name, effect: field.type_name },
    };
  }

  return { name: declaration.name, fields };
}

function abi_entry(
  init: AbiInit | undefined,
  values: Map<string, FrontExpr>,
  resolve_named: (name: string) => AbiType,
): AbiEntry | undefined {
  let result: AbiValueContract | undefined;
  const result_type_name = "duck_entry_result_type";

  if (values.has(result_type_name)) {
    resolve_named(result_type_name);
    result = {
      type: { tag: "named", name: result_type_name },
      ownership: "unique_heap",
    };
  }

  if (!init && !result) {
    return undefined;
  }

  return {
    result,
  };
}

function collect_type_values(source: Source): Map<string, FrontExpr> {
  const values = new Map<string, FrontExpr>();

  const declarations = source.declarations || [];

  for (const declaration of declarations) {
    if (declaration.tag === "record") {
      values.set(declaration.name, {
        tag: "struct_type",
        fields: declaration.fields,
      });
    }
  }

  for (const stmt of source.statements) {
    if (stmt.tag === "bind" && stmt.kind === "const") {
      values.set(stmt.name, stmt.value);
    }
  }

  return values;
}

function abi_type_ref(
  name: string,
  values: Map<string, FrontExpr>,
  resolve_named: (name: string) => AbiType,
  resolve_fixed_array: (element: AbiTypeRef, length: number) => AbiType,
  resolving?: ReadonlySet<string>,
): AbiTypeRef {
  const primitive = primitive_abi_type_ref(name);

  if (primitive) {
    return primitive;
  }

  const primitive_alias = primitive_abi_type_alias(name, values);

  if (primitive_alias) {
    return primitive_alias;
  }

  if (name.startsWith("[")) {
    const parsed = parse_type_expr(tokenize(name));

    if (parsed.tag === "array") {
      return abi_fixed_array_type_ref(
        parsed,
        values,
        resolve_named,
        resolve_fixed_array,
      );
    }
  }

  materialize_applied_abi_type_value(name, values);

  if (!values.has(name)) {
    throw new Error("Missing ABI type reference: " + name);
  }

  if (!resolving?.has(name)) {
    resolve_named(name);
  }
  return { tag: "named", name };
}

function materialize_applied_abi_type_value(
  name: string,
  values: Map<string, FrontExpr>,
): void {
  if (values.has(name)) {
    return;
  }

  const parsed = parse_type_expr(tokenize(name));
  const args: TypeExpr[] = [];
  let constructor_expr = parsed;

  while (constructor_expr.tag === "apply") {
    args.unshift(constructor_expr.arg);
    constructor_expr = constructor_expr.func;
  }

  if (constructor_expr.tag !== "name" || args.length === 0) {
    return;
  }

  const constructor = values.get(constructor_expr.name);

  if (!constructor || constructor.tag !== "lam") {
    return;
  }

  if (constructor.params.length !== args.length) {
    throw new Error(
      "ABI type constructor " + constructor_expr.name + " expects " +
        constructor.params.length.toString() + " arguments, got " +
        args.length.toString(),
    );
  }

  const replacements = new Map<string, FrontExpr>();

  for (let index = 0; index < constructor.params.length; index += 1) {
    const param = constructor.params[index];
    const arg = args[index];

    if (!param || !arg) {
      throw new Error(
        "Missing ABI type constructor argument " + index.toString(),
      );
    }

    replacements.set(param.name, {
      tag: "var",
      name: format_type_expr(arg),
    });
  }

  values.set(name, substitute_front_expr(constructor.body, replacements));
}

function abi_fixed_array_type_ref(
  array: Extract<TypeExpr, { tag: "array" }>,
  values: Map<string, FrontExpr>,
  resolve_named: (name: string) => AbiType,
  resolve_fixed_array: (element: AbiTypeRef, length: number) => AbiType,
): AbiTypeRef {
  const element = abi_type_ref_from_expr(
    array.element,
    values,
    resolve_named,
    resolve_fixed_array,
  );
  const length = fixed_array_length(array.length);
  const schema = resolve_fixed_array(element, length);
  return { tag: "named", name: schema.name };
}

function abi_type_ref_from_expr(
  type: TypeExpr,
  values: Map<string, FrontExpr>,
  resolve_named: (name: string) => AbiType,
  resolve_fixed_array: (element: AbiTypeRef, length: number) => AbiType,
): AbiTypeRef {
  if (type.tag === "name" || type.tag === "atom") {
    return abi_type_ref(type.name, values, resolve_named, resolve_fixed_array);
  }

  if (type.tag === "array") {
    return abi_fixed_array_type_ref(
      type,
      values,
      resolve_named,
      resolve_fixed_array,
    );
  }

  throw new Error("Unsupported ABI fixed-array element type");
}

function primitive_abi_type_alias(
  name: string,
  values: Map<string, FrontExpr>,
): AbiTypeRef | undefined {
  let current = name;
  const seen = new Set<string>();

  while (values.has(current)) {
    if (seen.has(current)) {
      return undefined;
    }

    seen.add(current);
    const value = values.get(current);

    if (!value) {
      throw new Error("Missing ABI type value: " + current);
    }

    if (value.tag !== "var") {
      return undefined;
    }

    const primitive = primitive_abi_type_ref(value.name);

    if (primitive) {
      return primitive;
    }

    current = value.name;
  }

  return undefined;
}

function primitive_abi_type_ref(name: string): AbiTypeRef | undefined {
  reject_resume_abi_type(name);
  const integer = integer_type_from_name(name);

  if (integer) {
    const type = integer_val_type(integer);

    if (type === "i32") {
      return { tag: "i32" };
    }

    if (type === "i64") {
      return { tag: "i64" };
    }

    throw new Error(
      "Gpufuck ABI cannot expose wide integer values directly: " + name,
    );
  }

  if (name === "F32x4") {
    throw new Error("Gpufuck ABI cannot expose F32x4 values");
  }

  if (
    name === "Bool" || name === "Char" || name === "Int" ||
    name === "I32" || name === "U32"
  ) {
    return { tag: "i32" };
  }

  if (name === "I64") {
    return { tag: "i64" };
  }

  if (name === "F32") {
    return { tag: "f32" };
  }

  if (name === "F64") {
    return { tag: "f64" };
  }

  if (name === "Unit") {
    return { tag: "unit" };
  }

  if (name === "Text") {
    return { tag: "text" };
  }

  if (name === "Bytes") {
    return { tag: "bytes" };
  }

  if (name === "I32Slice") {
    return { tag: "i32_slice" };
  }

  if (name === "TextSlice") {
    return { tag: "text_slice" };
  }

  return undefined;
}

function reject_resume_abi_type(name: string): void {
  if (name === "Resume") {
    throw new Error("Gpufuck ABI cannot expose Resume values");
  }
}
