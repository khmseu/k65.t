export type SourceKind = "code" | "comment" | "blank";

export interface SourceLine {
  readonly lineNumber: number;
  readonly raw: string;
  readonly kind: SourceKind;
  readonly label?: string;
  readonly mnemonic?: string;
  readonly operands: readonly string[];
  readonly comment?: string;
}

export interface ListingLine {
  readonly address: number | null;
  readonly bytes: readonly number[];
  readonly source: string;
}

export interface SymbolEntry {
  readonly name: string;
  readonly value: number;
}

export interface AssemblyResult {
  readonly binary: Uint8Array;
  readonly listing: readonly ListingLine[];
  readonly symbols: readonly SymbolEntry[];
}