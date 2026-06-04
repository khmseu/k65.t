/**
 * Centralized directive registry for the 6502 assembler.
 * This file defines all supported directives, their metadata, and validation functions.
 * Replaces scattered directive handling across preprocessor.ts and assembler.ts.
 */

export interface DirectiveMetadata {
  /** The canonical name of the directive (uppercase with dot prefix, e.g., ".IF") */
  readonly name: string;

  /** Alternative names/aliases for the same directive (e.g., [".SET", "="] for assignment) */
  //   readonly aliases?: readonly string[];

  /**
   * Execution phase:
   * - "preprocessing": Handled before assembly (e.g., .INCLUDE, .MACRO collection)
   * - "assembly": Handled during assembly passes (e.g., .ORG, .BYTE, .EQU)
   * - "both": Can appear at either phase with different semantics (e.g., .IF)
   */
  readonly phase: "preprocessing" | "assembly" | "both";

  /** Functional category */
  readonly category:
    | "structural" // .INCLUDE, .MACRO/.ENDMACRO - defines scope/structure
    | "state-control" // .IF/.ENDIF, .REPEAT/.ENDREPEAT - controls flow
    | "assignment" // .EQU, .SET, = - define constants
    | "data-emission" // .BYTE, .WORD, .TEXT, .FILL, .ALIGN - emit bytes
    | "metadata" // .TITLE, .SUBTTL, .PAGE, .LIST, etc - listing metadata
    | "origin"; // .ORG - set program origin

  /** Expected operand count: number, "variadic" (any), or range like "0-1" or "1-2" */
  readonly operandCount?: number | "variadic" | "0-1" | "1-2";

  /** User-friendly description */
  readonly description: string;
}

/**
 * Central directive table: canonical source for all directive definitions.
 * Each entry maps the canonical directive name to its metadata.
 * Aliases are registered separately via getDirectiveByAlias().
 */
export const DIRECTIVE_TABLE: Record<string, DirectiveMetadata> = {
  // Structural directives (preprocessing)
  ".INCLUDE": {
    name: ".INCLUDE",
    phase: "preprocessing",
    category: "structural",
    operandCount: 1,
    description: "Include external assembly file",
  },

  ".MACRO": {
    name: ".MACRO",
    phase: "preprocessing",
    category: "structural",
    operandCount: "variadic",
    description: "Begin macro definition with optional parameters",
  },

  ".ENDMACRO": {
    name: ".ENDMACRO",
    phase: "preprocessing",
    category: "structural",
    operandCount: 0,
    description: "End macro definition",
  },

  // State control directives (both phases, but main handling in assembly loop)
  ".IF": {
    name: ".IF",
    phase: "both",
    category: "state-control",
    operandCount: 1,
    description: "Begin conditional assembly block (true branch)",
  },

  ".ELSEIF": {
    name: ".ELSEIF",
    phase: "both",
    category: "state-control",
    operandCount: 1,
    description: "Else-if branch in conditional assembly",
  },

  ".ELSE": {
    name: ".ELSE",
    phase: "both",
    category: "state-control",
    operandCount: 0,
    description: "Else branch in conditional assembly",
  },

  ".ENDIF": {
    name: ".ENDIF",
    phase: "both",
    category: "state-control",
    operandCount: 0,
    description: "End conditional assembly block",
  },

  ".REPEAT": {
    name: ".REPEAT",
    phase: "both",
    category: "state-control",
    operandCount: 1,
    description: "Begin repeat block (execute N times)",
  },

  ".ENDREPEAT": {
    name: ".ENDREPEAT",
    phase: "both",
    category: "state-control",
    operandCount: 0,
    description: "End repeat block",
  },

  // Assembly directives (origin)
  ".ORG": {
    name: ".ORG",
    phase: "assembly",
    category: "origin",
    operandCount: 1,
    description: "Set program origin (address counter)",
  },

  // Assembly directives (assignment/constants)
  ".EQU": {
    name: ".EQU",
    // aliases: [".SET", "="],
    phase: "assembly",
    category: "assignment",
    operandCount: 1,
    description: "Define constant (label = value)",
  },

  ".SET": {
    name: ".SET",
    // aliases: ["="],
    phase: "assembly",
    category: "assignment",
    operandCount: 1,
    description: "Define reassignable constant (label .set value)",
  },

  "=": {
    name: ".SET",
    // aliases: ["="],
    phase: "assembly",
    category: "assignment",
    operandCount: 1,
    description: "Define reassignable constant (label .set value)",
  },

  // Note: "=" is handled as alias of .SET, not a separate entry

  // Assembly directives (data emission)
  ".BYTE": {
    name: ".BYTE",
    phase: "assembly",
    category: "data-emission",
    operandCount: "variadic",
    description: "Emit byte(s) (one value per byte)",
  },

  ".WORD": {
    name: ".WORD",
    phase: "assembly",
    category: "data-emission",
    operandCount: "variadic",
    description: "Emit 16-bit word(s) (little-endian)",
  },

  ".TEXT": {
    name: ".TEXT",
    phase: "assembly",
    category: "data-emission",
    operandCount: "variadic",
    description: "Emit text or character codes",
  },

  ".FILL": {
    name: ".FILL",
    phase: "assembly",
    category: "data-emission",
    operandCount: "1-2",
    description: "Fill memory (count [, value])",
  },

  ".ALIGN": {
    name: ".ALIGN",
    phase: "assembly",
    category: "data-emission",
    operandCount: "1-2",
    description: "Align to boundary (boundary [, fill_value])",
  },

  // Assembly directives (metadata for listing)
  ".TITLE": {
    name: ".TITLE",
    phase: "assembly",
    category: "metadata",
    operandCount: "variadic",
    description: "Set page title for listing",
  },

  ".SUBTTL": {
    name: ".SUBTTL",
    phase: "assembly",
    category: "metadata",
    operandCount: "variadic",
    description: "Set subtitle for listing page",
  },

  ".PAGE": {
    name: ".PAGE",
    // aliases: [".EJECT"],
    phase: "assembly",
    category: "metadata",
    operandCount: 0,
    description: "Emit page break in listing",
  },

  ".EJECT": {
    name: ".EJECT",
    phase: "assembly",
    category: "metadata",
    operandCount: 0,
    description: "Emit page break in listing (synonym for .PAGE)",
  },

  ".LIST": {
    name: ".LIST",
    phase: "assembly",
    category: "metadata",
    operandCount: 0,
    description: "Enable listing output",
  },

  ".NOLIST": {
    name: ".NOLIST",
    phase: "assembly",
    category: "metadata",
    operandCount: 0,
    description: "Disable listing output",
  },

  ".PAGESIZE": {
    name: ".PAGESIZE",
    phase: "assembly",
    category: "metadata",
    operandCount: 1,
    description: "Set lines per page in listing",
  },

  ".BYTESPERLINE": {
    name: ".BYTESPERLINE",
    phase: "assembly",
    category: "metadata",
    operandCount: 1,
    description: "Set bytes per line in listing output",
  },
};

