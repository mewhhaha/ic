import { expect } from "../expect.ts";
import { Prim } from "../op.ts";
import { Callable } from "../trait.ts";
import type { Ic } from "./ast.ts";
import { fold_prim, fold_select, is_binary_prim } from "./prim_reduce.ts";

type Ref = number;

type GraphNode =
  | { tag: "num"; type: IcNum["type"]; value: IcNum["value"] }
  | { tag: "text"; value: string }
  | { tag: "var"; name: string }
  | { tag: "prim"; prim: Prim; args: Ref[] }
  | { tag: "lam"; name: string; body: Ref }
  | { tag: "app"; func: Ref; arg: Ref }
  | { tag: "sup"; label: string; left: Ref; right: Ref }
  | { tag: "dup"; label: string; name: string; expr: Ref; body: Ref }
  | { tag: "era"; expr: Ref; body: Ref };

type IcNum = Extract<Ic, { tag: "num" }>;
export type IcReduceStats = {
  steps: number;
  allocs: number;
  max_refs: number;
  app_lam: number;
  app_sup: number;
  dup_sup_same: number;
  dup_sup_diff: number;
  dup_lam: number;
  prim_folds: number;
  prim_spreads: number;
  select_folds: number;
  select_dynamic: number;
  erasures: number;
};

export type IcGraphSnapshot = {
  label: string;
  text: string;
};

export type IcReduceDebug = {
  result: Ic;
  stats: IcReduceStats;
  snapshots: IcGraphSnapshot[];
};

type GraphCtx = {
  nodes: Map<Ref, GraphNode>;
  next_ref: number;
  used: Set<string>;
  next_name: number;
  max_steps: number;
  stats: IcReduceStats;
};

export function reduce_ic_graph(ic: Ic): Ic {
  return reduce_ic_graph_debug(ic).result;
}

export function reduce_ic_graph_debug(ic: Ic): IcReduceDebug {
  const ctx = create_ctx(ic);
  const root = from_ic(ctx, ic, new Map());
  const initial = dump_graph(ctx, root);
  const reduced = reduce_ref(ctx, root);
  const reduced_graph = dump_graph(ctx, reduced);
  const result = to_ic(ctx, reduced, new Set());
  return {
    result,
    stats: { ...ctx.stats },
    snapshots: [
      { label: "initial", text: initial },
      { label: "reduced", text: reduced_graph },
    ],
  };
}

export function dump_ic_graph(ic: Ic): string {
  const ctx = create_ctx(ic);
  const root = from_ic(ctx, ic, new Map());
  return dump_graph(ctx, root);
}

function create_ctx(ic: Ic): GraphCtx {
  return {
    nodes: new Map(),
    next_ref: 0,
    used: collect_names(ic),
    next_name: 0,
    max_steps: 1_000_000,
    stats: empty_stats(),
  };
}

function empty_stats(): IcReduceStats {
  return {
    steps: 0,
    allocs: 0,
    max_refs: 0,
    app_lam: 0,
    app_sup: 0,
    dup_sup_same: 0,
    dup_sup_diff: 0,
    dup_lam: 0,
    prim_folds: 0,
    prim_spreads: 0,
    select_folds: 0,
    select_dynamic: 0,
    erasures: 0,
  };
}

function alloc(ctx: GraphCtx, node: GraphNode): Ref {
  const ref = ctx.next_ref;
  ctx.next_ref += 1;
  ctx.nodes.set(ref, node);
  ctx.stats.allocs += 1;

  if (ctx.nodes.size > ctx.stats.max_refs) {
    ctx.stats.max_refs = ctx.nodes.size;
  }

  return ref;
}

