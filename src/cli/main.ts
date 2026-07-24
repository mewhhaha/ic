import { format_text } from "../fmt/format.ts";
import { run_lsp } from "../lsp/server.ts";
import { Source, type SourceDiagnostic } from "../frontend.ts";

const usage = `Usage: duck <command>

Commands:
  build <file> [options]    Compile a .duck file to Wasm through gpufuck
  run <file> [options]      Compile and run a .duck file
  test <file>               Compile and run @[test] functions
  fmt [paths...] [--check]  Format .duck files in place; --check only reports
  fmt --stdin               Format source from stdin to stdout
  check <paths...>          Analyze .duck files and report diagnostics
  lsp                       Run the language server over stdio

Build options:
  --out <directory>         Write outputs under this directory
  --host-interface <file>   Add host capability declarations
`;

export async function run_cli(args: string[]): Promise<number> {
  const command = args[0];

  try {
    return await dispatch_command(command, args.slice(1));
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      return 1;
    }

    throw error;
  }
}

async function dispatch_command(
  command: string | undefined,
  args: string[],
): Promise<number> {
  if (command === "build") {
    const { run_build } = await import("./compile.ts");
    return await run_build(args);
  }

  if (command === "run") {
    const { run_source } = await import("./compile.ts");
    return await run_source(args);
  }

  if (command === "test") {
    const { run_tests } = await import("./test.ts");
    return await run_tests(args);
  }

  if (command === "fmt") {
    return await run_fmt(args);
  }

  if (command === "check") {
    return await run_check(args);
  }

  if (command === "lsp") {
    return await run_lsp();
  }

  console.error(usage.trimEnd());

  if (command === undefined || command === "--help" || command === "help") {
    return 0;
  }

  return 1;
}

async function run_fmt(args: string[]): Promise<number> {
  const check = args.includes("--check");
  const stdin = args.includes("--stdin");
  const paths = args.filter((arg) => !arg.startsWith("--"));

  if (stdin) {
    const text = new TextDecoder().decode(
      await read_all(Deno.stdin.readable),
    );
    const failure = parse_failure(text);

    if (failure !== undefined) {
      console.error("<stdin>: " + failure);
      return 1;
    }

    await write_stdout(format_text(text));
    return 0;
  }

  const files = await collect_files(paths.length > 0 ? paths : ["."]);
  let changed = 0;
  let failed = 0;

  for (const file of files) {
    const text = await Deno.readTextFile(file);
    const failure = parse_failure(text);

    if (failure !== undefined) {
      console.error(file + ": " + failure);
      failed += 1;
      continue;
    }

    const formatted = format_text(text);

    if (formatted === text) {
      continue;
    }

    changed += 1;

    if (check) {
      console.log(file);
    } else {
      await Deno.writeTextFile(file, formatted);
      console.log("Formatted " + file);
    }
  }

  if (failed > 0) {
    return 1;
  }

  if (check && changed > 0) {
    return 1;
  }

  return 0;
}

async function run_check(args: string[]): Promise<number> {
  const paths = args.filter((arg) => !arg.startsWith("--"));

  if (paths.length === 0) {
    console.error(usage.trimEnd());
    return 1;
  }

  const files = await collect_files(paths);
  let failed = 0;

  for (const file of files) {
    const analysis = Source.analyze_file(file, { warnings: true });

    for (const diagnostic of analysis.diagnostics) {
      console.error(format_source_diagnostic(
        file,
        analysis.syntax.text,
        diagnostic,
      ));

      if (diagnostic.severity === "error") {
        failed += 1;
      }
    }
  }

  return failed > 0 ? 1 : 0;
}

function format_source_diagnostic(
  file: string,
  text: string,
  diagnostic: SourceDiagnostic,
): string {
  const location = source_location(text, diagnostic.span.start);
  const lines = [
    file + ":" + location.line.toString() + ":" +
    location.column.toString() + ": " + diagnostic.severity + "[" +
    diagnostic.code + "]: " + diagnostic.message,
  ];

  if (diagnostic.related === undefined) {
    return lines[0];
  }

  for (const related of diagnostic.related) {
    let related_file = file;
    let related_text = text;

    if (related.uri !== undefined) {
      const related_url = new URL(related.uri);
      related_file = related_url.pathname;
      related_text = Deno.readTextFileSync(related_url);
    }

    const related_location = source_location(related_text, related.span.start);
    lines.push(
      "  " + related_file + ":" + related_location.line.toString() + ":" +
        related_location.column.toString() + ": note: " + related.message,
    );
  }

  return lines.join("\n");
}

function source_location(
  text: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;

  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      column = 1;
      continue;
    }

    column += 1;
  }

  return { line, column };
}

function parse_failure(text: string): string | undefined {
  try {
    Source.parse(text);
    return undefined;
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}

async function collect_files(paths: string[]): Promise<string[]> {
  const files: string[] = [];

  for (const path of paths) {
    const info = await Deno.stat(path);

    if (info.isFile) {
      files.push(path);
      continue;
    }

    const pending = [path];

    while (pending.length > 0) {
      const directory = pending.pop();

      if (directory === undefined) {
        continue;
      }

      for await (const entry of Deno.readDir(directory)) {
        if (entry.name.startsWith(".")) {
          continue;
        }

        const entry_path = directory + "/" + entry.name;

        if (entry.isDirectory) {
          pending.push(entry_path);
        } else if (entry.name.endsWith(".duck")) {
          files.push(entry_path);
        }
      }
    }
  }

  files.sort();
  return files;
}

async function read_all(
  readable: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;

  for await (const chunk of readable) {
    chunks.push(chunk);
    length += chunk.length;
  }

  const combined = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return combined;
}

async function write_stdout(text: string): Promise<void> {
  const writer = Deno.stdout.writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  writer.releaseLock();
}
