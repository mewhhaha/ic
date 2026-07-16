import { expect } from "../../expect.ts";
import type { Wat } from "../../wat.ts";
import type { CoreExpr } from "../ast.ts";
import { indent_lines } from "../emit/format.ts";
import { closure_heap_global } from "../closure_runtime.ts";
import {
  consume_scratch_alloc,
  emit_persistent_alloc,
} from "../runtime_allocator.ts";
import { runtime_text_alloc_heap } from "../runtime_text/alloc.ts";
import {
  declare_runtime_bytes_generate_locals,
  runtime_bytes_generate_plan,
} from "./plan.ts";
import type {
  RuntimeTextEmitCtx,
  RuntimeTextHooks,
} from "../runtime_text/types.ts";

export function core_bytes_generate_args(
  expr: CoreExpr,
): [CoreExpr, CoreExpr] | undefined {
  if (expr.tag !== "app") {
    return undefined;
  }

  if (expr.func.tag !== "var" || expr.func.name !== "@Bytes.generate") {
    return undefined;
  }

  expect(expr.args.length === 2, "Core Bytes.generate expects 2 arguments");
  const length = expr.args[0];
  const generator = expr.args[1];
  expect(length, "Missing Core Bytes.generate length");
  expect(generator, "Missing Core Bytes.generate callback");
  return [length, generator];
}

export function core_bytes_generator_call(
  generator: CoreExpr,
  index: CoreExpr,
): Extract<CoreExpr, { tag: "app" }> {
  return {
    tag: "app",
    func: generator,
    args: [index],
  };
}

export function emit_runtime_bytes_generate<ctx extends RuntimeTextEmitCtx>(
  subject: CoreExpr,
  length: CoreExpr,
  generator: CoreExpr,
  ctx: ctx,
  hooks: Pick<RuntimeTextHooks<ctx>, "emit_expr" | "expr_type">,
): Wat {
  expect(
    hooks.expr_type(length, ctx) === "i32",
    "Core Bytes.generate length must be i32",
  );
  const locals = runtime_bytes_generate_plan(ctx);
  declare_runtime_bytes_generate_locals(locals, ctx);
  const generator_call = core_bytes_generator_call(
    generator,
    { tag: "var", name: locals.index },
  );
  expect(
    hooks.expr_type(generator_call, ctx) === "i32",
    "Core Bytes.generate callback must return i32",
  );
  const heap_name = runtime_text_alloc_heap(ctx);
  const allocation: string[] = [];

  if (heap_name === closure_heap_global) {
    allocation.push(emit_persistent_alloc(
      ctx,
      subject,
      "local.get $" + locals.length + "\ni32.const 4\ni32.add",
      8,
      "runtime_bytes",
      "runtime_bytes.length_prefixed_u8",
      "runtime_bytes.generate",
    ));
    allocation.push("local.set $" + locals.result);
  } else {
    consume_scratch_alloc(
      ctx,
      subject,
      "runtime_bytes",
      "runtime_bytes.length_prefixed_u8",
      "runtime_bytes.generate",
    );
    allocation.push("global.get $" + heap_name);
    allocation.push("local.set $" + locals.result);
    allocation.push("global.get $" + heap_name);
    allocation.push("local.get $" + locals.length);
    allocation.push("i32.const 4");
    allocation.push("i32.add");
    allocation.push("i32.const 7");
    allocation.push("i32.add");
    allocation.push("i32.const -8");
    allocation.push("i32.and");
    allocation.push("i32.add");
    allocation.push("global.set $" + heap_name);
  }

  const exit_label = "bytes_generate_exit_" + locals.id.toString();
  const loop_label = "bytes_generate_loop_" + locals.id.toString();

  return [
    hooks.emit_expr(length, ctx),
    "local.set $" + locals.length,
    "local.get $" + locals.length,
    "i32.const 0",
    "i32.lt_s",
    "if",
    "  unreachable",
    "end",
    ...allocation,
    "local.get $" + locals.result,
    "local.get $" + locals.length,
    "i32.store",
    "i32.const 0",
    "local.set $" + locals.index,
    "block $" + exit_label,
    "  loop $" + loop_label,
    "    local.get $" + locals.index,
    "    local.get $" + locals.length,
    "    i32.ge_u",
    "    br_if $" + exit_label,
    indent_lines(
      [
        "local.get $" + locals.result,
        "i32.const 4",
        "i32.add",
        "local.get $" + locals.index,
        "i32.add",
        hooks.emit_expr(generator_call, ctx),
        "i32.store8",
        "local.get $" + locals.index,
        "i32.const 1",
        "i32.add",
        "local.set $" + locals.index,
        "br $" + loop_label,
      ].join("\n"),
      4,
    ),
    "  end",
    "end",
    "local.get $" + locals.result,
  ].join("\n");
}
