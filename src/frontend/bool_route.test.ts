import { assert_equals, assert_includes } from "../assert.ts";
import { Source, SourceDiagnosticError } from "../frontend.ts";
import type { Source as FrontSource } from "./ast.ts";

function assert_source_diagnostic(
  compile: () => unknown,
  code: string,
  message: string,
): void {
  try {
    compile();
  } catch (error) {
    if (!(error instanceof SourceDiagnosticError)) {
      throw error;
    }

    assert_equals(error.diagnostic.code, code);
    assert_equals(error.diagnostic.message, message);
    return;
  }

  throw new Error("Expected SourceDiagnosticError " + code);
}

function assert_analysis_diagnostic(
  source: string,
  code: string,
  message: string,
  source_text: string,
): void {
  const diagnostics = Source.analyze(source, { route: "core" }).diagnostics;

  assert_equals(
    diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      source: source.slice(diagnostic.span.start, diagnostic.span.end),
    })),
    [{ code, message, source: source_text }],
  );
}

Deno.test("Source.wat preserves valid Bool lambda values", () => {
  const wat = Source.wat(`
let identity = (value: Bool) => value
identity(true)
`);

  assert_includes(wat, "(func $main (result i32)");
  assert_includes(wat, "i32.const 1");
});

Deno.test("Source.wat rejects invalid Bool bindings before Core lowering", () => {
  assert_source_diagnostic(
    () => Source.wat("let value: Bool = 1\nvalue"),
    "IX2306",
    "Binding annotation expects Bool, got I32",
  );
});

Deno.test("Bool bindings reject Unit and atom values", () => {
  assert_source_diagnostic(
    () => Source.core("let value: Bool = ()\nvalue"),
    "IX2306",
    "Binding annotation expects Bool, got Unit",
  );
  assert_source_diagnostic(
    () => Source.core("let value: Bool = #yes\nvalue"),
    "IX2306",
    "Binding annotation expects Bool, got #yes",
  );
});

Deno.test("Unit and atom bindings reject Bool values", () => {
  assert_source_diagnostic(
    () => Source.core("let value: Unit = true\nvalue"),
    "IX2306",
    "Binding annotation expects Unit, got Bool",
  );
  assert_source_diagnostic(
    () => Source.core("let value: #yes = true\nvalue"),
    "IX2306",
    "Binding annotation expects #yes, got Bool",
  );
});

Deno.test("Source.core rejects I32 passed to a direct Bool lambda", () => {
  assert_source_diagnostic(
    () => Source.core("((value: Bool) => value)(1)"),
    "IX2307",
    "Call to anonymous function argument 1 for parameter value expects Bool, got I32",
  );
});

Deno.test("Source.core rejects Bool passed to a direct I32 lambda", () => {
  assert_source_diagnostic(
    () => Source.core("((value: I32) => value)(true)"),
    "IX2307",
    "Call to anonymous function argument 1 for parameter value expects I32, got Bool",
  );
});

Deno.test("Source.mod rejects I32 passed to a named Bool lambda", () => {
  assert_source_diagnostic(
    () => Source.mod("let accept = (value: Bool) => value\naccept(1)"),
    "IX2307",
    "Call to accept argument 1 for parameter value expects Bool, got I32",
  );
});

Deno.test("Source.wat rejects Bool passed to a named I32 lambda", () => {
  assert_source_diagnostic(
    () => Source.wat("let accept = (value: I32) => value\naccept(true)"),
    "IX2307",
    "Call to accept argument 1 for parameter value expects I32, got Bool",
  );
});

Deno.test("named Bool lambda results remain Bool at binding annotations", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
let identity = (value: Bool) => value
let result: I32 = identity(true)
result
`),
    "IX2306",
    "Binding annotation expects I32, got Bool",
  );
});

Deno.test("named I32 lambda results remain I32 at Bool annotations", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
let identity = (value: I32) => value
let result: Bool = identity(1)
result
`),
    "IX2306",
    "Binding annotation expects Bool, got I32",
  );
});

