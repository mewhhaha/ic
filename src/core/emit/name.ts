import type { TempNameCtx } from "./types.ts";

export function fresh_temp_local(ctx: TempNameCtx, prefix: string): string {
  const name = "_" + prefix + "#" + ctx.next_temp.toString();
  ctx.next_temp += 1;
  return name;
}
