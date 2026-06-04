import { dirname, isAbsolute, join, resolve } from "node:path";

import { evaluateExpressionDetailed } from "./expressions.js";
import { parseLine, parseSource } from "./parser.js";
import { readFileSync } from "node:fs";

const MAX_EXPANSION_DEPTH = 25;
const MAX_INCLUDE_DEPTH = 32;

/**
 * Preprocessor: Minimal structural preprocessing before main assembly.
 *
 * Role (after Phase 5 refactoring):
 * - Structural composition: .INCLUDE recursion and file inclusion
 * - Macro management: Collect .MACRO definitions for later expansion
 * - Repetition expansion: Expand .REPEAT blocks (multi-pass sizing consideration)
 * - Constant collection: Extract numeric constants for .REPEAT count evaluation
 *
 * NOT handled here (moved to main assembly loop via DirectiveStack):
 * - Conditional branch selection (.IF/.ELSEIF/.ELSE/.ENDIF)
 *   These are now evaluated with live symbol table during sizing/emission
 *
 * This separation enables cleaner control flow and better symbol resolution.
 */

interface MacroDefinition {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly body: readonly string[];
}

export interface PreprocessOptions {
  readonly sourcePath?: string;
  readonly currentDir?: string;
  readonly readFile?: (filePath: string) => string;
}

export class PreprocessError extends Error {
  readonly code: string;
  readonly lineNumber: number;
  readonly source: string;

  constructor(
    code: string,
    message: string,
    lineNumber: number,
    source: string,
  ) {
    super(message);
    this.name = "PreprocessError";
    this.code = code;
    this.lineNumber = lineNumber;
    this.source = source;
  }
}

export function preprocessSource(
  text: string,
  options: PreprocessOptions = {},
): string {
  const sourcePath = options.sourcePath;
  const currentDir =
    options.currentDir ??
    (sourcePath === undefined ? process.cwd() : dirname(sourcePath));
  const readFile =
    options.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
  const macros = new Map<string, MacroDefinition>();

  // First pass: collect constants from the entire source
  // This allows .if directives to reference symbols defined anywhere in the file
  const constants = collectConstants(text.split(/\r?\n/));

  const output = preprocessLines(
    text.split(/\r?\n/),
    {
      currentDir,
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      includeStack: sourcePath === undefined ? [] : [resolve(sourcePath)],
      readFile,
      includeDepth: 0,
    },
    macros,
    constants,
  );

  return output.join("\n");
}

interface IncludeContext {
  readonly currentDir: string;
  readonly sourcePath?: string;
  readonly includeStack: readonly string[];
  readonly readFile: (filePath: string) => string;
  readonly includeDepth: number;
}

/**
 * First pass: collect numeric constants from the source.
 *
 * Extracts only numeric literals (not complex expressions) to avoid dependency
 * ordering issues. These constants are used for:
 * - .REPEAT count evaluation (needs to happen at preprocess time)
 * - Forward symbol resolution in expressions
 *
 * Note: .IF condition evaluation has moved to the main assembly loop,
 * so constants here are primarily for .REPEAT expansion.
 */
