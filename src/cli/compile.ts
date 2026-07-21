import { DuckHost, DuckRunner, Source } from "../frontend.ts";

type CompileRoute = "ic" | "core" | "managed";
type EmitTarget = "wat" | "wasm" | "all";

type CompileRequest = {
  input_path: string;
  route: CompileRoute;
  host_interface: string | undefined;
};

type BuildRequest = CompileRequest & {
  emit: EmitTarget;
  output_directory: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function run_build(args: string[]): Promise<number> {
  const request = parse_build_request(args);
  const compiled = compile_source(request);
  const source_name = source_stem(request.input_path);

  await Deno.mkdir(request.output_directory, { recursive: true });

  if (request.emit === "wat" || request.emit === "all") {
    const wat_path = output_path(
      request.output_directory,
      source_name + ".wat",
    );
    await Deno.writeTextFile(wat_path, compiled.wat);
    console.log(wat_path);
  }

  if (request.emit === "wasm" || request.emit === "all") {
    const wasm_path = output_path(
      request.output_directory,
      source_name + ".wasm",
    );
    await Deno.writeFile(wasm_path, await wasm_from_wat(compiled.wat));
    console.log(wasm_path);
  }

  if (compiled.abi !== undefined) {
    const manifest_path = output_path(
      request.output_directory,
      source_name + ".abi.json",
    );
    await Deno.writeTextFile(
      manifest_path,
      JSON.stringify(compiled.abi, undefined, 2) + "\n",
    );
    console.log(manifest_path);
  }

  return 0;
}

export async function run_source(args: string[]): Promise<number> {
  const request = parse_run_request(args);
  const compiled = compile_source(request);
  const wasm = await wasm_from_wat(compiled.wat);

  if (compiled.abi !== undefined) {
    const program = await DuckHost.instantiate(wasm, compiled.abi);

    try {
      const result = DuckRunner({}).run(program);
      console.log(Deno.inspect(result, { colors: false }));
      return 0;
    } finally {
      program.dispose();
    }
  }

  const module = await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(module, {});
  const main = instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Compiled module does not export a main function");
  }

  const result = main();

  if (result !== undefined) {
    console.log(result.toString());
  }

  return 0;
}

function parse_build_request(args: string[]): BuildRequest {
  let emit: EmitTarget = "wasm";
  let output_directory = "build";
  const compile_args: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--emit") {
      const value = args[index + 1];

      if (value !== "wat" && value !== "wasm" && value !== "all") {
        throw new Error("--emit expects wat, wasm, or all");
      }

      emit = value;
      index += 1;
      continue;
    }

    if (argument === "--out") {
      const value = args[index + 1];

      if (value === undefined || value.startsWith("--")) {
        throw new Error("--out expects an output directory");
      }

      output_directory = value;
      index += 1;
      continue;
    }

    if (argument === undefined) {
      throw new Error("Missing build argument " + index.toString());
    }

    compile_args.push(argument);
  }

  return {
    ...parse_compile_request(compile_args, "build"),
    emit,
    output_directory,
  };
}

function parse_run_request(args: string[]): CompileRequest {
  return parse_compile_request(args, "run");
}

function parse_compile_request(
  args: string[],
  command: "build" | "run",
): CompileRequest {
  let input_path: string | undefined;
  let route: CompileRoute = "core";
  let host_interface: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--managed") {
      route = "managed";
      continue;
    }

    if (argument === "--route") {
      const value = args[index + 1];

      if (value !== "ic" && value !== "core" && value !== "managed") {
        throw new Error("--route expects ic, core, or managed");
      }

      route = value;
      index += 1;
      continue;
    }

    if (argument === "--host-interface") {
      const value = args[index + 1];

      if (value === undefined || value.startsWith("--")) {
        throw new Error("--host-interface expects a .duck file");
      }

      host_interface = value;
      index += 1;
      continue;
    }

    if (argument === undefined) {
      throw new Error("Missing " + command + " argument " + index.toString());
    }

    if (argument.startsWith("--")) {
      throw new Error("Unknown " + command + " option: " + argument);
    }

    if (input_path !== undefined) {
      throw new Error(
        command + " expects one input file, got " + input_path + " and " +
          argument,
      );
    }

    input_path = argument;
  }

  if (input_path === undefined) {
    throw new Error(command + " expects an input .duck file");
  }

  if (host_interface !== undefined && route !== "managed") {
    throw new Error("--host-interface requires the managed route");
  }

  return { input_path, route, host_interface };
}

function compile_source(request: CompileRequest): {
  wat: string;
  abi: ReturnType<typeof Source.artifact_file>["abi"] | undefined;
} {
  if (request.route === "managed") {
    const artifact = Source.artifact_file(request.input_path, {
      host_interface: request.host_interface,
    });
    return { wat: artifact.wat, abi: artifact.abi };
  }

  if (request.route === "ic") {
    const source = Source.load_fragment_file(request.input_path);
    return { wat: Source.ic_wat(source), abi: undefined };
  }

  const source = Source.load_fragment_file(request.input_path);
  return { wat: Source.wat(source), abi: undefined };
}

export async function wasm_from_wat(
  wat: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const command = new Deno.Command("wat2wasm", {
    args: ["-o", "-", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(encoder.encode(wat));
  await writer.close();
  const output = await command.output();

  if (!output.success) {
    throw new Error(
      "wat2wasm failed:\n" + decoder.decode(output.stderr),
    );
  }

  const wasm = new Uint8Array(new ArrayBuffer(output.stdout.byteLength));
  wasm.set(output.stdout);
  return wasm;
}

function source_stem(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf(".");

  if (dot <= 0) {
    return file;
  }

  return file.slice(0, dot);
}

function output_path(directory: string, file: string): string {
  if (directory.endsWith("/") || directory.endsWith("\\")) {
    return directory + file;
  }

  return directory + "/" + file;
}