function from_ic(
  ctx: GraphCtx,
  ic: Ic,
  env: Map<string, Ref>,
): Ref {
  switch (ic.tag) {
    case "num":
      return alloc(ctx, { tag: "num", type: ic.type, value: ic.value });

    case "text":
      return alloc(ctx, { tag: "text", value: ic.value });

    case "var": {
      const bound = env.get(ic.name);

      if (bound !== undefined) {
        return bound;
      }

      return alloc(ctx, { tag: "var", name: ic.name });
    }

    case "prim":
      return alloc(ctx, {
        tag: "prim",
        prim: ic.prim,
        args: ic.args.map((arg) => from_ic(ctx, arg, env)),
      });

    case "lam":
      return alloc(ctx, {
        tag: "lam",
        name: ic.name,
        body: from_ic(ctx, ic.body, env),
      });

    case "app":
      return alloc(ctx, {
        tag: "app",
        func: from_ic(ctx, ic.func, env),
        arg: from_ic(ctx, ic.arg, env),
      });

    case "sup":
      return alloc(ctx, {
        tag: "sup",
        label: ic.label,
        left: from_ic(ctx, ic.left, env),
        right: from_ic(ctx, ic.right, env),
      });

    case "dup":
      return alloc(ctx, {
        tag: "dup",
        label: ic.label,
        name: ic.name,
        expr: from_ic(ctx, ic.expr, env),
        body: from_ic(ctx, ic.body, env),
      });

    case "era":
      return alloc(ctx, {
        tag: "era",
        expr: from_ic(ctx, ic.expr, env),
        body: from_ic(ctx, ic.body, env),
      });

    case "fix": {
      const self = alloc(ctx, { tag: "var", name: ic.name });
      const local = new Map(env);
      local.set(ic.name, self);
      const expr = from_ic(ctx, ic.expr, local);
      expect(expr !== self, "Recursive binding cannot directly equal itself");
      const expr_node = ctx.nodes.get(expr);
      expect(expr_node, "Missing recursive Ic graph node");
      ctx.nodes.set(self, clone_node(expr_node));
      return from_ic(ctx, ic.body, local);
    }
  }
}

function reduce_ref(ctx: GraphCtx, ref: Ref): Ref {
  ctx.stats.steps += 1;
  expect(
    ctx.stats.steps <= ctx.max_steps,
    "Ic graph reduction step limit exceeded",
  );

  const current = ctx.nodes.get(ref);
  expect(current, "Missing Ic graph node " + ref.toString());

  switch (current.tag) {
    case "num":
    case "text":
    case "var":
      return ref;

    case "lam":
      if (contains_ref(ctx, current.body, ref, new Set())) {
        return ref;
      }

      {
        const body = reduce_ref(ctx, current.body);
        ctx.nodes.set(ref, { tag: "lam", name: current.name, body });
        return ref;
      }

    case "prim":
      return reduce_prim(ctx, ref, current);

    case "app":
      return reduce_app(ctx, ref, current);

    case "sup": {
      const left = reduce_ref(ctx, current.left);
      const right = reduce_ref(ctx, current.right);
      ctx.nodes.set(ref, {
        tag: "sup",
        label: current.label,
        left,
        right,
      });
      return ref;
    }

    case "dup":
      return reduce_dup(ctx, ref, current);

    case "era":
      return reduce_era(ctx, ref, current);
  }
}

function reduce_prim(
  ctx: GraphCtx,
  ref: Ref,
  current: Extract<GraphNode, { tag: "prim" }>,
): Ref {
  const expected = Callable.arity(Prim, current.prim);
  expect(
    current.args.length === expected,
    "Primitive " + current.prim + " expects " + expected + " arguments",
  );

  if (current.prim === "i32.select" || current.prim === "i64.select") {
    return reduce_select(ctx, ref, current);
  }

  const args: Ref[] = [];

  for (let index = 0; index < current.args.length; index += 1) {
    const arg = current.args[index];
    expect(arg !== undefined, "Missing primitive argument " + index);
    args.push(reduce_ref(ctx, arg));
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    expect(arg !== undefined, "Missing primitive argument " + index);
    const arg_node = ctx.nodes.get(arg);
    expect(arg_node, "Missing primitive argument node " + index);

    if (arg_node.tag === "sup") {
      ctx.stats.prim_spreads += 1;
      const spread = spread_prim(ctx, current.prim, args, index, arg_node);
      const reduced = reduce_ref(ctx, spread);
      return replace_ref(ctx, ref, reduced);
    }
  }

  if (expected !== 2) {
    ctx.nodes.set(ref, { tag: "prim", prim: current.prim, args });
    return ref;
  }

  expect(
    is_binary_prim(current.prim),
    "Expected binary primitive: " + current.prim,
  );
  const left_ref = args[0];
  const right_ref = args[1];
  expect(left_ref !== undefined, "Missing primitive argument 0");
  expect(right_ref !== undefined, "Missing primitive argument 1");
  const left = ctx.nodes.get(left_ref);
  const right = ctx.nodes.get(right_ref);
  expect(left, "Missing primitive left argument");
  expect(right, "Missing primitive right argument");

  if (left.tag === "num" && right.tag === "num") {
    ctx.stats.prim_folds += 1;
    const folded = fold_prim(
      current.prim,
      node_to_num(left),
      node_to_num(right),
    );
    const folded_ref = from_ic(ctx, folded, new Map());
    return replace_ref(ctx, ref, folded_ref);
  }

  ctx.nodes.set(ref, { tag: "prim", prim: current.prim, args });
  return ref;
}

