import { assert_equals } from "../../src/assert.ts";
import {
  beginFunctionalWasmArena,
  FunctionalStorageClass,
  type FunctionalWasmHostValue,
} from "../../../gpufuck/functional.ts";
import { success_examples } from "../../examples/manifest.ts";
import { gpufuck_benchmark_cases } from "./benchmark_cases.ts";
import { encode_gpufuck_module, ExperimentalDuckCompiler } from "./compiler.ts";

Deno.test("gpufuck experiment lowers the supported scalar source shape", () => {
  const module = encode_gpufuck_module("let value = 40\nvalue + 2");

  assert_equals(module.definitionCount, 1);
  assert_equals(module.entrySymbol, 0);
  assert_equals(module.evaluationProfile, "strict-eager-v1");
  assert_equals(module.nodeCount, 5);
});

Deno.test("gpufuck experiment lowers Duck numeric types", () => {
  const i64_module = encode_gpufuck_module("21i64 * 2i64");
  const f32_module = encode_gpufuck_module("20.5f32 + 21.5f32");
  const f64_module = encode_gpufuck_module("20.5f64 + 21.5f64");

  assert_equals(i64_module.nodeCount, 3);
  assert_equals(f32_module.nodeCount, 3);
  assert_equals(f64_module.nodeCount, 3);
});

Deno.test("gpufuck experiment lowers empty generic union cases", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run(`
type Option value = | \`None Unit | \`Some value
type IntOption = Option I32
let value: IntOption = \`None ()
if let \`None () = value { 42 } else { 0 }
`);
    assert_equals(execution.value, { kind: "integer", value: 42 });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment runs common prelude comparisons", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run(`
const { max_i32, min_i32, text_equal_ascii_case_insensitive } = import "duck:prelude/functional" ()
let equal_score = if text_equal_ascii_case_insensitive(["PowerShell.EXE", "powershell.exe"]) { 1 } else { 0 }
let unequal_score = if text_equal_ascii_case_insensitive(["bash", "zsh"]) { 0 } else { 10 }
let concat_score = if "a" <> "b" <> "c" <> "d" == "abcd" { 10000 } else { 0 }
equal_score + unequal_score + min_i32([7, 3]) * 100 + max_i32([7, 3]) * 1000 + concat_score
`);
    assert_equals(execution.value, { kind: "integer", value: 17_311 });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment formats signed I64 values in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run(`
const { format_i64 } = import "duck:prelude/numeric" ()
if format_i64(-9223372036854775808i64) == "-9223372036854775808" && format_i64(1735894800i64) == "1735894800" { 42 } else { 0 }
`);
    assert_equals(execution.value, { kind: "integer", value: 42 });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment parses signed I64 values in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run(`
const { parse_i64_decimal } = import "duck:prelude/numeric" ()
let minimum = parse_i64_decimal("-9223372036854775808")
let maximum = parse_i64_decimal("9223372036854775807")
let overflow = parse_i64_decimal("9223372036854775808")
let malformed = parse_i64_decimal("--1")
let score = if let \`Ok value = minimum { if value == -9223372036854775808i64 { 1 } else { 0 } } else { 0 }
if let \`Ok value = maximum { if value == 9223372036854775807i64 { score = score + 10 } }
if let \`Err reason = overflow { if reason == "number exceeds I64" { score = score + 100 } }
if let \`Err reason = malformed { if reason == "must be an integer" { score = score + 1000 } }
score
`);
    assert_equals(execution.value, { kind: "integer", value: 1_111 });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment validates full-range U64 decimal text in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run(`
const { parse_u64_decimal_text } = import "duck:prelude/numeric" ()
let maximum = parse_u64_decimal_text("18446744073709551615")
let leading_zero = parse_u64_decimal_text("00042")
let overflow = parse_u64_decimal_text("18446744073709551616")
let score = if let \`Ok value = maximum { if value == "18446744073709551615" { 1 } else { 0 } } else { 0 }
if let \`Ok value = leading_zero { if value == "42" { score = score + 10 } }
if let \`Err message = overflow { if message == "number exceeds U64" { score = score + 100 } }
score
`);
    assert_equals(execution.value, { kind: "integer", value: 111 });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment lowers Duck remainder primitives", () => {
  const remainder_module = encode_gpufuck_module("84 % 30");

  assert_equals(remainder_module.nodeCount, 3);
});

Deno.test("gpufuck experiment preserves annotated function result types", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run(`
type Decision = | \`Accepted Text | \`Rejected Text
let decide: Bool -> Decision = accepted => {
  if accepted { \`Accepted "yes" } else { \`Rejected "no" }
}
let decision = decide(true)
if let \`Accepted message = decision { if message == "yes" { 42 } else { 0 } } else { 0 }
`);
    assert_equals(execution.value, { kind: "integer", value: 42 });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment lowers F32x4 through portable aggregate lanes", () => {
  const module = encode_gpufuck_module(
    "@i32_from_f32(@f32x4_extract_lane(" +
      "@f32x4_add(@f32x4(1f32, 2f32, 3f32, 4f32), " +
      "@f32x4_splat(1f32)), 2))",
  );

  assert_equals(module.definitionCount, 1);
});

