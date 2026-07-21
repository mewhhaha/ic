import {
  DuckAbiError,
  type DuckEffectObject,
  type DuckHostInstance,
  type DuckInitValue,
  DuckRunner,
  type DuckValue,
} from "../../src/frontend.ts";

const enter_terminal = new TextEncoder().encode("\x1b[?1049h\x1b[?25l");
const leave_terminal = new TextEncoder().encode(
  "\x1b[0m\x1b[?25h\x1b[?1049l",
);

export type EditorInit = DuckInitValue & {
  terminal: DuckEffectObject;
};

export type EditorRunner = {
  init: EditorInit;
  run: (program: DuckHostInstance) => DuckValue;
  dispose: () => void;
};

export type MockEditorRunner = EditorRunner & {
  frames: Uint8Array[];
  saves: Uint8Array[];
};

export function live_runner(path: string): EditorRunner {
  if (!Deno.stdin.isTerminal() || !Deno.stdout.isTerminal()) {
    throw new DuckAbiError(
      "invalid_state",
      "editor.terminal",
      "The editor requires terminal stdin and stdout",
    );
  }

  const terminal = create_live_terminal(path);
  Deno.stdin.setRaw(true);
  Deno.stdout.writeSync(enter_terminal);
  return create_runner({ terminal }, () => {
    Deno.stdout.writeSync(leave_terminal);
    Deno.stdin.setRaw(false);
  });
}

export function mock_runner(
  initial: Uint8Array,
  keys: Uint8Array[],
): MockEditorRunner {
  const frames: Uint8Array[] = [];
  const saves: Uint8Array[] = [];
  let next_key = 0;
  const terminal: DuckEffectObject = {
    load(): Uint8Array {
      return initial.slice();
    },
    read(): DuckValue {
      const key = keys[next_key];

      if (key === undefined) {
        return { tag: "End" };
      }

      next_key += 1;
      return { tag: "Keys", value: key.slice() };
    },
    write(value: DuckValue): undefined {
      frames.push(expect_bytes(value, "Terminal.write frame").slice());
      return undefined;
    },
    save(value: DuckValue): DuckValue {
      saves.push(expect_bytes(value, "Terminal.save contents").slice());
      return { tag: "Ok" };
    },
    columns(): number {
      return 80;
    },
    rows(): number {
      return 24;
    },
  };
  const runner = create_runner({ terminal }, () => undefined);
  return { ...runner, frames, saves };
}

function create_live_terminal(path: string): DuckEffectObject {
  return {
    load(): Uint8Array {
      try {
        return Deno.readFileSync(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          return new Uint8Array();
        }

        throw error;
      }
    },
    read(): DuckValue {
      const buffer = new Uint8Array(64);
      const read = Deno.stdin.readSync(buffer);

      if (read === null) {
        return { tag: "End" };
      }

      return { tag: "Keys", value: buffer.slice(0, read) };
    },
    write(value: DuckValue): undefined {
      Deno.stdout.writeSync(expect_bytes(value, "Terminal.write frame"));
      return undefined;
    },
    save(value: DuckValue): DuckValue {
      try {
        Deno.writeFileSync(path, expect_bytes(value, "Terminal.save contents"));
        return { tag: "Ok" };
      } catch {
        return { tag: "Err" };
      }
    },
    columns(): number {
      return Deno.consoleSize().columns;
    },
    rows(): number {
      return Deno.consoleSize().rows;
    },
  };
}

function create_runner(
  init: EditorInit,
  dispose_terminal: () => void,
): EditorRunner {
  const runner = DuckRunner(init);
  let disposed = false;

  return {
    init,
    run(program: DuckHostInstance): DuckValue {
      if (disposed) {
        throw new DuckAbiError(
          "disposed",
          "editor.runner",
          "Editor runner is disposed",
        );
      }

      return runner.run(program);
    },
    dispose(): void {
      if (disposed) {
        return;
      }

      disposed = true;
      dispose_terminal();
    },
  };
}

function expect_bytes(value: DuckValue, subject: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new DuckAbiError(
      "invalid_argument",
      subject,
      subject + " must be Bytes",
    );
  }

  return value;
}
