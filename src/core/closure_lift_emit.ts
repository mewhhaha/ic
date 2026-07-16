import { expect } from "../expect.ts";
import type { Func, FuncParam } from "../mod.ts";
import type { ValType } from "../op.ts";
import type { CoreExpr } from "./ast.ts";
import { set_local } from "./emit/local.ts";
import {
  closure_env_param,
  type ClosureEmitCtx,
  type CoreClosureEmitCtx,
  type CoreClosureEmitHooks,
  type LiftedClosure,
} from "./closure_runtime.ts";
import { load_instr } from "./memory.ts";
import type { RuntimeTextHeap } from "./runtime_text.ts";
import type { CoreScratchHeap } from "./scratch.ts";
import { substitute_core_call_expr } from "./substitute.ts";
import type { TextLayout } from "./text_layout.ts";

export function emit_lifted_closure_funcs<ctx extends CoreClosureEmitCtx>(
  text_layout: TextLayout,
  closures: ClosureEmitCtx,
  heap: RuntimeTextHeap,
  scratch: CoreScratchHeap,
  allocation_permits:
    import("./allocation_emission.ts").CoreAllocationPermitState,
  hooks: CoreClosureEmitHooks<ctx>,
): Func[] {
  const funcs: Func[] = [];

  for (let index = 0; index < closures.lifts.length; index += 1) {
    const lift = closures.lifts[index];
    expect(lift, "Missing lifted closure " + index.toString());
    funcs.push(
      emit_lifted_closure_func(
        lift,
        text_layout,
        closures,
        heap,
        scratch,
        allocation_permits,
        hooks,
      ),
    );
  }

  return funcs;
}

function emit_lifted_closure_func<ctx extends CoreClosureEmitCtx>(
  lift: LiftedClosure,
  text_layout: TextLayout,
  closures: ClosureEmitCtx,
  heap: RuntimeTextHeap,
  scratch: CoreScratchHeap,
  allocation_permits:
    import("./allocation_emission.ts").CoreAllocationPermitState,
  hooks: CoreClosureEmitHooks<ctx>,
): Func {
  const replacements = new Map<string, CoreExpr>();
  const params: FuncParam[] = [
    { name: closure_env_param, type: "i32" },
  ];
  const param_names = new Set<string>([closure_env_param]);
  const locals = new Map<string, ValType>();
  const text_locals = new Set(lift.text_locals);
  const struct_locals = new Map(lift.struct_locals);
  const union_locals = new Map(lift.union_locals);
  const frozen_locals = clone_optional_set(lift.frozen_locals);

  set_local(locals, closure_env_param, "i32");

  for (let index = 0; index < lift.lam.params.length; index += 1) {
    const param = lift.lam.params[index];
    const type = lift.fn_type.params[index];
    const is_text = lift.fn_type.param_texts[index];
    const struct_type = lift.fn_type.param_structs?.[index];
    const union_type = lift.fn_type.param_unions?.[index];
    expect(param, "Missing lifted closure parameter " + index.toString());
    expect(type, "Missing lifted closure parameter type " + index.toString());
    expect(
      is_text !== undefined,
      "Missing lifted closure parameter text fact " + index.toString(),
    );
    params.push({ name: param.name, type });
    param_names.add(param.name);
    set_local(locals, param.name, type);

    if (is_text) {
      text_locals.add(param.name);
    } else {
      text_locals.delete(param.name);
    }

    if (struct_type) {
      struct_locals.set(param.name, struct_type);
    } else {
      struct_locals.delete(param.name);
    }

    if (union_type) {
      union_locals.set(param.name, union_type);
    } else {
      union_locals.delete(param.name);
    }

    if (frozen_locals) {
      frozen_locals.delete(param.name);
    }
  }

  for (const capture of lift.captures) {
    replacements.set(capture.source_name, {
      tag: "var",
      name: capture.local_name,
    });
    set_local(locals, capture.local_name, capture.type);

    if (capture.is_text) {
      text_locals.add(capture.local_name);
    } else {
      text_locals.delete(capture.local_name);
    }

    if (frozen_locals) {
      if (capture.is_frozen) {
        frozen_locals.add(capture.local_name);
      } else {
        frozen_locals.delete(capture.local_name);
      }
    }

    if (capture.union_type) {
      union_locals.set(capture.local_name, capture.union_type);
    } else {
      union_locals.delete(capture.local_name);
    }

    if (capture.struct_type) {
      struct_locals.set(capture.local_name, capture.struct_type);
    } else {
      struct_locals.delete(capture.local_name);
    }
  }

  const body = substitute_core_call_expr(lift.lam.body, replacements);
  const body_ctx = hooks.create_lifted_body_ctx({
    lift,
    locals,
    text_locals,
    struct_locals,
    union_locals,
    frozen_locals,
    materialized_bindings: lift.materialized_bindings,
    host_imports: lift.host_imports,
    text_layout,
    closures,
    heap,
    scratch,
    allocation_permits,
  });

  for (const [name, value] of lift.statics) {
    body_ctx.statics.set(name, substitute_core_call_expr(value, replacements));
  }

  for (const capture of lift.captures) {
    if (capture.fn_type) {
      body_ctx.fn_types.set(capture.local_name, capture.fn_type);
    } else {
      body_ctx.fn_types.delete(capture.local_name);
    }

    if (capture.union_type) {
      body_ctx.union_locals.set(capture.local_name, capture.union_type);
    } else {
      body_ctx.union_locals.delete(capture.local_name);
    }

    if (capture.struct_type) {
      body_ctx.struct_locals.set(capture.local_name, capture.struct_type);
    } else {
      body_ctx.struct_locals.delete(capture.local_name);
    }

    if (body_ctx.frozen_locals) {
      if (capture.is_frozen) {
        body_ctx.frozen_locals.add(capture.local_name);
      } else {
        body_ctx.frozen_locals.delete(capture.local_name);
      }
    }
  }

  for (let index = 0; index < lift.lam.params.length; index += 1) {
    const param = lift.lam.params[index];
    const struct_type = lift.fn_type.param_structs?.[index];
    const union_type = lift.fn_type.param_unions?.[index];
    expect(param, "Missing lifted closure body parameter " + index.toString());
    body_ctx.fn_types.delete(param.name);

    if (struct_type) {
      body_ctx.struct_locals.set(param.name, struct_type);
    } else {
      body_ctx.struct_locals.delete(param.name);
    }

    if (union_type) {
      body_ctx.union_locals.set(param.name, union_type);
    } else {
      body_ctx.union_locals.delete(param.name);
    }

    if (body_ctx.frozen_locals) {
      body_ctx.frozen_locals.delete(param.name);
    }
  }

  hooks.collect_expr_locals(body, body_ctx);
  body_ctx.next_loop = 0;
  body_ctx.next_temp = 0;
  const lines: string[] = [];

  for (const [name, type] of locals) {
    if (!param_names.has(name)) {
      lines.push("(local $" + name + " " + type + ")");
    }
  }

  for (const capture of lift.captures) {
    lines.push("local.get $" + closure_env_param);
    lines.push(load_instr(capture.type, capture.offset));
    lines.push("local.set $" + capture.local_name);
  }

  lines.push(hooks.emit_expr(body, body_ctx));
  return {
    name: lift.func_name,
    params,
    result: lift.fn_type.result,
    body: lines.join("\n"),
  };
}

function clone_optional_set(
  value: Set<string> | undefined,
): Set<string> | undefined {
  if (!value) {
    return undefined;
  }

  return new Set(value);
}
