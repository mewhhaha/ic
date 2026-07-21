import { expect } from "../../expect.ts";
import type { ResumeSignature } from "../../type_syntax.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "../ast.ts";
import { clone_core_host_imports } from "../host_import.ts";
import { bind_core_if_let_payload_fact } from "../if_let_payload.ts";
import { runtime_aggregate_type_expr } from "../runtime_aggregate.ts";
import { dynamic_if_let_can_match } from "../union_static.ts";
import { check_closure_call_args } from "./args.ts";
import { same_core_fn_type } from "./compare.ts";
import { core_lam_fn_type, core_lam_fn_type_with_expected } from "./lambda.ts";
import { closure_param_info } from "./param.ts";
import type {
  CoreClosureTypeBlockCtx,
  CoreClosureTypeCtx,
  CoreClosureTypeHooks,
} from "./types.ts";

export function closure_fn_type(
  expr: CoreExpr,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): CoreFnType | undefined {
  switch (expr.tag) {
    case "lam":
      return core_lam_fn_type(expr, ctx, hooks);

    case "var": {
      if (expr.resume_signature) {
        return resume_signature_fn_type(expr.resume_signature, ctx, hooks);
      }

      const local_type = ctx.fn_types.get(expr.name);

      if (local_type) {
        return local_type;
      }

      const static_value = ctx.statics.get(expr.name);

      if (!static_value) {
        return undefined;
      }

      return closure_fn_type(static_value, ctx, hooks);
    }

    case "block": {
      const block = closure_block_ctx(expr, ctx, hooks);
      if (!block) {
        return undefined;
      }

      return stmt_closure_fn_type(block.final_stmt, block.ctx, hooks);
    }

    case "loop":
      return undefined;

    case "if": {
      const cond_type = hooks.expr_type(expr.cond, ctx);
      expect(cond_type === "i32", "Core closure if condition must be i32");
      let then_type = closure_fn_type(expr.then_branch, ctx, hooks);
      let else_type = closure_fn_type(expr.else_branch, ctx, hooks);

      if (!then_type && !else_type) {
        return undefined;
      }

      if (then_type && !else_type) {
        else_type = closure_fn_type_with_expected(
          expr.else_branch,
          then_type,
          ctx,
          hooks,
        );
      }

      if (!then_type && else_type) {
        then_type = closure_fn_type_with_expected(
          expr.then_branch,
          else_type,
          ctx,
          hooks,
        );
      }

      expect(
        then_type && else_type,
        "Core closure if branches must both be closures",
      );
      expect(
        same_core_fn_type(then_type, else_type),
        "Core closure if branch type mismatch",
      );
      return then_type;
    }

    case "if_let":
      return if_let_closure_fn_type(expr, ctx, hooks);

    case "app": {
      const target = hooks.static_core_call_target(expr.func, ctx);

      if (target) {
        const fn_type = hooks.scoped_static_core_call_fn_type(
          expr,
          target,
          ctx,
        );

        if (fn_type) {
          return fn_type;
        }
      }

      const inlined = hooks.static_core_call_value(expr, ctx);

      if (!inlined) {
        return undefined;
      }

      return closure_fn_type(inlined, ctx, hooks);
    }

    case "linear":
      if (expr.resume_signature) {
        return resume_signature_fn_type(expr.resume_signature, ctx, hooks);
      }

      return undefined;

    case "field":
      if (expr.resume_signature) {
        return resume_signature_fn_type(expr.resume_signature, ctx, hooks);
      }

      return undefined;

    case "num":
    case "text":
    case "type_name":
    case "prim":
    case "rec":
    case "comptime":
    case "with":
    case "struct_type":
    case "struct_value":
    case "struct_update":
    case "union_type":
    case "index":
    case "union_case":
    case "unsupported":
      return undefined;

    case "scratch":
      if (scratch_body_is_freeze(expr.body)) {
        return closure_fn_type(expr.body, ctx, hooks);
      }

      return undefined;

    case "borrow":
    case "freeze":
      return closure_fn_type(expr.value, ctx, hooks);
  }
}

