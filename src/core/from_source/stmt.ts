import type { FrontExpr, Stmt } from "../../frontend/ast.ts";
import type { CoreExpr, CoreStmt } from "../ast.ts";
import {
  bind_core_name,
  type CoreFromSourceCtx,
  fork_core_from_source_ctx,
  resolve_bound_core_value_name,
  resolve_core_annotation,
  resolve_core_name,
  shadow_core_name,
} from "./context.ts";
import { block_body, core_expr, core_param } from "./expr.ts";
import { validate_named_recursive_tail_binding } from "./rec.ts";

export function core_stmt(stmt: Stmt, ctx: CoreFromSourceCtx): CoreStmt {
  switch (stmt.tag) {
    case "bind": {
      if (stmt.is_recursive) {
        const name = bind_core_name(ctx, stmt.name);

        if (stmt.is_linear) {
          ctx.linear_names.add(name);
        } else {
          ctx.linear_names.delete(name);
        }

        return {
          tag: "bind",
          kind: stmt.kind,
          name,
          is_linear: stmt.is_linear,
          annotation: resolve_core_annotation(ctx, stmt.annotation),
          value: core_recursive_binding_value(stmt, ctx, name),
        };
      }

      let value = core_expr(stmt.value, ctx);
      const name = bind_core_name(ctx, stmt.name);

      if (stmt.is_linear) {
        ctx.linear_names.add(name);
      } else {
        ctx.linear_names.delete(name);
      }
      record_capability_method_table(name, stmt.value, ctx);
      if (ctx.dynamic_capability_tables.has(name)) {
        const methods = ctx.capability_methods.get(name);
        if (!methods) {
          throw new Error("Missing dynamic capability method facts: " + name);
        }
        value = strip_capability_method_fields(value, methods);
      }

      return {
        tag: "bind",
        kind: stmt.kind,
        name,
        is_linear: stmt.is_linear,
        annotation: resolve_core_annotation(ctx, stmt.annotation),
        value,
      };
    }

    case "assign": {
      resolve_bound_core_value_name(ctx, stmt.name);
      const value = core_expr(stmt.value, ctx);

      if (stmt.mode === "change") {
        const name = shadow_core_name(ctx, stmt.name);
        ctx.linear_names.delete(name);
        record_capability_method_table(name, stmt.value, ctx);
        return {
          tag: "bind",
          kind: "let",
          name,
          is_linear: false,
          annotation: undefined,
          value,
        };
      }

      const name = resolve_core_name(ctx, stmt.name);
      record_capability_method_table(name, stmt.value, ctx);

      return {
        tag: "assign",
        name,
        mode: stmt.mode,
        value,
      };
    }

    case "index_assign":
      resolve_bound_core_value_name(ctx, stmt.name);
      return {
        tag: "index_assign",
        name: resolve_core_name(ctx, stmt.name),
        index: core_expr(stmt.index, ctx),
        value: core_expr(stmt.value, ctx),
      };

    case "for_range": {
      const body_ctx = fork_core_from_source_ctx(ctx);
      body_ctx.aliases.set(stmt.index, stmt.index);
      const body = stmt.body.map((item) => core_stmt(item, body_ctx));
      return {
        tag: "range_loop",
        index: stmt.index,
        start: core_expr(stmt.start, ctx),
        end: core_expr(stmt.end, ctx),
        step: core_expr(stmt.step, ctx),
        carried: carried_names(body),
        body,
      };
    }

    case "for_collection": {
      const body_ctx = fork_core_from_source_ctx(ctx);
      body_ctx.aliases.set(stmt.item, stmt.item);

      if (stmt.index) {
        body_ctx.aliases.set(stmt.index, stmt.index);
      }

      const body = stmt.body.map((item) => core_stmt(item, body_ctx));
      return {
        tag: "collection_loop",
        index: stmt.index,
        item: stmt.item,
        collection: core_expr(stmt.collection, ctx),
        carried: carried_names(body),
        body,
      };
    }

    case "if_stmt": {
      const body_ctx = fork_core_from_source_ctx(ctx);
      return {
        tag: "if_stmt",
        cond: core_expr(stmt.cond, ctx),
        body: stmt.body.map((item) => core_stmt(item, body_ctx)),
      };
    }

    case "if_let_stmt": {
      const body_ctx = fork_core_from_source_ctx(ctx);

      if (stmt.value_name) {
        body_ctx.aliases.set(stmt.value_name, stmt.value_name);
      }

      return {
        tag: "if_let_stmt",
        case_name: stmt.case_name,
        value_name: stmt.value_name,
        target: core_expr(stmt.target, ctx),
        body: stmt.body.map((item) => core_stmt(item, body_ctx)),
      };
    }

    case "type_check":
      return {
        tag: "type_check",
        pattern: stmt.pattern,
        target: core_expr(stmt.target, ctx),
      };

    case "break": {
      const value = stmt.value ? core_expr(stmt.value, ctx) : undefined;
      return { tag: "break", value };
    }

    case "continue":
      return { tag: "continue" };

    case "return":
      return { tag: "return", value: core_expr(stmt.value, ctx) };

    case "expr": {
      const if_else = core_if_else_stmt(stmt.expr, ctx);

      if (if_else) {
        return if_else;
      }

      return { tag: "expr", expr: core_expr(stmt.expr, ctx) };
    }

    case "import":
      return {
        tag: "unsupported",
        feature: "import",
        text: stmt.name + " from " + Deno.inspect(stmt.path),
      };

    case "host_import":
      return {
        tag: "unsupported",
        feature: "host_import",
        text: stmt.value.name,
      };

    case "state_bind":
      throw new Error(
        "Effect state binding must be elaborated before Core lowering",
      );

    case "bind_pattern":
      throw new Error(
        "Module binding pattern must be elaborated before Core lowering",
      );

    case "resume_dup":
      throw new Error(
        "Resumption duplication must be elaborated before Core lowering",
      );

    case "unsupported":
      return {
        tag: "unsupported",
        feature: stmt.feature,
        text: stmt.text,
      };
  }
}

