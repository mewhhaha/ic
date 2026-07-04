import type { Expr as ExprNode } from "./expr.ts";
import { Emit, Format, Reduce } from "./trait.ts";
import type { Ic as IcNode } from "./ic/ast.ts";
import { fmt_ic } from "./ic/format.ts";
import { reduce_ic_graph } from "./ic/graph_reduce.ts";
import { lower_ic } from "./ic/lower.ts";

export type Ic = IcNode;

export function Ic() {}

Ic.fmt = fmt_ic;

Ic.reduce = function reduce(
  ctx_or_ic: undefined | IcNode,
  maybe_ic?: IcNode,
): IcNode {
  if (maybe_ic !== undefined) {
    return reduce_ic_graph(maybe_ic);
  }

  if (ctx_or_ic === undefined) {
    throw new Error("Missing Ic value to reduce");
  }

  return reduce_ic_graph(ctx_or_ic);
};

Ic.emit = function emit(ic: IcNode): ExprNode {
  return lower_ic(reduce_ic_graph(ic));
};

Ic satisfies
  & Format<IcNode>
  & Emit<IcNode, ExprNode>
  & Reduce<undefined, IcNode, IcNode>;