/**
 * Check if a token is a known directive (by name or alias).
 * @param token - The token to check (case-insensitive)
 * @returns true if the token is a valid directive
 */
export function isDirective(token: string | undefined): boolean {
  if (!token) return false;
  const upper = token.toUpperCase();
  return DIRECTIVE_TABLE[upper] !== undefined;
}

/**
 * Get the canonical directive metadata by name or alias.
 * @param token - The directive name or alias (case-insensitive)
 * @returns The DirectiveMetadata if found, undefined otherwise
 */
export function getDirectiveMetadata(
  token: string | undefined,
): DirectiveMetadata | undefined {
  if (!token) return undefined;
  const upper = token.toUpperCase();
  return DIRECTIVE_TABLE[upper];
}

/**
 * Check if a directive is handled in the preprocessing phase.
 * @param token - The directive name or alias (case-insensitive)
 * @returns true if the directive is handled in preprocessing
 */
export function isPreprocessingDirective(token: string | undefined): boolean {
  const meta = getDirectiveMetadata(token);
  return meta ? meta.phase === "preprocessing" || meta.phase === "both" : false;
}

/**
 * Check if a directive is handled in the assembly phase.
 * @param token - The directive name or alias (case-insensitive)
 * @returns true if the directive is handled during assembly
 */
export function isAssemblyDirective(token: string | undefined): boolean {
  const meta = getDirectiveMetadata(token);
  return meta ? meta.phase === "assembly" || meta.phase === "both" : false;
}

/**
 * Check if a directive is a state-control directive (affects control flow).
 * @param token - The directive name or alias (case-insensitive)
 * @returns true if the directive controls program flow (.if, .repeat, etc)
 */
export function isStateControlDirective(token: string | undefined): boolean {
  const meta = getDirectiveMetadata(token);
  return meta ? meta.category === "state-control" : false;
}

/**
 * Check if a directive is a structural directive (scope-related).
 * @param token - The directive name or alias (case-insensitive)
 * @returns true if the directive defines structural scope (.macro, .include)
 */
export function isStructuralDirective(token: string | undefined): boolean {
  const meta = getDirectiveMetadata(token);
  return meta ? meta.category === "structural" : false;
}

/**
 * Get list of all directive names in canonical form.
 */
export function getAllDirectiveNames(): string[] {
  return Object.keys(DIRECTIVE_TABLE);
}
