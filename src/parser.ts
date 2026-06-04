import type { SourceLine } from "./types.js";
import { isDirective } from "./directives.js";
import { opcodes } from "./opcodes.js";

const commentOnlyPattern = /^\s*(?:[;*].*)?$/;

export function parseSource(text: string): SourceLine[] {
  const lines = text.split(/\r?\n/);

  return lines.map((raw, index) => parseLine(raw, index + 1));
}

function parseLine(raw: string, lineNumber: number): SourceLine {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { lineNumber, raw, kind: "blank", operands: [] };
  }

  if (commentOnlyPattern.test(raw)) {
    return { lineNumber, raw, kind: "comment", operands: [] };
  }

  const [codePart, commentPart] = splitComment(raw);
  const tokens = codePart.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return { lineNumber, raw, kind: "comment", operands: [] };
  }

  const firstToken = tokens[0]!;
  const secondToken = tokens[1];
  let label: string | undefined;
  let mnemonic: string | undefined;
  let operands: string[] = [];

  if (firstToken.endsWith(":")) {
    label = firstToken.slice(0, -1);
    mnemonic = secondToken;
    operands = collectOperands(tokens.slice(2));
  } else if (
    tokens.length === 1 &&
    isLikelyLabel(firstToken) &&
    !isKnownMnemonic(firstToken)
  ) {
    // Single token that looks like a label and is not a known mnemonic
    label = firstToken;
    mnemonic = undefined;
    operands = [];
  } else if (
    tokens.length >= 2 &&
    isLikelyLabel(firstToken) &&
    secondToken !== undefined &&
    isDirectiveOrAssignment(secondToken)
  ) {
    // First token is a label, second token is a directive or assignment operator.
    // Treat as label + directive even if first token looks opcode-like.
    // E.g., "ADC = 100", "LDA .equ 10", "VAL .set 5"
    label = firstToken;
    mnemonic = secondToken;
    operands = collectOperands(tokens.slice(2));
  } else if (
    tokens.length >= 2 &&
    isLikelyLabel(firstToken) &&
    !isKnownMnemonic(firstToken)
  ) {
    // Two+ tokens, first looks like label, second is not a known mnemonic/directive.
    // E.g., "LOOP LDA #1"
    label = firstToken;
    mnemonic = secondToken;
    operands = collectOperands(tokens.slice(2));
  } else {
    // Default: first token is a mnemonic (opcode or directive)
    mnemonic = firstToken;
    operands = collectOperands(tokens.slice(1));
  }

  return {
    lineNumber,
    raw,
    kind: "code",
    operands,
    ...(label !== undefined ? { label } : {}),
    ...(mnemonic !== undefined ? { mnemonic } : {}),
    ...(commentPart !== undefined ? { comment: commentPart } : {}),
  };
}

function splitComment(raw: string): [string, string | undefined] {
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;

    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === ";") {
      const codePart = raw.slice(0, i);
      const commentPart = raw.slice(i + 1).trim();
      return [codePart, commentPart.length > 0 ? commentPart : undefined];
    }
  }

  return [raw, undefined];
}

function collectOperands(tokens: string[]): string[] {
  const text = tokens.join(" ");
  if (text.trim().length === 0) {
    return [];
  }

  const operands: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let parenDepth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (quote !== undefined) {
      current += ch;

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "(") {
      parenDepth += 1;
      current += ch;
      continue;
    }

    if (ch === ")") {
      if (parenDepth > 0) {
        parenDepth -= 1;
      }
      current += ch;
      continue;
    }

    if (ch === "," && parenDepth === 0) {
      const operand = current.trim();
      if (operand.length > 0) {
        operands.push(operand);
      }
      current = "";
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    operands.push(tail);
  }

  return operands;
}

function isLikelyLabel(token: string): boolean {
  return /^(?:@)?[A-Za-z_][A-Za-z0-9_]*$/.test(token);
}

/**
 * Check if a token is a known mnemonic (opcode or directive).
 * Uses lookup-based validation instead of heuristics like "3 letters = opcode".
 */
function isKnownMnemonic(token: string): boolean {
  const upper = token.toUpperCase();
  return opcodes[upper] !== undefined || isDirective(upper);
}

/**
 * Check if a token is a directive or assignment operator.
 * Used to determine if a 3-letter identifier should be treated as a label.
 * E.g., "ADC = 100" → label="ADC" (not mnemonic="ADC")
 */
function isDirectiveOrAssignment(token: string): boolean {
  const upper = token.toUpperCase();
  return (
    upper === "=" || upper === ".EQU" || upper === ".SET" || isDirective(upper)
  );
}
