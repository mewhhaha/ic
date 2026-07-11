import { Expr, type Expr as ExprNode } from "./expr.ts";
import { TestSource as Source } from "./frontend/test_source.ts";
import { Ic } from "./ic.ts";
import { Mod } from "./mod.ts";
import { Data, Emit, Typed } from "./trait.ts";

export const decoder = new TextDecoder();

export function log_error(label: string, bytes: Uint8Array): void {
  if (bytes.length > 0) {
    console.error(`${label}:\n${decoder.decode(bytes)}`);
  }
}

export function wat_from_expr(expr: ExprNode): string {
  const data = Data.data(Expr, expr);
  const mod: Mod = {
    funcs: {
      main: {
        name: "main",
        result: Typed.type(Expr, expr),
        body: Emit.emit(Expr, expr),
      },
    },
    exports: ["main"],
  };

  if (data.length > 0) {
    mod.memory = {
      name: "memory",
      pages: 1,
      export_name: "memory",
    };
    mod.data = data;
  }

  return Emit.emit(Mod, mod);
}

export function wat_from_source(text: string): string {
  const ic = Source.compile(text);
  const expr = Emit.emit(Ic, ic);
  return wat_from_expr(expr);
}

export function wat_from_core_source(text: string): string {
  return Source.wat(text);
}

export async function instantiate_wat(
  wat_text: string,
  name: string,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
  const dir = await Deno.makeTempDir();
  const wat_file = dir + "/" + name + ".wat";
  const wasm_file = dir + "/" + name + ".wasm";

  try {
    await Deno.writeTextFile(wat_file, wat_text);

    const compile = await new Deno.Command("wat2wasm", {
      args: [wat_file, "-o", wasm_file],
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (compile.stderr.length > 0) {
      log_error("wat2wasm stderr", compile.stderr);
    }

    if (!compile.success) {
      throw new Error("wat2wasm failed");
    }

    const wasm_bytes = await Deno.readFile(wasm_file);
    const { instance } = await WebAssembly.instantiate(wasm_bytes, imports);
    return instance;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
