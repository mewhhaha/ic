import type { FrontExpr, Source, TypeField } from "./frontend/ast.ts";
import { analyze_front_effects } from "./frontend/effect_analysis.ts";
import { resolve_front_type_value } from "./frontend/type_set_elaborate.ts";
import { align_to } from "./core/memory.ts";
import type { Func, Mod } from "./mod.ts";
import {
  allocator_free_head,
  runtime_allocator_funcs,
} from "./core/runtime_allocator.ts";
import { closure_heap_global } from "./core/closure_runtime.ts";

export const ix_abi_version = "ix-js-2";

export type AbiOwnership =
  | "scalar"
  | "bounded_borrow"
  | "frozen_shareable"
  | "ownership_transfer"
  | "unique_heap";

export type AbiTypeRef =
  | { tag: "i32" }
  | { tag: "i64" }
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
  offset: number;
};

export type AbiType =
  | {
    tag: "struct";
    name: string;
    schema_id: number;
    size: number;
    align: number;
    fields: AbiStructField[];
  }
  | {
    tag: "union";
    name: string;
    schema_id: number;
    size: number;
    align: 8;
    cases: { name: string; tag_value: number; payload: AbiTypeRef }[];
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
  import: string;
  params: AbiValueContract[];
  result: AbiValueContract;
};

export type AbiEffect = {
  name: string;
  operations: Record<string, AbiEffectOperation>;
};

export type AbiEffectRef = {
  effect: string;
  operation: string;
};

export type AbiEffectFunctionRequirement = {
  effects: AbiEffectRef[];
};

export type AbiEffectRequirements = {
  module: AbiEffectRef[];
  functions: Record<string, AbiEffectFunctionRequirement>;
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
  params: AbiTypeRef[];
  result: AbiValueContract | undefined;
};

export type AbiManifest = {
  abi_name: "ix-js";
  abi_version: "ix-js-2";
  target: {
    profile: "core-3-nonweb";
    pointer: "wasm32";
    endianness: "little";
    i64_js: "bigint";
  };
  frame: {
    byte_size_offset: 0;
    schema_id_offset: 4;
    root_offset: 8;
  };
  types: Record<string, AbiType>;
  imports: Record<string, AbiImport>;
  effects: Record<string, AbiEffect>;
  requirements: AbiEffectRequirements;
  init: AbiInit | undefined;
  entry: AbiEntry | undefined;
  exports: {
    memory: "memory";
    alloc: "__ix_abi_alloc";
    free: "__ix_abi_free";
    main: "__ix_abi_main";
  };
};

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
  const resolving = new Set<string>();
  let next_schema_id = 1;

  function resolve_named(name: string): AbiType {
    reject_resume_abi_type(name);
    const existing = types[name];

    if (existing) {
      return existing;
    }

    if (resolving.has(name)) {
      throw new Error("Recursive ABI type is not supported: " + name);
    }

    const value = values.get(name);

    if (!value) {
      throw new Error("Missing ABI type value: " + name);
    }

    resolving.add(name);
    try {
      if (value.tag === "var") {
        const alias = resolve_named(value.name);
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
        let offset = 0;
        let max_align = 1;
        const fields: AbiStructField[] = [];

        for (const field of resolved_value.fields) {
          const type = abi_type_ref(field.type_name, values, resolve_named);
          const layout = abi_type_ref_layout(type, resolve_named);
          offset = align_to(offset, layout.align);
          fields.push({ name: field.name, type, offset });
          offset += layout.size;

          if (layout.align > max_align) {
            max_align = layout.align;
          }
        }

        const result: AbiType = {
          tag: "struct",
          name,
          schema_id: next_schema_id,
          size: align_to(offset, max_align),
          align: max_align,
          fields,
        };
        next_schema_id += 1;
        types[name] = result;
        return result;
      }

      if (resolved_value.tag === "union_type") {
        let max_payload = 0;
        const cases = [];

        for (let index = 0; index < resolved_value.cases.length; index += 1) {
          const union_case = resolved_value.cases[index];

          if (!union_case) {
            throw new Error("Missing ABI union case " + index.toString());
          }

          const payload = abi_type_ref(
            union_case.type_name,
            values,
            resolve_named,
          );
          const layout = abi_type_ref_layout(payload, resolve_named);

          if (layout.size > max_payload) {
            max_payload = layout.size;
          }

          cases.push({
            name: union_case.name,
            tag_value: index,
            payload,
          });
        }

        const result: AbiType = {
          tag: "union",
          name,
          schema_id: next_schema_id,
          size: align_to(8 + max_payload, 8),
          align: 8,
          cases,
        };
        next_schema_id += 1;
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
          ),
        );
      }

      const result = abi_effect_result_contract(
        operation.result.type_name,
        operation.result.ownership,
        values,
        resolve_named,
      );
      operations[operation.name] = {
        name: operation.name,
        import: import_name,
        params: operation_params,
        result,
      };
      imports[import_name] = {
        name: import_name,
        module: "ix_effect",
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
  const requirements = abi_effect_requirements(source, effects);

  return {
    abi_name: "ix-js",
    abi_version: ix_abi_version,
    target: {
      profile: "core-3-nonweb",
      pointer: "wasm32",
      endianness: "little",
      i64_js: "bigint",
    },
    frame: { byte_size_offset: 0, schema_id_offset: 4, root_offset: 8 },
    types,
    imports,
    effects,
    requirements,
    init,
    entry: abi_entry(init, values, resolve_named),
    exports: {
      memory: "memory",
      alloc: "__ix_abi_alloc",
      free: "__ix_abi_free",
      main: "__ix_abi_main",
    },
  };
}

