import type { FrontExpr, Param, Pattern, Stmt } from "../../frontend/ast.ts";
import { contains_reserved_linear_effect } from "../../frontend/linear.ts";
import type { CoreExpr, CoreField, CoreParam, CoreTypeField } from "../ast.ts";
import {
  type CoreFromSourceCtx,
  fork_core_from_source_ctx,
  resolve_bound_core_value_name,
  resolve_core_annotation,
  resolve_core_name,
} from "./context.ts";
import { atom_i32 } from "../../frontend/atom.ts";
import { record_optional_core_source_origin } from "../source_origin.ts";
import {
  elaborate_array_repeat_expr,
  elaborate_fixed_array_expr,
  elaborate_product_as_expr,
  elaborate_product_expr,
} from "../../frontend/aggregate.ts";
import { numeric_builtin_call } from "../../frontend/numeric.ts";
import { Callable } from "../../trait.ts";
import { Prim } from "../../op.ts";
import { expect } from "../../expect.ts";
import { f32x4_builtin_call } from "../../frontend/f32x4.ts";
import { compiler_builtin_args } from "../../frontend/call_args.ts";
import {
  integer_bit_pattern,
  integer_type_from_name,
  integer_type_name,
  type IntegerType,
} from "../../integer.ts";

export function core_expr(expr: FrontExpr, ctx: CoreFromSourceCtx): CoreExpr {
  return record_optional_core_source_origin(
    core_expr_untracked(expr, ctx),
    expr,
  );
}

