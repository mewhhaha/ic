import type {
  AbiEffectOperation,
  AbiImport,
  AbiManifest,
  AbiType,
  AbiTypeRef,
} from "./abi.ts";

export type IxValue =
  | number
  | bigint
  | string
  | undefined
  | Uint8Array
  | number[]
  | string[]
  | { [name: string]: IxValue }
  | { tag: string; value?: IxValue };

export type IxHostHandler = (...args: IxValue[]) => IxValue;
export type IxHostHandlers = Record<string, Record<string, IxHostHandler>>;
export type IxEffectObject = Record<string, IxHostHandler>;
export type IxInitValue = Record<string, IxEffectObject>;

export class IxAbiError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "IxAbiError";
    this.code = code;
    this.path = path;
  }
}

export type IxHostInstance = {
  instance: WebAssembly.Instance;
  run: (init?: IxInitValue) => IxValue;
  dispose: () => void;
};

type EffectResource = {
  effect: string;
  value: IxEffectObject;
};

export function IxHost() {}

IxHost.instantiate = async function instantiate(
  source: BufferSource | WebAssembly.Module,
  manifest: AbiManifest,
  handlers: IxHostHandlers = {},
): Promise<IxHostInstance> {
  check_manifest(manifest);
  let instance: WebAssembly.Instance | undefined;
  let disposed = false;
  let running = false;
  let next_resource_handle = 1;
  const resources = new Map<number, EffectResource>();
  const active_init_handles = new Map<string, number>();
  const imports: WebAssembly.Imports = {};

  for (const name in manifest.imports) {
    const abi_import = manifest.imports[name];

    if (!abi_import) {
      throw new IxAbiError(
        "invalid_manifest",
        "imports." + name,
        "Missing ABI import",
      );
    }

    const handler = resolve_legacy_handler(abi_import, handlers);

    if (!abi_import.effect && !abi_import.init && !handler) {
      throw missing_handler_error(abi_import);
    }

    let module_imports = imports[abi_import.module];

    if (!module_imports) {
      module_imports = {};
      imports[abi_import.module] = module_imports;
    }

    module_imports[abi_import.field] = (...raw_args: unknown[]) => {
      if (disposed) {
        throw new IxAbiError(
          "disposed",
          abi_import.name,
          "Ix host instance is disposed",
        );
      }

      if (!instance) {
        throw new IxAbiError(
          "unbound_instance",
          abi_import.name,
          "Host import ran before the Wasm instance was bound",
        );
      }

      if (abi_import.init) {
        return invoke_init_getter(abi_import, active_init_handles);
      }

      const runtime = abi_runtime(instance, manifest);

      if (abi_import.effect) {
        return invoke_effect_operation(
          abi_import,
          raw_args,
          resources,
          runtime,
        );
      }

      if (!handler) {
        throw missing_handler_error(abi_import);
      }

      const args: IxValue[] = [];

      for (let index = 0; index < abi_import.params.length; index += 1) {
        const param = abi_import.params[index];
        const raw = raw_args[index];

        if (!param) {
          throw new IxAbiError(
            "invalid_manifest",
            abi_import.name,
            "Missing ABI parameter",
          );
        }

        args.push(runtime.decode_raw(
          param.type,
          raw,
          abi_import.name + ".arg" + index.toString(),
        ));
      }

      let result: IxValue;

      try {
        result = invoke_sync_handler(
          handler,
          args,
          abi_import.name,
          undefined,
        );
      } finally {
        free_transferred_params(abi_import, raw_args, runtime);
      }

      return runtime.encode_raw(
        abi_import.result.type,
        result,
        abi_import.name + ".result",
      );
    };
  }

  let instantiated: WebAssembly.WebAssemblyInstantiatedSource;

  if (source instanceof WebAssembly.Module) {
    const direct_instance = await WebAssembly.instantiate(source, imports);
    instantiated = { module: source, instance: direct_instance };
  } else {
    instantiated = await WebAssembly.instantiate(source, imports);
  }

  instance = instantiated.instance;
  abi_runtime(instance, manifest);

  return {
    instance,
    run(init?: IxInitValue): IxValue {
      if (disposed) {
        throw new IxAbiError(
          "disposed",
          "main",
          "Ix host instance is disposed",
        );
      }

      if (running) {
        throw new IxAbiError(
          "reentrant_run",
          "main",
          "Ix host run cannot be entered recursively",
        );
      }

      const current_instance = instance;

      if (!current_instance) {
        throw new IxAbiError(
          "disposed",
          "main",
          "Ix host instance is disposed",
        );
      }

      const main = current_instance.exports[manifest.exports.main];

      if (typeof main !== "function") {
        throw new IxAbiError(
          "missing_export",
          "main",
          "Missing managed main export",
        );
      }

      const handles = register_init_resources(
        manifest,
        init,
        resources,
        function allocate_handle(): number {
          if (next_resource_handle > 0x7fff_ffff) {
            throw new IxAbiError(
              "resource_exhausted",
              "init",
              "Ix effect resource handle space is exhausted",
            );
          }

          const handle = next_resource_handle;
          next_resource_handle += 1;

          return handle;
        },
      );
      const main_args: number[] = [];

      if (manifest.entry && manifest.entry.params.length > 0) {
        main_args.push(...handles);
      }

      if (manifest.init) {
        for (let index = 0; index < manifest.init.fields.length; index += 1) {
          const field = manifest.init.fields[index];
          const handle = handles[index];

          if (!field || handle === undefined) {
            throw new IxAbiError(
              "invalid_manifest",
              "init",
              "Init field and registered resource count differ",
            );
          }

          active_init_handles.set(field.name, handle);
        }
      }

      running = true;

      try {
        const raw_result = main(...main_args);

        if (manifest.entry && manifest.entry.result) {
          const runtime = abi_runtime(current_instance, manifest);

          if (
            manifest.entry.result.ownership === "unique_heap" &&
            typeof raw_result === "number"
          ) {
            try {
              return runtime.decode_raw(
                manifest.entry.result.type,
                raw_result,
                "main.result",
              );
            } finally {
              runtime.free_raw(manifest.entry.result.type, raw_result);
            }
          }

          return runtime.decode_raw(
            manifest.entry.result.type,
            raw_result,
            "main.result",
          );
        }

        if (
          typeof raw_result !== "number" && typeof raw_result !== "bigint"
        ) {
          throw new IxAbiError(
            "type_mismatch",
            "main",
            "Managed main returned a non-scalar",
          );
        }

        return raw_result;
      } finally {
        active_init_handles.clear();

        for (const handle of handles) {
          resources.delete(handle);
        }

        running = false;
      }
    },
    dispose(): void {
      disposed = true;
      active_init_handles.clear();
      resources.clear();
      instance = undefined;
    },
  };
};

