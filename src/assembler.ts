import { parseSource } from "./parser.js";
import { evaluateExpression } from "./expressions.js";
import { branchMnemonics, modeSize, opcodes, type AddressingMode } from "./opcodes.js";
import { preprocessSource } from "./preprocessor.js";
import type { AssemblyDiagnostic, AssemblyResult, ListingLine, SourceLine, SymbolEntry } from "./types.js";

const MAX_PASSES = 10;

interface ModeResolution {
  readonly mode: AddressingMode;
  readonly value: number | null;
}

interface SizedLine {
  readonly size: number;
  readonly nextAddress: number;
}

interface PassState {
  readonly symbols: Map<string, number>;
  readonly lineSizes: number[];
  readonly startAddress: number;
  readonly endAddress: number;
}

export function assemble(sourceText: string): AssemblyResult {
  const parsed = parseSource(preprocessSource(sourceText));

  const sized = runSizingPasses(parsed);
  const diagnostics = collectDiagnostics(parsed, sized);
  const emitted = diagnostics.length === 0 ? emitBinary(parsed, sized) : { binary: new Uint8Array(), listing: buildListingOnly(parsed) };
  const symbols: SymbolEntry[] = Array.from(sized.symbols.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value }));

  return {
    binary: emitted.binary,
    listing: emitted.listing,
    symbols,
    startAddress: sized.startAddress,
    diagnostics,
  };
}

function runSizingPasses(lines: readonly SourceLine[]): PassState {
  let symbols = new Map<string, number>();
  let previousSizes = new Array<number>(lines.length).fill(0);
  let startAddress = 0;
  let endAddress = 0;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const nextSymbols = new Map<string, number>();
    const lineSizes: number[] = [];
    let location = 0;
    let hasOrigin = false;
    let minAddress = Number.POSITIVE_INFINITY;
    let maxAddress = Number.NEGATIVE_INFINITY;

    for (const line of lines) {
      if (line.kind !== "code") {
        lineSizes.push(0);
        continue;
      }

      if (line.label !== undefined && line.mnemonic?.toUpperCase() !== ".EQU") {
        const key = line.label.toUpperCase();
        nextSymbols.set(key, location & 0xffff);
      }

      if (line.label !== undefined && line.mnemonic?.toUpperCase() === ".EQU") {
        const expr = line.operands[0];
        const resolved = expr === undefined ? null : evaluateExpression(expr, symbols, location);
        if (resolved !== null) {
          nextSymbols.set(line.label.toUpperCase(), resolved);
        }
      }

      const sizedLine = sizeLine(line, location, symbols);
      lineSizes.push(sizedLine.size);

      if (line.mnemonic?.toUpperCase() === ".ORG") {
        hasOrigin = true;
        minAddress = Math.min(minAddress, sizedLine.nextAddress);
        location = sizedLine.nextAddress;
        continue;
      }

      if (sizedLine.size > 0) {
        minAddress = Math.min(minAddress, location);
        maxAddress = Math.max(maxAddress, location + sizedLine.size - 1);
      }

      location = sizedLine.nextAddress;
    }

    if (minAddress === Number.POSITIVE_INFINITY) {
      minAddress = hasOrigin ? 0 : 0;
      maxAddress = minAddress;
    }

    const symbolsStable = mapsEqual(symbols, nextSymbols);
    const sizesStable = arraysEqual(previousSizes, lineSizes);
    symbols = nextSymbols;
    previousSizes = lineSizes;
    startAddress = minAddress & 0xffff;
    endAddress = Math.max(maxAddress, startAddress) & 0xffff;

    if (symbolsStable && sizesStable) {
      return { symbols, lineSizes, startAddress, endAddress };
    }
  }

  return { symbols, lineSizes: previousSizes, startAddress, endAddress };
}