function reduce_select(
  ctx: GraphCtx,
  ref: Ref,
  current: Extract<GraphNode, { tag: "prim" }>,
): Ref {
  const then_ref = current.args[0];
  const else_ref = current.args[1];
  const cond_ref = current.args[2];
  expect(then_ref !== undefined, "Missing select then branch");
  expect(else_ref !== undefined, "Missing select else branch");
  expect(cond_ref !== undefined, "Missing select condition");

  const cond = reduce_ref(ctx, cond_ref);
  const cond_node = ctx.nodes.get(cond);
  expect(cond_node, "Missing select condition node");

  if (cond_node.tag === "num") {
    ctx.stats.select_folds += 1;
    expect(cond_node.type === "i32", "Select condition must be i32");
    const value = cond_node.value;
    expect(typeof value === "number", "Expected i32 select condition");

    if (value !== 0) {
      const result = reduce_ref(ctx, then_ref);
      return replace_ref(ctx, ref, result);
    }

    const result = reduce_ref(ctx, else_ref);
    return replace_ref(ctx, ref, result);
  }

  ctx.stats.select_dynamic += 1;
  const then_value = reduce_ref(ctx, then_ref);
  const else_value = reduce_ref(ctx, else_ref);
  const args = [
    to_ic(ctx, then_value, new Set()),
    to_ic(ctx, else_value, new Set()),
    to_ic(ctx, cond, new Set()),
  ];
  const folded = fold_select(current.prim, args);
  const folded_ref = from_ic(ctx, folded, new Map());
  return replace_ref(ctx, ref, folded_ref);
}

function reduce_app(
  ctx: GraphCtx,
  ref: Ref,
  current: Extract<GraphNode, { tag: "app" }>,
): Ref {
  const func = reduce_ref(ctx, current.func);
  const arg = reduce_ref(ctx, current.arg);
  const func_node = ctx.nodes.get(func);
  expect(func_node, "Missing application function");

  if (func_node.tag === "lam") {
    ctx.stats.app_lam += 1;
    const body = subst(ctx, func_node.body, func_node.name, arg);
    const result = reduce_ref(ctx, body);
    return replace_ref(ctx, ref, result);
  }

  if (func_node.tag === "sup") {
    ctx.stats.app_sup += 1;
    const name = fresh_name(ctx, "x");
    const left_arg = alloc(ctx, { tag: "var", name: name + "0" });
    const right_arg = alloc(ctx, { tag: "var", name: name + "1" });
    const left_app = alloc(ctx, {
      tag: "app",
      func: func_node.left,
      arg: left_arg,
    });
    const right_app = alloc(ctx, {
      tag: "app",
      func: func_node.right,
      arg: right_arg,
    });
    const body = alloc(ctx, {
      tag: "sup",
      label: func_node.label,
      left: left_app,
      right: right_app,
    });
    const dup = alloc(ctx, {
      tag: "dup",
      label: func_node.label,
      name,
      expr: arg,
      body,
    });
    const result = reduce_ref(ctx, dup);
    return replace_ref(ctx, ref, result);
  }

  ctx.nodes.set(ref, { tag: "app", func, arg });
  return ref;
}