Deno.test("lambda captures keep their definition scope across shadowing", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
let value = true
let read = () => value
let value = 1
read() + 1
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
  assert_source_diagnostic(
    () =>
      Source.core(`
let value = 1
let read = () => value
let value = true
let result: Bool = read()
result
`),
    "IX2306",
    "Binding annotation expects Bool, got I32",
  );
});

Deno.test("callable aliases keep their definition scope across shadowing", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
let original = () => true
let alias = original
let original = () => 1
alias() + 1
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
  assert_source_diagnostic(
    () =>
      Source.core(`
let original = () => 1
let alias = original
let original = () => true
let result: Bool = alias()
result
`),
    "IX2306",
    "Binding annotation expects Bool, got I32",
  );
});

Deno.test("Bool lambda results cannot enter arithmetic", () => {
  assert_source_diagnostic(
    () => Source.wat("let ready = () => true\nready() + 1"),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("Bool block results cannot enter arithmetic", () => {
  assert_source_diagnostic(
    () => Source.wat("let ready = { true }\nready + 1"),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("Bool scratch results cannot enter arithmetic", () => {
  assert_source_diagnostic(
    () => Source.wat("let ready = scratch { true }\nready + 1"),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("if-let expression payloads retain Bool semantics", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
type Option = .some = Bool | .none
let option: Option = Option.some(true)
if let .some(flag) = option { flag + 1 } else { 0 }
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );

  Source.wat(`
type Option = .some = Bool | .none
let option: Option = Option.some(true)
if let .some(flag) = option { if flag { 1 } else { 0 } } else { 0 }
`);
});

Deno.test("if-let statement payloads retain Bool semantics", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
type Option = .some = Bool | .none
let option: Option = Option.some(true)
if let .some(flag) = option { flag + 1 }
0
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("destructured declared fields retain their named types", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
type Pair = [.flag = Bool, .number = I32]
let pair: Pair = [.flag = true, .number = 1]
let { number, flag } = pair
flag + number
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );

  Source.wat(`
type Pair = [.flag = Bool, .number = I32]
let pair: Pair = [.flag = true, .number = 1]
let { number, flag } = pair
if flag { number } else { 0 }
`);
});

Deno.test("handler Bool operation parameters retain semantic types", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
effect Check { test: (Bool) => Bool }
let run = () => { flag <- Check.test(true); flag }
let checker = Check {
  test: (flag, !resume) => flag + 1,
  return: value => value,
}
try run() with checker
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );

  Source.wat(`
effect Check { test: (Bool) => Bool }
let run = () => { flag <- Check.test(true); flag }
let checker = Check {
  test: (flag, !resume) => !resume(flag),
  return: value => value,
}
try run() with checker
`);
});

Deno.test("handler return parameters retain handled Bool results", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
effect Check { test: () => Bool }
let run = () => { flag <- Check.test(); flag }
let checker = Check {
  test: (!resume) => !resume(true),
  return: value => value + 1,
}
try run() with checker
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("annotated handler returns reject computed Bool results", () => {
  assert_source_diagnostic(
    () =>
      Source.core(
        "effect E { op:()=>Bool }; " +
          "let h=E { op:(!resume)=>!resume(true), " +
          "return:(v:I32)=>v+1 }; " +
          "try (()=>true)() with h",
      ),
    "IX2306",
    "Handler return parameter v expects I32, got Bool",
  );
});

Deno.test("core analysis reports invalid Bool resumptions", () => {
  const source = "effect E { op:()=>Bool }; " +
    "let run=()=>{ x <- E.op(); x }; " +
    "let h=E { op:(!resume)=>!resume(1), return:v=>v }; " +
    "try run() with h";

  assert_analysis_diagnostic(
    source,
    "IX2307",
    "Resumption resume expects Bool, got I32",
    "1",
  );
});

Deno.test("handler factories receive the handled Bool return type", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
effect Check { test: () => Bool }
let run = () => { flag <- Check.test(); flag }
let make = () => Check {
  test: (!resume) => !resume(true),
  return: value => value + 1,
}
try run() with make()
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );

  Source.wat(`
effect Check { test: () => Bool }
let run = () => { flag <- Check.test(); flag }
let make = () => Check {
  test: (!resume) => !resume(true),
  return: value => if value { 1 } else { 0 },
}
try run() with make()
`);
});

Deno.test("unannotated lambda calls specialize Bool parameters", () => {
  assert_source_diagnostic(
    () => Source.core("let increment = value => value + 1\nincrement(true)"),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
  assert_source_diagnostic(
    () => Source.wat("(value => value + 1)(true)"),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );

  Source.wat("let to_i32 = value => if value { 1 } else { 0 }\nto_i32(true)");
});

Deno.test("generic union aliases retain Bool payloads", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
type Maybe a = .some = a | .none
type MaybeBool = Maybe Bool
let result: MaybeBool = .some(true)
if let .some(flag) = result { flag + 1 } else { 0 }
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("unannotated qualified union constructors retain Bool payloads", () => {
  const source = `type Result = .ok = Bool | .err
let result = Result.ok(true)
if let .ok(value) = result { value + 1 } else { 0 }`;

  assert_analysis_diagnostic(
    source,
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
    "value + 1",
  );
});

Deno.test("unambiguous unqualified union constructors retain Bool payloads", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
type Result = .ok = Bool | .err
let result = .ok(true)
if let .ok(value) = result { value + 1 } else { 0 }
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("named generic union specializations retain Bool payloads", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
type Maybe a = .some = a | .none
type MaybeBool = Maybe Bool
let result = MaybeBool.some(true)
if let .some(value) = result { value + 1 } else { 0 }
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("contextual arrow parameters reject I32 call arguments", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
let accept: Bool -> Bool = value => value
accept(1)
`),
    "IX2307",
    "Call to accept argument 1 for parameter value expects Bool, got I32",
  );
});

Deno.test("Bool call parameters reject Unit and atom values", () => {
  assert_source_diagnostic(
    () => Source.core("((value: Bool) => value)(())"),
    "IX2307",
    "Call to anonymous function argument 1 for parameter value expects Bool, got Unit",
  );
  assert_source_diagnostic(
    () => Source.core("((value: Bool) => value)(#yes)"),
    "IX2307",
    "Call to anonymous function argument 1 for parameter value expects Bool, got #yes",
  );
});

Deno.test("Unit and atom call parameters reject Bool values", () => {
  assert_source_diagnostic(
    () => Source.core("((value: Unit) => true)(true)"),
    "IX2307",
    "Call to anonymous function argument 1 for parameter value expects Unit, got Bool",
  );
  assert_source_diagnostic(
    () => Source.core("((value: #yes) => true)(true)"),
    "IX2307",
    "Call to anonymous function argument 1 for parameter value expects #yes, got Bool",
  );
});

Deno.test("Bool function results reject Unit and atom values", () => {
  assert_source_diagnostic(
    () => Source.core("let f: () -> Bool = () => ()\nf()"),
    "IX2306",
    "Function result expects Bool, got Unit",
  );
  assert_source_diagnostic(
    () => Source.core("let f: () -> Bool = () => #yes\nf()"),
    "IX2306",
    "Function result expects Bool, got #yes",
  );
});

Deno.test("Unit and atom function results reject Bool values", () => {
  assert_source_diagnostic(
    () => Source.core("let f: () -> Unit = () => true\nf()"),
    "IX2306",
    "Function result expects Unit, got Bool",
  );
  assert_source_diagnostic(
    () => Source.core("let f: () -> #yes = () => true\nf()"),
    "IX2306",
    "Function result expects #yes, got Bool",
  );
});

Deno.test("contextual arrow results validate lambda bodies as Bool", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
let accept: Bool -> Bool = value => value + 1
accept(true)
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("higher-order arrows reject incompatible callback signatures", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
let apply: (Bool -> Bool, Bool) -> Bool =
  (const callback, value) => callback(value)
let number = (x: I32) => x
apply(number, true)
`),
    "IX2307",
    "Call to apply argument 1 for parameter callback expects Bool -> Bool, got I32 -> I32",
  );
});

Deno.test("higher-order arrows contextually validate callback bodies", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
let apply: (Bool -> Bool, Bool) -> Bool =
  (const callback, value) => callback(value)
apply(value => value + 1, true)
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("block-returned Bool callables retain parameter types", () => {
  assert_source_diagnostic(
    () => Source.core("({ (value: Bool) => value })(1)"),
    "IX2307",
    "Call to anonymous function argument 1 for parameter value expects Bool, got I32",
  );

  Source.wat("({ (value: Bool) => value })(true)");
});

Deno.test("function-returned Bool callables retain arrow context", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
let make: () -> Bool -> Bool = () => value => value
make()(1)
`),
    "IX2307",
    "Call to anonymous function argument 1 for parameter value expects Bool, got I32",
  );

  Source.wat(`
let make: () -> Bool -> Bool = () => value => value
make()(true)
  `);
});

Deno.test("computed Bool callable results retain semantic types", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
let result: I32 = ({ (value: Bool) => value })(true)
result
`),
    "IX2306",
    "Binding annotation expects I32, got Bool",
  );
  assert_source_diagnostic(
    () =>
      Source.wat(`
let make: () -> Bool -> Bool = () => value => value
let result: I32 = make()(true)
result
`),
    "IX2306",
    "Binding annotation expects I32, got Bool",
  );
});

Deno.test("frozen and borrowed Bool callables retain parameter types", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
let accept = (value: Bool) => value
(freeze accept)(1)
`),
    "IX2307",
    "Call to anonymous function argument 1 for parameter value expects Bool, got I32",
  );
  assert_source_diagnostic(
    () =>
      Source.core(`
let accept = (value: Bool) => value
(&accept)(1)
`),
    "IX2307",
    "Call to anonymous function argument 1 for parameter value expects Bool, got I32",
  );

  Source.wat(`
let accept = (value: Bool) => value
(freeze accept)(true)
`);
  assert_equals(
    Source.analyze(
      "let accept = (value: Bool) => value\n(&accept)(true)",
      { route: "core" },
    ).diagnostics,
    [],
  );
});

Deno.test("scratch-returned Bool callables retain parameter types", () => {
  assert_source_diagnostic(
    () => Source.core("(scratch { (value: Bool) => value })(1)"),
    "IX2307",
    "Call to anonymous function argument 1 for parameter value expects Bool, got I32",
  );

  assert_equals(
    Source.analyze("(scratch { (value: Bool) => value })(true)", {
      route: "core",
    }).diagnostics,
    [],
  );
});

Deno.test("captured Bool callables retain parameter types", () => {
  const source: FrontSource = {
    tag: "program",
    statements: [{
      tag: "expr",
      expr: {
        tag: "app",
        func: {
          tag: "captured",
          expr: {
            tag: "lam",
            params: [{
              name: "value",
              is_const: false,
              is_linear: false,
              annotation: "Bool",
            }],
            body: { tag: "var", name: "value" },
          },
          env: { scopes: [new Map()], next: new Map() },
        },
        args: [{ tag: "num", type: "i32", value: 1 }],
      },
    }],
  };

  assert_source_diagnostic(
    () => Source.core(source),
    "IX2307",
    "Call to anonymous function argument 1 for parameter value expects Bool, got I32",
  );
});

Deno.test("special rec calls retain contextual Bool parameters", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
let loop: (Bool, I32) -> Bool = rec (flag, n) => {
  if n == 0 { flag } else { rec(1, n - 1) }
}
loop(true, 1)
`),
    "IX2307",
    "Call to rec argument 1 for parameter flag expects Bool, got I32",
  );
});