function invoke_init_getter(
  abi_import: AbiImport,
  active_init_handles: Map<string, number>,
): number {
  const init_ref = abi_import.init;

  if (!init_ref) {
    throw new IxAbiError(
      "invalid_manifest",
      abi_import.name,
      "Init getter is missing its Init field reference",
    );
  }

  const handle = active_init_handles.get(init_ref.field);

  if (handle === undefined) {
    throw new IxAbiError(
      "inactive_init",
      "init." + init_ref.field,
      "Init resources are available only during run",
    );
  }

  return handle;
}

function resolve_legacy_handler(
  abi_import: AbiImport,
  handlers: IxHostHandlers,
): IxHostHandler | undefined {
  const module_handlers = handlers[abi_import.module];

  if (!module_handlers) {
    return undefined;
  }

  return module_handlers[abi_import.field];
}

function missing_handler_error(abi_import: AbiImport): IxAbiError {
  return new IxAbiError(
    "missing_handler",
    abi_import.module + "." + abi_import.field,
    "Missing Ix host handler",
  );
}

function invoke_sync_handler(
  handler: IxHostHandler,
  args: IxValue[],
  path: string,
  receiver: IxEffectObject | undefined,
): IxValue {
  let result: IxValue;

  try {
    result = handler.apply(receiver, args);
  } catch (error) {
    if (error instanceof IxAbiError) {
      throw error;
    }

    throw new IxAbiError(
      "host_exception",
      path,
      "Ix host handler threw: " + String(error),
    );
  }

  if (is_promise_like(result)) {
    throw new IxAbiError(
      "async_handler",
      path,
      "Ix host handlers must return synchronously",
    );
  }

  return result;
}

