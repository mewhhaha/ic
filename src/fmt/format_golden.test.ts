import { assert_equals } from "../assert.ts";
import { Source } from "../frontend.ts";
import { format_text } from "./format.ts";

// Golden formatter cases: deliberately messy input on the left, the exact
// biased output on the right. Every case must also parse and stay stable
// under a second format pass, so the suite guards intent, validity, and
// idempotence at once.

type GoldenCase = {
  name: string;
  input: string;
  expected: string;
  parses?: boolean;
};

const cases: GoldenCase[] = [
  {
    name: "reindents nested blocks from scratch",
    input: `let unwrap = value => {
      if let .some(found) = value {
   found
   } else {
0
      }
}
unwrap(1)
`,
    expected: `let unwrap = value => {
  if let .some(found) = value {
    found
  } else {
    0
  }
}
unwrap(1)
`,
  },
  {
    name: "indents union alternatives one level past the type header",
    input: `type Option t =
| .some = t
      | .none
let value = 1
value
`,
    expected: `type Option t =
  | .some = t
  | .none
let value = 1
value
`,
  },
  {
    name: "keeps union alternatives relative to an enclosing block",
    input: `let wrapped = {
type Result =
| .ok = Int
| .err = Text
1
}
wrapped
`,
    expected: `let wrapped = {
  type Result =
    | .ok = Int
    | .err = Text
  1
}
wrapped
`,
    // Local type declarations do not parse today; the shape still needs a
    // defined layout for mid-edit buffers.
    parses: false,
  },
  {
    name: "aligns multi-bracket lines with their opening line",
    input: `type MaybeInt =
  | .just = Int
  | .nothing
let by_name = 1
let result: MaybeInt = .just(if by_name == 1 {
2
} else {
0
})
result
`,
    expected: `type MaybeInt =
  | .just = Int
  | .nothing
let by_name = 1
let result: MaybeInt = .just(if by_name == 1 {
  2
} else {
  0
})
result
`,
  },
  {
    name: "formats effect declarations and handler literals",
    input: `effect Counter {
get: () => I32
add: (I32) => Unit
}
let run: () -> <Counter> I32 = () => {
_ <- Counter.add(40)
value <- Counter.get()
value + 2
}
let counter = {
let count = 0
Counter {
get: (!resume) => !resume(count),
add: (amount, !resume) => {
count = count + amount
!resume(())
},
return: value => value,
}
}
try run() with counter
`,
    expected: `effect Counter {
  get: () => I32
  add: (I32) => Unit
}
let run: () -> <Counter> I32 = () => {
  _ <- Counter.add(40)
  value <- Counter.get()
  value + 2
}
let counter = {
  let count = 0
  Counter {
    get: (!resume) => !resume(count),
    add: (amount, !resume) => {
      count = count + amount
      !resume(())
    },
    return: value => value,
  }
}
try run() with counter
`,
  },
  {
    name: "formats module headers and declares",
    input: `module (!init: Init) where
declare effect Io {
read: () => Text
print: (&Text) => Unit
}
declare Init {
io: Io
}
name <- Io.read()
return { name }
`,
    expected: `module (!init: Init) where
declare effect Io {
  read: () => Text
  print: (&Text) => Unit
}
declare Init {
  io: Io
}
name <- Io.read()
return { name }
`,
  },
  {
    name: "normalizes operator and sigil spacing",
    input: `let measure=( message :Text )=>{
len( &message )
}
let total=measure("hi")*2+1
total
`,
    expected: `let measure = (message: Text) => {
  len(&message)
}
let total = measure("hi") * 2 + 1
total
`,
  },
  {
    name: "keeps ranges, by clauses, and loop control tight",
    input: `let total = 0
for value in 0 .. 10 by 2 {
if value%2==0 {
continue
}
total = total+value
}
total
`,
    expected: `let total = 0
for value in 0..10 by 2 {
  if value % 2 == 0 {
    continue
  }
  total = total + value
}
total
`,
  },
  {
    name: "distinguishes rec declaration from recursive call",
    input: `let gcd = rec ( left , right ) => {
if right == 0 {
left
} else {
rec( right , left % right )
}
}
gcd(84, 30)
`,
    expected: `let gcd = rec (left, right) => {
  if right == 0 {
    left
  } else {
    rec(right, left % right)
  }
}
gcd(84, 30)
`,
  },
  {
    name: "keeps type set operators binary and sigils prefix",
    input: `type ValueSet = Int | Text
type Answer = ( ValueSet \\ Text ) & Int
let picked: Answer = 42
picked
`,
    expected: `type ValueSet = Int | Text
type Answer = (ValueSet \\ Text) & Int
let picked: Answer = 42
picked
`,
  },
  {
    name: "formats aggregates, updates, and indexing",
    input: `type Point = [ .x = Int , .y = Int ]
let point_value : Point = [ .x = 20 , .y = 21 ]
let moved = point_value { x : point_value . x + 1 }
let pair = { first : 20 , second : 0 }
let index = 1
pair [ index ] = 22
( moved ) . x + pair . first + pair . second
`,
    expected: `type Point = [.x = Int, .y = Int]
let point_value: Point = [.x = 20, .y = 21]
let moved = point_value { x: point_value.x + 1 }
let pair = { first: 20, second: 0 }
let index = 1
pair[index] = 22
(moved).x + pair.first + pair.second
`,
  },
  {
    name: "formats ownership wrappers and linear bindings",
    input: `let consume = ( !value ) => {
value + 1
}
let !token = 41
let frozen = freeze "shared"
let total = scratch {
let message = "temporary"
len( message ) + consume( !token )
}
total + len( frozen )
`,
    expected: `let consume = (!value) => {
  value + 1
}
let !token = 41
let frozen = freeze "shared"
let total = scratch {
  let message = "temporary"
  len(message) + consume(!token)
}
total + len(frozen)
`,
  },
  {
    name: "normalizes comments and preserves their placement",
    input: `//header comment
let value = 1 //trailing note
// already spaced
value
`,
    expected: `// header comment
let value = 1 // trailing note
// already spaced
value
`,
  },
  {
    name: "indents comment-only lines with their block",
    input: `let compute = () => {
// explain the constant
41 + 1
}
compute()
`,
    expected: `let compute = () => {
  // explain the constant
  41 + 1
}
compute()
`,
  },
  {
    name: "collapses blank runs and trims edges",
    input: `

let first = 1


let second = 2

let block = {

first + second

}

block
`,
    expected: `let first = 1

let second = 2

let block = {
  first + second
}

block
`,
  },
  {
    name: "canonicalizes strings and characters",
    input: `let text = "line\\none \\"quoted\\""
let char = '\\n'
len(text) + char
`,
    expected: `let text = "line\\none \\"quoted\\""
let char = '\\n'
len(text) + char
`,
  },
  {
    name: "splits semicolon statements onto lines",
    input: `let first = 1; let second = 2
first + second
`,
    expected: `let first = 1
let second = 2
first + second
`,
  },
  {
    name: "formats with-extension blocks",
    input: `const base_operations = 0
const extended_operations = base_operations with {
read : value => value + 1 ,
write : ( value , const f ) => {
f( value )
}
}
extended_operations.read(41)
`,
    expected: `const base_operations = 0
const extended_operations = base_operations with {
  read: value => value + 1,
  write: (value, const f) => {
    f(value)
  }
}
extended_operations.read(41)
`,
  },
  {
    name: "formats comptime and const specialization",
    input: `const make_adder = n => {
x => x + n
}
const add_three = comptime make_adder( 3 )
let apply_const = ( x , const f ) => {
f( x )
}
apply_const( 39 , add_three )
`,
    expected: `const make_adder = n => {
  x => x + n
}
const add_three = comptime make_adder(3)
let apply_const = (x, const f) => {
  f(x)
}
apply_const(39, add_three)
`,
  },
  {
    name: "keeps effect rows tight across pipes",
    input: `effect Stdin {
read: () => Text
}
effect Stdout {
print: (&Text) => Unit
}
let echo : () -> < Stdin | Stdout > Text = () => {
name <- Stdin.read()
_ <- Stdout.print(&name)
name
}
try echo() with Stdin { read: (!resume) => !resume("hi"), return: value => value }
`,
    expected: `effect Stdin {
  read: () => Text
}
effect Stdout {
  print: (&Text) => Unit
}
let echo: () -> <Stdin | Stdout> Text = () => {
  name <- Stdin.read()
  _ <- Stdout.print(&name)
  name
}
try echo() with Stdin { read: (!resume) => !resume("hi"), return: value => value }
`,
  },
  {
    name: "handles imports and type-changing shadowing",
    input: `import score_module from "./multi_file/score_module.ix"
let value = 40
value = value + 2
value := "done"
len(value)
`,
    expected: `import score_module from "./multi_file/score_module.ix"
let value = 40
value = value + 2
value := "done"
len(value)
`,
    parses: false,
  },
];

for (const golden of cases) {
  Deno.test("golden: " + golden.name, () => {
    const formatted = format_text(golden.input);
    assert_equals(formatted, golden.expected);
    assert_equals(format_text(formatted), formatted);

    if (golden.parses !== false) {
      Source.parse(formatted);
    }
  });
}