Deno.test("recursive Bool results are branch-order independent", () => {
  for (
    const body of [
      "if n { rec(flag, n - 1) } else { flag }",
      "if n { flag } else { rec(flag, n - 1) }",
    ]
  ) {
    assert_source_diagnostic(
      () =>
        Source.wat(
          "let loop = rec (flag: Bool, n: I32) => " + body +
            "\nloop(true, 1) + 1",
        ),
      "IX2302",
      "Primitive i32.add expects numeric operands, got Bool",
    );
  }
});

Deno.test("selected closures cannot mix Bool and I32 parameters", () => {
  assert_source_diagnostic(
    () =>
      Source.artifact(`
module (!init: Init) where

declare effect Input { flag: () => Bool }
type Init = [.input = Input]

cond <- Input.flag()
let selected = if cond { (value: Bool) => value } else { (value: I32) => value }
let value: Bool = selected(true)
return { value }
`),
    "IX2306",
    "Conditional function branches have incompatible parameter 1 types Bool and I32",
  );
});

Deno.test("selected closures cannot mix Bool and I32 results", () => {
  assert_source_diagnostic(
    () =>
      Source.artifact(`
module (!init: Init) where

declare effect Input { flag: () => Bool }
type Init = [.input = Input]

cond <- Input.flag()
let selected = if cond { () => true } else { () => 2 }
let value: Bool = selected()
return { value }
`),
    "IX2306",
    "Conditional function branches have incompatible result types Bool and I32",
  );
});

