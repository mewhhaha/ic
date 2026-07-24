import {
  compileFunctionalModuleToWasm,
  type EncodedFunctionalModule,
  type FunctionalCompileResult,
  type FunctionalComptimeExecutionOptions,
  type FunctionalComptimeExecutionResult,
  type FunctionalComptimeModuleArtifact,
  type FunctionalStoragePlan,
  type FunctionalWasmAsyncInit,
  type FunctionalWasmAsyncRunOptions,
  type FunctionalWasmExecution,
  type FunctionalWasmInit,
  type FunctionalWasmInitBinding,
  type FunctionalWasmRunOptions,
  GpuFunctionalCompiler,
  GpuFunctionalComptimeExecutor,
  type GpuFunctionalModule,
  planFunctionalModuleStorage,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  runFunctionalWasmModuleAsync,
} from "../../../gpufuck/functional.ts";
import type { Source as SourceNode } from "../../src/frontend/ast.ts";
import { format_source } from "../../src/frontend/format.ts";
import { source_with_host_interface } from "../../src/frontend/host_interface.ts";
import type { SourceImportMeta } from "../../src/frontend/import_meta.ts";
import { source_with_import_meta } from "../../src/frontend/import_meta.ts";
import {
  load_source_fragment_file_with_dependencies,
  source_file_url,
  type SourceDependency,
} from "../../src/frontend/load.ts";
import { parse_source } from "../../src/frontend/parser.ts";
import {
  lower_duck_source_to_gpufuck,
  type LoweredDuckGpufuckModule,
} from "./core_lowering.ts";

const maximum_gpufuck_compilation_steps = 10_000_000;
const maximum_cached_compiler_entries = 64;

export type DuckRunOptions =
  & Omit<FunctionalWasmRunOptions, "init">
  & {
    init?: FunctionalWasmInit;
  };

export type DuckFileOptions = {
  host_interface?: string;
  import_meta?: SourceImportMeta;
};

export type DuckTestResult =
  | { name: string; status: "passed" }
  | { name: string; status: "failed"; message: string };

export type DuckRunFileOptions =
  & DuckRunOptions
  & DuckFileOptions;

export type DuckAsyncRunFileOptions =
  & DuckAsyncRunOptions
  & DuckFileOptions;

export type DuckAsyncRunOptions =
  & Omit<
    FunctionalWasmAsyncRunOptions,
    "init"
  >
  & {
    init?: FunctionalWasmAsyncInit;
  };

export type DuckComptimeOptions = FunctionalComptimeExecutionOptions;

export type DuckComptimeResult = FunctionalComptimeExecutionResult;

export interface DuckProgram {
  run(
    options?: DuckRunOptions,
  ): Promise<FunctionalWasmExecution>;
  run_async(
    options?: DuckAsyncRunOptions,
  ): Promise<FunctionalWasmExecution>;
  destroy(): void;
}

class PreparedDuckProgram implements DuckProgram {
  readonly #path: string;
  readonly #module: GpuFunctionalModule;
  readonly #automatic_init: FunctionalWasmInit;
  #destroyed = false;

  constructor(
    path: string,
    module: GpuFunctionalModule,
    automatic_init: FunctionalWasmInit,
  ) {
    this.#path = path;
    this.#module = module;
    this.#automatic_init = automatic_init;
  }

  async run(
    options: DuckRunOptions = {},
  ): Promise<FunctionalWasmExecution> {
    if (this.#destroyed) {
      throw new Error(
        "Prepared Duck program has been destroyed: " + this.#path,
      );
    }

    return await runFunctionalWasmModule(this.#module, {
      ...options,
      init: merge_init(this.#automatic_init, options.init),
    });
  }

  async run_async(
    options: DuckAsyncRunOptions = {},
  ): Promise<FunctionalWasmExecution> {
    if (this.#destroyed) {
      throw new Error(
        "Prepared Duck program has been destroyed: " + this.#path,
      );
    }

    return await runFunctionalWasmModuleAsync(this.#module, {
      ...options,
      init: merge_async_init(this.#automatic_init, options.init),
    });
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }

    this.#destroyed = true;
    this.#module.destroy();
  }
}

export class DuckCompiler {
  readonly #device: GPUDevice;
  readonly #compiler: GpuFunctionalCompiler;
  readonly #wasm_by_source = new Map<
    string,
    Promise<Uint8Array<ArrayBuffer>>
  >();
  readonly #lowered_by_source = new Map<string, LoweredDuckGpufuckModule>();
  readonly #loaded_by_file = new Map<string, LoadedDuckFile>();
  #comptime: Promise<GpuFunctionalComptimeExecutor> | undefined;

  private constructor(device: GPUDevice, compiler: GpuFunctionalCompiler) {
    this.#device = device;
    this.#compiler = compiler;
  }

  static async create(): Promise<DuckCompiler> {
    const device = await requestWebGpuDevice();

    try {
      const compiler = await GpuFunctionalCompiler.create(device);
      return new DuckCompiler(device, compiler);
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  async compile(source: string): Promise<Uint8Array<ArrayBuffer>> {
    return await this.#compile_cached_source(
      "text:" + source,
      () => this.#lower_text(source),
    );
  }

  async compile_batch(
    sources: readonly string[],
  ): Promise<readonly Uint8Array<ArrayBuffer>[]> {
    const lowered_modules = sources.map((source) => this.#lower_text(source));
    return await this.#compile_lowered_batch(lowered_modules);
  }

  async compile_files(
    paths: readonly string[],
    options: DuckFileOptions = {},
  ): Promise<readonly Uint8Array<ArrayBuffer>[]> {
    const lowered_modules = paths.map((path) =>
      this.#lower_file(path, options)
    );
    return await this.#compile_lowered_batch(lowered_modules);
  }

  async compile_file(
    path: string,
    options: DuckFileOptions = {},
  ): Promise<Uint8Array<ArrayBuffer>> {
    const input = this.#load_file(path, options);
    return await this.#compile_cached_source(
      input.compilation_key,
      () => this.#lower_loaded_file(input),
    );
  }

  async prepare_file(
    path: string,
    options: DuckFileOptions = {},
  ): Promise<DuckProgram> {
    const lowered = this.#lower_file(path, options);
    const module = await this.#compile_module(lowered);
    return new PreparedDuckProgram(
      path,
      module,
      lowered.automatic_init,
    );
  }

  async plan_storage(source: string): Promise<FunctionalStoragePlan> {
    const lowered = this.#lower_text(source);
    const module = await this.#compile_module(lowered);
    try {
      return await planFunctionalModuleStorage(module);
    } finally {
      module.destroy();
    }
  }

  async evaluate_comptime(
    source: string,
    options: DuckComptimeOptions = {},
  ): Promise<DuckComptimeResult> {
    return await this.#evaluate_comptime_module(
      this.#lower_text(source),
      options,
    );
  }

