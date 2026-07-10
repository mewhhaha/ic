import { assert_equals } from "../assert.ts";
import { Source } from "../frontend.ts";

const prelude = `
effect Suspend {
  pause: () => I32
}

let Fx run = () => {
  let (!Fx, value) = Fx.Suspend.pause()
  value + 1
}
`;

async function run_i32(source: string): Promise<number> {
  const command = new Deno.Command("wat2wasm", {
    args: ["-o", "-", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(new TextEncoder().encode(Source.wat(source)));
  await writer.close();
  const output = await command.output();

  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }

  const instance = await WebAssembly.instantiate(output.stdout);
  const main = instance.instance.exports.main;

  if (typeof main !== "function") {
    throw new Error("Missing main export");
  }

  return Number(main());
}

Deno.test("a resumption supports a direct affine local alias", async () => {
  assert_equals(
    await run_i32(`${prelude}
let suspend = Suspend {
  pause: (!resume) => {
    let !later = !resume
    !later(41)
  },
  return: (value: I32) => value,
}

try run() with suspend
`),
    42,
  );
});

Deno.test("a resumption can be stored in and extracted from a struct", async () => {
  assert_equals(
    await run_i32(`
const resume_box_type = struct {
  resume: Resume
}

${prelude}
let suspend = Suspend {
  pause: (!resume) => {
    let !box: resume_box_type = resume_box_type { resume: !resume }
    let !later: Resume = !box.resume
    !later(41)
  },
  return: (value: I32) => value,
}

try run() with suspend
`),
    42,
  );
});

Deno.test("a resumption can pass through an affine Ix function", async () => {
  assert_equals(
    await run_i32(`${prelude}
let invoke = (!later: Resume, value: I32) => !later(value)

let suspend = Suspend {
  pause: (!resume) => invoke(!resume, 41),
  return: (value: I32) => value,
}

try run() with suspend
`),
    42,
  );
});
