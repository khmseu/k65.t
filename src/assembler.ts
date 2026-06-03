import { parseSource } from "./parser.js";
import { evaluateExpression, evaluateExpressionDetailed } from "./expressions.js";
import { branchMnemonics, modeSize, opcodes, type AddressingMode } from "./opcodes.js";
import { PreprocessError, preprocessSource } from "./preprocessor.js";
import type { AssemblyDiagnostic, AssemblyResult, ListingLine, SourceLine, SymbolEntry } from "./types.js";

const MAX_PASSES = 10;
const CHEAP_LABEL_PREFIX = "__CHEAP_LABEL__";
const CHEAP_LABEL_ROOT = "ROOT";

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
  readonly lineSymbols: ReadonlyArray<ReadonlyMap<string, number>>;
  readonly lineScopes: ReadonlyArray<string | undefined>;
  readonly lineSizes: number[];
  readonly startAddress: number;
  readonly endAddress: number;
}

export interface AssembleOptions {
  readonly sourcePath?: string;
  readonly readFile?: (filePath: string) => string;
}

export function assemble(sourceText: string, options: AssembleOptions = {}): AssemblyResult {
  let preprocessed: string;
  try {
    preprocessed = preprocessSource(sourceText, {
      ...(options.sourcePath !== undefined ? { sourcePath: options.sourcePath } : {}),
      ...(options.readFile !== undefined ? { readFile: options.readFile } : {}),
    });
  } catch (error) {
    const diagnostic = mapPreprocessError(error);
    return {
      binary: new Uint8Array(),
      listing: [],
      symbols: [],
      startAddress: 0,
      diagnostics: [diagnostic],
    };
  }

  const parsed = parseSource(preprocessed);

  const sized = runSizingPasses(parsed);
  const diagnostics = collectDiagnostics(parsed, sized);
  const emitted = diagnostics.length === 0 ? emitBinary(parsed, sized) : { binary: new Uint8Array(), listing: buildListingOnly(parsed) };
  const symbols: SymbolEntry[] = Array.from(sized.symbols.entries())
    .map(([name, value]) => ({ name: displaySymbolName(name), value }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    binary: emitted.binary,
    listing: emitted.listing,
    symbols,
    startAddress: sized.startAddress,
    diagnostics,
  };
}

function mapPreprocessError(error: unknown): AssemblyDiagnostic {
  if (error instanceof PreprocessError) {
    return {
      code: error.code,
      lineNumber: error.lineNumber > 0 ? error.lineNumber : 1,
      message: error.message,
      source: error.source,
    };
  }

  return {
    code: "E_PREPROCESS",
    lineNumber: 1,
    message: error instanceof Error ? error.message : "Preprocessing failed",
    source: "",
  };
}

function runSizingPasses(lines: readonly SourceLine[]): PassState {
  let symbols = new Map<string, number>();
  let previousSizes = new Array<number>(lines.length).fill(0);
  let previousLineSymbols = lines.map(() => new Map<string, number>() as ReadonlyMap<string, number>);
  let previousLineScopes = new Array<string | undefined>(lines.length).fill(undefined);
  let startAddress = 0;
  let endAddress = 0;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const nextSymbols = new Map<string, number>(symbols);
    const lineSymbols: ReadonlyMap<string, number>[] = [];
    const lineScopes: Array<string | undefined> = [];
    const lineSizes: number[] = [];
    let location = 0;
    let hasOrigin = false;
    let minAddress = Number.POSITIVE_INFINITY;
    let maxAddress = Number.NEGATIVE_INFINITY;
    let currentScope: string | undefined;

    for (const line of lines) {
      if (line.kind !== "code") {
        lineSymbols.push(new Map(nextSymbols));
        lineScopes.push(currentScope);
        lineSizes.push(0);
        continue;
      }

      const mnemonic = normalizeMnemonic(line.mnemonic);
      if (line.label !== undefined && !isCheapLabel(line.label)) {
        currentScope = normalizeGlobalLabel(line.label);
      }

      if (line.label !== undefined && !isAssignmentDirective(mnemonic)) {
        nextSymbols.set(normalizeLabelName(line.label, currentScope), location & 0xffff);
      }

      const lineSymbolState = new Map(nextSymbols);
      lineSymbols.push(lineSymbolState);
      lineScopes.push(currentScope);

      if (line.label !== undefined && isAssignmentDirective(mnemonic)) {
        const expr = line.operands[0];
        const resolved = expr === undefined ? null : evaluateScopedExpression(expr, lineSymbolState, location, currentScope);
        if (resolved !== null) {
          nextSymbols.set(normalizeLabelName(line.label, currentScope), resolved);
        }
      }

      const sizedLine = sizeLine(line, location, lineSymbolState, currentScope);
      lineSizes.push(sizedLine.size);

      if (mnemonic === ".ORG") {
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
    previousLineSymbols = lineSymbols;
    previousLineScopes = lineScopes;
    startAddress = minAddress & 0xffff;
    endAddress = Math.max(maxAddress, startAddress) & 0xffff;

    if (symbolsStable && sizesStable) {
      return { symbols, lineSymbols, lineScopes, lineSizes, startAddress, endAddress };
    }
  }

  return {
    symbols,
    lineSymbols: previousLineSymbols,
    lineScopes: previousLineScopes,
    lineSizes: previousSizes,
    startAddress,
    endAddress,
  };
}

function collectDiagnostics(lines: readonly SourceLine[], passState: PassState): AssemblyDiagnostic[] {
  const diagnostics: AssemblyDiagnostic[] = [];
  let location = passState.startAddress;

  for (const [index, line] of lines.entries()) {
    if (line.kind !== "code") {
      continue;
    }

    const mnemonic = normalizeMnemonic(line.mnemonic);
    const symbols = passState.lineSymbols[index] ?? passState.symbols;
    const scope = passState.lineScopes[index];
    if (mnemonic === undefined) {
      continue;
    }

    if (mnemonic === ".ORG") {
      const expression = line.operands[0];
      if (expression === undefined) {
        diagnostics.push(makeDiagnostic(line, "E_DIR_ORG_OPERAND", ".org requires an expression operand"));
      } else {
        const evaluation = evaluateScopedExpressionDetailed(expression, symbols, location, scope);
        if (evaluation.value === null) {
          diagnostics.push(
            makeDiagnostic(
              line,
              evaluation.errorCode ?? "E_EXPR_INVALID",
              `.org expression error (${expression}): ${evaluation.error ?? "invalid expression"}`,
              evaluation.errorColumn ?? undefined,
            ),
          );
        }
      }
      continue;
    }

    if (isAssignmentDirective(mnemonic)) {
      if (line.label === undefined) {
        diagnostics.push(makeDiagnostic(line, assignmentLabelCode(mnemonic), `${assignmentDirectiveName(mnemonic)} requires a label`));
      }
      const expression = line.operands[0];
      if (expression === undefined) {
        diagnostics.push(
          makeDiagnostic(line, assignmentOperandCode(mnemonic), `${assignmentDirectiveName(mnemonic)} requires an expression operand`),
        );
      } else {
        const evaluation = evaluateScopedExpressionDetailed(expression, symbols, location, scope);
        if (evaluation.value === null) {
          diagnostics.push(
            makeDiagnostic(
              line,
              evaluation.errorCode ?? "E_EXPR_INVALID",
              `${assignmentDirectiveName(mnemonic)} expression error (${expression}): ${evaluation.error ?? "invalid expression"}`,
              evaluation.errorColumn ?? undefined,
            ),
          );
        }
      }
      continue;
    }

    if (mnemonic === ".BYTE") {
      line.operands.forEach((expression) => {
        const evaluation = evaluateScopedExpressionDetailed(expression, symbols, location, scope);
        if (evaluation.value === null) {
          diagnostics.push(
            makeDiagnostic(
              line,
              evaluation.errorCode ?? "E_EXPR_INVALID",
              `byte expression error (${expression}): ${evaluation.error ?? "invalid expression"}`,
              evaluation.errorColumn ?? undefined,
            ),
          );
        }
      });
      location += line.operands.length;
      continue;
    }

    if (mnemonic === ".TEXT") {
      for (const operand of line.operands) {
        const literal = parseTextLiteral(operand);
        if (literal.kind === "invalid") {
          diagnostics.push(makeDiagnostic(line, "E_DIR_TEXT_LITERAL", literal.message));
          continue;
        }

        if (literal.kind === "bytes") {
          continue;
        }

        const evaluation = evaluateScopedExpressionDetailed(operand, symbols, location, scope);
        if (evaluation.value === null) {
          diagnostics.push(
            makeDiagnostic(
              line,
              evaluation.errorCode ?? "E_EXPR_INVALID",
              `text expression error (${operand}): ${evaluation.error ?? "invalid expression"}`,
              evaluation.errorColumn ?? undefined,
            ),
          );
        }
      }
      location += textDirectiveSize(line.operands);
      continue;
    }

    if (mnemonic === ".WORD") {
      line.operands.forEach((expression) => {
        const evaluation = evaluateScopedExpressionDetailed(expression, symbols, location, scope);
        if (evaluation.value === null) {
          diagnostics.push(
            makeDiagnostic(
              line,
              evaluation.errorCode ?? "E_EXPR_INVALID",
              `word expression error (${expression}): ${evaluation.error ?? "invalid expression"}`,
              evaluation.errorColumn ?? undefined,
            ),
          );
        }
      });
      location += line.operands.length * 2;
      continue;
    }

    if (mnemonic === ".FILL") {
      const countExpr = line.operands[0];
      if (countExpr === undefined) {
        diagnostics.push(makeDiagnostic(line, "E_DIR_FILL_COUNT", ".fill requires a count operand"));
        continue;
      }

      const countEval = evaluateScopedExpressionDetailed(countExpr, symbols, location, scope);
      if (countEval.value === null) {
        diagnostics.push(
          makeDiagnostic(
            line,
            countEval.errorCode ?? "E_EXPR_INVALID",
            `.fill count expression error (${countExpr}): ${countEval.error ?? "invalid expression"}`,
            countEval.errorColumn ?? undefined,
          ),
        );
      } else if (countEval.value < 0 || countEval.value > 0xffff) {
        diagnostics.push(makeDiagnostic(line, "E_DIR_FILL_RANGE", ".fill count must be in the range 0..65535"));
      }

      const valueExpr = line.operands[1];
      if (valueExpr !== undefined) {
        const valueEval = evaluateScopedExpressionDetailed(valueExpr, symbols, location, scope);
        if (valueEval.value === null) {
          diagnostics.push(
            makeDiagnostic(
              line,
              valueEval.errorCode ?? "E_EXPR_INVALID",
              `.fill value expression error (${valueExpr}): ${valueEval.error ?? "invalid expression"}`,
              valueEval.errorColumn ?? undefined,
            ),
          );
        }
      }

      location += (countEval.value ?? 0) & 0xffff;
      continue;
    }

    if (mnemonic === ".ALIGN") {
      const boundaryExpr = line.operands[0];
      if (boundaryExpr === undefined) {
        diagnostics.push(makeDiagnostic(line, "E_DIR_ALIGN_BOUNDARY", ".align requires a boundary operand"));
        continue;
      }

      const boundaryEval = evaluateScopedExpressionDetailed(boundaryExpr, symbols, location, scope);
      if (boundaryEval.value === null) {
        diagnostics.push(
          makeDiagnostic(
            line,
            boundaryEval.errorCode ?? "E_EXPR_INVALID",
            `.align boundary expression error (${boundaryExpr}): ${boundaryEval.error ?? "invalid expression"}`,
            boundaryEval.errorColumn ?? undefined,
          ),
        );
        continue;
      }

      const boundary = boundaryEval.value;
      if (boundary <= 0) {
        diagnostics.push(makeDiagnostic(line, "E_DIR_ALIGN_RANGE", ".align boundary must be greater than zero"));
        continue;
      }

      const fillExpr = line.operands[1];
      if (fillExpr !== undefined) {
        const fillEval = evaluateScopedExpressionDetailed(fillExpr, symbols, location, scope);
        if (fillEval.value === null) {
          diagnostics.push(
            makeDiagnostic(
              line,
              fillEval.errorCode ?? "E_EXPR_INVALID",
              `.align fill expression error (${fillExpr}): ${fillEval.error ?? "invalid expression"}`,
              fillEval.errorColumn ?? undefined,
            ),
          );
        }
      }

      location += alignPadding(location, boundary);
      continue;
    }

    const opcodeTable = opcodes[mnemonic];
    if (opcodeTable === undefined) {
      diagnostics.push(makeDiagnostic(line, "E_OPCODE_UNKNOWN", `Unknown mnemonic: ${mnemonic}`));
      continue;
    }

    const resolved = resolveMode(mnemonic, line.operands, opcodeTable, symbols, location, false, scope);
    if (opcodeTable[resolved.mode] === undefined) {
      diagnostics.push(
        makeDiagnostic(line, "E_MODE_UNSUPPORTED", `Unsupported addressing mode for ${mnemonic}: ${resolved.mode}`),
      );
      continue;
    }

    if (modeNeedsValue(resolved.mode) && resolved.value === null) {
      const operandText = line.operands.join(", ");
      const detail = resolveOperandDiagnostic(mnemonic, line.operands, symbols, location, scope);
      diagnostics.push(
        makeDiagnostic(
          line,
          detail.code,
          `operand expression error (${operandText.length > 0 ? operandText : "<empty>"}): ${detail.message}`,
          detail.column,
        ),
      );
      continue;
    }

    if (resolved.mode === "relative") {
      const branchOffset = computeBranchOffset(resolved.value ?? 0, location);
      if (branchOffset < -128 || branchOffset > 127) {
        diagnostics.push(makeDiagnostic(line, "E_BRANCH_RANGE", `Branch out of range at ${toHex16(location)}`));
        continue;
      }
    }

    location += modeSize(resolved.mode);
  }

  return diagnostics;
}

function resolveOperandDiagnostic(
  mnemonic: string,
  operands: readonly string[],
  symbols: ReadonlyMap<string, number>,
  location: number,
  scope: string | undefined,
): { code: string; message: string; column?: number } {
  const operand = operands.join(", ").trim();
  if (operand.length === 0) {
    return { code: "E_OPERAND_MISSING", message: "missing operand" };
  }

  let expression = operand;

  if (branchMnemonics.has(mnemonic)) {
    expression = operand;
  } else {
    const immediate = operand.match(/^#\s*(.+)$/i);
    if (immediate?.[1] !== undefined) {
      expression = immediate[1];
    } else {
      const indexedIndirect = operand.match(/^\(\s*(.+)\s*,\s*X\s*\)$/i);
      const indirectIndexed = operand.match(/^\(\s*(.+)\s*\)\s*,\s*Y\s*$/i);
      const indirect = operand.match(/^\(\s*(.+)\s*\)$/i);
      const xIndexed = operand.match(/^(.+)\s*,\s*X\s*$/i);
      const yIndexed = operand.match(/^(.+)\s*,\s*Y\s*$/i);

      if (indexedIndirect?.[1] !== undefined) {
        expression = indexedIndirect[1];
      } else if (indirectIndexed?.[1] !== undefined) {
        expression = indirectIndexed[1];
      } else if (indirect?.[1] !== undefined) {
        expression = indirect[1];
      } else if (xIndexed?.[1] !== undefined) {
        expression = xIndexed[1];
      } else if (yIndexed?.[1] !== undefined) {
        expression = yIndexed[1];
      }
    }
  }

  const evaluation = evaluateScopedExpressionDetailed(expression, symbols, location, scope);
  return {
    code: evaluation.errorCode ?? "E_EXPR_INVALID",
    message: evaluation.error ?? "invalid expression",
    ...(evaluation.errorColumn !== null ? { column: evaluation.errorColumn } : {}),
  };
}

function buildListingOnly(lines: readonly SourceLine[]): ListingLine[] {
  return lines.map((line) => ({
    address: line.kind === "code" ? 0 : null,
    bytes: [],
    source: line.raw,
  }));
}

function sizeLine(
  line: SourceLine,
  location: number,
  symbols: ReadonlyMap<string, number>,
  scope: string | undefined,
): SizedLine {
  const mnemonic = normalizeMnemonic(line.mnemonic);
  if (mnemonic === undefined) {
    return { size: 0, nextAddress: location };
  }

  if (mnemonic === ".ORG") {
    const expr = line.operands[0];
    const resolved = expr === undefined ? location : evaluateScopedExpression(expr, symbols, location, scope);
    return { size: 0, nextAddress: (resolved ?? location) & 0xffff };
  }

  if (isAssignmentDirective(mnemonic)) {
    return { size: 0, nextAddress: location };
  }

  if (mnemonic === ".BYTE") {
    return { size: line.operands.length, nextAddress: location + line.operands.length };
  }

  if (mnemonic === ".TEXT") {
    const size = textDirectiveSize(line.operands);
    return { size, nextAddress: location + size };
  }

  if (mnemonic === ".WORD") {
    const size = line.operands.length * 2;
    return { size, nextAddress: location + size };
  }

  if (mnemonic === ".FILL") {
    const countExpr = line.operands[0];
    const count = countExpr === undefined ? 0 : evaluateScopedExpression(countExpr, symbols, location, scope);
    const size = (count ?? 0) & 0xffff;
    return { size, nextAddress: location + size };
  }

  if (mnemonic === ".ALIGN") {
    const boundaryExpr = line.operands[0];
    const boundary = boundaryExpr === undefined ? null : evaluateScopedExpression(boundaryExpr, symbols, location, scope);
    const padding = boundary === null || boundary <= 0 ? 0 : alignPadding(location, boundary);
    return { size: padding, nextAddress: location + padding };
  }

  const table = opcodes[mnemonic];
  if (table === undefined) {
    return { size: 0, nextAddress: location };
  }

  const resolved = resolveMode(mnemonic, line.operands, table, symbols, location, true, scope);
  const size = modeSize(resolved.mode);
  return { size, nextAddress: location + size };
}

function emitBinary(lines: readonly SourceLine[], passState: PassState): { binary: Uint8Array; listing: ListingLine[] } {
  const bytes = new Map<number, number>();
  const listing: ListingLine[] = [];
  let location = passState.startAddress;
  let minAddress = Number.POSITIVE_INFINITY;
  let maxAddress = Number.NEGATIVE_INFINITY;

  for (const [index, line] of lines.entries()) {
    if (line.kind !== "code") {
      listing.push({ address: null, bytes: [], source: line.raw });
      continue;
    }

    const mnemonic = normalizeMnemonic(line.mnemonic);
    const symbols = passState.lineSymbols[index] ?? passState.symbols;
    const scope = passState.lineScopes[index];
    if (mnemonic === undefined) {
      listing.push({ address: location & 0xffff, bytes: [], source: line.raw });
      continue;
    }

    if (mnemonic === ".ORG") {
      const target = evaluateScopedExpression(line.operands[0] ?? "0", symbols, location, scope) ?? location;
      location = target & 0xffff;
      listing.push({ address: location, bytes: [], source: line.raw });
      continue;
    }

    if (isAssignmentDirective(mnemonic)) {
      listing.push({ address: location & 0xffff, bytes: [], source: line.raw });
      continue;
    }

    if (mnemonic === ".BYTE") {
      const emitted = line.operands.map((expr) => (evaluateScopedExpression(expr, symbols, location, scope) ?? 0) & 0xff);
      writeBytes(bytes, location, emitted);
      listing.push({ address: location & 0xffff, bytes: emitted, source: line.raw });
      if (emitted.length > 0) {
        minAddress = Math.min(minAddress, location);
        maxAddress = Math.max(maxAddress, location + emitted.length - 1);
      }
      location += emitted.length;
      continue;
    }

    if (mnemonic === ".TEXT") {
      const emitted: number[] = [];
      for (const operand of line.operands) {
        const literal = parseTextLiteral(operand);
        if (literal.kind === "bytes") {
          emitted.push(...literal.bytes);
          continue;
        }

        emitted.push((evaluateScopedExpression(operand, symbols, location, scope) ?? 0) & 0xff);
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

    if (mnemonic === ".WORD") {
      const emitted: number[] = [];
      for (const expr of line.operands) {
        const value = (evaluateScopedExpression(expr, symbols, location, scope) ?? 0) & 0xffff;
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

    if (mnemonic === ".FILL") {
      const count = (evaluateScopedExpression(line.operands[0] ?? "0", symbols, location, scope) ?? 0) & 0xffff;
      const value = (evaluateScopedExpression(line.operands[1] ?? "0", symbols, location, scope) ?? 0) & 0xff;
      const emitted = new Array<number>(count).fill(value);
      writeBytes(bytes, location, emitted);
      listing.push({ address: location & 0xffff, bytes: emitted, source: line.raw });
      if (emitted.length > 0) {
        minAddress = Math.min(minAddress, location);
        maxAddress = Math.max(maxAddress, location + emitted.length - 1);
      }
      location += emitted.length;
      continue;
    }

    if (mnemonic === ".ALIGN") {
      const boundary = evaluateScopedExpression(line.operands[0] ?? "0", symbols, location, scope) ?? 0;
      const fillValue = (evaluateScopedExpression(line.operands[1] ?? "0", symbols, location, scope) ?? 0) & 0xff;
      const emitted = new Array<number>(alignPadding(location, boundary)).fill(fillValue);
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

    const resolved = resolveMode(mnemonic, line.operands, opcodeTable, symbols, location, false, scope);
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
  scope: string | undefined,
): ModeResolution {
  const operand = operands.join(", ").trim();

  if (branchMnemonics.has(mnemonic)) {
    const value = operand.length > 0 ? evaluateScopedExpression(operand, symbols, location, scope) : null;
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
    return { mode: "immediate", value: expr === undefined ? null : evaluateScopedExpression(expr, symbols, location, scope) };
  }

  const indexedIndirect = operand.match(/^\(\s*(.+)\s*,\s*X\s*\)$/i);
  if (indexedIndirect) {
    const expr = indexedIndirect[1];
    return {
      mode: "indexedIndirect",
      value: expr === undefined ? null : evaluateScopedExpression(expr, symbols, location, scope),
    };
  }

  const indirectIndexed = operand.match(/^\(\s*(.+)\s*\)\s*,\s*Y\s*$/i);
  if (indirectIndexed) {
    const expr = indirectIndexed[1];
    return {
      mode: "indirectIndexed",
      value: expr === undefined ? null : evaluateScopedExpression(expr, symbols, location, scope),
    };
  }

  const indirect = operand.match(/^\(\s*(.+)\s*\)$/i);
  if (indirect) {
    const expr = indirect[1];
    return { mode: "indirect", value: expr === undefined ? null : evaluateScopedExpression(expr, symbols, location, scope) };
  }

  const xIndexed = operand.match(/^(.+)\s*,\s*X\s*$/i);
  if (xIndexed) {
    const expr = xIndexed[1];
    const value = expr === undefined ? null : evaluateScopedExpression(expr, symbols, location, scope);
    if (table.zeropageX !== undefined && (value !== null ? value <= 0xff : !conservative)) {
      return { mode: "zeropageX", value };
    }
    return { mode: "absoluteX", value };
  }

  const yIndexed = operand.match(/^(.+)\s*,\s*Y\s*$/i);
  if (yIndexed) {
    const expr = yIndexed[1];
    const value = expr === undefined ? null : evaluateScopedExpression(expr, symbols, location, scope);
    if (table.zeropageY !== undefined && (value !== null ? value <= 0xff : !conservative)) {
      return { mode: "zeropageY", value };
    }
    return { mode: "absoluteY", value };
  }

  const value = evaluateScopedExpression(operand, symbols, location, scope);
  if (table.zeropage !== undefined && (value !== null ? value <= 0xff : !conservative)) {
    return { mode: "zeropage", value };
  }
  return { mode: "absolute", value };
}

function normalizeMnemonic(mnemonic: string | undefined): string | undefined {
  return mnemonic?.toUpperCase();
}

function isAssignmentDirective(mnemonic: string | undefined): boolean {
  return mnemonic === ".EQU" || mnemonic === ".SET" || mnemonic === "=";
}

function assignmentDirectiveName(mnemonic: string): string {
  return mnemonic === "=" ? "=" : mnemonic.toLowerCase();
}

function assignmentLabelCode(mnemonic: string): string {
  return mnemonic === ".EQU" ? "E_DIR_EQU_LABEL" : "E_DIR_SET_LABEL";
}

function assignmentOperandCode(mnemonic: string): string {
  return mnemonic === ".EQU" ? "E_DIR_EQU_OPERAND" : "E_DIR_SET_OPERAND";
}

function isCheapLabel(label: string): boolean {
  return label.startsWith("@");
}

function normalizeGlobalLabel(label: string): string {
  return label.toUpperCase();
}

function normalizeLabelName(label: string, scope: string | undefined): string {
  if (!isCheapLabel(label)) {
    return normalizeGlobalLabel(label);
  }

  return `${CHEAP_LABEL_PREFIX}${scope ?? CHEAP_LABEL_ROOT}__${label.slice(1).toUpperCase()}`;
}

function rewriteCheapLabels(expression: string, scope: string | undefined): string {
  return expression.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, localName: string) => normalizeLabelName(`@${localName}`, scope));
}

function evaluateScopedExpression(
  expression: string,
  symbols: ReadonlyMap<string, number>,
  location: number,
  scope: string | undefined,
): number | null {
  return evaluateExpression(rewriteCheapLabels(expression, scope), symbols, location);
}

function evaluateScopedExpressionDetailed(
  expression: string,
  symbols: ReadonlyMap<string, number>,
  location: number,
  scope: string | undefined,
) {
  return evaluateExpressionDetailed(rewriteCheapLabels(expression, scope), symbols, location);
}

function displaySymbolName(name: string): string {
  const match = name.match(/^__CHEAP_LABEL__(.+)__([A-Z_][A-Z0-9_]*)$/);
  if (match?.[1] === undefined || match[2] === undefined) {
    return name;
  }

  return match[1] === CHEAP_LABEL_ROOT ? `@${match[2]}` : `${match[1]}.@${match[2]}`;
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

function makeDiagnostic(line: SourceLine, code: string, message: string, column?: number): AssemblyDiagnostic {
  return {
    code,
    lineNumber: line.lineNumber,
    ...(column !== undefined ? { column } : {}),
    message,
    source: line.raw,
  };
}

function textDirectiveSize(operands: readonly string[]): number {
  let size = 0;

  for (const operand of operands) {
    const literal = parseTextLiteral(operand);
    size += literal.kind === "bytes" ? literal.bytes.length : 1;
  }

  return size;
}

function alignPadding(location: number, boundary: number): number {
  if (boundary <= 0) {
    return 0;
  }

  const remainder = location % boundary;
  return remainder === 0 ? 0 : boundary - remainder;
}

function parseTextLiteral(operand: string):
  | { kind: "bytes"; bytes: number[] }
  | { kind: "not-literal" }
  | { kind: "invalid"; message: string } {
  const trimmed = operand.trim();
  if (trimmed.length < 2) {
    return { kind: "not-literal" };
  }

  const quote = trimmed[0];
  if ((quote !== "\"" && quote !== "'") || trimmed[trimmed.length - 1] !== quote) {
    if (quote === "\"" || quote === "'") {
      return { kind: "invalid", message: `Invalid string literal in .text operand: ${operand}` };
    }
    return { kind: "not-literal" };
  }

  const content = trimmed.slice(1, -1);
  const bytes: number[] = [];

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!;
    if (ch !== "\\") {
      bytes.push(ch.charCodeAt(0) & 0xff);
      continue;
    }

    const next = content[i + 1];
    if (next === undefined) {
      return { kind: "invalid", message: `Invalid escape in .text operand: ${operand}` };
    }

    if (next === "n") {
      bytes.push(0x0a);
      i += 1;
      continue;
    }
    if (next === "r") {
      bytes.push(0x0d);
      i += 1;
      continue;
    }
    if (next === "t") {
      bytes.push(0x09);
      i += 1;
      continue;
    }
    if (next === "\\" || next === "\"" || next === "'") {
      bytes.push(next.charCodeAt(0) & 0xff);
      i += 1;
      continue;
    }

    const hexStart = i + 1;
    if (next === "x" && hexStart + 2 <= content.length - 1) {
      const hex = content.slice(i + 2, i + 4);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 3;
        continue;
      }
    }

    return { kind: "invalid", message: `Invalid escape in .text operand: ${operand}` };
  }

  return { kind: "bytes", bytes };
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