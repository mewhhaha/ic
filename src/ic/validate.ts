import { Prim } from "../op.ts";
import { Callable } from "../trait.ts";
import type { Ic } from "./ast.ts";
import { expect_ic_label } from "./labels.ts";

export type IcValidationIssue = {
  path: string;
  message: string;
};

export type IcValidation = {
  ok: boolean;
  issues: IcValidationIssue[];
};

type Ctx = {
  issues: IcValidationIssue[];
  reserved: Map<string, string>;
  binders: Set<string>;
  recursive: Set<string>;
  uses: Map<string, number>;
};

export function validate_ic(ic: Ic): IcValidation {
  const ctx: Ctx = {
    issues: [],
    reserved: new Map(),
    binders: new Set(),
    recursive: new Set(),
    uses: new Map(),
  };
  visit(ctx, ic, "$");
  check_uses(ctx);
  return { ok: ctx.issues.length === 0, issues: ctx.issues };
}

export function assert_valid_ic(ic: Ic): void {
  const validation = validate_ic(ic);

  if (validation.ok) {
    return;
  }

  const first = validation.issues[0];

  if (!first) {
    throw new Error("Invalid Ic term");
  }

  throw new Error(first.path + ": " + first.message);
}

function issue(ctx: Ctx, path: string, message: string): void {
  ctx.issues.push({ path, message });
}

function reserve(ctx: Ctx, name: string, path: string, binder: boolean): void {
  const previous = ctx.reserved.get(name);

  if (previous) {
    issue(ctx, path, "Duplicate Ic name " + name + "; first at " + previous);
    return;
  }

  ctx.reserved.set(name, path);

  if (binder) {
    ctx.binders.add(name);
  }
}

function use_name(ctx: Ctx, name: string): void {
  const current = ctx.uses.get(name);

  if (current === undefined) {
    ctx.uses.set(name, 1);
    return;
  }

  ctx.uses.set(name, current + 1);
}

function visit(ctx: Ctx, ic: Ic, path: string): void {
  switch (ic.tag) {
    case "num":
      validate_num(ctx, ic, path);
      return;

    case "text":
      return;

    case "var":
      use_name(ctx, ic.name);
      return;

    case "prim": {
      const expected = Callable.arity(Prim, ic.prim);

      if (ic.args.length !== expected) {
        issue(
          ctx,
          path,
          "Primitive " + ic.prim + " expects " + expected + " arguments",
        );
      }

      for (let index = 0; index < ic.args.length; index += 1) {
        const arg = ic.args[index];

        if (!arg) {
          issue(ctx, path, "Missing primitive argument " + index);
          continue;
        }

        visit(ctx, arg, path + ".args[" + index.toString() + "]");
      }

      return;
    }

    case "lam":
      reserve(ctx, ic.name, path + ".name", true);
      visit(ctx, ic.body, path + ".body");
      return;

    case "app":
      visit(ctx, ic.func, path + ".func");
      visit(ctx, ic.arg, path + ".arg");
      return;

    case "sup":
      validate_label(ctx, ic.label, path + ".label");
      visit(ctx, ic.left, path + ".left");
      visit(ctx, ic.right, path + ".right");
      return;

    case "dup":
      validate_label(ctx, ic.label, path + ".label");
      reserve(ctx, ic.name, path + ".name", false);
      reserve(ctx, ic.name + "0", path + ".name0", true);
      reserve(ctx, ic.name + "1", path + ".name1", true);
      visit(ctx, ic.expr, path + ".expr");
      visit(ctx, ic.body, path + ".body");
      return;

    case "era":
      visit(ctx, ic.expr, path + ".expr");
      visit(ctx, ic.body, path + ".body");
      return;

    case "fix":
      reserve(ctx, ic.name, path + ".name", true);
      ctx.recursive.add(ic.name);
      visit(ctx, ic.expr, path + ".expr");
      visit(ctx, ic.body, path + ".body");
      return;
  }
}

function validate_num(
  ctx: Ctx,
  ic: Extract<Ic, { tag: "num" }>,
  path: string,
): void {
  if (ic.type === "i32") {
    if (typeof ic.value !== "number") {
      issue(ctx, path, "i32 literal must use a number value");
    }

    return;
  }

  if (typeof ic.value !== "bigint") {
    issue(ctx, path, "i64 literal must use a bigint value");
  }
}

function validate_label(ctx: Ctx, label: string, path: string): void {
  try {
    expect_ic_label(label);
  } catch (error) {
    if (error instanceof Error) {
      issue(ctx, path, error.message);
      return;
    }

    throw error;
  }
}

function check_uses(ctx: Ctx): void {
  for (const [name, count] of ctx.uses) {
    if (ctx.recursive.has(name)) {
      continue;
    }

    if (count <= 1) {
      continue;
    }

    if (ctx.binders.has(name)) {
      issue(ctx, "$", "Affine variable used more than once: " + name);
    } else {
      issue(ctx, "$", "Free variable used more than once: " + name);
    }
  }
}