function collectConstants(lines: readonly string[]): Map<string, number> {
  const constants = new Map<string, number>();

  for (const line of lines) {
    const parsed = parseSource(line)[0];
    if (!parsed || parsed.kind !== "code") {
      continue;
    }

    const mnemonic = parsed.mnemonic?.toUpperCase();

    // Pattern 1: Simple assignment "VAR = VALUE" (parser treats as label = operand)
    // Extract numeric values only to avoid dependency ordering issues
    if (mnemonic === "=" && parsed.label) {
      const operand = parsed.operands[0];
      if (operand !== undefined) {
        // Try to parse as numeric literal
        const numValue = parseInt(operand, 10);
        if (!isNaN(numValue) && operand === numValue.toString()) {
          constants.set(parsed.label.toUpperCase(), numValue);
        }
      }
      continue;
    }

    // Also handle plain assignment without label when parser doesn't recognize =
    if (!mnemonic) {
      const assignmentMatch = line.match(
        /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([+-]?\d+)\s*$/,
      );
      if (assignmentMatch) {
        const constName = assignmentMatch[1]!.toUpperCase();
        const constValue = parseInt(assignmentMatch[2]!, 10);
        constants.set(constName, constValue);
      }
      continue;
    }

    // Pattern 2: EQU directive "VAR .equ VALUE" (numeric only)
    if (mnemonic === ".EQU") {
      if (parsed.label) {
        const operand = parsed.operands[0];
        if (operand !== undefined) {
          const numValue = parseInt(operand, 10);
          if (!isNaN(numValue) && operand === numValue.toString()) {
            constants.set(parsed.label.toUpperCase(), numValue);
          }
        }
      }
      continue;
    }

    // Pattern 3: SET directive "VAR .set VALUE" (numeric only)
    if (mnemonic === ".SET") {
      if (parsed.label) {
        const operand = parsed.operands[0];
        if (operand !== undefined) {
          const numValue = parseInt(operand, 10);
          if (!isNaN(numValue) && operand === numValue.toString()) {
            constants.set(parsed.label.toUpperCase(), numValue);
          }
        }
      }
      continue;
    }
  }

  return constants;
}

/**
 * Recursive line processing: structural composition and macro/repeat expansion.
 *
 * Handles:
 * - .INCLUDE: Recursively includes and preprocesses external files
 * - .MACRO / .ENDMACRO: Collects macro definitions for later expansion
 * - .REPEAT / .ENDREPEAT: Expands repetition blocks (needed for multi-pass sizing)
 * - .IF / .ELSEIF / .ELSE / .ENDIF: Passes through unchanged (handled in main loop)
 * - Macro expansion: Substitutes macro invocations with body
 */
