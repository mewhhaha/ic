import prelude_text from "./prelude.duck" with { type: "text" };
import prelude_effects_text from "./prelude_effects.duck" with {
  type: "text",
};
import prelude_functional_text from "./prelude_functional.duck" with {
  type: "text",
};
import prelude_runtime_text from "./prelude_runtime.duck" with {
  type: "text",
};

export const ducklang_prelude_text = prelude_text;
export const ducklang_effects_prelude_text = prelude_effects_text;
export const ducklang_functional_prelude_text = prelude_functional_text;
export const ducklang_runtime_prelude_text = prelude_runtime_text;

export function bundled_source_text(uri: string): string | undefined {
  if (uri === "duck:prelude") {
    return ducklang_prelude_text;
  }

  if (uri === "duck:prelude/effects") {
    return ducklang_effects_prelude_text;
  }

  if (uri === "duck:prelude/functional") {
    return ducklang_functional_prelude_text;
  }

  if (uri === "duck:prelude/runtime") {
    return ducklang_runtime_prelude_text;
  }

  return undefined;
}
