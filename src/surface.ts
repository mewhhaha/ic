import { expect } from "./expect.ts";
import { Expr } from "./expr.ts";
import { Ic, type Ic as IcNode } from "./ic.ts";
import type { Func, Mod as ModNode } from "./mod.ts";
import type { Prim, ValType } from "./op.ts";
import { Emit, Typed, type Emit as EmitTrait } from "./trait.ts";

export type Term =
  | { tag: "num"; type: ValType; value: number | bigint }
  | { tag: "var"; name: string }
  | { tag: "prim"; prim: Prim; args: Term[] }
  | { tag: "lam"; name: string; body: Term }
  | { tag: "app"; func: Term; arg: Term }
  | { tag: "sup"; label: string; left: Term; right: Term }
  | { tag: "let"; name: string; value: Term; body: Term };

export type Statement =
  | { tag: "let"; name: string; value: Term; exported?: boolean }
  | { tag: "expr"; value: Term; exportedAs?: string };

export type Surface = {
  statements: Statement[];
};

type Binding = {
  uses: IcNode[];
  next: number;
};

type Ctx = {
  defs: Map<string, Term>;
  resolving: Set<string>;
  used: Set<string>;
  labels: Set<string>;
  next: number;
  nextLabel: number;
  name: (prefix: string) => string;
  label: () => string;
};

export function Term() {}
export function Surface() {}

Term.emit = function emit(term: Term): IcNode {
  const ctx = Ctx([], new Map());
  return lower(term, ctx, new Map());
};

Term satisfies EmitTrait<Term, IcNode>;

Surface.emit = function emit(surface: Surface): ModNode {
  const defs = new Map<string, Term>();
  const funcs: Record<string, Func> = {};
  const exports: string[] = [];
  const runs: Term[] = [];

  for (const statement of surface.statements) {
    if (statement.tag === "let") {
      expect(
        !defs.has(statement.name),
        "Duplicate top-level binding: " + statement.name,
      );
      defs.set(statement.name, statement.value);

      if (statement.exported === true) {
        addFunc(funcs, exports, statement.name, statement.value, defs);
      }
    }

    if (statement.tag === "expr") {
      if (statement.exportedAs !== undefined) {
        addFunc(funcs, exports, statement.exportedAs, statement.value, defs);
      } else {
        runs.push(statement.value);
      }
    }
  }

  if (runs.length > 0) {
    const main = compileTopLevel(runs, defs);
    addCompiledFunc(funcs, exports, "main", main);
  }

  return { funcs, exports };
};

Surface satisfies EmitTrait<Surface, ModNode>;

function addFunc(
  funcs: Record<string, Func>,
  exports: string[],
  name: string,
  term: Term,
  defs: Map<string, Term>,
): void {
  const ic = compileTerm(term, defs);
  addCompiledFunc(funcs, exports, name, ic);
}

function addCompiledFunc(
  funcs: Record<string, Func>,
  exports: string[],
  name: string,
  ic: IcNode,
): void {
  expect(funcs[name] === undefined, "Duplicate exported function: " + name);

  const expr = Emit.emit(Ic, ic);
  funcs[name] = {
    name,
    result: Typed.type(Expr, expr),
    body: Emit.emit(Expr, expr),
  };
  exports.push(name);
}

function compileTerm(term: Term, defs: Map<string, Term>): IcNode {
  const ctx = Ctx([term], defs);
  return lower(term, ctx, new Map());
}

function compileTopLevel(runs: Term[], defs: Map<string, Term>): IcNode {
  const ctx = Ctx(runs, defs);
  const last = runs[runs.length - 1];
  expect(last, "Module needs a top-level expression");

  let body = lower(last, ctx, new Map());

  for (let index = runs.length - 2; index >= 0; index -= 1) {
    const item = runs[index];
    expect(item, "Missing top-level expression " + index);
    body = {
      tag: "era",
      expr: lower(item, ctx, new Map()),
      body,
    };
  }

  return body;
}