Deno.test("gpufuck experiment statically links Duck module records", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "examples/showcases/06_modular_score_application.duck",
    );
    assert_equals(execution.value, { kind: "integer", value: 42 });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment reuses a prepared Duck program", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const program = await compiler.prepare_file(
      "examples/showcases/06_modular_score_application.duck",
    );
    try {
      const first = await program.run();
      const second = await program.run();
      assert_equals(first.value, { kind: "integer", value: 42 });
      assert_equals(second.value, { kind: "integer", value: 42 });
    } finally {
      program.destroy();
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck prepared program rejects execution after destruction", async () => {
  const path = "examples/showcases/06_modular_score_application.duck";
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const program = await compiler.prepare_file(path);
    program.destroy();
    program.destroy();

    let failure = "";
    try {
      await program.run();
    } catch (error) {
      if (!(error instanceof Error)) {
        throw new Error("Prepared Duck program threw a non-Error value");
      }
      failure = error.message;
    }
    assert_equals(
      failure,
      "Prepared Duck program has been destroyed: " + path,
    );
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment executes the Codex-derived citation parser", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const wasm = await compiler.compile_file(
      "case-studies/codex/citation_parser_stream_fixture.duck",
    );
    const module = await WebAssembly.compile(wasm);
    const runtime_imports = imported_buffer_runtime(module);
    assert_equals(runtime_imports, []);
    const execution = await compiler.run_file(
      "case-studies/codex/citation_parser_stream_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "integer",
      value: 474_580_703,
    });
    const main = execution.instance.exports.main;
    const heap_top = execution.instance.exports.heapTop;
    if (
      typeof main !== "function" || !(heap_top instanceof WebAssembly.Global)
    ) {
      throw new Error("gpufuck citation parser omitted main or heapTop");
    }
    const initial_heap_top = heap_top.value;
    for (let invocation = 0; invocation < 2; invocation += 1) {
      const arena = beginFunctionalWasmArena(execution.instance);
      try {
        assert_equals(main(), 474_580_703);
      } finally {
        arena.reset();
      }
      assert_equals(heap_top.value, initial_heap_top);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment executes the source JSON parser", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const wasm = await compiler.compile_file(
      "case-studies/codex/json_fixture.duck",
    );
    const module = await WebAssembly.compile(wasm);
    const runtime_imports = imported_buffer_runtime(module);
    assert_equals(runtime_imports, []);

    const execution = await compiler.run_file(
      "case-studies/codex/json_fixture.duck",
    );
    assert_equals(execution.value, { kind: "integer", value: 11_111 });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck JSON parser rejects truncated literals", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run(`
const { parse_json } = import "duck:prelude/json" ()
let parsed = parse_json("t", 0)
if let \`Err error = parsed {
  let [position, _] = error
  position + 42
} else {
  0
}
`);
    assert_equals(execution.value, { kind: "integer", value: 42 });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment executes the source JSON codec", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const wasm = await compiler.compile_file(
      "case-studies/codex/json_codec_fixture.duck",
    );
    const module = await WebAssembly.compile(wasm);
    assert_equals(imported_buffer_runtime(module), []);

    const execution = await compiler.run_file(
      "case-studies/codex/json_codec_fixture.duck",
    );
    assert_equals(execution.value, { kind: "integer", value: 11_111 });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck source JSON encoder emits ASCII-only strings", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run(`
