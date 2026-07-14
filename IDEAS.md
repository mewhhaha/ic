functions/closures takes only a single value that gets deconstructed, like

let run = (a, b) => {}
run (a, b)

and let's support tuple syntax with (a,b,c) etc and deconstruction
but you could run it like
let run = [a, b] => {}

run (Maybe a)

let x = () => {}
x () // Run as empty lol

let's have our match syntax be

match x
| ... if ... =>

etc


allow for casting between types that duck-type to the same structure

Maybe we change our [.a = I32, .b = I32] to use tuples instead like

(.a = I32, .b = I32)

but still allow for indexing 0,1,2 etc based on the size

instead

and [] can be reserved for same element arrays instead, but also allow for named access other than indexes
[I32; 3]

[.head = I32, ...tail = [I32; _]]

Or something like that? Like, if you wanted to create a non-empty array?

Let's focus on inference as a super power. Ideally we never type anything at all when writing code. Just ahead of time. Maybe we should allow for local imports. Or remove import statement have "use" instead?

const { a, b } = use "./something_something"

let x = () => {
  // These use statements are supposed to be scoped
  const { b, c } = use "../something_else"
  const { ... } = use "../lol" // just splatting all of them inside here
  const { b: _, c: _, ... } = use "../asdfasdfdsa" // Removing b and c and splat out everything else?
}

So ... is just a special symbol for adding all the qualified symbols to the namespace

I guess we could use it like

let { ... } = my_fun ()

as well?