function lower(term: Term, ctx: Ctx, env: Map<string, Binding>): IcNode {
  switch (term.tag) {
    case "num":
      return { tag: "num", type: term.type, value: term.value };

    case "var":
      return lowerVar(term.name, ctx, env);

    case "prim":
      return {
        tag: "prim",
        prim: term.prim,
        args: term.args.map((item) => lower(item, ctx, env)),
      };

    case "lam":
      return lowerLam(term, ctx, env);

    case "app":
      return {
        tag: "app",
        func: lower(term.func, ctx, env),
        arg: lower(term.arg, ctx, env),
      };

    case "sup":
      return {
        tag: "sup",
        label: term.label,
        left: lower(term.left, ctx, env),
        right: lower(term.right, ctx, env),
      };

    case "let":
      return lowerLet(term, ctx, env);
  }
}

function lowerVar(name: string, ctx: Ctx, env: Map<string, Binding>): IcNode {
  const binding = env.get(name);

  if (binding !== undefined) {
    const value = binding.uses[binding.next];
    expect(value, "Variable " + name + " used too many times");
    binding.next += 1;
    return value;
  }

  const def = ctx.defs.get(name);

  if (def !== undefined) {
    expect(!ctx.resolving.has(name), "Recursive top-level binding: " + name);
    ctx.resolving.add(name);
    const value = lower(def, ctx, env);
    ctx.resolving.delete(name);
    return value;
  }

  throw new Error("Unbound source variable: " + name);
}

function lowerLam(
  term: Extract<Term, { tag: "lam" }>,
  ctx: Ctx,
  env: Map<string, Binding>,
): IcNode {
  const count = countUses(term.body, term.name);
  const bodyEnv = shadow(env, term.name);

  if (count === 0) {
    return {
      tag: "lam",
      name: term.name,
      body: {
        tag: "era",
        expr: { tag: "var", name: term.name },
        body: lower(term.body, ctx, bodyEnv),
      },
    };
  }

  const body = useValue(
    { tag: "var", name: term.name },
    count,
    ctx,
    (uses) => lowerWithBinding(term.body, term.name, uses, ctx, bodyEnv),
  );

  return {
    tag: "lam",
    name: term.name,
    body,
  };
}

function lowerLet(
  term: Extract<Term, { tag: "let" }>,
  ctx: Ctx,
  env: Map<string, Binding>,
): IcNode {
  const value = lower(term.value, ctx, env);
  const count = countUses(term.body, term.name);
  const bodyEnv = shadow(env, term.name);

  if (count === 0) {
    return {
      tag: "era",
      expr: value,
      body: lower(term.body, ctx, bodyEnv),
    };
  }

  return useValue(
    value,
    count,
    ctx,
    (uses) => lowerWithBinding(term.body, term.name, uses, ctx, bodyEnv),
  );
}

function lowerWithBinding(
  term: Term,
  name: string,
  uses: IcNode[],
  ctx: Ctx,
  env: Map<string, Binding>,
): IcNode {
  const next = new Map(env);
  const binding = { uses, next: 0 };
  next.set(name, binding);
  const body = lower(term, ctx, next);
  expect(
    binding.next === uses.length,
    "Variable " + name + " was not fully consumed",
  );
  return body;
}

function useValue(
  value: IcNode,
  count: number,
  ctx: Ctx,
  build: (uses: IcNode[]) => IcNode,
): IcNode {
  expect(count > 0, "Value must be used at least once");

  if (count === 1) {
    return build([value]);
  }

  const leftCount = Math.floor(count / 2);
  const rightCount = count - leftCount;
  const name = ctx.name("v");

  return {
    tag: "dup",
    label: ctx.label(),
    name,
    expr: value,
    body: useValue(
      { tag: "var", name: `${name}0` },
      leftCount,
      ctx,
      (leftUses) => {
        return useValue(
          { tag: "var", name: `${name}1` },
          rightCount,
          ctx,
          (rightUses) => build(leftUses.concat(rightUses)),
        );
      },
    ),
  };
}

