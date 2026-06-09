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
  private includeStack: Set<string> = new Set();
  private includeDepth: number = 0;

  constructor(filePath: string, options: PreprocessorOptions = {}) {
    this.sourcePath = options.sourcePath ?? filePath;
    this.readFile =
      options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    this.currentDir = options.sourcePath
      ? dirname(options.sourcePath)
      : dirname(filePath);

    const filename = this.sourcePath;
    const content = this.readFile(filePath);
    const sourceLines = content.split(/\r?\n/);
    this.originalLines = sourceLines.map((content, idx) => ({
      content,
      location: {
        filename,
        lineNumber: idx + 1,
        text: content,
      },
    }));
    this.lines = [...this.originalLines];
    this.includeStack.add(resolve(filePath));

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
        throw error;
      }
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
        this.handleIfDirective(parsed, line.location, symbols);
        return null;
      }
      if (mnemonic === ".ELSEIF") {
        this.handleElseifDirective(parsed, symbols, line.location);
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
      if (mnemonic === ".REPEAT") {
        this.handleRepeatDirective(parsed, symbols, line.location);
        return null;
      }
      if (mnemonic === ".ENDREPEAT") {
        this.handleEndrepeatDirective(line.location);
        return null;
      }
      if (mnemonic === ".INCLUDE") {
        this.handleIncludeDirective(parsed, line.location);
        return null;
      }

      if (this.isInInactiveConditional()) {
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

  private handleMacroDefinition(
    line: SourceLine,
    location: SourceLocation,
  ): void {
    const name = line.operands[0]?.toUpperCase();
    if (!name) {
      throw new Error(
        `Macro definition missing name at ${location.filename}:${location.lineNumber}`,
      );
    }
    const parameters = line.operands.slice(1);
    const body: TaggedLine[] = [];
    let foundEnd = false;

    while (this.lineIndex < this.lines.length) {
      const bodyLine = this.lines[this.lineIndex]!;
      this.lineIndex += 1;
      const bodyParsed = parseLine(
        bodyLine.content,
        bodyLine.location.lineNumber,
      );
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
      throw new Error(
        `Unterminated macro ${name} at ${location.filename}:${location.lineNumber}`,
      );
    }

    this.macros.set(name, {
      name,
      parameters,
      body,
      lineNumber: location.lineNumber,
    });
  }

  private handleIfDirective(
    line: SourceLine,
    location: SourceLocation,
    symbols: ReadonlyMap<string, number>,
  ): void {
    const condition = line.operands[0] ?? "0";
    const isActive = this.evaluateCondition(condition, symbols);
    this.directiveStack.push({
      type: "if",
      startLineNumber: location.lineNumber,
      startLocation: location,
      branches: [{ condition, isActive }],
      currentBranchIndex: 0,
      activeBranchIndex: isActive ? 0 : null,
    });
  }

  private handleElseifDirective(
    line: SourceLine,
    symbols: ReadonlyMap<string, number>,
    location: SourceLocation,
  ): void {
    const frame = this.directiveStack[this.directiveStack.length - 1];
    if (!frame || frame.type !== "if") {
      throw new Error(
        `.elseif without matching .if at ${location.filename}:${location.lineNumber}`,
      );
    }
    const condition = line.operands[0] ?? "0";
    const isActive =
      frame.activeBranchIndex === null &&
      this.evaluateCondition(condition, symbols);
    (frame.branches as any).push({ condition, isActive });
    frame.currentBranchIndex = frame.branches.length - 1;
    if (isActive) {
      frame.activeBranchIndex = frame.currentBranchIndex;
    }
  }

  private handleElseDirective(location: SourceLocation): void {
    const frame = this.directiveStack[this.directiveStack.length - 1];
    if (!frame || frame.type !== "if") {
      throw new Error(
        `.else without matching .if at ${location.filename}:${location.lineNumber}`,
      );
    }
    const isActive = frame.activeBranchIndex === null;
    (frame.branches as any).push({ condition: null, isActive });
    frame.currentBranchIndex = frame.branches.length - 1;
    if (isActive) {
      frame.activeBranchIndex = frame.currentBranchIndex;
    }
  }

  private handleEndifDirective(location: SourceLocation): void {
    const frame = this.directiveStack[this.directiveStack.length - 1];
    if (!frame || frame.type !== "if") {
      throw new Error(
        `.endif without matching .if at ${location.filename}:${location.lineNumber}`,
      );
    }
    this.directiveStack.pop();
  }

  private handleRepeatDirective(
    line: SourceLine,
    symbols: ReadonlyMap<string, number>,
    location: SourceLocation,
  ): void {
    const countExpr = line.operands[0] ?? "0";
    const countEval = evaluateExpressionDetailed(countExpr, symbols, 0);
    const count = countEval.value ?? 0;

    if (count < 0) {
      throw new Error(
        `.repeat count must be non-negative at ${location.filename}:${location.lineNumber}`,
      );
    }

    const body: TaggedLine[] = [];
    let nesting = 0;
    let foundEnd = false;

    while (this.lineIndex < this.lines.length) {
      const bodyLine = this.lines[this.lineIndex]!;
      this.lineIndex += 1;
      const bodyParsed = parseLine(
        bodyLine.content,
        bodyLine.location.lineNumber,
      );
      if (bodyParsed.kind === "code") {
        const bodyMnemonic = bodyParsed.mnemonic?.toUpperCase();
        if (bodyMnemonic === ".REPEAT") {
          nesting += 1;
        } else if (bodyMnemonic === ".ENDREPEAT") {
          if (nesting === 0) {
            foundEnd = true;
            break;
          }
          nesting -= 1;
        }
      }
      body.push(bodyLine);
    }

    if (!foundEnd) {
      throw new Error(
        `.repeat block unterminated at ${location.filename}:${location.lineNumber}`,
      );
    }

    this.directiveStack.push({
      type: "repeat",
      startLineNumber: location.lineNumber,
      startLocation: location,
      count,
      body,
      currentIteration: 0,
      lineIndex: 0,
    });
  }

  private handleEndrepeatDirective(location: SourceLocation): void {
    const frame = this.directiveStack[this.directiveStack.length - 1];
    if (!frame || frame.type !== "repeat") {
      throw new Error(
        `.endrepeat without matching .repeat at ${location.filename}:${location.lineNumber}`,
      );
    }

    if (frame.currentIteration < frame.count - 1) {
      frame.currentIteration += 1;
      this.lines.splice(this.lineIndex, 0, ...frame.body);
    } else {
      this.directiveStack.pop();
    }
  }

  private handleIncludeDirective(
    line: SourceLine,
    location: SourceLocation,
  ): void {
    const pathOperand = line.operands[0];
    if (!pathOperand) {
      throw new Error(
        `.include requires a file path at ${location.filename}:${location.lineNumber}`,
      );
    }

    const pathMatch = pathOperand.match(/^["'](.+)["']$/);
    if (!pathMatch) {
      throw new Error(
        `.include path must be quoted at ${location.filename}:${location.lineNumber}`,
      );
    }

    const includePath = pathMatch[1]!;
    const resolvedPath = isAbsolute(includePath)
      ? resolve(includePath)
      : resolve(join(this.currentDir, includePath));

    if (this.includeDepth >= MAX_INCLUDE_DEPTH) {
      throw new Error(
        `.include depth exceeded at ${location.filename}:${location.lineNumber}`,
      );
    }

    if (this.includeStack.has(resolvedPath)) {
      throw new Error(
        `.include circular reference to ${resolvedPath} at ${location.filename}:${location.lineNumber}`,
      );
    }

    let includedText: string;
    try {
      includedText = this.readFile(resolvedPath);
    } catch {
      throw new Error(
        `.include failed to read ${resolvedPath} at ${location.filename}:${location.lineNumber}`,
      );
    }

    const includedLines = includedText.split(/\r?\n/);
    const taggedLines: TaggedLine[] = includedLines.map((content, idx) => ({
      content,
      location: {
        filename: resolvedPath,
        lineNumber: idx + 1,
        text: content,
      },
    }));

    this.lines.splice(this.lineIndex, 0, ...taggedLines);
  }

  private isInInactiveConditional(): boolean {
    for (const frame of this.directiveStack) {
      if (frame.type !== "if") continue;
      const activeBranch = frame.branches[frame.activeBranchIndex ?? -1];
      const currentBranch = frame.branches[frame.currentBranchIndex];
      if (activeBranch !== currentBranch) {
        return true;
      }
    }
    return false;
  }

  private evaluateCondition(
    condition: string,
    symbols: ReadonlyMap<string, number>,
  ): boolean {
    const result = evaluateExpressionDetailed(condition, symbols, 0);
    return (result.value ?? 0) !== 0;
  }

  private expandMacro(
    line: SourceLine,
    taggedLine: TaggedLine,
    symbols: ReadonlyMap<string, number>,
  ): TaggedLine[] | null {
    if (line.kind !== "code" || !line.mnemonic) return null;
    const macro = this.macros.get(line.mnemonic.toUpperCase());
    if (!macro) return null;

    const substitutions = new Map<string, string>();
    macro.parameters.forEach((param, index) => {
      substitutions.set(param, line.operands[index] ?? "");
    });

    const expanded: TaggedLine[] = macro.body.map((bodyLine) => {
      let content = bodyLine.content;
      for (const [param, value] of substitutions.entries()) {
        content = content.replaceAll(`\\${param}`, value);
      }
      return {
        content,
        location: {
          filename: `<macro:${macro.name}>`,
          lineNumber: bodyLine.location.lineNumber,
          text: content,
        },
      };
    });

    if (line.label && expanded.length > 0) {
      const firstLine = expanded[0]!;
      expanded[0] = {
        ...firstLine,
        content: `${line.label} ${firstLine.content}`,
      };
    }

    return expanded;
  }
}