function core_expr_untracked(
  expr: FrontExpr,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  switch (expr.tag) {
    case "bool": {
      let value = 0;

      if (expr.value) {
        value = 1;
      }

      return { tag: "num", type: "i32", value };
    }

    case "atom":
      return {
        tag: "num",
        type: "i32",
        value: atom_i32(expr.name),
        atom_name: expr.name,
      };

    case "num": {
      if (expr.integer && expr.integer.width > 64) {
        register_wide_integer_type(expr.integer, ctx);
        let value: bigint;

        if (typeof expr.value === "bigint") {
          value = expr.value;
        } else {
          value = BigInt(expr.value);
        }
        return wide_integer_literal(expr.integer, value, ctx);
      }

      const lowered: CoreExpr = {
        tag: "num",
        type: expr.type,
        value: expr.value,
      };

      if (expr.integer) {
        lowered.integer = expr.integer;
      }

      return lowered;
    }

    case "unit":
      return { tag: "num", type: "i32", value: 0 };

    case "text":
      return { tag: "text", value: expr.value };

    case "type_name":
      return { tag: "type_name", name: expr.name };

    case "set_type":
      throw new Error(
        "Compile-time set type cannot be emitted as a Core result",
      );

    case "is":
      throw new Error(
        "`is` expression must be elaborated before Core lowering",
      );

    case "as":
      return core_expr(elaborate_product_as_expr(expr), ctx);

    case "match":
      throw new Error(
        "Match expression must be elaborated before Core lowering",
      );

    case "var": {
      const resolved = resolve_bound_core_value_name(ctx, expr.name);
      const named_rec = ctx.namedRecs.get(resolved) ||
        ctx.namedRecs.get(expr.name);

      if (named_rec) {
        return { tag: "rec_ref", name: resolved, params: named_rec.params };
      }

      if (expr.resume_signature) {
        return {
          tag: "var",
          name: resolved,
          resume_signature: expr.resume_signature,
        };
      }

      return { tag: "var", name: resolved };
    }

    case "linear": {
      const name = resolve_core_name(ctx, expr.name);

      if (expr.resume_signature) {
        return {
          tag: "linear",
          name,
          resume_signature: expr.resume_signature,
        };
      }

      return { tag: "linear", name };
    }

    case "prim": {
      const integer = front_expr_integer_type(expr, ctx);
      const prim: CoreExpr = {
        tag: "prim",
        prim: expr.prim,
        args: [core_expr(expr.left, ctx), core_expr(expr.right, ctx)],
        integer,
      };

      return lower_core_integer_prim(prim, integer, ctx);
    }

    case "lam": {
      const body_ctx = fork_core_from_source_ctx(ctx);
      const flattened = flattened_product_function(expr);
      let params = expr.params;
      let body = expr.body;

      if (flattened !== undefined) {
        params = flattened.params;
        body = flattened.body;
      }

      for (const param of params) {
        body_ctx.aliases.set(param.name, param.name);
        record_param_integer_type(param, body_ctx);
        if (param.is_linear) {
          body_ctx.linear_names.add(param.name);
        } else {
          body_ctx.linear_names.delete(param.name);
        }
      }

      const value: CoreExpr = {
        tag: "lam",
        params: params.map((param) => core_param(param, ctx)),
        body: core_expr(body, body_ctx),
      };
      if (contains_reserved_linear_effect(body, body_ctx.linear_names)) {
        value.is_linear_closure = true;
      }
      return value;
    }

    case "rec": {
      const body_ctx = fork_core_from_source_ctx(ctx);
      const flattened = flattened_product_function(expr);
      let params = expr.params;
      let body = expr.body;

      if (flattened !== undefined) {
        params = flattened.params;
        body = flattened.body;
      }

      for (const param of params) {
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
        params: params.map((param) => core_param(param, ctx)),
        body: core_expr(body, body_ctx),
      };
    }

    case "app": {
      if (
        expr.func.tag === "var" && expr.func.name === "@integer.wrap" &&
        !ctx.aliases.has(expr.func.name)
      ) {
        const args = compiler_builtin_args(expr);
        expect(
          args.length === 2,
          "@integer.wrap expects 2 arguments, got " + args.length.toString(),
        );
        const value = args[0];
        const target = args[1];
        expect(value, "Missing @integer.wrap value argument");
        expect(
          target && target.tag === "var",
          "@integer.wrap target must be an integer type value",
        );
        const integer = integer_type_from_name(target.name);
        expect(integer, "@integer.wrap target must be I<N> or U<N>");
        return core_integer_wrap(
          core_expr(value, ctx),
          front_expr_integer_type(value, ctx),
          integer,
          ctx,
        );
      }

      if (
        expr.func.tag === "var" &&
        (expr.func.name === "@as" || expr.func.name === "@seal" ||
          expr.func.name === "@representation") &&
        !ctx.aliases.has(expr.func.name)
      ) {
        const cast_name = expr.func.name;
        const args = compiler_builtin_args(expr);
        expect(
          args.length === 2,
          cast_name + " expects 2 arguments, got " + args.length.toString(),
        );
        const value = args[0];
        expect(value, "Missing " + cast_name + " value argument");
        return core_expr(value, ctx);
      }

      const f32x4_call = f32x4_builtin_call(expr);

      if (f32x4_call) {
        expect(expr.func.tag === "var", "F32x4 builtin requires a name");

        if (!ctx.aliases.has(expr.func.name)) {
          const expected = Callable.arity(Prim, f32x4_call.prim);
          expect(
            f32x4_call.args.length === expected,
            expr.func.name + " expects " + expected + " arguments, got " +
              f32x4_call.args.length,
          );
          return {
            tag: "prim",
            prim: f32x4_call.prim,
            args: f32x4_call.args.map((arg) => core_expr(arg, ctx)),
          };
        }
      }

      const numeric_call = numeric_builtin_call(expr);

      if (numeric_call) {
        expect(expr.func.tag === "var", "Numeric builtin requires a name");

        if (!ctx.aliases.has(expr.func.name)) {
          const expected = Callable.arity(Prim, numeric_call.prim);
          expect(
            numeric_call.args.length === expected,
            expr.func.name + " expects " + expected + " arguments, got " +
              numeric_call.args.length,
          );
          const integer = front_expr_integer_type(expr, ctx);
          const prim: CoreExpr = {
            tag: "prim",
            prim: numeric_call.prim,
            args: numeric_call.args.map((arg) => core_expr(arg, ctx)),
            integer,
          };
          return lower_core_integer_prim(prim, integer, ctx);
        }
      }

      const host_method = core_host_import_method_app(expr, ctx);

      if (host_method) {
        return host_method;
      }

      let args = expr.args;

      if (
        expr.func.tag === "var" &&
        !ctx.aliases.has(expr.func.name) &&
        core_product_builtin_names.has(expr.func.name)
      ) {
        args = compiler_builtin_args(expr);
      }

      const app: Extract<CoreExpr, { tag: "app" }> = {
        tag: "app",
        func: core_expr(expr.func, ctx),
        args: args.map((arg) => core_expr(arg, ctx)),
      };

      if (expr.resume_payload) {
        app.resume_payload = true;
      }

      return app;
    }

    case "product":
      return core_expr(elaborate_product_expr(expr), ctx);

    case "shape":
      throw new Error("Compile-time shape cannot be emitted as a Core result");

    case "array":
      return core_expr(elaborate_fixed_array_expr(expr), ctx);

    case "array_repeat": {
      const value_name = "_array_repeat#" + ctx.fresh.next.toString();
      ctx.fresh.next += 1;
      return core_expr(
        elaborate_array_repeat_expr(expr, value_name),
        ctx,
      );
    }

    case "import":
      throw new Error(
        "Expression import must be resolved before Core lowering: " +
          expr.path,
      );

    case "block": {
      const block_ctx = fork_core_from_source_ctx(ctx);
      return {
        tag: "block",
        statements: expr.statements.map((stmt) => {
          return ctx.lower_stmt(stmt, block_ctx);
        }),
      };
    }

    case "loop": {
      const loop_ctx = fork_core_from_source_ctx(ctx);
      return {
        tag: "loop",
        body: expr.body.map((stmt) => {
          return ctx.lower_stmt(stmt, loop_ctx);
        }),
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

    case "handler":
      throw new Error(
        "Handler expression must be elaborated before Core lowering",
      );

    case "try_with":
      throw new Error(
        "Try-with expression must be elaborated before Core lowering",
      );

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

    case "type_with":
      throw new Error(
        "Computed type members must be elaborated before Core lowering",
      );

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

    case "field": {
      let object = core_expr(expr.object, ctx);

      if (expr.resume_signature && object.tag === "linear") {
        object = { tag: "var", name: object.name };
      }

      if (expr.resume_signature) {
        return {
          tag: "field",
          object,
          name: expr.name,
          resume_signature: expr.resume_signature,
        };
      }

      return { tag: "field", object, name: expr.name };
    }

    case "index":
      return {
        tag: "index",
        object: core_expr(expr.object, ctx),
        index: core_expr(expr.index, ctx),
      };

    case "union_case": {
      let payload: CoreExpr | undefined;
      let type_expr: CoreExpr | undefined;

      if (expr.value) {
        payload = core_expr(expr.value, ctx);
      }

      if (expr.type_expr) {
        type_expr = core_expr(expr.type_expr, ctx);
      }

      const value: Extract<CoreExpr, { tag: "union_case" }> = {
        tag: "union_case",
        name: expr.name,
        value: payload,
        type_expr,
      };

      if (expr.resume_payload) {
        value.resume_payload = true;
      }

      return value;
    }

    case "unsupported":
      return {
        tag: "unsupported",
        feature: expr.feature,
        text: expr.text,
      };
  }
}

function record_param_integer_type(
  param: Param,
  ctx: CoreFromSourceCtx,
): void {
  if (!param.annotation) {
    ctx.integer_types.delete(param.name);
    return;
  }

  const annotation = resolve_core_annotation(ctx, param.annotation);
  let integer: IntegerType | undefined;

  if (annotation) {
    integer = integer_type_from_name(annotation);
  }

  if (integer) {
    ctx.integer_types.set(param.name, integer);

    if (integer.width > 64) {
      register_wide_integer_type(integer, ctx);
    }
  } else {
    ctx.integer_types.delete(param.name);
  }
}

export function front_expr_integer_type(
  expr: FrontExpr,
  ctx: CoreFromSourceCtx,
): IntegerType | undefined {
  if (expr.tag === "num") {
    return expr.integer;
  }

  if (expr.tag === "var" || expr.tag === "linear") {
    const name = resolve_core_name(ctx, expr.name);
    return ctx.integer_types.get(name);
  }

  if (expr.tag === "prim") {
    const left = front_expr_integer_type(expr.left, ctx);
    const right = front_expr_integer_type(expr.right, ctx);

    if (
      left && right && left.signed === right.signed &&
      left.width === right.width
    ) {
      return left;
    }

    return left || right;
  }

  if (expr.tag === "app") {
    const args = compiler_builtin_args(expr);

    if (expr.func.tag === "var" && expr.func.name === "@integer.wrap") {
      const target = args[1];

      if (target && target.tag === "var") {
        return integer_type_from_name(target.name);
      }
    }

    const first = args[0];

    if (first) {
      return front_expr_integer_type(first, ctx);
    }
  }

  return undefined;
}

function core_integer_wrap(
  value: CoreExpr,
  source: IntegerType | undefined,
  target: IntegerType,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  if (target.width > 64) {
    register_wide_integer_type(target, ctx);
    return core_wrap_to_wide_integer(value, source, target, ctx);
  }

  if (source && source.width > 64) {
    register_wide_integer_type(source, ctx);
    value = core_wrap_wide_to_native_integer(value, source, target, ctx);
    source = { signed: false, width: target.width };
  }
  let normalized = value;

  if (target.width > 32 && source && source.width <= 32) {
    normalized = {
      tag: "prim",
      prim: "i64.extend_i32_u",
      args: [normalized],
      integer: target,
    };
  } else if (target.width <= 32 && source && source.width > 32) {
    normalized = {
      tag: "prim",
      prim: "i32.wrap_i64",
      args: [normalized],
      integer: target,
    };
  }

  let carrier: "i32" | "i64" = "i32";
  let carrier_width = 32;

  if (target.width > 32) {
    carrier = "i64";
    carrier_width = 64;
  }

  if (!target.signed) {
    if (target.width === carrier_width) {
      return normalized;
    }

    const mask = (1n << BigInt(target.width)) - 1n;
    let mask_value: number | bigint = mask;

    if (carrier === "i32") {
      mask_value = Number(mask);
    }

    return {
      tag: "prim",
      prim: carrier + ".and" as Prim,
      args: [{
        tag: "num",
        type: carrier,
        value: mask_value,
        integer: target,
      }, normalized],
      integer: target,
    };
  }

  if (target.width === carrier_width) {
    return normalized;
  }

  const shift = carrier_width - target.width;
  let shift_value: number | bigint = BigInt(shift);

  if (carrier === "i32") {
    shift_value = shift;
  }

  const shift_expr: CoreExpr = {
    tag: "num",
    type: carrier,
    value: shift_value,
    integer: target,
  };
  return {
    tag: "prim",
    prim: carrier + ".shr_s" as Prim,
    args: [{
      tag: "prim",
      prim: carrier + ".shl" as Prim,
      args: [normalized, shift_expr],
      integer: target,
    }, shift_expr],
    integer: target,
  };
}

function register_wide_integer_type(
  integer: IntegerType,
  ctx: CoreFromSourceCtx,
): void {
  const name = integer_type_name(integer);
  ctx.wide_integer_types.set(name, integer);
}

function core_wrap_to_wide_integer(
  value: CoreExpr,
  source: IntegerType | undefined,
  target: IntegerType,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const value_name = fresh_core_integer_name(ctx, "integer_wrap_source");
  let annotation = "I32";

  if (source) {
    annotation = integer_type_name(source);
  } else if (value.tag === "num" && value.type === "i64") {
    annotation = "I64";
  }

  const source_value: CoreExpr = { tag: "var", name: value_name };
  let result: CoreExpr;

  if (source && source.width > 64) {
    result = core_wrap_between_wide_integers(
      source_value,
      source,
      target,
      ctx,
    );
  } else {
    result = core_wrap_native_to_wide_integer(
      source_value,
      source,
      target,
      ctx,
    );
  }

  return {
    tag: "block",
    statements: [
      core_integer_binding(value_name, annotation, value),
      { tag: "expr", expr: result },
    ],
  };
}

function core_wrap_native_to_wide_integer(
  value: CoreExpr,
  source: IntegerType | undefined,
  target: IntegerType,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const fields: CoreField[] = [];
  const limb_count = Math.ceil(target.width / 32);
  let source_width = 32;
  let source_signed = true;

  if (source) {
    source_width = source.width;
    source_signed = source.signed;
  }

  let sign: CoreExpr | undefined;

  if (source_signed) {
    let carrier: "i32" | "i64" = "i32";
    let zero: number | bigint = 0;

    if (source_width > 32) {
      carrier = "i64";
      zero = 0n;
    }

    sign = {
      tag: "prim",
      prim: carrier + ".lt_s" as Prim,
      args: [value, { tag: "num", type: carrier, value: zero }],
      integer: { signed: true, width: source_width },
    };
  }

  for (let index = 0; index < limb_count; index += 1) {
    let limb: CoreExpr;

    if (index === 0) {
      if (source_width <= 32) {
        limb = value;
      } else {
        limb = { tag: "prim", prim: "i32.wrap_i64", args: [value] };
      }
    } else if (index === 1 && source_width > 32) {
      limb = {
        tag: "prim",
        prim: "i32.wrap_i64",
        args: [{
          tag: "prim",
          prim: "i64.shr_u",
          args: [value, { tag: "num", type: "i64", value: 32n }],
        }],
      };
    } else if (sign) {
      limb = {
        tag: "if",
        cond: sign,
        then_branch: { tag: "num", type: "i32", value: 0xffff_ffff },
        else_branch: { tag: "num", type: "i32", value: 0 },
      };
    } else {
      limb = { tag: "num", type: "i32", value: 0 };
    }

    limb = mask_wide_top_limb(limb, index, target);
    fields.push({ name: "limb_" + index.toString(), value: limb });
  }

  return wide_integer_struct_value(target, fields, ctx);
}

function core_wrap_between_wide_integers(
  value: CoreExpr,
  source: IntegerType,
  target: IntegerType,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const fields: CoreField[] = [];
  const source_limbs = Math.ceil(source.width / 32);
  const target_limbs = Math.ceil(target.width / 32);
  let sign: CoreExpr | undefined;

  if (source.signed) {
    const top = wide_integer_object_field(value, source_limbs - 1);
    const sign_bit = (source.width - 1) % 32;
    sign = {
      tag: "prim",
      prim: "i32.ne",
      args: [
        {
          tag: "prim",
          prim: "i32.and",
          args: [
            top,
            { tag: "num", type: "i32", value: 2 ** sign_bit },
          ],
        },
        { tag: "num", type: "i32", value: 0 },
      ],
    };
  }

  for (let index = 0; index < target_limbs; index += 1) {
    let limb: CoreExpr;

    if (index < source_limbs) {
      limb = wide_integer_object_field(value, index);
    } else if (sign) {
      limb = {
        tag: "if",
        cond: sign,
        then_branch: { tag: "num", type: "i32", value: 0xffff_ffff },
        else_branch: { tag: "num", type: "i32", value: 0 },
      };
    } else {
      limb = { tag: "num", type: "i32", value: 0 };
    }

    limb = mask_wide_top_limb(limb, index, target);
    fields.push({ name: "limb_" + index.toString(), value: limb });
  }

  return wide_integer_struct_value(target, fields, ctx);
}

function core_wrap_wide_to_native_integer(
  value: CoreExpr,
  source: IntegerType,
  target: IntegerType,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const value_name = fresh_core_integer_name(ctx, "integer_wrap_source");
  const source_value: CoreExpr = { tag: "var", name: value_name };
  const low = wide_integer_object_field(source_value, 0);
  let result: CoreExpr;

  if (target.width <= 32) {
    result = low;
  } else {
    const high = wide_integer_object_field(source_value, 1);
    result = {
      tag: "prim",
      prim: "i64.or",
      args: [
        { tag: "prim", prim: "i64.extend_i32_u", args: [low] },
        {
          tag: "prim",
          prim: "i64.shl",
          args: [
            { tag: "prim", prim: "i64.extend_i32_u", args: [high] },
            { tag: "num", type: "i64", value: 32n },
          ],
        },
      ],
    };
  }

  return {
    tag: "block",
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: value_name,
        is_linear: false,
        force_materialized: true,
        annotation: integer_type_name(source),
        value,
      },
      { tag: "expr", expr: result },
    ],
  };
}

