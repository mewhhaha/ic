import {
  DuckAbiError,
  type DuckEffectObject,
  type DuckHostInstance,
  type DuckInitValue,
  DuckRunner,
  type DuckValue,
} from "../../src/frontend.ts";

export const io_error_code = {
  not_found: 1,
  permission_denied: 2,
  invalid_state: 3,
  invalid_input: 4,
  other: 5,
} as const;

export type GrepInit = DuckInitValue & {
  process: DuckEffectObject;
  walk: DuckEffectObject;
  file_reader: DuckEffectObject;
  stdin: DuckEffectObject;
  stdout: DuckEffectObject;
  stderr: DuckEffectObject;
};

export type GrepRunner = {
  init: GrepInit;
  run: (program: DuckHostInstance) => DuckValue;
  dispose: () => void;
};

export type MockGrepOptions = {
  args: string[];
  cwd?: string;
  files?: Record<string, Uint8Array>;
  stdin?: Uint8Array;
};

export type MockGrepRunner = GrepRunner & {
  stdout: Uint8Array[];
  stderr: Uint8Array[];
};

type FsKind = "file" | "directory" | "symlink" | "other";

type FsInfo = {
  kind: FsKind;
  size: bigint;
};

type WalkBackend = {
  stat: (path: string) => FsInfo;
  read_dir: (path: string) => string[];
};

type WalkFrame = {
  path: string;
  name: string;
  depth: number;
  size: bigint;
  state: "enter" | "children" | "leave";
  children: string[] | undefined;
  next_child: number;
};

type DisposableEffect = {
  effect: DuckEffectObject;
  dispose: () => void;
};

export function live_runner(args: string[] = Deno.args): GrepRunner {
  const walk = create_walk_effect(deno_walk_backend());
  const file_reader = create_live_file_reader();
  const init: GrepInit = {
    process: create_process_effect(args, Deno.cwd()),
    walk: walk.effect,
    file_reader: file_reader.effect,
    stdin: create_live_stdin(),
    stdout: create_live_output("stdout"),
    stderr: create_live_output("stderr"),
  };

  return create_runner(init, [walk.dispose, file_reader.dispose]);
}

export function mock_runner(options: MockGrepOptions): MockGrepRunner {
  const files = new Map<string, Uint8Array>();

  if (options.files) {
    for (const path in options.files) {
      const bytes = options.files[path];

      if (!bytes) {
        throw new Error("Missing mock file bytes: " + path);
      }

      files.set(path, bytes.slice());
    }
  }

  let cwd = ".";

  if (options.cwd !== undefined) {
    cwd = options.cwd;
  }

  let stdin_bytes = new Uint8Array();

  if (options.stdin !== undefined) {
    stdin_bytes = options.stdin.slice();
  }

  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const walk = create_walk_effect(mock_walk_backend(files));
  const file_reader = create_mock_file_reader(files);
  const init: GrepInit = {
    process: create_process_effect(options.args, cwd),
    walk: walk.effect,
    file_reader: file_reader.effect,
    stdin: create_memory_input(stdin_bytes),
    stdout: create_memory_output(stdout),
    stderr: create_memory_output(stderr),
  };
  const runner = create_runner(init, [walk.dispose, file_reader.dispose]);

  return { ...runner, stdout, stderr };
}

function create_runner(
  init: GrepInit,
  disposers: Array<() => void>,
): GrepRunner {
  const runner = DuckRunner(init);
  let disposed = false;

  return {
    init,
    run(program: DuckHostInstance): DuckValue {
      if (disposed) {
        throw new DuckAbiError(
          "disposed",
          "grep.runner",
          "Grep runner is disposed",
        );
      }

      return runner.run(program);
    },
    dispose(): void {
      if (disposed) {
        return;
      }

      disposed = true;

      for (const dispose of disposers) {
        dispose();
      }
    },
  };
}

function create_process_effect(args: string[], cwd: string): DuckEffectObject {
  const copied_args = [...args];

  return {
    arg_count(): number {
      return copied_args.length;
    },
    arg(index_value: DuckValue): string {
      const index = expect_i32(index_value, "Process.arg index");
      const value = copied_args[index];

      if (value === undefined) {
        throw new DuckAbiError(
          "invalid_argument",
          "Process.arg",
          "Argument index is out of bounds: " + index.toString(),
        );
      }

      return value;
    },
    cwd(): string {
      return cwd;
    },
  };
}

