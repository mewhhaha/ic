import type { CoreExpr, CoreStmt } from "../ast.ts";
import { fresh_temp_local } from "../emit/name.ts";
import { type TempNameCtx } from "../emit/types.ts";
import {
  replacement_var_name,
  scoped_static_core_call_names,
} from "./names.ts";

export type ScopedStaticCoreCallCtx = TempNameCtx & {
  materialized_bindings?: Set<string>;
  mutable_bindings?: Set<string>;
};

type ScopedStaticCoreCallExpr = (
  expr: CoreExpr,
  replacements: Map<string, CoreExpr>,
  ctx: ScopedStaticCoreCallCtx,
) => CoreExpr;

export function scoped_static_core_call_block(
  stmts: CoreStmt[],
  replacements: Map<string, CoreExpr>,
  ctx: ScopedStaticCoreCallCtx,
  rewrite_expr: ScopedStaticCoreCallExpr,
): CoreStmt[] {
  const result: CoreStmt[] = [];

  for (const stmt of stmts) {
    result.push(
      scoped_static_core_call_stmt(stmt, replacements, ctx, rewrite_expr),
    );
  }

  return result;
}

function scoped_static_core_call_stmt(
  stmt: CoreStmt,
  replacements: Map<string, CoreExpr>,
  ctx: ScopedStaticCoreCallCtx,
  rewrite_expr: ScopedStaticCoreCallExpr,
): CoreStmt {
  switch (stmt.tag) {
    case "bind": {
      const value = rewrite_expr(
        stmt.value,
        replacements,
        ctx,
      );
      const name = fresh_temp_local(ctx, "local_" + stmt.name);
      if (ctx.mutable_bindings?.has(stmt.name)) {
        ctx.mutable_bindings.add(name);
      }
      if (ctx.materialized_bindings?.has(stmt.name)) {
        ctx.materialized_bindings.add(name);
      }
      replacements.set(stmt.name, { tag: "var", name });
      return {
        tag: "bind",
        kind: stmt.kind,
        name,
        is_linear: stmt.is_linear,
        force_materialized: stmt.force_materialized,
        annotation: stmt.annotation,
        value,
      };
    }

    case "assign": {
      const value = rewrite_expr(
        stmt.value,
        replacements,
        ctx,
      );
      const existing = replacement_var_name(replacements, stmt.name);

      if (existing && stmt.mode === "same") {
        return {
          tag: "assign",
          name: existing,
          mode: stmt.mode,
          value,
        };
      }

      if (existing && stmt.mode === "change") {
        const name = fresh_temp_local(ctx, "local_" + stmt.name);
        if (ctx.mutable_bindings?.has(stmt.name)) {
          ctx.mutable_bindings.add(name);
        }
        if (ctx.materialized_bindings?.has(stmt.name)) {
          ctx.materialized_bindings.add(name);
        }
        replacements.set(stmt.name, { tag: "var", name });
        return {
          tag: "assign",
          name,
          mode: stmt.mode,
          value,
        };
      }

      return {
        tag: "assign",
        name: stmt.name,
        mode: stmt.mode,
        value,
      };
    }

    case "index_assign": {
      const existing = replacement_var_name(replacements, stmt.name);
      let name = stmt.name;

      if (existing) {
        name = existing;
      }

      return {
        tag: "index_assign",
        name,
        index: rewrite_expr(stmt.index, replacements, ctx),
        value: rewrite_expr(stmt.value, replacements, ctx),
      };
    }

    case "range_loop": {
      const body_replacements = new Map(replacements);
      const index_name = fresh_temp_local(ctx, "local_" + stmt.index);
      body_replacements.set(stmt.index, { tag: "var", name: index_name });
      return {
        tag: "range_loop",
        index: index_name,
        start: rewrite_expr(stmt.start, replacements, ctx),
        end: rewrite_expr(stmt.end, replacements, ctx),
        step: rewrite_expr(stmt.step, replacements, ctx),
        carried: scoped_static_core_call_names(stmt.carried, replacements),
        body: scoped_static_core_call_block(
          stmt.body,
          body_replacements,
          ctx,
          rewrite_expr,
        ),
      };
    }

    case "collection_loop": {
      const body_replacements = new Map(replacements);
      let index_name: string | undefined;

      if (stmt.index) {
        index_name = fresh_temp_local(ctx, "local_" + stmt.index);
        body_replacements.set(stmt.index, { tag: "var", name: index_name });
      }

      const item_name = fresh_temp_local(ctx, "local_" + stmt.item);
      body_replacements.set(stmt.item, { tag: "var", name: item_name });
      return {
        tag: "collection_loop",
        index: index_name,
        item: item_name,
        collection: rewrite_expr(
          stmt.collection,
          replacements,
          ctx,
        ),
        carried: scoped_static_core_call_names(stmt.carried, replacements),
        body: scoped_static_core_call_block(
          stmt.body,
          body_replacements,
          ctx,
          rewrite_expr,
        ),
      };
    }

    case "if_stmt":
      return {
        tag: "if_stmt",
        cond: rewrite_expr(stmt.cond, replacements, ctx),
        body: scoped_static_core_call_block(
          stmt.body,
          new Map(replacements),
          ctx,
          rewrite_expr,
        ),
      };

    case "if_else_stmt":
      return {
        tag: "if_else_stmt",
        cond: rewrite_expr(stmt.cond, replacements, ctx),
        then_body: scoped_static_core_call_block(
          stmt.then_body,
          new Map(replacements),
          ctx,
          rewrite_expr,
        ),
        else_body: scoped_static_core_call_block(
          stmt.else_body,
          new Map(replacements),
          ctx,
          rewrite_expr,
        ),
      };

    case "if_let_stmt": {
      const body_replacements = new Map(replacements);
      let value_name = stmt.value_name;

      if (stmt.value_name) {
        value_name = fresh_temp_local(ctx, "local_" + stmt.value_name);
        body_replacements.set(stmt.value_name, {
          tag: "var",
          name: value_name,
        });
      }

      return {
        tag: "if_let_stmt",
        case_name: stmt.case_name,
        value_name,
        target: rewrite_expr(stmt.target, replacements, ctx),
        body: scoped_static_core_call_block(
          stmt.body,
          body_replacements,
          ctx,
          rewrite_expr,
        ),
      };
    }

    case "type_check":
      return {
        tag: "type_check",
        pattern: stmt.pattern,
        target: rewrite_expr(stmt.target, replacements, ctx),
      };

    case "return":
      return {
        tag: "return",
        value: rewrite_expr(stmt.value, replacements, ctx),
      };

    case "expr":
      return {
        tag: "expr",
        expr: rewrite_expr(stmt.expr, replacements, ctx),
      };

    case "break":
      if (!stmt.value) {
        return stmt;
      }
      return {
        tag: "break",
        value: rewrite_expr(stmt.value, replacements, ctx),
      };
    case "continue":
    case "unsupported":
      return stmt;
  }
}