Deno.test("mixed Bool and I32 branches are rejected before lowering", () => {
  assert_source_diagnostic(
    () =>
      Source.core(
        "let input = 1\nlet value = if input { true } else { 1 }\nvalue + 1",
      ),
    "IX2306",
    "Conditional branches have incompatible types Bool and I32",
  );

  Source.wat("let input = 1\nlet value: Bool = if input { true }\nvalue");
});

Deno.test("Bool branches reject Unit and atom alternatives", () => {
  assert_source_diagnostic(
    () => Source.core("let input = 1\nif input { true } else { () }"),
    "IX2306",
    "Conditional branches have incompatible types Bool and Unit",
  );
  assert_source_diagnostic(
    () => Source.core("let input = 1\nif input { true } else { #yes }"),
    "IX2306",
    "Conditional branches have incompatible types Bool and #yes",
  );
});

Deno.test("loop break values retain Bool semantics", () => {
  assert_source_diagnostic(
    () => Source.wat("let flag = loop { break true }\nflag + 1"),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );

  Source.wat("let flag = loop { break true }\nif flag { 1 } else { 0 }");
});

Deno.test("nested loop breaks cannot mix Bool and I32", () => {
  assert_source_diagnostic(
    () =>
      Source.artifact(`
module (!init: Init) where

declare effect Input { flag: () => Bool }
type Init = [.input = Input]

cond <- Input.flag()
let value: Bool = loop {
  if cond { break true }
  break 1
}
return { value }
`),
    "IX2306",
    "Loop break values have incompatible types Bool and I32",
  );
});

