import type { Wat } from "../../../wat.ts";
import type { CoreExpr, CoreStmt } from "../../ast.ts";
import type { CoreBackendText, CoreBackendTextApi } from "./types.ts";
import type { CoreBackendTextFacts } from "./facts.ts";
import type { CoreEmitCtx } from "../../emit_ctx.ts";
import {
  emit_runtime_bytes_generate as emit_runtime_bytes_generate_with_hooks,
} from "../../runtime_bytes.ts";
import type { CoreRuntimeBufferBuiltin } from "../../runtime_buffer.ts";
import {
  emit_runtime_float_format,
  emit_runtime_integer_format,
} from "../../runtime_buffer/format.ts";
import { emit_runtime_utf8_conversion } from "../../runtime_buffer/utf8.ts";
import {
  emit_runtime_text_append as emit_runtime_text_append_with_hooks,
  emit_runtime_text_byte_index as emit_runtime_text_byte_index_with_hooks,
  emit_runtime_text_concat as emit_runtime_text_concat_with_hooks,
  emit_runtime_text_eq as emit_runtime_text_eq_with_hooks,
  emit_runtime_text_index_assign as emit_runtime_text_index_assign_with_hooks,
  emit_runtime_text_len as emit_runtime_text_len_with_hooks,
  emit_runtime_text_slice as emit_runtime_text_slice_with_hooks,
  type RuntimeTextHooks,
} from "../../runtime_text.ts";

export type CoreBackendTextRuntime = Pick<
  CoreBackendText,
  | "emit_runtime_bytes_generate"
  | "emit_runtime_buffer_builtin"
  | "emit_runtime_text_byte_index"
  | "emit_runtime_text_append"
  | "emit_runtime_text_concat"
  | "emit_runtime_text_eq"
  | "emit_runtime_text_index_assign"
  | "emit_runtime_text_len"
  | "emit_runtime_text_slice"
>;

export function create_core_backend_text_runtime(
  api: CoreBackendTextApi,
  text_facts: CoreBackendTextFacts,
): CoreBackendTextRuntime {
  const runtime_text_hooks = {
    emit_expr: api.emit_expr,
    expr_type: api.expr_type,
    runtime_text_concat_operands: text_facts.core_runtime_text_concat_operands,
    runtime_text_eq_operands: text_facts.core_runtime_text_eq_operands,
  } satisfies RuntimeTextHooks<CoreEmitCtx>;

  function emit_runtime_bytes_generate(
    subject: CoreExpr,
    length: CoreExpr,
    generator: CoreExpr,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_bytes_generate_with_hooks(
      subject,
      length,
      generator,
      ctx,
      runtime_text_hooks,
    );
  }

  function emit_runtime_buffer_builtin(
    subject: CoreExpr,
    builtin: CoreRuntimeBufferBuiltin,
    ctx: CoreEmitCtx,
  ): Wat {
    if (builtin.name === "@Utf8.encode" || builtin.name === "@Utf8.decode") {
      return emit_runtime_utf8_conversion(
        subject,
        builtin,
        ctx,
        runtime_text_hooks,
      );
    }

    if (builtin.name === "@format_f32") {
      return emit_runtime_float_format(
        subject,
        builtin,
        ctx,
        runtime_text_hooks,
      );
    }

    return emit_runtime_integer_format(
      subject,
      builtin,
      ctx,
      runtime_text_hooks,
    );
  }

  function emit_runtime_text_concat(
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_text_concat_with_hooks(expr, ctx, runtime_text_hooks);
  }

  function emit_runtime_text_append(
    left: CoreExpr,
    right: CoreExpr,
    subject: CoreExpr,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_text_append_with_hooks(
      left,
      right,
      subject,
      ctx,
      runtime_text_hooks,
    );
  }

  function emit_runtime_text_len(
    collection: CoreExpr,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_text_len_with_hooks(
      collection,
      ctx,
      runtime_text_hooks,
    );
  }

  function emit_runtime_text_eq(
    expr: Extract<CoreExpr, { tag: "prim" }>,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_text_eq_with_hooks(expr, ctx, runtime_text_hooks);
  }

  function emit_runtime_text_byte_index(
    collection: CoreExpr,
    index: CoreExpr,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_text_byte_index_with_hooks(
      collection,
      index,
      ctx,
      runtime_text_hooks,
    );
  }

  function emit_runtime_text_slice(
    subject: CoreExpr,
    text: CoreExpr,
    start: CoreExpr,
    end: CoreExpr,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_text_slice_with_hooks(
      subject,
      text,
      start,
      end,
      ctx,
      runtime_text_hooks,
    );
  }

  function emit_runtime_text_index_assign(
    stmt: Extract<CoreStmt, { tag: "index_assign" }>,
    ctx: CoreEmitCtx,
  ): Wat {
    return emit_runtime_text_index_assign_with_hooks(
      stmt,
      ctx,
      runtime_text_hooks,
    );
  }

  return {
    emit_runtime_bytes_generate,
    emit_runtime_buffer_builtin,
    emit_runtime_text_byte_index,
    emit_runtime_text_append,
    emit_runtime_text_concat,
    emit_runtime_text_eq,
    emit_runtime_text_index_assign,
    emit_runtime_text_len,
    emit_runtime_text_slice,
  };
}
