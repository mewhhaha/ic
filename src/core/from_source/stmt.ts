import type { FrontExpr, Stmt, TypeExpr } from "../../frontend/ast.ts";
import { format_type_expr } from "../../frontend/type_expr.ts";
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
import {
  block_body,
  core_expr,
  core_param,
  front_expr_integer_type,
  front_expr_numeric_type,
  record_param_integer_type,
} from "./expr.ts";
import { validate_named_recursive_tail_binding } from "./rec.ts";
import { record_optional_core_source_origin } from "../source_origin.ts";
import { substitute_core_call_expr } from "../substitute.ts";
import { core_runtime_buffer_builtin } from "../runtime_buffer.ts";
import {
  integer_type_from_name,
  integer_type_name,
  type IntegerType,
} from "../../integer.ts";
import { val_type_from_type_name } from "../../frontend/types.ts";

export function core_stmt(stmt: Stmt, ctx: CoreFromSourceCtx): CoreStmt {
  return record_optional_core_source_origin(
    core_stmt_untracked(stmt, ctx),
    stmt,
  );
}

function core_stmt_untracked(stmt: Stmt, ctx: CoreFromSourceCtx): CoreStmt {
  switch (stmt.tag) {
    case "bind": {
      if (stmt.mutual !== undefined) {
        return core_mutually_recursive_binding(stmt, ctx);
      }

      let result_type = stmt.type_annotation;
      while (result_type?.tag === "forall") {
        result_type = result_type.body;
      }
      if (result_type?.tag === "arrow") {
        result_type = result_type.result;
      } else {
        result_type = undefined;
      }
      const named_function = stmt.value.tag === "lam" &&
        stmt.kind === "let" &&
        result_type?.tag === "name" &&
        (ctx.runtime_aggregate_type_names.has(result_type.name) ||
          result_type.name === "Text" || result_type.name === "Bytes" ||
          val_type_from_type_name(result_type.name) !== undefined);

      if (stmt.is_recursive || stmt.managed_export || named_function) {
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
          value: core_recursive_binding_value(stmt, ctx, name, named_function),
        };
      }

      let source_value = stmt.value;

      if (stmt.kind === "const" && source_value.tag === "struct_update") {
        source_value = { ...source_value, tag: "with" };
      }

      let value = core_expr(source_value, ctx);
      if (stmt.kind === "let") {
        value = move_core_projection(value);
      }

      if (value.tag === "rec") {
        value = {
          ...value,
          result_annotation: named_rec_result_annotation(stmt, ctx),
        };
      }

      if (value.tag === "block") {
        inline_match_if_let_target(value);
      }

      const name = bind_core_name(ctx, stmt.name);

      let integer: IntegerType | undefined;

      if (stmt.annotation) {
        const annotation = resolve_core_annotation(ctx, stmt.annotation);

        if (annotation) {
          integer = integer_type_from_name(annotation);
        }
      }

      if (!integer) {
        integer = front_expr_integer_type(source_value, ctx);
      }

      if (integer) {
        ctx.integer_types.set(name, integer);

        if (integer.width > 64) {
          ctx.wide_integer_types.set(integer_type_name(integer), integer);
        }
      } else {
        ctx.integer_types.delete(name);
      }

      let numeric = front_expr_numeric_type(source_value, ctx);
      if (stmt.annotation) {
        const annotation = resolve_core_annotation(ctx, stmt.annotation);
        if (annotation) {
          const annotated_numeric = val_type_from_type_name(annotation);
          if (annotated_numeric) {
            numeric = annotated_numeric;
          }
        }
      }
      if (numeric) {
        ctx.numeric_types.set(name, numeric);
      } else {
        ctx.numeric_types.delete(name);
      }

      let is_linear = stmt.is_linear;

      if (integer && integer.width > 64) {
        is_linear = true;
      }

      if (is_linear) {
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
        value = strip_capability_method_fields(
          value,
          methods,
          ctx.host_import_names,
        );
      }

      const lowered: Extract<CoreStmt, { tag: "bind" }> = {
        tag: "bind",
        kind: stmt.kind,
        name,
        is_linear,
        annotation: resolve_core_annotation(ctx, stmt.annotation),
        value,
      };

      if (integer && integer.width > 64) {
        lowered.force_materialized = true;
      }

      return lowered;
    }

    case "assign": {
      resolve_bound_core_value_name(ctx, stmt.name);
      const value = move_core_projection(core_expr(stmt.value, ctx));

      if (value.tag === "block") {
        inline_match_if_let_target(value);
      }

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
        value: move_core_projection(core_expr(stmt.value, ctx)),
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

      const expr = core_expr(stmt.expr, ctx);

      if (expr.tag === "block") {
        inline_match_if_let_target(expr);
        const final_stmt = expr.statements[expr.statements.length - 1];

        if (final_stmt?.tag === "if_else_stmt") {
          expr.statements.push({
            tag: "expr",
            expr: { tag: "num", type: "i32", value: 0 },
          });
        }
      }

      return { tag: "expr", expr };
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

function move_core_projection(value: CoreExpr): CoreExpr {
  if (value.tag === "field" || value.tag === "index") {
    return { ...value, move: true };
  }

  return value;
}

function core_mutually_recursive_binding(
  stmt: Extract<Stmt, { tag: "bind" }>,
  ctx: CoreFromSourceCtx,
): CoreStmt {
  const additional = stmt.mutual;

  if (additional === undefined || additional.length === 0) {
    throw new Error("Mutually recursive group has no additional bindings");
  }

  const members = [stmt, ...additional];
  const names = new Map<string, string>();

  for (const member of members) {
    if (member.is_linear) {
      throw new Error("Recursive binding cannot be linear: " + member.name);
    }

    if (member.value.tag !== "lam") {
      throw new Error("Recursive binding requires a lambda: " + member.name);
    }

    const name = bind_core_name(ctx, member.name);
    const params = member.value.params.map((param) => core_param(param, ctx));
    names.set(member.name, name);
    ctx.namedRecs.set(name, {
      params,
      body: undefined,
      result_annotation: named_rec_result_annotation(member, ctx),
    });
  }

  for (const member of members) {
    if (member.value.tag !== "lam") {
      throw new Error("Recursive binding requires a lambda: " + member.name);
    }

    const name = names.get(member.name);

    if (name === undefined) {
      throw new Error("Missing Core recursive name: " + member.name);
    }

    const recursive = ctx.namedRecs.get(name);

    if (recursive === undefined) {
      throw new Error("Missing Core recursive declaration: " + member.name);
    }

    const body_ctx = fork_core_from_source_ctx(ctx);

    for (const param of member.value.params) {
      body_ctx.aliases.set(param.name, param.name);

      if (param.is_linear) {
        body_ctx.linear_names.add(param.name);
      } else {
        body_ctx.linear_names.delete(param.name);
      }
    }

    recursive.body = core_expr(member.value.body, body_ctx);
  }

  const first_name = names.get(stmt.name);

  if (first_name === undefined) {
    throw new Error("Missing first Core recursive name: " + stmt.name);
  }

  const first = ctx.namedRecs.get(first_name);

  if (first === undefined) {
    throw new Error("Missing first Core recursive declaration: " + stmt.name);
  }

  return {
    tag: "bind",
    kind: "let",
    name: first_name,
    is_linear: false,
    annotation: resolve_core_annotation(ctx, stmt.annotation),
    value: {
      tag: "rec_ref",
      name: first_name,
      params: first.params,
      result_annotation: first.result_annotation,
    },
  };
}

function inline_match_if_let_target(
  expr: Extract<CoreExpr, { tag: "block" }>,
): void {
  const final_stmt = expr.statements[expr.statements.length - 1];

  if (final_stmt?.tag !== "expr" || final_stmt.expr.tag !== "if_let") {
    return;
  }

  const target = final_stmt.expr.target;

  if (target.tag !== "var" || !target.name.startsWith("_match#target")) {
    return;
  }

  const target_index = expr.statements.length - 2;
  const target_binding = expr.statements[target_index];

  if (
    target_binding?.tag !== "bind" || target_binding.name !== target.name ||
    (target_binding.value.tag !== "var" &&
      target_binding.value.tag !== "if" &&
      target_binding.value.tag !== "union_case")
  ) {
    return;
  }

  final_stmt.expr = substitute_core_call_expr(
    final_stmt.expr,
    new Map([[target.name, target_binding.value]]),
  );
  expr.statements.splice(target_index, 1);
}

function strip_capability_method_fields(
  value: CoreExpr,
  methods: Map<string, string>,
  host_import_names: Set<string>,
): CoreExpr {
  if (value.tag === "var" || value.tag === "linear") {
    return value;
  }

  if (value.tag === "struct_value") {
    const removed_names = new Set(methods.keys());
    for (const field of value.fields) {
      if (
        field.value.tag === "var" && host_import_names.has(field.value.name)
      ) {
        removed_names.add(field.name);
      }
    }
    const fields = value.fields.filter((field) => {
      return !removed_names.has(field.name);
    });
    let type_expr = value.type_expr;
    if (type_expr.tag === "struct_type") {
      type_expr = {
        ...type_expr,
        fields: type_expr.fields.filter((field) => {
          return !removed_names.has(field.name);
        }),
      };
    } else if (type_expr.tag === "var" && type_expr.name === "object_type") {
      type_expr = {
        tag: "struct_type",
        fields: fields.map((field) => {
          return {
            name: field.name,
            type_name: runtime_capability_field_type_name(
              field.name,
              field.value,
            ),
          };
        }),
      };
    }
    return {
      ...value,
      type_expr,
      fields,
    };
  }

  if (value.tag === "if") {
    return {
      ...value,
      then_branch: strip_capability_method_fields(
        value.then_branch,
        methods,
        host_import_names,
      ),
      else_branch: strip_capability_method_fields(
        value.else_branch,
        methods,
        host_import_names,
      ),
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
      expr: strip_capability_method_fields(
        final_stmt.expr,
        methods,
        host_import_names,
      ),
    };
    return { ...value, statements };
  }

  throw new Error(
    "Dynamic capability table must lower to a struct or conditional struct",
  );
}

function runtime_capability_field_type_name(
  field_name: string,
  value: CoreExpr,
): string {
  if (value.tag === "num") {
    if (value.type === "i32") {
      return "I32";
    }
    if (value.type === "i64") {
      return "I64";
    }
    if (value.type === "f32") {
      return "F32";
    }

    if (value.type === "f64") {
      return "F64";
    }
  }
  if (value.tag === "text") {
    return "Text";
  }
  if (value.tag === "borrow" || value.tag === "freeze") {
    return runtime_capability_field_type_name(field_name, value.value);
  }
  if (value.tag === "comptime") {
    return runtime_capability_field_type_name(field_name, value.expr);
  }
  if (value.tag === "scratch") {
    return runtime_capability_field_type_name(field_name, value.body);
  }
  if (value.tag === "app" && value.func.tag === "var") {
    const runtime_buffer_builtin = core_runtime_buffer_builtin(value);

    if (runtime_buffer_builtin) {
      if (runtime_buffer_builtin.result === "bytes") {
        return "Bytes";
      }

      return "Text";
    }

    if (value.func.name === "@Bytes.generate") {
      return "Bytes";
    }

    if (value.func.name === "@append" || value.func.name === "@slice") {
      return "Text";
    }
    if (
      value.func.name === "@runtime_i32_slice" ||
      value.func.name === "@runtime_text_slice"
    ) {
      return "I32";
    }
  }
  if (value.tag === "union_case" && value.type_expr?.tag === "var") {
    return value.type_expr.name;
  }
  if (
    value.tag === "struct_value" && value.type_expr.tag === "var" &&
    value.type_expr.name !== "object_type"
  ) {
    return value.type_expr.name;
  }
  if (value.tag === "if") {
    const then_type = runtime_capability_field_type_name(
      field_name,
      value.then_branch,
    );
    const else_type = runtime_capability_field_type_name(
      field_name,
      value.else_branch,
    );
    if (then_type !== else_type) {
      throw new Error(
        "Dynamic capability field " + field_name +
          " has incompatible branch types: " + then_type + " and " +
          else_type,
      );
    }
    return then_type;
  }
  if (value.tag === "block") {
    const final_stmt = value.statements[value.statements.length - 1];
    if (final_stmt?.tag === "expr") {
      return runtime_capability_field_type_name(field_name, final_stmt.expr);
    }
    if (final_stmt?.tag === "return") {
      return runtime_capability_field_type_name(field_name, final_stmt.value);
    }
  }
  throw new Error(
    "Cannot infer dynamic capability field " + field_name +
      " runtime type from " + value.tag,
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

  if (value.tag === "product") {
    const methods = new Map<string, string>();
    let dynamic = false;

    for (const entry of value.entries) {
      if (entry.label === undefined) {
        dynamic = true;
        continue;
      }

      const host_import = capability_host_import_name(entry.value, ctx);

      if (host_import) {
        methods.set(entry.label, host_import);
      } else {
        dynamic = true;
      }
    }

    if (methods.size === 0) {
      return undefined;
    }

    return { methods, dynamic };
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

  if (methods.size === 0) {
    return undefined;
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
  force_named = false,
): CoreExpr {
  if (stmt.managed_export || force_named) {
    if (stmt.value.tag !== "lam" && stmt.value.tag !== "rec") {
      throw new Error(
        "Named function must be a lambda or recursive function: " +
          stmt.name,
      );
    }

    const params = stmt.value.params.map((param) => core_param(param, ctx));
    const result_annotation = named_rec_result_annotation(stmt, ctx);
    ctx.namedRecs.set(name, { params, body: undefined, result_annotation });
    const body_ctx = fork_core_from_source_ctx(ctx);
    body_ctx.aliases.set(stmt.name, name);
    body_ctx.aliases.set("rec", name);
    body_ctx.namedRecs.set(name, {
      params,
      body: undefined,
      result_annotation,
    });

    for (const param of stmt.value.params) {
      body_ctx.aliases.set(param.name, param.name);
      record_param_integer_type(param, body_ctx);

      if (param.is_linear) {
        body_ctx.linear_names.add(param.name);
      } else {
        body_ctx.linear_names.delete(param.name);
      }
    }

    const body = core_expr(stmt.value.body, body_ctx);
    ctx.namedRecs.set(name, { params, body, result_annotation });
    return { tag: "rec_ref", name, params, result_annotation };
  }

  if (stmt.value.tag === "rec") {
    const body_ctx = fork_core_from_source_ctx(ctx);

    for (const param of stmt.value.params) {
      body_ctx.aliases.set(param.name, param.name);
      record_param_integer_type(param, body_ctx);
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
      result_annotation: named_rec_result_annotation(stmt, ctx),
    };
  }

  if (stmt.value.tag !== "lam") {
    throw new Error("Cannot lower recursive source binding to Core yet");
  }

  const params = stmt.value.params.map((param) => core_param(param, ctx));
  const result_annotation = named_rec_result_annotation(stmt, ctx);
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
    ctx.namedRecs.set(name, { params, body: undefined, result_annotation });
  }

  const body_ctx = fork_core_from_source_ctx(ctx);

  if (is_tail) {
    body_ctx.aliases.set(stmt.name, "rec");
  } else {
    body_ctx.aliases.set(stmt.name, name);
    body_ctx.namedRecs.set(name, {
      params,
      body: undefined,
      result_annotation,
    });
  }

  for (const param of stmt.value.params) {
    body_ctx.aliases.set(param.name, param.name);
    record_param_integer_type(param, body_ctx);
    if (param.is_linear) {
      body_ctx.linear_names.add(param.name);
    } else {
      body_ctx.linear_names.delete(param.name);
    }
  }

  const body = core_expr(stmt.value.body, body_ctx);

  if (!is_tail) {
    ctx.namedRecs.set(name, { params, body, result_annotation });
    return { tag: "rec_ref", name, params, result_annotation };
  }

  return {
    tag: "rec",
    params,
    body,
    result_annotation: named_rec_result_annotation(stmt, ctx),
  };
}

function named_rec_result_annotation(
  stmt: { type_annotation?: TypeExpr },
  ctx: CoreFromSourceCtx,
): string | undefined {
  let type: TypeExpr | undefined = stmt.type_annotation;

  while (type?.tag === "forall") {
    type = type.body;
  }

  if (type?.tag !== "arrow") {
    return undefined;
  }

  return resolve_core_annotation(ctx, format_type_expr(type.result));
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

  const then_produces_value = block_produces_value(then_body);
  const else_produces_value = conditional_branch_produces_value(
    expr.else_branch,
  );

  if (
    (then_produces_value || block_definitely_exits(then_body)) &&
    (else_produces_value || expr_definitely_exits(expr.else_branch))
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

function block_definitely_exits(stmts: Stmt[]): boolean {
  for (const stmt of stmts) {
    if (
      stmt.tag === "break" || stmt.tag === "continue" ||
      stmt.tag === "return"
    ) {
      return true;
    }

    if (stmt.tag === "expr" && expr_definitely_exits(stmt.expr)) {
      return true;
    }
  }

  return false;
}

function expr_definitely_exits(expr: FrontExpr): boolean {
  const body = block_body(expr);

  if (body) {
    return block_definitely_exits(body);
  }

  if (expr.tag === "if") {
    return expr_definitely_exits(expr.then_branch) &&
      expr_definitely_exits(expr.else_branch);
  }

  if (expr.tag === "if_let") {
    if (expr.implicit_else) {
      return false;
    }

    return expr_definitely_exits(expr.then_branch) &&
      expr_definitely_exits(expr.else_branch);
  }

  return false;
}
