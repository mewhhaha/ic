[
  (source_file)
  (block)
  (arrow_function)
  (recursive_function)
  (effect_handler_expression)
] @local.scope

(binding_statement name: (identifier) @local.definition.var)
(binding_statement
  name: (named_shape_pattern
    (shorthand_shape_pattern_field
      name: (identifier) @local.definition.var)))
(effect_binding_statement name: (identifier) @local.definition.var)
(resume_dup_statement left: (identifier) @local.definition.var)
(resume_dup_statement right: (identifier) @local.definition.var)
(parameter name: (identifier) @local.definition.parameter)
(recursive_function parameters: (identifier) @local.definition.parameter)
(for_statement first: (identifier) @local.definition.var)
(for_statement second: (identifier) @local.definition.var)
(union_pattern value: (identifier) @local.definition.var)
(named_shape_pattern_field pattern: (identifier) @local.definition.var)
(product_rest_pattern name: (identifier) @local.definition.var)

(identifier) @local.reference
