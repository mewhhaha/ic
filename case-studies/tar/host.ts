import {
  DuckAbiError,
  type DuckEffectObject,
  type DuckHostInstance,
  type DuckInitValue,
  DuckRunner,
  type DuckValue,
} from "../../src/frontend.ts";

export type TarInit = DuckInitValue & {
  archive: DuckEffectObject;
};

export type TarRunner = {
  init: TarInit;
  run: (program: DuckHostInstance) => DuckValue;
  dispose: () => void;
};

export type MockTarRunner = TarRunner;

export function live_runner(path: string): TarRunner {
  return mock_runner(Deno.readFileSync(path));
}

export function mock_runner(archive: Uint8Array): MockTarRunner {
  const bytes = archive.slice();
  let disposed = false;
  const init: TarInit = {
    archive: {
      read(): DuckValue {
        if (disposed) {
          throw new DuckAbiError(
            "disposed",
            "Archive.read",
            "Tar runner is disposed",
          );
        }

        return { tag: "Bytes", value: bytes.slice() };
      },
    },
  };
  const runner = DuckRunner(init);

  return {
    init,
    run(program: DuckHostInstance): DuckValue {
      if (disposed) {
        throw new DuckAbiError(
          "disposed",
          "tar.runner",
          "Tar runner is disposed",
        );
      }

      return runner.run(program);
    },
    dispose(): void {
      disposed = true;
    },
  };
}
