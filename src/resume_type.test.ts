import { assert_equals, assert_includes, assert_throws } from "./assert.ts";
import { build_abi_manifest } from "./abi.ts";
import { Core } from "./core.ts";
import type { CoreExpr } from "./core/ast.ts";
import { runtime_aggregate_layout_for_type } from "./core/runtime_aggregate.ts";
import {
  plan_static_value_expr,
  type StaticValueCtx,
  type StaticValueHooks,
} from "./core/static_values.ts";
import { substitute_core_type_expr } from "./core/type_static/substitute.ts";
import { runtime_union_type_size } from "./core/runtime_union/size.ts";
import { runtime_union_payload } from "./core/runtime_union_payload.ts";
import {
  core_val_type_from_type_name,
  is_core_builtin_type_name,
} from "./core/type_static.ts";
import { Source } from "./frontend.ts";
import {
  front_type_from_type_name,
  is_builtin_type_name,
  val_type_from_type_name,
} from "./frontend/types.ts";

Deno.test("Resume uses an internal wasm32 pointer representation", () => {
  assert_equals(is_builtin_type_name("Resume"), true);
  assert_equals(front_type_from_type_name("Resume"), {
    tag: "int",
    type: "i32",
  });
  assert_equals(val_type_from_type_name("Resume"), "i32");
  assert_equals(is_core_builtin_type_name("Resume"), true);
  assert_equals(core_val_type_from_type_name("Resume"), "i32");

  const box_type: CoreExpr = {
    tag: "struct_type",
    fields: [{ name: "resume", type_name: "Resume" }],
  };
  const ctx = {
    statics: new Map<string, CoreExpr>([["resume_box_type", box_type]]),
  };
  const layout = runtime_aggregate_layout_for_type(
    { tag: "var", name: "resume_box_type" },
    ctx,
  );

  assert_equals(layout.size, 4);
  assert_equals(layout.align, 4);
  assert_equals(layout.fields, [{
    tag: "value",
    name: "resume",
    offset: 0,
    type: "i32",
    text: false,
    resume: true,
    union_type_expr: undefined,
  }]);
  assert_equals(runtime_union_payload("Resume", ctx), {
    tag: "value",
    type: "i32",
    text: false,
    resume: true,
  });
  assert_equals(
    runtime_union_type_size({
      tag: "union_type",
      cases: [
        { name: "more", type_name: "Resume" },
        { name: "done", type_name: "Unit" },
      ],
    }, ctx),
    8,
  );
});

Deno.test("runtime aggregates and unions store Resume closure pointers", () => {
  const aggregate_wat = Source.wat(`
const { struct } = import "duck:prelude" ()
const resume_box_type = struct { .resume= Resume }
[.resume = (value: I32) => value + 1] as resume_box_type
`);
  assert_includes(aggregate_wat, "(type $closure_i32_i32_to_i32");
  assert_includes(aggregate_wat, "i32.store offset=0");

  const union_wat = Source.wat(`
type Suspended = | \`More Resume | \`Done I32
const suspended = Suspended
\`More ((value: I32) => value + 1)
`);
  assert_includes(union_wat, "(type $closure_i32_i32_to_i32");
  assert_includes(union_wat, "i32.store offset=4");
});

