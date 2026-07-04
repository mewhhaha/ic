import { expect } from "../expect.ts";
import type { Ic as IcNode } from "../ic.ts";

type FreeNameCount = {
  name: string;
  count: number;
};

type SharePlan = {
  leaves: string[];
  wrap: (body: IcNode) => IcNode;
};

export function lower_bound_value(
  value: IcNode,
  body: IcNode,
  name: string,
): IcNode {
  const uses = ic_name_use_count(body, name);

  if (uses === 0) {
    return {
      tag: "era",
      expr: value,
      body,
    };
  }

  if (uses > 1) {
    return share_ic_value(value, body, name, uses);
  }

  return {
    tag: "app",
    func: { tag: "lam", name, body },
    arg: value,
  };
}

export function lower_lambda_binding(name: string, body: IcNode): IcNode {
  const uses = ic_name_use_count(body, name);

  if (uses === 0) {
    return {
      tag: "lam",
      name,
      body: {
        tag: "era",
        expr: { tag: "var", name },
        body,
      },
    };
  }

  if (uses > 1) {
    return {
      tag: "lam",
      name,
      body: share_ic_value({ tag: "var", name }, body, name, uses),
    };
  }

  return { tag: "lam", name, body };
}

export function share_free_variables(ic: IcNode): IcNode {
  let result = ic;
  const counts = free_name_counts(ic);

  for (const item of counts) {
    if (item.count > 1) {
      result = share_ic_value(
        { tag: "var", name: item.name },
        result,
        item.name,
        item.count,
      );
    }
  }

  return result;
}

function share_ic_value(
  value: IcNode,
  body: IcNode,
  name: string,
  uses: number,
): IcNode {
  expect(uses > 1, "Shared Ic value must have multiple uses");
  const plan = create_share_plan(value, name, uses);
  const shared_body = replace_ic_name_with_leaves(body, name, plan.leaves);
  return plan.wrap(shared_body);
}

function free_name_counts(ic: IcNode): FreeNameCount[] {
  const counts = new Map<string, number>();
  collect_free_name_counts(ic, new Set(), counts);
  const result: FreeNameCount[] = [];

  for (const [name, count] of counts) {
    result.push({ name, count });
  }

  return result;
}

function collect_free_name_counts(
  ic: IcNode,
  bound: Set<string>,
  counts: Map<string, number>,
): void {
  switch (ic.tag) {
    case "num":
    case "text":
      return;

    case "var":
      if (bound.has(ic.name)) {
        return;
      }

      counts.set(ic.name, (counts.get(ic.name) || 0) + 1);
      return;

    case "prim":
      for (const arg of ic.args) {
        collect_free_name_counts(arg, bound, counts);
      }

      return;

    case "lam": {
      const body_bound = new Set(bound);
      body_bound.add(ic.name);
      collect_free_name_counts(ic.body, body_bound, counts);
      return;
    }

    case "app":
      collect_free_name_counts(ic.func, bound, counts);
      collect_free_name_counts(ic.arg, bound, counts);
      return;

    case "sup":
      collect_free_name_counts(ic.left, bound, counts);
      collect_free_name_counts(ic.right, bound, counts);
      return;

    case "dup": {
      collect_free_name_counts(ic.expr, bound, counts);
      const body_bound = new Set(bound);
      body_bound.add(ic.name + "0");
      body_bound.add(ic.name + "1");
      collect_free_name_counts(ic.body, body_bound, counts);
      return;
    }

    case "era":
      collect_free_name_counts(ic.expr, bound, counts);
      collect_free_name_counts(ic.body, bound, counts);
      return;

    case "fix": {
      const body_bound = new Set(bound);
      body_bound.add(ic.name);
      collect_free_name_counts(ic.expr, body_bound, counts);
      collect_free_name_counts(ic.body, body_bound, counts);
      return;
    }
  }
}

function create_share_plan(
  value: IcNode,
  name: string,
  uses: number,
): SharePlan {
  let next = 0;

  function create(expr: IcNode, remaining_uses: number): SharePlan {
    if (remaining_uses === 1) {
      expect(expr.tag === "var", "Expected Ic share leaf variable");
      return {
        leaves: [expr.name],
        wrap(body: IcNode): IcNode {
          return body;
        },
      };
    }

    const share_index = next;
    next += 1;
    const share_name = name + "_share" + share_index.toString();
    const left_name = share_name + "0";
    const right_name = share_name + "1";
    const right_plan = create(
      { tag: "var", name: right_name },
      remaining_uses - 1,
    );
    const leaves = [left_name, ...right_plan.leaves];

    return {
      leaves,
      wrap(body: IcNode): IcNode {
        return {
          tag: "dup",
          label: share_label(name, share_index),
          name: share_name,
          expr,
          body: right_plan.wrap(body),
        };
      },
    };
  }

  return create(value, uses);
}

function share_label(name: string, index: number): string {
  return "share_" + name.replace(/[^A-Za-z0-9_]/g, "_") + "_" +
    index.toString();
}

function replace_ic_name_with_leaves(
  ic: IcNode,
  name: string,
  leaves: string[],
): IcNode {
  let index = 0;

  function next_leaf(): IcNode {
    const leaf = leaves[index];
    expect(leaf, "Missing shared Ic leaf " + index.toString());
    index += 1;
    return { tag: "var", name: leaf };
  }

  function visit(node: IcNode): IcNode {
    switch (node.tag) {
      case "num":
      case "text":
        return node;

      case "var":
        if (node.name === name) {
          return next_leaf();
        }

        return node;

      case "prim":
        return {
          tag: "prim",
          prim: node.prim,
          args: node.args.map((arg) => visit(arg)),
        };

      case "lam":
        if (node.name === name) {
          return node;
        }

        return { tag: "lam", name: node.name, body: visit(node.body) };

      case "app":
        return {
          tag: "app",
          func: visit(node.func),
          arg: visit(node.arg),
        };

      case "sup":
        return {
          tag: "sup",
          label: node.label,
          left: visit(node.left),
          right: visit(node.right),
        };

      case "dup": {
        const expr = visit(node.expr);

        if (name === node.name + "0" || name === node.name + "1") {
          return {
            tag: "dup",
            label: node.label,
            name: node.name,
            expr,
            body: node.body,
          };
        }

        return {
          tag: "dup",
          label: node.label,
          name: node.name,
          expr,
          body: visit(node.body),
        };
      }

      case "era":
        return {
          tag: "era",
          expr: visit(node.expr),
          body: visit(node.body),
        };

      case "fix":
        if (node.name === name) {
          return node;
        }

        return {
          tag: "fix",
          name: node.name,
          expr: visit(node.expr),
          body: visit(node.body),
        };
    }
  }

  const result = visit(ic);
  expect(
    index === leaves.length,
    "Shared Ic use count changed for " + name,
  );
  return result;
}

function ic_name_use_count(ic: IcNode, name: string): number {
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

      if (name === ic.name + "0" || name === ic.name + "1") {
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
