# Detailed Code Changes for Preprocessing Refactoring

## Overview

This document shows the exact code changes needed for each file in the refactoring.

---

## 1. incremental-preprocessor.ts

### Changes Needed

#### 1.1 Add imports

```typescript
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
```

#### 1.2 Add properties to IncrementalPreprocessor class

```typescript
export class IncrementalPreprocessor {
  private originalLines: readonly TaggedLine[];
  private lines: TaggedLine[];
  private lineIndex: number = 0;
  private macros: Map<string, MacroDefinition> = new Map();
  private directiveStack: DirectiveFrame[] = [];

  // NEW PROPERTIES:
  private readFile: (filePath: string) => string;
  private currentDir: string;
  private includeStack: readonly string[] = [];
  private includeDepth: number = 0;

  private static readonly MAX_INCLUDE_DEPTH = 32;
```

#### 1.3 Update constructor

```typescript
constructor(
  taggedLines: readonly TaggedLine[],
  options: PreprocessorOptions = {}
) {
  this.originalLines = [...taggedLines];
  this.lines = [...taggedLines];

  // NEW:
  this.readFile = options.readFile ??
    ((filePath: string) => readFileSync(filePath, 'utf8'));
  this.currentDir = options.sourcePath
    ? dirname(options.sourcePath)
    : process.cwd();
  this.includeStack = options.sourcePath
    ? [resolve(options.sourcePath)]
    : [];

  debugLog(`Initialized with ${this.lines.length} lines`);
}
```

#### 1.4 Add .INCLUDE handling in processTaggedLine()

```typescript
private processTaggedLine(
  line: TaggedLine,
  symbols: ReadonlyMap<string, number>,
): TaggedLine | null {
  const trimmed = line.content.trim();
  if (!trimmed || /^\s*[;*]/.test(line.content)) {
    return line;
  }

  const parsed = parseLine(line.content, line.location);
  if (parsed.kind === "code" && parsed.mnemonic) {
    const mnemonic = parsed.mnemonic.toUpperCase();

    // NEW: Handle .INCLUDE before checking inactive conditionals
    if (mnemonic === ".INCLUDE") {
      this.handleIncludeDirective(parsed.operands[0] ?? "", line.location);
      return null;
    }

    if (mnemonic === ".IF") {
      // ... existing code ...
    }
    // ... rest of existing code ...
  }
  // ... rest of existing code ...
}
```

#### 1.5 Add handleIncludeDirective() method

```typescript
private handleIncludeDirective(
  operand: string,
  location: SourceLocation,
): void {
  const includePath = parseIncludePath(operand);
  if (!includePath) {
    throw new IncrementalPreprocessorError(
      "E_INCLUDE_PATH",
      `.include path must be a quoted string: ${operand}`,
      location,
    );
  }

  if (this.includeDepth >= IncrementalPreprocessor.MAX_INCLUDE_DEPTH) {
    throw new IncrementalPreprocessorError(
      "E_INCLUDE_DEPTH",
      "Maximum include depth exceeded",
      location,
    );
  }

  const resolvedPath = isAbsolute(includePath)
    ? resolve(includePath)
    : resolve(join(this.currentDir, includePath));

  if (this.includeStack.includes(resolvedPath)) {
    throw new IncrementalPreprocessorError(
      "E_INCLUDE_CYCLE",
      `Circular include detected for ${resolvedPath}`,
      location,
    );
  }

  let includedText: string;
  try {
    includedText = this.readFile(resolvedPath);
  } catch {
    throw new IncrementalPreprocessorError(
      "E_INCLUDE_READ",
      `Unable to read include file: ${resolvedPath}`,
      location,
    );
  }

  const includedLines = includedText
    .split(/\r?\n/)
    .map((content, idx) => ({
      content,
      location: {
        filename: resolvedPath,
        lineNumber: idx + 1,
      },
    }));

  this.lines.splice(this.lineIndex, 0, ...includedLines);
}
```

#### 1.6 Add parseIncludePath() helper (move from preprocessor.ts)

```typescript
function parseIncludePath(operand: string): string | null {
  const trimmed = operand.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote)
    return null;
  return trimmed.slice(1, -1);
}
```

#### 1.7 Update PreprocessorOptions interface

```typescript
export interface PreprocessorOptions {
  readonly sourcePath?: string;
  readonly readFile?: (filePath: string) => string;
}
```

---

## 2. assembler.ts

### Changes Needed [2]