function reduce_dup(
  ctx: GraphCtx,
  ref: Ref,
  current: Extract<GraphNode, { tag: "dup" }>,
): Ref {
  const expr = reduce_ref(ctx, current.expr);
  const expr_node = ctx.nodes.get(expr);
  expect(expr_node, "Missing duplication expression");

  if (expr_node.tag === "sup") {
    const result = reduce_dup_sup(ctx, current, expr_node);
    const reduced = reduce_ref(ctx, result);
    return replace_ref(ctx, ref, reduced);
  }

  if (expr_node.tag === "lam") {
    ctx.stats.dup_lam += 1;
    const result = reduce_dup_lam(ctx, current, expr_node);
    const reduced = reduce_ref(ctx, result);
    return replace_ref(ctx, ref, reduced);
  }

  if (expr_node.tag === "num" || expr_node.tag === "text") {
    const left = subst(ctx, current.body, current.name + "0", expr);
    const right = subst(ctx, left, current.name + "1", expr);
    const result = reduce_ref(ctx, right);
    return replace_ref(ctx, ref, result);
  }

  const body = reduce_ref(ctx, current.body);
  const left_name = current.name + "0";
  const right_name = current.name + "1";
  const left_uses = name_use_count(ctx, body, left_name, new Set());
  const right_uses = name_use_count(ctx, body, right_name, new Set());

  if (left_uses === 0 && right_uses === 0) {
    const era = alloc(ctx, { tag: "era", expr, body });
    const result = reduce_ref(ctx, era);
    return replace_ref(ctx, ref, result);
  }

  if (left_uses === 0 && right_uses === 1) {
    const result = reduce_ref(ctx, subst(ctx, body, right_name, expr));
    return replace_ref(ctx, ref, result);
  }

  if (left_uses === 1 && right_uses === 0) {
    const result = reduce_ref(ctx, subst(ctx, body, left_name, expr));
    return replace_ref(ctx, ref, result);
  }

  ctx.nodes.set(ref, {
    tag: "dup",
    label: current.label,
    name: current.name,
    expr,
    body,
  });
  return ref;
}

function reduce_era(
  ctx: GraphCtx,
  ref: Ref,
  current: Extract<GraphNode, { tag: "era" }>,
): Ref {
  ctx.stats.erasures += 1;
  const expr = reduce_ref(ctx, current.expr);
  const body = erase(ctx, expr, current.body);
  const result = reduce_ref(ctx, body);
  return replace_ref(ctx, ref, result);
}

function reduce_dup_sup(
  ctx: GraphCtx,
  dup: Extract<GraphNode, { tag: "dup" }>,
  sup: Extract<GraphNode, { tag: "sup" }>,
): Ref {
  if (sup.label === dup.label) {
    ctx.stats.dup_sup_same += 1;
    const left = subst(ctx, dup.body, dup.name + "0", sup.left);
    return subst(ctx, left, dup.name + "1", sup.right);
  }

  ctx.stats.dup_sup_diff += 1;
  const left_name = fresh_name(ctx, "a");
  const right_name = fresh_name(ctx, "b");
  const left_projection = alloc(ctx, {
    tag: "sup",
    label: sup.label,
    left: alloc(ctx, { tag: "var", name: left_name + "0" }),
    right: alloc(ctx, { tag: "var", name: right_name + "0" }),
  });
  const right_projection = alloc(ctx, {
    tag: "sup",
    label: sup.label,
    left: alloc(ctx, { tag: "var", name: left_name + "1" }),
    right: alloc(ctx, { tag: "var", name: right_name + "1" }),
  });
  const left = subst(ctx, dup.body, dup.name + "0", left_projection);
  const right = subst(ctx, left, dup.name + "1", right_projection);
  const right_dup = alloc(ctx, {
    tag: "dup",
    label: dup.label,
    name: right_name,
    expr: sup.right,
    body: right,
  });
  return alloc(ctx, {
    tag: "dup",
    label: dup.label,
    name: left_name,
    expr: sup.left,
    body: right_dup,
  });
}

function reduce_dup_lam(
  ctx: GraphCtx,
  dup: Extract<GraphNode, { tag: "dup" }>,
  lam: Extract<GraphNode, { tag: "lam" }>,
): Ref {
  const body_name = fresh_name(ctx, "b");
  const left_name = fresh_var(ctx, lam.name);
  const right_name = fresh_var(ctx, lam.name);
  const shared_arg = alloc(ctx, {
    tag: "sup",
    label: dup.label,
    left: alloc(ctx, { tag: "var", name: left_name }),
    right: alloc(ctx, { tag: "var", name: right_name }),
  });
  const shared_body = subst(ctx, lam.body, lam.name, shared_arg);
  const left_func = alloc(ctx, {
    tag: "lam",
    name: left_name,
    body: alloc(ctx, { tag: "var", name: body_name + "0" }),
  });
  const right_func = alloc(ctx, {
    tag: "lam",
    name: right_name,
    body: alloc(ctx, { tag: "var", name: body_name + "1" }),
  });
  const left = subst(ctx, dup.body, dup.name + "0", left_func);
  const right = subst(ctx, left, dup.name + "1", right_func);
  return alloc(ctx, {
    tag: "dup",
    label: dup.label,
    name: body_name,
    expr: shared_body,
    body: right,
  });
}

