import type {
  AbiEffectOperation,
  AbiImport,
  AbiManifest,
  AbiType,
  AbiTypeRef,
} from "./abi.ts";
import {
  abi_fixed_array_schema_name,
  duck_abi_name,
  duck_abi_version,
} from "./abi.ts";
import { align_to } from "./core/memory.ts";

export type DuckValue =
  | number
  | bigint
  | string
  | undefined
  | Uint8Array
  | DuckValue[]
  | { tag: string; value?: DuckValue };

export type DuckHostHandler = (...args: DuckValue[]) => DuckValue;
export type DuckEffectObject = Record<string, DuckHostHandler>;
export type DuckInitValue = Record<string, DuckEffectObject>;

export class DuckAbiError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "DuckAbiError";
    this.code = code;
    this.path = path;
  }
}

export type DuckHostInstance = {
  instance: WebAssembly.Instance;
  run: (init?: DuckInitValue) => DuckValue;
  call: (
    name: string,
    ...args: DuckCallableValue[]
  ) => DuckValue | DuckStateToken;
  dispose: () => void;
};

export type DuckStateToken = {
  dispose: () => void;
};

export type DuckCallableValue =
  | DuckValue
  | DuckStateToken
  | DuckCallableValue[];

type DuckStateRecord = {
  owner: symbol;
  type: AbiTypeRef;
  ptr: number;
  status: "live" | "in_flight" | "consumed" | "disposed";
};

const duck_state_records = new WeakMap<DuckStateToken, DuckStateRecord>();

export type DuckRunner = {
  run: (program: DuckHostInstance) => DuckValue;
};

export function DuckRunner(init: DuckInitValue): DuckRunner {
  return {
    run(program: DuckHostInstance): DuckValue {
      return program.run(init);
    },
  };
}

type EffectResource = {
  effect: string;
  value: DuckEffectObject;
};

export function DuckHost() {}

