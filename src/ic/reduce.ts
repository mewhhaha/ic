import { expect } from "../expect.ts";
import { Prim } from "../op.ts";
import { Callable, Reduce } from "../trait.ts";
import type { Ic } from "./ast.ts";
import { reduce_ic_graph } from "./graph_reduce.ts";
import { fold_prim, fold_select, is_binary_prim } from "./prim_reduce.ts";

type Ctx = {
  used: Set<string>;
  next: number;
  name: (prefix: string) => string;
  var: (prefix: string) => string;
};

type IcStep = Ic;
type PrimCall = Extract<Ic, { tag: "prim" }>;
type Lam = Extract<Ic, { tag: "lam" }>;
type App = Extract<Ic, { tag: "app" }>;
type Sup = Extract<Ic, { tag: "sup" }>;
type Dup = Extract<Ic, { tag: "dup" }>;
type Era = Extract<Ic, { tag: "era" }>;
type DupSup = [dup: Dup, sup: Sup];
type DupLam = [dup: Dup, lam: Lam];

function IcStep() {}
function PrimCall() {}
function Lam() {}
function App() {}
function Sup() {}
function Dup() {}
function Era() {}
function DupSup() {}
function DupLam() {}

export function reduce_ic(ic: Ic): Ic {
  const ctx = create_ctx(ic);
  return Reduce.reduce(IcStep, ctx, ic);
}

IcStep.reduce = function (ctx: Ctx, ic: IcStep): Ic {
  switch (ic.tag) {
    case "num":
    case "text":
    case "var":
      return ic;

    case "prim":
      return Reduce.reduce(PrimCall, ctx, ic);

    case "lam":
      return Reduce.reduce(Lam, ctx, ic);

    case "app":
      return Reduce.reduce(App, ctx, ic);

    case "sup":
      return Reduce.reduce(Sup, ctx, ic);

    case "dup":
      return Reduce.reduce(Dup, ctx, ic);

    case "era":
      return Reduce.reduce(Era, ctx, ic);

    case "fix":
      return reduce_ic_graph(ic);
  }
};

IcStep satisfies Reduce<Ctx, IcStep, Ic>;

PrimCall.reduce = function (ctx: Ctx, ic: PrimCall): Ic {
  const expected = Callable.arity(Prim, ic.prim);
  expect(
    ic.args.length === expected,
    "Primitive " + ic.prim + " expects " + expected + " arguments",
  );

  const args = Reduce.all(IcStep, ctx, ic.args);

  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    expect(item, "Missing primitive argument " + index);

    if (item.tag === "sup") {
      const body = spread_prim(ic.prim, args, index, item, ctx);
      return Reduce.reduce(IcStep, ctx, body);
    }
  }

  if (ic.prim === "i32.select" || ic.prim === "i64.select") {
    return fold_select(ic.prim, args);
  }

  if (expected === 0) {
    return { tag: "prim", prim: ic.prim, args };
  }

  if (expected !== 2) {
    return { tag: "prim", prim: ic.prim, args };
  }

  expect(is_binary_prim(ic.prim), "Expected binary primitive: " + ic.prim);
  const left = args[0];
  const right = args[1];
  expect(left, "Missing primitive argument 0");
  expect(right, "Missing primitive argument 1");

  if (left.tag === "num" && right.tag === "num") {
    return fold_prim(ic.prim, left, right);
  }

  return {
    tag: "prim",
    prim: ic.prim,
    args,
  };
};

PrimCall satisfies Reduce<Ctx, PrimCall, Ic>;