function collectDiagnostics(lines: readonly SourceLine[], passState: PassState): AssemblyDiagnostic[] {
  const diagnostics: AssemblyDiagnostic[] = [];
  let location = passState.startAddress;

  for (const line of lines) {
    if (line.kind !== "code") {
      continue;
    }

    const mnemonic = line.mnemonic?.toUpperCase();
    if (mnemonic === undefined) {
      continue;
    }

    if (mnemonic === ".ORG") {
      const expression = line.operands[0];
      if (expression === undefined) {
        diagnostics.push(makeDiagnostic(line, ".org requires an expression operand"));
      } else if (evaluateExpression(expression, passState.symbols, location) === null) {
        diagnostics.push(makeDiagnostic(line, `Unable to resolve .org expression: ${expression}`));
      }
      continue;
    }

    if (mnemonic === ".EQU") {
      if (line.label === undefined) {
        diagnostics.push(makeDiagnostic(line, ".equ requires a label"));
      }
      const expression = line.operands[0];
      if (expression === undefined) {
        diagnostics.push(makeDiagnostic(line, ".equ requires an expression operand"));
      } else if (evaluateExpression(expression, passState.symbols, location) === null) {
        diagnostics.push(makeDiagnostic(line, `Unable to resolve .equ expression: ${expression}`));
      }
      continue;
    }

    if (mnemonic === ".BYTE") {
      line.operands.forEach((expression) => {
        if (evaluateExpression(expression, passState.symbols, location) === null) {
          diagnostics.push(makeDiagnostic(line, `Unable to resolve byte expression: ${expression}`));
        }
      });
      location += line.operands.length;
      continue;
    }

    if (mnemonic === ".WORD") {
      line.operands.forEach((expression) => {
        if (evaluateExpression(expression, passState.symbols, location) === null) {
          diagnostics.push(makeDiagnostic(line, `Unable to resolve word expression: ${expression}`));
        }
      });
      location += line.operands.length * 2;
      continue;
    }

    const opcodeTable = opcodes[mnemonic];
    if (opcodeTable === undefined) {
      diagnostics.push(makeDiagnostic(line, `Unknown mnemonic: ${mnemonic}`));
      continue;
    }

    const resolved = resolveMode(mnemonic, line.operands, opcodeTable, passState.symbols, location, false);
    if (opcodeTable[resolved.mode] === undefined) {
      diagnostics.push(makeDiagnostic(line, `Unsupported addressing mode for ${mnemonic}: ${resolved.mode}`));
      continue;
    }

    if (modeNeedsValue(resolved.mode) && resolved.value === null) {
      diagnostics.push(makeDiagnostic(line, `Unable to resolve operand expression: ${line.operands.join(", ")}`));
      continue;
    }

    if (resolved.mode === "relative") {
      const branchOffset = computeBranchOffset(resolved.value ?? 0, location);
      if (branchOffset < -128 || branchOffset > 127) {
        diagnostics.push(makeDiagnostic(line, `Branch out of range at ${toHex16(location)}`));
        continue;
      }
    }

    location += modeSize(resolved.mode);
  }

  return diagnostics;
}

function buildListingOnly(lines: readonly SourceLine[]): ListingLine[] {
  return lines.map((line) => ({
    address: line.kind === "code" ? 0 : null,
    bytes: [],
    source: line.raw,
  }));
}

function sizeLine(line: SourceLine, location: number, symbols: ReadonlyMap<string, number>): SizedLine {
  const mnemonic = line.mnemonic?.toUpperCase();
  if (mnemonic === undefined) {
    return { size: 0, nextAddress: location };
  }

  if (mnemonic === ".ORG") {
    const expr = line.operands[0];
    const resolved = expr === undefined ? location : evaluateExpression(expr, symbols, location);
    return { size: 0, nextAddress: (resolved ?? location) & 0xffff };
  }

  if (mnemonic === ".EQU") {
    return { size: 0, nextAddress: location };
  }

  if (mnemonic === ".BYTE") {
    return { size: line.operands.length, nextAddress: location + line.operands.length };
  }

  if (mnemonic === ".WORD") {
    const size = line.operands.length * 2;
    return { size, nextAddress: location + size };
  }

  const table = opcodes[mnemonic];
  if (table === undefined) {
    return { size: 0, nextAddress: location };
  }

  const resolved = resolveMode(mnemonic, line.operands, table, symbols, location, true);
  const size = modeSize(resolved.mode);
  return { size, nextAddress: location + size };
}