export function closure_fn_type_with_expected(
  expr: CoreExpr,
  expected: CoreFnType,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): CoreFnType | undefined {
  switch (expr.tag) {
    case "lam":
      return core_lam_fn_type_with_expected(expr, expected, ctx, hooks);

    case "var": {
      if (expr.resume_signature) {
        const actual = resume_signature_fn_type(
          expr.resume_signature,
          ctx,
          hooks,
        );
        expect(
          same_core_fn_type(actual, expected),
          "Core closure if branch type mismatch",
        );
        return actual;
      }

      const local_type = ctx.fn_types.get(expr.name);

      if (local_type) {
        expect(
          same_core_fn_type(local_type, expected),
          "Core closure if branch type mismatch",
        );
        return local_type;
      }

      const static_value = ctx.statics.get(expr.name);

      if (!static_value) {
        return undefined;
      }

      return closure_fn_type_with_expected(static_value, expected, ctx, hooks);
    }

    case "block": {
      const block = closure_block_ctx(expr, ctx, hooks);
      if (!block) {
        return undefined;
      }

      return stmt_closure_fn_type_with_expected(
        block.final_stmt,
        expected,
        block.ctx,
        hooks,
      );
    }

    case "loop":
      return undefined;

    case "if": {
      const cond_type = hooks.expr_type(expr.cond, ctx);
      expect(cond_type === "i32", "Core closure if condition must be i32");
      const then_type = closure_fn_type_with_expected(
        expr.then_branch,
        expected,
        ctx,
        hooks,
      );
      const else_type = closure_fn_type_with_expected(
        expr.else_branch,
        expected,
        ctx,
        hooks,
      );

      if (!then_type && !else_type) {
        return undefined;
      }

      expect(
        then_type && else_type,
        "Core closure if branches must both be closures",
      );
      expect(
        same_core_fn_type(then_type, else_type),
        "Core closure if branch type mismatch",
      );
      return then_type;
    }

    case "if_let":
      return if_let_closure_fn_type_with_expected(
        expr,
        expected,
        ctx,
        hooks,
      );

    case "app": {
      const target = hooks.static_core_call_target(expr.func, ctx);

      if (target) {
        const fn_type = hooks.scoped_static_core_call_fn_type(
          expr,
          target,
          ctx,
        );

        if (fn_type) {
          expect(
            same_core_fn_type(fn_type, expected),
            "Core closure if branch type mismatch",
          );
          return fn_type;
        }
      }

      const inlined = hooks.static_core_call_value(expr, ctx);

      if (!inlined) {
        return undefined;
      }

      return closure_fn_type_with_expected(inlined, expected, ctx, hooks);
    }

    case "linear":
      if (expr.resume_signature) {
        const actual = resume_signature_fn_type(
          expr.resume_signature,
          ctx,
          hooks,
        );
        expect(
          same_core_fn_type(actual, expected),
          "Core closure if branch type mismatch",
        );
        return actual;
      }

      return undefined;

    case "field":
      if (expr.resume_signature) {
        const actual = resume_signature_fn_type(
          expr.resume_signature,
          ctx,
          hooks,
        );
        expect(
          same_core_fn_type(actual, expected),
          "Core closure if branch type mismatch",
        );
        return actual;
      }

      return undefined;

    case "num":
    case "text":
    case "type_name":
    case "prim":
    case "rec":
    case "comptime":
    case "with":
    case "struct_type":
    case "struct_value":
    case "struct_update":
    case "union_type":
    case "index":
    case "union_case":
    case "unsupported":
      return undefined;

    case "scratch":
      if (scratch_body_is_freeze(expr.body)) {
        return closure_fn_type_with_expected(
          expr.body,
          expected,
          ctx,
          hooks,
        );
      }

      return undefined;

    case "borrow":
    case "freeze":
      return closure_fn_type_with_expected(expr.value, expected, ctx, hooks);
  }
}

function resume_signature_fn_type(
  signature: ResumeSignature,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): CoreFnType {
  const input = closure_param_info(
    {
      name: "__duck_resume_input",
      is_const: false,
      is_linear: false,
      annotation: signature.input_type,
    },
    ctx,
    hooks,
  );
  expect(
    input,
    "Missing resumption input type: " + signature.input_type,
  );
  const output = closure_param_info(
    {
      name: "__duck_resume_output",
      is_const: false,
      is_linear: false,
      annotation: signature.output_type,
    },
    ctx,
    hooks,
  );
  expect(
    output,
    "Missing resumption output type: " + signature.output_type,
  );
  const fn_type: CoreFnType = {
    tag: "fn",
    params: [input.type],
    param_texts: [input.is_text],
    param_structs: [input.struct_type],
    param_unions: [input.union_type],
    result: output.type,
    result_text: output.is_text,
    result_struct: output.struct_type,
    result_union: output.union_type,
  };

  if (input.constraint) {
    fn_type.param_constraints = [input.constraint];
  }

  return fn_type;
}