function spread_prim(
  ctx: GraphCtx,
  prim: Prim,
  args: Ref[],
  index: number,
  sup: Extract<GraphNode, { tag: "sup" }>,
): Ref {
  const left_args: Ref[] = [];
  const right_args: Ref[] = [];
  const copy_names: string[] = [];
  const copy_exprs: Ref[] = [];

  for (let pos = 0; pos < args.length; pos += 1) {
    const input = args[pos];
    expect(input !== undefined, "Missing primitive argument " + pos);

    if (pos === index) {
      left_args.push(sup.left);
      right_args.push(sup.right);
    } else {
      const name = fresh_name(ctx, "p");
      copy_names.push(name);
      copy_exprs.push(input);
      left_args.push(alloc(ctx, { tag: "var", name: name + "0" }));
      right_args.push(alloc(ctx, { tag: "var", name: name + "1" }));
    }
  }

  let body = alloc(ctx, {
    tag: "sup",
    label: sup.label,
    left: alloc(ctx, { tag: "prim", prim, args: left_args }),
    right: alloc(ctx, { tag: "prim", prim, args: right_args }),
  });

  for (let copy = copy_names.length - 1; copy >= 0; copy -= 1) {
    const name = copy_names[copy];
    const expr = copy_exprs[copy];
    expect(name, "Missing copied primitive name");
    expect(expr !== undefined, "Missing copied primitive expression");
    body = alloc(ctx, {
      tag: "dup",
      label: sup.label,
      name,
      expr,
      body,
    });
  }

  return body;
}

function erase(ctx: GraphCtx, expr: Ref, body: Ref): Ref {
  const node = ctx.nodes.get(expr);
  expect(node, "Missing erasure expression");

  switch (node.tag) {
    case "num":
    case "text":
    case "var":
      return body;

    case "prim":
      return erase_many(ctx, node.args, body);

    case "lam":
      return alloc(ctx, { tag: "era", expr: node.body, body });

    case "app":
      return erase_many(ctx, [node.func, node.arg], body);

    case "sup":
      return erase_many(ctx, [node.left, node.right], body);

    case "dup": {
      const left = alloc(ctx, { tag: "var", name: node.name + "0" });
      const right = alloc(ctx, { tag: "var", name: node.name + "1" });
      const next = erase_many(ctx, [left, right], node.body);
      return erase_many(ctx, [node.expr, next], body);
    }

    case "era":
      return erase_many(ctx, [node.expr, node.body], body);
  }
}

function erase_many(ctx: GraphCtx, items: Ref[], next: Ref): Ref {
  let result = next;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    expect(item !== undefined, "Missing erasure item " + index);
    result = alloc(ctx, { tag: "era", expr: item, body: result });
  }

  return result;
}

function subst(
  ctx: GraphCtx,
  ref: Ref,
  name: string,
  value: Ref,
): Ref {
  if (!has_name(ctx, ref, name, new Set(), new Map())) {
    return ref;
  }

  return clone_subst(ctx, ref, name, value, new Map());
}

