import type { SourceLine } from "./types.js";

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
  } else if (tokens.length === 1 && isLikelyLabel(firstToken) && !isOpcodeLike(firstToken)) {
    label = firstToken;
    mnemonic = undefined;
    operands = [];
  } else if (tokens.length >= 2 && isLikelyLabel(firstToken) && !isOpcodeLike(firstToken)) {
    label = firstToken;
    mnemonic = secondToken;
    operands = collectOperands(tokens.slice(2));
  } else {
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

function isOpcodeLike(token: string): boolean {
  return /^[A-Za-z]{3}$/.test(token);
}