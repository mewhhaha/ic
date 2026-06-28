import { Mod } from "./src/mod.ts";
import { Source } from "./src/parse.ts";
import { Emit } from "./src/trait.ts";

let sourcePath = Deno.args[0];

if (sourcePath === undefined) {
  sourcePath = "examples/main.ic";
}

const source = await Deno.readTextFile(sourcePath);
const mod = Emit.emit(Source, source);
const watText = Emit.emit(Mod, mod);

await Deno.mkdir("build", { recursive: true });
await Deno.writeTextFile("build/out.wat", watText);

console.log("Source:");
console.log(source);

console.log("WAT:");
console.log(watText);
