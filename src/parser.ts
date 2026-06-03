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
  const commentIndex = raw.indexOf(";");
  if (commentIndex < 0) {
    return [raw, undefined];
  }

  const codePart = raw.slice(0, commentIndex);
  const commentPart = raw.slice(commentIndex + 1).trim();
  return [codePart, commentPart.length > 0 ? commentPart : undefined];
}

function collectOperands(tokens: string[]): string[] {
  return tokens
    .join(" ")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function isLikelyLabel(token: string): boolean {
  return /^(?:@)?[A-Za-z_][A-Za-z0-9_]*$/.test(token);
}

function isOpcodeLike(token: string): boolean {
  return /^[A-Za-z]{3}$/.test(token);
}