#### 2.1 Update imports

```typescript
// ADD:
import type { TaggedLine } from "./types.js";
```

#### 2.2 Update assemble() signature

```typescript
// BEFORE:
export function assemble(
  sourceText: string,
  options: AssembleOptions = {},
): AssemblyResult {

// AFTER:
export function assemble(
  taggedLines: readonly TaggedLine[],
  options: AssembleOptions = {},
): AssemblyResult {
```

#### 2.3 Update IncrementalPreprocessor instantiation

```typescript
// BEFORE:
const preprocessor = new IncrementalPreprocessor(sourceText, {
  ...(options.sourcePath !== undefined
    ? { sourcePath: options.sourcePath }
    : {}),
  ...(options.readFile !== undefined ? { readFile: options.readFile } : {}),
});

// AFTER:
const preprocessor = new IncrementalPreprocessor(taggedLines, {
  sourcePath: options.sourcePath,
  readFile: options.readFile,
});
```

#### 2.4 Remove preprocessSourceToTaggedLines() call

```typescript
// DELETE THIS ENTIRE SECTION:
let preprocessed: string = "";
const diagnostics: AssemblyDiagnostic[] = [];

try {
  preprocessed = preprocessSource(sourceText, {
    ...(options.sourcePath !== undefined
      ? { sourcePath: options.sourcePath }
      : {}),
    ...(options.readFile !== undefined ? { readFile: options.readFile } : {}),
  });
} catch (error) {
  // ... error handling ...
}

// REPLACE WITH:
const diagnostics: AssemblyDiagnostic[] = [];
const sourceText = taggedLines.map((line) => line.content).join("\n");
```

#### 2.5 Update runSizingPasses() calls

```typescript
// BEFORE:
const sized = runSizingPasses(preprocessed, options.sourcePath);

// AFTER:
const sized = runSizingPasses(sourceText, options.sourcePath);
```

---

## 3. preprocessor.ts

### Changes Needed [3]

#### 3.1 Add loadAndPreprocessFile() function

```typescript
import { dirname } from "node:path";
import { readFileSync } from "node:fs";

export interface FileLoadOptions {
  readonly readFile?: (filePath: string) => string;
}

/**
 * Load a source file and prepare it for assembly.
 *
 * Reads the file from disk and converts it to a TaggedLine array
 * with proper source location tracking.
 *
 * All preprocessing directives (.INCLUDE, .MACRO, .REPEAT, .IF)
 * are handled by IncrementalPreprocessor with symbol table access.
 */
export function loadAndPreprocessFile(
  filePath: string,
  options: FileLoadOptions = {},
): TaggedLine[] {
  const readFile =
    options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  const sourceText = readFile(filePath);

  return preprocessSourceToTaggedLines(sourceText, {
    sourcePath: filePath,
    currentDir: dirname(filePath),
    readFile,
  });
}
```

#### 3.2 Simplify preprocessSourceToTaggedLines()

```typescript
/**
 * Convert source string to TaggedLine array.
 *
 * ONLY responsibility:
 * - Split source by newlines
 * - Attach SourceLocation to each line
 * - Return TaggedLine[]
 *
 * All preprocessing directives (.INCLUDE, .MACRO, .REPEAT, .IF)
 * are handled by IncrementalPreprocessor with symbol table access.
 */
export function preprocessSourceToTaggedLines(
  text: string,
  options: PreprocessOptions = {},
): TaggedLine[] {
  const sourcePath = options.sourcePath ?? "<source>";
  const lines = text.split(/\r?\n/);

  return lines.map((content, idx) => ({
    content,
    location: {
      filename: sourcePath,
      lineNumber: idx + 1,
    },
  }));
}
```

#### 3.3 Remove old code (DELETE)

```typescript
// DELETE THESE FUNCTIONS:
- preprocessLinesToTagged()
- collectConstants()
- parseIncludePath()
- IncludeContext interface
- All .INCLUDE handling code
- All .MACRO collection code
- All .REPEAT expansion code
- All .IF pass-through code
```

#### 3.4 Keep preprocessSource() for backward compatibility (OPTIONAL)

```typescript
/**
 * Legacy function for backward compatibility.
 * Returns preprocessed source as a string.
 *
 * New code should use loadAndPreprocessFile() instead.
 */
export function preprocessSource(
  text: string,
  options: PreprocessOptions = {},
): string {
  const tagged = preprocessSourceToTaggedLines(text, options);
  return tagged.map((line) => line.content).join("\n");
}
```

