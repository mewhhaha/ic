import { success_examples } from "../examples/manifest.ts";
import { Source } from "../src/frontend.ts";
import {
  create_state,
  flush_due_diagnostics,
  handle_message,
} from "../src/lsp/server.ts";

type Measurement = {
  source_path: string;
  cold_init_ms: number;
  keystroke_diagnostics_ms: number;
  completion_ms: number;
  workspace_symbol_ms: number;
  source_bytes: number;
  syntax_tokens: number;
  workspace_files: number;
  workspace_analyses: number;
  workspace_symbol_analyses: number;
  analysis_computations: number;
  analysis_computed_bytes: number;
  heap_growth_bytes: number;
};

const budget = {
  cold_init_ms: 3_000,
  keystroke_diagnostics_ms: 1_500,
  completion_ms: 1_000,
  workspace_symbol_ms: 1_000,
  heap_growth_bytes: 128 * 1024 * 1024,
};

const benchmark = benchmark_source();
const uri = new URL("../" + benchmark.path, import.meta.url).href;
const workspace_root = new URL("../", import.meta.url).href;
const before_heap = Deno.memoryUsage().heapUsed;
const state = create_state({ debounce_ms: 0, now: () => 1 });
const init_start = performance.now();
handle_message(state, {
  id: 1,
  method: "initialize",
  params: { rootUri: workspace_root },
});
const cold_init_ms = performance.now() - init_start;
handle_message(state, {
  method: "textDocument/didOpen",
  params: {
    textDocument: {
      uri,
      languageId: "duck",
      version: 1,
      text: benchmark.text,
    },
  },
});
const edited = benchmark.text + "\n// performance edit\n";
const diagnostic_start = performance.now();
handle_message(state, {
  method: "textDocument/didChange",
  params: {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: edited }],
  },
});
flush_due_diagnostics(state, 1);
const keystroke_diagnostics_ms = performance.now() - diagnostic_start;
const completion_start = performance.now();
handle_message(state, {
  id: 2,
  method: "textDocument/completion",
  params: {
    textDocument: { uri },
    position: end_position(edited),
  },
});
const completion_ms = performance.now() - completion_start;
const workspace_analyses = state.workspace.analysis_count();
const workspace_symbol_start = performance.now();
handle_message(state, {
  id: 3,
  method: "workspace/symbol",
  params: { query: "value" },
});
const workspace_symbol_ms = performance.now() - workspace_symbol_start;
const parsed = Source.parse_with_diagnostics(edited);
const metrics = state.documents.cache_metrics(uri, "source_analysis");
const measurement: Measurement = {
  source_path: benchmark.path,
  cold_init_ms,
  keystroke_diagnostics_ms,
  completion_ms,
  workspace_symbol_ms,
  source_bytes: new TextEncoder().encode(edited).length,
  syntax_tokens: parsed.syntax.pieces.filter((piece) => piece.tag === "token")
    .length,
  workspace_files: state.workspace.file_count(),
  workspace_analyses,
  workspace_symbol_analyses: state.workspace.analysis_count() -
    workspace_analyses,
  analysis_computations: metrics.computations,
  analysis_computed_bytes: metrics.computed_bytes,
  heap_growth_bytes: Math.max(0, Deno.memoryUsage().heapUsed - before_heap),
};

console.log(JSON.stringify({ budget, measurement }, undefined, 2));
enforce_budget(measurement);

function benchmark_source(): { path: string; text: string } {
  let largest: { path: string; text: string } | undefined;

  for (const example of success_examples) {
    const url = new URL("../" + example.path, import.meta.url);
    const text = Deno.readTextFileSync(url);

    if (largest === undefined || text.length > largest.text.length) {
      largest = { path: example.path, text };
    }
  }

  const editor_path = "case-studies/editor/editor.duck";
  const editor_text = Deno.readTextFileSync(
    new URL("../" + editor_path, import.meta.url),
  );

  if (largest === undefined || editor_text.length > largest.text.length) {
    largest = { path: editor_path, text: editor_text };
  }

  if (largest === undefined) {
    throw new Error("No Duck source is available for benchmarking");
  }

  return largest;
}

function end_position(text: string): { line: number; character: number } {
  const lines = text.split("\n");
  const last = lines[lines.length - 1];

  if (last === undefined) {
    throw new Error("Missing final source line");
  }

  return { line: lines.length - 1, character: last.length };
}

function enforce_budget(measurement: Measurement): void {
  const failures: string[] = [];

  if (measurement.cold_init_ms > budget.cold_init_ms) {
    failures.push("cold initialization");
  }

  if (
    measurement.keystroke_diagnostics_ms > budget.keystroke_diagnostics_ms
  ) {
    failures.push("keystroke diagnostics");
  }

  if (measurement.completion_ms > budget.completion_ms) {
    failures.push("completion");
  }

  if (measurement.workspace_symbol_ms > budget.workspace_symbol_ms) {
    failures.push("workspace symbols");
  }

  if (measurement.heap_growth_bytes > budget.heap_growth_bytes) {
    failures.push("heap growth");
  }

  if (measurement.workspace_analyses > 0) {
    failures.push("eager workspace analysis");
  }

  if (measurement.workspace_symbol_analyses > 0) {
    failures.push("workspace symbol semantic analysis");
  }

  if (failures.length > 0) {
    throw new Error("LSP performance budget exceeded: " + failures.join(", "));
  }
}