function is_promise_like(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("then" in value)) {
    return false;
  }

  return typeof value.then === "function";
}

function invoke_effect_operation(
  abi_import: AbiImport,
  raw_args: unknown[],
  resources: Map<number, EffectResource>,
  runtime: ReturnType<typeof abi_runtime>,
): number | bigint {
  const effect_ref = abi_import.effect;

  if (!effect_ref) {
    throw new IxAbiError(
      "invalid_manifest",
      abi_import.name,
      "Effect import is missing its effect reference",
    );
  }

  const raw_handle = raw_args[effect_ref.resource_param];

  if (typeof raw_handle !== "number" || !Number.isInteger(raw_handle)) {
    throw type_error(abi_import.name + ".resource", "i32 resource handle");
  }

  const resource = resources.get(raw_handle);

  if (!resource) {
    throw new IxAbiError(
      "unknown_resource",
      abi_import.name + ".resource",
      "Unknown or expired Ix effect resource handle",
    );
  }

  if (resource.effect !== effect_ref.name) {
    throw new IxAbiError(
      "resource_type_mismatch",
      abi_import.name + ".resource",
      "Expected effect " + effect_ref.name + ", got " + resource.effect,
    );
  }

  const handler = resource.value[effect_ref.operation];

  if (typeof handler !== "function") {
    throw new IxAbiError(
      "missing_method",
      effect_ref.name + "." + effect_ref.operation,
      "Missing Ix effect method",
    );
  }

  const args: IxValue[] = [];

  for (let index = 0; index < abi_import.params.length; index += 1) {
    if (index === effect_ref.resource_param) {
      continue;
    }

    const param = abi_import.params[index];

    if (!param) {
      throw new IxAbiError(
        "invalid_manifest",
        abi_import.name,
        "Missing ABI effect parameter",
      );
    }

    args.push(runtime.decode_raw(
      param.type,
      raw_args[index],
      abi_import.name + ".arg" + index.toString(),
    ));
  }

  let result: IxValue;

  try {
    result = invoke_sync_handler(
      handler,
      args,
      abi_import.name,
      resource.value,
    );
  } finally {
    free_transferred_params(abi_import, raw_args, runtime);
  }

  return runtime.encode_raw(
    abi_import.result.type,
    result,
    abi_import.name + ".result",
  );
}

function free_transferred_params(
  abi_import: AbiImport,
  raw_args: unknown[],
  runtime: ReturnType<typeof abi_runtime>,
): void {
  for (let index = 0; index < abi_import.params.length; index += 1) {
    const param = abi_import.params[index];
    const raw = raw_args[index];

    if (
      param && param.ownership === "ownership_transfer" &&
      typeof raw === "number"
    ) {
      runtime.free_raw(param.type, raw);
    }
  }
}

function register_init_resources(
  manifest: AbiManifest,
  init: IxInitValue | undefined,
  resources: Map<number, EffectResource>,
  allocate_handle: () => number,
): number[] {
  if (!manifest.init) {
    if (init !== undefined) {
      throw new IxAbiError(
        "unexpected_init",
        "init",
        "This Ix module does not declare an Init context",
      );
    }

    return [];
  }

  if (typeof init !== "object" || init === null || Array.isArray(init)) {
    throw type_error("init", "Init object");
  }

  const handles: number[] = [];

  try {
    for (const field of manifest.init.fields) {
      const effect = manifest.effects[field.type.effect];

      if (!effect) {
        throw new IxAbiError(
          "invalid_manifest",
          "init." + field.name,
          "Missing declared effect: " + field.type.effect,
        );
      }

      const value = init[field.name];
      validate_effect_object(effect.operations, value, "init." + field.name);
      const handle = allocate_handle();
      resources.set(handle, { effect: field.type.effect, value });
      handles.push(handle);
    }

    return handles;
  } catch (error) {
    for (const handle of handles) {
      resources.delete(handle);
    }

    throw error;
  }
}

