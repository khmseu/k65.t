import { parseSource } from "./parser.js";
import type { AssemblyResult, ListingLine, SymbolEntry } from "./types.js";

export function assemble(sourceText: string): AssemblyResult {
  const parsed = parseSource(sourceText);
  const listing: ListingLine[] = parsed.map((line) => ({
    address: null,
    bytes: [],
    source: line.raw,
  }));

  const symbols: SymbolEntry[] = [];
  return {
    binary: new Uint8Array(),
    listing,
    symbols,
  };
}