function preprocessLines(
  lines: readonly string[],
  context: IncludeContext,
  macros: Map<string, MacroDefinition>,
  constants: Map<string, number> = new Map(),
  startLineNumber: number = 1,
): string[] {
  const output: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineNumber = startLineNumber + i;
    const parsed = parseLine(line, lineNumber);
    const mnemonic = parsed.mnemonic?.toUpperCase();

    if (parsed.kind === "code" && mnemonic === ".INCLUDE") {
      const includeOperand = parsed.operands[0];
      if (includeOperand === undefined) {
        throw new PreprocessError(
          "E_INCLUDE_OPERAND",
          ".include requires a quoted file path",
          parsed.lineNumber,
          parsed.raw,
        );
      }

      const includePath = parseIncludePath(includeOperand);
      if (includePath === null) {
        throw new PreprocessError(
          "E_INCLUDE_PATH",
          `.include path must be a quoted string: ${includeOperand}`,
          parsed.lineNumber,
          parsed.raw,
        );
      }

      if (context.includeDepth >= MAX_INCLUDE_DEPTH) {
        throw new PreprocessError(
          "E_INCLUDE_DEPTH",
          "Maximum include depth exceeded",
          parsed.lineNumber,
          parsed.raw,
        );
      }

      const resolvedPath = isAbsolute(includePath)
        ? resolve(includePath)
        : resolve(join(context.currentDir, includePath));
      if (context.includeStack.includes(resolvedPath)) {
        throw new PreprocessError(
          "E_INCLUDE_CYCLE",
          `Circular include detected for ${resolvedPath}`,
          parsed.lineNumber,
          parsed.raw,
        );
      }

      let includedText: string;
      try {
        includedText = context.readFile(resolvedPath);
      } catch {
        throw new PreprocessError(
          "E_INCLUDE_READ",
          `Unable to read include file: ${resolvedPath}`,
          parsed.lineNumber,
          parsed.raw,
        );
      }

      const includedLines = preprocessLines(
        includedText.split(/\r?\n/),
        {
          currentDir: dirname(resolvedPath),
          sourcePath: resolvedPath,
          includeStack: [...context.includeStack, resolvedPath],
          readFile: context.readFile,
          includeDepth: context.includeDepth + 1,
        },
        macros,
        constants,
      );
      output.push(...includedLines);
      continue;
    }

    if (parsed.kind === "code" && mnemonic === ".MACRO") {
      const name = parsed.operands[0]?.trim();
      if (!name) {
        throw new PreprocessError(
          "E_MACRO_NAME",
          `Missing macro name on line ${parsed.lineNumber}`,
          parsed.lineNumber,
          parsed.raw,
        );
      }

      const body: string[] = [];
      let foundEnd = false;

      for (i += 1; i < lines.length; i += 1) {
        const bodyLine = lines[i]!;
        const bodyLineNumber = startLineNumber + i;
        const bodyParsed = parseLine(bodyLine, bodyLineNumber);
        if (
          bodyParsed.kind === "code" &&
          bodyParsed.mnemonic?.toUpperCase() === ".ENDMACRO"
        ) {
          foundEnd = true;
          break;
        }
        body.push(bodyLine);
      }

      if (!foundEnd) {
        throw new PreprocessError(
          "E_MACRO_UNTERMINATED",
          `Unterminated macro ${name}`,
          parsed.lineNumber,
          parsed.raw,
        );
      }

      macros.set(name.toUpperCase(), {
        name,
        parameters: parsed.operands.slice(1),
        body,
      });
      continue;
    }

    if (parsed.kind === "code" && mnemonic === ".REPEAT") {
      const countOperand = parsed.operands[0];
      if (countOperand === undefined) {
        throw new PreprocessError(
          "E_REPEAT_COUNT",
          ".repeat requires a count operand",
          parsed.lineNumber,
          parsed.raw,
        );
      }

      const repeatEval = evaluateExpressionDetailed(countOperand, constants, 0);
      if (repeatEval.value === null) {
        throw new PreprocessError(
          repeatEval.errorCode ?? "E_EXPR_INVALID",
          `.repeat count expression error (${countOperand}): ${repeatEval.error ?? "invalid expression"}`,
          parsed.lineNumber,
          parsed.raw,
        );
      }

      const repeatCount = repeatEval.value;
      if (repeatCount < 0) {
        throw new PreprocessError(
          "E_REPEAT_RANGE",
          ".repeat count must be non-negative",
          parsed.lineNumber,
          parsed.raw,
        );
      }

      const block: string[] = [];
      let foundEnd = false;
      let nesting = 0;

      for (i += 1; i < lines.length; i += 1) {
        const bodyLine = lines[i]!;
        const bodyLineNumber = startLineNumber + i;
        const bodyParsed = parseLine(bodyLine, bodyLineNumber);
        const bodyMnemonic = bodyParsed.mnemonic?.toUpperCase();

        if (bodyParsed.kind === "code" && bodyMnemonic === ".REPEAT") {
          nesting += 1;
        }

        if (bodyParsed.kind === "code" && bodyMnemonic === ".ENDREPEAT") {
          if (nesting === 0) {
            foundEnd = true;
            break;
          }
          nesting -= 1;
        }

        block.push(bodyLine);
      }

      if (!foundEnd) {
        throw new PreprocessError(
          "E_REPEAT_UNTERMINATED",
          "Unterminated .repeat block",
          parsed.lineNumber,
          parsed.raw,
        );
      }

      for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
        output.push(...preprocessLines(block, context, macros, constants));
      }
      continue;
    }

    if (parsed.kind === "code" && mnemonic === ".IF") {
      // Pass .if blocks through to main assembly loop for handling
      // The main loop will use DirectiveStack to manage branch selection
      output.push(line);

      // Consume the block structure (but don't evaluate or select branches)
      let nesting = 0;
      let foundEnd = false;

      for (i += 1; i < lines.length; i += 1) {
        const bodyLine = lines[i]!;
        const bodyLineNumber = startLineNumber + i;
        const bodyParsed = parseLine(bodyLine, bodyLineNumber);
        const bodyMnemonic = bodyParsed.mnemonic?.toUpperCase();

        if (bodyParsed.kind === "code" && bodyMnemonic === ".IF") {
          nesting += 1;
          output.push(bodyLine);
          continue;
        }

        if (bodyParsed.kind === "code" && bodyMnemonic === ".ENDIF") {
          if (nesting === 0) {
            foundEnd = true;
            output.push(bodyLine); // Include the .endif
            break;
          }
          nesting -= 1;
          output.push(bodyLine);
          continue;
        }

        // Pass .else, .elseif through unchanged (main loop will interpret them)
        if (
          nesting === 0 &&
          bodyParsed.kind === "code" &&
          (bodyMnemonic === ".ELSEIF" || bodyMnemonic === ".ELSE")
        ) {
          output.push(bodyLine);
          continue;
        }

        output.push(bodyLine);
      }

      if (!foundEnd) {
        throw new PreprocessError(
          "E_IF_UNTERMINATED",
          "Unterminated .if block",
          parsed.lineNumber,
          parsed.raw,
        );
      }
      continue;
    }

    if (parsed.kind === "code" && mnemonic === ".ENDREPEAT") {
      throw new PreprocessError(
        "E_REPEAT_UNEXPECTED_END",
        "Unexpected .endrepeat",
        parsed.lineNumber,
        parsed.raw,
      );
    }

    if (
      parsed.kind === "code" &&
      (mnemonic === ".ELSE" || mnemonic === ".ELSEIF" || mnemonic === ".ENDIF")
    ) {
      throw new PreprocessError(
        "E_IF_UNEXPECTED_END",
        `Unexpected ${mnemonic.toLowerCase()}`,
        parsed.lineNumber,
        parsed.raw,
      );
    }

    output.push(...expandLine(line, macros, 0));
  }

  return output;
}