function create_walk_effect(backend: WalkBackend): DisposableEffect {
  const frames: WalkFrame[] = [];
  const pending: DuckValue[] = [];
  let active = false;
  let can_prune = false;

  function reset(): void {
    frames.length = 0;
    pending.length = 0;
    active = false;
    can_prune = false;
  }

  const effect: DuckEffectObject = {
    begin(path_value: DuckValue): DuckValue {
      const path = expect_text(path_value, "Walk.begin path");

      if (active) {
        return error_result(
          path,
          new Error("A walk is already active"),
          io_error_code.invalid_state,
        );
      }

      try {
        const info = backend.stat(path);
        active = true;

        if (info.kind === "directory") {
          frames.push(directory_frame(path, basename(path), 0, info.size));
        } else {
          pending.push(
            entry_event(info.kind, path, basename(path), 0, info.size),
          );
        }

        return { tag: "Ok" };
      } catch (error) {
        reset();
        return error_result(path, error);
      }
    },
    next(): DuckValue {
      if (!active) {
        return error_result(
          "",
          new Error("Walk.next requires an active walk"),
          io_error_code.invalid_state,
        );
      }

      can_prune = false;
      const ready = pending.shift();

      if (ready !== undefined) {
        return ready;
      }

      while (frames.length > 0) {
        const frame = frames[frames.length - 1];

        if (!frame) {
          throw new Error("Missing active walk frame");
        }

        if (frame.state === "enter") {
          frame.state = "children";
          can_prune = true;
          return entry_event(
            "directory",
            frame.path,
            frame.name,
            frame.depth,
            frame.size,
          );
        }

        if (frame.state === "leave") {
          frames.pop();
          return {
            tag: "Leave",
            value: walk_entry(
              frame.path,
              frame.name,
              frame.depth,
              frame.size,
            ),
          };
        }

        if (frame.children === undefined) {
          try {
            frame.children = backend.read_dir(frame.path);
          } catch (error) {
            frame.state = "leave";
            return error_result(frame.path, error);
          }
        }

        const child_name = frame.children[frame.next_child];

        if (child_name === undefined) {
          frame.state = "leave";
          continue;
        }

        frame.next_child += 1;
        const child_path = join_path(frame.path, child_name);
        let info: FsInfo;

        try {
          info = backend.stat(child_path);
        } catch (error) {
          return error_result(child_path, error);
        }

        if (info.kind === "directory") {
          frames.push(
            directory_frame(
              child_path,
              child_name,
              frame.depth + 1,
              info.size,
            ),
          );
          continue;
        }

        return entry_event(
          info.kind,
          child_path,
          child_name,
          frame.depth + 1,
          info.size,
        );
      }

      active = false;
      return { tag: "Done" };
    },
    prune(): undefined {
      const frame = frames[frames.length - 1];

      if (!active || !can_prune || !frame || frame.state !== "children") {
        throw new DuckAbiError(
          "invalid_state",
          "Walk.prune",
          "Walk.prune is valid only immediately after an enter event",
        );
      }

      frame.state = "leave";
      can_prune = false;
      return undefined;
    },
    end(): undefined {
      reset();
      return undefined;
    },
  };

  return { effect, dispose: reset };
}

function directory_frame(
  path: string,
  name: string,
  depth: number,
  size: bigint,
): WalkFrame {
  return {
    path,
    name,
    depth,
    size,
    state: "enter",
    children: undefined,
    next_child: 0,
  };
}

function entry_event(
  kind: FsKind,
  path: string,
  name: string,
  depth: number,
  size: bigint,
): DuckValue {
  let tag = "Other";

  if (kind === "directory") {
    tag = "Enter";
  } else if (kind === "file") {
    tag = "File";
  } else if (kind === "symlink") {
    tag = "Symlink";
  }

  return { tag, value: walk_entry(path, name, depth, size) };
}

function walk_entry(
  path: string,
  name: string,
  depth: number,
  size: bigint,
): DuckValue {
  return [path, name, depth, size];
}

function deno_walk_backend(): WalkBackend {
  return {
    stat(path: string): FsInfo {
      return deno_file_info(Deno.lstatSync(path));
    },
    read_dir(path: string): string[] {
      const names: string[] = [];

      for (const entry of Deno.readDirSync(path)) {
        names.push(entry.name);
      }

      return names;
    },
  };
}

function deno_file_info(info: Deno.FileInfo): FsInfo {
  let kind: FsKind = "other";

  if (info.isSymlink) {
    kind = "symlink";
  } else if (info.isDirectory) {
    kind = "directory";
  } else if (info.isFile) {
    kind = "file";
  }

  return { kind, size: BigInt(info.size) };
}