  async evaluate_comptime_file(
    path: string,
    options: DuckComptimeOptions = {},
  ): Promise<DuckComptimeResult> {
    return await this.#evaluate_comptime_module(
      this.#lower_file(path),
      options,
    );
  }

  async run(
    source: string,
    options: DuckRunOptions = {},
  ): Promise<FunctionalWasmExecution> {
    const lowered = this.#lower_text(source);
    const module = await this.#compile_module(lowered);
    try {
      return await runFunctionalWasmModule(module, {
        ...options,
        init: merge_init(lowered.automatic_init, options.init),
      });
    } finally {
      module.destroy();
    }
  }

  async run_file(
    path: string,
    options: DuckRunFileOptions = {},
  ): Promise<FunctionalWasmExecution> {
    const lowered = this.#lower_file(path, options);
    const {
      host_interface: _host_interface,
      import_meta: _import_meta,
      ...run_options
    } = options;
    const module = await this.#compile_module(lowered);
    try {
      return await runFunctionalWasmModule(module, {
        ...run_options,
        init: merge_init(lowered.automatic_init, run_options.init),
      });
    } finally {
      module.destroy();
    }
  }

  async run_async(
    source: string,
    options: DuckAsyncRunOptions = {},
  ): Promise<FunctionalWasmExecution> {
    const lowered = this.#lower_text(source);
    const module = await this.#compile_module(lowered);
    try {
      return await runFunctionalWasmModuleAsync(module, {
        ...options,
        init: merge_async_init(lowered.automatic_init, options.init),
      });
    } finally {
      module.destroy();
    }
  }

  async run_async_file(
    path: string,
    options: DuckAsyncRunFileOptions,
  ): Promise<FunctionalWasmExecution> {
    const lowered = this.#lower_file(path, options);
    const {
      host_interface: _host_interface,
      import_meta: _import_meta,
      ...run_options
    } = options;
    const module = await this.#compile_module(lowered);
    try {
      return await runFunctionalWasmModuleAsync(module, {
        ...run_options,
        init: merge_async_init(lowered.automatic_init, run_options.init),
      });
    } finally {
      module.destroy();
    }
  }

  async test_file(path: string): Promise<DuckTestResult[]> {
    const lowered = this.#lower_file(path, {
      import_meta: { mode: { atom: "test" } },
    });
    const module = await this.#compile_module(lowered);

    try {
      const execution = await runFunctionalWasmModule(module, {
        init: lowered.automatic_init,
      });
      const callables = lowered.abi.callables;

      if (callables === undefined) {
        throw new Error("Test module is missing callable contracts: " + path);
      }

      const results: DuckTestResult[] = [];
      for (const name of Object.keys(callables).sort()) {
        const callable = callables[name];

        if (callable === undefined) {
          throw new Error("Missing test callable contract for " + name);
        }

        if (
          callable.params.length !== 0 || callable.result.type.tag !== "unit"
        ) {
          results.push({
            name,
            status: "failed",
            message: "Test must have type () -> Unit",
          });
          continue;
        }

        const test = execution.instance.exports[callable.export];

        if (typeof test !== "function") {
          throw new Error(
            "Compiled test module is missing export " + callable.export,
          );
        }

        try {
          test();
          results.push({ name, status: "passed" });
        } catch (error) {
          if (error instanceof Error) {
            results.push({ name, status: "failed", message: error.message });
          } else {
            results.push({ name, status: "failed", message: String(error) });
          }
        }
      }

      return results;
    } finally {
      module.destroy();
    }
  }

  async #compile_lowered_batch(
    lowered_modules: readonly LoweredDuckGpufuckModule[],
  ): Promise<readonly Uint8Array<ArrayBuffer>[]> {
    const results = await this.#compiler.compileBatch(
      lowered_modules.map((lowered) => lowered.encoded),
      { maximumSteps: maximum_gpufuck_compilation_steps },
    );
    const compiled_modules = successful_modules(
      results,
      lowered_modules.length,
    );

    try {
      return await Promise.all(
        compiled_modules.map((module) => {
          return compileFunctionalModuleToWasm(module);
        }),
      );
    } finally {
      for (const module of compiled_modules) {
        module.destroy();
      }
    }
  }

  async #compile_cached_source(
    key: string,
    lower: () => LoweredDuckGpufuckModule,
  ): Promise<Uint8Array<ArrayBuffer>> {
    let compilation = this.#wasm_by_source.get(key);
    if (compilation === undefined) {
      compilation = Promise.resolve().then(async () => {
        const module = await this.#compile_module(lower());
        try {
          return await compileFunctionalModuleToWasm(module);
        } finally {
          module.destroy();
        }
      });
      this.#wasm_by_source.set(key, compilation);
      while (this.#wasm_by_source.size > maximum_cached_compiler_entries) {
        const oldest = this.#wasm_by_source.keys().next().value;

        if (oldest === undefined) {
          throw new Error("Duck Wasm cache exceeded its configured limit");
        }

        this.#wasm_by_source.delete(oldest);
      }
    } else {
      this.#wasm_by_source.delete(key);
      this.#wasm_by_source.set(key, compilation);
    }
    try {
      return (await compilation).slice();
    } catch (error) {
      if (this.#wasm_by_source.get(key) === compilation) {
        this.#wasm_by_source.delete(key);
      }
      throw error;
    }
  }

  #lower_text(source: string): LoweredDuckGpufuckModule {
    const key = "text:" + source;
    return this.#cached_lowering(key, () => lower_duck_text(source));
  }

  #lower_file(
    path: string,
    options: DuckFileOptions = {},
  ): LoweredDuckGpufuckModule {
    return this.#lower_loaded_file(this.#load_file(path, options));
  }

  #load_file(path: string, options: DuckFileOptions): LoadedDuckFile {
    const key = duck_file_cache_key(path, options);
    const cached = this.#loaded_by_file.get(key);

    if (cached !== undefined && dependencies_unchanged(cached.dependencies)) {
      this.#loaded_by_file.delete(key);
      this.#loaded_by_file.set(key, cached);
      return cached;
    }

    const loaded = load_duck_file(path, options);
    this.#loaded_by_file.set(key, loaded);

    while (this.#loaded_by_file.size > maximum_cached_compiler_entries) {
      const oldest = this.#loaded_by_file.keys().next().value;

      if (oldest === undefined) {
        throw new Error("Duck file cache exceeded its configured limit");
      }

      this.#loaded_by_file.delete(oldest);
    }

    return loaded;
  }

  #lower_loaded_file(input: LoadedDuckFile): LoweredDuckGpufuckModule {
    return this.#cached_lowering(
      input.compilation_key,
      () => lower_loaded_duck_file(input),
    );
  }

  #cached_lowering(
    key: string,
    lower: () => LoweredDuckGpufuckModule,
  ): LoweredDuckGpufuckModule {
    const cached = this.#lowered_by_source.get(key);
    if (cached !== undefined) {
      this.#lowered_by_source.delete(key);
      this.#lowered_by_source.set(key, cached);
      return cached;
    }
    const lowered = lower();
    this.#lowered_by_source.set(key, lowered);
    while (this.#lowered_by_source.size > maximum_cached_compiler_entries) {
      const oldest = this.#lowered_by_source.keys().next().value;

      if (oldest === undefined) {
        throw new Error("Duck lowering cache exceeded its configured limit");
      }

      this.#lowered_by_source.delete(oldest);
    }
    return lowered;
  }

  async #compile_module(
    lowered: LoweredDuckGpufuckModule,
  ): Promise<GpuFunctionalModule> {
    const result = await this.#compiler.compileModule(lowered.encoded, {
      maximumSteps: maximum_gpufuck_compilation_steps,
    });
    if (!result.ok) {
      throw compilation_error(result, 0);
    }
    return result.module;
  }

  async #evaluate_comptime_module(
    lowered: LoweredDuckGpufuckModule,
    options: DuckComptimeOptions,
  ): Promise<DuckComptimeResult> {
    const lowered_artifact = lowered.artifact;
    let comptime_artifact: FunctionalComptimeModuleArtifact = {
      name: lowered_artifact.name,
      definitions: lowered_artifact.definitions,
      typeDeclarations: lowered_artifact.typeDeclarations,
      imports: lowered_artifact.imports,
      exports: lowered_artifact.exports.flatMap((exported) => {
        if (exported.type === undefined) {
          return [];
        }
        return [{ ...exported, type: exported.type }];
      }),
      sourceByteLength: lowered_artifact.sourceByteLength,
    };
    if (lowered_artifact.options.evaluationProfile !== undefined) {
      comptime_artifact = {
        ...comptime_artifact,
        evaluationProfile: lowered_artifact.options.evaluationProfile,
      };
    }
    if (this.#comptime === undefined) {
      this.#comptime = GpuFunctionalComptimeExecutor.create(this.#device);
    }
    const comptime = await this.#comptime;
    return await comptime.executeExports(
      [comptime_artifact],
      [{ module: comptime_artifact.name, exportName: "main" }],
      options,
    );
  }

  destroy(): void {
    this.#wasm_by_source.clear();
    this.#lowered_by_source.clear();
    this.#loaded_by_file.clear();
    this.#device.destroy();
  }
}

