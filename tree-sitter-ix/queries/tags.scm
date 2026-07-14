(binding_statement
  name: (identifier) @name
  value: [(arrow_function) (recursive_function)] @definition.function)

(binding_statement
  name: (identifier) @name
  value: (postfix_expression
    [(struct_type) (union_type)] @definition.type))

(module_binding_statement name: (identifier) @name) @definition.module
(declare_effect_statement name: (effect_identifier) @name) @definition.type
(effect_statement name: (effect_identifier) @name) @definition.type
(declare_record_statement name: (identifier) @name) @definition.type
(type_declaration_statement name: (identifier) @name) @definition.type
(effect_operation name: (identifier) @name) @definition.function
(handler_operation_clause name: (identifier) @name) @definition.function

(application_expression
  function: (postfix_expression
    (identifier) @name)) @reference.call