function abi_effect_requirements(
  source: Source,
  effects: Record<string, AbiEffect>,
): AbiEffectRequirements {
  const analysis = analyze_front_effects(source);
  const functions: Record<string, AbiEffectFunctionRequirement> = {};

  for (const name in analysis.functions) {
    const requirement = analysis.functions[name];

    if (!requirement) {
      throw new Error("Missing effect analysis for function: " + name);
    }

    const host_effects = requirement.effects.filter((effect) => {
      return effects[effect.effect] !== undefined;
    });

    if (host_effects.length > 0) {
      const item: AbiEffectFunctionRequirement = {
        effects: host_effects,
      };

      functions[name] = item;
    }
  }

  const module_effects = analysis.module_effects.filter((effect) => {
    return effects[effect.effect] !== undefined;
  });
  return { module: module_effects, functions };
}

function effect_import_name(effect: string, operation: string): string {
  return "__ix_effect_" + effect + "_" + operation;
}

function abi_effect_param_contract(
  type_name: string,
  ownership: AbiOwnership,
  values: Map<string, FrontExpr>,
  resolve_named: (name: string) => AbiType,
): AbiValueContract {
  const type = abi_type_ref(type_name, values, resolve_named);

  validate_effect_ownership(type_name, type, ownership, false);
  return { type, ownership };
}

function abi_effect_result_contract(
  type_name: string,
  ownership: AbiOwnership,
  values: Map<string, FrontExpr>,
  resolve_named: (name: string) => AbiType,
): AbiValueContract {
  const type = abi_type_ref(type_name, values, resolve_named);

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
  return type.tag === "i32" || type.tag === "i64" || type.tag === "unit";
}

function abi_init(
  source: Source,
  effects: Record<string, AbiEffect>,
  imports: Record<string, AbiImport>,
): AbiInit | undefined {
  const declarations = source.declarations || [];
  const declaration = declarations.find((item) =>
    item.name === "Init" &&
    (item.tag === "record" ||
      (item.tag === "type" && item.params.length === 0 &&
        item.body.tag === "product" && !item.body.positional))
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

    const import_name = "__ix_init_" + field.name;

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
      module: "ix_init",
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
  const result_type_name = "ix_entry_result_type";

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
    params: [],
    result,
  };
}

