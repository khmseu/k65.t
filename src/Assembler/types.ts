/**
 * Source location tracking for precise error reporting
 */
export interface SourceLocation {
  readonly filename: string;
  readonly lineNumber: number;
  readonly text?: string;
  readonly parent?: SourceLocation;
}

/**
 * A line with its source location information
 */
export interface TaggedLine {
  readonly content: string;
  readonly location: SourceLocation;
  readonly locationChain: readonly SourceLocation[];
}

/**
 * Parsed assembly source line
 */
export interface SourceLine {
  readonly lineNumber: number;
  readonly raw: string;
  readonly kind: "blank" | "comment" | "code";
  readonly operands: readonly string[];
  readonly label?: string;
  readonly mnemonic?: string;
  readonly comment?: string;
  readonly location?: SourceLocation;
  readonly locationChain: readonly SourceLocation[];
}

/**
 * Assembly diagnostic (error, warning, or info)
 */
export interface AssemblyDiagnostic {
  readonly code: string;
  readonly level: "error" | "warning" | "info";
  readonly message: string;
  readonly location: SourceLocation;
  readonly hint?: string;
  readonly column?: number;
}

/**
 * Macro definition
 */
export interface MacroDefinition {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly body: readonly TaggedLine[];
  readonly lineNumber: number;
}

/**
 * Preprocessor options
 */
export interface PreprocessorOptions {
  readonly sourcePath?: string;
  readonly readFile?: (filePath: string) => string;
}

/**
 * Assembler options
 */
export interface AssemblerOptions {
  readonly sourcePath?: string;
  readonly readFile?: (filePath: string) => string;
  readonly onDiagnostic?: (diagnostic: AssemblyDiagnostic) => void;
}

/**
 * Listing line in the assembly output
 */
export interface ListingLine {
  readonly address: number | null;
  readonly bytes: readonly number[];
  readonly source: string;
  readonly target: number | undefined;
  readonly title?: string;
  readonly subtitle?: string;
  readonly pageBreak?: boolean;
}

/**
 * Symbol table entry
 */
export interface SymbolEntry {
  readonly name: string;
  readonly value: number;
}

/**
 * Assembly result
 */
export interface AssemblyResult {
  readonly binary: Uint8Array;
  readonly listing: ListingLine[];
  readonly symbols: SymbolEntry[];
  readonly startAddress: number;
  readonly diagnostics: AssemblyDiagnostic[];
  readonly bytesPerLine: number;
  readonly pageSize: number;
}