function wide_integer_object_field(value: CoreExpr, index: number): CoreExpr {
  let address: CoreExpr = { tag: "borrow", value };

  if (index > 0) {
    address = {
      tag: "prim",
      prim: "i32.add",
      args: [
        { tag: "borrow", value },
        { tag: "num", type: "i32", value: index * 4 },
      ],
    };
  }

  return {
    tag: "prim",
    prim: "i32.load",
    args: [address],
  };
}

function wide_integer_literal(
  integer: IntegerType,
  value: bigint,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const pattern = integer_bit_pattern(integer, value);
  const fields: CoreField[] = [];
  const limb_count = Math.ceil(integer.width / 32);
  const limb_mask = 0xffff_ffffn;

  for (let index = 0; index < limb_count; index += 1) {
    const limb = Number((pattern >> BigInt(index * 32)) & limb_mask);
    fields.push({
      name: "limb_" + index.toString(),
      value: { tag: "num", type: "i32", value: limb },
    });
  }

  return wide_integer_struct_value(integer, fields, ctx);
}

function core_narrow_integer_shift(
  expr: CoreExpr,
  integer: IntegerType,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  expect(expr.tag === "prim", "Integer shift lowering requires a primitive");
  const value = expr.args[0];
  const amount = expr.args[1];
  expect(value, "Integer shift is missing its value operand");
  expect(amount, "Integer shift is missing its amount operand");
  const value_name = "integer_shift_value#" + ctx.fresh.next.toString();
  ctx.fresh.next += 1;
  const amount_name = "integer_shift_amount#" + ctx.fresh.next.toString();
  ctx.fresh.next += 1;
  const annotation = integer_type_name(integer);
  let carrier: "i32" | "i64" = "i32";
  let width_value: number | bigint = integer.width;
  let zero_value: number | bigint = 0;

  if (integer.width > 32) {
    carrier = "i64";
    width_value = BigInt(integer.width);
    zero_value = 0n;
  }

  return {
    tag: "block",
    statements: [
      {
        tag: "bind",
        kind: "let",
        name: value_name,
        is_linear: false,
        annotation,
        value,
      },
      {
        tag: "bind",
        kind: "let",
        name: amount_name,
        is_linear: false,
        annotation,
        value: amount,
      },
      {
        tag: "expr",
        expr: {
          tag: "if",
          cond: {
            tag: "prim",
            prim: carrier + ".ge_u" as Prim,
            args: [
              { tag: "var", name: amount_name },
              { tag: "num", type: carrier, value: width_value },
            ],
            integer: { signed: false, width: integer.width },
          },
          then_branch: {
            tag: "num",
            type: carrier,
            value: zero_value,
            integer,
          },
          else_branch: {
            tag: "prim",
            prim: expr.prim,
            args: [
              { tag: "var", name: value_name },
              { tag: "var", name: amount_name },
            ],
            integer,
          },
        },
      },
    ],
  };
}

function lower_core_integer_prim(
  expr: CoreExpr,
  integer: IntegerType | undefined,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  if (!integer) {
    return expr;
  }

  if (integer.width > 64) {
    return lower_core_wide_integer_prim(expr, integer, ctx);
  }

  if (integer.width === integer_carrier_width(integer)) {
    return expr;
  }

  expect(
    expr.tag === "prim",
    "Integer primitive lowering requires a primitive",
  );

  if (!expr.prim.endsWith(".shl") && !expr.prim.endsWith(".shr_u")) {
    return expr;
  }

  return core_narrow_integer_shift(expr, integer, ctx);
}

