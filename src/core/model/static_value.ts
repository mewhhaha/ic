import type { CoreExpr } from "../ast.ts";

export type StaticStructIfBranches = {
  then_struct: Extract<CoreExpr, { tag: "struct_value" }>;
  else_struct: Extract<CoreExpr, { tag: "struct_value" }>;
};

export type StaticTextIfBranches = {
  then_text: CoreExpr;
  else_text: CoreExpr;
};
