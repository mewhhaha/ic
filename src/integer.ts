export type IntegerType = {
  signed: boolean;
  width: number;
};

export function integer_type_from_name(name: string): IntegerType | undefined {
  const match = /^([IU])([1-9][0-9]*)$/.exec(name);

  if (!match) {
    return undefined;
  }

  const sign = match[1];
  const width_text = match[2];

  if (!sign || !width_text) {
    throw new Error("Malformed fixed-width integer type: " + name);
  }

  const width = Number(width_text);

  if (!Number.isSafeInteger(width)) {
    throw new Error("Fixed-width integer width is too large: " + width_text);
  }

  return { signed: sign === "I", width };
}

export function integer_type_name(type: IntegerType): string {
  return (type.signed ? "I" : "U") + type.width.toString();
}

export function integer_val_type(
  type: IntegerType,
): "i32" | "i64" | undefined {
  if (type.width <= 32) {
    return "i32";
  }

  if (type.width <= 64) {
    return "i64";
  }

  return undefined;
}

export function integer_minimum(type: IntegerType): bigint {
  if (!type.signed) {
    return 0n;
  }

  return -(1n << BigInt(type.width - 1));
}

export function integer_maximum(type: IntegerType): bigint {
  if (type.signed) {
    return (1n << BigInt(type.width - 1)) - 1n;
  }

  return (1n << BigInt(type.width)) - 1n;
}

export function integer_literal_fits(
  type: IntegerType,
  value: bigint,
): boolean {
  return value >= integer_minimum(type) && value <= integer_maximum(type);
}

export function normalize_integer(type: IntegerType, value: bigint): bigint {
  const modulus = 1n << BigInt(type.width);
  let normalized = value % modulus;

  if (normalized < 0n) {
    normalized += modulus;
  }

  if (type.signed) {
    const sign_bit = 1n << BigInt(type.width - 1);

    if ((normalized & sign_bit) !== 0n) {
      normalized -= modulus;
    }
  }

  return normalized;
}

export function integer_bit_pattern(
  type: IntegerType,
  value: bigint,
): bigint {
  const modulus = 1n << BigInt(type.width);
  let pattern = value % modulus;

  if (pattern < 0n) {
    pattern += modulus;
  }

  return pattern;
}