function countUses(term: Term, name: string): number {
  switch (term.tag) {
    case "num":
      return 0;

    case "var":
      if (term.name === name) {
        return 1;
      }

      return 0;

    case "prim": {
      let count = 0;

      for (const item of term.args) {
        count += countUses(item, name);
      }

      return count;
    }

    case "lam":
      if (term.name === name) {
        return 0;
      }

      return countUses(term.body, name);

    case "app":
      return countUses(term.func, name) + countUses(term.arg, name);

    case "sup":
      return countUses(term.left, name) + countUses(term.right, name);

    case "let": {
      const valueCount = countUses(term.value, name);

      if (term.name === name) {
        return valueCount;
      }

      return valueCount + countUses(term.body, name);
    }
  }
}

function shadow(env: Map<string, Binding>, name: string): Map<string, Binding> {
  const next = new Map(env);
  next.delete(name);
  return next;
}

function Ctx(terms: Term[], defs: Map<string, Term>): Ctx {
  const ctx: Ctx = {
    defs,
    resolving: new Set(),
    used: collectNames(terms, defs),
    labels: collectLabels(terms, defs),
    next: 0,
    nextLabel: 0,
    name(prefix: string): string {
      while (true) {
        const name = "_" + prefix + ctx.next.toString();
        ctx.next += 1;

        if (
          !ctx.used.has(name) &&
          !ctx.used.has(`${name}0`) &&
          !ctx.used.has(`${name}1`)
        ) {
          ctx.used.add(name);
          ctx.used.add(`${name}0`);
          ctx.used.add(`${name}1`);
          return name;
        }
      }
    },
    label(): string {
      while (true) {
        const label = "S" + ctx.nextLabel.toString();
        ctx.nextLabel += 1;

        if (!ctx.labels.has(label)) {
          ctx.labels.add(label);
          return label;
        }
      }
    },
  };

  return ctx;
}

function collectNames(terms: Term[], defs: Map<string, Term>): Set<string> {
  const out = new Set<string>();

  for (const term of terms) {
    collectTermNames(term, out);
  }

  for (const name of defs.keys()) {
    out.add(name);
  }

  for (const term of defs.values()) {
    collectTermNames(term, out);
  }

  return out;
}

function collectTermNames(term: Term, out: Set<string>): void {
  switch (term.tag) {
    case "num":
      return;

    case "var":
      out.add(term.name);
      return;

    case "prim":
      for (const item of term.args) {
        collectTermNames(item, out);
      }
      return;

    case "lam":
      out.add(term.name);
      collectTermNames(term.body, out);
      return;

    case "app":
      collectTermNames(term.func, out);
      collectTermNames(term.arg, out);
      return;

    case "sup":
      collectTermNames(term.left, out);
      collectTermNames(term.right, out);
      return;

    case "let":
      out.add(term.name);
      collectTermNames(term.value, out);
      collectTermNames(term.body, out);
      return;
  }
}

function collectLabels(terms: Term[], defs: Map<string, Term>): Set<string> {
  const out = new Set<string>();

  for (const term of terms) {
    collectTermLabels(term, out);
  }

  for (const term of defs.values()) {
    collectTermLabels(term, out);
  }

  return out;
}

function collectTermLabels(term: Term, out: Set<string>): void {
  switch (term.tag) {
    case "num":
    case "var":
      return;

    case "prim":
      for (const item of term.args) {
        collectTermLabels(item, out);
      }
      return;

    case "lam":
      collectTermLabels(term.body, out);
      return;

    case "app":
      collectTermLabels(term.func, out);
      collectTermLabels(term.arg, out);
      return;

    case "sup":
      out.add(term.label);
      collectTermLabels(term.left, out);
      collectTermLabels(term.right, out);
      return;

    case "let":
      collectTermLabels(term.value, out);
      collectTermLabels(term.body, out);
      return;
  }
}
