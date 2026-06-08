import { isDirective } from "./directives.js";
import type { SourceLine } from "./types.js";
import { opcodes } from "./opcodes.js";

const commentOnlyPattern = /^\s*(?:[;*].*)?$/;
let knownMacros: Set<string> = new Set();

export function setKnownMacros(macros: Set<string>): void {
  knownMacros = new Set(macros);
}

function isKnownMacro(token: string): boolean {
  return knownMacros.has(token.toUpperCase());
}

function isKnownMnemonic(token: string): boolean {
  const upper = token.toUpperCase();
  return opcodes[upper] !== undefined || isDirective(upper);
}

function looksLikeLabel(token: string): boolean {
  return /^(?:@)?[A-Za-z_][A-Za-z0-9_]*$/.test(token);
}

export function parseSource(text: string): SourceLine[] {
  return text.split(/\r?\n/).map((raw, index) => parseLine(raw, index + 1));
}

/**
 * Parse a single line of assembly source.
 *
 * Grammar (after stripping comments):
 *   line    ::= blank | comment | code
 *   code    ::= [label [':' | '=']] [mnemonic [operands]]
 *   label   ::= /[A-Za-z_@][A-Za-z0-9_]* /
 *   mnemonic::= opcode | directive | macro-name
 *   operands::= operand (',' operand)*
 *
 * Rules for distinguishing label vs mnemonic when no colon is present:
 *   - Token followed by '=' -> it is a label with '=' as mnemonic
 *   - Token is a known directive/opcode/macro -> it is a mnemonic (no label)
 *   - Token looks like a label AND next token is directive/opcode/macro -> label + mnemonic
 *   - Token looks like a label AND next token is unknown -> label + mnemonic (unrecognised mnemonic)
 *   - Single token that looks like a label -> label-only anchor
 *   - Single token that is a known mnemonic -> mnemonic-only
 */
