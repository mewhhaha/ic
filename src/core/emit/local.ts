import { expect } from "../../expect.ts";
import type { ValType } from "../../op.ts";

export function set_local(
  locals: Map<string, ValType>,
  name: string,
  type: ValType,
): void {
  const existing = locals.get(name);

  if (existing) {
    expect(
      existing === type,
      "Core local $" + name + " is " + existing + ", got " + type,
    );
    return;
  }

  locals.set(name, type);
}
