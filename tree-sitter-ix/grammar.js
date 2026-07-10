const PREC = {
  ARROW: 1,
  OR: 2,
  AND: 3,
  EQUALITY: 4,
  COMPARE: 5,
  ADD: 6,
  MULTIPLY: 7,
  UNARY: 8,
  POSTFIX: 9,
};

module.exports = grammar({
  name: "ix",

  extras: ($) => [/\s/, ";", $.comment],

  word: ($) => $.identifier,

  conflicts: ($) => [
    [$.index_assignment, $._primary_expression],
    [$._primary_expression, $.linear_reference],
    [$.parameter],
    [$.parameter, $._primary_expression],
    [$.union_case],
    [$.field_block, $.block],
    [$.parameter, $._primary_expression, $.linear_reference],
    [$.parameter, $.type_reference],
    [$.condition_expression, $.linear_reference],
    [$._primary_expression, $.shorthand_field],
    [$.context_holder, $.resume_dup_statement],
  ],

  rules: {
    source_file: ($) =>
      seq(
        $.module_header,
        repeat($._module_statement),
        $.module_return_statement,
      ),

    module_header: ($) =>
      seq(
        "module",
        field("parameters", $.parameter_list),
        "where",
      ),

    _module_statement: ($) =>
      choice(
        $.declare_effect_statement,
        $.effect_statement,
        $.declare_record_statement,
        $.import_statement,
        $.host_import_statement,
        $.context_function_statement,
        $.state_binding_statement,
        $.resume_dup_statement,
        $.binding_statement,
        $.type_pattern_statement,
        $.for_statement,
        $.break_statement,
        $.continue_statement,
        $.index_assignment,
        $.assignment,
        $.expression_statement,
      ),

    _statement: ($) =>
      choice(
        $.context_function_statement,
        $.state_binding_statement,
        $.resume_dup_statement,
        $.binding_statement,
        $.type_pattern_statement,
        $.return_statement,
        $.for_statement,
        $.break_statement,
        $.continue_statement,
        $.index_assignment,
        $.assignment,
        $.expression_statement,
      ),

    binding_statement: ($) =>
      seq(
        field("kind", choice("let", "const")),
        optional(field("recursive", "rec")),
        optional(field("linear", "!")),
        field("name", choice($.identifier, $.destructuring_pattern)),
        optional(seq(":", field("type", $.type_reference))),
        "=",
        field("value", $._expression),
      ),

    destructuring_pattern: ($) =>
      seq(
        "{",
        optional(commaSep1(field("name", $.identifier))),
        "}",
      ),

    context_function_statement: ($) =>
      seq(
        "let",
        optional(field("recursive", "rec")),
        choice(
          field("context", $.context_holder),
          field("context", $.context_annotation),
        ),
        field("name", $.identifier),
        "=",
        field("value", $._expression),
      ),

    context_holder: ($) => field("name", $.identifier),

    context_annotation: ($) =>
      seq(
        "(",
        field("holder", $.context_holder),
        "::",
        field("effects", $.effect_row),
        ")",
      ),

    effect_row: ($) =>
      seq("{", optional(commaSep1($.effect_operation_reference)), "}"),

    effect_operation_reference: ($) =>
      seq(
        field("effect", $.identifier),
        ".",
        field("operation", $.identifier),
      ),

    state_binding_statement: ($) =>
      seq(
        "let",
        "(",
        "!",
        field("context", $.context_holder),
        ",",
        field("value", choice($.identifier, $.unit_pattern)),
        ")",
        "=",
        field("operation", $._expression),
      ),

    resume_dup_statement: ($) =>
      seq(
        "let",
        "(",
        "!",
        field("left", $.identifier),
        ",",
        "!",
        field("right", $.identifier),
        ")",
        "=",
        "dup",
        field("value", $.linear_reference),
      ),

    unit_pattern: () => seq("(", ")"),

    type_pattern_statement: ($) =>
      seq(
        "let",
        field("pattern", $.type_pattern),
        "=",
        field("value", $._expression),
      ),

    declare_effect_statement: ($) =>
      seq(
        "declare",
        "effect",
        field("name", $.identifier),
        field("operations", $.effect_operation_block),
      ),

    effect_statement: ($) =>
      seq(
        "effect",
        field("name", $.identifier),
        field("operations", $.effect_operation_block),
      ),

    effect_operation_block: ($) =>
      seq(
        "{",
        repeat(seq($.effect_operation, optional(","))),
        "}",
      ),

    effect_operation: ($) =>
      seq(
        field("name", $.identifier),
        ":",
        field("parameters", $.host_parameter_list),
        "=>",
        field("result", $.host_result),
      ),

    declare_record_statement: ($) =>
      seq(
        "declare",
        field("name", $.identifier),
        field("fields", $.type_field_block),
      ),

    import_statement: ($) =>
      seq(
        "import",
        field("name", $.identifier),
        "from",
        field("path", $.string),
      ),

    host_import_statement: ($) =>
      seq(
        "host_import",
        field("name", $.identifier),
        "from",
        field("path", $.string),
        field("parameters", $.host_parameter_list),
        "=>",
        field("result", $.host_result),
      ),

    host_parameter_list: ($) =>
      seq("(", optional(commaSep1($.host_parameter)), ")"),

    host_parameter: ($) =>
      seq(
        optional(
          field(
            "contract",
            choice(
              "scalar",
              "bounded_borrow",
              "frozen_shareable",
              "ownership_transfer",
            ),
          ),
        ),
        field("type", $.type_reference),
      ),

    host_result: ($) =>
      seq(
        optional(
          field(
            "contract",
            choice("scalar", "unique_heap", "frozen_shareable"),
          ),
        ),
        field("type", $.type_reference),
      ),

    return_statement: ($) => seq("return", field("value", $._expression)),

    module_return_statement: ($) =>
      seq("return", field("exports", $.object_literal)),

    break_statement: () => "break",

    continue_statement: () => "continue",

    assignment: ($) =>
      seq(
        field("name", $.identifier),
        field("operator", choice("=", ":=")),
        field("value", $._expression),
      ),

    index_assignment: ($) =>
      seq(
        field("name", $.identifier),
        "[",
        field("index", $._expression),
        "]",
        "=",
        field("value", $._expression),
      ),

    for_statement: ($) =>
      seq(
        "for",
        field("first", $.identifier),
        optional(seq(",", field("second", $.identifier))),
        "in",
        field("start_or_collection", $.condition_expression),
        optional(
          seq(
            "..",
            field("end", $.condition_expression),
            optional(seq("by", field("step", $.condition_expression))),
          ),
        ),
        field("body", prec.dynamic(10, $.block)),
      ),

    expression_statement: ($) => $._expression,

    _expression: ($) =>
      choice(
        $.try_with_expression,
        $.arrow_function,
        $.recursive_function,
        $.recursive_call_expression,
        $.if_expression,
        $.binary_expression,
        $.unary_expression,
        $.call_expression,
        $.field_expression,
        $.index_expression,
        $.struct_expression,
        $.extension_expression,
        $.effect_handler_expression,
        $._primary_expression,
      ),

    try_with_expression: ($) =>
      prec.right(
        PREC.ARROW,
        seq(
          "try",
          field("body", $._expression),
          "with",
          field("handler", $._expression),
        ),
      ),

    arrow_function: ($) =>
      prec.right(
        PREC.ARROW,
        seq(
          field("parameters", choice($.parameter, $.parameter_list)),
          "=>",
          field("body", $._expression),
        ),
      ),

    recursive_function: ($) =>
      prec.right(
        PREC.ARROW,
        seq(
          "rec",
          field("parameters", choice($.identifier, $.parameter_list)),
          "=>",
          field("body", $._expression),
        ),
      ),

    recursive_call_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq("rec", field("arguments", $.argument_list)),
      ),

    parameter_list: ($) => seq("(", optional(commaSep1($.parameter)), ")"),

    parameter: ($) =>
      seq(
        optional("const"),
        optional("!"),
        field("name", $.identifier),
        optional(seq(":", field("type", $.type_reference))),
      ),

    if_expression: ($) =>
      prec.right(
        seq(
          "if",
          choice(
            seq(
              "let",
              field("pattern", $.union_pattern),
              "=",
              field("value", $.condition_expression),
            ),
            field("condition", $.condition_expression),
          ),
          field("consequence", prec.dynamic(10, $.block)),
          optional(
            seq("else", field("alternative", prec.dynamic(10, $.block))),
          ),
        ),
      ),

    union_pattern: ($) =>
      seq(
        ".",
        field("case", $.identifier),
        optional(seq("(", field("value", $.identifier), ")")),
      ),

    condition_expression: ($) =>
      choice(
        $.condition_binary_expression,
        $.condition_unary_expression,
        $.condition_call_expression,
        $.condition_field_expression,
        $.condition_index_expression,
        $.condition_parenthesized_expression,
        $.number,
        $.string,
        $.identifier,
        $.linear_reference,
        $.union_case,
      ),

    condition_binary_expression: ($) => {
      const table = [
        ["||", PREC.OR],
        ["&&", PREC.AND],
        [choice("==", "!="), PREC.EQUALITY],
        [choice("<", "<=", ">", ">="), PREC.COMPARE],
        [choice("+", "-"), PREC.ADD],
        [choice("*", "/", "%"), PREC.MULTIPLY],
      ];

      return choice(
        ...table.map(([operator, precedence]) =>
          prec.left(
            precedence,
            seq(
              field("left", $.condition_expression),
              field("operator", operator),
              field("right", $.condition_expression),
            ),
          )
        ),
      );
    },

    condition_unary_expression: ($) =>
      prec.right(
        PREC.UNARY,
        seq(
          field(
            "operator",
            choice("-", "!", "borrow", "freeze", "comptime"),
          ),
          field("operand", $.condition_expression),
        ),
      ),

    condition_call_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("function", $.condition_expression),
          field("arguments", $.condition_argument_list),
        ),
      ),

    condition_argument_list: ($) =>
      seq("(", optional(commaSep1($._expression)), ")"),

    condition_field_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("object", $.condition_expression),
          ".",
          field("field", $.identifier),
        ),
      ),

    condition_index_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("object", $.condition_expression),
          "[",
          field("index", $._expression),
          "]",
        ),
      ),

    condition_parenthesized_expression: ($) =>
      seq("(", $.condition_expression, ")"),

    binary_expression: ($) => {
      const table = [
        ["||", PREC.OR],
        ["&&", PREC.AND],
        [choice("==", "!="), PREC.EQUALITY],
        [choice("<", "<=", ">", ">="), PREC.COMPARE],
        [choice("+", "-"), PREC.ADD],
        [choice("*", "/", "%"), PREC.MULTIPLY],
      ];

      return choice(
        ...table.map(([operator, precedence]) =>
          prec.left(
            precedence,
            seq(
              field("left", $._expression),
              field("operator", operator),
              field("right", $._expression),
            ),
          )
        ),
      );
    },

    unary_expression: ($) =>
      prec.right(
        PREC.UNARY,
        seq(
          field(
            "operator",
            choice("-", "!", "borrow", "freeze", "comptime"),
          ),
          field("operand", $._expression),
        ),
      ),

    scratch_expression: ($) => seq("scratch", field("body", $.block)),

    call_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("function", $._expression),
          field("arguments", $.argument_list),
        ),
      ),

    argument_list: ($) => seq("(", optional(commaSep1($._expression)), ")"),

    field_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("object", $._expression),
          ".",
          field("field", $.identifier),
        ),
      ),

    index_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("object", $._expression),
          "[",
          field("index", $._expression),
          "]",
        ),
      ),

    struct_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("base", $._expression),
          field("fields", $.field_block),
        ),
      ),

    extension_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("base", $._expression),
          "with",
          field("fields", $.field_block),
        ),
      ),

    effect_handler_expression: ($) =>
      prec(
        PREC.POSTFIX + 1,
        seq(
          field("effect", $.identifier),
          field("clauses", $.handler_clause_block),
        ),
      ),

    handler_clause_block: ($) =>
      seq(
        "{",
        repeat(seq($.handler_operation_clause, optional(","))),
        $.handler_return_clause,
        optional(","),
        "}",
      ),

    handler_operation_clause: ($) =>
      seq(
        field("name", $.identifier),
        ":",
        field("value", $.arrow_function),
      ),

    handler_return_clause: ($) =>
      seq(
        "return",
        ":",
        field("value", $.arrow_function),
      ),

    _primary_expression: ($) =>
      choice(
        $.number,
        $.string,
        $.identifier,
        $.union_case,
        $.linear_reference,
        $.unit_pattern,
        $.struct_type,
        $.union_type,
        $.object_literal,
        $.scratch_expression,
        $.block,
        $.parenthesized_expression,
      ),

    union_case: ($) =>
      seq(
        ".",
        field("case", $.identifier),
        optional(seq("(", optional(field("value", $._expression)), ")")),
      ),

    linear_reference: ($) => seq("!", field("name", $.identifier)),

    struct_type: ($) => seq("struct", field("fields", $.type_field_block)),

    union_type: ($) => seq("union", field("cases", $.type_field_block)),

    object_literal: ($) => field("fields", $.field_block),

    field_block: ($) =>
      seq(
        "{",
        repeat(
          seq(choice($.field_definition, $.shorthand_field), optional(",")),
        ),
        "}",
      ),

    field_definition: ($) =>
      seq(field("name", $.identifier), ":", field("value", $._expression)),

    shorthand_field: ($) => field("name", $.identifier),

    type_field_block: ($) =>
      seq("{", repeat(seq($.type_field, optional(","))), "}"),

    type_field: ($) =>
      seq(
        field("name", $.identifier),
        ":",
        field("type", $.type_reference),
      ),

    type_pattern: ($) =>
      seq(
        field("kind", choice("struct", "union")),
        "{",
        repeat(
          seq(choice($.type_field, field("open", "..")), optional(",")),
        ),
        "}",
      ),

    block: ($) => seq("{", repeat($._statement), "}"),

    parenthesized_expression: ($) => seq("(", $._expression, ")"),

    type_reference: ($) => $.identifier,

    identifier: () => /[A-Za-z_][A-Za-z0-9_]*/,

    number: () => /[0-9]+(i32|i64)?/,

    string: () => /"([^"\\]|\\[ntr"\\])*"/,

    comment: () => token(seq("//", /.*/)),
  },
});

function commaSep1(rule) {
  return seq(rule, repeat(seq(",", rule)));
}