function spread_prim(
  prim: Prim,
  args: Ic[],
  index: number,
  sup: Extract<Ic, { tag: "sup" }>,
  ctx: Ctx,
): Ic {
  const left_args: Ic[] = [];
  const right_args: Ic[] = [];
  const copy_names: string[] = [];
  const copy_exprs: Ic[] = [];

  for (let pos = 0; pos < args.length; pos += 1) {
    const input = args[pos];
    expect(input, "Missing primitive argument " + pos);

    if (pos === index) {
      left_args.push(sup.left);
      right_args.push(sup.right);
    } else {
      const name = ctx.name("p");
      copy_names.push(name);
      copy_exprs.push(input);
      left_args.push({ tag: "var", name: `${name}0` });
      right_args.push({ tag: "var", name: `${name}1` });
    }
  }

  let body: Ic = {
    tag: "sup",
    label: sup.label,
    left: { tag: "prim", prim, args: left_args },
    right: { tag: "prim", prim, args: right_args },
  };

  for (let copy = copy_names.length - 1; copy >= 0; copy -= 1) {
    const name = copy_names[copy];
    const expr = copy_exprs[copy];
    expect(name, "Missing copied primitive name");
    expect(expr, "Missing copied primitive expression");

    body = {
      tag: "dup",
      label: sup.label,
      name,
      expr,
      body,
    };
  }

  return body;
}

Lam.reduce = function (ctx: Ctx, ic: Lam): Ic {
  return {
    tag: "lam",
    name: ic.name,
    body: Reduce.reduce(IcStep, ctx, ic.body),
  };
};

Lam satisfies Reduce<Ctx, Lam, Ic>;

App.reduce = function (ctx: Ctx, ic: App): Ic {
  const func = Reduce.reduce(IcStep, ctx, ic.func);
  const value = Reduce.reduce(IcStep, ctx, ic.arg);

  if (func.tag === "lam") {
    return Reduce.reduce(IcStep, ctx, subst(func.body, func.name, value));
  }

  if (func.tag === "sup") {
    const name = ctx.name("x");
    return Reduce.reduce(
      IcStep,
      ctx,
      {
        tag: "dup",
        label: func.label,
        name,
        expr: value,
        body: {
          tag: "sup",
          label: func.label,
          left: {
            tag: "app",
            func: func.left,
            arg: { tag: "var", name: `${name}0` },
          },
          right: {
            tag: "app",
            func: func.right,
            arg: { tag: "var", name: `${name}1` },
          },
        },
      },
    );
  }

  return { tag: "app", func, arg: value };
};

App satisfies Reduce<Ctx, App, Ic>;

Sup.reduce = function (ctx: Ctx, ic: Sup): Ic {
  return {
    tag: "sup",
    label: ic.label,
    left: Reduce.reduce(IcStep, ctx, ic.left),
    right: Reduce.reduce(IcStep, ctx, ic.right),
  };
};

Sup satisfies Reduce<Ctx, Sup, Ic>;

Dup.reduce = function (ctx: Ctx, ic: Dup): Ic {
  const expr = Reduce.reduce(IcStep, ctx, ic.expr);

  if (expr.tag === "sup") {
    return Reduce.reduce(DupSup, ctx, [ic, expr]);
  }

  if (expr.tag === "lam") {
    return Reduce.reduce(DupLam, ctx, [ic, expr]);
  }

  if (expr.tag === "num" || expr.tag === "text") {
    const left = subst(ic.body, `${ic.name}0`, expr);
    const right = subst(left, `${ic.name}1`, expr);
    return Reduce.reduce(IcStep, ctx, right);
  }

  const body = Reduce.reduce(IcStep, ctx, ic.body);
  const left_name = `${ic.name}0`;
  const right_name = `${ic.name}1`;
  const left_uses = ic_name_use_count(body, left_name);
  const right_uses = ic_name_use_count(body, right_name);

  if (left_uses === 0 && right_uses === 0) {
    return Reduce.reduce(IcStep, ctx, { tag: "era", expr, body });
  }

  if (left_uses === 0 && right_uses === 1) {
    return Reduce.reduce(IcStep, ctx, subst(body, right_name, expr));
  }

  if (left_uses === 1 && right_uses === 0) {
    return Reduce.reduce(IcStep, ctx, subst(body, left_name, expr));
  }

  return {
    tag: "dup",
    label: ic.label,
    name: ic.name,
    expr,
    body,
  };
};

Dup satisfies Reduce<Ctx, Dup, Ic>;