function clone_subst(
  ctx: GraphCtx,
  ref: Ref,
  name: string,
  value: Ref,
  memo: Map<Ref, Ref>,
): Ref {
  if (!has_name(ctx, ref, name, new Set(), new Map())) {
    return ref;
  }

  const cached = memo.get(ref);

  if (cached !== undefined) {
    return cached;
  }

  const node = ctx.nodes.get(ref);
  expect(node, "Missing substitution node");

  switch (node.tag) {
    case "num":
    case "text":
      return ref;

    case "var":
      if (node.name === name) {
        return value;
      }

      return ref;

    case "prim": {
      const result = alloc(ctx, {
        tag: "prim",
        prim: node.prim,
        args: [],
      });
      memo.set(ref, result);
      const args = node.args.map((arg) =>
        clone_subst(ctx, arg, name, value, memo)
      );
      ctx.nodes.set(result, { tag: "prim", prim: node.prim, args });
      return result;
    }

    case "lam":
      if (node.name === name) {
        return ref;
      }

      {
        const result = alloc(ctx, { tag: "lam", name: node.name, body: ref });
        memo.set(ref, result);
        const body = clone_subst(ctx, node.body, name, value, memo);
        ctx.nodes.set(result, { tag: "lam", name: node.name, body });
        return result;
      }

    case "app": {
      const result = alloc(ctx, { tag: "app", func: ref, arg: ref });
      memo.set(ref, result);
      const func = clone_subst(ctx, node.func, name, value, memo);
      const arg = clone_subst(ctx, node.arg, name, value, memo);
      ctx.nodes.set(result, { tag: "app", func, arg });
      return result;
    }

    case "sup": {
      const result = alloc(ctx, {
        tag: "sup",
        label: node.label,
        left: ref,
        right: ref,
      });
      memo.set(ref, result);
      const left = clone_subst(ctx, node.left, name, value, memo);
      const right = clone_subst(ctx, node.right, name, value, memo);
      ctx.nodes.set(result, {
        tag: "sup",
        label: node.label,
        left,
        right,
      });
      return result;
    }

    case "dup": {
      const result = alloc(ctx, {
        tag: "dup",
        label: node.label,
        name: node.name,
        expr: ref,
        body: ref,
      });
      memo.set(ref, result);
      const expr = clone_subst(ctx, node.expr, name, value, memo);

      if (name === node.name + "0" || name === node.name + "1") {
        ctx.nodes.set(result, {
          tag: "dup",
          label: node.label,
          name: node.name,
          expr,
          body: node.body,
        });
        return result;
      }

      const body = clone_subst(ctx, node.body, name, value, memo);
      ctx.nodes.set(result, {
        tag: "dup",
        label: node.label,
        name: node.name,
        expr,
        body,
      });
      return result;
    }

    case "era": {
      const result = alloc(ctx, { tag: "era", expr: ref, body: ref });
      memo.set(ref, result);
      const expr = clone_subst(ctx, node.expr, name, value, memo);
      const body = clone_subst(ctx, node.body, name, value, memo);
      ctx.nodes.set(result, { tag: "era", expr, body });
      return result;
    }
  }
}

function has_name(
  ctx: GraphCtx,
  ref: Ref,
  name: string,
  visiting: Set<Ref>,
  memo: Map<Ref, boolean>,
): boolean {
  const cached = memo.get(ref);

  if (cached !== undefined) {
    return cached;
  }

  if (visiting.has(ref)) {
    return false;
  }

  visiting.add(ref);
  const node = ctx.nodes.get(ref);
  expect(node, "Missing name search node");
  let result = false;

  switch (node.tag) {
    case "num":
    case "text":
      result = false;
      break;

    case "var":
      result = node.name === name;
      break;

    case "prim":
      for (const arg of node.args) {
        if (has_name(ctx, arg, name, visiting, memo)) {
          result = true;
          break;
        }
      }

      break;

    case "lam":
      if (node.name !== name) {
        result = has_name(ctx, node.body, name, visiting, memo);
      }

      break;

    case "app":
      result = has_name(ctx, node.func, name, visiting, memo) ||
        has_name(ctx, node.arg, name, visiting, memo);
      break;

    case "sup":
      result = has_name(ctx, node.left, name, visiting, memo) ||
        has_name(ctx, node.right, name, visiting, memo);
      break;

    case "dup":
      result = has_name(ctx, node.expr, name, visiting, memo);

      if (!result && name !== node.name + "0" && name !== node.name + "1") {
        result = has_name(ctx, node.body, name, visiting, memo);
      }

      break;

    case "era":
      result = has_name(ctx, node.expr, name, visiting, memo) ||
        has_name(ctx, node.body, name, visiting, memo);
      break;
  }

  visiting.delete(ref);
  memo.set(ref, result);
  return result;
}