export function managed_abi_mod(mod: Mod, manifest: AbiManifest): Mod {
  const funcs: Record<string, Func> = { ...mod.funcs };
  const allocator = runtime_allocator_funcs();
  Object.assign(funcs, allocator);

  funcs[manifest.exports.alloc] = {
    name: manifest.exports.alloc,
    params: [
      { name: "size", type: "i32" },
      { name: "alignment", type: "i32" },
    ],
    result: "i32",
    body: "local.get $size\nlocal.get $alignment\ncall $__alloc",
  };
  funcs[manifest.exports.free] = {
    name: manifest.exports.free,
    params: [{ name: "ptr", type: "i32" }],
    result: "i32",
    body: "local.get $ptr\ncall $__free",
  };

  const source_main = mod.exports[0];

  if (!source_main) {
    throw new Error("Managed ABI module requires an exported main function");
  }

  const main_func = funcs[source_main];

  if (!main_func) {
    throw new Error(
      "Managed ABI module is missing main function: " + source_main,
    );
  }

  funcs[manifest.exports.main] = {
    name: manifest.exports.main,
    params: main_func.params,
    result: main_func.result,
    body: managed_main_body(source_main, main_func),
  };

  const globals = { ...mod.globals };

  if (!globals[closure_heap_global]) {
    globals[closure_heap_global] = {
      name: closure_heap_global,
      type: "i32",
      mutable: true,
      value: abi_heap_start(mod),
    };
  }

  if (!globals[allocator_free_head]) {
    globals[allocator_free_head] = {
      name: allocator_free_head,
      type: "i32",
      mutable: true,
      value: 0,
    };
  }

  return {
    ...mod,
    funcs,
    globals,
    memory: {
      name: "memory",
      pages: abi_initial_pages(mod),
      export_name: manifest.exports.memory,
    },
    exports: [
      source_main,
      manifest.exports.main,
      manifest.exports.alloc,
      manifest.exports.free,
    ],
  };
}

function managed_main_body(source_main: string, main_func: Func): string {
  const lines = [];
  const params = main_func.params || [];

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];

    if (!param) {
      throw new Error("Missing managed main parameter " + index.toString());
    }

    if (param.name) {
      lines.push("local.get $" + param.name);
    } else {
      lines.push("local.get " + index.toString());
    }
  }

  lines.push("call $" + source_main);
  return lines.join("\n");
}

function abi_initial_pages(mod: Mod): number {
  const required = Math.ceil(abi_heap_start(mod) / 65536);
  let pages = required;

  if (pages < 1) {
    pages = 1;
  }

  if (mod.memory && mod.memory.pages > pages) {
    pages = mod.memory.pages;
  }

  return pages;
}

function abi_heap_start(mod: Mod): number {
  let end = 8;

  if (mod.data) {
    for (const segment of mod.data) {
      const segment_end = segment.offset + segment.bytes.length;

      if (segment_end > end) {
        end = segment_end;
      }
    }
  }

  return align_to(end, 8);
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
): AbiTypeRef {
  const primitive = primitive_abi_type_ref(name);

  if (primitive) {
    return primitive;
  }

  const primitive_alias = primitive_abi_type_alias(name, values);

  if (primitive_alias) {
    return primitive_alias;
  }

  if (!values.has(name)) {
    throw new Error("Missing ABI type reference: " + name);
  }

  resolve_named(name);
  return { tag: "named", name };
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

  if (
    name === "Bool" || name === "Int" || name === "I32" || name === "U32"
  ) {
    return { tag: "i32" };
  }

  if (name === "I64") {
    return { tag: "i64" };
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
    throw new Error("Managed ABI cannot expose Resume values");
  }
}

function abi_type_ref_layout(
  type: AbiTypeRef,
  resolve_named: (name: string) => AbiType,
): { size: number; align: number } {
  if (type.tag === "i64") {
    return { size: 8, align: 8 };
  }

  if (type.tag === "unit") {
    return { size: 0, align: 1 };
  }

  if (type.tag === "resource") {
    return { size: 4, align: 4 };
  }

  if (type.tag === "named") {
    const named = resolve_named(type.name);

    if (named.tag === "struct") {
      return { size: named.size, align: named.align };
    }

    return { size: 4, align: 4 };
  }

  return { size: 4, align: 4 };
}