Era.reduce = function (ctx: Ctx, ic: Era): Ic {
  const expr = Reduce.reduce(IcStep, ctx, ic.expr);
  const body = erase(expr, ic.body);
  return Reduce.reduce(IcStep, ctx, body);
};

Era satisfies Reduce<Ctx, Era, Ic>;

DupSup.reduce = function (ctx: Ctx, pair: DupSup): Ic {
  const [ic, expr] = pair;

  if (expr.label === ic.label) {
    const left = subst(ic.body, `${ic.name}0`, expr.left);
    const right = subst(left, `${ic.name}1`, expr.right);
    return Reduce.reduce(IcStep, ctx, right);
  }

  const left_name = ctx.name("a");
  const right_name = ctx.name("b");
  const left_projection: Ic = {
    tag: "sup",
    label: expr.label,
    left: { tag: "var", name: `${left_name}0` },
    right: { tag: "var", name: `${right_name}0` },
  };
  const right_projection: Ic = {
    tag: "sup",
    label: expr.label,
    left: { tag: "var", name: `${left_name}1` },
    right: { tag: "var", name: `${right_name}1` },
  };
  const left = subst(ic.body, `${ic.name}0`, left_projection);
  const right = subst(left, `${ic.name}1`, right_projection);

  return Reduce.reduce(
    IcStep,
    ctx,
    {
      tag: "dup",
      label: ic.label,
      name: left_name,
      expr: expr.left,
      body: {
        tag: "dup",
        label: ic.label,
        name: right_name,
        expr: expr.right,
        body: right,
      },
    },
  );
};

DupSup satisfies Reduce<Ctx, DupSup, Ic>;

DupLam.reduce = function (ctx: Ctx, pair: DupLam): Ic {
  const [ic, expr] = pair;

  const body_name = ctx.name("b");
  const left_name = ctx.var(expr.name);
  const right_name = ctx.var(expr.name);
  const shared_body = subst(expr.body, expr.name, {
    tag: "sup",
    label: ic.label,
    left: { tag: "var", name: left_name },
    right: { tag: "var", name: right_name },
  });

  const left_func: Ic = {
    tag: "lam",
    name: left_name,
    body: { tag: "var", name: `${body_name}0` },
  };
  const right_func: Ic = {
    tag: "lam",
    name: right_name,
    body: { tag: "var", name: `${body_name}1` },
  };

  const left = subst(ic.body, `${ic.name}0`, left_func);
  const right = subst(left, `${ic.name}1`, right_func);
  return Reduce.reduce(
    IcStep,
    ctx,
    {
      tag: "dup",
      label: ic.label,
      name: body_name,
      expr: shared_body,
      body: right,
    },
  );
};

DupLam satisfies Reduce<Ctx, DupLam, Ic>;

function erase(expr: Ic, body: Ic): Ic {
  switch (expr.tag) {
    case "num":
    case "text":
    case "var":
      return body;

    case "prim":
      return erase_many(expr.args, body);

    case "lam":
      return { tag: "era", expr: expr.body, body };

    case "app":
      return erase_many([expr.func, expr.arg], body);

    case "sup":
      return erase_many([expr.left, expr.right], body);

    case "dup": {
      const left: Ic = { tag: "var", name: `${expr.name}0` };
      const right: Ic = { tag: "var", name: `${expr.name}1` };
      const next = erase_many([left, right], expr.body);
      return erase_many([expr.expr, next], body);
    }

    case "era":
      return erase_many([expr.expr, expr.body], body);

    case "fix":
      return erase_many([expr.expr, expr.body], body);
  }
}

function erase_many(items: Ic[], next: Ic): Ic {
  let result = next;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    expect(item, "Missing erasure item " + index);
    result = { tag: "era", expr: item, body: result };
  }

  return result;
}

function create_ctx(ic: Ic): Ctx {
  const ctx: Ctx = {
    used: collect_names(ic),
    next: 0,
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
    var(prefix: string): string {
      while (true) {
        const name = "_" + prefix + ctx.next.toString();
        ctx.next += 1;

        if (!ctx.used.has(name)) {
          ctx.used.add(name);
          return name;
        }
      }
    },
  };

  return ctx;
}