function lower_core_wide_integer_prim(
  expr: CoreExpr,
  integer: IntegerType,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  expect(expr.tag === "prim", "Wide integer lowering requires a primitive");
  const left = expr.args[0];
  const right = expr.args[1];
  expect(left, "Wide integer operation is missing its left operand");
  expect(right, "Wide integer operation is missing its right operand");
  register_wide_integer_type(integer, ctx);
  const annotation = integer_type_name(integer);
  const statements: import("../ast.ts").CoreStmt[] = [];
  const operation = expr.prim.slice(expr.prim.indexOf(".") + 1);
  const left_name = bind_wide_integer_operand(
    left,
    "wide_left",
    annotation,
    statements,
    ctx,
  );

  if (operation === "shl" || operation === "shr_u") {
    const static_amount = wide_static_integer_pattern(right);

    if (static_amount !== undefined) {
      let result: CoreExpr;

      if (static_amount >= BigInt(integer.width)) {
        result = wide_zero(integer, ctx);
      } else {
        result = wide_constant_shift_result(
          operation,
          left_name,
          Number(static_amount),
          integer,
          ctx,
        );
      }

      statements.push({ tag: "expr", expr: result });
      return { tag: "block", statements };
    }
  }

  const right_name = bind_wide_integer_operand(
    right,
    "wide_right",
    annotation,
    statements,
    ctx,
  );
  let result: CoreExpr;

  if (operation === "and" || operation === "or" || operation === "xor") {
    result = wide_bitwise_result(
      operation,
      left_name,
      right_name,
      integer,
      ctx,
    );
  } else if (operation === "add") {
    result = wide_add_result(left_name, right_name, integer, statements, ctx);
  } else if (operation === "sub") {
    result = wide_subtract_result(
      left_name,
      right_name,
      integer,
      statements,
      ctx,
    );
  } else if (operation === "mul") {
    result = wide_multiply_result(
      left_name,
      right_name,
      integer,
      statements,
      ctx,
    );
  } else if (operation === "shl" || operation === "shr_u") {
    result = wide_shift_result(
      operation,
      left_name,
      right_name,
      integer,
      statements,
      ctx,
    );
  } else if (
    operation === "div_s" || operation === "div_u" ||
    operation === "rem_s" || operation === "rem_u"
  ) {
    result = wide_division_result(
      operation,
      left_name,
      right_name,
      integer,
      statements,
      ctx,
    );
  } else if (
    operation === "eq" || operation === "ne" || operation.startsWith("lt") ||
    operation.startsWith("le") || operation.startsWith("gt") ||
    operation.startsWith("ge")
  ) {
    result = wide_comparison_result(
      operation,
      left_name,
      right_name,
      integer,
    );
  } else {
    throw new Error(
      "Wide integer operation is not implemented for " + expr.prim + " on " +
        annotation,
    );
  }

  statements.push({ tag: "expr", expr: result });
  return { tag: "block", statements };
}

function bind_wide_integer_operand(
  value: CoreExpr,
  prefix: string,
  annotation: string,
  statements: import("../ast.ts").CoreStmt[],
  ctx: CoreFromSourceCtx,
): string {
  if (value.tag === "var" || value.tag === "linear") {
    return value.name;
  }

  if (value.tag === "block") {
    const final = value.statements[value.statements.length - 1];

    if (final && final.tag === "expr") {
      for (let index = 0; index + 1 < value.statements.length; index += 1) {
        const statement = value.statements[index];
        expect(statement, "Missing wide operand statement " + index);
        statements.push(statement);
      }

      return bind_wide_integer_operand(
        final.expr,
        prefix,
        annotation,
        statements,
        ctx,
      );
    }
  }

  const name = fresh_core_integer_name(ctx, prefix);
  statements.push({
    tag: "bind",
    kind: "let",
    name,
    is_linear: true,
    force_materialized: true,
    annotation,
    value,
  });
  return name;
}

function core_integer_binding(
  name: string,
  annotation: string,
  value: CoreExpr,
): import("../ast.ts").CoreStmt {
  return {
    tag: "bind",
    kind: "let",
    name,
    is_linear: false,
    annotation,
    value,
  };
}

function fresh_core_integer_name(
  ctx: CoreFromSourceCtx,
  prefix: string,
): string {
  const name = prefix + "#" + ctx.fresh.next.toString();
  ctx.fresh.next += 1;
  return name;
}

function wide_bitwise_result(
  operation: "and" | "or" | "xor",
  left_name: string,
  right_name: string,
  integer: IntegerType,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const fields: CoreField[] = [];
  const limb_count = Math.ceil(integer.width / 32);

  for (let index = 0; index < limb_count; index += 1) {
    let value = core_i32_binary(
      operation,
      wide_integer_field(left_name, index),
      wide_integer_field(right_name, index),
    );
    value = mask_wide_top_limb(value, index, integer);
    fields.push({ name: "limb_" + index.toString(), value });
  }

  return wide_integer_struct_value(integer, fields, ctx);
}

function wide_add_result(
  left_name: string,
  right_name: string,
  integer: IntegerType,
  statements: import("../ast.ts").CoreStmt[],
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const fields: CoreField[] = [];
  const limb_count = Math.ceil(integer.width / 32);
  let carry_name: string | undefined;

  for (let index = 0; index < limb_count; index += 1) {
    const left = wide_integer_field(left_name, index);
    const right = wide_integer_field(right_name, index);
    const partial_name = fresh_core_integer_name(ctx, "wide_partial");
    statements.push(core_integer_binding(
      partial_name,
      "U32",
      core_i32_binary("add", left, right),
    ));
    let sum: CoreExpr = { tag: "var", name: partial_name };
    let carry = core_unsigned_comparison("lt", sum, left);

    if (carry_name) {
      const sum_name = fresh_core_integer_name(ctx, "wide_sum");
      statements.push(core_integer_binding(
        sum_name,
        "U32",
        core_i32_binary("add", sum, { tag: "var", name: carry_name }),
      ));
      const carried = core_unsigned_comparison(
        "lt",
        { tag: "var", name: sum_name },
        sum,
      );
      carry = core_i32_binary("or", carry, carried);
      sum = { tag: "var", name: sum_name };
    }

    if (index + 1 < limb_count) {
      carry_name = fresh_core_integer_name(ctx, "wide_carry");
      statements.push(core_integer_binding(carry_name, "U32", carry));
    }

    sum = mask_wide_top_limb(sum, index, integer);
    fields.push({ name: "limb_" + index.toString(), value: sum });
  }

  return wide_integer_struct_value(integer, fields, ctx);
}

function wide_subtract_result(
  left_name: string,
  right_name: string,
  integer: IntegerType,
  statements: import("../ast.ts").CoreStmt[],
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const fields: CoreField[] = [];
  const limb_count = Math.ceil(integer.width / 32);
  let borrow_name: string | undefined;

  for (let index = 0; index < limb_count; index += 1) {
    const left = wide_integer_field(left_name, index);
    const right = wide_integer_field(right_name, index);
    const partial_name = fresh_core_integer_name(ctx, "wide_partial");
    statements.push(core_integer_binding(
      partial_name,
      "U32",
      core_i32_binary("sub", left, right),
    ));
    let difference: CoreExpr = { tag: "var", name: partial_name };
    let borrow = core_unsigned_comparison("lt", left, right);

    if (borrow_name) {
      const difference_name = fresh_core_integer_name(ctx, "wide_difference");
      statements.push(core_integer_binding(
        difference_name,
        "U32",
        core_i32_binary(
          "sub",
          difference,
          { tag: "var", name: borrow_name },
        ),
      ));
      const borrowed = core_unsigned_comparison(
        "lt",
        difference,
        { tag: "var", name: borrow_name },
      );
      borrow = core_i32_binary("or", borrow, borrowed);
      difference = { tag: "var", name: difference_name };
    }

    if (index + 1 < limb_count) {
      borrow_name = fresh_core_integer_name(ctx, "wide_borrow");
      statements.push(core_integer_binding(borrow_name, "U32", borrow));
    }

    difference = mask_wide_top_limb(difference, index, integer);
    fields.push({ name: "limb_" + index.toString(), value: difference });
  }

  return wide_integer_struct_value(integer, fields, ctx);
}

