import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseLine, parseSource, setKnownMacros } from "./parser.js";

import { evaluateExpressionDetailed } from "./expressions.js";
import { readFileSync } from "node:fs";

const MAX_INCLUDE_DEPTH = 32;

/**
 * Preprocessor: Handles ONLY structural composition before the incremental pass.
 *
 * Responsibilities:
 * - .INCLUDE: recursive file inclusion
 * - .MACRO collection: registers macro names with the parser (via setKnownMacros)
 *   and passes the definition blocks THROUGH unchanged so the incremental
 *   preprocessor can collect the bodies with full symbol-table access.
 * - .REPEAT: structural error checking (unterminated/unexpected) and count
 *   evaluation, then passes the repeated lines through.
 * - .IF pass-through: .if blocks are passed through entirely unchanged.
 * - Everything else: passed through unchanged.
 *
 * NOT handled here (all moved to IncrementalPreprocessor):
 * - Macro expansion: must interleave with .if/.repeat using the live symbol table
 * - Conditional branch selection (.IF/.ELSEIF/.ELSE/.ENDIF)
 * - All symbol-table-dependent evaluations
 */

export interface PreprocessOptions {
  readonly sourcePath?: string;
  readonly currentDir?: string;
  readonly readFile?: (filePath: string) => string;
}

export class PreprocessError extends Error {
  readonly code: string;
  readonly lineNumber: number;
  readonly source: string;

  constructor(code: string, message: string, lineNumber: number, source: string) {
    super(message);
    this.name = "PreprocessError";
    this.code = code;
    this.lineNumber = lineNumber;
    this.source = source;
  }
}