---

## 4. cli.ts / index.ts

### Changes Needed [4]

#### 4.1 Update imports

```typescript
// ADD:
import { loadAndPreprocessFile } from "./preprocessor.js";

// REMOVE:
// import { readFileSync } from "node:fs";  // if only used for reading source
```

#### 4.2 Update main assembly logic

```typescript
// BEFORE:
const sourceText = readFileSync(cliOptions.inputPath, "utf8");
const result = assemble(sourceText, {
  sourcePath: cliOptions.inputPath,
  readFile: (path) => readFileSync(path, "utf8"),
});

// AFTER:
const taggedLines = loadAndPreprocessFile(cliOptions.inputPath);
const result = assemble(taggedLines, {
  sourcePath: cliOptions.inputPath,
  readFile: (path) => readFileSync(path, "utf8"),
});
```

---

## 5. types.ts

### Changes Needed [5]

#### 5.1 Add FileLoadOptions interface

```typescript
/**
 * Options for file loading
 */
export interface FileLoadOptions {
  readonly readFile?: (filePath: string) => string;
}
```

#### 5.2 Verify exports

```typescript
// Make sure these are exported:
export interface TaggedLine { ... }
export interface PreprocessorOptions { ... }
export interface FileLoadOptions { ... }
export interface AssemblyResult { ... }
```

---

## 6. index.ts (exports)

### Changes Needed [6]

#### 6.1 Update exports

```typescript
// ADD:
export { loadAndPreprocessFile } from "./preprocessor.js";
export type { FileLoadOptions } from "./types.js";

// KEEP EXISTING:
export { assemble } from "./assembler.js";
export { IncrementalPreprocessor } from "./incremental-preprocessor.js";
export {
  preprocessSource,
  preprocessSourceToTaggedLines,
} from "./preprocessor.js";
export type {
  AssemblyResult,
  TaggedLine,
  PreprocessorOptions,
  // ... other types
} from "./types.js";
```

---

## 7. Delete source-loader.ts

### Action

- [ ] Delete the entire file (it's incomplete and broken)

---

## 8. Test Updates

### 8.1 assembler.test.ts

```typescript
// BEFORE:
test("assembles simple code", () => {
  const sourceText = `
    LDA #$42
    RTS
  `;
  const result = assemble(sourceText);
  expect(result.binary).toHaveLength(3);
});

// AFTER:
test("assembles simple code", () => {
  const sourceText = `
    LDA #$42
    RTS
  `;
  const taggedLines = preprocessSourceToTaggedLines(sourceText);
  const result = assemble(taggedLines);
  expect(result.binary).toHaveLength(3);
});

// OR (using new function):
test("assembles simple code", () => {
  // Create temp file, then:
  const taggedLines = loadAndPreprocessFile(tempFilePath);
  const result = assemble(taggedLines);
  expect(result.binary).toHaveLength(3);
});
```

### 8.2 cli.test.ts

```typescript
// Update to test loadAndPreprocessFile() directly
// Or test the full CLI flow which now uses it
```

---

## 9. Migration Path Summary

### Step 1: Prepare IncrementalPreprocessor

- Add `.INCLUDE` handling
- Add `readFile` and `currentDir` properties
- Add `parseIncludePath()` helper
- Test thoroughly

### Step 2: Update assemble() signature

- Change to accept `TaggedLine[]` instead of `string`
- Update IncrementalPreprocessor instantiation
- Remove old preprocessSource() call
- Test

### Step 3: Create loadAndPreprocessFile()

- Add to preprocessor.ts
- Export from index.ts
- Test

### Step 4: Simplify preprocessSourceToTaggedLines()

- Remove all directive handling
- Keep only string → TaggedLine conversion
- Test

### Step 5: Update CLI

- Use loadAndPreprocessFile()
- Remove direct file reading
- Test

### Step 6: Update tests

- Update existing tests to use new signatures
- Add new tests for includes
- Verify all pass

### Step 7: Cleanup

- Delete source-loader.ts
- Remove any deprecated code
- Final verification

---

## Validation Checklist

After each change:

- [ ] TypeScript compiles without errors
- [ ] All tests pass
- [ ] No console warnings
- [ ] Source locations preserved
- [ ] Error messages clear

Final validation:

- [ ] Full test suite passes
- [ ] CLI works with sample files
- [ ] No duplication of preprocessing logic
- [ ] Code is cleaner than before