function wide_multiply_result(
  left_name: string,
  right_name: string,
  integer: IntegerType,
  statements: import("../ast.ts").CoreStmt[],
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const limb_count = Math.ceil(integer.width / 32);
  const result_names: string[] = [];

  for (let index = 0; index < limb_count; index += 1) {
    const name = fresh_core_integer_name(ctx, "wide_product");
    result_names.push(name);
    statements.push(core_integer_binding(
      name,
      "U32",
      { tag: "num", type: "i32", value: 0 },
    ));
  }

  for (let left_index = 0; left_index < limb_count; left_index += 1) {
    const carry_name = fresh_core_integer_name(ctx, "wide_product_carry");
    statements.push(core_integer_binding(
      carry_name,
      "I64",
      { tag: "num", type: "i64", value: 0n },
    ));

    for (
      let right_index = 0;
      left_index + right_index < limb_count;
      right_index += 1
    ) {
      const result_index = left_index + right_index;
      const result_name = result_names[result_index];
      expect(result_name, "Missing wide product limb " + result_index);
      const total_name = fresh_core_integer_name(ctx, "wide_product_total");
      const product = core_i64_binary(
        "mul",
        core_i64_extend_unsigned(wide_integer_field(left_name, left_index)),
        core_i64_extend_unsigned(wide_integer_field(right_name, right_index)),
      );
      const with_limb = core_i64_binary(
        "add",
        product,
        core_i64_extend_unsigned({ tag: "var", name: result_name }),
      );
      const total = core_i64_binary(
        "add",
        with_limb,
        { tag: "var", name: carry_name },
      );
      statements.push(core_integer_binding(total_name, "I64", total));
      statements.push({
        tag: "assign",
        name: result_name,
        mode: "same",
        value: {
          tag: "prim",
          prim: "i32.wrap_i64",
          args: [{ tag: "var", name: total_name }],
        },
      });
      statements.push({
        tag: "assign",
        name: carry_name,
        mode: "same",
        value: {
          tag: "prim",
          prim: "i64.shr_u",
          args: [
            { tag: "var", name: total_name },
            { tag: "num", type: "i64", value: 32n },
          ],
        },
      });
    }
  }

  const fields: CoreField[] = [];

  for (let index = 0; index < limb_count; index += 1) {
    const name = result_names[index];
    expect(name, "Missing wide product result limb " + index);
    const value = mask_wide_top_limb(
      { tag: "var", name },
      index,
      integer,
    );
    fields.push({ name: "limb_" + index.toString(), value });
  }

  return wide_integer_struct_value(integer, fields, ctx);
}

function wide_division_result(
  operation: "div_s" | "div_u" | "rem_s" | "rem_u",
  dividend_name: string,
  divisor_name: string,
  integer: IntegerType,
  statements: import("../ast.ts").CoreStmt[],
  ctx: CoreFromSourceCtx,
): CoreExpr {
  if (integer.signed) {
    return wide_signed_division_result(
      operation,
      dividend_name,
      divisor_name,
      integer,
      statements,
      ctx,
    );
  }

  const limb_count = Math.ceil(integer.width / 32);
  const quotient_names: string[] = [];
  const remainder_names: string[] = [];
  let divisor_is_zero: CoreExpr | undefined;

  for (let index = 0; index < limb_count; index += 1) {
    const limb_is_zero = core_i32_binary(
      "eq",
      wide_integer_field(divisor_name, index),
      { tag: "num", type: "i32", value: 0 },
    );

    if (divisor_is_zero) {
      divisor_is_zero = core_i32_binary(
        "and",
        divisor_is_zero,
        limb_is_zero,
      );
    } else {
      divisor_is_zero = limb_is_zero;
    }
  }

  expect(divisor_is_zero, "Wide division requires at least one divisor limb");
  statements.push({
    tag: "if_stmt",
    cond: divisor_is_zero,
    body: [{
      tag: "expr",
      expr: { tag: "prim", prim: "i32.trap", args: [] },
    }],
  });

  for (let index = 0; index < limb_count; index += 1) {
    const quotient = fresh_core_integer_name(ctx, "wide_quotient");
    const remainder = fresh_core_integer_name(ctx, "wide_remainder");
    quotient_names.push(quotient);
    remainder_names.push(remainder);
    statements.push(core_integer_binding(
      quotient,
      "U32",
      { tag: "num", type: "i32", value: 0 },
    ));
    statements.push(core_integer_binding(
      remainder,
      "U32",
      { tag: "num", type: "i32", value: 0 },
    ));
  }

  for (let bit = integer.width - 1; bit >= 0; bit -= 1) {
    for (let index = limb_count - 1; index >= 0; index -= 1) {
      const remainder = remainder_names[index];
      expect(remainder, "Missing wide remainder limb " + index);
      let shifted: CoreExpr = {
        tag: "prim",
        prim: "i32.shl",
        args: [
          { tag: "var", name: remainder },
          { tag: "num", type: "i32", value: 1 },
        ],
      };

      if (index > 0) {
        const lower = remainder_names[index - 1];
        expect(lower, "Missing lower wide remainder limb " + (index - 1));
        shifted = core_i32_binary("or", shifted, {
          tag: "prim",
          prim: "i32.shr_u",
          args: [
            { tag: "var", name: lower },
            { tag: "num", type: "i32", value: 31 },
          ],
        });
      } else {
        const source_bit = core_i32_binary(
          "and",
          {
            tag: "prim",
            prim: "i32.shr_u",
            args: [
              wide_integer_field(dividend_name, Math.floor(bit / 32)),
              { tag: "num", type: "i32", value: bit % 32 },
            ],
          },
          { tag: "num", type: "i32", value: 1 },
        );
        shifted = core_i32_binary("or", shifted, source_bit);
      }

      statements.push({
        tag: "assign",
        name: remainder,
        mode: "same",
        value: mask_wide_top_limb(shifted, index, integer),
      });
    }

    const subtract: import("../ast.ts").CoreStmt[] = [];
    let borrow_name: string | undefined;

    for (let index = 0; index < limb_count; index += 1) {
      const remainder = remainder_names[index];
      expect(remainder, "Missing wide remainder limb " + index);
      const divisor = wide_integer_field(divisor_name, index);
      const partial_name = fresh_core_integer_name(ctx, "wide_div_partial");
      subtract.push(core_integer_binding(
        partial_name,
        "U32",
        core_i32_binary(
          "sub",
          { tag: "var", name: remainder },
          divisor,
        ),
      ));
      let difference: CoreExpr = { tag: "var", name: partial_name };
      let borrow = core_unsigned_comparison(
        "lt",
        { tag: "var", name: remainder },
        divisor,
      );

      if (borrow_name) {
        const difference_name = fresh_core_integer_name(
          ctx,
          "wide_div_difference",
        );
        subtract.push(core_integer_binding(
          difference_name,
          "U32",
          core_i32_binary(
            "sub",
            difference,
            { tag: "var", name: borrow_name },
          ),
        ));
        borrow = core_i32_binary(
          "or",
          borrow,
          core_unsigned_comparison(
            "lt",
            difference,
            { tag: "var", name: borrow_name },
          ),
        );
        difference = { tag: "var", name: difference_name };
      }

      if (index + 1 < limb_count) {
        borrow_name = fresh_core_integer_name(ctx, "wide_div_borrow");
        subtract.push(core_integer_binding(borrow_name, "U32", borrow));
      }

      subtract.push({
        tag: "assign",
        name: remainder,
        mode: "same",
        value: mask_wide_top_limb(difference, index, integer),
      });
    }

    const quotient_index = Math.floor(bit / 32);
    const quotient = quotient_names[quotient_index];
    expect(quotient, "Missing wide quotient limb " + quotient_index);
    subtract.push({
      tag: "assign",
      name: quotient,
      mode: "same",
      value: core_i32_binary(
        "or",
        { tag: "var", name: quotient },
        { tag: "num", type: "i32", value: 2 ** (bit % 32) },
      ),
    });
    statements.push({
      tag: "if_stmt",
      cond: wide_local_greater_or_equal(
        remainder_names,
        divisor_name,
      ),
      body: subtract,
    });
  }

  let selected = quotient_names;

  if (operation.startsWith("rem")) {
    selected = remainder_names;
  }

  const fields: CoreField[] = [];

  for (let index = 0; index < limb_count; index += 1) {
    const name = selected[index];
    expect(name, "Missing wide division result limb " + index);
    fields.push({
      name: "limb_" + index.toString(),
      value: mask_wide_top_limb({ tag: "var", name }, index, integer),
    });
  }

  return wide_integer_struct_value(integer, fields, ctx);
}