export function preprocessSource(text: string, options: PreprocessOptions = {}): string {
  const sourcePath = options.sourcePath;
  const currentDir = options.currentDir ?? (sourcePath === undefined ? process.cwd() : dirname(sourcePath));
  const readFile = options.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
  const macros = new Set<string>();
  // Collect numeric constants for .repeat count evaluation only
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
 * Collect simple numeric constants for .repeat count evaluation.
 * Only extracts plain numeric literals -- no complex expressions or symbol deps.
 */
function collectConstants(lines: readonly string[]): Map<string, number> {
  const constants = new Map<string, number>();
  for (const line of lines) {
    const parsed = parseSource(line)[0];
    if (!parsed || parsed.kind !== "code") continue;
    const mnemonic = parsed.mnemonic?.toUpperCase();
    if (mnemonic === "=" && parsed.label) {
      const operand = parsed.operands[0];
      if (operand !== undefined) {
        const numValue = parseInt(operand, 10);
        if (!isNaN(numValue) && operand === numValue.toString()) {
          constants.set(parsed.label.toUpperCase(), numValue);
        }
      }
      continue;
    }
    if (!mnemonic) {
      const assignmentMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([+-]?\d+)\s*$/);
      if (assignmentMatch) {
        constants.set(assignmentMatch[1]!.toUpperCase(), parseInt(assignmentMatch[2]!, 10));
      }
      continue;
    }
    if (mnemonic === ".EQU" || mnemonic === ".SET") {
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

function preprocessLines(
  lines: readonly string[],
  context: IncludeContext,
  macros: Set<string>,
  constants: Map<string, number> = new Map(),
  startLineNumber: number = 1,
): string[] {
  const output: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineNumber = startLineNumber + i;
    const parsed = parseLine(line, lineNumber);
    const mnemonic = parsed.mnemonic?.toUpperCase();

    // .INCLUDE: expand file contents inline
    if (parsed.kind === "code" && mnemonic === ".INCLUDE") {
      const includeOperand = parsed.operands[0];
      if (includeOperand === undefined) {
        throw new PreprocessError("E_INCLUDE_OPERAND", ".include requires a quoted file path", parsed.lineNumber, parsed.raw);
      }
      const includePath = parseIncludePath(includeOperand);
      if (includePath === null) {
        throw new PreprocessError("E_INCLUDE_PATH", `.include path must be a quoted string: ${includeOperand}`, parsed.lineNumber, parsed.raw);
      }
      if (context.includeDepth >= MAX_INCLUDE_DEPTH) {
        throw new PreprocessError("E_INCLUDE_DEPTH", "Maximum include depth exceeded", parsed.lineNumber, parsed.raw);
      }
      const resolvedPath = isAbsolute(includePath) ? resolve(includePath) : resolve(join(context.currentDir, includePath));
      if (context.includeStack.includes(resolvedPath)) {
        throw new PreprocessError("E_INCLUDE_CYCLE", `Circular include detected for ${resolvedPath}`, parsed.lineNumber, parsed.raw);
      }
      let includedText: string;
      try {
        includedText = context.readFile(resolvedPath);
      } catch {
        throw new PreprocessError("E_INCLUDE_READ", `Unable to read include file: ${resolvedPath}`, parsed.lineNumber, parsed.raw);
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

    // .MACRO: register the name with the parser (so it is recognized as a macro
    // invocation during parsing), then pass the entire definition block through
    // UNCHANGED so the incremental preprocessor can collect the body and expand
    // invocations at the right time with the live symbol table.
    if (parsed.kind === "code" && mnemonic === ".MACRO") {
      const name = parsed.operands[0]?.trim()?.toUpperCase();
      if (name) {
        macros.add(name);
        setKnownMacros(new Set(macros));
      }
      // Pass .MACRO line through
      output.push(line);
      // Pass body lines through until .ENDMACRO (with unterminated check)
      let foundEnd = false;
      for (i += 1; i < lines.length; i += 1) {
        const bodyLine = lines[i]!;
        output.push(bodyLine);
        const bodyParsed = parseLine(bodyLine, startLineNumber + i);
        if (bodyParsed.kind === "code" && bodyParsed.mnemonic?.toUpperCase() === ".ENDMACRO") {
          foundEnd = true;
          break;
        }
      }
      if (!foundEnd) {
        throw new PreprocessError("E_MACRO_UNTERMINATED", `Unterminated macro ${name ?? "<unnamed>"}`, parsed.lineNumber, parsed.raw);
      }
      continue;
    }

    // .REPEAT: check structure and evaluate count (with static constants only),
    // then emit the body lines the required number of times.
    // NOTE: macro invocations inside .repeat are NOT expanded here -- they are
    // passed through raw and expanded by the incremental preprocessor with the
    // live symbol table.
    if (parsed.kind === "code" && mnemonic === ".REPEAT") {
      const countOperand = parsed.operands[0];
      if (countOperand === undefined) {
        throw new PreprocessError("E_REPEAT_COUNT", ".repeat requires a count operand", parsed.lineNumber, parsed.raw);
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
        throw new PreprocessError("E_REPEAT_RANGE", ".repeat count must be non-negative", parsed.lineNumber, parsed.raw);
      }
      const block: string[] = [];
      let foundEnd = false;
      let nesting = 0;
      for (i += 1; i < lines.length; i += 1) {
        const bodyLine = lines[i]!;
        const bodyParsed = parseLine(bodyLine, startLineNumber + i);
        const bodyMnemonic = bodyParsed.mnemonic?.toUpperCase();
        if (bodyParsed.kind === "code" && bodyMnemonic === ".REPEAT") nesting += 1;
        if (bodyParsed.kind === "code" && bodyMnemonic === ".ENDREPEAT") {
          if (nesting === 0) { foundEnd = true; break; }
          nesting -= 1;
        }
        block.push(bodyLine);
      }
      if (!foundEnd) {
        throw new PreprocessError("E_REPEAT_UNTERMINATED", "Unterminated .repeat block", parsed.lineNumber, parsed.raw);
      }
      // Emit body lines N times -- WITHOUT expanding macros (that is the
      // incremental preprocessor's job)
      for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
        output.push(...preprocessLines(block, context, macros, constants));
      }
      continue;
    }

    // Structural error: .ENDREPEAT without a matching .REPEAT
    if (parsed.kind === "code" && mnemonic === ".ENDREPEAT") {
      throw new PreprocessError("E_REPEAT_UNEXPECTED_END", "Unexpected .endrepeat", parsed.lineNumber, parsed.raw);
    }

    // .IF blocks: pass through ENTIRELY unchanged (the incremental preprocessor
    // evaluates conditions with the live symbol table).
    // We must track nesting to find the matching .ENDIF and check for unterminated blocks.
    if (parsed.kind === "code" && mnemonic === ".IF") {
      output.push(line);
      let nesting = 0;
      let foundEnd = false;
      for (i += 1; i < lines.length; i += 1) {
        const bodyLine = lines[i]!;
        output.push(bodyLine);
        const bodyParsed = parseLine(bodyLine, startLineNumber + i);
        const bodyMnemonic = bodyParsed.kind === "code" ? bodyParsed.mnemonic?.toUpperCase() : undefined;
        if (bodyMnemonic === ".IF") {
          nesting += 1;
        } else if (bodyMnemonic === ".ENDIF") {
          if (nesting === 0) { foundEnd = true; break; }
          nesting -= 1;
        }
      }
      if (!foundEnd) {
        throw new PreprocessError("E_IF_UNTERMINATED", "Unterminated .if block", parsed.lineNumber, parsed.raw);
      }
      continue;
    }

    // Structural errors: .ELSE/.ELSEIF/.ENDIF without matching .IF
    if (parsed.kind === "code" && (mnemonic === ".ELSE" || mnemonic === ".ELSEIF" || mnemonic === ".ENDIF")) {
      throw new PreprocessError("E_IF_UNEXPECTED_END", `Unexpected ${mnemonic.toLowerCase()}`, parsed.lineNumber, parsed.raw);
    }

    // Everything else (regular instructions, directives, macro invocations):
    // pass through unchanged for the incremental preprocessor to handle.
    output.push(line);
  }

  return output;
}

function parseIncludePath(operand: string): string | null {
  const trimmed = operand.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return null;
  return trimmed.slice(1, -1);
}
