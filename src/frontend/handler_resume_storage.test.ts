import { assert_equals } from "../assert.ts";
import { Core } from "../core.ts";
import { Source } from "../frontend.ts";

const prelude = `
effect Suspend {
  pause: () => I32
}

let run = () => {
  value <- Suspend.pause()
  value + 1
}
`;

const stored_resume_source = `
const { struct } = import "duck:prelude" ()
const resume_box_type = struct {
  .resume= Resume
}

${prelude}
let suspend = Suspend {
  pause: (!resume) => {
    let !box: resume_box_type = [.resume = !resume]
    let !later: Resume = !box.resume
    !later(41)
  },
  return: (value: I32) => value,
}

try run() with suspend
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
  assert_equals(await run_i32(stored_resume_source), 42);
});

Deno.test("extracting a stored resumption detaches its closure allocation", () => {
  const proof = Core.proof(Source.core(stored_resume_source));

  assert_equals(proof.issues, []);
  assert_equals(
    proof.allocations.facts.map((fact) => ({
      allocation_id: fact.allocation_id,
      reason: fact.reason,
      owned_children: fact.owned_children,
    })),
    [
      {
        allocation_id: "allocation#0",
        reason: "runtime_aggregate",
        owned_children: undefined,
      },
      {
        allocation_id: "allocation#1",
        reason: "closure",
        owned_children: undefined,
      },
    ],
  );
  assert_equals(
    proof.drops.steps.map((step) => ({
      allocation_id: step.allocation_id,
      owner: step.owner,
      owned_children: step.owned_children,
    })),
    [
      {
        allocation_id: "allocation#0",
        owner: "box",
        owned_children: undefined,
      },
      {
        allocation_id: "allocation#1",
        owner: "later",
        owned_children: undefined,
      },
    ],
  );
});

Deno.test("a resumption can pass through an affine Duck function", async () => {
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
