import type { CoreOwnership } from "./ownership.ts";
import type { CoreStorageClass } from "./storage.ts";

export type CoreExpressionTag =
  | "num"
  | "text"
  | "type_name"
  | "var"
  | "linear"
  | "prim"
  | "lam"
  | "rec"
  | "rec_ref"
  | "app"
  | "block"
  | "loop"
  | "comptime"
  | "borrow"
  | "freeze"
  | "scratch"
  | "with"
  | "struct_type"
  | "struct_value"
  | "struct_update"
  | "union_type"
  | "if"
  | "if_let"
  | "field"
  | "index"
  | "union_case"
  | "unsupported";

export type CoreAllocationReason =
  | "closure"
  | "runtime_bytes"
  | "runtime_aggregate"
  | "runtime_text"
  | "runtime_union";

export type CoreAllocationFact = {
  id: string;
  allocation_id: string;
  scope: string;
  storage: CoreStorageClass;
  ownership: CoreOwnership;
  reason: CoreAllocationReason;
  expression: CoreExpressionTag;
  byte_size: CoreAllocationByteSize;
  alignment: 4 | 8 | 16;
  layout: CoreAllocationLayout;
  owned_children?: CoreAllocationOwnedChild[];
  owner?: string;
};

export type CoreAllocationOwnedChild = {
  allocation_ids: string[];
  offset: number;
  ownership: Extract<CoreOwnership, { tag: "unique_heap" }>;
  layout: CoreAllocationLayout;
  owned_children?: CoreAllocationOwnedChild[];
};

export type CoreAllocationByteSize =
  | { tag: "static"; value: number }
  | { tag: "runtime"; formula: string };

export type CoreAllocationLayout =
  | "closure_env.table_index_and_capture_slots"
  | "runtime_aggregate.aligned_fields"
  | "runtime_bytes.length_prefixed_u8"
  | "runtime_text.length_prefixed_utf8"
  | "runtime_union.tag_and_aligned_payload"
  | "runtime_slice.length_and_i32_elements"
  | "runtime_slice.length_and_frozen_text_pointers";

export type CoreAllocationPlan = {
  facts: CoreAllocationFact[];
};