function mock_walk_backend(files: Map<string, Uint8Array>): WalkBackend {
  const directories = mock_directories(files);

  return {
    stat(path: string): FsInfo {
      const bytes = files.get(path);

      if (bytes) {
        return { kind: "file", size: BigInt(bytes.byteLength) };
      }

      if (directories.has(path)) {
        return { kind: "directory", size: 0n };
      }

      throw new Deno.errors.NotFound("Mock path not found: " + path);
    },
    read_dir(path: string): string[] {
      if (!directories.has(path)) {
        throw new Deno.errors.NotFound("Mock directory not found: " + path);
      }

      const children = new Set<string>();

      for (const candidate of [...directories, ...files.keys()]) {
        if (candidate === path) {
          continue;
        }

        if (parent_path(candidate) === path) {
          children.add(basename(candidate));
        }
      }

      return [...children].sort();
    },
  };
}

function mock_directories(files: Map<string, Uint8Array>): Set<string> {
  const directories = new Set<string>(["."]);

  for (const path of files.keys()) {
    let parent = parent_path(path);

    while (parent !== "" && !directories.has(parent)) {
      directories.add(parent);
      const next = parent_path(parent);

      if (next === parent) {
        break;
      }

      parent = next;
    }
  }

  return directories;
}

function create_live_file_reader(): DisposableEffect {
  let file: Deno.FsFile | undefined;
  let path = "";

  function close(): void {
    if (!file) {
      return;
    }

    file.close();
    file = undefined;
    path = "";
  }

  const effect: DuckEffectObject = {
    open(path_value: DuckValue): DuckValue {
      const requested = expect_text(path_value, "FileReader.open path");

      if (file) {
        return error_result(
          requested,
          new Error("A file is already open"),
          io_error_code.invalid_state,
        );
      }

      try {
        file = Deno.openSync(requested, { read: true });
        path = requested;
        return { tag: "Ok" };
      } catch (error) {
        return error_result(requested, error);
      }
    },
    read(max_value: DuckValue): DuckValue {
      const max = expect_positive_size(max_value, "FileReader.read max_bytes");

      if (!file) {
        return error_result(
          path,
          new Error("No file is open"),
          io_error_code.invalid_state,
        );
      }

      try {
        const buffer = new Uint8Array(max);
        let count = file.readSync(buffer);

        while (count === 0) {
          count = file.readSync(buffer);
        }

        if (count === null) {
          return { tag: "Eof" };
        }

        return { tag: "Chunk", value: buffer.slice(0, count) };
      } catch (error) {
        return error_result(path, error);
      }
    },
    close(): undefined {
      close();
      return undefined;
    },
  };

  return { effect, dispose: close };
}

function create_mock_file_reader(
  files: Map<string, Uint8Array>,
): DisposableEffect {
  let bytes: Uint8Array | undefined;
  let offset = 0;
  let path = "";

  function close(): void {
    bytes = undefined;
    offset = 0;
    path = "";
  }

  const effect: DuckEffectObject = {
    open(path_value: DuckValue): DuckValue {
      const requested = expect_text(path_value, "FileReader.open path");

      if (bytes) {
        return error_result(
          requested,
          new Error("A file is already open"),
          io_error_code.invalid_state,
        );
      }

      const found = files.get(requested);

      if (!found) {
        return error_result(
          requested,
          new Deno.errors.NotFound("Mock file not found: " + requested),
        );
      }

      bytes = found;
      offset = 0;
      path = requested;
      return { tag: "Ok" };
    },
    read(max_value: DuckValue): DuckValue {
      const max = expect_positive_size(max_value, "FileReader.read max_bytes");

      if (!bytes) {
        return error_result(
          path,
          new Error("No file is open"),
          io_error_code.invalid_state,
        );
      }

      if (offset >= bytes.byteLength) {
        return { tag: "Eof" };
      }

      const end = Math.min(offset + max, bytes.byteLength);
      const chunk = bytes.slice(offset, end);
      offset = end;
      return { tag: "Chunk", value: chunk };
    },
    close(): undefined {
      close();
      return undefined;
    },
  };

  return { effect, dispose: close };
}

function create_live_stdin(): DuckEffectObject {
  return {
    read(max_value: DuckValue): DuckValue {
      const max = expect_positive_size(max_value, "Stdin.read max_bytes");

      try {
        const buffer = new Uint8Array(max);
        let count = Deno.stdin.readSync(buffer);

        while (count === 0) {
          count = Deno.stdin.readSync(buffer);
        }

        if (count === null) {
          return { tag: "Eof" };
        }

        return { tag: "Chunk", value: buffer.slice(0, count) };
      } catch (error) {
        return error_result("<stdin>", error);
      }
    },
    is_terminal(): number {
      if (Deno.stdin.isTerminal()) {
        return 1;
      }

      return 0;
    },
  };
}

