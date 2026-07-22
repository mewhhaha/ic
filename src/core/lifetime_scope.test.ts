import { assert_equals, assert_throws } from "../assert.ts";
import type { Core, CoreExpr, CoreStmt } from "./ast.ts";
import {
  core_lifetime_plan,
  core_lifetime_scope_for_subject,
  core_require_lifetime_scope_for_subject,
} from "./lifetime_scope.ts";
import { substitute_core_call_expr } from "./substitute.ts";

Deno.test("Core lifetime scopes retain allocation-subject provenance through nested scopes", () => {
  const inner_body: CoreExpr = { tag: "text", value: "inner" };
  const inner_lambda: CoreExpr = {
    tag: "lam",
    params: [],
    body: inner_body,
  };
  const outer_lambda: CoreExpr = {
    tag: "lam",
    params: [],
    body: inner_lambda,
  };
  const call_function: CoreExpr = { tag: "var", name: "f" };
  const call_argument: CoreExpr = { tag: "text", value: "argument" };
  const call: CoreExpr = {
    tag: "app",
    func: call_function,
    args: [call_argument],
  };
  const block_statement: CoreStmt = {
    tag: "expr",
    expr: { tag: "text", value: "block" },
  };
  const block: CoreExpr = { tag: "block", statements: [block_statement] };
  const scratch_body: CoreExpr = { tag: "text", value: "scratch" };
  const scratch: CoreExpr = { tag: "scratch", body: scratch_body };
  const then_statement: CoreStmt = {
    tag: "expr",
    expr: { tag: "text", value: "then" },
  };
  const else_statement: CoreStmt = {
    tag: "expr",
    expr: { tag: "text", value: "else" },
  };
  const branches: CoreStmt = {
    tag: "if_else_stmt",
    cond: { tag: "num", type: "i32", value: 1 },
    then_body: [then_statement],
    else_body: [else_statement],
  };
  const loop_body: CoreStmt = {
    tag: "expr",
    expr: { tag: "text", value: "iteration" },
  };
  const loop: CoreStmt = {
    tag: "range_loop",
    index: "index",
    start: { tag: "num", type: "i32", value: 0 },
    end: { tag: "num", type: "i32", value: 1 },
    end_bound: "exclusive",
    step: { tag: "num", type: "i32", value: 1 },
    carried: [],
    body: [loop_body],
  };
  const core: Core = {
    tag: "program",
    statements: [
      { tag: "expr", expr: outer_lambda },
      { tag: "expr", expr: call },
      { tag: "expr", expr: block },
      { tag: "expr", expr: scratch },
      branches,
      loop,
    ],
  };

  const plan = core_lifetime_plan(core);

  assert_equals(scope_id(plan, outer_lambda), "program#0");
  assert_equals(scope_id(plan, outer_lambda.body), "closure#0");
  assert_equals(scope_id(plan, inner_body), "closure#1");
  assert_equals(scope_id(plan, call), "function_call#0");
  assert_equals(scope_id(plan, call_function), "function_call#0");
  assert_equals(scope_id(plan, call_argument), "function_call#0");
  assert_equals(scope_id(plan, block_statement), "block#0");
  assert_equals(scope_id(plan, scratch_body), "scratch#0");
  assert_equals(scope_id(plan, then_statement), "block#1");
  assert_equals(scope_id(plan, else_statement), "block#2");
  assert_equals(scope_id(plan, loop), "loop#0");
  assert_equals(scope_id(plan, loop_body), "loop#0");
});

Deno.test("Core lifetime provenance resolves subjects instead of independent allocation scope numbers", () => {
  const block_value: CoreExpr = { tag: "text", value: "value" };
  const allocation_subject: CoreExpr = {
    tag: "block",
    statements: [{ tag: "expr", expr: block_value }],
  };
  const plan = core_lifetime_plan({
    tag: "program",
    statements: [{ tag: "expr", expr: allocation_subject }],
  });

  assert_equals(scope_id(plan, block_value), "block#0");
  assert_equals(scope_id(plan, allocation_subject), "program#0");
  assert_equals(plan.scopes.some((scope) => scope.id === "block#5"), false);
});

Deno.test("Core lifetime provenance rejects an unknown subject without defaulting", () => {
  const plan = core_lifetime_plan({ tag: "program", statements: [] });
  const unknown: CoreExpr = { tag: "text", value: "unknown" };

  assert_equals(core_lifetime_scope_for_subject(plan, unknown), undefined);
  assert_throws(
    () => core_require_lifetime_scope_for_subject(plan, unknown),
    "Missing lifetime scope provenance",
  );
});

Deno.test("Core lifetime provenance resolves substituted expressions to their source scopes", () => {
  const source_value: CoreExpr = {
    tag: "prim",
    prim: "i32.add",
    args: [
      { tag: "num", type: "i32", value: 1 },
      { tag: "num", type: "i32", value: 2 },
    ],
  };
  const source: CoreExpr = {
    tag: "block",
    statements: [{ tag: "expr", expr: source_value }],
  };
  const plan = core_lifetime_plan({
    tag: "program",
    statements: [{ tag: "expr", expr: source }],
  });
  const derived = substitute_core_call_expr(source, new Map());

  assert_equals(derived === source, false);
  if (derived.tag !== "block") {
    throw new Error("Expected substituted block expression");
  }
  const derived_stmt = derived.statements[0];
  if (!derived_stmt || derived_stmt.tag !== "expr") {
    throw new Error("Missing substituted block expression");
  }

  assert_equals(scope_id(plan, derived), "program#0");
  assert_equals(scope_id(plan, derived_stmt.expr), "block#0");
});

function scope_id(
  plan: ReturnType<typeof core_lifetime_plan>,
  subject: CoreExpr | CoreStmt,
): string {
  return core_require_lifetime_scope_for_subject(plan, subject).id;
}
