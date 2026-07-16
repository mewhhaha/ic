import { expect } from "../expect.ts";
import type { ValType } from "../op.ts";
import type { Wat } from "../wat.ts";
import type { CoreExpr, CoreFnType, CoreStmt } from "./ast.ts";
import { fresh_temp_local } from "./emit/name.ts";
import { indent_lines } from "./emit/format.ts";
import { set_local } from "./emit/local.ts";
import { same_core_fn_type } from "./closure_type.ts";
import type { DynamicUnionIf } from "./if_let.ts";
import type {
  RuntimeUnionMatchInfo,
  RuntimeUnionTarget,
} from "./runtime_union.ts";
import type { RuntimeUnionPayloadEmitBinding } from "./runtime_union_emit.ts";
import { emit_runtime_union_match_payload_setup } from "./runtime_union_payload_emit.ts";

export type CoreClosureIfEmitCtx = {
  statics: Map<string, CoreExpr>;
};

export type CoreClosureIfLetEmitCtx = CoreClosureIfEmitCtx & {
  locals: Map<string, ValType>;
  next_loop: number;
  next_temp: number;
};

export type CoreClosureIfEmitHooks<ctx extends CoreClosureIfEmitCtx> = {
  closure_fn_type_with_expected: (
    expr: CoreExpr,
    expected: CoreFnType,
    ctx: ctx,
  ) => CoreFnType | undefined;
  emit_expr: (expr: CoreExpr, ctx: ctx) => Wat;
  emit_runtime_closure_with_type: (
    expr: Extract<CoreExpr, { tag: "lam" }>,
    fn_type: CoreFnType,
    ctx: ctx,
  ) => Wat;
  emit_stmt: (stmt: CoreStmt, ctx: ctx, is_final: boolean) => Wat;
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType;
};

export type CoreClosureIfLetEmitHooks<
  ctx extends CoreClosureIfLetEmitCtx,
> = CoreClosureIfEmitHooks<ctx> & {
  bind_payload: (
    value_name: string | undefined,
    union_case: Extract<CoreExpr, { tag: "union_case" }>,
    ctx: ctx,
  ) => { setup: Wat; ctx: ctx };
  dynamic_union_if: (
    expr: CoreExpr,
    ctx: ctx,
  ) => DynamicUnionIf | undefined;
  match_branch_ctx: (
    value_name: string | undefined,
    info: RuntimeUnionMatchInfo,
    ctx: ctx,
  ) => RuntimeUnionPayloadEmitBinding<ctx>;
  runtime_union_match_info: (
    case_name: string,
    target: RuntimeUnionTarget,
    ctx: ctx,
  ) => RuntimeUnionMatchInfo;
  runtime_union_target: (
    expr: CoreExpr,
    ctx: ctx,
  ) => RuntimeUnionTarget | undefined;
  static_union_case: (
    expr: CoreExpr,
    ctx: ctx,
  ) => Extract<CoreExpr, { tag: "union_case" }> | undefined;
};

export function emit_core_closure_if_expr<
  ctx extends CoreClosureIfEmitCtx,
>(
  expr: Extract<CoreExpr, { tag: "if" }>,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreClosureIfEmitHooks<ctx>,
): Wat {
  const cond_type = hooks.expr_type(expr.cond, ctx);
  expect(cond_type === "i32", "Core closure if condition must be i32");
  expect(!expr.implicit_else, "Core closure if cannot use implicit else");
  return [
    hooks.emit_expr(expr.cond, ctx),
    "if (result i32)",
    indent_lines(
      emit_core_closure_value_with_type(expr.then_branch, fn_type, ctx, hooks),
      2,
    ),
    "else",
    indent_lines(
      emit_core_closure_value_with_type(expr.else_branch, fn_type, ctx, hooks),
      2,
    ),
    "end",
  ].join("\n");
}

export function emit_core_closure_if_let_expr<
  ctx extends CoreClosureIfLetEmitCtx,
