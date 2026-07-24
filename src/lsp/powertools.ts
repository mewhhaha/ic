import type { FrontExpr, Source as SourceNode, Stmt } from "../frontend/ast.ts";
import { Source } from "../frontend/source.ts";
import { source_span } from "../frontend/syntax.ts";
import { evaluate_frontend_expression } from "../frontend/lower_graph.ts";
import {
  capped_format_expr,
  type EditorValue,
  eval_editor_value,
} from "./hover.ts";
import type { LspPosition, LspRange, PositionEncoding } from "./position.ts";
import { PositionIndex } from "./position.ts";
import {
  compile_failure_examples,
  type ExampleRoute,
  success_examples,
  trap_examples,
} from "../../examples/manifest.ts";

export type PowertoolsError = {
  ok: false;
  code:
    | "broken_source"
    | "evaluation_failed"
    | "invalid_position"
    | "unsupported_route"
    | "no_comptime_target"
    | "unknown_command";
  message: string;
};

export type PowertoolsSuccess<value> = { ok: true; value: value };

export type PowertoolsResult<value> =
  | PowertoolsSuccess<value>
  | PowertoolsError;

export type ComptimeFact = {
  kind: "capture";
  name: string;
  value: string;
};

export type ComptimeExpansion = {
  source: string;
  facts: ComptimeFact[];
  trace: ComptimeTraceStep[];
};

export type ComptimeTraceStep = {
  kind: "input" | "fact_check" | "capture" | "result";
  detail: string;
};

export type PowertoolsCodeLens = {
  range: LspRange;
  title: string;
  command: "duck.expandComptime" | "duck.runExample";
  arguments: unknown[];
};

export type TerminalInvocation = {
  command: "deno";
  args: string[];
};

export type ExecuteCommandRequest = {
  command: string;
  uri: string;
  text: string;
  position?: LspPosition;
  encoding: PositionEncoding;
};

export type ExecuteCommandResult =
  | PowertoolsResult<ComptimeExpansion>
  | PowertoolsResult<TerminalInvocation>;

export function expand_comptime(
  text: string,
  position: LspPosition,
  encoding: PositionEncoding,
): PowertoolsResult<ComptimeExpansion> {
  const parsed = Source.parse_with_diagnostics(text);

  if (parsed.diagnostics.length > 0) {
    return broken_source(parsed.diagnostics[0]?.message);
  }

  let offset: number;

  try {
    offset = new PositionIndex(text, encoding).offset_from_position(position);
  } catch (error) {
    return {
      ok: false,
      code: "invalid_position",
      message: error_message(error),
    };
  }

  const target = comptime_target(parsed.source, offset);

  if (target === undefined) {
    return {
      ok: false,
      code: "no_comptime_target",
      message: "No comptime expression or const call at this position",
    };
  }

  try {
    evaluate_frontend_expression(
      target.preceding_statements,
      target.expr,
    );
  } catch (error) {
    return {
      ok: false,
      code: "evaluation_failed",
      message: error_message(error),
    };
  }

  const editor_value = eval_editor_value(target.expr, target.env, 0);
  const facts = capture_facts(editor_value);
  let source = capped_format_expr(editor_value.expr);
  const trace: ComptimeTraceStep[] = [{
    kind: "input",
    detail: capped_format_expr(target.expr),
  }];

  trace.push(...fact_check_trace(
    target.expr,
    target.preceding_statements,
  ));

  if (facts.length > 0) {
    source += "\n// captured " +
      facts.map((fact) => fact.name + " = " + fact.value).join(", ");

    for (const fact of facts) {
      trace.push({
        kind: "capture",
        detail: fact.name + " = " + fact.value,
      });
    }
  }

  trace.push({
    kind: "result",
    detail: capped_format_expr(editor_value.expr),
  });
  return { ok: true, value: { source, facts, trace } };
}

export function powertools_code_lenses(
  uri: string,
  text: string,
  encoding: PositionEncoding,
): PowertoolsCodeLens[] {
  const parsed = Source.parse_with_diagnostics(text);

  if (parsed.diagnostics.length > 0) {
    return [];
  }

  const positions = new PositionIndex(text, encoding);
  const lenses: PowertoolsCodeLens[] = [];

  for_each_expr(parsed.source, (expr) => {
    if (expr.tag !== "comptime") {
      return;
    }

    const span = source_span(expr);
    lenses.push({
      range: range_at(positions, span.start, span.end),
      title: "▸ expand",
      command: "duck.expandComptime",
      arguments: [uri, positions.position_from_offset(span.start)],
    });
  });

  const example = example_for_uri(uri);

  if (example !== undefined) {
    lenses.push({
      range: range_at(positions, 0, 0),
      title: "▸ run example",
      command: "duck.runExample",
      arguments: [uri],
    });
  }

  return lenses;
}