const { encode_json_string_ascii } = import "duck:prelude/json/encode" ()
if encode_json_string_ascii("東京😀") == "\\\"\\\\u6771\\\\u4eac\\\\ud83d\\\\ude00\\\"" { 42 } else { 0 }
`);
    assert_equals(execution.value, { kind: "integer", value: 42 });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment executes the source Codex protocol codec", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const wasm = await compiler.compile_file(
      "case-studies/codex/protocol_fixture.duck",
    );
    const module = await WebAssembly.compile(wasm);
    assert_equals(imported_buffer_runtime(module), []);

    const execution = await compiler.run_file(
      "case-studies/codex/protocol_fixture.duck",
    );
    assert_equals(execution.value, { kind: "integer", value: 111_111 });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment gates Codex app-server initialization in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const wasm = await compiler.compile_file(
      "case-studies/codex/app_server_fixture.duck",
    );
    const module = await WebAssembly.compile(wasm);
    assert_equals(imported_buffer_runtime(module), []);

    const execution = await compiler.run_file(
      "case-studies/codex/app_server_fixture.duck",
    );
    assert_equals(execution.value, { kind: "integer", value: 1_111_111 });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment routes Codex CLI entrypoints in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/cli_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment parses Codex CLI leaf options in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/cli_options_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment builds typed Codex CLI plans in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/cli_plan_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment parses Codex CLI session commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_resume_fixture.duck", 511],
    ["cli_resume_last_fixture.duck", 1],
    ["cli_fork_fixture.duck", 1],
    ["cli_archive_fixture.duck", 1],
    ["cli_delete_fixture.duck", 11],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex login and logout commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_auth_fixture.duck", 1_111],
    ["cli_auth_device_fixture.duck", 1],
    ["cli_auth_errors_fixture.duck", 111],
    ["cli_auth_route_fixture.duck", 1],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex MCP commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_mcp_query_fixture.duck", 11],
    ["cli_mcp_stdio_fixture.duck", 1],
    ["cli_mcp_http_fixture.duck", 1],
    ["cli_mcp_auth_fixture.duck", 111],
    ["cli_mcp_route_fixture.duck", 1],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex plugin commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_plugin_mutation_fixture.duck", 11],
    ["cli_plugin_list_fixture.duck", 11],
    ["cli_marketplace_add_fixture.duck", 1],
    ["cli_marketplace_maintenance_fixture.duck", 111],
    ["cli_plugin_route_fixture.duck", 1],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex cloud commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_cloud_exec_fixture.duck", 11],
    ["cli_cloud_list_fixture.duck", 11],
    ["cli_cloud_task_fixture.duck", 111],
    ["cli_cloud_route_fixture.duck", 1],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex server commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_server_fixture.duck", 1_111],
    ["cli_server_route_fixture.duck", 1],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex application commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_app_fixture.duck", 1_111],
    ["cli_app_route_fixture.duck", 1],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex app-server commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_app_server_transport_fixture.duck", 1_111],
    ["cli_app_server_auth_fixture.duck", 1_111],
    ["cli_app_server_daemon_fixture.duck", 111],
    ["cli_app_server_generate_fixture.duck", 1_111],
    ["cli_app_server_route_fixture.duck", 1],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex utility commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_utility_fixture.duck", 111],
    ["cli_responses_proxy_fixture.duck", 111],
    ["cli_utility_route_fixture.duck", 1],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex debug commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_debug_fixture.duck", 111],
    ["cli_debug_input_fixture.duck", 11],
    ["cli_debug_route_fixture.duck", 1],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex execpolicy commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_execpolicy_fixture.duck", 11],
    ["cli_execpolicy_route_fixture.duck", 1],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex exec and review commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_exec_fixture.duck", 1],
    ["cli_exec_removed_fixture.duck", 1],
    ["cli_exec_shared_fixture.duck", 1],
    ["cli_exec_output_fixture.duck", 1],
    ["cli_exec_resume_last_fixture.duck", 1],
    ["cli_exec_resume_id_fixture.duck", 1],
    ["cli_exec_review_fixture.duck", 1],
    ["cli_exec_review_conflict_fixture.duck", 1],
    ["cli_exec_head_fixture.duck", 11],
    ["cli_exec_route_fixture.duck", 1],
    ["cli_review_route_fixture.duck", 1],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex sandbox commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly [string, number][] = [
    ["cli_sandbox_fixture.duck", 1_111],
    ["cli_sandbox_route_fixture.duck", 1],
  ];

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment decodes Codex thread methods in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const wasm = await compiler.compile_file(
      "case-studies/codex/app_server_methods_fixture.duck",
    );
    const module = await WebAssembly.compile(wasm);
    assert_equals(imported_buffer_runtime(module), []);

    const execution = await compiler.run_file(
      "case-studies/codex/app_server_methods_fixture.duck",
    );
    assert_equals(execution.value, { kind: "integer", value: 11_111 });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment decodes Codex account methods in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["app_server_account_login_methods_fixture.duck", 6],
    ["app_server_account_api_login_fixture.duck", 11],
    ["app_server_account_chatgpt_login_fixture.duck", 1],
    ["app_server_account_auth_tokens_login_fixture.duck", 1],
    ["app_server_account_bedrock_login_fixture.duck", 1],
    ["app_server_account_methods_fixture.duck", 11],
    ["app_server_account_route_fixture.duck", 1],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment decodes Codex turn methods in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const wasm = await compiler.compile_file(
      "case-studies/codex/app_server_turn_methods_fixture.duck",
    );
    const module = await WebAssembly.compile(wasm);
    assert_equals(imported_buffer_runtime(module), []);

    const execution = await compiler.run_file(
      "case-studies/codex/app_server_turn_methods_fixture.duck",
    );
    assert_equals(execution.value, { kind: "integer", value: 111 });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment decodes Codex turn steering in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/app_server_turn_steer_methods_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 11 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment normalizes and rolls back Codex history in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const wasm = await compiler.compile_file(
      "case-studies/codex/history_fixture.duck",
    );
    const module = await WebAssembly.compile(wasm);
    assert_equals(imported_buffer_runtime(module), []);

    const execution = await compiler.run_file(
      "case-studies/codex/history_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111_116 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment compacts Codex history within a source token budget", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const wasm = await compiler.compile_file(
      "case-studies/codex/compaction_fixture.duck",
    );
    const module = await WebAssembly.compile(wasm);
    assert_equals(imported_buffer_runtime(module), []);

    const execution = await compiler.run_file(
      "case-studies/codex/compaction_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_113 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment truncates Codex text at UTF-8 boundaries", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/truncation_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment discovers hierarchical Codex instructions in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/instruction_discovery_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 11_114 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment merges layered Codex configuration in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/config_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 11_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment renders Codex model context in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/context_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 11_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment selects durable Codex rollout policy in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/rollout_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment reconstructs Codex model context from a rollout", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/rollout_scan_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex response stream retries", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/responses_retry_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment advances Codex auto-compaction windows", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/auto_compact_window_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment runs Codex token-budget tools in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["context_window_status_fixture.duck", 1_111],
    ["context_window_body_status_fixture.duck", 111],
    ["token_budget_tool_registration_fixture.duck", 111],
    ["token_budget_tool_output_fixture.duck", 1_111],
    ["new_context_window_tool_fixture.duck", 1],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex user-input prompts in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["request_user_input_normalization_fixture.duck", 11],
    ["request_user_input_options_fixture.duck", 11],
    ["request_user_input_availability_fixture.duck", 1_111_111],
    ["request_user_input_plan_fixture.duck", 111],
    ["request_user_input_registration_fixture.duck", 111],
    ["request_user_input_output_fixture.duck", 1],
    ["request_user_input_execution_fixture.duck", 11],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex permission requests in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["request_permissions_registration_fixture.duck", 111],
    ["request_permissions_environment_fixture.duck", 111],
    ["request_permissions_policy_fixture.duck", 11],
    ["request_permissions_response_fixture.duck", 1_111],
    ["request_permissions_output_fixture.duck", 1],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex environment waiting in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["wait_for_environment_registration_fixture.duck", 111],
    ["wait_for_environment_policy_fixture.duck", 11_111],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex plan updates in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["update_plan_registration_fixture.duck", 111],
    ["update_plan_policy_fixture.duck", 11_111],
    ["update_plan_value_fixture.duck", 11_111],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment lists Codex plugin install candidates in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["list_plugin_install_registration_fixture.duck", 111],
    ["list_plugin_install_fixture.duck", 11],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment handles Codex plugin install requests in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["request_plugin_install_registration_fixture.duck", 1_111],
    ["request_plugin_install_policy_fixture.duck", 11_111],
    ["request_plugin_install_execution_fixture.duck", 11],
    ["request_plugin_install_value_fixture.duck", 1_111],
  ] as const;
  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment runs the Codex synchronization tool in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["test_sync_registration_fixture.duck", 111],
    ["test_sync_policy_fixture.duck", 1_111],
    ["test_sync_value_fixture.duck", 1_111],
  ] as const;
  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans the Codex image viewer in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["view_image_registration_fixture.duck", 11_111],
    ["view_image_value_fixture.duck", 1_111],
    ["view_image_call_fixture.duck", 111],
    ["view_image_policy_fixture.duck", 1_111],
  ] as const;
  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment discovers deferred Codex tools in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["tool_search_registration_fixture.duck", 1_111],
    ["tool_search_value_fixture.duck", 111],
    ["tool_search_rank_fixture.duck", 111],
    ["tool_search_output_fixture.duck", 11],
    ["tool_search_call_fixture.duck", 11_111],
  ] as const;
  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment accesses Codex MCP resources in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["mcp_resource_registration_fixture.duck", 111],
    ["mcp_resource_call_fixture.duck", 11_111],
    ["mcp_resource_output_fixture.duck", 111],
  ] as const;
  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex agent jobs in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["agent_job_registration_fixture.duck", 1_111],
    ["agent_job_spawn_json_required_fixture.duck", 11],
    ["agent_job_spawn_json_text_fixture.duck", 11],
    ["agent_job_spawn_json_schema_fixture.duck", 11],
    ["agent_job_spawn_json_numeric_fixture.duck", 11],
    ["agent_job_spawn_environment_policy_fixture.duck", 11],
    ["agent_job_spawn_limits_policy_fixture.duck", 11],
    ["agent_job_spawn_policy_fixture.duck", 11_111],
    ["agent_job_csv_fixture.duck", 11_111],
    ["agent_job_prepare_fixture.duck", 11_111],
    ["agent_job_runner_action_fixture.duck", 111],
    ["agent_job_runner_transition_fixture.duck", 1_111],
    ["agent_job_result_fixture.duck", 11],
    ["agent_job_csv_header_output_fixture.duck", 1],
    ["agent_job_csv_row_output_fixture.duck", 11],
    ["agent_job_csv_output_fixture.duck", 11],
    ["agent_job_report_fixture.duck", 1_111],
  ] as const;
  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment profiles Codex turn phases", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/turn_profile_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment records Codex turn timing milestones", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/turn_timing_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment tags Codex sandbox profiles", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/sandbox_tags_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 11_111_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment lists and searches Codex rollout storage", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/rollout_storage_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 10_111_100 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex message history in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: readonly string[] = [
    "message_history_storage_fixture.duck",
    "message_history_batch_fixture.duck",
  ];

  try {
    for (const fixture of fixtures) {
      const path = "case-studies/codex/" + fixture;
      const execution = await compiler.run_file(path);
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: 11_111 }],
      }, path);
      assert_equals(execution.stats.thunkEvaluations, 1, path);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment materializes Codex app-server threads", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/app_server_threads_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 11_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment materializes Codex thread/read", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/app_server_thread_read_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment decodes Codex thread lifecycle methods", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: Array<[string, number]> = [
    ["app_server_thread_start_methods_fixture.duck", 1],
    ["app_server_thread_config_conflict_fixture.duck", 1],
    ["app_server_thread_resume_methods_fixture.duck", 1],
    ["app_server_thread_resume_page_methods_fixture.duck", 1],
    ["app_server_thread_fork_constraints_fixture.duck", 1],
    ["app_server_thread_fork_exclude_methods_fixture.duck", 1],
    ["app_server_thread_fork_persistence_methods_fixture.duck", 1],
    ["app_server_thread_fork_goal_methods_fixture.duck", 1],
    ["app_server_thread_fork_methods_fixture.duck", 1_111],
    ["app_server_thread_operations_methods_fixture.duck", 1_111],
    ["app_server_thread_delete_method_fixture.duck", 11],
    ["app_server_thread_metadata_methods_fixture.duck", 111],
    ["app_server_thread_settings_methods_fixture.duck", 1_111],
    ["app_server_thread_page_methods_fixture.duck", 1_111],
    ["app_server_thread_control_methods_fixture.duck", 1_111],
    ["app_server_goal_set_method_fixture.duck", 1],
    ["app_server_goal_id_methods_fixture.duck", 11],
    ["app_server_goal_method_errors_fixture.duck", 11],
  ];

  try {
    for (const [fixture, expected_score] of fixtures) {
      const path = "case-studies/codex/" + fixture;
      const execution = await compiler.run_file(path);
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: expected_score }],
      }, path);
      assert_equals(execution.stats.thunkEvaluations, 1, path);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex thread lifecycle transitions", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: Array<[string, number]> = [
    ["app_server_thread_start_lifecycle_fixture.duck", 1],
    ["app_server_thread_start_paginated_fixture.duck", 1],
    ["app_server_thread_start_integration_fixture.duck", 1],
    ["app_server_thread_resume_lifecycle_fixture.duck", 1],
    ["app_server_thread_resume_running_fixture.duck", 1],
    ["app_server_thread_resume_paginated_fixture.duck", 1],
    ["app_server_thread_resume_integration_fixture.duck", 1],
    ["app_server_thread_fork_lifecycle_fixture.duck", 1],
    ["app_server_thread_fork_integration_fixture.duck", 1],
    ["app_server_thread_unsubscribe_fixture.duck", 111],
    ["app_server_thread_pages_fixture.duck", 1_111_111],
    ["app_server_thread_turn_cursor_fixture.duck", 111],
    ["app_server_thread_turn_pagination_fixture.duck", 11_100],
    ["app_server_thread_turn_pages_fixture.duck", 11],
    ["app_server_thread_name_fixture.duck", 111],
    ["app_server_thread_elicitation_fixture.duck", 1_111],
    ["app_server_thread_control_responses_fixture.duck", 11],
    ["app_server_thread_paused_response_fixture.duck", 1],
    ["app_server_thread_set_name_response_fixture.duck", 1],
    ["app_server_thread_settings_policy_fixture.duck", 111],
    ["app_server_thread_settings_policy_errors_fixture.duck", 111],
    ["app_server_thread_permission_fixture.duck", 11],
    ["app_server_thread_settings_plan_fixture.duck", 1],
    ["app_server_thread_workspace_roots_fixture.duck", 1],
    ["app_server_thread_delete_fixture.duck", 111_111],
    ["app_server_thread_delete_response_fixture.duck", 11],
    ["app_server_goal_availability_fixture.duck", 111],
    ["app_server_goal_create_fixture.duck", 1],
    ["app_server_goal_update_fixture.duck", 1],
    ["app_server_goal_missing_fixture.duck", 1],
    ["app_server_goal_empty_objective_fixture.duck", 1],
    ["app_server_goal_budget_fixture.duck", 1],
    ["app_server_goal_objective_limit_fixture.duck", 1],
    ["app_server_goal_materialization_fixture.duck", 1],
    ["app_server_goal_get_clear_responses_fixture.duck", 11],
    ["app_server_goal_notifications_fixture.duck", 11],
  ];

  try {
    for (const [fixture, expected_score] of fixtures) {
      const path = "case-studies/codex/" + fixture;
      const execution = await compiler.run_file(path);
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: expected_score }],
      }, path);
      assert_equals(execution.stats.thunkEvaluations, 1, path);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment materializes Codex thread lifecycle responses", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures: Array<[string, number]> = [
    ["app_server_thread_start_response_fixture.duck", 11_111],
    ["app_server_thread_resume_response_fixture.duck", 111],
    ["app_server_thread_fork_response_fixture.duck", 1],
    ["app_server_thread_stable_response_fixture.duck", 1],
    ["app_server_thread_started_notification_fixture.duck", 1],
    ["app_server_thread_operation_responses_fixture.duck", 111],
    ["app_server_thread_metadata_fixture.duck", 11],
    ["app_server_thread_settings_response_fixture.duck", 111],
  ];

  try {
    for (const [fixture, expected_score] of fixtures) {
      const path = "case-studies/codex/" + fixture;
      const execution = await compiler.run_file(path);
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: expected_score }],
      }, path);
      assert_equals(execution.stats.thunkEvaluations, 1, path);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment starts and interrupts Codex app-server turns", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/app_server_turn_lifecycle_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111 }],
    });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment validates Codex turn steering", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/app_server_turn_steer_lifecycle_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 11 }],
    });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment completes Codex app-server turns", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/app_server_turn_terminal_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111 }],
    });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment records Codex app-server turn failures", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/app_server_turn_failure_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment materializes Codex app-server turns", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/app_server_turn_materialization_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment discovers Codex rollout metadata and paths", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/rollout_storage_metadata_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment routes Codex tools in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/tool_registry_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment dispatches Codex tools in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/tool_dispatch_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 3 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment exposes Codex tool metadata in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/tool_metadata_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 3 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment selects Codex MCP exposure and approval", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const exposure = await compiler.run_file(
      "case-studies/codex/mcp_exposure_fixture.duck",
    );
    assert_equals(exposure.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 3 }],
    });

    const approval = await compiler.run_file(
      "case-studies/codex/mcp_approval_fixture.duck",
    );
    assert_equals(approval.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 5 }],
    });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment discovers and selects Codex skills in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const metadata = await compiler.run_file(
      "case-studies/codex/skill_metadata_fixture.duck",
    );
    assert_equals(metadata.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111 }],
    });

    const document = await compiler.run_file(
      "case-studies/codex/skill_document_fixture.duck",
    );
    assert_equals(document.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111 }],
    });

    const discovery = await compiler.run_file(
      "case-studies/codex/skill_discovery_fixture.duck",
    );
    assert_equals(discovery.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111_111 }],
    });

    const rendering = await compiler.run_file(
      "case-studies/codex/skill_render_fixture.duck",
    );
    assert_equals(rendering.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111_111 }],
    });
    assert_equals(metadata.stats.thunkEvaluations, 0);
    assert_equals(document.stats.thunkEvaluations, 0);
    assert_equals(discovery.stats.thunkEvaluations, 0);
    assert_equals(rendering.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment projects Codex plugin capabilities in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/plugin_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment dispatches Codex hooks in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const matcher = await compiler.run_file(
      "case-studies/codex/hook_matcher_fixture.duck",
    );
    assert_equals(matcher.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 97 }],
    });

    const regex = await compiler.run_file(
      "case-studies/codex/hook_regex_fixture.duck",
    );
    assert_equals(regex.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });

    const configPolicy = await compiler.run_file(
      "case-studies/codex/hook_config_policy_fixture.duck",
    );
    assert_equals(configPolicy.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111 }],
    });

    const resultPolicy = await compiler.run_file(
      "case-studies/codex/hook_result_policy_fixture.duck",
    );
    assert_equals(resultPolicy.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });

    const legacyPolicy = await compiler.run_file(
      "case-studies/codex/hook_legacy_policy_fixture.duck",
    );
    assert_equals(legacyPolicy.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });
    assert_equals(matcher.stats.thunkEvaluations, 0);
    assert_equals(regex.stats.thunkEvaluations, 0);
    assert_equals(configPolicy.stats.thunkEvaluations, 0);
    assert_equals(resultPolicy.stats.thunkEvaluations, 0);
    assert_equals(legacyPolicy.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment interprets Codex hook outputs in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const stop = await compiler.run_file(
      "case-studies/codex/hook_stop_output_fixture.duck",
    );
    assert_equals(stop.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111 }],
    });

    const permission = await compiler.run_file(
      "case-studies/codex/hook_permission_output_fixture.duck",
    );
    assert_equals(permission.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111 }],
    });

    const invalidPermission = await compiler.run_file(
      "case-studies/codex/hook_permission_invalid_fixture.duck",
    );
    assert_equals(invalidPermission.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });

    const preTool = await compiler.run_file(
      "case-studies/codex/hook_pre_tool_output_fixture.duck",
    );
    assert_equals(preTool.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111 }],
    });

    const invalidPreTool = await compiler.run_file(
      "case-studies/codex/hook_pre_tool_invalid_fixture.duck",
    );
    assert_equals(invalidPreTool.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });

    const context = await compiler.run_file(
      "case-studies/codex/hook_context_output_fixture.duck",
    );
    assert_equals(context.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111 }],
    });

    const postTool = await compiler.run_file(
      "case-studies/codex/hook_post_tool_output_fixture.duck",
    );
    assert_equals(postTool.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111_111 }],
    });

    const invalidPostTool = await compiler.run_file(
      "case-studies/codex/hook_post_tool_invalid_fixture.duck",
    );
    assert_equals(invalidPostTool.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });

    const userPrompt = await compiler.run_file(
      "case-studies/codex/hook_user_prompt_output_fixture.duck",
    );
    assert_equals(userPrompt.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111 }],
    });

    const stateless = await compiler.run_file(
      "case-studies/codex/hook_stateless_output_fixture.duck",
    );
    assert_equals(stateless.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111 }],
    });
    assert_equals(stop.stats.thunkEvaluations, 1);
    assert_equals(permission.stats.thunkEvaluations, 1);
    assert_equals(invalidPermission.stats.thunkEvaluations, 1);
    assert_equals(preTool.stats.thunkEvaluations, 1);
    assert_equals(invalidPreTool.stats.thunkEvaluations, 1);
    assert_equals(context.stats.thunkEvaluations, 1);
    assert_equals(postTool.stats.thunkEvaluations, 1);
    assert_equals(invalidPostTool.stats.thunkEvaluations, 1);
    assert_equals(userPrompt.stats.thunkEvaluations, 1);
    assert_equals(stateless.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment serializes Codex hook inputs in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/hook_input_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 11 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment applies Codex hook command policy in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const fixtures = [
      ["hook_command_tool_fixture.duck", 3],
      ["hook_command_permission_fixture.duck", 1],
      ["hook_command_post_tool_fixture.duck", 1],
      ["hook_command_user_prompt_fixture.duck", 1],
      ["hook_command_start_fixture.duck", 2],
      ["hook_command_stop_fixture.duck", 2],
      ["hook_command_compact_fixture.duck", 1],
      ["hook_command_session_end_fixture.duck", 1],
      ["hook_command_aggregate_fixture.duck", 1],
    ] as const;

    for (const [fixture, expectedScore] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: expectedScore }],
      });
      assert_equals(execution.stats.thunkEvaluations, 0);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment coordinates Codex agents in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const statusAndCapacity = await compiler.run_file(
      "case-studies/codex/agent_status_capacity_fixture.duck",
    );
    assert_equals(statusAndCapacity.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111_111 }],
    });

    const inputAndTimeout = await compiler.run_file(
      "case-studies/codex/agent_input_timeout_fixture.duck",
    );
    assert_equals(inputAndTimeout.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111 }],
    });

    const path = await compiler.run_file(
      "case-studies/codex/agent_path_fixture.duck",
    );
    assert_equals(path.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111 }],
    });

    const wait = await compiler.run_file(
      "case-studies/codex/agent_wait_fixture.duck",
    );
    assert_equals(wait.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });

    const waitFailure = await compiler.run_file(
      "case-studies/codex/agent_wait_failure_fixture.duck",
    );
    assert_equals(waitFailure.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111 }],
    });

    const waitTimeout = await compiler.run_file(
      "case-studies/codex/agent_wait_timeout_fixture.duck",
    );
    assert_equals(waitTimeout.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });

    const residency = await compiler.run_file(
      "case-studies/codex/agent_residency_fixture.duck",
    );
    assert_equals(residency.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111 }],
    });
    assert_equals(statusAndCapacity.stats.thunkEvaluations, 0);
    assert_equals(inputAndTimeout.stats.thunkEvaluations, 0);
    assert_equals(path.stats.thunkEvaluations, 0);
    assert_equals(wait.stats.thunkEvaluations, 0);
    assert_equals(waitFailure.stats.thunkEvaluations, 0);
    assert_equals(waitTimeout.stats.thunkEvaluations, 0);
    assert_equals(residency.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment applies Codex sandbox policy in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/tool_policy_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment checks Codex patch policy in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/tool_patch_policy_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 5 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment parses Codex patches in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["apply_patch_boundary_fixture.duck", 1_111],
    ["apply_patch_parser_fixture.duck", 111_111],
    ["apply_patch_policy_fixture.duck", 111],
    ["apply_patch_registration_fixture.duck", 1_111],
    ["apply_patch_update_fixture.duck", 1_111],
  ] as const;
  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex sandbox retries in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/tool_sandbox_retry_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 11_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex network approvals in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/network_approval_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 7 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment finishes deferred Codex network approvals", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/network_outcome_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 4 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment resolves Codex shell commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/exec_command_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 124_321 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment canonicalizes Codex approval commands in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const fixtures = [
      ["command_canonicalization_fixture.duck", 1, 1],
      ["command_canonicalization_quoted_fixture.duck", 2, 1],
      ["command_canonicalization_script_fixture.duck", 3, 1],
      ["command_canonicalization_powershell_fixture.duck", 4, 1],
      ["command_canonicalization_preserve_fixture.duck", 5, 1],
      ["command_canonicalization_flag_fixture.duck", 6, 1],
    ] as const;

    for (const [fixture, score, thunkEvaluations] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, thunkEvaluations);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment formats Codex inter-agent session messages", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["session_prefix_notification_fixture.duck", 1],
    ["session_prefix_status_fixture.duck", 1_111_111],
    ["session_prefix_completion_fixture.duck", 111],
    ["session_prefix_terminal_fixture.duck", 1_111],
    ["session_prefix_error_fixture.duck", 111],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex compaction model fallback", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["compaction_tags_fixture.duck", 1],
    ["compact_model_fallback_fixture.duck", 11_111_111],
    ["compact_model_fallback_telemetry_fixture.duck", 11],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment sanitizes Codex original image detail", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["original_image_detail_normalization_fixture.duck", 11_111],
    ["original_image_detail_fixture.duck", 1_111],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment accounts for shared Codex rollout budgets", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["rollout_budget_usage_fixture.duck", 11_111],
    ["rollout_budget_reminder_fixture.duck", 111_111],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment schedules Codex current-time reminders", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["current_time_provider_fixture.duck", 111],
    ["current_time_schedule_fixture.duck", 1_111],
    ["current_time_boundary_fixture.duck", 111_111],
    ["current_time_format_fixture.duck", 11],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex clock tools in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const fixtures = [
    ["current_time_tool_disabled_fixture.duck", 1],
    ["current_time_tool_current_fixture.duck", 1],
    ["current_time_tool_sleep_fixture.duck", 1],
    ["sleep_tool_policy_fixture.duck", 1_111],
  ] as const;

  try {
    for (const [fixture, score] of fixtures) {
      const execution = await compiler.run_file(
        "case-studies/codex/" + fixture,
      );
      assert_equals(execution.value, {
        kind: "constructor",
        name: "duck::$DuckStruct:duck_entry_result_type",
        fields: [{ kind: "integer", value: score }],
      });
      assert_equals(execution.stats.thunkEvaluations, 1);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment renders Codex clock tool output", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/current_time_tool_output_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment projects Codex current time for code mode", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/current_time_code_mode_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 1);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment manages Codex process output in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/exec_output_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 1_111_111_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment manages Codex process sessions in source", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "case-studies/codex/exec_store_fixture.duck",
    );
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 11_111 }],
    });
    assert_equals(execution.stats.thunkEvaluations, 0);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment plans Codex terminal lifecycle events", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const delta = await compiler.run_file(
      "case-studies/codex/exec_event_delta_fixture.duck",
    );
    assert_equals(delta.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 4 }],
    });

    const interaction = await compiler.run_file(
      "case-studies/codex/exec_event_interaction_fixture.duck",
    );
    assert_equals(interaction.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 3 }],
    });

    const lifecycle = await compiler.run_file(
      "case-studies/codex/exec_event_lifecycle_fixture.duck",
    );
    assert_equals(lifecycle.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 5 }],
    });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment executes native Text append and indexing", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_file(
      "examples/data/10_text_append_and_bytes.duck",
    );
    assert_equals(execution.value, { kind: "integer", value: 112 });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment executes native Bytes conversion and slicing", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run(`
