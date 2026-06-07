import type {
  MacroDefinition,
  PreprocessorOptions,
  SourceLine,
  SourceLocation,
  TaggedLine,
} from "./types.js";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { evaluateExpressionDetailed } from "./expressions.js";
import { parseLine } from "./parser.js";
import { readFileSync } from "node:fs";

const MAX_EXPANSION_DEPTH = 25;
const MAX_INCLUDE_DEPTH = 32;

function debugLog(message: string): void {
  if (process.env.DEBUG_PREPROCESSOR) {
    console.error(`[PREPROC] ${message}`);
  }
}

interface ConditionalFrame {
  readonly type: "if";
  readonly startLineNumber: number;
  readonly startLocation: SourceLocation;
  readonly branches: Array<{
    condition: string | null;
    isActive: boolean;
  }>;
  currentBranchIndex: number;
  activeBranchIndex: number | null;
}

interface RepeatFrame {
  readonly type: "repeat";
  readonly startLineNumber: number;
  readonly startLocation: SourceLocation;
  readonly count: number;
  readonly body: readonly TaggedLine[];
  currentIteration: number;
  lineIndex: number;
}

interface IncludeFrame {
  readonly type: "include";
  readonly filePath: string;
  readonly preprocessor: IncrementalPreprocessor;
}

interface MacroExpansionFrame {
  readonly type: "macro";
  readonly macroName: string;
  readonly body: readonly TaggedLine[];
  lineIndex: number;
}

type DirectiveFrame =
  | ConditionalFrame
  | RepeatFrame
  | IncludeFrame
  | MacroExpansionFrame;

export class IncrementalPreprocessor {
  private originalLines: readonly TaggedLine[];
  private lines: TaggedLine[];
  private lineIndex: number = 0;
  private macros: Map<string, MacroDefinition> = new Map();
  private directiveStack: DirectiveFrame[] = [];
  private sourcePath: string | undefined;
  private readFile: (path: string) => string;
  private currentDir: string;

  constructor(source: string, options: PreprocessorOptions = {}) {
    this.sourcePath = options.sourcePath;
    this.readFile =
      options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    this.currentDir = options.sourcePath
      ? dirname(options.sourcePath)
      : process.cwd();

    const filename = options.sourcePath ?? "<source>";
    const sourceLines = source.split(/\r?\n/);
    this.originalLines = sourceLines.map((content, idx) => {
      const loc = {
        filename,
        lineNumber: idx + 1,
        text: content,
      };
      return {
        content,
        location: loc,
        locationChain: [loc],
      };
    });
    this.lines = [...this.originalLines];

    debugLog(`Initialized with ${this.lines.length} lines from ${filename}`);
  }

  nextLine(symbols: ReadonlyMap<string, number>): SourceLine | null {
    const tagged = this.nextTaggedLine(symbols);
    if (!tagged) {
      return null;
    }

    const parsed = parseLine(tagged.content, tagged.location.lineNumber);
    return {
      ...parsed,
      location: tagged.location,
      locationChain: tagged.locationChain,
    };
  }

