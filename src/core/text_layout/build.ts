import type { DataSegment } from "../../mod.ts";
import type { CoreExpr, CoreField, CoreParam, CoreStmt } from "../ast.ts";
import { set_local } from "../backend/util.ts";
import { align_to } from "../memory.ts";
import { static_core_call_branch_value } from "../static_call.ts";
import { align_to_4, text_bytes } from "../text.ts";
import {
  static_text_value,
  type StaticTextCtx,
  type StaticTextHooks,
} from "../text_static.ts";
import { dynamic_if_let_can_match } from "../union_static.ts";
import { core_text_layout_param_type } from "./param.ts";
import type { CoreTextLayoutHooks, TextLayout } from "./types.ts";

type TextLayoutBranchCtx =
  | { tag: "scan"; ctx: StaticTextCtx }
  | { tag: "skip" }
  | { tag: "unknown" };

export function build_text_layout(
  core: { statements: CoreStmt[] },
  initial_ctx: StaticTextCtx,
  hooks: CoreTextLayoutHooks,
): TextLayout {
  const offsets = new Map<string, number>();
  const data: DataSegment[] = [];
  const text_hooks = {
    static_collection_fields: hooks.static_collection_fields,
    expr_type: hooks.expr_type,
    static_union_case: hooks.static_union_case,
    dynamic_union_if: hooks.dynamic_union_if,
  } satisfies StaticTextHooks;
  const ctx: StaticTextCtx = {
    ...initial_ctx,
    locals: initial_ctx.locals,
    statics: new Map(),
    fn_types: new Map(initial_ctx.fn_types),
    text_locals: new Set(initial_ctx.text_locals),
    struct_locals: new Map(initial_ctx.struct_locals),
    union_locals: new Map(initial_ctx.union_locals),
  };
  let offset = 0;
  const visiting_static_functions = new Set<string>();

  function add_text(expr: Extract<CoreExpr, { tag: "text" }>): void {
    const existing = offsets.get(expr.value);

    if (existing !== undefined) {
      return;
    }

    const bytes = text_bytes(expr.value);
    offsets.set(expr.value, offset);
    data.push({ offset, bytes });
    offset = align_to_4(offset + bytes.length);
  }

  function add_static_text(expr: CoreExpr): void {
    if (expr.tag === "text") {
      add_text(expr);
      return;
    }

    if (expr.tag === "if") {
      visit_expr(expr.cond);
      add_static_text(expr.then_branch);
      add_static_text(expr.else_branch);
      return;
    }
  }

  function visit_static_binding(name: string, value: CoreExpr): boolean {
    if (value.tag === "lam" || value.tag === "rec") {
      ctx.statics.set(name, value);
      visit_expr(value);
      return true;
    }

    const branch_function_value = static_core_call_branch_value(
      value,
      ctx,
      hooks,
    );

    if (branch_function_value) {
      ctx.statics.set(name, branch_function_value);
      visit_expr(branch_function_value);
      return true;
    }

    const text_value = static_text_value(value, ctx, text_hooks);

    if (text_value) {
      ctx.statics.set(name, text_value);
      add_static_text(text_value);
      return true;
    }

    const struct_value = hooks.static_struct_value(value, ctx);

    if (struct_value) {
      ctx.statics.set(name, struct_value);
      visit_expr(struct_value);
      return true;
    }

    const union_case = hooks.static_union_case(value, ctx);

    if (union_case) {
      ctx.statics.set(name, union_case);
      visit_expr(union_case);
      return true;
    }

    const union_if = hooks.dynamic_union_if(value, ctx);

    if (union_if) {
      const union_value: CoreExpr = {
        tag: "if",
        cond: union_if.cond,
        then_branch: union_if.then_case,
        else_branch: union_if.else_case,
      };
      ctx.statics.set(name, union_value);
      visit_expr(union_value);
      return true;
    }

    ctx.statics.delete(name);
    return false;
  }

  function visit_stmt(stmt: CoreStmt): void {
    switch (stmt.tag) {
      case "bind":
        {
          const value = hooks.core_binding_value(stmt, ctx);
          const type_value = hooks.core_type_const_value(stmt, value, ctx);

          if (type_value) {
            ctx.statics.set(stmt.name, type_value);
            return;
          }

          if (visit_static_binding(stmt.name, value)) {
            return;
          }

          visit_expr(value);
          bind_dynamic_value(stmt.name, value, stmt.annotation);
        }

        return;

      case "assign":
        if (visit_static_binding(stmt.name, stmt.value)) {
          return;
        }

        visit_expr(stmt.value);
        bind_dynamic_value(stmt.name, stmt.value, undefined);
        return;

      case "index_assign":
        visit_expr(stmt.index);
        visit_expr(stmt.value);
        return;

      case "range_loop":
        visit_expr(stmt.start);
        visit_expr(stmt.end);
        visit_expr(stmt.step);

        for (const item of stmt.body) {
          visit_stmt(item);
        }

        return;

      case "collection_loop":
        visit_expr(stmt.collection);

        for (const item of stmt.body) {
          visit_stmt(item);
        }

        return;

      case "if_stmt":
        visit_expr(stmt.cond);

        for (const item of stmt.body) {
          visit_stmt(item);
        }

        return;

      case "if_else_stmt":
        visit_expr(stmt.cond);

        {
          const then_ctx: StaticTextCtx = {
            locals: ctx.locals,
            statics: new Map(ctx.statics),
            fn_types: new Map(ctx.fn_types),
            text_locals: new Set(ctx.text_locals),
            struct_locals: new Map(ctx.struct_locals),
            union_locals: new Map(ctx.union_locals),
          };
          const else_ctx: StaticTextCtx = {
            locals: ctx.locals,
            statics: new Map(ctx.statics),
            fn_types: new Map(ctx.fn_types),
            text_locals: new Set(ctx.text_locals),
            struct_locals: new Map(ctx.struct_locals),
            union_locals: new Map(ctx.union_locals),
          };
          const outer_statics = ctx.statics;
          const outer_fn_types = ctx.fn_types;
          const outer_text_locals = ctx.text_locals;
          const outer_struct_locals = ctx.struct_locals;
          const outer_union_locals = ctx.union_locals;

          ctx.statics = then_ctx.statics;
          ctx.fn_types = then_ctx.fn_types;
          ctx.text_locals = then_ctx.text_locals;
          ctx.struct_locals = then_ctx.struct_locals;
          ctx.union_locals = then_ctx.union_locals;
          for (const item of stmt.then_body) {
            visit_stmt(item);
          }

          ctx.statics = else_ctx.statics;
          ctx.fn_types = else_ctx.fn_types;
          ctx.text_locals = else_ctx.text_locals;
          ctx.struct_locals = else_ctx.struct_locals;
          ctx.union_locals = else_ctx.union_locals;
          for (const item of stmt.else_body) {
            visit_stmt(item);
          }

          ctx.statics = outer_statics;
          ctx.fn_types = outer_fn_types;
          ctx.text_locals = outer_text_locals;
          ctx.struct_locals = outer_struct_locals;
          ctx.union_locals = outer_union_locals;
        }

        return;

      case "if_let_stmt":
        visit_expr(stmt.target);

        {
          const branch_ctx = if_let_branch_ctx(
            stmt.target,
            stmt.case_name,
            stmt.value_name,
          );

          if (branch_ctx.tag === "skip") {
            return;
          }

          if (branch_ctx.tag === "scan") {
            with_text_layout_ctx(branch_ctx.ctx, () => {
              for (const item of stmt.body) {
                visit_stmt(item);
              }
            });
            return;
          }
        }

        for (const item of stmt.body) {
          visit_stmt(item);
        }

        return;

      case "return":
        visit_expr(stmt.value);
        return;

      case "expr":
        visit_expr(stmt.expr);
        return;

      case "type_check":
      case "break":
      case "continue":
      case "unsupported":
        return;
    }
  }

  function visit_field(field: CoreField): void {
    visit_expr(field.value);
  }

  function bind_dynamic_value(
    name: string,
    value: CoreExpr,
    annotation: string | undefined,
  ): void {
    ctx.statics.delete(name);

    const has_text_fact = layout_value_has_text_fact(value, annotation);

    if (has_text_fact && value_has_implicit_text_fallback(value)) {
      add_text({ tag: "text", value: "" });
    }

    if (has_text_fact) {
      set_local(ctx.locals, name, "i32");
      ctx.text_locals.add(name);
    } else {
      ctx.text_locals.delete(name);
    }
  }

  function layout_value_has_text_fact(
    value: CoreExpr,
    annotation: string | undefined,
  ): boolean {
    if (annotation === "Text") {
      return true;
    }

    if (static_text_value(value, ctx, text_hooks)) {
      return true;
    }

    if (value.tag === "var") {
      return ctx.text_locals.has(value.name);
    }

    if (value.tag === "borrow" || value.tag === "freeze") {
      return layout_value_has_text_fact(value.value, undefined);
    }

    if (value.tag === "scratch") {
      return layout_value_has_text_fact(value.body, undefined);
    }

    if (value.tag === "if") {
      if (value.implicit_else) {
        return layout_value_has_text_fact(value.then_branch, undefined);
      }

      return layout_value_has_text_fact(value.then_branch, undefined) &&
        layout_value_has_text_fact(value.else_branch, undefined);
    }

    if (value.tag === "if_let" && value.implicit_else) {
      const text_value = static_text_value(value, ctx, text_hooks);

      if (text_value) {
        return true;
      }
    }

    return false;
  }

  function value_has_implicit_text_fallback(value: CoreExpr): boolean {
    if (value.tag === "if" && value.implicit_else) {
      return true;
    }

    if (value.tag === "if_let" && value.implicit_else) {
      return true;
    }

    if (value.tag === "borrow" || value.tag === "freeze") {
      return value_has_implicit_text_fallback(value.value);
    }

    if (value.tag === "scratch") {
      return value_has_implicit_text_fallback(value.body);
    }

    return false;
  }

  function visit_closure_body(params: CoreParam[], body: CoreExpr): void {
    const body_ctx: StaticTextCtx = {
      locals: new Map(ctx.locals),
      statics: new Map(ctx.statics),
      fn_types: new Map(ctx.fn_types),
      text_locals: new Set(ctx.text_locals),
      struct_locals: new Map(ctx.struct_locals),
      union_locals: new Map(ctx.union_locals),
    };

    for (const param of params) {
      const type = core_text_layout_param_type(param);

      if (type) {
        body_ctx.statics.delete(param.name);
        body_ctx.fn_types.delete(param.name);
        body_ctx.struct_locals.delete(param.name);
        body_ctx.union_locals.delete(param.name);
        set_local(body_ctx.locals, param.name, type);

        if (param.annotation === "Text") {
          body_ctx.text_locals.add(param.name);
        } else {
          body_ctx.text_locals.delete(param.name);
        }
      }
    }

    const outer_locals = ctx.locals;
    const outer_statics = ctx.statics;
    const outer_fn_types = ctx.fn_types;
    const outer_text_locals = ctx.text_locals;
    const outer_struct_locals = ctx.struct_locals;
    const outer_union_locals = ctx.union_locals;

    ctx.locals = body_ctx.locals;
    ctx.statics = body_ctx.statics;
    ctx.fn_types = body_ctx.fn_types;
    ctx.text_locals = body_ctx.text_locals;
    ctx.struct_locals = body_ctx.struct_locals;
    ctx.union_locals = body_ctx.union_locals;

    try {
      visit_expr(body);
    } finally {
      ctx.locals = outer_locals;
      ctx.statics = outer_statics;
      ctx.fn_types = outer_fn_types;
      ctx.text_locals = outer_text_locals;
      ctx.struct_locals = outer_struct_locals;
      ctx.union_locals = outer_union_locals;
    }
  }

  function visit_static_function_reference(name: string): void {
    const value = ctx.statics.get(name);

    if (!value) {
      return;
    }

    if (value.tag !== "lam" && value.tag !== "rec") {
      return;
    }

    if (visiting_static_functions.has(name)) {
      return;
    }

    visiting_static_functions.add(name);
    try {
      visit_expr(value);
    } finally {
      visiting_static_functions.delete(name);
    }
  }

  function visit_expr(expr: CoreExpr): void {
    if (expr.tag === "rec_ref" || expr.tag === "rec") {
      return;
    }
    const inlined = hooks.static_core_call_value(expr, ctx);

    if (inlined) {
      visit_expr(inlined);
      return;
    }

    const text_value = static_text_value(expr, ctx, text_hooks);

    if (text_value) {
      add_static_text(text_value);
      return;
    }

    switch (expr.tag) {
      case "rec_ref":
        return;

      case "prim":
        for (const arg of expr.args) {
          visit_expr(arg);
        }

        return;

      case "text":
        add_text(expr);
        return;

      case "if":
        if (
          expr.implicit_else &&
          layout_value_has_text_fact(expr, undefined)
        ) {
          add_text({ tag: "text", value: "" });
        }

        visit_expr(expr.cond);
        visit_expr(expr.then_branch);

        if (!expr.implicit_else) {
          visit_expr(expr.else_branch);
        }

        return;

      case "lam":
      case "rec":
        visit_closure_body(expr.params, expr.body);
        return;

      case "app":
        visit_expr(expr.func);

        for (const arg of expr.args) {
          visit_expr(arg);
        }

        return;

      case "block":
        for (const stmt of expr.statements) {
          visit_stmt(stmt);
        }

        return;

      case "comptime":
        visit_expr(expr.expr);
        return;

      case "borrow":
        visit_expr(expr.value);
        return;

      case "freeze":
        visit_expr(expr.value);
        return;

      case "scratch":
        visit_expr(expr.body);
        return;

      case "with":
        visit_expr(expr.base);

        for (const field of expr.fields) {
          visit_field(field);
        }

        return;

      case "struct_value":
        visit_expr(expr.type_expr);

        for (const field of expr.fields) {
          visit_field(field);
        }

        return;

      case "struct_update":
        visit_expr(expr.base);

        for (const field of expr.fields) {
          visit_field(field);
        }

        return;

      case "if_let":
        if (
          expr.implicit_else &&
          layout_value_has_text_fact(expr, undefined)
        ) {
          add_text({ tag: "text", value: "" });
        }

        visit_expr(expr.target);

        {
          const branch_ctx = if_let_branch_ctx(
            expr.target,
            expr.case_name,
            expr.value_name,
          );

          if (branch_ctx.tag === "skip") {
            if (!expr.implicit_else) {
              visit_expr(expr.else_branch);
            }

            return;
          }

          if (branch_ctx.tag === "scan") {
            with_text_layout_ctx(branch_ctx.ctx, () => {
              visit_expr(expr.then_branch);
            });

            if (!expr.implicit_else) {
              visit_expr(expr.else_branch);
            }

            return;
          }
        }

        visit_expr(expr.then_branch);

        if (!expr.implicit_else) {
          visit_expr(expr.else_branch);
        }

        return;

      case "field":
        visit_expr(expr.object);
        return;

      case "index":
        visit_expr(expr.object);
        visit_expr(expr.index);
        return;

      case "union_case":
        if (expr.value) {
          visit_expr(expr.value);
        }

        if (expr.type_expr) {
          visit_expr(expr.type_expr);
        }

        return;

      case "var":
        visit_static_function_reference(expr.name);
        return;

      case "num":
      case "type_name":
      case "linear":
      case "struct_type":
      case "union_type":
      case "unsupported":
        return;
    }
  }

  for (const stmt of core.statements) {
    visit_stmt(stmt);
  }

  return { offsets, data, heap_start: align_to(offset, 8) };

  function if_let_branch_ctx(
    target: CoreExpr,
    case_name: string,
    value_name: string | undefined,
  ): TextLayoutBranchCtx {
    const union_case = hooks.static_union_case(target, ctx);

    if (union_case) {
      if (union_case.name !== case_name) {
        return { tag: "skip" };
      }

      const branch_ctx = create_text_layout_branch_ctx(ctx);
      hooks.bind_core_if_let_payload_fact(
        value_name,
        union_case,
        branch_ctx,
      );
      return { tag: "scan", ctx: branch_ctx };
    }

    const dynamic_target = hooks.dynamic_union_if(target, ctx);

    if (dynamic_target) {
      if (!dynamic_if_let_can_match(case_name, dynamic_target)) {
        return { tag: "skip" };
      }

      const branch_ctx = create_text_layout_branch_ctx(ctx);
      hooks.bind_dynamic_if_let_payload(
        case_name,
        value_name,
        dynamic_target,
        branch_ctx,
      );
      return { tag: "scan", ctx: branch_ctx };
    }

    const runtime_target = hooks.runtime_union_target(target, ctx);

    if (runtime_target) {
      const info = hooks.runtime_union_match_info(
        case_name,
        runtime_target,
        ctx,
      );
      const branch_ctx = hooks.static_runtime_union_match_branch_ctx(
        value_name,
        info,
        ctx,
      );
      return { tag: "scan", ctx: branch_ctx };
    }

    return { tag: "unknown" };
  }

  function create_text_layout_branch_ctx(
    source: StaticTextCtx,
  ): StaticTextCtx {
    return {
      ...source,
      locals: new Map(source.locals),
      statics: new Map(source.statics),
      fn_types: new Map(source.fn_types),
      text_locals: new Set(source.text_locals),
      struct_locals: new Map(source.struct_locals),
      union_locals: new Map(source.union_locals),
    };
  }

  function with_text_layout_ctx(
    next_ctx: StaticTextCtx,
    visit: () => void,
  ): void {
    const outer_locals = ctx.locals;
    const outer_statics = ctx.statics;
    const outer_fn_types = ctx.fn_types;
    const outer_text_locals = ctx.text_locals;
    const outer_struct_locals = ctx.struct_locals;
    const outer_union_locals = ctx.union_locals;

    ctx.locals = next_ctx.locals;
    ctx.statics = next_ctx.statics;
    ctx.fn_types = next_ctx.fn_types;
    ctx.text_locals = next_ctx.text_locals;
    ctx.struct_locals = next_ctx.struct_locals;
    ctx.union_locals = next_ctx.union_locals;

    try {
      visit();
    } finally {
      ctx.locals = outer_locals;
      ctx.statics = outer_statics;
      ctx.fn_types = outer_fn_types;
      ctx.text_locals = outer_text_locals;
      ctx.struct_locals = outer_struct_locals;
      ctx.union_locals = outer_union_locals;
    }
  }
}