Deno.test("Core rewrites preserve Resume payload ownership metadata", () => {
  const resume_case: Extract<CoreExpr, { tag: "union_case" }> = {
    tag: "union_case",
    name: "suspended",
    value: {
      tag: "lam",
      params: [{
        name: "value",
        is_const: false,
        is_linear: false,
        annotation: "I32",
      }],
      body: { tag: "var", name: "value" },
    },
    type_expr: { tag: "var", name: "suspended_type" },
    resume_payload: true,
  };
  const substituted = substitute_core_type_expr(resume_case, new Map());
  if (substituted.tag !== "union_case") {
    throw new Error("Core type substitution changed a union case tag");
  }
  assert_equals(substituted.resume_payload, true);

  const ctx: StaticValueCtx = {
    locals: new Map(),
    statics: new Map(),
    fn_types: new Map(),
    text_locals: new Set(),
    struct_locals: new Map(),
    union_locals: new Map(),
    frozen_locals: new Set(),
    next_temp: 0,
  };
  const queued_case: Extract<CoreExpr, { tag: "union_case" }> = {
    ...resume_case,
    name: "queued",
  };
  const dynamic_resume: Extract<CoreExpr, { tag: "if" }> = {
    tag: "if",
    cond: { tag: "num", type: "i32", value: 1 },
    then_branch: resume_case,
    else_branch: queued_case,
  };
  const hooks: StaticValueHooks<StaticValueCtx, StaticValueCtx> = {
    closure_fn_type() {
      return undefined;
    },
    collect_expr_locals() {},
    collect_stmt_locals() {},
    core_expr_is_text() {
      return false;
    },
    dynamic_union_if(expr) {
      if (expr === dynamic_resume) {
        return {
          cond: dynamic_resume.cond,
          then_case: resume_case,
          else_case: queued_case,
        };
      }
      return undefined;
    },
    emit_expr() {
      return "";
    },
    emit_stmt() {
      return "";
    },
    expr_type() {
      return "i32";
    },
    is_stable_static_expr(expr) {
      return expr.tag !== "lam";
    },
    runtime_aggregate_type_expr() {
      return undefined;
    },
    runtime_union_type_expr() {
      return undefined;
    },
    static_core_call_value() {
      return undefined;
    },
    static_struct_if_branches() {
      return undefined;
    },
    static_struct_update_value() {
      return undefined;
    },
    static_struct_value() {
      return undefined;
    },
    static_text_if_branches() {
      return undefined;
    },
    static_text_value() {
      return undefined;
    },
    static_union_case(expr) {
      if (expr.tag === "union_case") {
        return expr;
      }
      return undefined;
    },
  };
  const planned = plan_static_value_expr(resume_case, ctx, undefined, hooks);
  if (planned.value.tag !== "union_case") {
    throw new Error("Core static planning changed a union case tag");
  }
  assert_equals(planned.value.resume_payload, true);

  const planned_dynamic = plan_static_value_expr(
    dynamic_resume,
    ctx,
    undefined,
    hooks,
  );
  if (planned_dynamic.value.tag !== "if") {
    throw new Error("Core static planning changed a dynamic union tag");
  }
  if (
    planned_dynamic.value.then_branch.tag !== "union_case" ||
    planned_dynamic.value.else_branch.tag !== "union_case"
  ) {
    throw new Error("Core static planning changed dynamic union case tags");
  }
  assert_equals(planned_dynamic.value.then_branch.resume_payload, true);
  assert_equals(planned_dynamic.value.else_branch.resume_payload, true);
});

Deno.test("runtime union construction moves a named Resume owner", () => {
  const resume: CoreExpr = {
    tag: "lam",
    params: [{
      name: "value",
      is_const: false,
      is_linear: false,
      annotation: "I32",
    }],
    body: { tag: "var", name: "value" },
  };
  const core: Core = {
    tag: "program",
    statements: [
      {
        tag: "bind",
        kind: "const",
        name: "suspended_type",
        is_linear: false,
        annotation: undefined,
        value: {
          tag: "union_type",
          cases: [
            { name: "suspended", type_name: "Resume" },
            { name: "done", type_name: "I32" },
          ],
        },
      },
      {
        tag: "bind",
        kind: "let",
        name: "resume",
        is_linear: true,
        annotation: "Resume",
        value: resume,
      },
      {
        tag: "bind",
        kind: "let",
        name: "suspended",
        is_linear: true,
        annotation: "suspended_type",
        value: {
          tag: "union_case",
          name: "suspended",
          value: {
            tag: "linear",
            name: "resume",
            resume_signature: { input_type: "I32", output_type: "I32" },
          },
          type_expr: { tag: "var", name: "suspended_type" },
          resume_payload: true,
        },
      },
      { tag: "expr", expr: { tag: "num", type: "i32", value: 0 } },
    ],
  };
  const proof = Core.proof(core);

  assert_equals(proof.issues, []);
  assert_equals(
    proof.drops.steps.map((step) => ({
      owner: step.owner,
      reason: step.ownership.reason,
      owned_children: step.owned_children,
    })),
    [{
      owner: "suspended",
      reason: "runtime_union",
      owned_children: [{
        allocation_ids: ["allocation#1"],
        offset: 4,
        ownership: { tag: "unique_heap", reason: "closure" },
        layout: "closure_env.table_index_and_capture_slots",
      }],
    }],
  );
  assert_equals(
    proof.transfers.transfers.map((transfer) => ({
      owner: transfer.owner,
      callee: transfer.callee,
    })),
    [{ owner: "resume", callee: "union_case.suspended" }],
  );
});

Deno.test("managed ABI rejects Resume directly and through aliases", () => {
  assert_throws(
    () =>
      build_abi_manifest(Source.parse(`
declare effect Io { suspend: () => Resume }
0
`)),
    "Managed ABI cannot expose Resume values",
  );

  assert_throws(
    () =>
      build_abi_manifest(Source.parse(`
const resume_alias = Resume
const duck_entry_result_type = resume_alias
0
`)),
    "Managed ABI cannot expose Resume values",
  );
});
