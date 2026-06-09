import { SourceLocation } from "./types.js";

export type ErrorKind =
  | "E_BRANCH_RANGE"
  | "E_DIR_ALIGN_BOUNDARY"
  | "E_DIR_ALIGN_RANGE"
  | "E_DIR_EQU_LABEL"
  | "E_DIR_EQU_OPERAND"
  | "E_DIR_FILL_COUNT"
  | "E_DIR_FILL_RANGE"
  | "E_DIR_ORG_OPERAND"
  | "E_DIR_SET_LABEL"
  | "E_DIR_SET_OPERAND"
  | "E_DIR_TEXT_LITERAL"
  | "E_EXPRESSION_INVALID_OPERATOR"
  | "E_EXPRESSION_SYNTAX_ERROR"
  | "E_EXPRESSION_UNDEFINED_SYMBOL"
  | "E_EXPR_DIV_BY_ZERO"
  | "E_EXPR_EMPTY"
  | "E_EXPR_INVALID"
  | "E_EXPR_INVALID_TOKEN"
  | "E_EXPR_MISSING_RPAREN"
  | "E_EXPR_MOD_BY_ZERO"
  | "E_EXPR_STRING_ESCAPE"
  | "E_EXPR_STRING_LENGTH"
  | "E_EXPR_STRING_UNTERMINATED"
  | "E_EXPR_UNEXPECTED_TOKEN"
  | "E_EXPR_UNKNOWN_SYMBOL"
  | "E_IF_UNEXPECTED_ELSE"
  | "E_IF_UNEXPECTED_ELSEIF"
  | "E_IF_UNEXPECTED_END"
  | "E_IF_UNEXPECTED_ENDIF"
  | "E_IF_UNTERMINATED"
  | "E_INCLUDE_CIRCULAR"
  | "E_INCLUDE_CYCLE"
  | "E_INCLUDE_DEPTH"
  | "E_INCLUDE_FILE_NOT_FOUND"
  | "E_INCLUDE_OPERAND"
  | "E_INCLUDE_PATH"
  | "E_INCLUDE_READ"
  | "E_MACRO_INSTANTIATION_TOO_FEW_ARGS"
  | "E_MACRO_INSTANTIATION_TOO_MANY_ARGS"
  | "E_MACRO_INSTANTIATION_UNDEFINED_MACRO"
  | "E_MACRO_DEFINITION_NEEDS_NAME"
  | "E_MACRO_REDEFINITION"
  | "E_MACRO_UNEXPECTED_ENDMACRO"
  | "E_MACRO_UNTERMINATED"
  | "E_MODE_UNSUPPORTED"
  | "E_OPCODE_INVALID_ADDRESSING_MODE"
  | "E_OPCODE_OPERAND_OUT_OF_RANGE"
  | "E_OPCODE_OPERAND_SYNTAX_ERROR"
  | "E_OPCODE_UNKNOWN"
  | "E_OPERAND_MISSING"
  | "E_PREPROCESS"
  | "E_REPEAT_COUNT"
  | "E_REPEAT_NEGATIVE_COUNT"
  | "E_REPEAT_RANGE"
  | "E_REPEAT_UNEXPECTED_END"
  | "E_REPEAT_UNEXPECTED_ENDREPEAT"
  | "E_REPEAT_UNTERMINATED";

export class ErrorWithLocation extends Error {
  readonly code: ErrorKind;
  readonly location: SourceLocation;

  constructor(code: ErrorKind, message: string, location: SourceLocation) {
    super(message);
    this.code = code;
    this.location = location;
  }
}

export class PreprocessError extends ErrorWithLocation {
  constructor(code: ErrorKind, message: string, location: SourceLocation) {
    super(code, message, location);
    this.name = "PreprocessError";
  }
}

export class IncrementalPreprocessorError extends ErrorWithLocation {
  constructor(code: ErrorKind, message: string, location: SourceLocation) {
    super(code, message, location);
    this.name = "IncrementalPreprocessorError";
  }
}

export class AssemblerError extends ErrorWithLocation {
  constructor(code: ErrorKind, message: string, location: SourceLocation) {
    super(code, message, location);
    this.name = "AssemblerError";
  }
}