Deno.test("expression conditional loop breaks cannot mix Bool and I32", () => {
  const source = "let input=1; " +
    "let x=loop { if input { break true } else { break 2 } }; " +
    "x+1";

  assert_analysis_diagnostic(
    source,
    "IX2306",
    "Loop break values have incompatible types Bool and I32",
    "2",
  );
});

Deno.test("if-let loop breaks retain payload types", () => {
  const source = "type O=.some=Bool|.none; " +
    "let o:O=.some(true); " +
    "let x=loop { if let .some(v)=o { break v }; break 2 }; " +
    "x+1";

  assert_analysis_diagnostic(
    source,
    "IX2306",
    "Loop break values have incompatible types Bool and I32",
    "2",
  );
});

Deno.test("nested value loops keep their break types separate", () => {
  assert_source_diagnostic(
    () =>
      Source.core(
        "let value=loop { let nested=loop { break 1 }; break true }; " +
          "value+1",
      ),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("collection item bindings retain homogeneous Bool fields", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
let flags = { left: true, right: false }
let result = 0
for flag in flags { result = result + flag }
result
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );

  Source.core(`
let values = { left: 1, right: 2 }
let result = 0
for value in values { result = result + value }
result
`);
});

Deno.test("numeric source boundaries reject Bool values", () => {
  assert_source_diagnostic(
    () => Source.wat('get("ab", true)'),
    "IX2302",
    "get index expects numeric value, got Bool",
  );
  assert_source_diagnostic(
    () => Source.core("for value in true..2 { value }\n0"),
    "IX2302",
    "Range start expects numeric value, got Bool",
  );
  assert_source_diagnostic(
    () => Source.wat('slice("ab", 0, true)'),
    "IX2302",
    "slice end expects numeric value, got Bool",
  );
});

Deno.test("same assignment rejects replacing Bool with I32", () => {
  assert_source_diagnostic(
    () => Source.wat("let ready = true\nready = 1\nready"),
    "IX2301",
    "Assignment changes type for ready",
  );
});

Deno.test("declared Bool struct fields reject I32 payloads", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
type Status = [.ready = Bool]
let status: Status = [.ready = 1]
status.ready
`),
    "IX2306",
    "Struct field ready expects Bool, got I32",
  );
});

Deno.test("declared Bool fields reject Unit and atom payloads", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
type Status = [.ready = Bool]
let status: Status = [.ready = ()]
status.ready
`),
    "IX2306",
    "Struct field ready expects Bool, got Unit",
  );
  assert_source_diagnostic(
    () =>
      Source.core(`
type Status = [.ready = Bool]
let status: Status = [.ready = #yes]
status.ready
`),
    "IX2306",
    "Struct field ready expects Bool, got #yes",
  );
});