function wide_signed_division_result(
  operation: "div_s" | "div_u" | "rem_s" | "rem_u",
  dividend_name: string,
  divisor_name: string,
  integer: IntegerType,
  statements: import("../ast.ts").CoreStmt[],
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const unsigned: IntegerType = { signed: false, width: integer.width };
  register_wide_integer_type(unsigned, ctx);
  const unsigned_annotation = integer_type_name(unsigned);
  const dividend_limbs = snapshot_wide_integer_limbs(
    dividend_name,
    "wide_dividend_limb",
    integer,
    statements,
    ctx,
  );
  const divisor_limbs = snapshot_wide_integer_limbs(
    divisor_name,
    "wide_divisor_limb",
    integer,
    statements,
    ctx,
  );
  const dividend_is_negative = wide_local_integer_is_negative(
    dividend_limbs,
    integer,
  );
  const divisor_is_negative = wide_local_integer_is_negative(
    divisor_limbs,
    integer,
  );
  const dividend_magnitude = fresh_core_integer_name(
    ctx,
    "wide_dividend_magnitude",
  );
  const divisor_magnitude = fresh_core_integer_name(
    ctx,
    "wide_divisor_magnitude",
  );

  statements.push({
    tag: "bind",
    kind: "let",
    name: dividend_magnitude,
    is_linear: false,
    force_materialized: true,
    annotation: unsigned_annotation,
    value: wide_conditional_negate_local_result(
      dividend_limbs,
      dividend_is_negative,
      unsigned,
      ctx,
    ),
  });
  statements.push({
    tag: "bind",
    kind: "let",
    name: divisor_magnitude,
    is_linear: false,
    force_materialized: true,
    annotation: unsigned_annotation,
    value: wide_conditional_negate_local_result(
      divisor_limbs,
      divisor_is_negative,
      unsigned,
      ctx,
    ),
  });

  let unsigned_operation: "div_u" | "rem_u" = "div_u";

  if (operation.startsWith("rem")) {
    unsigned_operation = "rem_u";
  }

  const unsigned_result = wide_division_result(
    unsigned_operation,
    dividend_magnitude,
    divisor_magnitude,
    unsigned,
    statements,
    ctx,
  );
  const result_name = fresh_core_integer_name(ctx, "wide_division_result");
  statements.push({
    tag: "bind",
    kind: "let",
    name: result_name,
    is_linear: false,
    force_materialized: true,
    annotation: unsigned_annotation,
    value: unsigned_result,
  });

  let result_is_negative = dividend_is_negative;

  if (unsigned_operation === "div_u") {
    result_is_negative = core_i32_binary(
      "xor",
      dividend_is_negative,
      divisor_is_negative,
    );
  }

  const result_limbs = snapshot_wide_integer_limbs(
    result_name,
    "wide_division_limb",
    integer,
    statements,
    ctx,
  );
  const signed_result = fresh_core_integer_name(ctx, "wide_signed_result");
  statements.push({
    tag: "bind",
    kind: "let",
    name: signed_result,
    is_linear: false,
    force_materialized: true,
    annotation: integer_type_name(integer),
    value: wide_conditional_negate_local_result(
      result_limbs,
      result_is_negative,
      integer,
      ctx,
    ),
  });
  return { tag: "var", name: signed_result };
}

function snapshot_wide_integer_limbs(
  name: string,
  prefix: string,
  integer: IntegerType,
  statements: import("../ast.ts").CoreStmt[],
  ctx: CoreFromSourceCtx,
): string[] {
  const names: string[] = [];
  const limb_count = Math.ceil(integer.width / 32);

  for (let index = 0; index < limb_count; index += 1) {
    const limb_name = fresh_core_integer_name(ctx, prefix);
    names.push(limb_name);
    statements.push(core_integer_binding(
      limb_name,
      "U32",
      wide_integer_field(name, index),
    ));
  }

  return names;
}

function wide_local_integer_is_negative(
  names: string[],
  integer: IntegerType,
): CoreExpr {
  const top_index = Math.ceil(integer.width / 32) - 1;
  const sign_offset = (integer.width - 1) % 32;
  const top = names[top_index];
  expect(top, "Missing wide integer sign limb " + top_index);
  return core_i32_binary(
    "and",
    {
      tag: "prim",
      prim: "i32.shr_u",
      args: [
        { tag: "var", name: top },
        { tag: "num", type: "i32", value: sign_offset },
      ],
    },
    { tag: "num", type: "i32", value: 1 },
  );
}

function wide_conditional_negate_local_result(
  names: string[],
  condition: CoreExpr,
  integer: IntegerType,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const fields: CoreField[] = [];
  let carry: CoreExpr = { tag: "num", type: "i32", value: 1 };

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    expect(name, "Missing local wide integer limb " + index);
    const original: CoreExpr = { tag: "var", name };
    const inverted = core_i32_binary(
      "xor",
      original,
      { tag: "num", type: "i32", value: 0xffffffff },
    );
    let negated = core_i32_binary("add", inverted, carry);
    carry = core_i32_binary(
      "and",
      carry,
      core_i32_binary("eq", original, {
        tag: "num",
        type: "i32",
        value: 0,
      }),
    );
    negated = mask_wide_top_limb(negated, index, integer);
    fields.push({
      name: "limb_" + index.toString(),
      value: {
        tag: "if",
        cond: condition,
        then_branch: negated,
        else_branch: original,
      },
    });
  }

  return wide_integer_struct_value(integer, fields, ctx);
}

function wide_local_greater_or_equal(
  remainder_names: string[],
  divisor_name: string,
): CoreExpr {
  let result: CoreExpr = { tag: "num", type: "i32", value: 1 };

  for (let index = 0; index < remainder_names.length; index += 1) {
    const remainder = remainder_names[index];
    expect(remainder, "Missing wide comparison remainder limb " + index);
    const left: CoreExpr = { tag: "var", name: remainder };
    const right = wide_integer_field(divisor_name, index);
    result = {
      tag: "if",
      cond: core_i32_binary("eq", left, right),
      then_branch: result,
      else_branch: {
        tag: "prim",
        prim: "i32.gt_u",
        args: [left, right],
        integer: { signed: false, width: 32 },
      },
    };
  }

  return result;
}

