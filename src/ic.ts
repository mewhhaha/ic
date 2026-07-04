import type { Expr as ExprNode } from "./expr.ts";
import { Emit, Format, Reduce } from "./trait.ts";
import type { Ic as IcNode } from "./ic/ast.ts";
import { fmt_ic } from "./ic/format.ts";
import {
  dump_ic_graph,
  reduce_ic_graph,
  reduce_ic_graph_debug,
} from "./ic/graph_reduce.ts";
import { lower_ic } from "./ic/lower.ts";
import { ic_open_mod, ic_open_wat } from "./ic/open_term.ts";
import { assert_valid_ic, validate_ic } from "./ic/validate.ts";

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

Ic.validate = validate_ic;

Ic.assert_valid = assert_valid_ic;

Ic.reduce_debug = function reduce_debug(ic: IcNode) {
  assert_valid_ic(ic);
  return reduce_ic_graph_debug(ic);
};

Ic.dump_graph = dump_ic_graph;

Ic.mod = ic_open_mod;

Ic.wat = ic_open_wat;

Ic satisfies
  & Format<IcNode>
  & Emit<IcNode, ExprNode>
  & Reduce<undefined, IcNode, IcNode>;
