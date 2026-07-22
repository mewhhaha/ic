export {
  runtime_aggregate_field_base_offset,
  runtime_aggregate_layout,
  runtime_aggregate_layout_for_type,
  type RuntimeAggregateField,
  type RuntimeAggregateLayout,
  same_runtime_aggregate_type_expr,
} from "./runtime_aggregate/layout.ts";

export {
  runtime_aggregate_field_access,
  runtime_aggregate_field_info,
  runtime_aggregate_index_field,
  runtime_aggregate_type_expr,
  runtime_struct_update_value,
  type RuntimeAggregateFieldAccess,
  type RuntimeAggregateTypeCtx,
  type RuntimeAggregateTypeHooks,
} from "./runtime_aggregate/type_expr.ts";

export {
  type RuntimeAggregateEmitCtx,
  type RuntimeAggregateFreezeCopyHooks,
  type RuntimeAggregateFreezeCopyLocalHooks,
  type RuntimeAggregateFreezeCopySupportHooks,
  type RuntimeAggregateHooks,
  type RuntimeAggregatePlan,
  type RuntimeAggregateTempCtx,
} from "./runtime_aggregate/types.ts";

export {
  declare_runtime_aggregate_locals,
  runtime_aggregate_plan,
} from "./runtime_aggregate/plan.ts";

export {
  emit_runtime_aggregate_field_load,
  emit_runtime_aggregate_field_move,
  emit_runtime_aggregate_field_pointer,
  emit_runtime_aggregate_value,
  runtime_aggregate_move_pointer_local,
} from "./runtime_aggregate/emit.ts";

export {
  declare_runtime_aggregate_freeze_copy_locals,
  emit_runtime_aggregate_freeze_copy,
  runtime_aggregate_freeze_copy_supported,
} from "./runtime_aggregate/freeze_copy.ts";
