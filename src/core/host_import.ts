import { expect } from "../expect.ts";
import type { FuncImport } from "../mod.ts";
import type { ValType } from "../op.ts";
import type {
  Core,
  CoreExpr,
  CoreHostImport,
  CoreHostImportArgContract,
  CoreHostImportResultContract,
} from "./ast.ts";
import { core_ownership_result_text, type CoreOwnership } from "./ownership.ts";

export type CoreHostImportCtx = {
  host_imports?: Map<string, CoreHostImport>;
};

export type CoreHostImportDecision =
  | {
    tag: "allowed";
    reason: string;
  }
  | {
    tag: "rejected";
    reason: string;
  };

export function core_host_import_map(
  core: Core,
): Map<string, CoreHostImport> {
  const imports = new Map<string, CoreHostImport>();

  if (!core.host_imports) {
    return imports;
  }

  for (const name in core.host_imports) {
    const host_import = core.host_imports[name];
    expect(host_import, "Missing core host import: " + name);
    expect(
      host_import.name === name,
      "Core host import key/name mismatch: " + name,
    );
    expect(
      host_import.params.length === host_import.args.length,
      "Core host import " + name +
        " must declare one ownership contract per parameter",
    );
    check_core_host_import_result_owner(host_import);
    imports.set(name, host_import);
  }

  return imports;
}

export function clone_core_host_imports(
  imports: Map<string, CoreHostImport> | undefined,
): Map<string, CoreHostImport> | undefined {
  if (!imports) {
    return undefined;
  }

  return new Map(imports);
}

export function core_host_import_signature(
  name: string,
  ctx: CoreHostImportCtx,
): CoreHostImport | undefined {
  if (!ctx.host_imports) {
    return undefined;
  }

  return ctx.host_imports.get(name);
}

export function core_host_import_for_app(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: CoreHostImportCtx,
): CoreHostImport | undefined {
  if (expr.func.tag !== "var") {
    return undefined;
  }

  return core_host_import_signature(expr.func.name, ctx);
}

export function core_host_import_result_type<ctx extends CoreHostImportCtx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType,
): ValType | undefined {
  const host_import = core_host_import_for_app(expr, ctx);

  if (!host_import) {
    return undefined;
  }

  check_core_host_import_call(expr, host_import, ctx, expr_type);
  return host_import.result;
}

export function core_host_import_result_type_expr(
  expr: CoreExpr,
  ctx: CoreHostImportCtx,
): CoreExpr | undefined {
  if (expr.tag !== "app") {
    return undefined;
  }

  const host_import = core_host_import_for_app(expr, ctx);

  if (!host_import) {
    return undefined;
  }

  return host_import.result_type_expr;
}

export function core_host_import_result_ownership(
  expr: CoreExpr,
  ctx: CoreHostImportCtx,
): CoreOwnership | undefined {
  if (expr.tag !== "app") {
    return undefined;
  }

  const host_import = core_host_import_for_app(expr, ctx);

  if (!host_import) {
    return undefined;
  }

  const result_owner = host_import.result_owner;

  if (!result_owner) {
    return undefined;
  }

  return core_host_import_result_contract_ownership(
    result_owner,
    host_import.result,
  );
}

export function emit_core_host_import_call<ctx extends CoreHostImportCtx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  ctx: ctx,
  emit_expr: (expr: CoreExpr, ctx: ctx) => string,
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType,
): string | undefined {
  const host_import = core_host_import_for_app(expr, ctx);

  if (!host_import) {
    return undefined;
  }

  check_core_host_import_call(expr, host_import, ctx, expr_type);
  const lines: string[] = [];

  for (const arg of expr.args) {
    lines.push(emit_expr(arg, ctx));
  }

  lines.push("call $" + host_import.name);
  return lines.join("\n");
}

function core_host_import_result_contract_ownership(
  result_owner: CoreHostImportResultContract,
  result_type: ValType,
): CoreOwnership {
  switch (result_owner.tag) {
    case "scalar":
      return {
        tag: "scalar_local",
        type: result_type,
      };

    case "unique_heap":
      return {
        tag: "unique_heap",
        reason: result_owner.reason,
      };

    case "frozen_shareable":
      return {
        tag: "frozen_shareable",
        reason: result_owner.reason,
      };
  }
}