function strip_capability_method_fields(
  value: CoreExpr,
  methods: Map<string, string>,
): CoreExpr {
  if (value.tag === "var" || value.tag === "linear") {
    return value;
  }

  if (value.tag === "struct_value") {
    let type_expr = value.type_expr;
    if (type_expr.tag === "struct_type") {
      type_expr = {
        ...type_expr,
        fields: type_expr.fields.filter((field) => !methods.has(field.name)),
      };
    }
    return {
      ...value,
      type_expr,
      fields: value.fields.filter((field) => !methods.has(field.name)),
    };
  }

  if (value.tag === "if") {
    return {
      ...value,
      then_branch: strip_capability_method_fields(value.then_branch, methods),
      else_branch: strip_capability_method_fields(value.else_branch, methods),
    };
  }

  if (value.tag === "block") {
    const statements = [...value.statements];
    const final_index = statements.length - 1;
    const final_stmt = statements[final_index];
    if (!final_stmt || final_stmt.tag !== "expr") {
      throw new Error("Dynamic capability block must end in an expression");
    }
    statements[final_index] = {
      ...final_stmt,
      expr: strip_capability_method_fields(final_stmt.expr, methods),
    };
    return { ...value, statements };
  }

  throw new Error(
    "Dynamic capability table must lower to a struct or conditional struct",
  );
}

function record_capability_method_table(
  name: string,
  value: FrontExpr,
  ctx: CoreFromSourceCtx,
): void {
  const table = capability_method_table(value, ctx, new Set());

  if (!table) {
    ctx.capability_methods.delete(name);
    ctx.dynamic_capability_tables.delete(name);
    return;
  }

  ctx.capability_methods.set(name, table.methods);
  if (table.dynamic) {
    ctx.dynamic_capability_tables.add(name);
  } else {
    ctx.dynamic_capability_tables.delete(name);
  }
}