export function encode_duck_module(
  source_text: string,
): EncodedFunctionalModule {
  return lower_duck_text(source_text).encoded;
}

export function encode_duck_file(path: string): EncodedFunctionalModule {
  return lower_duck_file(path).encoded;
}

function lower_duck_text(source_text: string): LoweredDuckGpufuckModule {
  const source = parse_source(source_text);
  const source_byte_length = new TextEncoder().encode(source_text).byteLength;
  return lower_gpufuck_source(source, source_byte_length);
}

function lower_duck_file(
  path: string,
  options: DuckFileOptions = {},
): LoweredDuckGpufuckModule {
  return lower_loaded_duck_file(load_duck_file(path, options));
}

type LoadedDuckFile = {
  compilation_key: string;
  dependencies: readonly SourceDependency[];
  linked_source: string;
  source: SourceNode;
};

function load_duck_file(
  path: string,
  options: DuckFileOptions,
): LoadedDuckFile {
  const loaded = load_source_fragment_file_with_dependencies(path);
  const dependencies = new Map(
    loaded.dependencies.map((dependency) => [dependency.uri, dependency.text]),
  );
  let source = loaded.source;
  if (options.import_meta !== undefined) {
    source = source_with_import_meta(source, options.import_meta);
  }
  if (options.host_interface !== undefined) {
    const host = load_source_fragment_file_with_dependencies(
      options.host_interface,
    );
    merge_source_dependencies(dependencies, host.dependencies);
    source = source_with_host_interface(
      source,
      host.source,
    );
  }
  const linked_source = format_source(source);
  const ordered_dependencies = Array.from(
    dependencies,
    ([uri, text]) => ({ uri, text }),
  ).sort((left, right) => left.uri.localeCompare(right.uri));
  return {
    compilation_key: JSON.stringify({
      dependencies: ordered_dependencies.map((dependency) => ({
        fingerprint: source_text_fingerprint(dependency.text),
        uri: dependency.uri,
      })),
      linked_source: source_text_fingerprint(linked_source),
    }),
    dependencies: ordered_dependencies,
    linked_source,
    source,
  };
}

