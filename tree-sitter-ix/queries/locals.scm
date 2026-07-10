[
  (source_file)
  (block)
  (arrow_function)
  (recursive_function)
  (effect_handler_expression)
] @local.scope

(binding_statement name: (identifier) @local.definition.var)
(binding_statement
  name: (destructuring_pattern (identifier) @local.definition.var))
(context_function_statement name: (identifier) @local.definition.var)
(context_function_statement
  context: (context_holder name: (identifier) @local.definition.var))
(context_function_statement
  context: (context_annotation
    holder: (context_holder name: (identifier) @local.definition.var)))
(state_binding_statement value: (identifier) @local.definition.var)
(resume_dup_statement left: (identifier) @local.definition.var)
(resume_dup_statement right: (identifier) @local.definition.var)
(parameter name: (identifier) @local.definition.parameter)
(recursive_function parameters: (identifier) @local.definition.parameter)
(for_statement first: (identifier) @local.definition.var)
(for_statement second: (identifier) @local.definition.var)
(union_pattern value: (identifier) @local.definition.var)

(identifier) @local.reference