function emitBinary(lines: readonly SourceLine[], passState: PassState): { binary: Uint8Array; listing: ListingLine[] } {
  const bytes = new Map<number, number>();
  const listing: ListingLine[] = [];
  let location = passState.startAddress;
  let minAddress = Number.POSITIVE_INFINITY;
  let maxAddress = Number.NEGATIVE_INFINITY;

  for (const line of lines) {
    if (line.kind !== "code") {
      listing.push({ address: null, bytes: [], source: line.raw });
      continue;
    }

    const mnemonic = line.mnemonic?.toUpperCase();
    if (mnemonic === undefined) {
      listing.push({ address: location & 0xffff, bytes: [], source: line.raw });
      continue;
    }

    if (mnemonic === ".ORG") {
      const target = evaluateExpression(line.operands[0] ?? "0", passState.symbols, location) ?? location;
      location = target & 0xffff;
      listing.push({ address: location, bytes: [], source: line.raw });
      continue;
    }

    if (mnemonic === ".EQU") {
      listing.push({ address: location & 0xffff, bytes: [], source: line.raw });
      continue;
    }

    if (mnemonic === ".BYTE") {
      const emitted = line.operands.map((expr) => (evaluateExpression(expr, passState.symbols, location) ?? 0) & 0xff);
      writeBytes(bytes, location, emitted);
      listing.push({ address: location & 0xffff, bytes: emitted, source: line.raw });
      if (emitted.length > 0) {
        minAddress = Math.min(minAddress, location);
        maxAddress = Math.max(maxAddress, location + emitted.length - 1);
      }
      location += emitted.length;
      continue;
    }

    if (mnemonic === ".WORD") {
      const emitted: number[] = [];
      for (const expr of line.operands) {
        const value = (evaluateExpression(expr, passState.symbols, location) ?? 0) & 0xffff;
        emitted.push(value & 0xff, (value >> 8) & 0xff);
      }
      writeBytes(bytes, location, emitted);
      listing.push({ address: location & 0xffff, bytes: emitted, source: line.raw });
      if (emitted.length > 0) {
        minAddress = Math.min(minAddress, location);
        maxAddress = Math.max(maxAddress, location + emitted.length - 1);
      }
      location += emitted.length;
      continue;
    }

    const opcodeTable = opcodes[mnemonic];
    if (opcodeTable === undefined) {
      listing.push({ address: location & 0xffff, bytes: [], source: line.raw });
      continue;
    }

    const resolved = resolveMode(mnemonic, line.operands, opcodeTable, passState.symbols, location, false);
    const opcode = opcodeTable[resolved.mode];
    if (opcode === undefined) {
      listing.push({ address: location & 0xffff, bytes: [], source: line.raw });
      continue;
    }

    const emitted = encodeInstruction(opcode, resolved, location);
    writeBytes(bytes, location, emitted);
    listing.push({ address: location & 0xffff, bytes: emitted, source: line.raw });
    minAddress = Math.min(minAddress, location);
    maxAddress = Math.max(maxAddress, location + emitted.length - 1);
    location += emitted.length;
  }

  if (minAddress === Number.POSITIVE_INFINITY || maxAddress === Number.NEGATIVE_INFINITY) {
    return { binary: new Uint8Array(), listing };
  }

  const binary = new Uint8Array(maxAddress - minAddress + 1);
  for (const [address, value] of bytes.entries()) {
    binary[address - minAddress] = value;
  }

  return { binary, listing };
}