export function parseLine(raw: string, lineNumber: number): SourceLine {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { lineNumber, raw, kind: "blank", operands: [], locationChain: [] };
  }
  if (commentOnlyPattern.test(raw)) {
    return { lineNumber, raw, kind: "comment", operands: [], locationChain: [] };
  }

  const [codePart, commentPart] = splitComment(raw);
  const text = codePart.trim();
  if (text.length === 0) {
    return { lineNumber, raw, kind: "comment", operands: [], locationChain: [] };
  }

  let parts = splitTopLevelWhitespace(text);
  if (parts.length === 0) {
    return { lineNumber, raw, kind: "comment", operands: [], locationChain: [] };
  }

  // Normalize compact assignment forms: "a=b" -> ["a", "=", "b"]
  // Also handles "a =b" -> ["a", "=b"] -> ["a", "=", "b"]
  // and "a= b" -> ["a=", "b"] -> ["a", "=", "b"]
  if (parts.length >= 1) {
    const first = parts[0]!;
    const eqInFirst = /^([A-Za-z_@][A-Za-z0-9_]*)=(.*)$/.exec(first);
    if (eqInFirst) {
      // "a=b" or "a=": split into ["a", "=", "b", ...rest]
      const rest = eqInFirst[2]!.length > 0
        ? [eqInFirst[2]!, ...parts.slice(1)]
        : parts.slice(1);
      parts = [eqInFirst[1]!, "=", ...rest];
    } else if (parts.length >= 2) {
      const second = parts[1]!;
      if (second.startsWith("=") && second.length > 1) {
        // "a =expr": split "=expr" into ["=", "expr"]
        parts = [first, "=", second.slice(1), ...parts.slice(2)];
      } else if (first.endsWith("=") && looksLikeLabel(first.slice(0, -1))) {
        // "a= b": "a=" -> ["a", "="]
        parts = [first.slice(0, -1), "=", ...parts.slice(1)];
      }
    }
  }

  let label: string | undefined;
  let mnemonic: string | undefined;
  let operandStart = 0;

  // --- Case 1: explicit colon label ---
  if (parts[0]!.endsWith(":")) {
    label = parts[0]!.slice(0, -1);
    if (parts.length === 1) {
      // label-only with colon
      return {
        lineNumber, raw, kind: "code", label, operands: [], locationChain: [],
        ...(commentPart !== undefined ? { comment: commentPart } : {}),
      };
    }
    const candidate = parts[1]!;
    if (
      candidate === "=" ||
      isDirective(candidate.toUpperCase()) ||
      isKnownMnemonic(candidate) ||
      isKnownMacro(candidate)
    ) {
      mnemonic = candidate;
      operandStart = 2;
    } else {
      // label: followed by unknown token -- treat as label + mnemonic
      mnemonic = candidate;
      operandStart = 2;
    }

  // --- Case 2: assignment  label = expr  or  label = expr  ---
  } else if (parts.length >= 2 && parts[1] === "=") {
    label = parts[0]!;
    mnemonic = "=";
    operandStart = 2;

  // --- Case 3: first token looks like label, second is directive/opcode/macro ---
  } else if (
    parts.length >= 2 &&
    looksLikeLabel(parts[0]!) &&
    (
      isDirective(parts[1]!.toUpperCase()) ||
      isKnownMnemonic(parts[1]!) ||
      isKnownMacro(parts[1]!) ||
      parts[1] === "="
    )
  ) {
    label = parts[0]!;
    mnemonic = parts[1]!;
    operandStart = 2;

  // --- Case 4: single known mnemonic ---
  } else if (parts.length === 1 && (isKnownMnemonic(parts[0]!) || isKnownMacro(parts[0]!))) {
    mnemonic = parts[0]!;
    operandStart = 1;

  // --- Case 5: single label-only anchor ---
  } else if (parts.length === 1 && looksLikeLabel(parts[0]!)) {
    label = parts[0]!;
    operandStart = 1;

  // --- Case 6: first token is a known mnemonic ---
  } else if (isKnownMnemonic(parts[0]!) || isKnownMacro(parts[0]!)) {
    mnemonic = parts[0]!;
    operandStart = 1;

  // --- Case 7: label + unknown mnemonic (e.g. "start loadpair 1, 2" when
  //     macros haven't been registered yet, or an unknown directive) ---
  } else if (parts.length >= 2 && looksLikeLabel(parts[0]!)) {
    label = parts[0]!;
    mnemonic = parts[1]!;
    operandStart = 2;

  // --- Case 8: fallback -- treat first token as mnemonic ---
  } else {
    mnemonic = parts[0]!;
    operandStart = 1;
  }

  const operands = splitOperands(parts.slice(operandStart).join(" "));
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitComment(raw: string): [string, string | undefined] {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote !== undefined) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ";") {
      const commentText = raw.slice(i + 1).trim();
      return [raw.slice(0, i), commentText.length > 0 ? commentText : undefined];
    }
  }
  return [raw, undefined];
}

/**
 * Split on top-level whitespace only (respecting quotes and parentheses).
 * This preserves expression tokens like $8000, #$01, (base+3)*2 intact.
 * A string literal immediately following a non-space token is treated as
 * a separate token (e.g. DCI"END" -> ["DCI", '"END"']).
 * When a quoted string closes and is followed by a non-whitespace character,
 * the string is pushed as its own token to allow macros like ABC"TEXT" to
 * parse correctly with ABC as mnemonic and "TEXT" as operand.
 */
function splitTopLevelWhitespace(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== undefined) {
      cur += ch;
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) {
        quote = undefined;
        // String is complete. If next char is non-whitespace and non-paren,
        // this string should be its own token (don't let it merge with following chars)
        if (i + 1 < text.length) {
          const nextCh = text[i + 1]!;
          if (!/\s|[().]/.test(nextCh)) {
            // Push the string as its own token
            out.push(cur);
            cur = "";
          }
        }
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Split string literal off from a preceding non-string token
      if (cur.length > 0) { out.push(cur); cur = ""; }
      quote = ch; cur += ch; continue;
    }
    if (ch === "(") { depth += 1; cur += ch; continue; }
    if (ch === ")") { if (depth > 0) depth -= 1; cur += ch; continue; }
    if (/\s/.test(ch) && depth === 0) {
      if (cur.length > 0) { out.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Split operands on top-level commas (respecting quotes and parentheses).
 */
function splitOperands(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (quote !== undefined) {
      cur += ch;
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(") { depth += 1; cur += ch; continue; }
    if (ch === ")") { if (depth > 0) depth -= 1; cur += ch; continue; }
    if (ch === "," && depth === 0) {
      if (cur.trim().length > 0) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}
