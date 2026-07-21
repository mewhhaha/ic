#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

enum TokenType {
  APPLICATION_SPACE,
  TYPE_APPLICATION_SPACE,
  BREAK_VALUE_SPACE,
  BREAK_TERMINATOR_SPACE,
  EXTENSION_MEMBER_TERMINATOR,
};

void *tree_sitter_duck_external_scanner_create(void) {
  return NULL;
}

void tree_sitter_duck_external_scanner_destroy(void *payload) {
  (void)payload;
}

unsigned tree_sitter_duck_external_scanner_serialize(
  void *payload,
  char *buffer
) {
  (void)payload;
  (void)buffer;
  return 0;
}

void tree_sitter_duck_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  (void)payload;
  (void)buffer;
  (void)length;
}

static bool starts_application_argument(int32_t character) {
  if (
    (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') ||
    (character >= '0' && character <= '9')
  ) {
    return true;
  }

  switch (character) {
    case '_':
    case '"':
    case '\'':
    case '(':
    case '[':
    case '{':
    case '!':
    case '#':
      return true;
    default:
      return false;
  }
}

static bool application_stop_keyword(TSLexer *lexer) {
  char word[8] = {0};
  unsigned length = 0;

  while (
    length < sizeof(word) - 1 &&
    ((lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
      (lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
      lexer->lookahead == '_')
  ) {
    word[length] = (char)lexer->lookahead;
    length += 1;
    lexer->advance(lexer, false);
  }

  if (
    (lexer->lookahead >= '0' && lexer->lookahead <= '9') ||
    (lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
    (lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
    lexer->lookahead == '_'
  ) {
    return false;
  }

  return strcmp(word, "as") == 0 || strcmp(word, "by") == 0 ||
    strcmp(word, "else") == 0 || strcmp(word, "if") == 0 ||
    strcmp(word, "in") == 0 || strcmp(word, "is") == 0 ||
    strcmp(word, "where") == 0 || strcmp(word, "with") == 0;
}

static bool starts_type_argument(int32_t character) {
  return (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') || character == '_' ||
    character == '#' || character == '&' || character == '(' ||
    character == '[';
}

bool tree_sitter_duck_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid_symbols
) {
  (void)payload;

  if (
    valid_symbols[BREAK_TERMINATOR_SPACE] &&
    (lexer->lookahead == '\n' || lexer->lookahead == '\r')
  ) {
    lexer->advance(lexer, true);
    lexer->mark_end(lexer);
    lexer->result_symbol = BREAK_TERMINATOR_SPACE;
    return true;
  }

  if (
    valid_symbols[EXTENSION_MEMBER_TERMINATOR] &&
    (lexer->lookahead == '\n' || lexer->lookahead == '\r')
  ) {
    lexer->advance(lexer, true);
    lexer->mark_end(lexer);
    lexer->result_symbol = EXTENSION_MEMBER_TERMINATOR;
    return true;
  }

  if (
    !valid_symbols[APPLICATION_SPACE] &&
    !valid_symbols[TYPE_APPLICATION_SPACE] &&
    !valid_symbols[BREAK_VALUE_SPACE] &&
    !valid_symbols[BREAK_TERMINATOR_SPACE] &&
    !valid_symbols[EXTENSION_MEMBER_TERMINATOR]
  ) {
    return false;
  }

  if (lexer->lookahead != ' ' && lexer->lookahead != '\t') {
    return false;
  }

  do {
    lexer->advance(lexer, true);
  } while (lexer->lookahead == ' ' || lexer->lookahead == '\t');

  lexer->mark_end(lexer);

  if (
    valid_symbols[BREAK_TERMINATOR_SPACE] &&
    (lexer->lookahead == 0 || lexer->lookahead == '\n' ||
      lexer->lookahead == '\r' || lexer->lookahead == ';' ||
      lexer->lookahead == '}')
  ) {
    lexer->result_symbol = BREAK_TERMINATOR_SPACE;
    return true;
  }

  if (
    valid_symbols[BREAK_VALUE_SPACE] && lexer->lookahead != 0 &&
    lexer->lookahead != '\n' && lexer->lookahead != '\r' &&
    lexer->lookahead != ';' && lexer->lookahead != '}'
  ) {
    lexer->result_symbol = BREAK_VALUE_SPACE;
    return true;
  }

  if (
    valid_symbols[TYPE_APPLICATION_SPACE] &&
    starts_type_argument(lexer->lookahead)
  ) {
    lexer->result_symbol = TYPE_APPLICATION_SPACE;
    return true;
  }

  if (!valid_symbols[APPLICATION_SPACE]) {
    return false;
  }

  if (!starts_application_argument(lexer->lookahead)) {
    return false;
  }

  if (lexer->lookahead == '!') {
    lexer->advance(lexer, false);
    if (
      !((lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
        (lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
        lexer->lookahead == '_')
    ) {
      return false;
    }
  }

  if (
    ((lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
      (lexer->lookahead >= 'a' && lexer->lookahead <= 'z')) &&
    application_stop_keyword(lexer)
  ) {
    return false;
  }

  lexer->result_symbol = APPLICATION_SPACE;
  return true;
}