>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreClosureIfLetEmitHooks<ctx>,
): Wat {
  const union_case = hooks.static_union_case(expr.target, ctx);

  if (union_case) {
    return emit_static_closure_if_let_expr(
      expr,
      union_case,
      fn_type,
      ctx,
      hooks,
    );
  }

  const dynamic_target = hooks.dynamic_union_if(expr.target, ctx);

  if (dynamic_target) {
    return emit_dynamic_closure_if_let_expr(
      expr,
      dynamic_target,
      fn_type,
      ctx,
      hooks,
    );
  }

  const runtime_target = hooks.runtime_union_target(expr.target, ctx);
  expect(runtime_target, "Core closure if let requires a union target");
  return emit_runtime_closure_if_let_expr(
    expr,
    runtime_target,
    fn_type,
    ctx,
    hooks,
  );
}

function emit_static_closure_if_let_expr<
  ctx extends CoreClosureIfLetEmitCtx,
>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreClosureIfLetEmitHooks<ctx>,
): Wat {
  expect(!expr.implicit_else, "Core closure if let cannot use implicit else");

  if (union_case.name !== expr.case_name) {
    return emit_core_closure_value_with_type(
      expr.else_branch,
      fn_type,
      ctx,
      hooks,
    );
  }

  const binding = hooks.bind_payload(expr.value_name, union_case, ctx);
  const lines: string[] = [];

  if (binding.setup !== "") {
    lines.push(binding.setup);
  }

  const branch_value = emit_core_closure_value_with_type(
    expr.then_branch,
    fn_type,
    binding.ctx,
    hooks,
  );
  ctx.next_loop = binding.ctx.next_loop;
  ctx.next_temp = binding.ctx.next_temp;
  lines.push(branch_value);
  return lines.join("\n");
}

function emit_dynamic_closure_if_let_expr<
  ctx extends CoreClosureIfLetEmitCtx,
>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  target: DynamicUnionIf,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreClosureIfLetEmitHooks<ctx>,
): Wat {
  const cond_type = hooks.expr_type(target.cond, ctx);
  expect(cond_type === "i32", "Core closure if let condition must be i32");
  return [
    hooks.emit_expr(target.cond, ctx),
    "if (result i32)",
    indent_lines(
      emit_dynamic_closure_if_let_case(
        expr,
        target.then_case,
        fn_type,
        ctx,
        hooks,
      ),
      2,
    ),
    "else",
    indent_lines(
      emit_dynamic_closure_if_let_case(
        expr,
        target.else_case,
        fn_type,
        ctx,
        hooks,
      ),
      2,
    ),
    "end",
  ].join("\n");
}

function emit_dynamic_closure_if_let_case<
  ctx extends CoreClosureIfLetEmitCtx,
>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  union_case: Extract<CoreExpr, { tag: "union_case" }>,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreClosureIfLetEmitHooks<ctx>,
): Wat {
  expect(!expr.implicit_else, "Core closure if let cannot use implicit else");

  if (union_case.name !== expr.case_name) {
    return emit_core_closure_value_with_type(
      expr.else_branch,
      fn_type,
      ctx,
      hooks,
    );
  }

  const binding = hooks.bind_payload(expr.value_name, union_case, ctx);
  const lines: string[] = [];

  if (binding.setup !== "") {
    lines.push(binding.setup);
  }

  const branch_value = emit_core_closure_value_with_type(
    expr.then_branch,
    fn_type,
    binding.ctx,
    hooks,
  );
  ctx.next_loop = binding.ctx.next_loop;
  ctx.next_temp = binding.ctx.next_temp;
  lines.push(branch_value);
  return lines.join("\n");
}

function emit_runtime_closure_if_let_expr<
  ctx extends CoreClosureIfLetEmitCtx,
