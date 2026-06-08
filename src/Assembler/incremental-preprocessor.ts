import { isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";

import type { SourceLine } from "./types.js";
import { parseLine } from "./parser.js";
import { evaluateExpressionDetailed } from "./expressions.js";

let currentDir = process.cwd();

export function setCurrentDir(dir: string): void {
  currentDir = dir;
}

interface TaggedLine {
  content: string;
  location: SourceLocation;
  locationChain: SourceLocation[];
}

interface SourceLocation {
  filename: string;
  lineNumber: number;
  text: string;
  parent?: SourceLocation;
}

interface MacroFrame {
  type: "macro";
  name: string;
  parameters: string[];
  body: SourceLine[];
}

interface IfFrame {
  type: "if";
  branches: Array<{ condition: string; isActive: boolean }>;
  currentBranchIndex: number;
  activeBranchIndex?: number;
}

interface RepeatFrame {
  type: "repeat";
  startLineNumber: number;
  startLocation: SourceLocation;
  count: number;
  body: TaggedLine[];
  currentIteration: number;
  lineIndex: number;
}

type DirectiveFrame = MacroFrame | IfFrame | RepeatFrame;

export class IncrementalPreprocessor {
  private lines: TaggedLine[] = [];
  private lineIndex = 0;
  private macros: Map<string, MacroFrame> = new Map();
  private directiveStack: DirectiveFrame[] = [];
  private readFile: (path: string) => string = readFileSync;

  constructor(sourceText: string, readFile?: (path: string) => string) {
    const lines = sourceText.split(/\r?\n/);
    this.lines = lines.map((content, idx) => {
      const loc = { filename: "<source>", lineNumber: idx + 1, text: content };
      return { content, location: loc, locationChain: [loc] };
    });
    if (readFile) this.readFile = readFile;
  }

  nextLine(symbols: ReadonlyMap<string, number>): SourceLine | null {
    while (this.lineIndex < this.lines.length) {
      const tagged = this.lines[this.lineIndex]!;
      this.lineIndex += 1;
      const processed = this.processTaggedLine(tagged, symbols);
      if (processed) {
        return processed;
      }
    }
    return null;
  }

  private processTaggedLine(
    line: TaggedLine,
    symbols: ReadonlyMap<string, number>,
  ): SourceLine | null {
    const trimmed = line.content.trim();
    if (!trimmed || /^\s*[;*]/.test(line.content)) {
      return {
        lineNumber: line.location.lineNumber,
        raw: line.content,
        kind: "blank",
        operands: [],
        locationChain: line.locationChain,
        location: line.location,
      };
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
    }

    // Check for macro invocation
    const macroExpansion = this.expandMacro(parsed, line, symbols);
    if (macroExpansion) {
      this.lines.splice(this.lineIndex, 0, ...macroExpansion);
      return null;
    }

    // Check for inactive conditional AFTER macro expansion
    if (this.isInInactiveConditional()) {
      return null;
    }

    return {
      lineNumber: line.location.lineNumber,
      raw: line.content,
      kind: parsed.kind,
      label: parsed.label,
      mnemonic: parsed.mnemonic,
      operands: parsed.operands,
      comment: parsed.comment,
      locationChain: line.locationChain,
      location: line.location,
    };
  }

  private handleIfDirective(condition: string, isActive: boolean, location: SourceLocation): void {
    const frame: IfFrame = {
      type: "if",
      branches: [
        { condition, isActive },
        { condition: "1", isActive: !isActive }, // else branch
      ],
      currentBranchIndex: 0,
      activeBranchIndex: isActive ? 0 : undefined,
    };
    this.directiveStack.push(frame);
  }

  private handleElseifDirective(condition: string, symbols: ReadonlyMap<string, number>, location: SourceLocation): void {
    const frame = this.directiveStack[this.directiveStack.length - 1];
    if (!frame || frame.type !== "if") throw new Error(`.elseif without matching .if at ${location.filename}:${location.lineNumber}`);
    const isActive = this.evaluateCondition(condition, symbols);
    const currentBranch = frame.branches[frame.currentBranchIndex];
    if (currentBranch) {
      currentBranch.condition = condition;
      currentBranch.isActive = isActive;
    }
    if (frame.activeBranchIndex === undefined && isActive) {
      frame.activeBranchIndex = frame.currentBranchIndex;
    }
    frame.currentBranchIndex += 1;
    if (frame.branches.length <= frame.currentBranchIndex) {
      frame.branches.push({ condition: "1", isActive: false });
    }
  }

  private handleElseDirective(location: SourceLocation): void {
    const frame = this.directiveStack[this.directiveStack.length - 1];
    if (!frame || frame.type !== "if") throw new Error(`.else without matching .if at ${location.filename}:${location.lineNumber}`);
    frame.currentBranchIndex += 1;
    if (frame.branches.length <= frame.currentBranchIndex) {
      const isActive = frame.activeBranchIndex === undefined;
      frame.branches.push({ condition: "1", isActive });
      if (isActive) frame.activeBranchIndex = frame.currentBranchIndex;
    }
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
      const bodyParsed = parseLine(bodyLine.content, bodyLine.location.lineNumber);
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
    // Splice the body BEFORE the .endrepeat line (which is at this.lineIndex - 1)
    // This way, the body is at the correct position for the first iteration
    this.lines.splice(this.lineIndex - 1, 0, ...body);
  }

  private handleEndrepeatDirective(location: SourceLocation): void {
    const frame = this.directiveStack[this.directiveStack.length - 1];
    if (!frame || frame.type !== "repeat") throw new Error(`.endrepeat without matching .repeat at ${location.filename}:${location.lineNumber}`);
    if (frame.currentIteration < frame.count - 1) {
      frame.currentIteration += 1;
      // Create new TaggedLine objects with updated line numbers for this iteration
      // Each iteration should appear at a different position in the file
      const bodyWithUpdatedLineNumbers = frame.body.map((line, idx) => ({
        ...line,
        location: {
          ...line.location,
          lineNumber: line.location.lineNumber + (frame.body.length * frame.currentIteration)
        }
      }));
      this.lines.splice(this.lineIndex - 1, 0, ...bodyWithUpdatedLineNumbers);
    } else {
      this.directiveStack.pop();
    }
  }

  private handleIncludeDirective(line: SourceLine, location: SourceLocation): void {
    const pathOperand = line.operands[0];
    if (!pathOperand) throw new Error(`.include requires a file path at ${location.filename}:${location.lineNumber}`);
    const pathMatch = pathOperand.match(/^[\"'](.+)[\"']$/);
    if (!pathMatch) throw new Error(`.include path must be quoted at ${location.filename}:${location.lineNumber}`);
    const includePath = pathMatch[1]!;
    const resolvedPath = isAbsolute(includePath) ? resolve(includePath) : resolve(join(currentDir, includePath));
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
    });
    const expanded: TaggedLine[] = [];
    for (const bodyLine of macro.body) {
      let content = bodyLine.raw;
      for (const [param, value] of substitutions) {
        const regex = new RegExp(`\\b${param}\\b`, "g");
        content = content.replace(regex, value);
      }
      const loc = { ...bodyLine.location, parent: taggedLine.location };
      expanded.push({
        content,
        location: loc,
        locationChain: [loc, ...taggedLine.locationChain],
      });
    }
    return expanded;
  }

  private handleMacroDefinition(line: SourceLine, location: SourceLocation): void {
    const name = line.mnemonic!.toUpperCase();
    const parameters = line.operands;
    const body: SourceLine[] = [];
    let nesting = 0;
    while (this.lineIndex < this.lines.length) {
      const bodyLine = this.lines[this.lineIndex]!;
      this.lineIndex += 1;
      const bodyParsed = parseLine(bodyLine.content, bodyLine.location.lineNumber);
      if (bodyParsed.kind === "code") {
        const bodyMnemonic = bodyParsed.mnemonic?.toUpperCase();
        if (bodyMnemonic === ".MACRO") nesting += 1;
        else if (bodyMnemonic === ".ENDMACRO") {
          if (nesting === 0) break;
          nesting -= 1;
        }
      }
      body.push({
        lineNumber: bodyLine.location.lineNumber,
        raw: bodyLine.content,
        kind: bodyParsed.kind,
        label: bodyParsed.label,
        mnemonic: bodyParsed.mnemonic,
        operands: bodyParsed.operands,
        comment: bodyParsed.comment,
        locationChain: bodyLine.locationChain,
        location: bodyLine.location,
      });
    }
    this.macros.set(name, { type: "macro", name, parameters, body });
  }
}
