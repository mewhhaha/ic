const PREC = {
  ARROW: 1,
  OR: 2,
  AND: 3,
  EQUALITY: 4,
  COMPARE: 5,
  ADD: 6,
  MULTIPLY: 7,
  UNARY: 8,
  APPLICATION: 9,
  POSTFIX: 10,
  EFFECT_UNION: 1,
  EFFECT_INTERSECTION: 2,
  EFFECT_DIFFERENCE: 3,
  TYPE_ARROW: 1,
  TYPE_UNION: 2,
  TYPE_INTERSECTION: 3,
  TYPE_DIFFERENCE: 4,
  TYPE_APPLICATION: 5,
};

module.exports = grammar({
  name: "ix",

  // Whitespace applications consume their own horizontal space with an
  // immediate token, so they cannot cross a newline even though newlines are
  // otherwise insignificant between statements.
  extras: ($) => [/\s/, ";", $.comment],

  externals: ($) => [$._application_space, $._type_application_space],

  word: ($) => $.identifier,

  conflicts: ($) => [
    [$.index_assignment, $._primary_expression],
    [$._primary_expression, $.linear_reference],
    [$.parameter],
    [$.parameter, $._primary_expression],
    [$.union_case],
    [$.field_block, $.block],
    [$.parameter, $._primary_expression, $.linear_reference],
    [$.parameter, $._primary_expression, $._type_atom],
    [$._primary_expression, $.borrow_type],
    [$.parameter, $.borrow_type],
    [$.atom_expression, $.atom_type],
    [$.top_type, $.wildcard],
    [$.condition_expression, $.linear_reference],
    [$._primary_expression, $.shorthand_field],
  ],

  rules: {
    source_file: ($) =>
      choice(
        seq(
          $.module_header,
          repeat($._module_statement),
          $.module_return_statement,
        ),
        repeat1($._module_statement),
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
        $.type_declaration_statement,
        $.module_binding_statement,
        $.effect_binding_statement,
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
        $.effect_binding_statement,
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
        field(
          "name",
          choice(
            $.identifier,
            $.wildcard,
            $.destructuring_pattern,
            $.array_pattern,
            $.positional_product_pattern,
            $.named_product_pattern,
          ),
        ),
        optional(seq(":", field("type", $.type_reference))),
        "=",
        field("value", $._expression),
      ),

    destructuring_pattern: ($) =>
      seq(
        "{",
        optional(
          commaSep1(field("name", choice($.identifier, $.wildcard))),
        ),
        "}",
      ),

    effect_row: ($) => $._effect_row_expression,

    _effect_row_expression: ($) =>
      choice(
        $.effect_union_expression,
        $.effect_intersection_expression,
        $.effect_difference_expression,
        $.parenthesized_effect_expression,
        $.effect_family_reference,
        $.effect_row_variable,
        $.effect_operation_reference,
      ),

    effect_union_expression: ($) =>
      prec.left(
        PREC.EFFECT_UNION,
        seq(
          field("left", $._effect_row_expression),
          "|",
          field("right", $._effect_row_expression),
        ),
      ),

    effect_intersection_expression: ($) =>
      prec.left(
        PREC.EFFECT_INTERSECTION,
        seq(
          field("left", $._effect_row_expression),
          "&",
          field("right", $._effect_row_expression),
        ),
      ),

    effect_difference_expression: ($) =>
      prec.left(
        PREC.EFFECT_DIFFERENCE,
        seq(
          field("left", $._effect_row_expression),
          "\\",
          field("right", $._effect_row_expression),
        ),
      ),

    parenthesized_effect_expression: ($) =>
      seq("(", field("value", $._effect_row_expression), ")"),

    effect_family_reference: ($) => field("effect", $.effect_identifier),

    effect_row_variable: ($) => field("name", $.row_variable),

    effect_operation_reference: ($) =>
      seq(
        field("effect", $.effect_identifier),
        ".",
        field("operation", $.identifier),
      ),

    effect_binding_statement: ($) =>
      seq(
        field("name", choice($.identifier, $.wildcard, $.unit_pattern)),
        "<-",
        field("value", $._expression),
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
        field("name", $.effect_identifier),
        field("operations", $.effect_operation_block),
      ),

    effect_statement: ($) =>
      seq(
        "effect",
        field("name", $.effect_identifier),
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

    type_declaration_statement: ($) =>
      seq(
        "type",
        field("name", $.identifier),
        repeat(field("parameter", $.identifier)),
        "=",
        field(
          "definition",
          choice($.type_sum, $.type_product, $.type_reference),
        ),
      ),

    type_sum: ($) =>
      seq(
        optional("|"),
        $.type_case,
        repeat(seq("|", $.type_case)),
      ),

    type_case: ($) =>
      seq(
        ".",
        field("name", $.identifier),
        optional(
          seq(
            "=",
            field("payload", alias($.type_intersection, $.type_reference)),
          ),
        ),
      ),

    type_product: ($) =>
      choice($.named_type_product, $.positional_type_product),

    named_type_product: ($) =>
      seq(
        "(",
        commaSep1($.named_type_field),
        ")",
      ),

    named_type_field: ($) =>
      seq(
        ".",
        field("name", $.identifier),
        "=",
        field("type", $.type_reference),
      ),

    positional_type_product: ($) => seq("(", commaSep2($.type_reference), ")"),

    module_binding_statement: ($) =>
      seq(
        "module",
        field("name", $.identifier),
        "=",
        field("value", $._expression),
      ),

    host_parameter_list: ($) =>
      seq("(", optional(commaSep1($.host_parameter)), ")"),

    host_parameter: ($) =>
      choice(
        seq(
          field(
            "contract",
            choice("&", "#", "scalar"),
          ),
          field("type", alias($.identifier, $.type_reference)),
        ),
        field("type", alias($.identifier, $.type_reference)),
      ),

    host_result: ($) =>
      choice(
        seq(
          field(
            "contract",
            choice("#", "scalar"),
          ),
          field("type", alias($.identifier, $.type_reference)),
        ),
        field("type", alias($.identifier, $.type_reference)),
      ),

    return_statement: ($) => seq("return", field("value", $._expression)),

    module_return_statement: ($) =>
      seq("return", field("exports", $.object_literal)),

    break_statement: ($) =>
      choice(
        "break",
        seq(
          "break",
          token.immediate(/[ \t]+/),
          field("value", $._expression),
        ),
      ),

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
      choice(
        seq(
          "for",
          field("first", choice($.identifier, $.wildcard)),
          optional(seq(",", field("second", choice($.identifier, $.wildcard)))),
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
        seq(
          "for",
          field("start", $.condition_expression),
          "..",
          field("end", $.condition_expression),
          optional(seq("by", field("step", $.condition_expression))),
          field("body", prec.dynamic(10, $.block)),
        ),
      ),

    expression_statement: ($) => $._expression,

    _expression: ($) =>
      choice(
        $.try_with_expression,
        $.loop_expression,
        $.arrow_function,
        $.recursive_function,
        $.recursive_call_expression,
        $.if_expression,
        $.match_expression,
        $.binary_expression,
        $.is_expression,
        $.as_expression,
        $.unary_expression,
        $.application_expression,
        $.postfix_expression,
        $.effect_handler_expression,
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
          field(
            "parameters",
            choice($.identifier, $.wildcard, $.parameter_list),
          ),
          "=>",
          field("body", $._expression),
        ),
      ),

    recursive_call_expression: ($) =>
      prec.left(
        PREC.APPLICATION,
        seq("rec", field("argument", $.positional_product)),
      ),

    parameter_list: ($) => seq("(", optional(commaSep1($.parameter)), ")"),

    parameter: ($) =>
      seq(
        optional("const"),
        optional("!"),
        field("name", choice($.identifier, $.wildcard)),
        optional(seq(":", field("type", $.type_reference))),
      ),

    if_expression: ($) =>
      prec.right(
        seq(
          "if",
          choice(
            ifLetCondition($),
            seq("(", ifLetCondition($), ")"),
            field("condition", $.condition_expression),
          ),
          field("consequence", prec.dynamic(10, $.block)),
          optional(
            seq(
              "else",
              field(
                "alternative",
                choice(
                  prec.dynamic(10, $.block),
                  prec.dynamic(10, $.if_expression),
                ),
              ),
            ),
          ),
        ),
      ),

    union_pattern: ($) =>
      seq(
        ".",
        field("case", $.identifier),
        optional(
          seq("(", field("value", choice($.identifier, $.wildcard)), ")"),
        ),
      ),

    condition_expression: ($) =>
      choice(
        $.condition_binary_expression,
        $.condition_is_expression,
        $.condition_unary_expression,
        $.condition_call_expression,
        $.condition_field_expression,
        $.condition_index_expression,
        $.condition_parenthesized_expression,
        $.number,
        $.string,
        $.character,
        $.boolean,
        $.atom_expression,
        alias("loop", $.identifier),
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

    condition_is_expression: ($) =>
      prec.left(
        PREC.COMPARE,
        seq(
          field("value", $.condition_expression),
          field("operator", "is"),
          field("type", $.type_reference),
        ),
      ),

    condition_unary_expression: ($) =>
      prec.right(
        PREC.UNARY,
        seq(
          field(
            "operator",
            choice("-", "!", "&", "freeze", "comptime"),
          ),
          field("operand", $.condition_expression),
        ),
      ),

    condition_call_expression: ($) =>
      prec.left(
        PREC.APPLICATION,
        seq(
          field("function", $.condition_expression),
          field("argument", $.positional_product),
        ),
      ),

    condition_field_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        choice(
          seq(
            field("object", $.condition_expression),
            ".",
            field("field", $.identifier),
          ),
          seq(
            field("object", alias($.effect_identifier, $.identifier)),
            ".",
            field("field", $.identifier),
          ),
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

    is_expression: ($) =>
      prec.left(
        PREC.COMPARE,
        seq(
          field("value", $._expression),
          field("operator", "is"),
          field("type", $.type_reference),
        ),
      ),

    as_expression: ($) =>
      prec.left(
        PREC.POSTFIX + 1,
        seq(
          field("value", $._expression),
          $.as_keyword,
          field("type", $.type_reference),
        ),
      ),

    unary_expression: ($) =>
      prec.right(
        PREC.UNARY,
        seq(
          field(
            "operator",
            choice("-", "!", "&", "freeze", "comptime"),
          ),
          field("operand", $._expression),
        ),
      ),

    scratch_expression: ($) => seq("scratch", field("body", $.block)),

    loop_expression: ($) =>
      prec(PREC.APPLICATION + 1, seq("loop", field("body", $.block))),

    match_expression: ($) =>
      prec.right(
        seq(
          "match",
          field("target", $.condition_expression),
          field("cases", $.match_case_block),
        ),
      ),

    match_case_block: ($) =>
      seq(
        "{",
        $.match_case,
        repeat(seq(optional(","), $.match_case)),
        optional(","),
        "}",
      ),

    match_case: ($) =>
      seq(
        "|",
        field("pattern", $._match_pattern),
        optional(seq("if", field("guard", $.condition_expression))),
        "=>",
        field("body", $._expression),
      ),

    _match_pattern: ($) =>
      choice(
        $.union_pattern,
        $.number,
        $.string,
        $.character,
        $.boolean,
        $.identifier,
        $.wildcard,
        $.array_pattern,
        $.positional_product_pattern,
        $.named_product_pattern,
      ),

    application_expression: ($) =>
      prec.left(
        PREC.APPLICATION,
        choice(
          seq(
            field(
              "function",
              choice($.application_expression, $.postfix_expression),
            ),
            $._application_space,
            field("argument", $.postfix_expression),
          ),
          seq(
            field(
              "function",
              choice($.application_expression, $.postfix_expression),
            ),
            field("argument", $.parenthesized_or_product),
          ),
        ),
      ),

    postfix_expression: ($) =>
      choice(
        $.field_expression,
        $.index_expression,
        $.update_expression,
        $._primary_expression,
      ),

    field_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        choice(
          seq(
            field("object", $.postfix_expression),
            ".",
            field("field", $.identifier),
          ),
          seq(
            field("object", alias($.effect_identifier, $.identifier)),
            ".",
            field("field", $.identifier),
          ),
        ),
      ),

    index_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("object", $.postfix_expression),
          "[",
          field("index", $._expression),
          "]",
        ),
      ),

    struct_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("base", $.postfix_expression),
          field("fields", $.field_block),
        ),
      ),

    update_expression: ($) =>
      prec.left(
        PREC.POSTFIX,
        seq(
          field("value", $.postfix_expression),
          $.with_keyword,
          field("updates", $.field_block),
        ),
      ),

    effect_handler_expression: ($) =>
      prec.dynamic(
        20,
        prec(
          PREC.POSTFIX + 1,
          seq(
            field("effect", $.effect_identifier),
            field("clauses", $.handler_clause_block),
          ),
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
        $.character,
        $.boolean,
        alias("loop", $.identifier),
        $.identifier,
        $.atom_expression,
        $.import_expression,
        $.named_product,
        $.positional_product,
        $.union_case,
        $.linear_reference,
        $.unit_pattern,
        $.struct_type,
        $.union_type,
        $.array_expression,
        $.array_repeat_expression,
        $.object_literal,
        $.scratch_expression,
        $.block,
        $.parenthesized_expression,
      ),

    union_case: ($) =>
      prec(
        -1,
        seq(
          ".",
          field("case", $.identifier),
          optional(seq("(", optional(field("value", $._expression)), ")")),
        ),
      ),

    linear_reference: ($) => seq("!", field("name", $.identifier)),

    atom_expression: ($) =>
      seq(
        "#",
        field("name", alias($.row_variable, $.identifier)),
      ),

    import_expression: ($) => seq("import", field("path", $.string)),

    struct_type: ($) => seq("struct", field("fields", $.type_field_block)),

    union_type: ($) => seq("union", field("cases", $.type_field_block)),

    named_product: ($) => prec(1, seq("(", commaSep1($.product_field), ")")),

    product_field: ($) =>
      seq(
        $._named_product_dot,
        field("name", $.identifier),
        "=",
        field("value", $._expression),
      ),

    positional_product: ($) => seq("(", commaSep2($._expression), ")"),

    parenthesized_or_product: ($) =>
      choice(
        $.unit_pattern,
        $.named_product,
        $.positional_product,
        $.parenthesized_expression,
      ),

    array_expression: ($) => seq("[", optional(commaSep1($._expression)), "]"),

    array_repeat_expression: ($) =>
      seq(
        "[",
        field("value", $._expression),
        ";",
        field("length", $._expression),
        "]",
      ),

    array_pattern: ($) =>
      seq("[", optional(commaSep1($._array_pattern_element)), "]"),

    _array_pattern_element: ($) =>
      choice(
        $.identifier,
        $.wildcard,
        $.union_pattern,
        $.array_pattern,
        $.positional_product_pattern,
        $.named_product_pattern,
        $.array_rest_pattern,
      ),

    array_rest_pattern: ($) =>
      seq("...", field("name", choice($.identifier, $.wildcard))),

    positional_product_pattern: ($) =>
      seq("(", commaSep2($._match_pattern), ")"),

    named_product_pattern: ($) =>
      seq("(", commaSep1($.named_product_pattern_field), ")"),

    named_product_pattern_field: ($) =>
      seq(
        $._named_product_dot,
        field("name", $.identifier),
        "=",
        field("pattern", $._match_pattern),
      ),

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
        field("type", alias($.identifier, $.type_reference)),
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

    // Surface types use whitespace application (`List a`) and right
    // associative arrows (`a -> b`).  Keep the existing type_reference node
    // as the wrapper so simple annotations retain their old tree shape.
    type_reference: ($) => $._type_expression,

    _type_expression: ($) => choice($.function_type, $.type_union),

    function_type: ($) =>
      prec.right(
        PREC.TYPE_ARROW,
        seq(
          field("parameter", $.type_union),
          "->",
          optional(field("effects", $.latent_effect_row)),
          field("result", $._type_expression),
        ),
      ),

    type_union: ($) =>
      prec.left(
        PREC.TYPE_UNION,
        choice(
          $.type_intersection,
          seq(
            field("left", $.type_union),
            "|",
            field("right", $.type_intersection),
          ),
        ),
      ),

    type_intersection: ($) =>
      prec.left(
        PREC.TYPE_INTERSECTION,
        choice(
          $.type_difference,
          seq(
            field("left", $.type_intersection),
            "&",
            field("right", $.type_difference),
          ),
        ),
      ),

    type_difference: ($) =>
      prec.left(
        PREC.TYPE_DIFFERENCE,
        choice(
          $._type_application,
          seq(
            field("left", $.type_difference),
            "\\",
            field("right", $._type_application),
          ),
        ),
      ),

    latent_effect_row: ($) => seq("<", field("row", $.effect_row), ">"),

    _type_application: ($) => choice($.type_application, $._type_prefix),

    type_application: ($) =>
      prec.left(
        PREC.TYPE_APPLICATION,
        seq(
          field("constructor", choice($.type_application, $._type_prefix)),
          $._type_application_space,
          field("argument", $._type_prefix),
        ),
      ),

    _type_prefix: ($) =>
      choice($.atom_type, $.frozen_type, $.borrow_type, $._type_atom),

    atom_type: ($) =>
      seq(
        "#",
        field("name", alias($.row_variable, $.identifier)),
      ),

    frozen_type: ($) =>
      seq(
        "#",
        choice(
          field("name", alias($.effect_identifier, $.identifier)),
          $.type_parenthesized,
        ),
      ),

    borrow_type: ($) => seq("&", choice($.identifier, $.type_parenthesized)),

    _type_atom: ($) =>
      prec(
        -1,
        choice(
          alias($.effect_identifier, $.identifier),
          $.identifier,
          $.top_type,
          $.never_type,
          $.unit_type,
          $.type_parenthesized,
          $.type_product,
          $.array_type,
        ),
      ),

    unit_type: () => prec(-1, seq("(", ")")),

    top_type: () => "_",

    never_type: () => token(prec(2, "Never")),

    array_type: ($) =>
      seq(
        "[",
        field("element", $._type_expression),
        ";",
        field("length", choice($.number, $.wildcard)),
        "]",
      ),

    type_parenthesized: ($) =>
      seq("(", field("value", $._type_expression), ")"),

    wildcard: () => "_",

    _named_product_dot: () => token(prec(1, ".")),

    as_keyword: () => token(prec(1, "as")),

    with_keyword: () => token(prec(1, "with")),

    identifier: () => token(/[A-Za-z][A-Za-z0-9_]*/),

    effect_identifier: () => token(prec(1, /[A-Z][A-Za-z0-9]*/)),

    row_variable: () => /[a-z_][A-Za-z0-9_]*/,

    number: () => /[0-9]+(i32|i64)?/,

    string: () => /"([^"\\]|\\[ntr"\\])*"/,

    character: () => /'([^'\\\n\r]|\\[ntr'\\])'/,

    boolean: () => choice("true", "false"),

    comment: () => token(seq("//", /.*/)),
  },
});

function commaSep1(rule) {
  return seq(rule, repeat(seq(",", rule)));
}

function commaSep2(rule) {
  return seq(rule, ",", commaSep1(rule));
}

function ifLetCondition($) {
  return seq(
    "let",
    field(
      "pattern",
      choice(
        $.union_pattern,
        $.number,
        $.string,
        $.character,
        $.boolean,
      ),
    ),
    "=",
    field("value", $.condition_expression),
  );
}