  private nextTaggedLine(
    symbols: ReadonlyMap<string, number>,
  ): TaggedLine | null {
    while (this.lineIndex < this.lines.length) {
      const line = this.lines[this.lineIndex]!;
      this.lineIndex += 1;

      try {
        const result = this.processTaggedLine(line, symbols);
        if (result !== null) {
          return result;
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        debugLog(
          `ERROR at ${line.location.filename}:${line.location.lineNumber}: ${message}`,
        );
        return {
          content: line.content,
          location: line.location,
          locationChain: [line.location],
        };
      }
    }

    const repeatFrame = this.directiveStack.find((f) => f.type === "repeat") as
      | RepeatFrame
      | undefined;
    if (repeatFrame && repeatFrame.currentIteration < repeatFrame.count - 1) {
      repeatFrame.currentIteration += 1;
      repeatFrame.lineIndex = 0;
      return this.nextTaggedLine(symbols);
    }

    return null;
  }

  private processTaggedLine(
    line: TaggedLine,
    symbols: ReadonlyMap<string, number>,
  ): TaggedLine | null {
    const trimmed = line.content.trim();
    if (!trimmed || /^\s*[;*]/.test(line.content)) {
      return line;
    }

    const parsed = parseLine(line.content, line.location.lineNumber);
    if (parsed.kind === "code" && parsed.mnemonic) {
      const mnemonic = parsed.mnemonic.toUpperCase();
      if (mnemonic === ".IF") {
        this.handleIfDirective(parsed.operands[0] ?? "0", this.evaluateCondition(parsed.operands[0] ?? "0", symbols), line.location);
        return null;
      }
      if (mnemonic === ".ELSEIF") {
        this.handleElseifDirective(parsed.operands[0] ?? "0", symbols, line.location);
        return null;
      }
      if (mnemonic === ".ELSE") {
        this.handleElseDirective(line.location);
        return null;
      }
      if (mnemonic === ".ENDIF") {
        this.handleEndifDirective(line.location);
        return null;
      }
      if (mnemonic === ".MACRO") {
        this.handleMacroDefinition(parsed, line.location);
        return null;
      }
      if (mnemonic === ".INCLUDE") {
        this.handleIncludeDirective(parsed, line.location);
        return null;
      }
      // Check for inactive conditional BEFORE processing .REPEAT/.ENDREPEAT
      // This prevents .repeat blocks inside inactive conditionals from corrupting the directive stack
      if (this.isInInactiveConditional()) {
        return null;
      }
      if (mnemonic === ".REPEAT") {
        this.handleRepeatDirective(parsed, symbols, line.location);
        return null;
      }
      if (mnemonic === ".ENDREPEAT") {
        this.handleEndrepeatDirective(line.location);
        return null;
      }
      const expanded = this.expandMacro(parsed, line, symbols);
      if (expanded !== null) {
        this.lines.splice(this.lineIndex, 0, ...expanded);
        return null;
      }
    }
    if (this.isInInactiveConditional()) {
      return null;
    }
    return line;
  }

  private handleMacroDefinition(line: SourceLine, location: SourceLocation): void {
    const name = line.operands[0]?.toUpperCase();
    if (!name) {
      throw new Error(`Macro definition missing name at ${location.filename}:${location.lineNumber}`);
    }
    const parameters = line.operands.slice(1);
    const body: TaggedLine[] = [];
    while (this.lineIndex < this.lines.length) {
      const bodyLine = this.lines[this.lineIndex]!;
      this.lineIndex += 1;
      const bodyParsed = parseLine(bodyLine.content, this.lineIndex);
      if (bodyParsed.kind === "code" && bodyParsed.mnemonic?.toUpperCase() === ".ENDMACRO") break;
      body.push(bodyLine);
    }
    this.macros.set(name, { name, parameters, body, lineNumber: location.lineNumber });
  }

  private handleIfDirective(condition: string, isActive: boolean, location: SourceLocation): void {
    this.directiveStack.push({
      type: "if",
      startLineNumber: location.lineNumber,
      startLocation: location,
      branches: [{ condition, isActive }],
      currentBranchIndex: 0,
      activeBranchIndex: isActive ? 0 : null,
    });
  }

  private handleElseifDirective(condition: string, symbols: ReadonlyMap<string, number>, location: SourceLocation): void {
    const frame = this.directiveStack[this.directiveStack.length - 1];
    if (!frame || frame.type !== "if") throw new Error(`.elseif without matching .if at ${location.filename}:${location.lineNumber}`);
    const isActive = frame.activeBranchIndex === null && this.evaluateCondition(condition, symbols);
    frame.branches.push({ condition, isActive });
    frame.currentBranchIndex = frame.branches.length - 1;
    if (isActive) frame.activeBranchIndex = frame.currentBranchIndex;
  }

  private handleElseDirective(location: SourceLocation): void {
    const frame = this.directiveStack[this.directiveStack.length - 1];
    if (!frame || frame.type !== "if") throw new Error(`.else without matching .if at ${location.filename}:${location.lineNumber}`);
    const isActive = frame.activeBranchIndex === null;
    frame.branches.push({ condition: null, isActive });
    frame.currentBranchIndex = frame.branches.length - 1;
    if (isActive) frame.activeBranchIndex = frame.currentBranchIndex;
  }

  private handleEndifDirective(location: SourceLocation): void {
    const frame = this.directiveStack[this.directiveStack.length - 1];
    if (!frame || frame.type !== "if") throw new Error(`.endif without matching .if at ${location.filename}:${location.lineNumber}`);
    this.directiveStack.pop();
  }

  private handleRepeatDirective(line: SourceLine, symbols: ReadonlyMap<string, number>, location: SourceLocation): void {
    const countExpr = line.operands[0] ?? "0";
    const countEval = evaluateExpressionDetailed(countExpr, symbols, 0);
    const count = countEval.value ?? 0;
    if (count < 0) throw new Error(`.repeat count must be non-negative at ${location.filename}:${location.lineNumber}`);
    const body: TaggedLine[] = [];
    let nesting = 0;
    while (this.lineIndex < this.lines.length) {
      const bodyLine = this.lines[this.lineIndex]!;
      this.lineIndex += 1;
      const bodyParsed = parseLine(bodyLine.content, this.lineIndex);
      if (bodyParsed.kind === "code") {
        const bodyMnemonic = bodyParsed.mnemonic?.toUpperCase();
        if (bodyMnemonic === ".REPEAT") nesting += 1;
        else if (bodyMnemonic === ".ENDREPEAT") {
          if (nesting === 0) break;
          nesting -= 1;
        }
      }
      body.push(bodyLine);
    }
    this.directiveStack.push({ type: "repeat", startLineNumber: location.lineNumber, startLocation: location, count, body, currentIteration: 0, lineIndex: 0 });
    this.lines.splice(this.lineIndex, 0, ...body);
  }

  private handleEndrepeatDirective(location: SourceLocation): void {
    const frame = this.directiveStack[this.directiveStack.length - 1];
    if (!frame || frame.type !== "repeat") throw new Error(`.endrepeat without matching .repeat at ${location.filename}:${location.lineNumber}`);
    if (frame.currentIteration < frame.count - 1) {
      frame.currentIteration += 1;
      this.lines.splice(this.lineIndex, 0, ...frame.body);
    } else {
      this.directiveStack.pop();
    }
  }

  private handleIncludeDirective(line: SourceLine, location: SourceLocation): void {
    const pathOperand = line.operands[0];
    if (!pathOperand) throw new Error(`.include requires a file path at ${location.filename}:${location.lineNumber}`);
    const pathMatch = pathOperand.match(/^["'](.+)["']$/);
    if (!pathMatch) throw new Error(`.include path must be quoted at ${location.filename}:${location.lineNumber}`);
    const includePath = pathMatch[1]!;
    const resolvedPath = isAbsolute(includePath) ? resolve(includePath) : resolve(join(this.currentDir, includePath));
    let includedText: string;
    try {
      includedText = this.readFile(resolvedPath);
    } catch {
      throw new Error(`.include failed to read ${resolvedPath} at ${location.filename}:${location.lineNumber}`);
    }
    const includedLines = includedText.split(/\r?\n/);
    const taggedLines: TaggedLine[] = includedLines.map((content, idx) => {
      const loc = { filename: resolvedPath, lineNumber: idx + 1, text: content, parent: location };
      return { content, location: loc, locationChain: [loc, location] };
    });
    this.lines.splice(this.lineIndex, 0, ...taggedLines);
  }

  private isInInactiveConditional(): boolean {
    // Check all .if frames on the stack, not just the outermost one
    for (const frame of this.directiveStack) {
      if (frame.type !== "if") continue;
      const activeBranch = frame.branches[frame.activeBranchIndex ?? -1];
      const currentBranch = frame.branches[frame.currentBranchIndex];
      // If any .if frame is in an inactive branch, we're in an inactive conditional
      if (activeBranch !== currentBranch) {
        return true;
      }
    }
    return false;
  }

  private evaluateCondition(condition: string, symbols: ReadonlyMap<string, number>): boolean {
    const result = evaluateExpressionDetailed(condition, symbols, 0);
    return (result.value ?? 0) !== 0;
  }

  private expandMacro(line: SourceLine, taggedLine: TaggedLine, symbols: ReadonlyMap<string, number>): TaggedLine[] | null {
    if (line.kind !== "code" || !line.mnemonic) return null;
    const macro = this.macros.get(line.mnemonic.toUpperCase());
    if (!macro) return null;
    const substitutions = new Map<string, string>();
    macro.parameters.forEach((param, index) => {
      substitutions.set(param, line.operands[index] ?? "");
      substitutions.set(String(index + 1), line.operands[index] ?? "");
    });
    const expanded: TaggedLine[] = macro.body.map((bodyLine) => {
      let content = bodyLine.content;
      for (const [param, value] of substitutions.entries()) content = content.replaceAll(`\\${param}`, value);
      const loc = { filename: `<macro:${macro.name}>`, lineNumber: bodyLine.location.lineNumber, text: content, parent: taggedLine.location };
      return { content, location: loc, locationChain: [loc, taggedLine.location, ...taggedLine.locationChain] };
    });
    if (line.label && expanded.length > 0) {
      const firstLine = expanded[0]!;
      expanded[0] = { ...firstLine, content: `${line.label} ${firstLine.content}` };
    }
    return expanded;
  }
}