function expandLine(
  line: string,
  macros: ReadonlyMap<string, MacroDefinition>,
  depth: number,
): string[] {
  if (depth > MAX_EXPANSION_DEPTH) {
    throw new PreprocessError(
      "E_MACRO_DEPTH",
      "Macro expansion depth exceeded",
      0,
      line,
    );
  }

  const parsed = parseSource(line)[0]!;
  if (parsed.kind !== "code" || parsed.mnemonic === undefined) {
    return [line];
  }

  const macro = macros.get(parsed.mnemonic.toUpperCase());
  if (macro === undefined) {
    return [line];
  }

  const replacements = buildReplacementMap(macro.parameters, parsed.operands);
  const expandedLines = macro.body.map((bodyLine) =>
    substituteParameters(bodyLine, replacements),
  );

  if (parsed.label !== undefined && expandedLines.length > 0) {
    expandedLines[0] = attachLabel(parsed.label, expandedLines[0]!);
  }

  return expandedLines.flatMap((expandedLine) =>
    expandLine(expandedLine, macros, depth + 1),
  );
}

function buildReplacementMap(
  parameters: readonly string[],
  values: readonly string[],
): Map<string, string> {
  const replacements = new Map<string, string>();

  parameters.forEach((parameter, index) => {
    replacements.set(parameter, values[index] ?? "");
    replacements.set(String(index + 1), values[index] ?? "");
  });

  return replacements;
}

function substituteParameters(
  line: string,
  replacements: ReadonlyMap<string, string>,
): string {
  let expanded = line;

  for (const [name, value] of replacements.entries()) {
    expanded = expanded.replaceAll(`\\${name}`, value);
  }

  return expanded;
}

function attachLabel(label: string, line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.length === 0) {
    return `${label}`;
  }

  if (trimmed.startsWith(";") || trimmed.startsWith("*")) {
    return `${label} ${trimmed}`;
  }

  return `${label} ${trimmed}`;
}

function parseIncludePath(operand: string): string | null {
  const trimmed = operand.trim();
  if (trimmed.length < 2) {
    return null;
  }

  const quote = trimmed[0];
  if (
    (quote !== '"' && quote !== "'") ||
    trimmed[trimmed.length - 1] !== quote
  ) {
    return null;
  }

  return trimmed.slice(1, -1);
}