function collect_names(ic: Ic, out = new Set<string>()): Set<string> {
  switch (ic.tag) {
    case "num":
    case "text":
      return out;

    case "var":
      out.add(ic.name);
      return out;

    case "prim":
      for (const item of ic.args) {
        collect_names(item, out);
      }

      return out;

    case "lam":
      out.add(ic.name);
      collect_names(ic.body, out);
      return out;

    case "app":
      collect_names(ic.func, out);
      collect_names(ic.arg, out);
      return out;

    case "sup":
      collect_names(ic.left, out);
      collect_names(ic.right, out);
      return out;

    case "dup":
      out.add(ic.name);
      out.add(`${ic.name}0`);
      out.add(`${ic.name}1`);
      collect_names(ic.expr, out);
      collect_names(ic.body, out);
      return out;

    case "era":
      collect_names(ic.expr, out);
      collect_names(ic.body, out);
      return out;

    case "fix":
      out.add(ic.name);
      collect_names(ic.expr, out);
      collect_names(ic.body, out);
      return out;
  }
}

function subst(ic: Ic, name: string, value: Ic): Ic {
  switch (ic.tag) {
    case "num":
    case "text":
      return ic;

    case "var":
      if (ic.name === name) {
        return value;
      }

      return ic;

    case "prim":
      return {
        tag: "prim",
        prim: ic.prim,
        args: ic.args.map((item) => subst(item, name, value)),
      };

    case "lam":
      if (ic.name === name) {
        return ic;
      }

      return {
        tag: "lam",
        name: ic.name,
        body: subst(ic.body, name, value),
      };

    case "app":
      return {
        tag: "app",
        func: subst(ic.func, name, value),
        arg: subst(ic.arg, name, value),
      };

    case "sup":
      return {
        tag: "sup",
        label: ic.label,
        left: subst(ic.left, name, value),
        right: subst(ic.right, name, value),
      };

    case "dup": {
      const expr = subst(ic.expr, name, value);

      if (name === `${ic.name}0` || name === `${ic.name}1`) {
        return {
          tag: "dup",
          label: ic.label,
          name: ic.name,
          expr,
          body: ic.body,
        };
      }

      return {
        tag: "dup",
        label: ic.label,
        name: ic.name,
        expr,
        body: subst(ic.body, name, value),
      };
    }

    case "era":
      return {
        tag: "era",
        expr: subst(ic.expr, name, value),
        body: subst(ic.body, name, value),
      };

    case "fix":
      if (ic.name === name) {
        return ic;
      }

      return {
        tag: "fix",
        name: ic.name,
        expr: subst(ic.expr, name, value),
        body: subst(ic.body, name, value),
      };
  }
}

function ic_name_use_count(ic: Ic, name: string): number {
  switch (ic.tag) {
    case "num":
    case "text":
      return 0;

    case "var":
      if (ic.name === name) {
        return 1;
      }

      return 0;

    case "prim": {
      let count = 0;

      for (const arg of ic.args) {
        count += ic_name_use_count(arg, name);
      }

      return count;
    }

    case "lam":
      if (ic.name === name) {
        return 0;
      }

      return ic_name_use_count(ic.body, name);

    case "app":
      return ic_name_use_count(ic.func, name) +
        ic_name_use_count(ic.arg, name);

    case "sup":
      return ic_name_use_count(ic.left, name) +
        ic_name_use_count(ic.right, name);

    case "dup": {
      const expr_count = ic_name_use_count(ic.expr, name);

      if (name === `${ic.name}0` || name === `${ic.name}1`) {
        return expr_count;
      }

      return expr_count + ic_name_use_count(ic.body, name);
    }

    case "era":
      return ic_name_use_count(ic.expr, name) +
        ic_name_use_count(ic.body, name);

    case "fix":
      if (ic.name === name) {
        return 0;
      }

      return ic_name_use_count(ic.expr, name) +
        ic_name_use_count(ic.body, name);
  }
}