function resolveMode(
  mnemonic: string,
  operands: readonly string[],
  table: Partial<Record<AddressingMode, number>>,
  symbols: ReadonlyMap<string, number>,
  location: number,
  conservative: boolean,
): ModeResolution {
  const operand = operands.join(", ").trim();

  if (branchMnemonics.has(mnemonic)) {
    const value = operand.length > 0 ? evaluateExpression(operand, symbols, location) : null;
    return { mode: "relative", value };
  }

  if (operand.length === 0) {
    return { mode: "implied", value: null };
  }

  if (/^A$/i.test(operand)) {
    return { mode: "accumulator", value: null };
  }

  const immediate = operand.match(/^#\s*(.+)$/i);
  if (immediate) {
    const expr = immediate[1];
    return { mode: "immediate", value: expr === undefined ? null : evaluateExpression(expr, symbols, location) };
  }

  const indexedIndirect = operand.match(/^\(\s*(.+)\s*,\s*X\s*\)$/i);
  if (indexedIndirect) {
    const expr = indexedIndirect[1];
    return {
      mode: "indexedIndirect",
      value: expr === undefined ? null : evaluateExpression(expr, symbols, location),
    };
  }

  const indirectIndexed = operand.match(/^\(\s*(.+)\s*\)\s*,\s*Y\s*$/i);
  if (indirectIndexed) {
    const expr = indirectIndexed[1];
    return {
      mode: "indirectIndexed",
      value: expr === undefined ? null : evaluateExpression(expr, symbols, location),
    };
  }

  const indirect = operand.match(/^\(\s*(.+)\s*\)$/i);
  if (indirect) {
    const expr = indirect[1];
    return { mode: "indirect", value: expr === undefined ? null : evaluateExpression(expr, symbols, location) };
  }

  const xIndexed = operand.match(/^(.+)\s*,\s*X\s*$/i);
  if (xIndexed) {
    const expr = xIndexed[1];
    const value = expr === undefined ? null : evaluateExpression(expr, symbols, location);
    if (table.zeropageX !== undefined && (value !== null ? value <= 0xff : !conservative)) {
      return { mode: "zeropageX", value };
    }
    return { mode: "absoluteX", value };
  }

  const yIndexed = operand.match(/^(.+)\s*,\s*Y\s*$/i);
  if (yIndexed) {
    const expr = yIndexed[1];
    const value = expr === undefined ? null : evaluateExpression(expr, symbols, location);
    if (table.zeropageY !== undefined && (value !== null ? value <= 0xff : !conservative)) {
      return { mode: "zeropageY", value };
    }
    return { mode: "absoluteY", value };
  }

  const value = evaluateExpression(operand, symbols, location);
  if (table.zeropage !== undefined && (value !== null ? value <= 0xff : !conservative)) {
    return { mode: "zeropage", value };
  }
  return { mode: "absolute", value };
}

function encodeInstruction(opcode: number, modeResolution: ModeResolution, location: number): number[] {
  const value = modeResolution.value ?? 0;

  switch (modeResolution.mode) {
    case "implied":
    case "accumulator":
      return [opcode];
    case "immediate":
    case "zeropage":
    case "zeropageX":
    case "zeropageY":
    case "indexedIndirect":
    case "indirectIndexed":
      return [opcode, value & 0xff];
    case "relative": {
      const signed = computeBranchOffset(value, location);
      if (signed < -128 || signed > 127) {
        throw new Error(`Branch out of range at ${toHex16(location)}`);
      }
      return [opcode, signed & 0xff];
    }
    case "absolute":
    case "absoluteX":
    case "absoluteY":
    case "indirect":
      return [opcode, value & 0xff, (value >> 8) & 0xff];
  }
}

function computeBranchOffset(target: number, location: number): number {
  const nextPc = (location + 2) & 0xffff;
  const delta = ((target & 0xffff) - nextPc) & 0xffff;
  return delta > 0x7f ? delta - 0x10000 : delta;
}

function modeNeedsValue(mode: AddressingMode): boolean {
  return mode !== "implied" && mode !== "accumulator";
}

function makeDiagnostic(line: SourceLine, message: string): AssemblyDiagnostic {
  return {
    lineNumber: line.lineNumber,
    message,
    source: line.raw,
  };
}

function writeBytes(target: Map<number, number>, address: number, values: readonly number[]): void {
  values.forEach((value, index) => {
    target.set((address + index) & 0xffff, value & 0xff);
  });
}

function toHex16(value: number): string {
  return `$${(value & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
}

function arraysEqual(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }

  return true;
}

function mapsEqual(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [key, value] of left.entries()) {
    if (right.get(key) !== value) {
      return false;
    }
  }

  return true;
}