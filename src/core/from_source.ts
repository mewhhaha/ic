import type {
  FrontExpr,
  FrontHostImportArgContract,
  FrontHostImportOwnerReason,
  FrontHostImportResultContract,
  Source as SourceNode,
  Stmt,
} from "../frontend/ast.ts";
import type {
  Core,
  CoreExpr,
  CoreField,
  CoreHostImport,
  CoreHostImportArgContract,
  CoreHostImportOwnerReason,
  CoreHostImportResultContract,
  CoreParam,
  CoreStmt,
  CoreTypeField,
} from "./ast.ts";

export function core_from_source(source: SourceNode): Core {
  const ctx = create_core_from_source_ctx();
  const host_imports: Record<string, CoreHostImport> = {};
  const statements: CoreStmt[] = [];

  for (const stmt of source.statements) {
    if (stmt.tag === "host_import") {
      ctx.host_import_names.add(stmt.value.name);
      host_imports[stmt.value.name] = {
        name: stmt.value.name,
        module: stmt.value.module,
        field: stmt.value.field,
        params: stmt.value.params,
        result: stmt.value.result,
        args: stmt.value.args.map((arg) =>
          core_host_import_arg_contract(arg, ctx)
        ),
        result_owner: core_host_import_result_contract(
          stmt.value.result_owner,
          ctx,
        ),
      };
    } else {
      record_core_from_source_type_value(stmt, ctx);
      statements.push(core_stmt(stmt, ctx));
    }
  }

  const core: Core = {
    tag: "program",
    statements,
  };

  if (Object.keys(host_imports).length > 0) {
    core.host_imports = host_imports;
  }

  return core;
}

function core_host_import_arg_contract(
  arg: FrontHostImportArgContract,
  ctx: CoreFromSourceCtx,
): CoreHostImportArgContract {
  switch (arg.tag) {
    case "scalar":
      return { tag: "scalar" };

    case "bounded_borrow":
      core_host_import_owner_reason(arg.reason, ctx);
      return { tag: "bounded_borrow" };

    case "frozen_shareable":
      core_host_import_owner_reason(arg.reason, ctx);
      return { tag: "frozen_shareable" };

    case "ownership_transfer":
      core_host_import_owner_reason(arg.reason, ctx);
      return { tag: "ownership_transfer" };
  }
}

function core_host_import_result_contract(
  owner: FrontHostImportResultContract | undefined,
  ctx: CoreFromSourceCtx,
): CoreHostImportResultContract | undefined {
  if (!owner) {
    return undefined;
  }

  switch (owner.tag) {
    case "scalar":
      return { tag: "scalar" };

    case "unique_heap":
      return {
        tag: "unique_heap",
        reason: core_host_import_owner_reason(owner.reason, ctx),
      };

    case "frozen_shareable":
      if (owner.reason === "freeze") {
        return {
          tag: "frozen_shareable",
          reason: "freeze",
        };
      }

      return {
        tag: "frozen_shareable",
        reason: core_host_import_owner_reason(owner.reason, ctx),
      };
  }
}

type CoreFromSourceCtx = {
  aliases: Map<string, string>;
  host_import_const_names: Set<string>;
  host_import_names: Set<string>;
  host_import_type_values: Map<string, CoreHostImportOwnerReason>;
  linear_names: Set<string>;
  fresh: { next: number };
};

function create_core_from_source_ctx(): CoreFromSourceCtx {
  return {
    aliases: new Map(),
    host_import_const_names: new Set(),
    host_import_names: new Set(),
    host_import_type_values: new Map(),
    linear_names: new Set(),
    fresh: { next: 0 },
  };
}

function fork_core_from_source_ctx(
  ctx: CoreFromSourceCtx,
): CoreFromSourceCtx {
  return {
    aliases: new Map(ctx.aliases),
    host_import_const_names: new Set(ctx.host_import_const_names),
    host_import_names: new Set(ctx.host_import_names),
    host_import_type_values: new Map(ctx.host_import_type_values),
    linear_names: new Set(ctx.linear_names),
    fresh: ctx.fresh,
  };
}

