export type CoreStorageClass =
  | "scalar_local"
  | "static_data"
  | "persistent_unique_heap"
  | "frozen_heap"
  | "borrow_view"
  | "scratch_arena"
  | "rejected";