function scratch_body_is_freeze(expr: CoreExpr): boolean {
  if (expr.tag === "freeze") {
    return true;
  }

  if (expr.tag === "if" && !expr.implicit_else) {
    return scratch_body_is_freeze(expr.then_branch) &&
      scratch_body_is_freeze(expr.else_branch);
  }

  if (expr.tag === "if_let" && !expr.implicit_else) {
    return scratch_body_is_freeze(expr.then_branch) &&
      scratch_body_is_freeze(expr.else_branch);
  }

  if (expr.tag !== "block") {
    return false;
  }

  const final_stmt = expr.statements[expr.statements.length - 1];
  expect(final_stmt, "Core scratch closure block has no result statement");

  if (final_stmt.tag === "expr") {
    return scratch_body_is_freeze(final_stmt.expr);
  }

  if (final_stmt.tag === "return") {
    return scratch_body_is_freeze(final_stmt.value);
  }

  return false;
}

function if_let_closure_fn_type(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): CoreFnType | undefined {
  const union_case = hooks.static_union_case(expr.target, ctx);

  if (union_case) {
    if (union_case.name !== expr.case_name) {
      if (expr.implicit_else) {
        return undefined;
      }

      return closure_fn_type(expr.else_branch, ctx, hooks);
    }

    if (expr.implicit_else) {
      return undefined;
    }

    const branch_ctx = static_if_let_closure_branch_ctx(
      expr,
      union_case,
      ctx,
      hooks,
    );
    return pair_closure_fn_type(
      expr.then_branch,
      branch_ctx,
      expr.else_branch,
      ctx,
      hooks,
    );
  }

  const dynamic_target = hooks.dynamic_union_if(expr.target, ctx);

  if (dynamic_target) {
    const cond_type = hooks.expr_type(dynamic_target.cond, ctx);
    expect(
      cond_type === "i32",
      "Core closure if let condition must be i32",
    );

    if (!dynamic_if_let_can_match(expr.case_name, dynamic_target)) {
      if (expr.implicit_else) {
        return undefined;
      }

      return closure_fn_type(expr.else_branch, ctx, hooks);
    }

    return pair_closure_fn_type(
      dynamic_if_let_case_closure_expr(expr, dynamic_target.then_case),
      dynamic_if_let_case_closure_ctx(
        expr,
        dynamic_target.then_case,
        ctx,
        hooks,
      ),
      dynamic_if_let_case_closure_expr(expr, dynamic_target.else_case),
      dynamic_if_let_case_closure_ctx(
        expr,
        dynamic_target.else_case,
        ctx,
        hooks,
      ),
      hooks,
    );
  }

  const runtime_target = hooks.runtime_union_target(expr.target, ctx);

  if (!runtime_target) {
    return undefined;
  }

  if (expr.implicit_else) {
    return undefined;
  }

  const info = hooks.runtime_union_match_info(
    expr.case_name,
    runtime_target,
    ctx,
  );
  const branch_ctx = hooks.static_runtime_union_match_branch_ctx(
    expr.value_name,
    info,
    ctx,
  );
  return pair_closure_fn_type(
    expr.then_branch,
    branch_ctx,
    expr.else_branch,
    ctx,
    hooks,
  );
}