function wide_shift_result(
  operation: "shl" | "shr_u",
  value_name: string,
  amount_name: string,
  integer: IntegerType,
  statements: import("../ast.ts").CoreStmt[],
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const limb_count = Math.ceil(integer.width / 32);
  const amount_low_name = fresh_core_integer_name(ctx, "wide_shift_amount");
  statements.push(core_integer_binding(
    amount_low_name,
    "U32",
    wide_integer_field(amount_name, 0),
  ));
  const amount: CoreExpr = { tag: "var", name: amount_low_name };
  let outside = core_unsigned_comparison(
    "lt",
    { tag: "num", type: "i32", value: integer.width },
    amount,
  );
  outside = core_i32_binary(
    "or",
    outside,
    core_i32_binary(
      "eq",
      amount,
      { tag: "num", type: "i32", value: integer.width },
    ),
  );

  for (let index = 1; index < limb_count; index += 1) {
    const high_name = fresh_core_integer_name(ctx, "wide_shift_high");
    statements.push(core_integer_binding(
      high_name,
      "U32",
      wide_integer_field(amount_name, index),
    ));
    const high_nonzero = core_i32_binary(
      "eq",
      core_i32_binary(
        "eq",
        { tag: "var", name: high_name },
        { tag: "num", type: "i32", value: 0 },
      ),
      { tag: "num", type: "i32", value: 0 },
    );
    outside = core_i32_binary("or", outside, high_nonzero);
  }

  let shifted = wide_shift_word_result(
    operation,
    value_name,
    amount,
    0,
    integer,
    ctx,
  );

  for (let word = 1; word < limb_count; word += 1) {
    shifted = {
      tag: "if",
      cond: {
        tag: "prim",
        prim: "i32.ge_u",
        args: [
          amount,
          { tag: "num", type: "i32", value: word * 32 },
        ],
        integer: { signed: false, width: 32 },
      },
      then_branch: wide_shift_word_result(
        operation,
        value_name,
        amount,
        word,
        integer,
        ctx,
      ),
      else_branch: shifted,
    };
  }

  return {
    tag: "if",
    cond: outside,
    then_branch: wide_zero(integer, ctx),
    else_branch: shifted,
  };
}

function wide_static_integer_pattern(value: CoreExpr): bigint | undefined {
  if (value.tag === "block") {
    const final = value.statements[value.statements.length - 1];

    if (final && final.tag === "expr") {
      return wide_static_integer_pattern(final.expr);
    }

    return undefined;
  }

  if (value.tag !== "struct_value") {
    return undefined;
  }

  let pattern = 0n;

  for (let index = 0; index < value.fields.length; index += 1) {
    const field = value.fields[index];
    expect(field, "Missing static wide integer limb " + index);

    if (
      field.value.tag !== "num" || field.value.type !== "i32" ||
      typeof field.value.value !== "number"
    ) {
      return undefined;
    }

    const limb = BigInt(field.value.value) & 0xffff_ffffn;
    pattern |= limb << BigInt(index * 32);
  }

  return pattern;
}

function wide_constant_shift_result(
  operation: "shl" | "shr_u",
  value_name: string,
  amount: number,
  integer: IntegerType,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const fields: CoreField[] = [];
  const limb_count = Math.ceil(integer.width / 32);
  const word = Math.floor(amount / 32);
  const residual = amount % 32;

  for (let output = 0; output < limb_count; output += 1) {
    let value: CoreExpr = { tag: "num", type: "i32", value: 0 };

    if (operation === "shl") {
      const source = output - word;

      if (source >= 0) {
        value = wide_integer_field(value_name, source);

        if (residual > 0) {
          value = {
            tag: "prim",
            prim: "i32.shl",
            args: [value, { tag: "num", type: "i32", value: residual }],
          };

          if (source > 0) {
            value = core_i32_binary("or", value, {
              tag: "prim",
              prim: "i32.shr_u",
              args: [
                wide_integer_field(value_name, source - 1),
                { tag: "num", type: "i32", value: 32 - residual },
              ],
            });
          }
        }
      }
    } else {
      const source = output + word;

      if (source < limb_count) {
        value = wide_integer_field(value_name, source);

        if (residual > 0) {
          value = {
            tag: "prim",
            prim: "i32.shr_u",
            args: [value, { tag: "num", type: "i32", value: residual }],
          };

          if (source + 1 < limb_count) {
            value = core_i32_binary("or", value, {
              tag: "prim",
              prim: "i32.shl",
              args: [
                wide_integer_field(value_name, source + 1),
                { tag: "num", type: "i32", value: 32 - residual },
              ],
            });
          }
        }
      }
    }

    value = mask_wide_top_limb(value, output, integer);
    fields.push({ name: "limb_" + output.toString(), value });
  }

  return wide_integer_struct_value(integer, fields, ctx);
}

function wide_shift_word_result(
  operation: "shl" | "shr_u",
  value_name: string,
  amount: CoreExpr,
  word: number,
  integer: IntegerType,
  ctx: CoreFromSourceCtx,
): CoreExpr {
  const fields: CoreField[] = [];
  const limb_count = Math.ceil(integer.width / 32);
  const residual = core_i32_binary(
    "sub",
    amount,
    { tag: "num", type: "i32", value: word * 32 },
  );
  const residual_is_zero = core_i32_binary(
    "eq",
    residual,
    { tag: "num", type: "i32", value: 0 },
  );

  for (let output = 0; output < limb_count; output += 1) {
    let value: CoreExpr = { tag: "num", type: "i32", value: 0 };

    if (operation === "shl") {
      const source = output - word;

      if (source >= 0) {
        const direct = wide_integer_field(value_name, source);
        let shifted: CoreExpr = {
          tag: "prim",
          prim: "i32.shl",
          args: [direct, residual],
        };

        if (source > 0) {
          const cross = {
            tag: "prim" as const,
            prim: "i32.shr_u" as Prim,
            args: [
              wide_integer_field(value_name, source - 1),
              core_i32_binary(
                "sub",
                { tag: "num", type: "i32", value: 32 },
                residual,
              ),
            ],
          };
          shifted = core_i32_binary("or", shifted, cross);
        }

        value = {
          tag: "if",
          cond: residual_is_zero,
          then_branch: direct,
          else_branch: shifted,
        };
      }
    } else {
      const source = output + word;

      if (source < limb_count) {
        const direct = wide_integer_field(value_name, source);
        let shifted: CoreExpr = {
          tag: "prim",
          prim: "i32.shr_u",
          args: [direct, residual],
        };

        if (source + 1 < limb_count) {
          const cross = {
            tag: "prim" as const,
            prim: "i32.shl" as Prim,
            args: [
              wide_integer_field(value_name, source + 1),
              core_i32_binary(
                "sub",
                { tag: "num", type: "i32", value: 32 },
                residual,
              ),
            ],
          };
          shifted = core_i32_binary("or", shifted, cross);
        }

        value = {
          tag: "if",
          cond: residual_is_zero,
          then_branch: direct,
          else_branch: shifted,
        };
      }
    }

    value = mask_wide_top_limb(value, output, integer);
    fields.push({ name: "limb_" + output.toString(), value });
  }

  return wide_integer_struct_value(integer, fields, ctx);
}

function wide_zero(integer: IntegerType, ctx: CoreFromSourceCtx): CoreExpr {
  const fields: CoreField[] = [];
  const limb_count = Math.ceil(integer.width / 32);

  for (let index = 0; index < limb_count; index += 1) {
    fields.push({
      name: "limb_" + index.toString(),
      value: { tag: "num", type: "i32", value: 0 },
    });
  }

  return wide_integer_struct_value(integer, fields, ctx);
}

function core_i64_extend_unsigned(value: CoreExpr): CoreExpr {
  return {
    tag: "prim",
    prim: "i64.extend_i32_u",
    args: [value],
  };
}

function core_i64_binary(
  operation: "add" | "mul",
  left: CoreExpr,
  right: CoreExpr,
): CoreExpr {
  return {
    tag: "prim",
    prim: "i64." + operation as Prim,
    args: [left, right],
  };
}

function wide_comparison_result(
  operation: string,
  left_name: string,
  right_name: string,
  integer: IntegerType,
): CoreExpr {
  const equal = wide_equality_result(left_name, right_name, integer);

  if (operation === "eq") {
    return equal;
  }

  if (operation === "ne") {
    return core_i32_binary(
      "eq",
      equal,
      { tag: "num", type: "i32", value: 0 },
    );
  }

  const less = wide_order_result(left_name, right_name, integer);

  if (operation.startsWith("lt")) {
    return less;
  }

  if (operation.startsWith("le")) {
    return core_i32_binary("or", less, equal);
  }

  if (operation.startsWith("gt")) {
    return wide_order_result(right_name, left_name, integer);
  }

  if (operation.startsWith("ge")) {
    return core_i32_binary(
      "or",
      wide_order_result(right_name, left_name, integer),
      equal,
    );
  }

  throw new Error("Unknown wide integer comparison: " + operation);
}