function record_core_from_source_type_value(
  stmt: Stmt,
  ctx: CoreFromSourceCtx,
): void {
  if (stmt.tag !== "bind") {
    return;
  }

  if (stmt.kind !== "const") {
    return;
  }

  ctx.host_import_const_names.add(stmt.name);
  const reason = front_host_import_type_value_reason(
    stmt.value,
    ctx,
    new Set(),
  );

  if (!reason) {
    ctx.host_import_type_values.delete(stmt.name);
    return;
  }

  ctx.host_import_type_values.set(stmt.name, reason);
}

function front_host_import_type_value_reason(
  expr: FrontExpr,
  ctx: CoreFromSourceCtx,
  seen: Set<string>,
): CoreHostImportOwnerReason | undefined {
  switch (expr.tag) {
    case "struct_type":
      return "runtime_aggregate";

    case "union_type":
      return "runtime_union";

    case "var": {
      if (seen.has(expr.name)) {
        throw new Error("Recursive host import owner type alias: " + expr.name);
      }

      const reason = ctx.host_import_type_values.get(expr.name);

      if (!reason) {
        return undefined;
      }

      seen.add(expr.name);
      return reason;
    }

    case "comptime":
      return front_host_import_type_value_reason(expr.expr, ctx, seen);

    case "captured":
      return front_host_import_type_value_reason(expr.expr, ctx, seen);

    default:
      return undefined;
  }
}

function core_host_import_owner_reason(
  reason: FrontHostImportOwnerReason,
  ctx: CoreFromSourceCtx,
): CoreHostImportOwnerReason {
  if (typeof reason === "string") {
    return reason;
  }

  const resolved = ctx.host_import_type_values.get(reason.name);

  if (!resolved) {
    if (ctx.host_import_const_names.has(reason.name)) {
      throw new Error(
        "Host import owner type " + reason.name +
          " must resolve to a struct or union type-value",
      );
    }

    throw new Error("Missing host import owner type value: " + reason.name);
  }

  return resolved;
}

function resolve_core_name(ctx: CoreFromSourceCtx, name: string): string {
  const alias = ctx.aliases.get(name);

  if (alias) {
    return alias;
  }

  return name;
}

function bind_core_name(ctx: CoreFromSourceCtx, name: string): string {
  let bound = name;

  if (ctx.aliases.has(name)) {
    bound = fresh_core_shadow_name(ctx, name);
  }

  ctx.aliases.set(name, bound);
  return bound;
}

function shadow_core_name(ctx: CoreFromSourceCtx, name: string): string {
  const bound = fresh_core_shadow_name(ctx, name);
  ctx.aliases.set(name, bound);
  return bound;
}

function fresh_core_shadow_name(
  ctx: CoreFromSourceCtx,
  name: string,
): string {
  const fresh = "_" + name + "#shadow" + ctx.fresh.next.toString();
  ctx.fresh.next += 1;
  return fresh;
}

function core_stmt(stmt: Stmt, ctx: CoreFromSourceCtx): CoreStmt {
  switch (stmt.tag) {
    case "bind": {
      if (stmt.is_recursive) {
        throw new Error("Cannot lower recursive source binding to Core yet");
      }

      const value = core_expr(stmt.value, ctx);
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
        annotation: stmt.annotation,
        value,
      };
    }

    case "assign": {
      const value = core_expr(stmt.value, ctx);

      if (stmt.mode === "change") {
        const name = shadow_core_name(ctx, stmt.name);
        ctx.linear_names.delete(name);
        return {
          tag: "bind",
          kind: "let",
          name,
          is_linear: false,
          annotation: undefined,
          value,
        };
      }

      return {
        tag: "assign",
        name: resolve_core_name(ctx, stmt.name),
        mode: stmt.mode,
        value,
      };
    }

    case "index_assign":
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

    case "break":
      return { tag: "break" };

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

    case "unsupported":
      return {
        tag: "unsupported",
        feature: stmt.feature,
        text: stmt.text,
      };
  }
}

