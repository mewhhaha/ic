[
  "let"
  "const"
  "rec"
  "module"
  "where"
  "declare"
  "effect"
  "try"
  "dup"
  "import"
  "from"
  "host_import"
  "return"
  "for"
  "in"
  "by"
  "if"
  "else"
  "with"
  "comptime"
  "borrow"
  "freeze"
  "scratch"
  "struct"
  "union"
] @keyword

(break_statement) @keyword
(continue_statement) @keyword

[
  "scalar"
  "bounded_borrow"
  "frozen_shareable"
  "ownership_transfer"
  "unique_heap"
] @keyword.storage

[
  "="
  ":="
  "=>"
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
  "::"
] @operator

(number) @constant.numeric.integer
(string) @string
(comment) @comment

((identifier) @type.builtin
  (#any-of? @type.builtin "Int" "I32" "U32" "I64" "Text" "Unit" "Type"))

(binding_statement name: (identifier) @variable)
(binding_statement name: (destructuring_pattern (identifier) @variable))
(import_statement name: (identifier) @namespace)
(host_import_statement name: (identifier) @function)
(declare_effect_statement name: (identifier) @type)
(effect_statement name: (identifier) @type)
(declare_record_statement name: (identifier) @type)
(effect_operation name: (identifier) @function.method)
(effect_operation_reference
  effect: (identifier) @type
  operation: (identifier) @function.method)
(context_function_statement
  context: (context_holder name: (identifier) @variable.builtin)
  name: (identifier) @function)
(context_function_statement
  context: (context_annotation
    holder: (context_holder name: (identifier) @variable.builtin))
  name: (identifier) @function)
(state_binding_statement
  context: (context_holder name: (identifier) @variable.builtin))
(state_binding_statement value: (identifier) @variable)
(resume_dup_statement left: (identifier) @variable)
(resume_dup_statement right: (identifier) @variable)
(effect_handler_expression effect: (identifier) @type)
(handler_operation_clause name: (identifier) @function.method)

(arrow_function parameters: (parameter name: (identifier) @variable.parameter))
(arrow_function parameters: (parameter_list (parameter name: (identifier) @variable.parameter)))
(recursive_function parameters: (identifier) @variable.parameter)
(recursive_function parameters: (parameter_list (parameter name: (identifier) @variable.parameter)))

(call_expression function: (identifier) @function)
(field_expression field: (identifier) @variable.other.member)
(field_definition name: (identifier) @variable.other.member)
(type_field name: (identifier) @variable.other.member)
(union_case case: (identifier) @constructor)
(union_pattern case: (identifier) @constructor)

((call_expression function: (identifier) @function.builtin)
  (#any-of? @function.builtin
    "len" "get" "slice" "append" "has" "fields_of" "cases_of"
    "is_struct" "is_union" "size_of" "align_of" "layout" "fail" "panic"))