function wide_equality_result(
  left_name: string,
  right_name: string,
  integer: IntegerType,
): CoreExpr {
  const limb_count = Math.ceil(integer.width / 32);
  let result: CoreExpr | undefined;

  for (let index = 0; index < limb_count; index += 1) {
    const equal = core_i32_binary(
      "eq",
      wide_integer_field(left_name, index),
      wide_integer_field(right_name, index),
    );

    if (result) {
      result = core_i32_binary("and", result, equal);
    } else {
      result = equal;
    }
  }

  expect(result, "Wide integer equality requires at least one limb");
  return result;
}

function wide_order_result(
  left_name: string,
  right_name: string,
  integer: IntegerType,
): CoreExpr {
  const limb_count = Math.ceil(integer.width / 32);
  let result: CoreExpr = { tag: "num", type: "i32", value: 0 };

  for (let index = 0; index < limb_count; index += 1) {
    const left = wide_integer_field(left_name, index);
    const right = wide_integer_field(right_name, index);
    let less: CoreExpr;

    if (integer.signed && index + 1 === limb_count) {
      less = core_signed_top_limb_comparison(left, right, integer);
    } else {
      less = core_unsigned_comparison("lt", left, right);
    }

    result = {
      tag: "if",
      cond: core_i32_binary("eq", left, right),
      then_branch: result,
      else_branch: less,
    };
  }

  return result;
}

function core_signed_top_limb_comparison(
  left: CoreExpr,
  right: CoreExpr,
  integer: IntegerType,
): CoreExpr {
  const used = integer.width % 32;
  let signed_left = left;
  let signed_right = right;

  if (used !== 0) {
    const shift = 32 - used;
    const amount: CoreExpr = { tag: "num", type: "i32", value: shift };
    signed_left = {
      tag: "prim",
      prim: "i32.shr_s",
      args: [{ tag: "prim", prim: "i32.shl", args: [left, amount] }, amount],
    };
    signed_right = {
      tag: "prim",
      prim: "i32.shr_s",
      args: [{ tag: "prim", prim: "i32.shl", args: [right, amount] }, amount],
    };
  }

  return {
    tag: "prim",
    prim: "i32.lt_s",
    args: [signed_left, signed_right],
    integer: { signed: true, width: 32 },
  };
}

function core_unsigned_comparison(
  operation: "lt",
  left: CoreExpr,
  right: CoreExpr,
): CoreExpr {
  return {
    tag: "prim",
    prim: "i32." + operation + "_u" as Prim,
    args: [left, right],
    integer: { signed: false, width: 32 },
  };
}

function core_i32_binary(
  operation: "add" | "sub" | "and" | "or" | "xor" | "eq",
  left: CoreExpr,
  right: CoreExpr,
): CoreExpr {
  return {
    tag: "prim",
    prim: "i32." + operation as Prim,
    args: [left, right],
  };
}

function wide_integer_field(name: string, index: number): CoreExpr {
  return wide_integer_object_field({ tag: "linear", name }, index);
}

function mask_wide_top_limb(
  value: CoreExpr,
  index: number,
  integer: IntegerType,
): CoreExpr {
  const limb_count = Math.ceil(integer.width / 32);
  const used = integer.width % 32;

  if (index + 1 !== limb_count || used === 0) {
    return value;
  }

  const mask = Number((1n << BigInt(used)) - 1n);
  return core_i32_binary(
    "and",
    value,
    { tag: "num", type: "i32", value: mask },
  );
}

function wide_integer_struct_value(
  integer: IntegerType,
  fields: CoreField[],
  _ctx: CoreFromSourceCtx,
): CoreExpr {
  return {
    tag: "struct_value",
    type_expr: { tag: "var", name: integer_type_name(integer) },
    fields,
  };
}

function integer_carrier_width(integer: IntegerType): number {
  if (integer.width <= 32) {
    return 32;
  }

  return 64;
}

const core_product_builtin_names = new Set([
  "@append",
  "@Bytes.generate",
  "@get",
  "@runtime_i32_slice",
  "@runtime_text_slice",
  "@slice",
]);

function flattened_product_function(
  expr: Extract<FrontExpr, { tag: "lam" | "rec" }>,
): { params: Param[]; body: FrontExpr } | undefined {
  const pattern = expr.pattern;
  const packed_param = expr.params[0];

  if (pattern?.tag !== "product") {
    return undefined;
  }

  let body = expr.body;

  if (
    expr.params.length === 1 && packed_param !== undefined &&
    packed_param.name.startsWith("_pattern#param")
  ) {
    if (expr.body.tag !== "block") {
      return undefined;
    }

    const final_stmt = expr.body.statements[expr.body.statements.length - 1];

    if (!final_stmt || final_stmt.tag !== "expr") {
      return undefined;
    }

    body = final_stmt.expr;
  }

  const params = flattened_product_pattern_params(pattern, { next: 0 });

  if (params === undefined) {
    return undefined;
  }

  return { params, body };
}

function flattened_product_pattern_params(
  pattern: Extract<Pattern, { tag: "product" }>,
  ignored: { next: number },
): Param[] | undefined {
  if (pattern.value_pack === true) {
    return undefined;
  }

  const params: Param[] = [];

  for (const entry of pattern.entries) {
    if (entry.pattern.tag === "binding") {
      params.push({
        name: entry.pattern.name,
        is_const: entry.pattern.mode === "const",
        is_linear: entry.pattern.mode === "linear",
        annotation: entry.pattern.annotation,
        type_annotation: entry.pattern.type_annotation,
      });
      continue;
    }

    if (entry.pattern.tag === "wildcard") {
      params.push({
        name: "_pattern#ignored" + ignored.next.toString(),
        is_const: entry.pattern.mode === "const",
        is_linear: false,
        annotation: undefined,
      });
      ignored.next += 1;
      continue;
    }

    if (entry.pattern.tag === "product") {
      const nested = flattened_product_pattern_params(entry.pattern, ignored);

      if (nested === undefined) {
        return undefined;
      }

      params.push(...nested);
      continue;
    }

    return undefined;
  }

  return params;
}

export function core_param(param: {
  name: string;
  is_const: boolean;
  is_linear: boolean;
  annotation: string | undefined;
}, ctx: CoreFromSourceCtx): CoreParam {
  let is_linear = param.is_linear;
  const annotation = resolve_core_annotation(ctx, param.annotation);

  if (annotation) {
    const integer = integer_type_from_name(annotation);

    if (integer && integer.width > 64) {
      is_linear = true;
    }
  }

  return {
    name: param.name,
    is_const: param.is_const,
    is_linear,
    annotation,
  };
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
  resolve_bound_core_value_name(ctx, object.name);
  const method_table = ctx.capability_methods.get(receiver_name);

  if (method_table) {
    const host_import = method_table.get(expr.func.name);

    if (!host_import) {
      return {
        tag: "unsupported",
        feature: "missing_capability_method",
        text: receiver_name + "." + expr.func.name,
      };
    }

    return {
      tag: "app",
      func: { tag: "var", name: host_import },
      args: expr.args.map((arg) => core_expr(arg, ctx)),
    };
  }

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

function core_type_field(
  field: {
    name: string;
    type_name: string;
    set_member?: import("../../frontend/ast.ts").TypeExpr;
  },
): CoreTypeField {
  const result: CoreTypeField = {
    name: field.name,
    type_name: field.type_name,
  };

  if (field.set_member) {
    result.set_member = field.set_member;
  }

  return result;
}

export function block_body(expr: FrontExpr): Stmt[] | undefined {
  if (expr.tag !== "block") {
    return undefined;
  }

  return expr.statements;
}