function create_memory_input(input: Uint8Array): DuckEffectObject {
  let offset = 0;

  return {
    read(max_value: DuckValue): DuckValue {
      const max = expect_positive_size(max_value, "Stdin.read max_bytes");

      if (offset >= input.byteLength) {
        return { tag: "Eof" };
      }

      const end = Math.min(offset + max, input.byteLength);
      const chunk = input.slice(offset, end);
      offset = end;
      return { tag: "Chunk", value: chunk };
    },
    is_terminal(): number {
      return 0;
    },
  };
}

function create_live_output(stream: "stdout" | "stderr"): DuckEffectObject {
  return {
    write(value: DuckValue): DuckValue {
      const bytes = expect_bytes(value, stream + ".write bytes");

      try {
        let offset = 0;

        while (offset < bytes.byteLength) {
          let count: number;

          if (stream === "stdout") {
            count = Deno.stdout.writeSync(bytes.subarray(offset));
          } else {
            count = Deno.stderr.writeSync(bytes.subarray(offset));
          }

          if (count === 0) {
            return error_result(
              "<" + stream + ">",
              new Error("Output stopped before the buffer was written"),
            );
          }

          offset += count;
        }

        return { tag: "Ok" };
      } catch (error) {
        if (error instanceof Deno.errors.BrokenPipe) {
          return { tag: "Closed" };
        }

        return error_result("<" + stream + ">", error);
      }
    },
    is_terminal(): number {
      if (stream === "stdout") {
        if (Deno.stdout.isTerminal()) {
          return 1;
        }
      } else if (Deno.stderr.isTerminal()) {
        return 1;
      }

      return 0;
    },
  };
}

function create_memory_output(output: Uint8Array[]): DuckEffectObject {
  return {
    write(value: DuckValue): DuckValue {
      output.push(expect_bytes(value, "mock output bytes").slice());
      return { tag: "Ok" };
    },
    is_terminal(): number {
      return 0;
    },
  };
}

function error_result(
  path: string,
  error: unknown,
  code?: number,
): DuckValue {
  return { tag: "Err", value: io_error(path, error, code) };
}

function io_error(path: string, error: unknown, code?: number): DuckValue {
  let resolved_code = code;

  if (resolved_code === undefined) {
    resolved_code = classify_io_error(error);
  }

  return [resolved_code, path, error_message(error)];
}

function classify_io_error(error: unknown): number {
  if (error instanceof Deno.errors.NotFound) {
    return io_error_code.not_found;
  }

  if (error instanceof Deno.errors.PermissionDenied) {
    return io_error_code.permission_denied;
  }

  return io_error_code.other;
}

function error_message(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function expect_i32(value: DuckValue, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DuckAbiError("type_mismatch", name, name + " must be an integer");
  }

  return value;
}

function expect_positive_size(value: DuckValue, name: string): number {
  const size = expect_i32(value, name);

  if (size <= 0) {
    throw new DuckAbiError(
      "invalid_argument",
      name,
      name + " must be positive",
    );
  }

  return size;
}

function expect_text(value: DuckValue, name: string): string {
  if (typeof value !== "string") {
    throw new DuckAbiError("type_mismatch", name, name + " must be Text");
  }

  return value;
}

function expect_bytes(value: DuckValue, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new DuckAbiError("type_mismatch", name, name + " must be Bytes");
  }

  return value;
}

function join_path(parent: string, child: string): string {
  if (parent === ".") {
    return "./" + child;
  }

  if (parent.endsWith("/") || parent.endsWith("\\")) {
    return parent + child;
  }

  let separator = "/";

  if (Deno.build.os === "windows") {
    separator = "\\";
  }

  return parent + separator + child;
}

function parent_path(path: string): string {
  const slash = path.lastIndexOf("/");
  const backslash = path.lastIndexOf("\\");
  const index = Math.max(slash, backslash);

  if (index < 0) {
    return ".";
  }

  if (index === 0) {
    return path.slice(0, 1);
  }

  return path.slice(0, index);
}

function basename(path: string): string {
  let end = path.length;

  while (end > 1) {
    const char = path[end - 1];

    if (char !== "/" && char !== "\\") {
      break;
    }

    end -= 1;
  }

  const trimmed = path.slice(0, end);
  const slash = trimmed.lastIndexOf("/");
  const backslash = trimmed.lastIndexOf("\\");
  const index = Math.max(slash, backslash);

  if (index < 0) {
    return trimmed;
  }

  return trimmed.slice(index + 1);
}
