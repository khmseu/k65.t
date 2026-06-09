import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseLine, parseSource, setKnownMacros } from "./parser.js";

import { PreprocessError } from "./location-errors.js";
import { SourceLocation } from "./types.js";
import { evaluateExpressionDetailed } from "./expressions.js";
import { readFileSync } from "node:fs";

const MAX_INCLUDE_DEPTH = 32;

/**
 * Preprocessor: Handles ONLY structural composition before the incremental pass.
 *
 * Responsibilities:
 * - .INCLUDE: recursive file inclusion with proper source location tracking
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

export interface TaggedLine {
  content: string;
  location: SourceLocation;
}

/**
 * Preprocess source code and return tagged lines with source locations.
 * Each line carries information about which file it came from and its line number within that file.
 */
export function preprocessSourceToTaggedLines(
  text: string,
  options: PreprocessOptions = {},
): TaggedLine[] {
  const sourcePath = options.sourcePath;
  const currentDir =
    options.currentDir ??
    (sourcePath === undefined ? process.cwd() : dirname(sourcePath));
  const readFile =
    options.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
  const macros = new Set<string>();
  // Collect numeric constants for .repeat count evaluation only
  const constants = collectConstants(
    text.split(/\r?\n/),
    sourcePath ?? "<source>",
  );
  const output = preprocessLinesToTagged(
    text.split(/\r?\n/).map((content, idx) => ({
      content,
      location: { filename: sourcePath ?? "<source>", lineNumber: idx + 1 },
    })),
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
  return output;
}

/**
 * Legacy function that returns preprocessed source as a string.
 * Used for backward compatibility.
 */
export function preprocessSource(
  text: string,
  options: PreprocessOptions = {},
): string {
  const tagged = preprocessSourceToTaggedLines(text, options);
  return tagged.map((line) => line.content).join("\n");
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
function collectConstants(
  lines: readonly string[],
  filename: string,
): Map<string, number> {
  const constants = new Map<string, number>();
  for (const line of lines) {
    const parsed = parseSource(line, filename)[0];
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
      const assignmentMatch = line.match(
        /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([+-]?\d+)\s*$/,
      );
      if (assignmentMatch) {
        constants.set(
          assignmentMatch[1]!.toUpperCase(),
          parseInt(assignmentMatch[2]!, 10),
        );
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

function preprocessLinesToTagged(
  lines: readonly TaggedLine[],
  context: IncludeContext,
  macros: Set<string>,
  constants: Map<string, number> = new Map(),
): TaggedLine[] {
  const output: TaggedLine[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const taggedLine = lines[i]!;
    const line = taggedLine.content;
    const parsed = parseLine(line, taggedLine.location);
    const mnemonic = parsed.mnemonic?.toUpperCase();

    // .INCLUDE: expand file contents inline, but preserve source locations
    if (parsed.kind === "code" && mnemonic === ".INCLUDE") {
      const includeOperand = parsed.operands[0];
      if (includeOperand === undefined) {
        throw new PreprocessError(
          "E_INCLUDE_OPERAND",
          ".include requires a quoted file path",
          parsed.location,
        );
      }
      const includePath = parseIncludePath(includeOperand);
      if (includePath === null) {
        throw new PreprocessError(
          "E_INCLUDE_PATH",
          `.include path must be a quoted string: ${includeOperand}`,
          parsed.location,
        );
      }
      if (context.includeDepth >= MAX_INCLUDE_DEPTH) {
        throw new PreprocessError(
          "E_INCLUDE_DEPTH",
          "Maximum include depth exceeded",
          parsed.location,
        );
      }
      const resolvedPath = isAbsolute(includePath)
        ? resolve(includePath)
        : resolve(join(context.currentDir, includePath));
      if (context.includeStack.includes(resolvedPath)) {
        throw new PreprocessError(
          "E_INCLUDE_CYCLE",
          `Circular include detected for ${resolvedPath}`,
          parsed.location,
        );
      }
      let includedText: string;
      try {
        includedText = context.readFile(resolvedPath);
      } catch {
        throw new PreprocessError(
          "E_INCLUDE_READ",
          `Unable to read include file: ${resolvedPath}`,
          parsed.location,
        );
      }
      const includedLines = preprocessLinesToTagged(
        includedText.split(/\r?\n/).map((content, idx) => ({
          content,
          location: { filename: resolvedPath, lineNumber: idx + 1 },
        })),
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
      output.push(taggedLine);
      // Pass body lines through until .ENDMACRO (with unterminated check)
      let foundEnd = false;
      for (i += 1; i < lines.length; i += 1) {
        const bodyTaggedLine = lines[i]!;
        output.push(bodyTaggedLine);
        const bodyParsed = parseLine(
          bodyTaggedLine.content,
          bodyTaggedLine.location,
        );
        if (
          bodyParsed.kind === "code" &&
          bodyParsed.mnemonic?.toUpperCase() === ".ENDMACRO"
        ) {
          foundEnd = true;
          break;
        }
      }
      if (!foundEnd) {
        throw new PreprocessError(
          "E_MACRO_UNTERMINATED",
          `Unterminated macro ${name ?? "<unnamed>"}`,
          parsed.location,
        );
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
        throw new PreprocessError(
          "E_REPEAT_COUNT",
          ".repeat requires a count operand",
          parsed.location,
        );
      }
      const repeatEval = evaluateExpressionDetailed(countOperand, constants, 0);
      if (repeatEval.value === null) {
        throw new PreprocessError(
          repeatEval.errorCode ?? "E_EXPR_INVALID",
          `.repeat count expression error (${countOperand}): ${repeatEval.error ?? "invalid expression"}`,
          parsed.location,
        );
      }
      const repeatCount = repeatEval.value;
      if (repeatCount < 0) {
        throw new PreprocessError(
          "E_REPEAT_RANGE",
          ".repeat count must be non-negative",
          parsed.location,
        );
      }
      const block: TaggedLine[] = [];
      let foundEnd = false;
      let nesting = 0;
      for (i += 1; i < lines.length; i += 1) {
        const bodyTaggedLine = lines[i]!;
        const bodyParsed = parseLine(
          bodyTaggedLine.content,
          bodyTaggedLine.location,
        );
        const bodyMnemonic = bodyParsed.mnemonic?.toUpperCase();
        if (bodyParsed.kind === "code" && bodyMnemonic === ".REPEAT")
          nesting += 1;
        if (bodyParsed.kind === "code" && bodyMnemonic === ".ENDREPEAT") {
          if (nesting === 0) {
            foundEnd = true;
            break;
          }
          nesting -= 1;
        }
        block.push(bodyTaggedLine);
      }
      if (!foundEnd) {
        throw new PreprocessError(
          "E_REPEAT_UNTERMINATED",
          "Unterminated .repeat block",
          parsed.location,
        );
      }
      // Emit body lines N times -- WITHOUT expanding macros (that is the
      // incremental preprocessor's job)
      for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
        output.push(
          ...preprocessLinesToTagged(block, context, macros, constants),
        );
      }
      continue;
    }

    // Structural error: .ENDREPEAT without a matching .REPEAT
    if (parsed.kind === "code" && mnemonic === ".ENDREPEAT") {
      throw new PreprocessError(
        "E_REPEAT_UNEXPECTED_END",
        "Unexpected .endrepeat",
        parsed.location,
      );
    }

    // .IF blocks: pass through ENTIRELY unchanged (the incremental preprocessor
    // evaluates conditions with the live symbol table).
    // We must track nesting to find the matching .ENDIF and check for unterminated blocks.
    if (parsed.kind === "code" && mnemonic === ".IF") {
      output.push(taggedLine);
      let nesting = 0;
      let foundEnd = false;
      for (i += 1; i < lines.length; i += 1) {
        const bodyTaggedLine = lines[i]!;
        output.push(bodyTaggedLine);
        const bodyParsed = parseLine(
          bodyTaggedLine.content,
          bodyTaggedLine.location,
        );
        const bodyMnemonic =
          bodyParsed.kind === "code"
            ? bodyParsed.mnemonic?.toUpperCase()
            : undefined;
        if (bodyMnemonic === ".IF") {
          nesting += 1;
        } else if (bodyMnemonic === ".ENDIF") {
          if (nesting === 0) {
            foundEnd = true;
            break;
          }
          nesting -= 1;
        }
      }
      if (!foundEnd) {
        throw new PreprocessError(
          "E_IF_UNTERMINATED",
          "Unterminated .if block",
          parsed.location,
        );
      }
      continue;
    }

    // Structural errors: .ELSE/.ELSEIF/.ENDIF without matching .IF
    if (
      parsed.kind === "code" &&
      (mnemonic === ".ELSE" || mnemonic === ".ELSEIF" || mnemonic === ".ENDIF")
    ) {
      throw new PreprocessError(
        "E_IF_UNEXPECTED_END",
        `Unexpected ${mnemonic.toLowerCase()}`,
        parsed.location,
      );
    }

    // Everything else (regular instructions, directives, macro invocations):
    // pass through unchanged for the incremental preprocessor to handle.
    output.push(taggedLine);
  }

  return output;
}

function parseIncludePath(operand: string): string | null {
  const trimmed = operand.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote)
    return null;
  return trimmed.slice(1, -1);
}
