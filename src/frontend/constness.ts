import type { Env, FrontExpr, Stmt } from "./ast.ts";
import { lookup } from "./env.ts";
import { is_builtin_type_name } from "./types.ts";
import { pattern_bindings } from "./pattern.ts";

const stable_compiler_callable_names = new Set([
  "@append",
  "@slice",
  "@bit_and",
  "@bit_or",
  "@bit_xor",
  "@shift_left",
  "@shift_right_u",
  "@f32_sqrt",
  "@f32_from_i32",
  "@i32_from_f32",
  "@unsafe_i32_wrap_i64",
  "@unsafe_i64_extend_i32_signed",
  "@unsafe_i64_extend_i32_unsigned",
  "@unsafe_i32_reinterpret_f32",
  "@unsafe_f32_reinterpret_i32",
  "@as",
  "@seal",
  "@representation",
  "@format_i32",
  "@format_i64",
  "@format_f32",
  "@Bytes.generate",
  "@Utf8.encode",
  "@Utf8.decode",
  "@panic",
  "@f32x4",
  "@f32x4_splat",
  "@f32x4_add",
  "@f32x4_sub",
  "@f32x4_mul",
  "@f32x4_div",
]);

export function is_const_builtin_name(name: string): boolean {
  return name === "@fail" || name === "@size_of" || name === "@align_of" ||
    name === "@layout" || name === "@is_struct" || name === "@is_union" ||
    name === "@has" || name === "@fields_of" || name === "@cases_of" ||
    name === "@describe_type" || name === "@describe_fields" ||
    name === "@describe_cases" ||
    name === "@construct" || name === "@project" || name === "@is_case" ||
    name === "@len" || name === "@get" ||
    name === "@shape.entries" || name === "@type.product" ||
    name === "@type.namespace" || name === "@type.union" ||
    name === "@type.intersection" || name === "@type.difference" ||
    is_builtin_type_name(name) ||
    name === "object_type" || name === "layout_type" ||
    name === "field_offsets_type";
}

export function validate_const_expr(
  expr: FrontExpr,
  env: Env,
  bound: Set<string>,
  message: string,
): void {
  switch (expr.tag) {
    case "bool":
    case "num":
    case "atom":
    case "unit":
    case "text":
    case "type_name":
    case "set_type":
    case "struct_type":
    case "union_type":
      return;

    case "is":
    case "as":
      validate_const_expr(expr.value, env, bound, message);
      return;

    case "product":
    case "shape":
      for (const entry of expr.entries) {
        validate_const_expr(entry.value, env, bound, message);
      }
      return;

    case "array":
      for (const item of expr.items) {
        validate_const_expr(item, env, bound, message);
      }

      if (expr.rest !== undefined) {
        validate_const_expr(expr.rest, env, bound, message);
      }
      return;

    case "array_repeat":
      validate_const_expr(expr.value, env, bound, message);
      validate_const_expr(expr.length, env, bound, message);
      return;

    case "import":
      return;

    case "match":
      validate_const_expr(expr.target, env, bound, message);

      for (const arm of expr.arms) {
        const local = new Set(bound);

        for (const binding of pattern_bindings(arm.pattern)) {
          local.add(binding.name);
        }

        if (arm.guard !== undefined) {
          validate_const_expr(arm.guard, env, local, message);
        }

        validate_const_expr(arm.body, env, local, message);
      }
      return;

    case "var": {
      if (bound.has(expr.name)) {
        return;
      }

      if (
        is_const_builtin_name(expr.name) ||
        stable_compiler_callable_names.has(expr.name)
      ) {
        return;
      }

      const binding = lookup(env, expr.name);

      if (binding && binding.is_const) {
        return;
      }

      throw new Error(message + ": " + expr.name);
    }

    case "prim":
      validate_const_expr(expr.left, env, bound, message);
      validate_const_expr(expr.right, env, bound, message);
      return;

    case "lam": {
      const local = new Set(bound);

      for (const param of expr.params) {
        local.add(param.name);
      }

      validate_const_expr(expr.body, env, local, message);
      return;
    }

    case "rec": {
      const local = new Set(bound);
      local.add("rec");

      for (const param of expr.params) {
        local.add(param.name);
      }

      validate_const_expr(expr.body, env, local, message);
      return;
    }

    case "app":
      validate_const_expr(expr.func, env, bound, message);

      for (const arg of expr.args) {
        validate_const_expr(arg, env, bound, message);
      }

      return;

    case "block":
      validate_const_block(expr.statements, env, bound, message);
      return;

    case "comptime":
      validate_const_expr(expr.expr, env, bound, message);
      return;

    case "borrow":
      validate_const_expr(expr.value, env, bound, message);
      return;

    case "freeze":
      validate_const_expr(expr.value, env, bound, message);
      return;

    case "scratch":
      validate_const_expr(expr.body, env, bound, message);
      return;

    case "loop":
      throw new Error(message);

    case "captured":
      validate_const_expr(expr.expr, expr.env, bound, message);
      return;

    case "with":
      validate_const_expr(expr.base, env, bound, message);

      for (const field of expr.fields) {
        validate_const_expr(field.value, env, bound, message);
      }

      return;

    case "type_with":
      validate_const_expr(expr.base, env, bound, message);

      for (const member of expr.members) {
        validate_const_expr(member.name, env, bound, message);
        validate_const_expr(member.value, env, bound, message);
      }

      return;

    case "struct_value":
      validate_const_expr(expr.type_expr, env, bound, message);

      for (const field of expr.fields) {
        validate_const_expr(field.value, env, bound, message);
      }

      return;

    case "struct_update":
      validate_const_expr(expr.base, env, bound, message);

      for (const field of expr.fields) {
        validate_const_expr(field.value, env, bound, message);
      }

      return;

    case "if":
      validate_const_expr(expr.cond, env, bound, message);
      validate_const_expr(expr.then_branch, env, bound, message);
      validate_const_expr(expr.else_branch, env, bound, message);
      return;

    case "if_let": {
      const local = new Set(bound);
      validate_const_expr(expr.target, env, bound, message);

      if (expr.value_name) {
        local.add(expr.value_name);
      }

      validate_const_expr(expr.then_branch, env, local, message);
      validate_const_expr(expr.else_branch, env, bound, message);
      return;
    }

    case "field":
      validate_const_expr(expr.object, env, bound, message);
      return;

    case "index":
      validate_const_expr(expr.object, env, bound, message);
      validate_const_expr(expr.index, env, bound, message);
      return;

    case "union_case":
      if (expr.type_expr) {
        validate_const_expr(expr.type_expr, env, bound, message);
      }

      if (expr.value) {
        validate_const_expr(expr.value, env, bound, message);
      }

      return;

    case "linear":
      if (bound.has(expr.name)) {
        return;
      }

      throw new Error(message + ": " + expr.name);

    case "handler":
    case "try_with":
      throw new Error(message + ": " + expr.tag);

    case "unsupported":
      return;
  }
}

