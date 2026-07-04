export const structured_core_route =
  "; use Source.core, Source.mod, or Source.wat for structured Core/Wasm lowering";

export const unresolved_import_route =
  "use Source.load, Source.compile_file, Source.core_file, Source.mod_file, or Source.wat_file";

export const dynamic_if_let_ic_route =
  "Cannot lower dynamic if let without typed union target to Ic frontend; use Source.core, Source.mod, or Source.wat for structured Core/Wasm lowering";
