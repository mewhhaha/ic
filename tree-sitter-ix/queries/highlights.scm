; General identifiers. More specific patterns below override this fallback.
(identifier) @variable
(effect_identifier) @type

; Keywords
[
  "module"
  "where"
] @keyword

[
  "import"
  "from"
] @keyword.control.import

[
  "let"
  "const"
] @keyword.storage

[
  "declare"
  "effect"
  "struct"
  "type"
  "union"
] @keyword.storage.type

"rec" @keyword.function

[
  "if"
  "else"
] @keyword.control.conditional

(try_with_expression
  ["try" "with"] @keyword.control.exception)

(extension_expression
  "with" @keyword.operator)

[
  "for"
  "loop"
  "in"
  "by"
] @keyword.control.repeat

[
  "return"
  (break_statement)
  (continue_statement)
] @keyword.control.return

(wildcard) @variable.builtin

[
  "dup"
  "freeze"
  "scratch"
  "is"
] @keyword.operator

"comptime" @keyword.directive

[
  "scalar"
] @keyword.storage.modifier

; Operators and punctuation
[
  "="
  ":="
  "=>"
  "->"
  ".."
  "+"
  "-"
  "*"
  "/"
  "%"
  "=="
  "!="
  "<"
  "<="
  ">"
  ">="
  "&&"
  "||"
  "!"
  "<-"
  "|"
  "&"
  "\\"
] @operator

[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

[
  ","
  ":"
  "."
  "#"
] @punctuation.delimiter

; Literals and comments
(number) @constant.numeric.integer
(string) @string
(character) @constant.character
(boolean) @constant.builtin.boolean
(atom_expression
  name: (identifier) @constant)
(atom_type
  name: (identifier) @constant)
(comment) @comment.line

; Types
(type_difference
  (identifier) @type)

(type_application
  constructor: (identifier) @type
  argument: (identifier) @type)

(frozen_type
  name: (identifier) @type)

(borrow_type
  (identifier) @type)

[
  (top_type)
  (never_type)
] @type.builtin

(row_variable) @type.parameter

((identifier) @type.builtin
  (#any-of? @type.builtin
    "Bool" "Int" "I32" "U32" "I64" "Text" "Bytes" "Unit" "Type" "Resume"))

(declare_effect_statement
  name: (effect_identifier) @type)

(effect_statement
  name: (effect_identifier) @type)

(declare_record_statement
  name: (identifier) @type)

(type_declaration_statement
  name: (identifier) @type
  parameter: (identifier) @type.parameter)

(type_case
  name: (identifier) @constructor)

(named_type_field
  name: (identifier) @variable.other.member)

(effect_operation_reference
  effect: (effect_identifier) @type
  operation: (identifier) @function.method)

(effect_family_reference
  effect: (effect_identifier) @type)

(effect_handler_expression
  effect: (effect_identifier) @constructor)

; Bindings and parameters
(binding_statement
  name: (identifier) @variable)

(effect_binding_statement
  name: (identifier) @variable)

(binding_statement
  name: (destructuring_pattern
    (identifier) @variable))

(binding_statement
  name: (identifier) @function
  value: [(arrow_function) (recursive_function)])

(binding_statement
  name: (identifier) @type
  value: [(struct_type) (union_type)])

(parameter
  name: (identifier) @variable.parameter)

(recursive_function
  parameters: (identifier) @variable.parameter)

(assignment
  name: (identifier) @variable.mutable)

(index_assignment
  name: (identifier) @variable.mutable)

(for_statement
  first: (identifier) @variable)

(for_statement
  second: (identifier) @variable)

(union_pattern
  value: (identifier) @variable)

(linear_reference
  name: (identifier) @variable)

(atom_expression
  name: (identifier) @constant)

(resume_dup_statement
  left: (identifier) @variable)

(resume_dup_statement
  right: (identifier) @variable)

; Imports, functions, effects, and calls
(import_statement
  name: (identifier) @namespace)

(module_binding_statement
  name: (identifier) @namespace)

(effect_operation
  name: (identifier) @function.method)

(handler_operation_clause
  name: (identifier) @function.method)

(call_expression
  function: (identifier) @function)

(condition_call_expression
  function: (condition_expression
    (identifier) @function))

(call_expression
  function: (linear_reference
    name: (identifier) @function))

(condition_call_expression
  function: (condition_expression
    (linear_reference
      name: (identifier) @function)))

((call_expression
  function: (identifier) @function.builtin)
  (#any-of? @function.builtin
    "len" "get" "slice" "append" "has" "fields_of" "cases_of"
    "is_struct" "is_union" "size_of" "align_of" "layout" "fail" "panic"))

((condition_call_expression
  function: (condition_expression
    (identifier) @function.builtin))
  (#any-of? @function.builtin
    "len" "get" "slice" "append" "has" "fields_of" "cases_of"
    "is_struct" "is_union" "size_of" "align_of" "layout" "fail" "panic"))

; Members and constructors
(field_expression
  field: (identifier) @variable.other.member)

(condition_field_expression
  field: (identifier) @variable.other.member)

(field_definition
  name: (identifier) @variable.other.member)

(record_field
  name: (identifier) @variable.other.member)

(shorthand_field
  name: (identifier) @variable.other.member)

(type_field
  name: (identifier) @variable.other.member)

(union_case
  case: (identifier) @constructor)

(union_pattern
  case: (identifier) @constructor)

; A member in call position is a method. Keep these after the general member
; patterns so they win for the same identifier span.
(call_expression
  function: (field_expression
    field: (identifier) @function.method))

(condition_call_expression
  function: (condition_expression
    (condition_field_expression
      field: (identifier) @function.method)))
