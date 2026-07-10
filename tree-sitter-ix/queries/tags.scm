(binding_statement
  name: (identifier) @name
  value: [(arrow_function) (recursive_function)] @definition.function)

(binding_statement
  name: (identifier) @name
  value: [(struct_type) (union_type)] @definition.type)

(import_statement name: (identifier) @name) @definition.module
(declare_effect_statement name: (identifier) @name) @definition.type
(effect_statement name: (identifier) @name) @definition.type
(declare_record_statement name: (identifier) @name) @definition.type
(effect_operation name: (identifier) @name) @definition.function
(handler_operation_clause name: (identifier) @name) @definition.function
(context_function_statement name: (identifier) @name) @definition.function
(host_import_statement name: (identifier) @name) @definition.function

(call_expression function: (identifier) @name) @reference.call
