import { assert_equals } from "../../assert.ts";
import { Source } from "../../frontend.ts";
import { Core } from "../../core.ts";
import { named_rec_function_core } from "../named_rec.ts";
import { bind_core_borrowed_fact } from "../local_facts.ts";

Deno.test("borrowed projections remain borrowed through local aliases", () => {
  const borrowed_locals = new Set(["table"]);
  const ctx = { borrowed_locals };

  bind_core_borrowed_fact("current", undefined, {
    tag: "field",
    object: { tag: "var", name: "table" },
    name: "pieces",
  }, ctx);
  bind_core_borrowed_fact(
    "node",
    undefined,
    { tag: "var", name: "current" },
    ctx,
  );
  bind_core_borrowed_fact("piece", undefined, {
    tag: "index",
    object: { tag: "var", name: "node" },
    index: { tag: "num", type: "i32", value: 0 },
    move: true,
  }, ctx);

  assert_equals([...borrowed_locals], ["table", "current", "node", "piece"]);
});

Deno.test("reassigning a borrowed list cursor keeps its owner protected", () => {
  const core = Source.core(`
const {} = import "duck:prelude/functional" ()
type IntList = List I32

let sum = values => {
  let current = values
  let total = 0

  loop {
    if let \`Cons node = current {
      total = total + node[0]
      current = node[1]
    } else {
      break
    }
  }

  total
}

let end: IntList = \`Nil ()
let values: IntList = \`Cons [20, \`Cons [22, end]]
sum(&values) + sum(&values)
`);

  assert_equals(Core.validate_borrows(core), { ok: true, issues: [] });
});

Deno.test("a scalar read ends its borrow before the next statement", () => {
  const core = Source.core(`
const { struct } = import "duck:prelude" ()
type Selection = struct { .anchor = I32, .head = I32 }

const selection_head: &Selection -> I32 = (selection: &Selection) => selection.head

let selection: Selection = Selection.new { .anchor = 20, .head = 22 }
let head = selection_head(&selection)
selection = Selection.new { .anchor = head, .head = head }
selection.head
`);

  assert_equals(Core.validate_borrows(core), { ok: true, issues: [] });
});

Deno.test("reassigning a cursor into a borrowed struct field is local", () => {
  const core = Source.core(`
const { struct } = import "duck:prelude" ()
const {} = import "duck:prelude/functional" ()
type IntList = List I32
type Numbers = struct { .values = IntList }

let sum = numbers => {
  let current = numbers.values
  let total = 0

  loop {
    if let \`Cons node = current {
      total = total + node[0]
      current = node[1]
    } else {
      break
    }
  }

  total
}

let end: IntList = \`Nil ()
let values: IntList = \`Cons [20, \`Cons [22, end]]
let numbers: Numbers = Numbers.new { .values = values }
sum(&numbers)
`);

  assert_equals(Core.validate_borrows(core), { ok: true, issues: [] });
});

Deno.test("a borrowed parameter can be forwarded without re-borrowing", () => {
  const core = Source.core(`
const { struct } = import "duck:prelude" ()
type Selection = struct { .head = I32 }
type Editor = struct { .selection = Selection }

const selection_head: &Selection -> I32 = (selection: &Selection) => selection.head
const forwarded_head: &Selection -> I32 = (selection: &Selection) => selection_head(selection)
let read_head: Editor -> I32 = editor => forwarded_head(&editor.selection)
let editor = Editor.new { .selection = Selection.new { .head = 42 } }
read_head(editor)
`);
  const definition = core.recFunctions?.read_head;

  if (definition === undefined) {
    throw new Error("Expected read_head to lower as a named function");
  }

  const function_core = named_rec_function_core(core, definition);
  assert_equals(Core.validate_borrows(function_core), {
    ok: true,
    issues: [],
  });
});
