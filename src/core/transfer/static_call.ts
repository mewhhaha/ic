import type { CoreExpr, CoreHostImport } from "../ast.ts";
import {
  bind_transfer_alias_ownership,
  resolve_transfer_owner,
} from "./ownership.ts";
import {
  child_scope,
  clone_transfer_state,
  merge_conditional_transfer_states,
} from "./state.ts";
import { static_transfer_function_params } from "./static_function.ts";
import type { CoreTransferFunction, CoreTransferState } from "./types.ts";

type ScanTransferExpr<ctx> = (
  expr: CoreExpr,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
) => void;

export function scan_static_transfer_call<ctx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
  scan_transfer_expr: ScanTransferExpr<ctx>,
): void {
  if (expr.func.tag !== "var") {
    return;
  }

  const name = expr.func.name;
  const target = state.functions.get(name);

  if (!target) {
    return;
  }

  if (state.active_functions.has(name)) {
    return;
  }

  const aliases = static_transfer_call_aliases(target, expr.args, state);

  if (!aliases) {
    return;
  }

  const function_aliases = static_transfer_call_function_aliases(
    target,
    expr.args,
    state,
  );
  const previous_aliases = state.aliases;
  const previous_alias_subjects = state.alias_subjects;
  const previous_alias_ownership = state.alias_ownership;
  const previous_alias_rejection_reasons = state.alias_rejection_reasons;
  const previous_functions = state.functions;
  state.aliases = new Map(previous_aliases);
  state.alias_subjects = new Map(previous_alias_subjects);
  state.alias_ownership = new Map(previous_alias_ownership);
  state.alias_rejection_reasons = new Map(previous_alias_rejection_reasons);
  state.functions = new Map(previous_functions);

  for (const entry of aliases.entries()) {
    state.aliases.set(entry[0], entry[1]);
  }

  bind_static_transfer_alias_subjects(target, expr.args, state);

  for (const entry of function_aliases.entries()) {
    state.functions.set(entry[0], entry[1]);
  }

  state.active_functions.add(name);

  try {
    scan_static_transfer_target(
      target,
      child_scope(scope, "static_call/" + name),
      host_imports,
      state,
      scan_transfer_expr,
    );
  } finally {
    state.active_functions.delete(name);
    state.aliases = previous_aliases;
    state.alias_subjects = previous_alias_subjects;
    state.alias_ownership = previous_alias_ownership;
    state.alias_rejection_reasons = previous_alias_rejection_reasons;
    state.functions = previous_functions;
  }
}

function bind_static_transfer_alias_subjects<ctx>(
  target: CoreTransferFunction,
  args: CoreExpr[],
  state: CoreTransferState<ctx>,
): void {
  const params = static_transfer_function_params(target);
  if (!params || params.length !== args.length) {
    return;
  }

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const arg = args[index];
    if (!param || !arg) {
      throw new Error("Missing static transfer alias subject");
    }

    let subject = arg;
    if (arg.tag === "var") {
      const source = state.alias_subjects.get(arg.name);
      if (source) {
        subject = source;
      }
    }
    state.alias_subjects.set(param.name, subject);
  }
}

function static_transfer_call_aliases<ctx>(
  target: CoreTransferFunction,
  args: CoreExpr[],
  state: CoreTransferState<ctx>,
): Map<string, string> | undefined {
  const params = static_transfer_function_params(target);

  if (!params) {
    return undefined;
  }

  if (params.length !== args.length) {
    return undefined;
  }

  const aliases = new Map<string, string>();

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const arg = args[index];

    if (!param) {
      throw new Error("Missing static transfer call parameter");
    }

    if (!arg) {
      throw new Error("Missing static transfer call argument");
    }

    if (arg.tag !== "var") {
      const temporary = "temporary#" + state.next_temporary.toString();
      state.next_temporary += 1;
      aliases.set(param.name, temporary);
      bind_transfer_alias_ownership(param.name, temporary, arg, state);
      continue;
    }

    const owner = resolve_transfer_owner(arg.name, state);
    aliases.set(param.name, owner);
    bind_transfer_alias_ownership(param.name, owner, arg, state);
  }

  return aliases;
}

function static_transfer_call_function_aliases<ctx>(
  target: CoreTransferFunction,
  args: CoreExpr[],
  state: CoreTransferState<ctx>,
): Map<string, CoreTransferFunction> {
  const params = static_transfer_function_params(target);
  const aliases = new Map<string, CoreTransferFunction>();

  if (!params) {
    return aliases;
  }

  if (params.length !== args.length) {
    return aliases;
  }

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index];
    const arg = args[index];

    if (!param) {
      throw new Error("Missing static transfer call parameter");
    }

    if (!arg) {
      throw new Error("Missing static transfer call argument");
    }

    if (!param.is_const) {
      continue;
    }

    if (arg.tag !== "var") {
      continue;
    }

    const target_fn = state.functions.get(arg.name);

    if (!target_fn) {
      continue;
    }

    aliases.set(param.name, target_fn);
  }

  return aliases;
}

function scan_static_transfer_target<ctx>(
  target: CoreTransferFunction,
  scope: string,
  host_imports: Map<string, CoreHostImport>,
  state: CoreTransferState<ctx>,
  scan_transfer_expr: ScanTransferExpr<ctx>,
): void {
  if (target.tag === "lam" || target.tag === "rec") {
    const previous_ctx = state.ctx;
    const previous_collect_local_facts = state.collect_local_facts;

    if (state.hooks.closure_body_ctx) {
      const scoped_ctx = state.hooks.closure_body_ctx(target.value, state.ctx);

      if (scoped_ctx) {
        state.ctx = scoped_ctx;
      } else {
        state.collect_local_facts = false;
      }
    }

    try {
      scan_transfer_expr(
        target.value.body,
        scope,
        host_imports,
        state,
      );
    } finally {
      state.ctx = previous_ctx;
      state.collect_local_facts = previous_collect_local_facts;
    }
    return;
  }

  const then_branch = clone_transfer_state(state);
  scan_static_transfer_target(
    target.then_target,
    child_scope(scope, target.kind + "_then"),
    host_imports,
    then_branch,
    scan_transfer_expr,
  );

  const else_branch = clone_transfer_state(state);
  else_branch.next_transfer = then_branch.next_transfer;
  scan_static_transfer_target(
    target.else_target,
    child_scope(scope, target.kind + "_else"),
    host_imports,
    else_branch,
    scan_transfer_expr,
  );

  merge_conditional_transfer_states(state, [then_branch, else_branch], 2);
}