function validate_effect_object(
  operations: Record<string, AbiEffectOperation>,
  value: IxEffectObject | undefined,
  path: string,
): asserts value is IxEffectObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw type_error(path, "effect object");
  }

  for (const name in operations) {
    if (typeof value[name] !== "function") {
      throw new IxAbiError(
        "missing_method",
        path + "." + name,
        "Missing Ix effect method",
      );
    }
  }
}

function check_manifest(manifest: AbiManifest): void {
  if (manifest.abi_version !== "ix-js-1") {
    throw new IxAbiError(
      "version_mismatch",
      "abi_version",
      "Expected ix-js-1, got " + String(manifest.abi_version),
    );
  }

  for (const effect_name in manifest.effects) {
    const effect = manifest.effects[effect_name];

    if (!effect || effect.name !== effect_name) {
      throw new IxAbiError(
        "invalid_manifest",
        "effects." + effect_name,
        "Missing effect or effect name mismatch",
      );
    }

    for (const operation_name in effect.operations) {
      const operation = effect.operations[operation_name];

      if (!operation || operation.name !== operation_name) {
        throw new IxAbiError(
          "invalid_manifest",
          "effects." + effect_name + ".operations." + operation_name,
          "Missing operation or operation name mismatch",
        );
      }

      const abi_import = manifest.imports[operation.import];

      if (
        !abi_import || !abi_import.effect ||
        abi_import.effect.name !== effect_name ||
        abi_import.effect.operation !== operation_name
      ) {
        throw new IxAbiError(
          "invalid_manifest",
          "effects." + effect_name + ".operations." + operation_name,
          "Effect operation import does not match",
        );
      }

      const resource_param = abi_import.params[
        abi_import.effect.resource_param
      ];

      if (
        !resource_param || resource_param.type.tag !== "resource" ||
        resource_param.type.effect !== effect_name
      ) {
        throw new IxAbiError(
          "invalid_manifest",
          "imports." + operation.import,
          "Effect import is missing its resource parameter",
        );
      }
    }
  }

  for (const effect of manifest.requirements.module) {
    check_effect_requirement(manifest, effect, "requirements.module");
  }

  for (const function_name in manifest.requirements.functions) {
    const requirement = manifest.requirements.functions[function_name];

    if (!requirement) {
      throw new IxAbiError(
        "invalid_manifest",
        "requirements.functions." + function_name,
        "Missing function effect requirement",
      );
    }

    for (const effect of requirement.effects) {
      check_effect_requirement(
        manifest,
        effect,
        "requirements.functions." + function_name,
      );
    }
  }

  if (manifest.init) {
    for (const field of manifest.init.fields) {
      if (!manifest.effects[field.type.effect]) {
        throw new IxAbiError(
          "invalid_manifest",
          "init." + field.name,
          "Init field references an unknown effect",
        );
      }
    }

    if (
      manifest.entry &&
      manifest.entry.params.length !== 0 &&
      manifest.entry.params.length !== manifest.init.fields.length
    ) {
      throw new IxAbiError(
        "invalid_manifest",
        "entry.params",
        "Entry parameter count must match Init fields",
      );
    }

    if (manifest.entry && manifest.entry.params.length > 0) {
      for (let index = 0; index < manifest.init.fields.length; index += 1) {
        const field = manifest.init.fields[index];
        const param = manifest.entry.params[index];

        if (
          !field || !param || param.tag !== "resource" ||
          param.effect !== field.type.effect
        ) {
          throw new IxAbiError(
            "invalid_manifest",
            "entry.params." + index.toString(),
            "Entry resource parameter must match its Init field",
          );
        }
      }
    }

    if (!manifest.entry || manifest.entry.params.length === 0) {
      for (const field of manifest.init.fields) {
        const abi_import = manifest.imports[field.import];

        if (
          !abi_import || !abi_import.init ||
          abi_import.init.field !== field.name ||
          abi_import.init.effect !== field.type.effect
        ) {
          throw new IxAbiError(
            "invalid_manifest",
            "init." + field.name,
            "Init field getter import does not match",
          );
        }
      }
    }
  }
}