function validate_const_block(
  stmts: Stmt[],
  env: Env,
  bound: Set<string>,
  message: string,
): void {
  const local = new Set(bound);

  for (const stmt of stmts) {
    if (stmt.tag === "bind") {
      if (stmt.is_linear) {
        throw new Error(
          "Cannot evaluate linear binding at compile time: " + stmt.name,
        );
      }

      validate_const_expr(stmt.value, env, local, message);
      local.add(stmt.name);
      continue;
    }

    if (stmt.tag === "assign") {
      validate_const_expr(stmt.value, env, local, message);
      local.add(stmt.name);
      continue;
    }

    if (stmt.tag === "index_assign") {
      validate_const_expr(stmt.index, env, local, message);
      validate_const_expr(stmt.value, env, local, message);
      local.add(stmt.name);
      continue;
    }

    if (stmt.tag === "return") {
      validate_const_expr(stmt.value, env, local, message);
      continue;
    }

    if (stmt.tag === "expr") {
      validate_const_expr(stmt.expr, env, local, message);
      continue;
    }

    if (stmt.tag === "for_range") {
      validate_const_expr(stmt.start, env, local, message);
      validate_const_expr(stmt.end, env, local, message);
      validate_const_expr(stmt.step, env, local, message);

      const body_bound = new Set(local);
      body_bound.add(stmt.index);
      validate_const_block(stmt.body, env, body_bound, message);
      continue;
    }

    if (stmt.tag === "for_collection") {
      validate_const_expr(stmt.collection, env, local, message);

      const body_bound = new Set(local);

      if (stmt.index) {
        body_bound.add(stmt.index);
      }

      body_bound.add(stmt.item);
      validate_const_block(stmt.body, env, body_bound, message);
      continue;
    }

    if (stmt.tag === "if_stmt") {
      validate_const_expr(stmt.cond, env, local, message);
      validate_const_block(stmt.body, env, local, message);
      continue;
    }

    if (stmt.tag === "if_let_stmt") {
      validate_const_expr(stmt.target, env, local, message);

      const body_bound = new Set(local);

      if (stmt.value_name) {
        body_bound.add(stmt.value_name);
      }

      validate_const_block(stmt.body, env, body_bound, message);
      continue;
    }

    if (stmt.tag === "type_check") {
      validate_const_expr(stmt.target, env, local, message);
      continue;
    }

    if (stmt.tag === "break" || stmt.tag === "continue") {
      continue;
    }

    if (stmt.tag === "import" || stmt.tag === "host_import") {
      continue;
    }
  }
}