function check_core_host_import_result_owner(
  host_import: CoreHostImport,
): void {
  const result_owner = host_import.result_owner;

  if (!result_owner) {
    return;
  }

  if (result_owner.tag === "scalar") {
    return;
  }

  expect(
    host_import.result === "i32",
    "Core host import " + host_import.name +
      " owner result must use i32 pointer representation",
  );
}

export function core_host_func_imports(
  core: Core,
): FuncImport[] {
  const imports = core_host_import_map(core);
  const funcs: FuncImport[] = [];

  for (const host_import of imports.values()) {
    funcs.push({
      name: host_import.name,
      module: host_import.module,
      field: host_import.field,
      params: host_import.params,
      result: host_import.result,
    });
  }

  return funcs;
}

export function core_host_import_arg_decision(
  contract: CoreHostImportArgContract,
  ownership: CoreOwnership,
): CoreHostImportDecision {
  switch (contract.tag) {
    case "scalar":
      if (ownership.tag === "scalar_local") {
        return {
          tag: "allowed",
          reason: "scalar host/import contract carries no ownership",
        };
      }

      return rejected_contract(
        "scalar",
        ownership,
      );

    case "bounded_borrow":
      if (ownership.tag === "borrow_view") {
        return {
          tag: "allowed",
          reason: "bounded-borrow host/import contract keeps the view inside " +
            "the call",
        };
      }

      if (ownership.tag === "scalar_local") {
        return {
          tag: "allowed",
          reason: "scalar value satisfies bounded-borrow host/import " +
            "contract without ownership",
        };
      }

      if (ownership.tag === "frozen_shareable") {
        return {
          tag: "allowed",
          reason: "frozen/shareable value satisfies bounded-borrow " +
            "host/import contract without ownership transfer",
        };
      }

      return rejected_contract(
        "bounded-borrow",
        ownership,
      );

    case "frozen_shareable":
      if (ownership.tag === "frozen_shareable") {
        return {
          tag: "allowed",
          reason: "frozen/shareable host/import contract can read without " +
            "ownership transfer",
        };
      }

      if (ownership.tag === "scalar_local") {
        return {
          tag: "allowed",
          reason: "scalar value satisfies frozen/shareable host/import " +
            "contract without ownership",
        };
      }

      return rejected_contract(
        "frozen/shareable",
        ownership,
      );

    case "ownership_transfer":
      if (ownership.tag === "unique_heap") {
        return {
          tag: "allowed",
          reason: "ownership-transfer host/import contract consumes " +
            core_ownership_result_text(ownership),
        };
      }

      return rejected_contract(
        "ownership-transfer",
        ownership,
      );
  }
}

function rejected_contract(
  contract: string,
  ownership: CoreOwnership,
): CoreHostImportDecision {
  return {
    tag: "rejected",
    reason: contract + " host/import contract cannot accept " +
      core_ownership_result_text(ownership),
  };
}

function check_core_host_import_call<ctx extends CoreHostImportCtx>(
  expr: Extract<CoreExpr, { tag: "app" }>,
  host_import: CoreHostImport,
  ctx: ctx,
  expr_type: (expr: CoreExpr, ctx: ctx) => ValType,
): void {
  expect(
    expr.args.length === host_import.params.length,
    "Core host import " + host_import.name + " expects " +
      host_import.params.length.toString() + " arguments",
  );
  expect(
    host_import.params.length === host_import.args.length,
    "Core host import " + host_import.name +
      " must declare one ownership contract per parameter",
  );

  for (let index = 0; index < expr.args.length; index += 1) {
    const arg = expr.args[index];
    const expected = host_import.params[index];
    expect(arg, "Missing core host import argument " + index.toString());
    expect(
      expected,
      "Missing core host import parameter " + index.toString(),
    );
    const actual = expr_type(arg, ctx);
    expect(
      actual === expected,
      "Core host import " + host_import.name + " argument " +
        index.toString() + " must be " + expected,
    );
  }
}