scratch {
  let bytes: Bytes = @Utf8.encode("AB")
  let part: Bytes = @slice(bytes, 0, 2)
  let joined: Bytes = @append(part, @Utf8.encode("C"))
  @len(joined) * 100 + @get(joined, 2)
}
`);
    assert_equals(execution.value, { kind: "integer", value: 367 });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment compiles the benchmark suite to runnable Wasm", async () => {
  const sources = await Promise.all(
    gpufuck_benchmark_cases.map((benchmark_case) =>
      Deno.readTextFile(benchmark_case.path)
    ),
  );
  const compiler = await ExperimentalDuckCompiler.create();

  try {
    const modules = await compiler.compile_batch(sources);
    assert_equals(modules.length, gpufuck_benchmark_cases.length);

    for (let index = 0; index < modules.length; index += 1) {
      const wasm = modules[index];
      const benchmark_case = gpufuck_benchmark_cases[index];

      if (wasm === undefined || benchmark_case === undefined) {
        throw new Error(
          "gpufuck test omitted benchmark module " + index.toString(),
        );
      }

      const instance = await WebAssembly.instantiate(wasm);
      const main = instance.instance.exports.main;

      if (typeof main !== "function") {
        throw new Error(
          "gpufuck output for " + benchmark_case.path +
            " does not export main",
        );
      }

      assert_equals(main(), benchmark_case.expected, benchmark_case.path);
    }

    const numeric_modules = await compiler.compile_batch([
      "21i64 * 2i64",
      "20.5f32 + 21.5f32",
      "20.5f64 + 21.5f64",
      "@i32_from_f32(@f32x4_extract_lane(" +
      "@f32x4_add(@f32x4(1f32, 2f32, 3f32, 4f32), " +
      "@f32x4_splat(1f32)), 2))",
    ]);
    const i64_instance = await WebAssembly.instantiate(numeric_modules[0]);
    const f32_instance = await WebAssembly.instantiate(numeric_modules[1]);
    const f64_instance = await WebAssembly.instantiate(numeric_modules[2]);
    const f32x4_instance = await WebAssembly.instantiate(numeric_modules[3]);
    const i64_main = i64_instance.instance.exports.main;
    const f32_main = f32_instance.instance.exports.main;
    const f64_main = f64_instance.instance.exports.main;
    const f32x4_main = f32x4_instance.instance.exports.main;

    if (
      typeof i64_main !== "function" || typeof f32_main !== "function" ||
      typeof f64_main !== "function" || typeof f32x4_main !== "function"
    ) {
      throw new Error("gpufuck numeric output does not export main");
    }

    assert_equals(i64_main(), 42n, "i64 numeric output");
    assert_equals(f32_main(), 42, "f32 numeric output");
    assert_equals(f64_main(), 42, "f64 numeric output");
    assert_equals(f32x4_main(), 4, "portable F32x4 output");

    const workload = await compiler.compile_file(
      "experiments/gpufuck/workload/main.duck",
    );
    const instantiated = await WebAssembly.instantiate(workload);
    const main = instantiated.instance.exports.main;

    if (typeof main !== "function") {
      throw new Error("gpufuck modular workload does not export main");
    }

    assert_equals(main(), 381_455_585, "modular workload");
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment evaluates a pure Duck result at compile time", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const result = await compiler.evaluate_comptime(
      "let answer = 40 + 2\nanswer",
    );
    if (!result.ok) {
      throw new Error(
        "gpufuck comptime evaluation failed: " + JSON.stringify(result),
      );
    }
    assert_equals(result.exports.length, 1);
    assert_equals(result.exports[0]?.value, {
      kind: "integer",
      value: 42,
    });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment preserves comptime execution limits", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const result = await compiler.evaluate_comptime(
      "40 + 2",
      { maximumOutputBytes: 1 },
    );
    if (result.ok || result.stage !== "comptime") {
      throw new Error(
        "gpufuck comptime output limit returned an unexpected result: " +
          JSON.stringify(result),
      );
    }
    assert_equals(result.diagnostic.kind, "output-limit");
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment compiles every standalone success example", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    for (const example of success_examples) {
      await compiler.compile_file(example.path);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment executes structured Core, ownership, handlers, and loops", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const cases = [
    ["examples/data/09_union_struct_payload.duck", 42],
    ["examples/ownership_modules/04_freeze_and_share.duck", 42],
    ["examples/handlers/01_local_counter.duck", 42],
    ["examples/loops/06_nested_ranges.duck", 42],
    ["examples/compile_time/13_derived_nested_equality.duck", 42],
  ] as const;

  try {
    for (const [path, expected] of cases) {
      const execution = await compiler.run_file(path);
      assert_equals(execution.value, {
        kind: "integer",
        value: expected,
      }, path);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment executes aggregate effect capabilities", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const written: FunctionalWasmHostValue[] = [];

  try {
    const execution = await compiler.run_file(
      "examples/effects/03_cli_stdin_stdout.duck",
      {
        init: {
          Stdin: {
            $resource: { kind: "resource", id: 1 },
            read_line: () => ({ kind: "text", value: "hello" }),
          },
          Stdout: {
            $resource: { kind: "resource", id: 2 },
            write_line: (value: FunctionalWasmHostValue) => {
              written.push(value);
              return { kind: "unit" };
            },
          },
        },
      },
    );

    assert_equals(written, [{ kind: "text", value: "hello" }]);
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "text", value: "hello" }],
    });
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment emits managed callables as persistent exports", async () => {
  const compiler = await ExperimentalDuckCompiler.create();
  const storage_source = `