export function route_execute_command(
  request: ExecuteCommandRequest,
): ExecuteCommandResult {
  if (request.command === "duck.expandComptime") {
    if (request.position === undefined) {
      return {
        ok: false,
        code: "no_comptime_target",
        message: "duck.expandComptime requires a position",
      };
    }

    return expand_comptime(request.text, request.position, request.encoding);
  }

  if (request.command === "duck.runExample") {
    const example = example_for_uri(request.uri);

    if (example === undefined) {
      return {
        ok: false,
        code: "unsupported_route",
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

function broken_source(message: string | undefined): PowertoolsError {
  let detail = "Source could not be parsed";

  if (message !== undefined) {
    detail += ": " + message;
  }

  return { ok: false, code: "broken_source", message: detail };
}

export function route_for_uri(uri: string): ExampleRoute {
  const example = example_for_uri(uri);

  if (example !== undefined) {
    return example.route;
  }

  const path = path_for_uri(uri);

  for (const failure of compile_failure_examples) {
    if (path === failure.path || path.endsWith("/" + failure.path)) {
      return failure.route;
    }
  }

  for (const trap of trap_examples) {
    if (path === trap.path || path.endsWith("/" + trap.path)) {
      return trap.route;
    }
  }

  return "ic";
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

function comptime_target(
  source: SourceNode,
  offset: number,
): {
  expr: FrontExpr;
  env: Map<string, EditorValue>;
  preceding_statements: Stmt[];
} | undefined {
  const env = new Map<string, EditorValue>();

  for (let index = 0; index < source.statements.length; index += 1) {
    const statement = source.statements[index];

    if (statement === undefined) {
      throw new Error("Missing comptime source statement");
    }

    const match = comptime_target_in_statement(
      statement,
      offset,
      env,
      source.statements.slice(0, index),
    );

    if (match !== undefined) {
      return match;
    }

    if (statement.tag === "bind" || statement.tag === "assign") {
      env.set(statement.name, eval_editor_value(statement.value, env, 0));
    }
  }

  return undefined;
}

function comptime_target_in_statement(
  statement: Stmt,
  offset: number,
  env: Map<string, EditorValue>,
  preceding_statements: Stmt[],
): {
  expr: FrontExpr;
  env: Map<string, EditorValue>;
  preceding_statements: Stmt[];
} | undefined {
  let result: {
    expr: FrontExpr;
    env: Map<string, EditorValue>;
    preceding_statements: Stmt[];
  } | undefined;

  for_each_expr_in_statement(statement, (expr) => {
    if (result !== undefined || !contains_offset(expr, offset)) {
      return;
    }

    if (expr.tag === "comptime") {
      result = {
        expr: expr.expr,
        env: new Map(env),
        preceding_statements,
      };
      return;
    }

    if (expr.tag === "app" && has_const_parameter(expr, env)) {
      result = { expr, env: new Map(env), preceding_statements };
    }
  });

  return result;
}

function has_const_parameter(
  expr: Extract<FrontExpr, { tag: "app" }>,
  env: Map<string, EditorValue>,
): boolean {
  const value = eval_editor_value(expr.func, env, 0).expr;

  if (value.tag !== "lam" && value.tag !== "rec") {
    return false;
  }

  return value.params.some((param) => param.is_const);
}

function fact_check_trace(
  expr: FrontExpr,
  preceding_statements: Stmt[],
): ComptimeTraceStep[] {
  if (expr.tag !== "app" || expr.func.tag !== "var") {
    return [];
  }

  let target: Extract<FrontExpr, { tag: "lam" | "rec" }> | undefined;

  for (const statement of preceding_statements) {
    if (
      statement.tag === "bind" && statement.name === expr.func.name &&
      (statement.value.tag === "lam" || statement.value.tag === "rec")
    ) {
      target = statement.value;
    }
  }

  if (target === undefined) {
    return [];
  }

  const trace: ComptimeTraceStep[] = [];

  for (let index = 0; index < target.params.length; index += 1) {
    const param = target.params[index];
    const arg = expr.args[index];

    if (
      param === undefined || arg === undefined ||
      param.annotation === undefined
    ) {
      continue;
    }

    trace.push({
      kind: "fact_check",
      detail: param.annotation + "(" + capped_format_expr(arg) + ") passed",
    });
  }

  return trace;
}

function capture_facts(value: EditorValue): ComptimeFact[] {
  const facts: ComptimeFact[] = [];

  if (value.captures === undefined) {
    return facts;
  }

  for (const [name, capture] of value.captures) {
    facts.push({
      kind: "capture",
      name,
      value: capped_format_expr(capture.expr),
    });
  }

  return facts;
}

function contains_offset(expr: FrontExpr, offset: number): boolean {
  const span = source_span(expr);
  return offset >= span.start && offset <= span.end;
}

function range_at(
  positions: PositionIndex,
  start: number,
  end: number,
): LspRange {
  return {
    start: positions.position_from_offset(start),
    end: positions.position_from_offset(end),
  };
}

function for_each_expr(
  source: SourceNode,
  visit: (expr: FrontExpr) => void,
): void {
  for (const statement of source.statements) {
    for_each_expr_in_statement(statement, visit);
  }
}

function for_each_expr_in_statement(
  statement: Stmt,
  visit: (expr: FrontExpr) => void,
): void {
  switch (statement.tag) {
    case "bind":
    case "state_bind":
    case "bind_pattern":
    case "resume_dup":
    case "assign":
    case "return":
      for_each_expr_in_expr(statement.value, visit);
      return;

    case "index_assign":
      for_each_expr_in_expr(statement.index, visit);
      for_each_expr_in_expr(statement.value, visit);
      return;

    case "for_range":
      for_each_expr_in_expr(statement.start, visit);
      for_each_expr_in_expr(statement.end, visit);
      for_each_expr_in_expr(statement.step, visit);
      for_each_statements(statement.body, visit);
      return;

    case "for_collection":
      for_each_expr_in_expr(statement.collection, visit);
      for_each_statements(statement.body, visit);
      return;

    case "if_stmt":
      for_each_expr_in_expr(statement.cond, visit);
      for_each_statements(statement.body, visit);
      return;

    case "if_let_stmt":
      for_each_expr_in_expr(statement.target, visit);
      for_each_statements(statement.body, visit);
      return;

    case "type_check":
      for_each_expr_in_expr(statement.target, visit);
      return;

    case "break":
      if (statement.value !== undefined) {
        for_each_expr_in_expr(statement.value, visit);
      }
      return;

    case "expr":
      for_each_expr_in_expr(statement.expr, visit);
      return;

    case "import":
    case "host_import":
    case "continue":
    case "unsupported":
      return;
  }
}

function for_each_statements(
  statements: Stmt[],
  visit: (expr: FrontExpr) => void,
): void {
  for (const statement of statements) {
    for_each_expr_in_statement(statement, visit);
  }
}

function for_each_expr_in_expr(
  expr: FrontExpr,
  visit: (expr: FrontExpr) => void,
): void {
  visit(expr);

  switch (expr.tag) {
    case "prim":
      for_each_expr_in_expr(expr.left, visit);
      for_each_expr_in_expr(expr.right, visit);
      return;

    case "lam":
    case "rec":
      for_each_expr_in_expr(expr.body, visit);
      return;

    case "app":
      for_each_expr_in_expr(expr.func, visit);
      for (const arg of expr.args) {
        for_each_expr_in_expr(arg, visit);
      }
      return;

    case "block":
      for_each_statements(expr.statements, visit);
      return;

    case "comptime":
    case "captured":
      for_each_expr_in_expr(expr.expr, visit);
      return;

    case "borrow":
    case "freeze":
    case "is":
      for_each_expr_in_expr(expr.value, visit);
      return;

    case "scratch":
      for_each_expr_in_expr(expr.body, visit);
      return;

    case "loop":
      for_each_statements(expr.body, visit);
      return;

    case "handler":
      for (const state of expr.state) {
        for_each_expr_in_expr(state.value, visit);
      }
      for (const clause of expr.clauses) {
        for_each_expr_in_expr(clause.body, visit);
      }
      for_each_expr_in_expr(expr.return_clause.body, visit);
      return;

    case "try_with":
      for_each_expr_in_expr(expr.body, visit);
      for_each_expr_in_expr(expr.handler, visit);
      return;

    case "with":
    case "struct_update":
      for_each_expr_in_expr(expr.base, visit);
      for (const field of expr.fields) {
        for_each_expr_in_expr(field.value, visit);
      }
      return;

    case "struct_value":
      for_each_expr_in_expr(expr.type_expr, visit);
      for (const field of expr.fields) {
        for_each_expr_in_expr(field.value, visit);
      }
      return;

    case "if":
      for_each_expr_in_expr(expr.cond, visit);
      for_each_expr_in_expr(expr.then_branch, visit);
      for_each_expr_in_expr(expr.else_branch, visit);
      return;

    case "if_let":
      for_each_expr_in_expr(expr.target, visit);
      for_each_expr_in_expr(expr.then_branch, visit);
      for_each_expr_in_expr(expr.else_branch, visit);
      return;

    case "field":
      for_each_expr_in_expr(expr.object, visit);
      return;

    case "index":
      for_each_expr_in_expr(expr.object, visit);
      for_each_expr_in_expr(expr.index, visit);
      return;

    case "union_case":
      if (expr.value !== undefined) {
        for_each_expr_in_expr(expr.value, visit);
      }
      if (expr.type_expr !== undefined) {
        for_each_expr_in_expr(expr.type_expr, visit);
      }
      return;

    case "bool":
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "type_name":
    case "var":
    case "set_type":
    case "struct_type":
    case "union_type":
    case "linear":
    case "unsupported":
      return;
  }
}

function error_message(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
