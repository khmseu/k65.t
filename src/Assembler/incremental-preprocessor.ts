import * as fs from "fs";
import { URL } from "url";
import { parse } from "path";

export interface TaggedLine {
  content: string;
  location: SourceLocation;
}

export interface SourceLocation {
  filename: string;
  lineNumber: number;
}

export interface DirectiveFrame {
  type: "macro" | "if" | "repeat";
  startLineNumber: number;
  startLocation: SourceLocation;
  count?: number;
  body?: TaggedLine[];
  currentIteration?: number;
  lineIndex?: number;
  condition?: boolean;
}

/**
 * Incrementally preprocesses source code, handling macros, conditionals, and repeats.
 * Returns lines with their original source locations preserved.
 */
export class IncrementalPreprocessor {
  private lines: TaggedLine[];
  private lineIndex: number = 0;
  private directiveStack: DirectiveFrame[] = [];
  private macros: Map<string, TaggedLine[]> = new Map();
  private filename: string;

  constructor(source: string, options?: { sourcePath?: string }) {
    this.filename = options?.sourcePath ?? "<source>";
    const sourceLines = source.split(/\r?\n/);
    this.lines = sourceLines.map((content, index) => ({
      content,
      location: { filename: this.filename, lineNumber: index + 1 },
    }));
  }

  nextLine(symbols: Map<string, unknown>): TaggedLine | null {
    while (this.lineIndex < this.lines.length) {
      const tagged = this.lines[this.lineIndex]!;
      this.lineIndex += 1;

      const processed = this.processTaggedLine(tagged, symbols);
      if (processed !== null) {
        return processed;
      }
    }
    return null;
  }

  private processTaggedLine(
    tagged: TaggedLine,
    symbols: Map<string, unknown>,
  ): TaggedLine | null {
    const line = tagged.content;
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("*")) {
      return tagged;
    }

    // Check if we're in an inactive conditional
    for (const frame of this.directiveStack) {
      if (frame.type === "if" && frame.condition === false) {
        // Skip lines in inactive conditionals
        return null;
      }
    }

    // Parse the line to check for directives
    const mnemonic = trimmed.split(/\s+/)[0]?.toUpperCase();

    // Handle macro definition
    if (mnemonic === ".MACRO") {
      this.handleMacroDirective(tagged.location);
      return null;
    }

    // Handle macro expansion
    if (mnemonic && this.macros.has(mnemonic)) {
      return this.expandMacro(mnemonic, tagged.location);
    }

    // Handle conditional directives
    if (mnemonic === ".IF") {
      this.handleIfDirective(tagged.location);
      return null;
    }

    if (mnemonic === ".ENDIF") {
      this.handleEndifDirective(tagged.location);
      return null;
    }

    // Handle repeat directive
    if (mnemonic === ".REPEAT") {
      this.handleRepeatDirective(tagged.location);
      return null;
    }

    if (mnemonic === ".ENDREPEAT") {
      this.handleEndrepeatDirective(tagged.location);
      return null;
    }

    return tagged;
  }

  private handleMacroDirective(location: SourceLocation): void {
    const line = this.lines[this.lineIndex - 1]!.content;
    const match = line.match(/\.MACRO\s+([A-Za-z0-9_]+)/i);
    if (!match) return;

    const macroName = match[1]!.toUpperCase();
    const body: TaggedLine[] = [];
    let nesting = 0;

    while (this.lineIndex < this.lines.length) {
      const bodyLine = this.lines[this.lineIndex]!;
      this.lineIndex += 1;
      const bodyParsed = bodyLine.content.trim().toUpperCase();

      if (bodyParsed.startsWith(".MACRO")) nesting += 1;
      else if (bodyParsed.startsWith(".ENDMACRO")) {
        if (nesting === 0) break;
        nesting -= 1;
      }

      body.push(bodyLine);
    }

    this.macros.set(macroName, body);
  }

  private expandMacro(
    macroName: string,
    location: SourceLocation,
  ): TaggedLine | null {
    const body = this.macros.get(macroName);
    if (!body) return null;

    // Insert the macro body into the lines array
    const expandedBody = body.map((line) => ({
      ...line,
      location: {
        ...line.location,
        filename: `<macro:${macroName}>`,
      },
    }));

    this.lines.splice(this.lineIndex - 1, 1, ...expandedBody);
    this.lineIndex -= 1; // Back up to re-process the first line of the macro

    return this.nextLine(new Map());
  }

  private handleIfDirective(location: SourceLocation): void {
    const line = this.lines[this.lineIndex - 1]!.content;
    const match = line.match(/\.IF\s+(.*)/i);
    if (!match) {
      this.directiveStack.push({
        type: "if",
        startLineNumber: location.lineNumber,
        startLocation: location,
        condition: true,
      });
      return;
    }

    const condition = this.evaluateCondition(match[1]!);
    this.directiveStack.push({
      type: "if",
      startLineNumber: location.lineNumber,
      startLocation: location,
      condition,
    });
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

  private handleRepeatDirective(location: SourceLocation): void {
    const line = this.lines[this.lineIndex - 1]!.content;
    const match = line.match(/\.REPEAT\s+(\d+)/i);
    if (!match) return;

    const count = parseInt(match[1]!, 10);
    const body: TaggedLine[] = [];
    let nesting = 0;

    while (this.lineIndex < this.lines.length) {
      const bodyLine = this.lines[this.lineIndex]!;
      this.lineIndex += 1;
      const bodyMnemonic = bodyLine.content.trim().split(/\s+/)[0]?.toUpperCase();

      if (bodyMnemonic === ".REPEAT") nesting += 1;
      else if (bodyMnemonic === ".ENDREPEAT") {
        if (nesting === 0) break;
        nesting -= 1;
      }

      body.push(bodyLine);
    }

    this.directiveStack.push({
      type: "repeat",
      startLineNumber: location.lineNumber,
      startLocation: location,
      count,
      body,
      currentIteration: 0,
      lineIndex: this.lineIndex,
    });

    // Splice the body into the lines array for the first iteration
    this.lines.splice(this.lineIndex - body.length - 1, 0, ...body);
  }

  private handleEndrepeatDirective(location: SourceLocation): void {
    const frame = this.directiveStack[this.directiveStack.length - 1];
    if (!frame || frame.type !== "repeat")
      throw new Error(
        `.endrepeat without matching .repeat at ${location.filename}:${location.lineNumber}`,
      );
    if (frame.currentIteration! < frame.count! - 1) {
      frame.currentIteration! += 1;
      this.lines.splice(this.lineIndex, 0, ...frame.body!);
    } else {
      this.directiveStack.pop();
    }
  }

  private evaluateCondition(expr: string): boolean {
    // Simple condition evaluation - just check if it's non-zero or non-empty
    return expr.trim() !== "0" && expr.trim() !== "";
  }
}