function check_effect_requirement(
  manifest: AbiManifest,
  requirement: { effect: string; operation: string },
  path: string,
): void {
  const effect = manifest.effects[requirement.effect];

  if (!effect || !effect.operations[requirement.operation]) {
    throw new IxAbiError(
      "invalid_manifest",
      path,
      "Effect requirement references an unknown operation: " +
        requirement.effect + "." + requirement.operation,
    );
  }
}

function abi_runtime(instance: WebAssembly.Instance, manifest: AbiManifest) {
  const memory_value = instance.exports[manifest.exports.memory];
  const alloc_value = instance.exports[manifest.exports.alloc];
  const free_value = instance.exports[manifest.exports.free];

  if (!(memory_value instanceof WebAssembly.Memory)) {
    throw new IxAbiError(
      "missing_export",
      "memory",
      "Missing managed memory export",
    );
  }

  if (typeof alloc_value !== "function" || typeof free_value !== "function") {
    throw new IxAbiError(
      "missing_export",
      "allocator",
      "Missing managed allocator exports",
    );
  }

  const memory = memory_value;
  const alloc_export = alloc_value;
  const free_export = free_value;

  function alloc(size: number, alignment: number): number {
    const ptr = alloc_export(size, alignment);

    if (typeof ptr !== "number" || ptr <= 0) {
      throw new IxAbiError(
        "out_of_memory",
        "allocator",
        "ABI allocation failed",
      );
    }

    return ptr;
  }

  function free(ptr: number): void {
    free_export(ptr);
  }

  function decode_raw(type: AbiTypeRef, raw: unknown, path: string): IxValue {
    if (type.tag === "i32") {
      if (typeof raw !== "number") {
        throw type_error(path, "i32");
      }

      return raw | 0;
    }

    if (type.tag === "i64") {
      if (typeof raw !== "bigint") {
        throw type_error(path, "i64 BigInt");
      }

      return raw;
    }

    if (type.tag === "unit") {
      return undefined;
    }

    if (typeof raw !== "number") {
      throw type_error(path, "wasm32 pointer");
    }

    return decode_pointer(type, raw, path);
  }

  function decode_pointer(
    type: AbiTypeRef,
    ptr: number,
    path: string,
  ): IxValue {
    check_pointer(memory, ptr, 4, path);
    const view = new DataView(memory.buffer);

    if (type.tag === "text" || type.tag === "bytes") {
      const length = view.getUint32(ptr, true);
      check_pointer(memory, ptr + 4, length, path);
      const bytes = new Uint8Array(memory.buffer, ptr + 4, length).slice();

      if (type.tag === "bytes") {
        return bytes;
      }

      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new IxAbiError(
          "invalid_utf8",
          path,
          "Invalid UTF-8 Text: " + String(error),
        );
      }
    }

    if (type.tag === "i32_slice" || type.tag === "text_slice") {
      const length = view.getUint32(ptr, true);
      check_pointer(memory, ptr + 4, length * 4, path);
      const result: IxValue[] = [];

      for (let index = 0; index < length; index += 1) {
        const value = view.getUint32(ptr + 4 + index * 4, true);

        if (type.tag === "i32_slice") {
          result.push(value | 0);
        } else {
          result.push(
            decode_pointer(
              { tag: "text" },
              value,
              path + "[" + index.toString() + "]",
            ),
          );
        }
      }

      if (type.tag === "i32_slice") {
        return result as number[];
      }

      return result as string[];
    }

    if (type.tag !== "named") {
      throw new IxAbiError(
        "type_mismatch",
        path,
        "Unsupported ABI pointer type",
      );
    }

    const schema = manifest.types[type.name];

    if (!schema) {
      throw new IxAbiError(
        "invalid_manifest",
        path,
        "Missing ABI schema: " + type.name,
      );
    }

    return decode_named(schema, ptr, path, view);
  }

  function decode_named(
    schema: AbiType,
    ptr: number,
    path: string,
    view: DataView,
  ): IxValue {
    if (schema.tag === "struct") {
      check_pointer(memory, ptr, schema.size, path);
      const result: { [name: string]: IxValue } = {};

      for (const field of schema.fields) {
        result[field.name] = decode_slot(
          field.type,
          ptr + field.offset,
          path + "." + field.name,
          view,
        );
      }

      return result;
    }

    check_pointer(memory, ptr, 8, path);
    const tag_value = view.getUint32(ptr, true);
    const union_case = schema.cases[tag_value];

    if (!union_case) {
      throw new IxAbiError(
        "invalid_tag",
        path,
        "Invalid union tag " + tag_value.toString(),
      );
    }

    const result: { tag: string; value?: IxValue } = { tag: union_case.name };

    if (union_case.payload.tag !== "unit") {
      result.value = decode_slot(
        union_case.payload,
        ptr + 4,
        path + ".value",
        view,
      );
    }

    return result;
  }

  function decode_slot(
    type: AbiTypeRef,
    address: number,
    path: string,
    view: DataView,
  ): IxValue {
    if (type.tag === "i32") {
      return view.getInt32(address, true);
    }

    if (type.tag === "i64") {
      return view.getBigInt64(address, true);
    }

    if (type.tag === "unit") {
      return undefined;
    }

    if (type.tag === "named") {
      const schema = manifest.types[type.name];

      if (schema && schema.tag === "struct") {
        return decode_named(schema, address, path, view);
      }
    }

    return decode_pointer(type, view.getUint32(address, true), path);
  }

  function encode_raw(
    type: AbiTypeRef,
    value: IxValue,
    path: string,
  ): number | bigint {
    if (type.tag === "i32") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw type_error(path, "integer number");
      }

      return value | 0;
    }

    if (type.tag === "i64") {
      if (typeof value !== "bigint") {
        throw type_error(path, "BigInt");
      }

      return value;
    }

    if (type.tag === "unit") {
      return 0;
    }

    return encode_pointer(type, value, path);
  }

  function encode_pointer(
    type: AbiTypeRef,
    value: IxValue,
    path: string,
  ): number {
    if (type.tag === "text" || type.tag === "bytes") {
      let bytes: Uint8Array;

      if (type.tag === "text") {
        if (typeof value !== "string") {
          throw type_error(path, "string");
        }

        bytes = new TextEncoder().encode(value);
      } else {
        if (!(value instanceof Uint8Array)) {
          throw type_error(path, "Uint8Array");
        }

        bytes = value;
      }

      const ptr = alloc(4 + bytes.length, 8);
      new DataView(memory.buffer).setUint32(ptr, bytes.length, true);
      new Uint8Array(memory.buffer, ptr + 4, bytes.length).set(bytes);
      return ptr;
    }

    if (type.tag === "i32_slice" || type.tag === "text_slice") {
      if (!Array.isArray(value) && !(value instanceof Int32Array)) {
        throw type_error(path, "slice array");
      }

      const items = Array.from(value as number[] | Int32Array);
      const ptr = alloc(4 + items.length * 4, 8);
      new DataView(memory.buffer).setUint32(ptr, items.length, true);

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];

        if (type.tag === "i32_slice") {
          if (typeof item !== "number") {
            throw type_error(path + "[" + index.toString() + "]", "number");
          }

          new DataView(memory.buffer).setInt32(
            ptr + 4 + index * 4,
            item,
            true,
          );
        } else {
          const text_ptr = encode_pointer(
            { tag: "text" },
            item as IxValue,
            path,
          );
          new DataView(memory.buffer).setUint32(
            ptr + 4 + index * 4,
            text_ptr,
            true,
          );
        }
      }

      return ptr;
    }

    if (type.tag !== "named") {
      throw type_error(path, "rich ABI value");
    }

    const schema = manifest.types[type.name];

    if (!schema) {
      throw new IxAbiError(
        "invalid_manifest",
        path,
        "Missing ABI schema: " + type.name,
      );
    }

    const ptr = alloc(schema.size, schema.align);
    encode_named(schema, ptr, value, path);
    return ptr;
  }

  function encode_named(
    schema: AbiType,
    ptr: number,
    value: IxValue,
    path: string,
  ): void {
    if (schema.tag === "struct") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw type_error(path, "object");
      }

      const object = value as { [name: string]: IxValue };

      for (const field of schema.fields) {
        encode_slot(
          field.type,
          ptr + field.offset,
          object[field.name],
          path + "." + field.name,
        );
      }

      return;
    }

    if (typeof value !== "object" || value === null || !("tag" in value)) {
      throw type_error(path, "tagged union object");
    }

    const union = value as { tag: string; value?: IxValue };
    const union_case = schema.cases.find((item) => item.name === union.tag);

    if (!union_case) {
      throw new IxAbiError(
        "invalid_tag",
        path,
        "Unknown union case: " + union.tag,
      );
    }

    new DataView(memory.buffer).setUint32(ptr, union_case.tag_value, true);

    if (union_case.payload.tag !== "unit") {
      encode_slot(
        union_case.payload,
        ptr + 4,
        union.value,
        path + ".value",
      );
    }
  }

  function encode_slot(
    type: AbiTypeRef,
    address: number,
    value: IxValue,
    path: string,
  ): void {
    if (type.tag === "i32") {
      if (typeof value !== "number") {
        throw type_error(path, "number");
      }

      new DataView(memory.buffer).setInt32(address, value, true);
      return;
    }

    if (type.tag === "i64") {
      if (typeof value !== "bigint") {
        throw type_error(path, "BigInt");
      }

      new DataView(memory.buffer).setBigInt64(address, value, true);
      return;
    }

    if (type.tag === "unit") {
      return;
    }

    if (type.tag === "named") {
      const schema = manifest.types[type.name];

      if (schema && schema.tag === "struct") {
        encode_named(schema, address, value, path);
        return;
      }
    }

    const child_ptr = encode_pointer(type, value, path);
    new DataView(memory.buffer).setUint32(address, child_ptr, true);
  }

  function free_raw(type: AbiTypeRef, ptr: number): void {
    if (ptr <= 0) {
      return;
    }

    if (type.tag === "named") {
      const schema = manifest.types[type.name];

      if (schema) {
        free_named_children(schema, ptr);
      }
    }

    free(ptr);
  }

  function free_named_children(schema: AbiType, ptr: number): void {
    const view = new DataView(memory.buffer);

    if (schema.tag === "struct") {
      for (const field of schema.fields) {
        free_slot(field.type, ptr + field.offset, view);
      }

      return;
    }

    const tag_value = view.getUint32(ptr, true);
    const union_case = schema.cases[tag_value];

    if (union_case) {
      free_slot(union_case.payload, ptr + 4, view);
    }
  }

  function free_slot(type: AbiTypeRef, address: number, view: DataView): void {
    if (type.tag === "i32" || type.tag === "i64" || type.tag === "unit") {
      return;
    }

    if (type.tag === "named") {
      const schema = manifest.types[type.name];

      if (schema && schema.tag === "struct") {
        free_named_children(schema, address);
        return;
      }
    }

    free_raw(type, view.getUint32(address, true));
  }

  return { decode_raw, encode_raw, free_raw };
}

function check_pointer(
  memory: WebAssembly.Memory,
  ptr: number,
  length: number,
  path: string,
): void {
  if (
    !Number.isInteger(ptr) || ptr < 0 || !Number.isInteger(length) || length < 0
  ) {
    throw new IxAbiError("out_of_bounds", path, "Invalid memory range");
  }

  const end = ptr + length;

  if (end < ptr || end > memory.buffer.byteLength) {
    throw new IxAbiError(
      "out_of_bounds",
      path,
      "Memory range is out of bounds",
    );
  }
}

function type_error(path: string, expected: string): IxAbiError {
  return new IxAbiError("type_mismatch", path, "Expected " + expected);
}