Deno.test("declared I32 struct fields reject Bool payloads", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
type Status = [.ready = I32]
let status: Status = [.ready = true]
status.ready
`),
    "IX2306",
    "Struct field ready expects I32, got Bool",
  );
});

Deno.test("declared Bool union cases keep IX2305 payload validation", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
type Status = .ready = Bool | .waiting
Status.ready(1)
`),
    "IX2305",
    "Union case ready expects Bool, got I32",
  );
});

Deno.test("declared Bool union cases reject Unit and atom payloads", () => {
  assert_source_diagnostic(
    () =>
      Source.core("type Status = .ready = Bool | .waiting\nStatus.ready(())"),
    "IX2305",
    "Union case ready expects Bool, got Unit",
  );
  assert_source_diagnostic(
    () =>
      Source.core(
        "type Status = .ready = Bool | .waiting\nStatus.ready(#yes)",
      ),
    "IX2305",
    "Union case ready expects Bool, got #yes",
  );
});

Deno.test("Bool aggregate call arguments validate nested fields", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
type Box = [.value = Bool]
let accept: Box -> Bool = box => box.value
accept([.value = 1])
`),
    "IX2307",
    "Call to accept argument 1 for parameter box expects struct, got struct",
  );
  assert_source_diagnostic(
    () =>
      Source.core(`
type Box a = [.value = a]
let accept: Box Bool -> Bool = box => box.value
accept([.value = 1])
`),
    "IX2307",
    "Call to accept argument 1 for parameter box expects struct, got struct",
  );
  assert_source_diagnostic(
    () =>
      Source.core(`
type Box = [.value = Bool]
type Wrapper = [.box = Box]
let accept: Wrapper -> Bool = wrapper => wrapper.box.value
accept([.box = [.value = 1]])
`),
    "IX2307",
    "Call to accept argument 1 for parameter wrapper expects struct, got struct",
  );
});

Deno.test("Bool aggregate fields and cases validate nested values", () => {
  assert_source_diagnostic(
    () =>
      Source.core(`
type Box = [.value = Bool]
type Wrapper = [.box = Box]
let wrapper: Wrapper = [.box = [.value = 1]]
wrapper.box.value
`),
    "IX2306",
    "Struct field box expects struct, got struct",
  );
  assert_source_diagnostic(
    () =>
      Source.core(`
type Box = [.value = Bool]
type Result = .ok = Box | .none
Result.ok([.value = 1])
`),
    "IX2305",
    "Union case ok expects struct, got struct",
  );
});

Deno.test("simple Bool aliases participate in lambda argument checks", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
type Flag = Bool
let accept = (value: Flag) => value
accept(1)
`),
    "IX2307",
    "Call to accept argument 1 for parameter value expects Bool, got I32",
  );
});