let add: (I32, I32) -> I32 = (left, right) => left + right
const sum_to: I32 -> I32 = rec (value: I32) => {
  if value == 0 { 0 } else { value + rec(value - 1) }
}
add(sum_to(6), 21)
`;
  const callable_source = `
module () where

let add: (I32, I32) -> I32 = (left, right) => left + right
const sum_to: I32 -> I32 = rec (value: I32) => {
  if value == 0 { 0 } else { value + rec(value - 1) }
}
return { .add = add, .sum_to = sum_to, .answer = 42 }
`;
  try {
    const storage_plan = await compiler.plan_storage(storage_source);
    assert_equals(
      storage_plan.values.some((value) =>
        value.valueKind === "closure" &&
        value.storage === FunctionalStorageClass.ScalarLocal &&
        value.escapeStorage === FunctionalStorageClass.InvocationArena
      ),
      true,
    );
    assert_equals(
      storage_plan.values.some((value) =>
        value.valueKind === "closure" &&
        value.storage === FunctionalStorageClass.InvocationArena
      ),
      true,
    );
    assert_equals(storage_plan.summary.automaticArenaReset, false);

    const wasm = await compiler.compile(callable_source);
    const instantiated = await WebAssembly.instantiate(wasm);
    const add = instantiated.instance.exports.__duck_abi_call_add;
    const sum_to = instantiated.instance.exports.__duck_abi_call_sum_to;
    if (typeof add !== "function" || typeof sum_to !== "function") {
      throw new Error("gpufuck managed callable exports are missing");
    }

    assert_equals(add(tagged_integer(20), tagged_integer(22)), 42);
    assert_equals(sum_to(tagged_integer(6)), 21);
  } finally {
    compiler.destroy();
  }
});

Deno.test("gpufuck experiment resumes explicitly suspending effects", async () => {
  const source = `
