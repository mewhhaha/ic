import type { ValType } from "../../op.ts";

export type CoreOwnership =
  | {
    tag: "scalar_local";
    type: ValType;
  }
  | {
    tag: "unique_heap";
    reason: CoreOwnershipPointerReason;
  }
  | {
    tag: "frozen_shareable";
    reason: CoreOwnershipPointerReason | "freeze";
  }
  | {
    tag: "borrow_view";
    source: CoreOwnership;
  }
  | {
    tag: "scratch_backed";
    source: CoreOwnership;
  };

export type CoreOwnershipPointerReason =
  | "bytes"
  | "text"
  | "closure"
  | "runtime_union"
  | "runtime_aggregate";
