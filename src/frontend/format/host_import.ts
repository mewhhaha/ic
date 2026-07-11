import type {
  FrontHostImport,
  FrontHostImportArgContract,
  FrontHostImportResultContract,
} from "../ast.ts";

export function format_host_import(value: FrontHostImport): string {
  let text = "host_import " + value.name + " from " +
    Deno.inspect(value.module + "." + value.field);
  text += " (";
  text += value.args.map((arg, index) => {
    const param = value.params[index];

    if (!param) {
      throw new Error("Missing host import parameter type");
    }

    return format_host_import_arg(arg, param);
  }).join(", ");
  text += ") => ";
  text += format_host_import_result(
    value.result,
    value.result_owner,
  );
  return text;
}

function format_host_import_arg(
  arg: FrontHostImportArgContract,
  param: string,
): string {
  if (arg.tag === "scalar") {
    return format_host_import_val_type(param);
  }

  const type_name = format_host_import_owner_reason(arg.reason);

  if (arg.tag === "ownership_transfer") {
    return type_name;
  }

  if (arg.tag === "bounded_borrow") {
    return "&" + type_name;
  }

  return "#" + type_name;
}

function format_host_import_result(
  result: string,
  owner: FrontHostImportResultContract | undefined,
): string {
  if (!owner) {
    return format_host_import_val_type(result);
  }

  if (owner.tag === "scalar") {
    return "scalar " + format_host_import_val_type(result);
  }

  const type_name = format_host_import_owner_reason(owner.reason);

  if (owner.tag === "unique_heap") {
    return type_name;
  }

  return "#" + type_name;
}

function format_host_import_val_type(type: string): string {
  if (type === "i32") {
    return "I32";
  }

  if (type === "i64") {
    return "I64";
  }

  throw new Error("Cannot format host import ABI type: " + type);
}

function format_host_import_owner_reason(
  reason: string | { tag: "type_ref"; name: string } | undefined,
): string {
  if (reason && typeof reason !== "string") {
    return reason.name;
  }

  if (reason === "text") {
    return "Text";
  }

  if (reason === "bytes") {
    return "Bytes";
  }

  if (reason === "closure") {
    return "closure";
  }

  if (reason === "runtime_union") {
    return "runtime_union";
  }

  if (reason === "runtime_aggregate") {
    return "runtime_aggregate";
  }

  if (reason === "freeze") {
    return "freeze";
  }

  throw new Error("Cannot format host import owner reason");
}