Deno.test("dynamic Bool struct access remains Bool in arithmetic", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
let status = [.left = true, .right = false]
status[input] + 1
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("dynamic Bool struct updates reject I32 values", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
let status = [.left = true, .right = false]
status[input] = 1
status[input]
`),
    "IX2306",
    "Struct index update expects Bool, got I32",
  );
});

Deno.test("dynamic mixed Bool and I32 struct access is rejected", () => {
  assert_source_diagnostic(
    () =>
      Source.wat(`
let status = [.left = true, .right = 1]
status[input]
`),
    "IX2304",
    "Mixed Bool and numeric indexed values",
  );
});

Deno.test("mixed dynamic access in a validated branch stays structured", () => {
  const source = "let pair=[.a=true,.b=1]\nif true { pair[input] } else { 0 }";

  assert_analysis_diagnostic(
    source,
    "IX2304",
    "Mixed Bool and numeric indexed values",
    "pair[input]",
  );
});

Deno.test("managed effects reject I32 passed to Bool operations", () => {
  assert_source_diagnostic(
    () =>
      Source.artifact(`
module (!init: Init) where

declare effect Input { choose: (Bool) => Bool }
type Init = [.input = Input]

value <- Input.choose(1)
return { value }
`),
    "IX2307",
    "Call to Input.choose argument 1 expects Bool, got I32",
  );
});

Deno.test("managed effects accept Bool arguments and results", () => {
  const artifact = Source.artifact(`
module (!init: Init) where

declare effect Input { choose: (Bool) => Bool }
type Init = [.input = Input]

value <- Input.choose(true)
return { value }
`);

  assert_includes(artifact.wat, "(func $__ix_abi_main");
});

Deno.test("managed effects reject Bool passed to I32 operations", () => {
  assert_source_diagnostic(
    () =>
      Source.artifact(`
module (!init: Init) where

declare effect Input { choose: (I32) => Bool }
type Init = [.input = Input]

value <- Input.choose(true)
return { value }
`),
    "IX2307",
    "Call to Input.choose argument 1 expects I32, got Bool",
  );
});

Deno.test("managed Bool effect results cannot enter arithmetic", () => {
  assert_source_diagnostic(
    () =>
      Source.artifact(`
module (!init: Init) where

declare effect Input { ready: () => Bool }
type Init = [.input = Input]

ready <- Input.ready()
let result = ready + 1
return { result }
`),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});

Deno.test("synthetic sources receive fallback spans before semantic errors", () => {
  const source = {
    tag: "program" as const,
    statements: [{
      tag: "expr" as const,
      expr: {
        tag: "prim" as const,
        prim: "i32.add" as const,
        left: { tag: "bool" as const, value: true },
        right: { tag: "num" as const, type: "i32" as const, value: 1 },
      },
    }],
  };

  assert_source_diagnostic(
    () => Source.core(source),
    "IX2302",
    "Primitive i32.add expects numeric operands, got Bool",
  );
});