function source_text_fingerprint(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }

  return text.length.toString(16) + ":" +
    (first >>> 0).toString(16).padStart(8, "0") +
    (second >>> 0).toString(16).padStart(8, "0");
}

function duck_file_cache_key(
  path: string,
  options: DuckFileOptions,
): string {
  let key = source_file_url(path).href;

  if (options.host_interface !== undefined) {
    key += "\nhost=" + source_file_url(options.host_interface).href;
  }

  if (options.import_meta === undefined) {
    return key;
  }

  for (const name of Object.keys(options.import_meta).sort()) {
    const value = options.import_meta[name];

    if (value === undefined) {
      throw new Error("Missing import.meta cache value for " + name);
    }

    key += "\nmeta=" + name + ":" + import_meta_cache_value(value);
  }

  return key;
}

function import_meta_cache_value(
  value: SourceImportMeta[string],
): string {
  if (typeof value === "bigint") {
    return "bigint:" + value.toString();
  }

  if (typeof value === "object") {
    return "atom:" + value.atom;
  }

  return typeof value + ":" + String(value);
}

function dependencies_unchanged(
  dependencies: readonly SourceDependency[],
): boolean {
  for (const dependency of dependencies) {
    const current = Deno.readTextFileSync(new URL(dependency.uri));

    if (current !== dependency.text) {
      return false;
    }
  }

  return true;
}

