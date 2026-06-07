import { getDirectiveMetadata, isDirective } from "./directives.js";

import type { SourceLine } from "./types.js";
import { opcodes } from "./opcodes.js";

const commentOnlyPattern = /^\s*(?:[;*].*)?$/;

/**
 * Set of known macro names (populated by preprocessor)
 */
let knownMacros: Set<string> = new Set();

/**
 * Set the known macros (called by preprocessor before parsing)
 */
export function setKnownMacros(macros: Set<string>): void {
  knownMacros = new Set(macros);
}

/**
 * Check if a token is a known macro
 */
function isKnownMacro(token: string): boolean {
  return knownMacros.has(token.toUpperCase());
}

export function parseSource(text: string): SourceLine[] {
  const lines = text.split(/\r?\n/);

  return lines.map((raw, index) => parseLine(raw, index + 1));
}

export function parseLine(raw: string, lineNumber: number): SourceLine {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { lineNumber, raw, kind: "blank", operands: [], locationChain: [] };
  }

  if (commentOnlyPattern.test(raw)) {
    return { lineNumber, raw, kind: "comment", operands: [], locationChain: [] };
  }

  const [codePart, commentPart] = splitComment(raw);

  // Normalize spacing around = operator (but not == or !=)
  // This allows `count=5` to be parsed the same as `count = 5`
  const normalized = codePart
    .split(/\s*((?:[.@]?\w+:?)|"[^"]*"|'[^']*'|[^.@:"'\w\s]+)\s*/)
    .join(" ");

  const tokens = normalized.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return { lineNumber, raw, kind: "comment", operands: [], locationChain: [] };
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
    !isKnownMnemonic(firstToken) &&
    !isKnownMacro(firstToken)
  ) {
    label = firstToken;
    mnemonic = undefined;
    operands = [];
  } else if (
    tokens.length >= 2 &&
    isLikelyLabel(firstToken) &&
    secondToken !== undefined &&
    isDirectiveOrAssignment(secondToken)
  ) {
    label = firstToken;
    mnemonic = secondToken;
    operands = collectOperands(tokens.slice(2));
  } else if (
    tokens.length >= 2 &&
    isLikelyLabel(firstToken) &&
    !isKnownMnemonic(firstToken) &&
    !isKnownMacro(firstToken)
  ) {
    label = firstToken;
    mnemonic = secondToken;
    operands = collectOperands(tokens.slice(2));
  } else if (isKnownMacro(firstToken)) {
    mnemonic = firstToken;
    operands = collectOperands(tokens.slice(1));
  } else {
    mnemonic = firstToken;
    operands = collectOperands(tokens.slice(1));
  }

  return {
    lineNumber,
    raw,
    kind: "code",
    operands,
    locationChain: [],
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

function isKnownMnemonic(token: string): boolean {
  const upper = token.toUpperCase();
  return opcodes[upper] !== undefined || isDirective(upper);
}

function isDirectiveOrAssignment(token: string): boolean {
  const upper = token.toUpperCase();
  return isDirective(upper);
}