function if_let_closure_fn_type_with_expected(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  expected: CoreFnType,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): CoreFnType | undefined {
  const union_case = hooks.static_union_case(expr.target, ctx);

  if (union_case) {
    if (union_case.name !== expr.case_name) {
      if (expr.implicit_else) {
        return undefined;
      }

      return closure_fn_type_with_expected(
        expr.else_branch,
        expected,
        ctx,
        hooks,
      );
    }

    if (expr.implicit_else) {
      return undefined;
    }

    const branch_ctx = static_if_let_closure_branch_ctx(
      expr,
      union_case,
      ctx,
      hooks,
    );
    return pair_closure_fn_type_with_expected(
      expr.then_branch,
      branch_ctx,
      expr.else_branch,
      ctx,
      expected,
      hooks,
    );
  }

  const dynamic_target = hooks.dynamic_union_if(expr.target, ctx);

  if (dynamic_target) {
    const cond_type = hooks.expr_type(dynamic_target.cond, ctx);
    expect(
      cond_type === "i32",
      "Core closure if let condition must be i32",
    );

    if (!dynamic_if_let_can_match(expr.case_name, dynamic_target)) {
      if (expr.implicit_else) {
        return undefined;
      }

      return closure_fn_type_with_expected(
        expr.else_branch,
        expected,
        ctx,
        hooks,
      );
    }

    return pair_closure_fn_type_with_expected(
      dynamic_if_let_case_closure_expr(expr, dynamic_target.then_case),
      dynamic_if_let_case_closure_ctx(
        expr,
        dynamic_target.then_case,
        ctx,
        hooks,
      ),
      dynamic_if_let_case_closure_expr(expr, dynamic_target.else_case),
      dynamic_if_let_case_closure_ctx(
        expr,
        dynamic_target.else_case,
        ctx,
        hooks,
      ),
      expected,
      hooks,
    );
  }

  const runtime_target = hooks.runtime_union_target(expr.target, ctx);

  if (!runtime_target) {
    return undefined;
  }

  if (expr.implicit_else) {
    return undefined;
  }

  const info = hooks.runtime_union_match_info(
    expr.case_name,
    runtime_target,
    ctx,
  );
  const branch_ctx = hooks.static_runtime_union_match_branch_ctx(
    expr.value_name,
    info,
    ctx,
  );
  return pair_closure_fn_type_with_expected(
    expr.then_branch,
    branch_ctx,
    expr.else_branch,
    ctx,
    expected,
    hooks,
  );
}

function pair_closure_fn_type(
  then_branch: CoreExpr,
  then_ctx: CoreClosureTypeCtx,
  else_branch: CoreExpr,
  else_ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): CoreFnType | undefined {
  let then_type = closure_fn_type(then_branch, then_ctx, hooks);
  let else_type = closure_fn_type(else_branch, else_ctx, hooks);

  if (!then_type && !else_type) {
    return undefined;
  }

  if (then_type && !else_type) {
    else_type = closure_fn_type_with_expected(
      else_branch,
      then_type,
      else_ctx,
      hooks,
    );
  }

  if (!then_type && else_type) {
    then_type = closure_fn_type_with_expected(
      then_branch,
      else_type,
      then_ctx,
      hooks,
    );
  }

  expect(
    then_type && else_type,
    "Core closure if let branches must both be closures",
  );
  expect(
    same_core_fn_type(then_type, else_type),
    "Core closure if let branch type mismatch",
  );
  return then_type;
}

function pair_closure_fn_type_with_expected(
  then_branch: CoreExpr,
  then_ctx: CoreClosureTypeCtx,
  else_branch: CoreExpr,
  else_ctx: CoreClosureTypeCtx,
  expected: CoreFnType,
  hooks: CoreClosureTypeHooks,
): CoreFnType | undefined {
  const then_type = closure_fn_type_with_expected(
    then_branch,
    expected,
    then_ctx,
    hooks,
  );
  const else_type = closure_fn_type_with_expected(
    else_branch,
    expected,
    else_ctx,
    hooks,
  );

  if (!then_type && !else_type) {
    return undefined;
  }

  expect(
    then_type && else_type,
    "Core closure if let branches must both be closures",
  );
  expect(
    same_core_fn_type(then_type, else_type),
    "Core closure if let branch type mismatch",
  );
  return then_type;
}

function dynamic_if_let_case_closure_expr(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
): CoreExpr {
  if (union_case.name === expr.case_name) {
    return expr.then_branch;
  }

  if (expr.implicit_else) {
    return { tag: "num", type: "i32", value: 0 };
  }

  return expr.else_branch;
}

function dynamic_if_let_case_closure_ctx(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): CoreClosureTypeCtx {
  if (union_case.name !== expr.case_name) {
    return ctx;
  }

  return static_if_let_closure_branch_ctx(expr, union_case, ctx, hooks);
}

