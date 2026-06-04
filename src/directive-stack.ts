/**
 * Directive state stack for managing nested scopes during assembly.
 * Tracks conditional branches, repetitions, and macro expansions.
 *
 * This replaces scattered state management in preprocessor.ts with
 * a clear, explicit stack-based approach suitable for the main assembly loop.
 */

/**
 * A single frame on the directive stack, representing one level of nesting.
 * Contains state specific to the type of directive (if/repeat/macro).
 */
export interface DirectiveStackFrame {
  /** Type of directive creating this frame */
  readonly type: "if" | "repeat" | "macro";

  /** Depth in the stack (for error reporting) */
  readonly depth: number;

  /** Line number where the directive started (for error messages) */
  readonly startLineNumber: number;

  // Conditional (.if/.elseif/.else/.endif) specific fields
  /** For .if: the branches [{ condition, lines }] */
  branches?: ReadonlyArray<{ condition: string | null; lines: string[] }>;

  /** For .if: index of active branch, or null to skip all (null condition = .else) */
  activeBranchIndex?: number | null;

  // Repetition (.repeat/.endrepeat) specific fields
  /** For .repeat: total iteration count */
  repeatCount?: number;

  /** For .repeat: current iteration (0-based) */
  currentIteration?: number;

  /** For .repeat: the lines to repeat */
  repeatBlock?: string[];

  /** For .repeat: line index to jump back to at loop start */
  repeatStartLineIndex?: number;

  // Macro expansion specific fields
  /** For .macro invocation: name of the macro */
  macroName?: string;

  /** For .macro invocation: parameter names */
  macroParameters?: readonly string[];

  /** For .macro invocation: macro body lines */
  macroBody?: string[];

  /** For .macro invocation: map of parameter → actual argument values */
  macroArguments?: Map<string, string>;

  /** For .macro invocation: line to resume at after macro completes */
  macroReturnLineIndex?: number;
}

/**
 * Stack-based state machine for managing nested directives.
 * Provides explicit control flow for .if/.repeat/.macro nesting.
 */
export class DirectiveStack {
  private frames: DirectiveStackFrame[] = [];

  /**
   * Push a new frame onto the stack.
   */
  push(frame: DirectiveStackFrame): void {
    this.frames.push(frame);
  }

  /**
   * Pop the top frame from the stack.
   */
  pop(): DirectiveStackFrame | undefined {
    return this.frames.pop();
  }

  /**
   * Peek at the top frame without removing it.
   */
  peek(): DirectiveStackFrame | undefined {
    return this.frames.length > 0
      ? this.frames[this.frames.length - 1]
      : undefined;
  }

  /**
   * Get a frame at a specific depth (0 = top of stack).
   */
  get(depth: number): DirectiveStackFrame | undefined {
    if (depth < 0 || depth >= this.frames.length) return undefined;
    return this.frames[this.frames.length - 1 - depth];
  }

  /**
   * Get the current stack depth.
   */
  get depth(): number {
    return this.frames.length;
  }

  /**
   * Check if the stack is empty.
   */
  isEmpty(): boolean {
    return this.frames.length === 0;
  }

  /**
   * Check if we're currently inside a conditional block.
   */
  isInConditional(): boolean {
    const frame = this.peek();
    return frame?.type === "if";
  }

  /**
   * Check if we're currently inside a repeat block.
   */
  isInRepeat(): boolean {
    const frame = this.peek();
    return frame?.type === "repeat";
  }

  /**
   * Check if we're currently expanding a macro.
   */
  isInMacro(): boolean {
    const frame = this.peek();
    return frame?.type === "macro";
  }

  /**
   * For a conditional frame: get the active branch index.
   * Returns undefined if not in a conditional or branch index not set.
   */
  getActiveBranchIndex(): number | null | undefined {
    const frame = this.peek();
    if (frame?.type !== "if") return undefined;
    return frame.activeBranchIndex;
  }

  /**
   * For a conditional frame: set which branch is active.
   * Pass null to skip all branches (condition was false, no .else).
   */
  setActiveBranch(index: number | null): void {
    const frame = this.peek();
    if (frame?.type === "if") {
      (frame as any).activeBranchIndex = index;
    }
  }

  /**
   * For a conditional frame: check if we're in an active (non-skipped) branch.
   */
  isInActiveBranch(): boolean {
    const frame = this.peek();
    if (frame?.type !== "if") return true; // Not in conditional, so "active"
    return frame.activeBranchIndex !== null;
  }

  /**
   * For a repeat frame: advance to the next iteration.
   * Returns true if there are more iterations, false if done.
   */
  nextIteration(): boolean {
    const frame = this.peek();
    if (frame?.type !== "repeat") return false;

    if (frame.currentIteration === undefined) {
      (frame as any).currentIteration = 0;
    } else {
      (frame as any).currentIteration++;
    }

    return (
      frame.currentIteration! < frame.repeatCount!
    );
  }

  /**
   * For a repeat frame: get the current iteration number (0-based).
   */
  getCurrentIteration(): number | undefined {
    const frame = this.peek();
    if (frame?.type !== "repeat") return undefined;
    return frame.currentIteration;
  }

  /**
   * For a repeat frame: get the total iteration count.
   */
  getRepeatCount(): number | undefined {
    const frame = this.peek();
    if (frame?.type !== "repeat") return undefined;
    return frame.repeatCount;
  }

  /**
   * For a repeat frame: get the line index to jump back to at loop start.
   */
  getRepeatStartLineIndex(): number | undefined {
    const frame = this.peek();
    if (frame?.type !== "repeat") return undefined;
    return frame.repeatStartLineIndex;
  }

  /**
   * For a macro frame: get the macro name.
   */
  getMacroName(): string | undefined {
    const frame = this.peek();
    if (frame?.type !== "macro") return undefined;
    return frame.macroName;
  }

  /**
   * For a macro frame: get the line index to return to after macro expands.
   */
  getMacroReturnLineIndex(): number | undefined {
    const frame = this.peek();
    if (frame?.type !== "macro") return undefined;
    return frame.macroReturnLineIndex;
  }

  /**
   * Verify invariant: all .if frames should have branches defined.
   * Used for debugging/assertions only.
   */
  assertValid(): void {
    for (const frame of this.frames) {
      if (frame.type === "if" && !frame.branches) {
        throw new Error(
          `Invariant violation: .if frame at depth ${frame.depth} missing branches`,
        );
      }
      if (frame.type === "repeat" && frame.repeatCount === undefined) {
        throw new Error(
          `Invariant violation: .repeat frame at depth ${frame.depth} missing count`,
        );
      }
      if (frame.type === "macro" && !frame.macroBody) {
        throw new Error(
          `Invariant violation: .macro frame at depth ${frame.depth} missing body`,
        );
      }
    }
  }

  /**
   * Dump stack state for debugging.
   */
  debug(): string {
    return this.frames
      .map((frame, i) => {
        const indent = "  ".repeat(i);
        if (frame.type === "if") {
          return `${indent}[${i}] if (branches=${frame.branches?.length}, active=${frame.activeBranchIndex})`;
        } else if (frame.type === "repeat") {
          return `${indent}[${i}] repeat (count=${frame.repeatCount}, iter=${frame.currentIteration})`;
        } else {
          return `${indent}[${i}] macro ${frame.macroName}`;
        }
      })
      .join("\n");
  }
}