type CapabilityMethodTable = {
  methods: Map<string, string>;
  dynamic: boolean;
};

function capability_method_table(
  value: FrontExpr,
  ctx: CoreFromSourceCtx,
  seen: Set<string>,
): CapabilityMethodTable | undefined {
  if (value.tag === "captured" || value.tag === "comptime") {
    return capability_method_table(value.expr, ctx, seen);
  }

  if (value.tag === "var" || value.tag === "linear") {
    const name = resolve_core_name(ctx, value.name);
    if (seen.has(name)) {
      throw new Error("Recursive capability method table alias: " + name);
    }
    seen.add(name);
    const methods = ctx.capability_methods.get(name);
    if (!methods) {
      return undefined;
    }
    return {
      methods: new Map(methods),
      dynamic: ctx.dynamic_capability_tables.has(name),
    };
  }

  if (value.tag === "if") {
    const left = capability_method_table(value.then_branch, ctx, new Set(seen));
    const right = capability_method_table(
      value.else_branch,
      ctx,
      new Set(seen),
    );
    if (!left || !right) {
      return undefined;
    }
    return {
      methods: intersect_capability_methods(left.methods, right.methods),
      dynamic: true,
    };
  }

  if (value.tag === "block") {
    const final_stmt = value.statements[value.statements.length - 1];
    if (!final_stmt || final_stmt.tag !== "expr") {
      return undefined;
    }
    const table = capability_method_table(final_stmt.expr, ctx, seen);
    if (!table) {
      return undefined;
    }
    return { methods: table.methods, dynamic: true };
  }

  if (value.tag !== "struct_value") {
    return undefined;
  }

  const methods = new Map<string, string>();
  let dynamic = false;

  for (const field of value.fields) {
    const host_import = capability_host_import_name(field.value, ctx);
    if (host_import) {
      methods.set(field.name, host_import);
      continue;
    }
    dynamic = true;
  }

  return { methods, dynamic };
}

function capability_host_import_name(
  value: FrontExpr,
  ctx: CoreFromSourceCtx,
): string | undefined {
  if (value.tag === "captured" || value.tag === "comptime") {
    return capability_host_import_name(value.expr, ctx);
  }

  if (value.tag !== "var") {
    return undefined;
  }

  if (!ctx.host_import_names.has(value.name)) {
    return undefined;
  }

  return value.name;
}

function intersect_capability_methods(
  left: Map<string, string>,
  right: Map<string, string>,
): Map<string, string> {
  const result = new Map<string, string>();

  for (const [method, host_import] of left) {
    const other = right.get(method);
    if (other === host_import) {
      result.set(method, host_import);
    }
  }

  return result;
}

function core_recursive_binding_value(
  stmt: Extract<Stmt, { tag: "bind" }>,
  ctx: CoreFromSourceCtx,
  name: string,
): CoreExpr {
  if (stmt.value.tag === "rec") {
    const body_ctx = fork_core_from_source_ctx(ctx);

    for (const param of stmt.value.params) {
      body_ctx.aliases.set(param.name, param.name);
      if (param.is_linear) {
        body_ctx.linear_names.add(param.name);
      } else {
        body_ctx.linear_names.delete(param.name);
      }
    }

    return {
      tag: "rec",
      params: stmt.value.params.map((param) => core_param(param, ctx)),
      body: core_expr(stmt.value.body, body_ctx),
    };
  }

  if (stmt.value.tag !== "lam") {
    throw new Error("Cannot lower recursive source binding to Core yet");
  }

  const params = stmt.value.params.map((param) => core_param(param, ctx));
  let is_tail = true;

  try {
    validate_named_recursive_tail_binding(stmt.name, stmt.value);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    if (
      error.message !== "Cannot lower recursive source binding to Core yet"
    ) {
      throw error;
    }

    is_tail = false;
  }

  if (!is_tail) {
    ctx.namedRecs.set(name, { params, body: undefined });
  }

  const body_ctx = fork_core_from_source_ctx(ctx);

  if (is_tail) {
    body_ctx.aliases.set(stmt.name, "rec");
  } else {
    body_ctx.aliases.set(stmt.name, name);
    body_ctx.namedRecs.set(name, { params, body: undefined });
  }

  for (const param of stmt.value.params) {
    body_ctx.aliases.set(param.name, param.name);
    if (param.is_linear) {
      body_ctx.linear_names.add(param.name);
    } else {
      body_ctx.linear_names.delete(param.name);
    }
  }

  const body = core_expr(stmt.value.body, body_ctx);

  if (!is_tail) {
    ctx.namedRecs.set(name, { params, body });
    return { tag: "rec_ref", name, params };
  }

  return { tag: "rec", params, body };
}