function name_use_count(
  ctx: GraphCtx,
  ref: Ref,
  name: string,
  visiting: Set<Ref>,
): number {
  if (visiting.has(ref)) {
    return 0;
  }

  visiting.add(ref);
  const node = ctx.nodes.get(ref);
  expect(node, "Missing name count node");
  let count = 0;

  switch (node.tag) {
    case "num":
    case "text":
      count = 0;
      break;

    case "var":
      if (node.name === name) {
        count = 1;
      }

      break;

    case "prim":
      for (const arg of node.args) {
        count += name_use_count(ctx, arg, name, visiting);
      }

      break;

    case "lam":
      if (node.name !== name) {
        count = name_use_count(ctx, node.body, name, visiting);
      }

      break;

    case "app":
      count = name_use_count(ctx, node.func, name, visiting) +
        name_use_count(ctx, node.arg, name, visiting);
      break;

    case "sup":
      count = name_use_count(ctx, node.left, name, visiting) +
        name_use_count(ctx, node.right, name, visiting);
      break;

    case "dup":
      count = name_use_count(ctx, node.expr, name, visiting);

      if (name !== node.name + "0" && name !== node.name + "1") {
        count += name_use_count(ctx, node.body, name, visiting);
      }

      break;

    case "era":
      count = name_use_count(ctx, node.expr, name, visiting) +
        name_use_count(ctx, node.body, name, visiting);
      break;
  }

  visiting.delete(ref);
  return count;
}

function contains_ref(
  ctx: GraphCtx,
  ref: Ref,
  target: Ref,
  visiting: Set<Ref>,
): boolean {
  if (ref === target) {
    return true;
  }

  if (visiting.has(ref)) {
    return false;
  }

  visiting.add(ref);
  const node = ctx.nodes.get(ref);
  expect(node, "Missing graph reference search node");
  let result = false;

  switch (node.tag) {
    case "num":
    case "text":
    case "var":
      result = false;
      break;

    case "prim":
      for (const arg of node.args) {
        if (contains_ref(ctx, arg, target, visiting)) {
          result = true;
          break;
        }
      }

      break;

    case "lam":
      result = contains_ref(ctx, node.body, target, visiting);
      break;

    case "app":
      result = contains_ref(ctx, node.func, target, visiting) ||
        contains_ref(ctx, node.arg, target, visiting);
      break;

    case "sup":
      result = contains_ref(ctx, node.left, target, visiting) ||
        contains_ref(ctx, node.right, target, visiting);
      break;

    case "dup":
      result = contains_ref(ctx, node.expr, target, visiting) ||
        contains_ref(ctx, node.body, target, visiting);
      break;

    case "era":
      result = contains_ref(ctx, node.expr, target, visiting) ||
        contains_ref(ctx, node.body, target, visiting);
      break;
  }

  visiting.delete(ref);
  return result;
}

function replace_ref(ctx: GraphCtx, target: Ref, source: Ref): Ref {
  if (target === source) {
    return target;
  }

  const source_node = ctx.nodes.get(source);
  expect(source_node, "Missing replacement source");
  ctx.nodes.set(target, clone_node(source_node));
  return target;
}

function clone_node(node: GraphNode): GraphNode {
  switch (node.tag) {
    case "num":
      return { tag: "num", type: node.type, value: node.value };

    case "text":
      return { tag: "text", value: node.value };

    case "var":
      return { tag: "var", name: node.name };

    case "prim":
      return { tag: "prim", prim: node.prim, args: [...node.args] };

    case "lam":
      return { tag: "lam", name: node.name, body: node.body };

    case "app":
      return { tag: "app", func: node.func, arg: node.arg };

    case "sup":
      return {
        tag: "sup",
        label: node.label,
        left: node.left,
        right: node.right,
      };

    case "dup":
      return {
        tag: "dup",
        label: node.label,
        name: node.name,
        expr: node.expr,
        body: node.body,
      };

    case "era":
      return { tag: "era", expr: node.expr, body: node.body };
  }
}

function node_to_num(node: Extract<GraphNode, { tag: "num" }>): IcNum {
  return { tag: "num", type: node.type, value: node.value };
}

