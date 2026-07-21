import prelude_text from "./prelude.duck" with { type: "text" };
import prelude_abstractions_text from "./prelude_abstractions.duck" with {
  type: "text",
};
import prelude_attributes_text from "./prelude_attributes.duck" with {
  type: "text",
};
import prelude_collections_text from "./prelude_collections.duck" with {
  type: "text",
};
import prelude_csv_text from "./prelude_csv.duck" with { type: "text" };
import prelude_effects_text from "./prelude_effects.duck" with {
  type: "text",
};
import prelude_effect_defaults_text from "./prelude_effect_defaults.duck" with {
  type: "text",
};
import prelude_functional_text from "./prelude_functional.duck" with {
  type: "text",
};
import prelude_json_text from "./prelude_json.duck" with { type: "text" };
import prelude_json_encode_text from "./prelude_json_encode.duck" with {
  type: "text",
};
import prelude_json_values_text from "./prelude_json_values.duck" with {
  type: "text",
};
import prelude_list_text from "./prelude_list.duck" with { type: "text" };
import prelude_numeric_text from "./prelude_numeric.duck" with {
  type: "text",
};
import prelude_path_text from "./prelude_path.duck" with { type: "text" };
import prelude_runtime_text from "./prelude_runtime.duck" with {
  type: "text",
};
import prelude_text_text from "./prelude_text.duck" with { type: "text" };
import prelude_testing_text from "./prelude_testing.duck" with { type: "text" };
import prelude_time_text from "./prelude_time.duck" with { type: "text" };
import prelude_types_text from "./prelude_types.duck" with { type: "text" };

export const ducklang_prelude_text = prelude_text;
export const ducklang_abstractions_prelude_text = prelude_abstractions_text;
export const ducklang_attributes_prelude_text = prelude_attributes_text;
export const ducklang_collections_prelude_text = prelude_collections_text;
export const ducklang_csv_prelude_text = prelude_csv_text;
export const ducklang_effects_prelude_text = prelude_effects_text;
export const ducklang_effect_defaults_prelude_text =
  prelude_effect_defaults_text;
export const ducklang_functional_prelude_text = prelude_functional_text;
export const ducklang_json_prelude_text = prelude_json_text;
export const ducklang_json_encode_prelude_text = prelude_json_encode_text;
export const ducklang_json_values_prelude_text = prelude_json_values_text;
export const ducklang_list_prelude_text = prelude_list_text;
export const ducklang_numeric_prelude_text = prelude_numeric_text;
export const ducklang_path_prelude_text = prelude_path_text;
export const ducklang_runtime_prelude_text = prelude_runtime_text;
export const ducklang_text_prelude_text = prelude_text_text;
export const ducklang_testing_prelude_text = prelude_testing_text;
export const ducklang_time_prelude_text = prelude_time_text;
export const ducklang_types_prelude_text = prelude_types_text;

export function bundled_source_text(uri: string): string | undefined {
  if (uri === "duck:prelude") {
    return ducklang_prelude_text;
  }

  if (uri === "duck:prelude/abstractions") {
    return ducklang_abstractions_prelude_text;
  }

  if (uri === "duck:prelude/attributes") {
    return ducklang_attributes_prelude_text;
  }

  if (uri === "duck:prelude/collections") {
    return ducklang_collections_prelude_text;
  }

  if (uri === "duck:prelude/csv") {
    return ducklang_csv_prelude_text;
  }

  if (uri === "duck:prelude/effects") {
    return ducklang_effects_prelude_text;
  }

  if (uri === "duck:prelude/effects/defaults") {
    return ducklang_effect_defaults_prelude_text;
  }

  if (uri === "duck:prelude/functional") {
    return ducklang_functional_prelude_text;
  }

  if (uri === "duck:prelude/json") {
    return ducklang_json_prelude_text;
  }

  if (uri === "duck:prelude/json/encode") {
    return ducklang_json_encode_prelude_text;
  }

  if (uri === "duck:prelude/json/values") {
    return ducklang_json_values_prelude_text;
  }

  if (uri === "duck:prelude/list") {
    return ducklang_list_prelude_text;
  }

  if (uri === "duck:prelude/numeric") {
    return ducklang_numeric_prelude_text;
  }

  if (uri === "duck:prelude/path") {
    return ducklang_path_prelude_text;
  }

  if (uri === "duck:prelude/runtime") {
    return ducklang_runtime_prelude_text;
  }

  if (uri === "duck:prelude/text") {
    return ducklang_text_prelude_text;
  }

  if (uri === "duck:prelude/testing") {
    return ducklang_testing_prelude_text;
  }

  if (uri === "duck:prelude/time") {
    return ducklang_time_prelude_text;
  }

  if (uri === "duck:prelude/types") {
    return ducklang_types_prelude_text;
  }

  return undefined;
}
