/**
 * Directive-aware line iteration for the main assembly loop.
 *
 * This module provides utilities for iterating through source lines while respecting
 * directive control flow (.if, .repeat, .macro) using the DirectiveStack.
 *
 * Instead of expanding all directives in preprocessing, the main assembly loop
 * uses these iterators to decide which lines to process, enabling proper symbol
 * resolution before branch evaluation and other improvements.
 */

import type { SourceLine } from "./types.js";
import { DirectiveStack, type DirectiveStackFrame } from "./directive-stack.js";
import type { PreprocessOptions } from "./preprocessor.js";
import { evaluateExpressionDetailed } from "./expressions.js";

export interface LineIteratorOptions {
  /** Macro definitions (from preprocessing) */
  readonly macros?: Map<
    string,
    { parameters: readonly string[]; body: string[] }
  >;

  /** Constants for .if condition evaluation */
  readonly constants?: Map<string, number>;

  /** Symbol table for forward reference resolution */
  readonly symbols?: Map<string, number>;

  /** Max iterations for .repeat to prevent infinite loops */
  readonly maxRepeatIterations?: number;
}

/**
 * Iterate through source lines while respecting directive control flow.
 *
 * This generator yields individual lines with associated context (whether to process,
 * whether we're in an active branch, etc). It handles:
 * - .IF/.ELSEIF/.ELSE/.ENDIF branching
 * - .REPEAT/.ENDREPEAT looping
 * - Macro expansion (future)
 *
 * Usage:
 * ```typescript
 * for (const { line, shouldProcess, lineIndex } of directiveAwareIteration(lines, stack, options)) {
 *   if (shouldProcess) {
 *     // Process the line normally
 *   }
 *   // Update stack if line is a directive
 * }
 * ```
 */
export interface LineIterationItem {
  /** The source line */
  readonly line: SourceLine;

  /** The index in the original lines array */
  readonly lineIndex: number;

  /** Whether this line should be processed (not in inactive branch) */
  readonly shouldProcess: boolean;

  /** If this line starts a directive scope, the resulting frame (optional) */
  readonly pushFrame?: DirectiveStackFrame | undefined;

  /** If this line ends a directive scope (optional) */
  readonly shouldPopFrame?: boolean | undefined;

  /** Next line index to process (for loop jumps, optional) */
  readonly nextLineIndex?: number | undefined;
}

/**
 * Generator that yields lines while respecting the directive stack.
 *
 * This is the core of the new assembly approach:
 * Instead of the preprocessor expanding all directives upfront,
 * the main assembly loop uses this iterator to selectively process lines
 * based on runtime conditions (evaluated .if branches, .repeat iterations, etc).
 */
export function* directiveAwareIteration(
  lines: readonly SourceLine[],
  stack: DirectiveStack,
  options: LineIteratorOptions = {},
): Generator<LineIterationItem> {
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex]!;

    // Check if we're in an inactive branch
    if (stack.isInConditional() && !stack.isInActiveBranch()) {
      // Skip this line
      const mnemonic = line.mnemonic?.toUpperCase();

      // But still track directive scope changes
      if (mnemonic === ".ELSEIF" || mnemonic === ".ELSE") {
        // Will be handled in next iteration after popping
        yield {
          line,
          lineIndex,
          shouldProcess: false,
        };
        lineIndex++;
        continue;
      }

      if (mnemonic === ".ENDIF") {
        yield {
          line,
          lineIndex,
          shouldProcess: false,
          shouldPopFrame: true,
        };
        lineIndex++;
        continue;
      }

      // In inactive branch, skip regular lines
      yield {
        line,
        lineIndex,
        shouldProcess: false,
      };
      lineIndex++;
      continue;
    }

    // Process this line normally
    const shouldProcess = true;

    // Check if it's a directive that affects the stack
    const mnemonic = line.mnemonic?.toUpperCase();

    if (mnemonic === ".IF") {
      // Create a conditional frame
      const condition = line.operands[0];
      const frame: DirectiveStackFrame = {
        type: "if",
        depth: stack.depth,
        startLineNumber: line.lineNumber,
        branches: [], // Will be populated
      };

      yield {
        line,
        lineIndex,
        shouldProcess,
        pushFrame: frame,
      };
      lineIndex++;
    } else if (mnemonic === ".ELSE" || mnemonic === ".ELSEIF") {
      // These will be handled by the consumer (branch selection)
      yield {
        line,
        lineIndex,
        shouldProcess,
      };
      lineIndex++;
    } else if (mnemonic === ".ENDIF") {
      yield {
        line,
        lineIndex,
        shouldProcess: false, // Don't process the .ENDIF itself
        shouldPopFrame: true,
      };
      lineIndex++;
    } else if (mnemonic === ".REPEAT") {
      // Create a repeat frame
      const frame: DirectiveStackFrame = {
        type: "repeat",
        depth: stack.depth,
        startLineNumber: line.lineNumber,
        repeatCount: 1, // Will be evaluated by caller
        currentIteration: 0,
        repeatBlock: [],
        repeatStartLineIndex: lineIndex + 1,
      };

      yield {
        line,
        lineIndex,
        shouldProcess,
        pushFrame: frame,
      };
      lineIndex++;
    } else if (mnemonic === ".ENDREPEAT") {
      // Check if we should loop again
      const frame = stack.peek();
      if (frame?.type === "repeat" && stack.nextIteration()) {
        // Loop again
        yield {
          line,
          lineIndex,
          shouldProcess: false,
          nextLineIndex: frame.repeatStartLineIndex,
        };
      } else {
        // Done looping
        yield {
          line,
          lineIndex,
          shouldProcess: false,
          shouldPopFrame: true,
        };
        lineIndex++;
      }
    } else {
      // Regular line
      yield {
        line,
        lineIndex,
        shouldProcess,
      };
      lineIndex++;
    }
  }
}

/**
 * Simpler version that just tracks whether to process a line.
 * Use this when you don't need full frame management.
 */
export function* shouldProcessLine(
  lines: readonly SourceLine[],
  stack: DirectiveStack,
): Generator<boolean> {
  for (const item of directiveAwareIteration(lines, stack)) {
    yield item.shouldProcess;
  }
}
