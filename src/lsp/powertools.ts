import { success_examples } from "../../examples/manifest.ts";
import type { LspRange } from "./position.ts";

export type PowertoolsError = {
  ok: false;
  code: "not_runnable" | "unknown_command";
  message: string;
};

export type PowertoolsSuccess<value> = { ok: true; value: value };

export type PowertoolsResult<value> =
  | PowertoolsSuccess<value>
  | PowertoolsError;

export type PowertoolsCodeLens = {
  range: LspRange;
  title: string;
  command: "duck.runExample";
  arguments: unknown[];
};

export type TerminalInvocation = {
  command: "deno";
  args: string[];
};

export type ExecuteCommandRequest = {
  command: string;
  uri: string;
};

export type ExecuteCommandResult = PowertoolsResult<TerminalInvocation>;

export function powertools_code_lenses(uri: string): PowertoolsCodeLens[] {
  const example = example_for_uri(uri);

  if (example === undefined) {
    return [];
  }

  return [{
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
    title: "▸ run example",
    command: "duck.runExample",
    arguments: [uri],
  }];
}

export function execute_powertools_command(
  request: ExecuteCommandRequest,
): ExecuteCommandResult {
  if (request.command === "duck.runExample") {
    const example = example_for_uri(request.uri);

    if (example === undefined) {
      return {
        ok: false,
        code: "not_runnable",
        message: "This file is not a runnable manifest example",
      };
    }

    return {
      ok: true,
      value: {
        command: "deno",
        args: [
          "test",
          "--allow-read",
          "--allow-write",
          "--allow-run",
          "examples/examples.test.ts",
          "--filter",
          "example runs: " + example.path,
        ],
      },
    };
  }

  return {
    ok: false,
    code: "unknown_command",
    message: "Unknown Duck powertools command: " + request.command,
  };
}

function example_for_uri(
  uri: string,
): typeof success_examples[number] | undefined {
  const path = path_for_uri(uri);

  for (const example of success_examples) {
    if (path === example.path || path.endsWith("/" + example.path)) {
      return example;
    }
  }

  return undefined;
}

function path_for_uri(uri: string): string {
  if (uri.startsWith("file:")) {
    return new URL(uri).pathname;
  }

  return uri;
}