function core_expr(expr: FrontExpr, ctx: CoreFromSourceCtx): CoreExpr {
  switch (expr.tag) {
    case "num":
      return { tag: "num", type: expr.type, value: expr.value };

    case "text":
      return { tag: "text", value: expr.value };

    case "type_name":
      return { tag: "type_name", name: expr.name };

    case "var":
      return { tag: "var", name: resolve_core_name(ctx, expr.name) };

    case "linear":
      return { tag: "linear", name: resolve_core_name(ctx, expr.name) };

    case "prim":
      return {
        tag: "prim",
        prim: expr.prim,
        args: [core_expr(expr.left, ctx), core_expr(expr.right, ctx)],
      };

    case "lam": {
      const body_ctx = fork_core_from_source_ctx(ctx);

      for (const param of expr.params) {
        body_ctx.aliases.set(param.name, param.name);
        if (param.is_linear) {
          body_ctx.linear_names.add(param.name);
        } else {
          body_ctx.linear_names.delete(param.name);
        }
      }

      return {
        tag: "lam",
        params: expr.params.map(core_param),
        body: core_expr(expr.body, body_ctx),
      };
    }

    case "rec": {
      const body_ctx = fork_core_from_source_ctx(ctx);

      for (const param of expr.params) {
        body_ctx.aliases.set(param.name, param.name);
        if (param.is_linear) {
          body_ctx.linear_names.add(param.name);
        } else {
          body_ctx.linear_names.delete(param.name);
        }
      }

      return {
        tag: "rec",
        params: expr.params.map(core_param),
        body: core_expr(expr.body, body_ctx),
      };
    }

    case "app": {
      const host_method = core_host_import_method_app(expr, ctx);

      if (host_method) {
        return host_method;
      }

      return {
        tag: "app",
        func: core_expr(expr.func, ctx),
        args: expr.args.map((arg) => core_expr(arg, ctx)),
      };
    }

    case "block": {
      const block_ctx = fork_core_from_source_ctx(ctx);
      return {
        tag: "block",
        statements: expr.statements.map((stmt) => core_stmt(stmt, block_ctx)),
      };
    }

    case "comptime":
      return { tag: "comptime", expr: core_expr(expr.expr, ctx) };

    case "borrow":
      return { tag: "borrow", value: core_expr(expr.value, ctx) };

    case "freeze":
      return { tag: "freeze", value: core_expr(expr.value, ctx) };

    case "scratch":
      return { tag: "scratch", body: core_expr(expr.body, ctx) };

    case "captured":
      return core_expr(expr.expr, ctx);

    case "with":
      return {
        tag: "with",
        base: core_expr(expr.base, ctx),
        fields: expr.fields.map((field) => core_field(field, ctx)),
      };

    case "struct_type":
      return {
        tag: "struct_type",
        fields: expr.fields.map(core_type_field),
      };

    case "struct_value":
      return {
        tag: "struct_value",
        type_expr: core_expr(expr.type_expr, ctx),
        fields: expr.fields.map((field) => core_field(field, ctx)),
      };

    case "struct_update":
      return {
        tag: "struct_update",
        base: core_expr(expr.base, ctx),
        fields: expr.fields.map((field) => core_field(field, ctx)),
      };

    case "union_type":
      return {
        tag: "union_type",
        cases: expr.cases.map(core_type_field),
      };

    case "if":
      return {
        tag: "if",
        cond: core_expr(expr.cond, ctx),
        then_branch: core_expr(
          expr.then_branch,
          fork_core_from_source_ctx(ctx),
        ),
        else_branch: core_expr(
          expr.else_branch,
          fork_core_from_source_ctx(ctx),
        ),
        implicit_else: expr.implicit_else,
      };

    case "if_let": {
      const then_ctx = fork_core_from_source_ctx(ctx);

      if (expr.value_name) {
        then_ctx.aliases.set(expr.value_name, expr.value_name);
      }

      return {
        tag: "if_let",
        case_name: expr.case_name,
        value_name: expr.value_name,
        target: core_expr(expr.target, ctx),
        then_branch: core_expr(expr.then_branch, then_ctx),
        else_branch: core_expr(
          expr.else_branch,
          fork_core_from_source_ctx(ctx),
        ),
        implicit_else: expr.implicit_else,
      };
    }

    case "field":
      return {
        tag: "field",
        object: core_expr(expr.object, ctx),
        name: expr.name,
      };

    case "index":
      return {
        tag: "index",
        object: core_expr(expr.object, ctx),
        index: core_expr(expr.index, ctx),
      };

    case "union_case": {
      let value: CoreExpr | undefined;
      let type_expr: CoreExpr | undefined;

      if (expr.value) {
        value = core_expr(expr.value, ctx);
      }

      if (expr.type_expr) {
        type_expr = core_expr(expr.type_expr, ctx);
      }

      return {
        tag: "union_case",
        name: expr.name,
        value,
        type_expr,
      };
    }

    case "unsupported":
      return {
        tag: "unsupported",
        feature: expr.feature,
        text: expr.text,
      };
  }
}

