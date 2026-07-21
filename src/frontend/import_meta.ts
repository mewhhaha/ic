import { expect } from "../expect.ts";
import type { FrontExpr, ProductExprEntry, Source, Stmt } from "./ast.ts";
import { expect_snake_case } from "./names.ts";

export const import_meta_binding_name = "@no_demand_import_meta";

export type SourceImportMetaAtom = { atom: string };
export type SourceImportMetaLiteral =
  | boolean
  | number
  | bigint
  | string
  | SourceImportMetaAtom;
export type SourceImportMeta = Readonly<
  Record<string, SourceImportMetaLiteral>
>;

export const default_source_import_meta: SourceImportMeta = {
  mode: { atom: "build" },
  profile: { atom: "debug" },
  target: { atom: "wasm32" },
};

export function source_with_import_meta(
  source: Source,
  supplied: SourceImportMeta = {},
): Source {
  if (
    source.statements.some((statement) =>
      statement.tag === "bind" && statement.name === import_meta_binding_name
    )
  ) {
    return source;
  }

  const values: Record<string, SourceImportMetaLiteral> = {
    ...default_source_import_meta,
    ...supplied,
  };
  const entries: ProductExprEntry[] = [];

  for (const name of Object.keys(values).sort()) {
    expect_snake_case(name, "import.meta field");
    const value = values[name];
    expect(value !== undefined, "Missing import.meta value for " + name);
    entries.push({ label: name, value: import_meta_literal(value, name) });
  }

  const binding: Extract<Stmt, { tag: "bind" }> = {
    tag: "bind",
    kind: "const",
    name: import_meta_binding_name,
    is_linear: false,
    annotation: undefined,
    value: {
      tag: "shape",
      entries,
    },
  };

  return { ...source, statements: [binding, ...source.statements] };
}

function import_meta_literal(
  value: SourceImportMetaLiteral,
  name: string,
): FrontExpr {
  if (typeof value === "boolean") {
    return { tag: "bool", value };
  }

  if (typeof value === "number") {
    expect(
      Number.isSafeInteger(value) && value >= -2147483648 &&
        value <= 2147483647,
      "import.meta number " + name + " must fit I32",
    );
    return { tag: "num", type: "i32", value };
  }

  if (typeof value === "bigint") {
    expect(
      value >= -9223372036854775808n && value <= 9223372036854775807n,
      "import.meta bigint " + name + " must fit I64",
    );
    return { tag: "num", type: "i64", value };
  }

  if (typeof value === "string") {
    return { tag: "text", value };
  }

  expect_snake_case(value.atom, "import.meta atom");
  return { tag: "atom", name: value.atom };
}