module (!init: Init) where

declare effect Timer {
  suspending wait: (I32) => I32
}
declare Init { timer: Timer }

result <- Timer.wait(41)
return { .result = result + 1 }
`;
  const compiler = await ExperimentalDuckCompiler.create();
  try {
    const execution = await compiler.run_async(source, {
      init: {
        Timer: {
          $resource: { kind: "resource", id: 1 },
          wait: (argument: FunctionalWasmHostValue) =>
            Promise.resolve(argument),
        },
      },
    });
    assert_equals(execution.value, {
      kind: "constructor",
      name: "duck::$DuckStruct:duck_entry_result_type",
      fields: [{ kind: "integer", value: 42 }],
    });

    try {
      await compiler.run(source, {
        init: {
          Timer: {
            $resource: { kind: "resource", id: 1 },
            wait: (argument: FunctionalWasmHostValue) => argument,
          },
        },
      });
      throw new Error("synchronous runner unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      if (!error.message.includes("suspending")) {
        throw error;
      }
    }
  } finally {
    compiler.destroy();
  }
});

function tagged_integer(value: number): bigint {
  return (BigInt(value) << 3n) | 1n;
}

function imported_buffer_runtime(
  module: WebAssembly.Module,
): WebAssembly.ModuleImportDescriptor[] {
  return WebAssembly.Module.imports(module).filter((imported) =>
    imported.name.startsWith("len:") ||
    imported.name.startsWith("get_byte:") ||
    imported.name.startsWith("slice:") ||
    imported.name.startsWith("append:") ||
    imported.name.startsWith("equal:") ||
    imported.name.startsWith("convert:") ||
    imported.name.startsWith("generate:") ||
    imported.name.startsWith("literal:")
  );
}