function core_host_import_method_app(
  expr: Extract<FrontExpr, { tag: "app" }>,
  ctx: CoreFromSourceCtx,
): CoreExpr | undefined {
  if (expr.func.tag !== "field") {
    return undefined;
  }

  const object = expr.func.object;

  if (object.tag !== "var" && object.tag !== "linear") {
    return undefined;
  }

  const receiver_name = resolve_core_name(ctx, object.name);

  if (!ctx.host_import_names.has(expr.func.name)) {
    if (ctx.linear_names.has(receiver_name)) {
      return {
        tag: "unsupported",
        feature: "missing_capability_method",
        text: receiver_name + "." + expr.func.name,
      };
    }

    return undefined;
  }

  const args: CoreExpr[] = [{ tag: "linear", name: receiver_name }];

  for (const arg of expr.args) {
    args.push(core_expr(arg, ctx));
  }

  return {
    tag: "app",
    func: { tag: "var", name: expr.func.name },
    args,
  };
}

function core_field(
  field: { name: string; value: FrontExpr },
  ctx: CoreFromSourceCtx,
): CoreField {
  return { name: field.name, value: core_expr(field.value, ctx) };
}

function core_param(param: {
  name: string;
  is_const: boolean;
  is_linear: boolean;
  annotation: string | undefined;
}): CoreParam {
  return {
    name: param.name,
    is_const: param.is_const,
    is_linear: param.is_linear,
    annotation: param.annotation,
  };
}

function core_type_field(
  field: { name: string; type_name: string },
): CoreTypeField {
  return { name: field.name, type_name: field.type_name };
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
  const else_body = block_body(expr.else_branch);

  if (!then_body || !else_body) {
    return undefined;
  }

  if (block_produces_value(then_body) && block_produces_value(else_body)) {
    return undefined;
  }

  const then_ctx = fork_core_from_source_ctx(ctx);
  const else_ctx = fork_core_from_source_ctx(ctx);

  return {
    tag: "if_else_stmt",
    cond: core_expr(expr.cond, ctx),
    then_body: then_body.map((stmt) => core_stmt(stmt, then_ctx)),
    else_body: else_body.map((stmt) => core_stmt(stmt, else_ctx)),
  };
}

function block_body(expr: FrontExpr): Stmt[] | undefined {
  if (expr.tag !== "block") {
    return undefined;
  }

  return expr.statements;
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