function to_ic(ctx: GraphCtx, ref: Ref, visiting: Set<Ref>): Ic {
  if (visiting.has(ref)) {
    throw new Error("Cannot materialize cyclic Ic graph after reduction");
  }

  visiting.add(ref);
  const node = ctx.nodes.get(ref);
  expect(node, "Missing Ic graph node during materialization");
  let result: Ic;

  switch (node.tag) {
    case "num":
      result = { tag: "num", type: node.type, value: node.value };
      break;

    case "text":
      result = { tag: "text", value: node.value };
      break;

    case "var":
      result = { tag: "var", name: node.name };
      break;

    case "prim":
      result = {
        tag: "prim",
        prim: node.prim,
        args: node.args.map((arg) => to_ic(ctx, arg, visiting)),
      };
      break;

    case "lam":
      result = {
        tag: "lam",
        name: node.name,
        body: to_ic(ctx, node.body, visiting),
      };
      break;

    case "app":
      result = {
        tag: "app",
        func: to_ic(ctx, node.func, visiting),
        arg: to_ic(ctx, node.arg, visiting),
      };
      break;

    case "sup":
      result = {
        tag: "sup",
        label: node.label,
        left: to_ic(ctx, node.left, visiting),
        right: to_ic(ctx, node.right, visiting),
      };
      break;

    case "dup":
      result = {
        tag: "dup",
        label: node.label,
        name: node.name,
        expr: to_ic(ctx, node.expr, visiting),
        body: to_ic(ctx, node.body, visiting),
      };
      break;

    case "era":
      result = {
        tag: "era",
        expr: to_ic(ctx, node.expr, visiting),
        body: to_ic(ctx, node.body, visiting),
      };
      break;
  }

  visiting.delete(ref);
  return result;
}

function dump_graph(ctx: GraphCtx, root: Ref): string {
  const refs: Ref[] = [];
  const seen = new Set<Ref>();
  const pending = [root];

  while (pending.length > 0) {
    const ref = pending.shift();
    expect(ref !== undefined, "Missing pending graph ref");

    if (seen.has(ref)) {
      continue;
    }

    seen.add(ref);
    refs.push(ref);
    const node = ctx.nodes.get(ref);
    expect(node, "Missing graph dump node");

    for (const child of child_refs(node)) {
      pending.push(child);
    }
  }

  refs.sort((left, right) => left - right);
  return refs.map((ref) => {
    const node = ctx.nodes.get(ref);
    expect(node, "Missing graph dump node");
    return "#" + ref.toString() + " = " + dump_node(node);
  }).join("\n");
}

function child_refs(node: GraphNode): Ref[] {
  switch (node.tag) {
    case "num":
    case "text":
    case "var":
      return [];

    case "prim":
      return [...node.args];

    case "lam":
      return [node.body];

    case "app":
      return [node.func, node.arg];

    case "sup":
      return [node.left, node.right];

    case "dup":
      return [node.expr, node.body];

    case "era":
      return [node.expr, node.body];
  }
}

function dump_node(node: GraphNode): string {
  switch (node.tag) {
    case "num":
      return node.value.toString() + ":" + node.type;

    case "text":
      return Deno.inspect(node.value);

    case "var":
      return node.name;

    case "prim":
      return node.prim + "(" + node.args.map(dump_ref).join(", ") + ")";

    case "lam":
      return "λ" + node.name + ". " + dump_ref(node.body);

    case "app":
      return "app(" + dump_ref(node.func) + ", " + dump_ref(node.arg) + ")";

    case "sup":
      return "&" + node.label + "{" + dump_ref(node.left) + ", " +
        dump_ref(node.right) + "}";

    case "dup":
      return "! " + node.name + " &" + node.label + " = " +
        dump_ref(node.expr) + "; " + dump_ref(node.body);

    case "era":
      return "~ " + dump_ref(node.expr) + "; " + dump_ref(node.body);
  }
}

function dump_ref(ref: Ref): string {
  return "#" + ref.toString();
}

function fresh_name(ctx: GraphCtx, prefix: string): string {
  while (true) {
    const name = "_" + prefix + ctx.next_name.toString();
    ctx.next_name += 1;

    if (
      !ctx.used.has(name) &&
      !ctx.used.has(name + "0") &&
      !ctx.used.has(name + "1")
    ) {
      ctx.used.add(name);
      ctx.used.add(name + "0");
      ctx.used.add(name + "1");
      return name;
    }
  }
}

function fresh_var(ctx: GraphCtx, prefix: string): string {
  while (true) {
    const name = "_" + prefix + ctx.next_name.toString();
    ctx.next_name += 1;

    if (!ctx.used.has(name)) {
      ctx.used.add(name);
      return name;
    }
  }
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
      out.add(ic.name + "0");
      out.add(ic.name + "1");
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
