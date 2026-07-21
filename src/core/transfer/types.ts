import type { CoreExpr } from "../ast.ts";
import type { CoreOwnership, CoreOwnershipHooks } from "../ownership.ts";

export type CoreTransferEdge = {
  id: string;
  scope: string;
  owner: string;
  callee: string;
  argument: number;
};

export type CoreTransferValidationIssue =
  | {
    tag: "use_after_transfer";
    owner: string;
    transfer: CoreTransferEdge;
    use: string;
    message: string;
  }
  | {
    tag: "invalid_static_transfer_argument";
    owner: string;
    callee: string;
    argument: number;
    ownership: CoreOwnership | undefined;
    reason: string;
    message: string;
  }
  | {
    tag: "conditional_transfer_requires_cleanup";
    owner: string;
    transfer: CoreTransferEdge;
    message: string;
  }
  | {
    tag: "invalid_union_payload_ownership";
    owner: string | undefined;
    callee: string;
    ownership: CoreOwnership;
    message: string;
  };

export type CoreTransferValidation = {
  transfers: CoreTransferEdge[];
  issues: CoreTransferValidationIssue[];
};

export type CoreTransferHooks<ctx> = CoreOwnershipHooks<ctx> & {
  bind_annotation_fact?: (
    name: string,
    annotation: string,
    ctx: ctx,
  ) => void;
  closure_body_ctx?: (
    expr: Extract<CoreExpr, { tag: "lam" | "rec" }>,
    ctx: ctx,
  ) => ctx | undefined;
};

export type CoreTransferFunction =
  | { tag: "lam"; value: Extract<CoreExpr, { tag: "lam" }> }
  | { tag: "rec"; value: Extract<CoreExpr, { tag: "rec" }> }
  | {
    tag: "branch";
    kind: "if" | "if_let";
    then_target: CoreTransferFunction;
    else_target: CoreTransferFunction;
  };

export type CoreTransferState<ctx> = {
  collect_local_facts: boolean;
  next_transfer: number;
  next_temporary: number;
  transfers: CoreTransferEdge[];
  issues: CoreTransferValidationIssue[];
  transferred: Map<string, CoreTransferEdge>;
  functions: Map<string, CoreTransferFunction>;
  aliases: Map<string, string>;
  declared_owners: Set<string>;
  alias_subjects: Map<string, CoreExpr>;
  alias_ownership: Map<string, CoreOwnership | undefined>;
  alias_rejection_reasons: Map<string, string>;
  active_functions: Set<string>;
  ctx: ctx;
  hooks: CoreTransferHooks<ctx>;
};