>(
  expr: Extract<CoreExpr, { tag: "if_let" }>,
  target: RuntimeUnionTarget,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreClosureIfLetEmitHooks<ctx>,
): Wat {
  expect(!expr.implicit_else, "Core closure if let cannot use implicit else");
  const target_code = hooks.emit_expr(target.target, ctx);
  const local_name = fresh_temp_local(ctx, "union_match");
  set_local(ctx.locals, local_name, "i32");
  const info = hooks.runtime_union_match_info(expr.case_name, target, ctx);
  const binding = hooks.match_branch_ctx(expr.value_name, info, ctx);
  const branch_ctx = binding.ctx;
  const then_lines: string[] = [];
  const payload_setup = emit_runtime_union_match_payload_setup(
    local_name,
    expr.value_name,
    info,
    binding.fields,
  );

  if (payload_setup !== "") {
    then_lines.push(payload_setup);
  }

  then_lines.push(
    emit_core_closure_value_with_type(
      expr.then_branch,
      fn_type,
      branch_ctx,
      hooks,
    ),
  );
  ctx.next_loop = branch_ctx.next_loop;
  ctx.next_temp = branch_ctx.next_temp;

  return [
    target_code,
    "local.set $" + local_name,
    "local.get $" + local_name,
    "i32.load",
    "i32.const " + info.tag_value.toString(),
    "i32.eq",
    "if (result i32)",
    indent_lines(then_lines.join("\n"), 2),
    "else",
    indent_lines(
      emit_core_closure_value_with_type(
        expr.else_branch,
        fn_type,
        ctx,
        hooks,
      ),
      2,
    ),
    "end",
  ].join("\n");
}

function emit_core_closure_value_with_type<
  ctx extends CoreClosureIfEmitCtx,
>(
  expr: CoreExpr,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreClosureIfEmitHooks<ctx>,
): Wat {
  const actual = hooks.closure_fn_type_with_expected(expr, fn_type, ctx);
  expect(actual, "Core closure if branch must be a closure");
  expect(
    same_core_fn_type(actual, fn_type),
    "Core closure if branch type mismatch",
  );

  if (expr.tag === "lam") {
    return hooks.emit_runtime_closure_with_type(expr, fn_type, ctx);
  }

  if (expr.tag === "if") {
    return emit_core_closure_if_expr(expr, fn_type, ctx, hooks);
  }

  if (expr.tag === "block") {
    return emit_core_closure_block_with_type(expr, fn_type, ctx, hooks);
  }

  if (expr.tag === "var") {
    const static_value = ctx.statics.get(expr.name);

    if (static_value) {
      return emit_core_closure_value_with_type(
        static_value,
        fn_type,
        ctx,
        hooks,
      );
    }
  }

  return hooks.emit_expr(expr, ctx);
}

function emit_core_closure_block_with_type<
  ctx extends CoreClosureIfEmitCtx,
>(
  expr: Extract<CoreExpr, { tag: "block" }>,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreClosureIfEmitHooks<ctx>,
): Wat {
  const lines: string[] = [];

  for (let index = 0; index < expr.statements.length; index += 1) {
    const stmt = expr.statements[index];
    expect(stmt, "Missing core block statement " + index);
    const is_final = index + 1 >= expr.statements.length;

    if (is_final) {
      lines.push(emit_core_closure_stmt_with_type(stmt, fn_type, ctx, hooks));
    } else {
      lines.push(hooks.emit_stmt(stmt, ctx, false));
    }
  }

  return lines.join("\n");
}

function emit_core_closure_stmt_with_type<
  ctx extends CoreClosureIfEmitCtx,
>(
  stmt: CoreStmt,
  fn_type: CoreFnType,
  ctx: ctx,
  hooks: CoreClosureIfEmitHooks<ctx>,
): Wat {
  if (stmt.tag === "expr") {
    return emit_core_closure_value_with_type(stmt.expr, fn_type, ctx, hooks);
  }

  if (stmt.tag === "return") {
    return emit_core_closure_value_with_type(stmt.value, fn_type, ctx, hooks);
  }

  throw new Error("Core closure block final statement must produce a closure");
}