function static_if_let_closure_branch_ctx(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): CoreClosureTypeCtx {
  const branch_ctx = child_closure_type_ctx(ctx);
  bind_core_if_let_payload_fact(
    expr.value_name,
    union_case,
    branch_ctx,
    {
      clear_core_local_facts: hooks.clear_core_local_facts,
      core_expr_is_text: hooks.core_expr_is_text,
      expr_type: hooks.expr_type,
      runtime_aggregate_type_expr: (value, value_ctx) =>
        runtime_aggregate_type_expr(value, value_ctx, {
          check_closure_call_args: (call_expr, fn_type, call_ctx) =>
            check_closure_call_args(call_expr, fn_type, call_ctx, hooks),
          closure_fn_type: (closure_expr, closure_ctx) =>
            closure_fn_type(closure_expr, closure_ctx, hooks),
        }),
      runtime_union_type_expr: hooks.runtime_union_type_expr,
      static_struct_value: hooks.static_struct_value,
    },
  );
  return branch_ctx;
}

function stmt_closure_fn_type(
  stmt: CoreStmt,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): CoreFnType | undefined {
  if (stmt.tag === "expr") {
    return closure_fn_type(stmt.expr, ctx, hooks);
  }

  if (stmt.tag === "return") {
    return closure_fn_type(stmt.value, ctx, hooks);
  }

  return undefined;
}

function stmt_closure_fn_type_with_expected(
  stmt: CoreStmt,
  expected: CoreFnType,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): CoreFnType | undefined {
  if (stmt.tag === "expr") {
    return closure_fn_type_with_expected(stmt.expr, expected, ctx, hooks);
  }

  if (stmt.tag === "return") {
    return closure_fn_type_with_expected(stmt.value, expected, ctx, hooks);
  }

  return undefined;
}

function child_closure_type_ctx(
  ctx: CoreClosureTypeCtx,
): CoreClosureTypeCtx {
  return {
    locals: new Map(ctx.locals),
    static_capture_values: clone_optional_map(ctx.static_capture_values),
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    borrowed_locals: clone_optional_set(ctx.borrowed_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    host_imports: clone_core_host_imports(ctx.host_imports),
    scratch_depth: ctx.scratch_depth,
    materialized_bindings: clone_optional_set(ctx.materialized_bindings),
    mutable_bindings: clone_optional_set(ctx.mutable_bindings),
  };
}

function closure_block_ctx(
  expr: Extract<CoreExpr, { tag: "block" }>,
  ctx: CoreClosureTypeCtx,
  hooks: CoreClosureTypeHooks,
): {
  final_stmt: CoreStmt;
  ctx: CoreClosureTypeBlockCtx;
} | undefined {
  const final_stmt = expr.statements[expr.statements.length - 1];
  expect(final_stmt, "Core closure block has no result statement");
  const block_ctx: CoreClosureTypeBlockCtx = {
    locals: new Map(ctx.locals),
    static_capture_values: clone_optional_map(ctx.static_capture_values),
    statics: new Map(ctx.statics),
    fn_types: new Map(ctx.fn_types),
    text_locals: new Set(ctx.text_locals),
    struct_locals: new Map(ctx.struct_locals),
    union_locals: new Map(ctx.union_locals),
    borrowed_locals: clone_optional_set(ctx.borrowed_locals),
    frozen_locals: clone_optional_set(ctx.frozen_locals),
    host_imports: clone_core_host_imports(ctx.host_imports),
    scratch_depth: ctx.scratch_depth,
    materialized_bindings: clone_optional_set(ctx.materialized_bindings),
    mutable_bindings: clone_optional_set(ctx.mutable_bindings),
    next_loop: 0,
    next_temp: 0,
  };

  for (let index = 0; index + 1 < expr.statements.length; index += 1) {
    const stmt = expr.statements[index];
    expect(
      stmt,
      "Missing core closure block statement " + index.toString(),
    );
    try {
      hooks.collect_stmt_locals(stmt, block_ctx);
    } catch (error) {
      if (closure_block_probe_error(error)) {
        return undefined;
      }

      throw error;
    }
  }

  return {
    final_stmt,
    ctx: block_ctx,
  };
}

function clone_optional_map<key, value>(
  source: Map<key, value> | undefined,
): Map<key, value> | undefined {
  if (!source) {
    return undefined;
  }

  return new Map(source);
}

function clone_optional_set<value>(
  source: Set<value> | undefined,
): Set<value> | undefined {
  if (!source) {
    return undefined;
  }

  return new Set(source);
}

function closure_block_probe_error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.message === "Cannot type core app expression yet") {
    return true;
  }

  if (error.message.startsWith("Unbound core local: ")) {
    return true;
  }

  return false;
}