DuckHost.instantiate = async function instantiate(
  source: BufferSource | WebAssembly.Module,
  manifest: AbiManifest,
): Promise<DuckHostInstance> {
  check_manifest(manifest);
  let instance: WebAssembly.Instance | undefined;
  let disposed = false;
  let running = false;
  let next_resource_handle = 1;
  const state_owner = Symbol("DuckHost.state");
  const live_states = new Set<DuckStateToken>();
  const resources = new Map<number, EffectResource>();
  const active_init_handles = new Map<string, number>();
  const imports: WebAssembly.Imports = {};

  for (const name in manifest.imports) {
    const abi_import = manifest.imports[name];

    if (!abi_import) {
      throw new DuckAbiError(
        "invalid_manifest",
        "imports." + name,
        "Missing ABI import",
      );
    }

    let module_imports = imports[abi_import.module];

    if (!module_imports) {
      module_imports = {};
      imports[abi_import.module] = module_imports;
    }

    module_imports[abi_import.field] = (...raw_args: unknown[]) => {
      if (disposed) {
        throw new DuckAbiError(
          "disposed",
          abi_import.name,
          "Duck host instance is disposed",
        );
      }

      if (!instance) {
        throw new DuckAbiError(
          "unbound_instance",
          abi_import.name,
          "Host import ran before the Wasm instance was bound",
        );
      }

      if (abi_import.init) {
        return invoke_init_getter(abi_import, active_init_handles);
      }

      const runtime = abi_runtime(instance, manifest);

      return invoke_effect_operation(
        abi_import,
        raw_args,
        resources,
        runtime,
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

  function dispose_state(token: DuckStateToken): void {
    const record = duck_state_records.get(token);

    if (!record || record.owner !== state_owner) {
      throw new DuckAbiError(
        "invalid_state",
        "state",
        "State token does not belong to this Duck host instance",
      );
    }

    if (record.status !== "live") {
      throw new DuckAbiError(
        "consumed_state",
        "state",
        "State token is no longer live",
      );
    }

    const current_instance = instance;

    if (!current_instance || disposed) {
      throw new DuckAbiError(
        "disposed",
        "state",
        "Duck host instance is disposed",
      );
    }

    record.status = "disposed";
    live_states.delete(token);
    abi_runtime(current_instance, manifest).free_raw(record.type, record.ptr);
  }

  function state_token(type: AbiTypeRef, ptr: number): DuckStateToken {
    if (!Number.isInteger(ptr) || ptr <= 0) {
      throw new DuckAbiError(
        "invalid_state",
        "state",
        "Managed callable returned an invalid state pointer",
      );
    }

    const token: DuckStateToken = {
      dispose(): void {
        dispose_state(token);
      },
    };
    Object.freeze(token);
    duck_state_records.set(token, {
      owner: state_owner,
      type,
      ptr,
      status: "live",
    });
    live_states.add(token);
    return token;
  }

  return {
    instance,
    run(init?: DuckInitValue): DuckValue {
      if (disposed) {
        throw new DuckAbiError(
          "disposed",
          "main",
          "Duck host instance is disposed",
        );
      }

      if (running) {
        throw new DuckAbiError(
          "reentrant_run",
          "main",
          "Duck host run cannot be entered recursively",
        );
      }

      const current_instance = instance;

      if (!current_instance) {
        throw new DuckAbiError(
          "disposed",
          "main",
          "Duck host instance is disposed",
        );
      }

      const main = current_instance.exports[manifest.exports.main];

      if (typeof main !== "function") {
        throw new DuckAbiError(
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
            throw new DuckAbiError(
              "resource_exhausted",
              "init",
              "Duck effect resource handle space is exhausted",
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
            throw new DuckAbiError(
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
          throw new DuckAbiError(
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
    call(
      name: string,
      ...args: DuckCallableValue[]
    ): DuckValue | DuckStateToken {
      if (disposed) {
        throw new DuckAbiError(
          "disposed",
          "callables." + name,
          "Duck host instance is disposed",
        );
      }

      if (running) {
        throw new DuckAbiError(
          "reentrant_run",
          "callables." + name,
          "Duck host cannot be entered recursively",
        );
      }

      const callable = manifest.callables?.[name];

      if (!callable) {
        throw new DuckAbiError(
          "missing_callable",
          "callables." + name,
          "Managed callable is not declared",
        );
      }

      let values: DuckCallableValue[];

      if (callable.params.length === 0) {
        if (args.length !== 0) {
          throw new DuckAbiError(
            "arity_mismatch",
            "callables." + name,
            "Managed callable expects no source argument, got " +
              args.length.toString(),
          );
        }

        values = [];
      } else if (callable.params.length === 1) {
        if (args.length !== 1) {
          throw new DuckAbiError(
            "arity_mismatch",
            "callables." + name,
            "Managed callable expects one source argument, got " +
              args.length.toString(),
          );
        }

        values = args;
      } else {
        const product = args[0];

        if (args.length !== 1 || !Array.isArray(product)) {
          throw new DuckAbiError(
            "arity_mismatch",
            "callables." + name,
            "Managed callable expects one product source argument",
          );
        }

        if (product.length !== callable.params.length) {
          throw new DuckAbiError(
            "arity_mismatch",
            "callables." + name,
            "Managed callable product expects " +
              callable.params.length.toString() + " fields, got " +
              product.length.toString(),
          );
        }

        values = product;
      }

      const current_instance = instance;

      if (!current_instance) {
        throw new DuckAbiError(
          "disposed",
          "callables." + name,
          "Duck host instance is disposed",
        );
      }

      const exported = current_instance.exports[callable.export];

      if (typeof exported !== "function") {
        throw new DuckAbiError(
          "missing_export",
          "callables." + name,
          "Missing managed callable export " + callable.export,
        );
      }

      const runtime = abi_runtime(current_instance, manifest);
      const raw_args: Array<number | bigint> = [];
      const moved: DuckStateRecord[] = [];
      const bootstrapped: Array<{ type: AbiTypeRef; ptr: number }> = [];
      let invoked = false;

      try {
        for (let index = 0; index < callable.params.length; index += 1) {
          const contract = callable.params[index];
          const value = values[index];

          if (!contract) {
            throw new DuckAbiError(
              "invalid_manifest",
              "callables." + name + ".params." + index.toString(),
              "Missing managed callable parameter contract",
            );
          }

          if (contract.ownership === "scalar") {
            raw_args.push(runtime.encode_raw(
              contract.type,
              value as DuckValue,
              "callables." + name + ".args." + index.toString(),
            ));
            continue;
          }

          let record: DuckStateRecord | undefined;

          if (typeof value === "object" && value !== null) {
            record = duck_state_records.get(value as DuckStateToken);
          }

          if (!record) {
            const raw = runtime.encode_raw(
              contract.type,
              value as DuckValue,
              "callables." + name + ".args." + index.toString(),
            );

            if (typeof raw !== "number") {
              throw new DuckAbiError(
                "invalid_state",
                "callables." + name + ".args." + index.toString(),
                "Managed move parameter did not encode to a pointer",
              );
            }

            raw_args.push(raw);
            bootstrapped.push({ type: contract.type, ptr: raw });
            continue;
          }

          if (record.owner !== state_owner) {
            throw new DuckAbiError(
              "invalid_state",
              "callables." + name + ".args." + index.toString(),
              "State token does not belong to this Duck host instance",
            );
          }

          if (record.status !== "live") {
            throw new DuckAbiError(
              "consumed_state",
              "callables." + name + ".args." + index.toString(),
              "State token is no longer live",
            );
          }

          if (!same_abi_type_ref(record.type, contract.type)) {
            throw new DuckAbiError(
              "state_type_mismatch",
              "callables." + name + ".args." + index.toString(),
              "State token type does not match the callable contract",
            );
          }

          if (moved.includes(record)) {
            throw new DuckAbiError(
              "consumed_state",
              "callables." + name + ".args." + index.toString(),
              "The same state token cannot be moved more than once",
            );
          }

          moved.push(record);
          raw_args.push(record.ptr);
        }

        for (const record of moved) {
          record.status = "in_flight";

          for (const token of live_states) {
            if (duck_state_records.get(token) === record) {
              live_states.delete(token);
              break;
            }
          }
        }

        running = true;
        const raw_result = exported(...raw_args);
        invoked = true;

        for (const record of moved) {
          record.status = "consumed";
        }

        if (callable.result.ownership === "move") {
          if (typeof raw_result !== "number") {
            throw new DuckAbiError(
              "invalid_state",
              "callables." + name + ".result",
              "Managed callable returned a non-pointer state",
            );
          }

          return state_token(callable.result.type, raw_result);
        }

        return runtime.decode_raw(
          callable.result.type,
          raw_result,
          "callables." + name + ".result",
        );
      } catch (error) {
        if (!invoked) {
          for (const record of moved) {
            if (record.status === "in_flight") {
              record.status = "consumed";
              runtime.free_raw(record.type, record.ptr);
            }
          }

          for (const value of bootstrapped) {
            runtime.free_raw(value.type, value.ptr);
          }
        }

        throw error;
      } finally {
        running = false;
      }
    },
    dispose(): void {
      const current_instance = instance;

      if (current_instance) {
        const runtime = abi_runtime(current_instance, manifest);

        for (const token of live_states) {
          const record = duck_state_records.get(token);

          if (record && record.status === "live") {
            record.status = "disposed";
            runtime.free_raw(record.type, record.ptr);
          }
        }
      }

      live_states.clear();
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
    throw new DuckAbiError(
      "invalid_manifest",
      abi_import.name,
      "Init getter is missing its Init field reference",
    );
  }

  const handle = active_init_handles.get(init_ref.field);

  if (handle === undefined) {
    throw new DuckAbiError(
      "inactive_init",
      "init." + init_ref.field,
      "Init resources are available only during run",
    );
  }

  return handle;
}

function invoke_sync_handler(
  handler: DuckHostHandler,
  args: DuckValue[],
  path: string,
  receiver: DuckEffectObject | undefined,
): DuckValue {
  let result: DuckValue;

  try {
    result = handler.apply(receiver, args);
  } catch (error) {
    if (error instanceof DuckAbiError) {
      throw error;
    }

    throw new DuckAbiError(
      "host_exception",
      path,
      "Duck host handler threw: " + String(error),
    );
  }

  if (is_promise_like(result)) {
    throw new DuckAbiError(
      "async_handler",
      path,
      "Duck host handlers must return synchronously",
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
    throw new DuckAbiError(
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
    throw new DuckAbiError(
      "unknown_resource",
      abi_import.name + ".resource",
      "Unknown or expired Duck effect resource handle",
    );
  }

  if (resource.effect !== effect_ref.name) {
    throw new DuckAbiError(
      "resource_type_mismatch",
      abi_import.name + ".resource",
      "Expected effect " + effect_ref.name + ", got " + resource.effect,
    );
  }

  const handler = resource.value[effect_ref.operation];

  if (typeof handler !== "function") {
    throw new DuckAbiError(
      "missing_method",
      effect_ref.name + "." + effect_ref.operation,
      "Missing Duck effect method",
    );
  }

  const args: DuckValue[] = [];

  for (let index = 0; index < abi_import.params.length; index += 1) {
    if (index === effect_ref.resource_param) {
      continue;
    }

    const param = abi_import.params[index];

    if (!param) {
      throw new DuckAbiError(
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

  let result: DuckValue;

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
  init: DuckInitValue | undefined,
  resources: Map<number, EffectResource>,
  allocate_handle: () => number,
): number[] {
  if (!manifest.init) {
    if (init !== undefined) {
      throw new DuckAbiError(
        "unexpected_init",
        "init",
        "This Duck module does not declare an Init context",
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
        throw new DuckAbiError(
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
  value: DuckEffectObject | undefined,
  path: string,
): asserts value is DuckEffectObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw type_error(path, "effect object");
  }

  for (const name in operations) {
    if (typeof value[name] !== "function") {
      throw new DuckAbiError(
        "missing_method",
        path + "." + name,
        "Missing Duck effect method",
      );
    }
  }
}

function check_manifest(manifest: AbiManifest): void {
  const untrusted_manifest = manifest as {
    abi_name?: unknown;
    abi_version?: unknown;
  };

  if (untrusted_manifest.abi_name !== duck_abi_name) {
    throw new DuckAbiError(
      "manifest_mismatch",
      "abi_name",
      "Expected " + duck_abi_name + ", got " +
        String(untrusted_manifest.abi_name),
    );
  }

  if (untrusted_manifest.abi_version !== duck_abi_version) {
    throw new DuckAbiError(
      "version_mismatch",
      "abi_version",
      "Expected " + duck_abi_version + ", got " +
        String(untrusted_manifest.abi_version),
    );
  }

  if (manifest.target.profile !== "core-3-nonweb") {
    throw new DuckAbiError(
      "target_mismatch",
      "target.profile",
      "Expected core-3-nonweb, got " + String(manifest.target.profile),
    );
  }

  if (manifest.target.pointer !== "wasm32") {
    throw new DuckAbiError(
      "target_mismatch",
      "target.pointer",
      "Expected wasm32, got " + String(manifest.target.pointer),
    );
  }

  if (manifest.target.endianness !== "little") {
    throw new DuckAbiError(
      "target_mismatch",
      "target.endianness",
      "Expected little endian, got " + String(manifest.target.endianness),
    );
  }

  if (manifest.target.i64_js !== "bigint") {
    throw new DuckAbiError(
      "target_mismatch",
      "target.i64_js",
      "Expected BigInt i64 values, got " + String(manifest.target.i64_js),
    );
  }

  check_manifest_types(manifest);

  if (manifest.callables) {
    check_manifest_callables(manifest);
  }

  for (const import_name in manifest.imports) {
    const abi_import = manifest.imports[import_name];

    if (!abi_import || abi_import.name !== import_name) {
      throw new DuckAbiError(
        "invalid_manifest",
        "imports." + import_name,
        "Missing import or import name mismatch",
      );
    }

    if (
      (!abi_import.effect && !abi_import.init) ||
      (abi_import.effect !== undefined && abi_import.init !== undefined)
    ) {
      throw new DuckAbiError(
        "invalid_manifest",
        "imports." + import_name,
        "Managed ABI imports must reference exactly one effect or Init field",
      );
    }
  }

  for (const effect_name in manifest.effects) {
    const effect = manifest.effects[effect_name];

    if (!effect || effect.name !== effect_name) {
      throw new DuckAbiError(
        "invalid_manifest",
        "effects." + effect_name,
        "Missing effect or effect name mismatch",
      );
    }

    for (const operation_name in effect.operations) {
      const operation = effect.operations[operation_name];

      if (!operation || operation.name !== operation_name) {
        throw new DuckAbiError(
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
        throw new DuckAbiError(
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
        throw new DuckAbiError(
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
      throw new DuckAbiError(
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
        throw new DuckAbiError(
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
      throw new DuckAbiError(
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
          throw new DuckAbiError(
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
          throw new DuckAbiError(
            "invalid_manifest",
            "init." + field.name,
            "Init field getter import does not match",
          );
        }
      }
    }
  }
}

function check_manifest_callables(manifest: AbiManifest): void {
  const exports = new Set<string>();

  for (const name in manifest.callables) {
    const callable = manifest.callables[name];

    if (!callable || callable.name !== name) {
      throw new DuckAbiError(
        "invalid_manifest",
        "callables." + name,
        "Managed callable key and name must match",
      );
    }

    if (callable.export.length === 0 || exports.has(callable.export)) {
      throw new DuckAbiError(
        "invalid_manifest",
        "callables." + name + ".export",
        "Managed callable exports must be non-empty and unique",
      );
    }

    exports.add(callable.export);

    for (let index = 0; index < callable.params.length; index += 1) {
      const contract = callable.params[index];

      if (!contract) {
        throw new DuckAbiError(
          "invalid_manifest",
          "callables." + name + ".params." + index.toString(),
          "Missing managed callable parameter contract",
        );
      }

      check_callable_contract(
        manifest,
        contract,
        "callables." + name + ".params." + index.toString(),
      );
    }

    check_callable_contract(
      manifest,
      callable.result,
      "callables." + name + ".result",
    );
  }
}

function check_callable_contract(
  manifest: AbiManifest,
  contract: { type: AbiTypeRef; ownership: "scalar" | "move" },
  path: string,
): void {
  manifest_type_ref_layout(manifest, contract.type, path + ".type");
  const scalar = contract.type.tag === "i32" ||
    contract.type.tag === "i64" || contract.type.tag === "f32" ||
    contract.type.tag === "f64" || contract.type.tag === "unit";

  if (contract.type.tag === "resource") {
    throw new DuckAbiError(
      "invalid_manifest",
      path + ".type",
      "Managed callable state cannot be an effect resource",
    );
  }

  if (contract.ownership === "scalar" && !scalar) {
    throw new DuckAbiError(
      "invalid_manifest",
      path + ".ownership",
      "Scalar callable ownership requires a scalar type",
    );
  }

  const movable = contract.type.tag === "text" ||
    contract.type.tag === "bytes" || contract.type.tag === "named";

  if (contract.ownership === "move" && !movable) {
    throw new DuckAbiError(
      "invalid_manifest",
      path + ".ownership",
      "Move callable ownership requires Text, Bytes, or a named aggregate",
    );
  }
}

function check_manifest_types(manifest: AbiManifest): void {
  const schema_ids = new Set<number>();

  for (const name in manifest.types) {
    const schema = manifest.types[name];

    if (!schema) {
      throw new DuckAbiError(
        "invalid_manifest",
        "types." + name,
        "Missing ABI schema",
      );
    }

    if (schema.name !== name) {
      throw new DuckAbiError(
        "invalid_manifest",
        "types." + name + ".name",
        "ABI schema name must match its type key",
      );
    }

    if (!Number.isInteger(schema.schema_id) || schema.schema_id <= 0) {
      throw new DuckAbiError(
        "invalid_manifest",
        "types." + name + ".schema_id",
        "ABI schema id must be a positive integer",
      );
    }

    if (schema_ids.has(schema.schema_id)) {
      throw new DuckAbiError(
        "invalid_manifest",
        "types." + name + ".schema_id",
        "ABI schema ids must be unique",
      );
    }

    schema_ids.add(schema.schema_id);
    check_manifest_schema(manifest, schema, "types." + name);
  }
}

function check_manifest_schema(
  manifest: AbiManifest,
  schema: AbiType,
  path: string,
): void {
  if (schema.tag === "struct") {
    let offset = 0;
    let max_align = 1;
    const field_names = new Set<string>();

    for (const field of schema.fields) {
      if (field_names.has(field.name)) {
        throw new DuckAbiError(
          "invalid_manifest",
          path + ".fields",
          "ABI struct field names must be unique",
        );
      }

      field_names.add(field.name);
      const layout = manifest_type_ref_layout(
        manifest,
        field.type,
        path + ".fields." + field.name + ".type",
      );
      offset = align_to(offset, layout.align);

      if (field.offset !== offset) {
        throw new DuckAbiError(
          "invalid_manifest",
          path + ".fields." + field.name + ".offset",
          "ABI struct field offset does not match its schema",
        );
      }

      offset += layout.size;

      if (layout.align > max_align) {
        max_align = layout.align;
      }
    }

    check_schema_layout(
      schema,
      align_to(offset, max_align),
      max_align,
      path,
    );
    return;
  }

  if (schema.tag === "union") {
    let max_payload = 0;
    const case_names = new Set<string>();

    for (let index = 0; index < schema.cases.length; index += 1) {
      const union_case = schema.cases[index];

      if (!union_case) {
        throw new DuckAbiError(
          "invalid_manifest",
          path + ".cases." + index.toString(),
          "Missing ABI union case",
        );
      }

      if (case_names.has(union_case.name)) {
        throw new DuckAbiError(
          "invalid_manifest",
          path + ".cases",
          "ABI union case names must be unique",
        );
      }

      case_names.add(union_case.name);

      if (union_case.tag_value !== index) {
        throw new DuckAbiError(
          "invalid_manifest",
          path + ".cases." + index.toString() + ".tag_value",
          "ABI union tag values must follow case order",
        );
      }

      const layout = manifest_type_ref_layout(
        manifest,
        union_case.payload,
        path + ".cases." + index.toString() + ".payload",
      );

      if (layout.size > max_payload) {
        max_payload = layout.size;
      }
    }

    check_schema_layout(schema, align_to(4 + max_payload, 8), 8, path);
    return;
  }

  if (schema.tag === "array") {
    const element_layout = manifest_type_ref_layout(
      manifest,
      schema.element,
      path + ".element",
    );

    if (!Number.isInteger(schema.length) || schema.length < 0) {
      throw new DuckAbiError(
        "invalid_manifest",
        path + ".length",
        "ABI fixed array length must be a non-negative integer",
      );
    }

    const expected_name = abi_fixed_array_schema_name(
      schema.element,
      schema.length,
    );

    if (schema.name !== expected_name) {
      throw new DuckAbiError(
        "invalid_manifest",
        path + ".name",
        "ABI fixed array name does not match its element schema and length",
      );
    }

    const stride = align_to(element_layout.size, element_layout.align);
    const size = stride * schema.length;

    if (!Number.isSafeInteger(size)) {
      throw new DuckAbiError(
        "invalid_manifest",
        path + ".size",
        "ABI fixed array size exceeds JavaScript's safe integer range",
      );
    }

    if (schema.stride !== stride) {
      throw new DuckAbiError(
        "invalid_manifest",
        path + ".stride",
        "ABI fixed array stride does not match its element schema",
      );
    }

    check_schema_layout(schema, size, element_layout.align, path);
    return;
  }

  schema satisfies never;
  throw new DuckAbiError("invalid_manifest", path, "Unknown ABI schema tag");
}

function check_schema_layout(
  schema: AbiType,
  expected_size: number,
  expected_align: number,
  path: string,
): void {
  if (schema.size !== expected_size) {
    throw new DuckAbiError(
      "invalid_manifest",
      path + ".size",
      "ABI schema size does not match its structure",
    );
  }

  if (schema.align !== expected_align) {
    throw new DuckAbiError(
      "invalid_manifest",
      path + ".align",
      "ABI schema alignment does not match its structure",
    );
  }
}

function manifest_type_ref_layout(
  manifest: AbiManifest,
  type: AbiTypeRef,
  path: string,
): { size: number; align: number } {
  if (type.tag === "i64" || type.tag === "f64") {
    return { size: 8, align: 8 };
  }

  if (type.tag === "unit") {
    return { size: 0, align: 1 };
  }

  if (type.tag === "resource") {
    return { size: 4, align: 4 };
  }

  if (
    type.tag === "i32" || type.tag === "f32" || type.tag === "text" ||
    type.tag === "bytes" || type.tag === "i32_slice" ||
    type.tag === "text_slice"
  ) {
    return { size: 4, align: 4 };
  }

  if (type.tag === "named") {
    const schema = manifest.types[type.name];

    if (!schema || schema.name !== type.name) {
      throw new DuckAbiError(
        "invalid_manifest",
        path,
        "ABI type reference names an unknown schema: " + type.name,
      );
    }

    if (type.indirect) {
      if (schema.tag !== "struct" && schema.tag !== "array") {
        throw new DuckAbiError(
          "invalid_manifest",
          path,
          "Only struct and array ABI references can be indirect",
        );
      }
      return { size: 4, align: 4 };
    }

    if (schema.tag === "struct" || schema.tag === "array") {
      return { size: schema.size, align: schema.align };
    }

    return { size: 4, align: 4 };
  }

  throw new DuckAbiError(
    "invalid_manifest",
    path,
    "Unknown ABI type reference",
  );
}

function same_abi_type_ref(left: AbiTypeRef, right: AbiTypeRef): boolean {
  if (left.tag !== right.tag) {
    return false;
  }

  if (left.tag === "named" && right.tag === "named") {
    return left.name === right.name && left.indirect === right.indirect;
  }

  if (left.tag === "resource" && right.tag === "resource") {
    return left.effect === right.effect;
  }

  return true;
}

function check_effect_requirement(
  manifest: AbiManifest,
  requirement: { effect: string; operation: string },
  path: string,
): void {
  const effect = manifest.effects[requirement.effect];

  if (!effect || !effect.operations[requirement.operation]) {
    throw new DuckAbiError(
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
    throw new DuckAbiError(
      "missing_export",
      "memory",
      "Missing managed memory export",
    );
  }

  if (typeof alloc_value !== "function" || typeof free_value !== "function") {
    throw new DuckAbiError(
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
      throw new DuckAbiError(
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

  function decode_raw(type: AbiTypeRef, raw: unknown, path: string): DuckValue {
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

    if (type.tag === "f32") {
      if (typeof raw !== "number") {
        throw type_error(path, "f32 number");
      }

      return Math.fround(raw);
    }

    if (type.tag === "f64") {
      if (typeof raw !== "number") {
        throw type_error(path, "f64 number");
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
  ): DuckValue {
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
        throw new DuckAbiError(
          "invalid_utf8",
          path,
          "Invalid UTF-8 Text: " + String(error),
        );
      }
    }

    if (type.tag === "i32_slice" || type.tag === "text_slice") {
      const length = view.getUint32(ptr, true);
      check_pointer(memory, ptr + 4, length * 4, path);
      const result: DuckValue[] = [];

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
      throw new DuckAbiError(
        "type_mismatch",
        path,
        "Unsupported ABI pointer type",
      );
    }

    const schema = manifest.types[type.name];

    if (!schema) {
      throw new DuckAbiError(
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
  ): DuckValue {
    if (schema.tag === "struct") {
      check_pointer(memory, ptr, schema.size, path);
      const result: DuckValue[] = [];

      for (let index = 0; index < schema.fields.length; index += 1) {
        const field = schema.fields[index];

        if (field === undefined) {
          throw new DuckAbiError(
            "invalid_manifest",
            path,
            "Missing struct field schema " + index.toString(),
          );
        }

        result.push(decode_slot(
          field.type,
          ptr + field.offset,
          path + "[" + index.toString() + "]",
          view,
        ));
      }

      return result;
    }

    if (schema.tag === "array") {
      check_pointer(memory, ptr, schema.size, path);
      const result: DuckValue[] = [];

      for (let index = 0; index < schema.length; index += 1) {
        result.push(
          decode_slot(
            schema.element,
            ptr + index * schema.stride,
            path + "[" + index.toString() + "]",
            view,
          ),
        );
      }

      return result;
    }

    check_pointer(memory, ptr, 8, path);
    const tag_value = view.getUint32(ptr, true);
    const union_case = schema.cases[tag_value];

    if (!union_case) {
      throw new DuckAbiError(
        "invalid_tag",
        path,
        "Invalid union tag " + tag_value.toString(),
      );
    }

    const result: { tag: string; value?: DuckValue } = { tag: union_case.name };

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
  ): DuckValue {
    if (type.tag === "i32") {
      return view.getInt32(address, true);
    }

    if (type.tag === "i64") {
      return view.getBigInt64(address, true);
    }

    if (type.tag === "f32") {
      return view.getFloat32(address, true);
    }

    if (type.tag === "f64") {
      return view.getFloat64(address, true);
    }

    if (type.tag === "unit") {
      return undefined;
    }

    if (type.tag === "named") {
      const schema = manifest.types[type.name];

      if (
        schema && !type.indirect &&
        (schema.tag === "struct" || schema.tag === "array")
      ) {
        return decode_named(schema, address, path, view);
      }
    }

    return decode_pointer(type, view.getUint32(address, true), path);
  }

  function encode_raw(
    type: AbiTypeRef,
    value: DuckValue,
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

    if (type.tag === "f32") {
      if (typeof value !== "number") {
        throw type_error(path, "number");
      }

      return Math.fround(value);
    }

    if (type.tag === "f64") {
      if (typeof value !== "number") {
        throw type_error(path, "number");
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
    value: DuckValue,
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
            item as DuckValue,
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
      throw new DuckAbiError(
        "invalid_manifest",
        path,
        "Missing ABI schema: " + type.name,
      );
    }

    const ptr = alloc(schema.size, schema.align);
    new Uint8Array(memory.buffer, ptr, schema.size).fill(0);

    try {
      encode_named(schema, ptr, value, path);
      return ptr;
    } catch (error) {
      free_raw(type, ptr);
      throw error;
    }
  }

  function encode_named(
    schema: AbiType,
    ptr: number,
    value: DuckValue,
    path: string,
  ): void {
    if (schema.tag === "struct") {
      if (!Array.isArray(value)) {
        throw type_error(path, "exact product array");
      }

      if (value.length !== schema.fields.length) {
        throw new DuckAbiError(
          "array_length_mismatch",
          path,
          "Expected product length " + schema.fields.length.toString() +
            ", got " + value.length.toString(),
        );
      }

      for (let index = 0; index < schema.fields.length; index += 1) {
        const field = schema.fields[index];

        if (field === undefined) {
          throw new DuckAbiError(
            "invalid_manifest",
            path,
            "Missing struct field schema " + index.toString(),
          );
        }

        encode_slot(
          field.type,
          ptr + field.offset,
          value[index],
          path + "[" + index.toString() + "]",
        );
      }

      return;
    }

    if (schema.tag === "array") {
      if (!Array.isArray(value)) {
        throw type_error(path, "array");
      }

      if (value.length !== schema.length) {
        throw new DuckAbiError(
          "array_length_mismatch",
          path,
          "Expected array length " + schema.length.toString() + ", got " +
            value.length.toString(),
        );
      }

      for (let index = 0; index < schema.length; index += 1) {
        const item = value[index];

        encode_slot(
          schema.element,
          ptr + index * schema.stride,
          item,
          path + "[" + index.toString() + "]",
        );
      }

      return;
    }

    if (typeof value !== "object" || value === null || !("tag" in value)) {
      throw type_error(path, "tagged union object");
    }

    const union = value as { tag: string; value?: DuckValue };
    const union_case = schema.cases.find((item) => item.name === union.tag);

    if (!union_case) {
      throw new DuckAbiError(
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
    value: DuckValue,
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

    if (type.tag === "f32") {
      if (typeof value !== "number") {
        throw type_error(path, "number");
      }

      new DataView(memory.buffer).setFloat32(address, value, true);
      return;
    }

    if (type.tag === "f64") {
      if (typeof value !== "number") {
        throw type_error(path, "number");
      }

      new DataView(memory.buffer).setFloat64(address, value, true);
      return;
    }

    if (type.tag === "unit") {
      return;
    }

    if (type.tag === "named") {
      const schema = manifest.types[type.name];

      if (
        schema && !type.indirect &&
        (schema.tag === "struct" || schema.tag === "array")
      ) {
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

    if (schema.tag === "array") {
      for (let index = 0; index < schema.length; index += 1) {
        free_slot(schema.element, ptr + index * schema.stride, view);
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
    if (
      type.tag === "i32" || type.tag === "i64" || type.tag === "f32" ||
      type.tag === "f64" || type.tag === "unit"
    ) {
      return;
    }

    if (type.tag === "named") {
      const schema = manifest.types[type.name];

      if (
        schema && !type.indirect &&
        (schema.tag === "struct" || schema.tag === "array")
      ) {
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
    throw new DuckAbiError("out_of_bounds", path, "Invalid memory range");
  }

  const end = ptr + length;

  if (end < ptr || end > memory.buffer.byteLength) {
    throw new DuckAbiError(
      "out_of_bounds",
      path,
      "Memory range is out of bounds",
    );
  }
}

function type_error(path: string, expected: string): DuckAbiError {
  return new DuckAbiError("type_mismatch", path, "Expected " + expected);
}
