import type { Source } from "./ast.ts";
import { expand_source_attributes } from "./attribute.ts";
import {
  source_with_import_meta,
  type SourceImportMeta,
} from "./import_meta.ts";
import { resolve_bundled_source_imports } from "./load.ts";
import { specialize_const_module_imports } from "./module_specialize.ts";
import {
  apply_front_function_signatures,
  infer_front_function_signatures,
} from "./signature_inference.ts";
import { derive_missing_source_spans } from "./syntax.ts";

export function source_with_expanded_attributes(
  source: Source,
  import_meta: SourceImportMeta = {},
): Source {
  source = source_with_import_meta(source, import_meta);
  const imported_source = resolve_bundled_source_imports(source);
  const inferred_source = infer_front_function_signatures(imported_source);
  const contextual_source = apply_front_function_signatures(
    source,
    inferred_source,
  );

  if (contextual_source === source) {
    source = inferred_source;
  } else {
    source = resolve_bundled_source_imports(contextual_source);
    source = infer_front_function_signatures(source);
  }

  source = specialize_const_module_imports(source);
  derive_missing_source_spans(source, { start: 0, end: 0 });
  return expand_source_attributes(source);
}