function merge_source_dependencies(
  destination: Map<string, string>,
  dependencies: readonly SourceDependency[],
): void {
  for (const dependency of dependencies) {
    const existing = destination.get(dependency.uri);

    if (existing !== undefined && existing !== dependency.text) {
      throw new Error(
        "Source dependency changed while loading: " + dependency.uri,
      );
    }

    destination.set(dependency.uri, dependency.text);
  }
}

function lower_loaded_duck_file(
  input: LoadedDuckFile,
): LoweredDuckGpufuckModule {
  const source_byte_length = new TextEncoder().encode(input.linked_source)
    .byteLength;
  return lower_gpufuck_source(input.source, source_byte_length);
}

function lower_gpufuck_source(
  source: SourceNode,
  source_byte_length: number,
): LoweredDuckGpufuckModule {
  return lower_duck_source_to_gpufuck(source, source_byte_length);
}

function successful_modules(
  results: readonly FunctionalCompileResult[],
  expected_module_count: number,
): GpuFunctionalModule[] {
  const modules: GpuFunctionalModule[] = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];

    if (result === undefined) {
      destroy_modules(modules);
      throw new Error(
        "gpufuck compiler omitted compilation result " + index.toString(),
      );
    }

    if (!result.ok) {
      destroy_modules(modules);
      throw compilation_error(result, index);
    }

    modules.push(result.module);
  }

  if (modules.length !== expected_module_count) {
    destroy_modules(modules);
    throw new Error(
      "gpufuck compiler returned " + modules.length.toString() +
        " results for " + expected_module_count.toString() + " sources",
    );
  }

  return modules;
}

function compilation_error(
  result: Extract<FunctionalCompileResult, { ok: false }>,
  index: number,
): Error {
  const diagnostic = result.diagnostics[0];
  if (diagnostic === undefined) {
    return new Error(
      "gpufuck compilation " + index.toString() +
        " failed without a diagnostic",
    );
  }
  return new Error(
    "gpufuck compilation " + index.toString() + " failed with " +
      diagnostic.code + " at bytes " + diagnostic.span.startByte.toString() +
      ".." + diagnostic.span.endByte.toString() + ": " + diagnostic.message,
  );
}

function destroy_modules(modules: readonly GpuFunctionalModule[]): void {
  for (const module of modules) {
    module.destroy();
  }
}

function merge_init(
  automatic: FunctionalWasmInit,
  supplied: FunctionalWasmInit | undefined,
): FunctionalWasmInit {
  const merged: Record<string, Record<string, FunctionalWasmInitBinding>> = {};
  for (const [capability, fields] of Object.entries(automatic)) {
    merged[capability] = { ...fields };
  }
  if (supplied !== undefined) {
    for (const [capability, fields] of Object.entries(supplied)) {
      const current = merged[capability];
      if (current === undefined) {
        merged[capability] = { ...fields };
      } else {
        Object.assign(current, fields);
      }
    }
  }
  return merged;
}

function merge_async_init(
  automatic: FunctionalWasmInit,
  supplied: FunctionalWasmAsyncInit | undefined,
): FunctionalWasmAsyncInit {
  const merged: Record<
    string,
    Record<string, FunctionalWasmAsyncInit[string][string]>
  > = {};
  for (const [capability, fields] of Object.entries(automatic)) {
    merged[capability] = { ...fields };
  }
  if (supplied !== undefined) {
    for (const [capability, fields] of Object.entries(supplied)) {
      const current = merged[capability];
      if (current === undefined) {
        merged[capability] = { ...fields };
      } else {
        Object.assign(current, fields);
      }
    }
  }
  return merged;
}