function carried_names(stmts: CoreStmt[]): string[] {
  const names: string[] = [];

  function add(name: string): void {
    if (!names.includes(name)) {
      names.push(name);
    }
  }

  function visit(stmt: CoreStmt): void {
    switch (stmt.tag) {
      case "assign":
      case "index_assign":
        add(stmt.name);
        return;

      case "range_loop":
      case "collection_loop":
        for (const name of stmt.carried) {
          add(name);
        }

        return;

      case "if_stmt":
      case "if_let_stmt":
        for (const item of stmt.body) {
          visit(item);
        }

        return;

      case "if_else_stmt":
        for (const item of stmt.then_body) {
          visit(item);
        }

        for (const item of stmt.else_body) {
          visit(item);
        }

        return;

      case "bind":
      case "type_check":
      case "break":
      case "continue":
      case "return":
      case "expr":
      case "unsupported":
        return;
    }
  }

  for (const stmt of stmts) {
    visit(stmt);
  }

  return names;
}

function core_if_else_stmt(
  expr: FrontExpr,
  ctx: CoreFromSourceCtx,
): CoreStmt | undefined {
  if (expr.tag !== "if") {
    return undefined;
  }

  const then_body = block_body(expr.then_branch);

  if (!then_body) {
    return undefined;
  }

  if (
    block_produces_value(then_body) &&
    conditional_branch_produces_value(expr.else_branch)
  ) {
    return undefined;
  }

  const then_ctx = fork_core_from_source_ctx(ctx);
  const else_ctx = fork_core_from_source_ctx(ctx);

  return {
    tag: "if_else_stmt",
    cond: core_expr(expr.cond, ctx),
    then_body: then_body.map((stmt) => core_stmt(stmt, then_ctx)),
    else_body: core_conditional_branch_stmts(expr.else_branch, else_ctx),
  };
}

function core_conditional_branch_stmts(
  expr: FrontExpr,
  ctx: CoreFromSourceCtx,
): CoreStmt[] {
  const body = block_body(expr);

  if (body) {
    return body.map((stmt) => core_stmt(stmt, ctx));
  }

  const nested = core_if_else_stmt(expr, ctx);

  if (nested) {
    return [nested];
  }

  return [{ tag: "expr", expr: core_expr(expr, ctx) }];
}

function conditional_branch_produces_value(expr: FrontExpr): boolean {
  const body = block_body(expr);

  if (body) {
    return block_produces_value(body);
  }

  if (expr.tag === "if" || expr.tag === "if_let") {
    const then_body = block_body(expr.then_branch);

    if (!then_body) {
      return true;
    }

    return block_produces_value(then_body) &&
      conditional_branch_produces_value(expr.else_branch);
  }

  return true;
}

function block_produces_value(stmts: Stmt[]): boolean {
  const stmt = stmts[stmts.length - 1];

  if (!stmt) {
    return false;
  }

  if (stmt.tag === "expr") {
    return true;
  }

  if (stmt.tag === "return") {
    return true;
  }

  return false;
}
