# Revised Implementation Plan - APPROVED ARCHITECTURE

## Key Approved Change

**Move reading of the MAIN file into IncrementalPreprocessor**, not just `.INCLUDE` handling.

This simplifies the architecture significantly by eliminating the need for a separate `loadAndPreprocessFile()` function.

---

## Revised Architecture

### New Data Flow

```text
CLI (index.ts)
  ↓ passes filePath + options
  ↓
assemble(mainFilePath, options)
  ↓
IncrementalPreprocessor(mainFilePath, options)
  ├─ reads main file via readFile callback
  ├─ converts to TaggedLine[] internally
  ├─ handles .INCLUDE directives (recursive)
  ├─ collects .MACRO definitions
  ├─ expands .REPEAT blocks
  ├─ evaluates .IF/.ELSE/.ELSEIF/.ENDIF
  └─ returns SourceLine[] (one at a time via nextLine())
  ↓
Assembler passes (sizing, diagnostics, emission)
```

### Key Insight

**IncrementalPreprocessor becomes the single entry point for all file I/O and preprocessing.**

This means:
- No separate `loadAndPreprocessFile()` function needed
- No `preprocessSourceToTaggedLines()` called from outside
- All file reading happens inside IncrementalPreprocessor
- Cleaner, simpler API

---

## Updated Function Signatures

### IncrementalPreprocessor Constructor

```typescript
// BEFORE:
constructor(source: string, options: PreprocessorOptions = {})

// AFTER:
constructor(
  mainFilePath: string,
  options: PreprocessorOptions = {}
)
```

### assemble() Function

```typescript
// BEFORE:
export function assemble(
  sourceText: string,
  options: AssembleOptions = {}
): AssemblyResult

// AFTER:
export function assemble(
  mainFilePath: string,
  options: AssembleOptions = {}
): AssemblyResult
```

### CLI Usage

```typescript
// BEFORE:
const sourceText = readFileSync(cliOptions.inputPath, 'utf8');
const result = assemble(sourceText, {
  sourcePath: cliOptions.inputPath,
  readFile: (path) => readFileSync(path, 'utf8'),
});

// AFTER:
const result = assemble(cliOptions.inputPath, {
  readFile: (path) => readFileSync(path, 'utf8'),
});
```

---

## Migration Strategy

### Phase 1: Core Refactoring (Day 1-2)

1. **Update IncrementalPreprocessor constructor**
   - Change parameter from `source: string` to `mainFilePath: string`
   - Add file reading logic
   - Add `preprocessSourceToTaggedLines()` call internally
   - Add `readFile` and `currentDir` properties
   - Add `.INCLUDE` handling

2. **Update assemble() function**
   - Change parameter from `sourceText: string` to `mainFilePath: string`
   - Pass `mainFilePath` to IncrementalPreprocessor constructor
   - Remove `preprocessSourceToTaggedLines()` call from assemble()

3. **Update types**
   - Simplify `AssembleOptions` (remove `sourcePath` if not needed elsewhere)
   - Keep `PreprocessorOptions` for IncrementalPreprocessor

### Phase 2: CLI & Tests (Day 2-3)

1. **Update CLI**
   - Remove `readFileSync()` call from CLI
   - Pass file path directly to `assemble()`

2. **Update tests**
   - Update `assembler.test.ts` to use new signature
   - Update `cli.test.ts` to use new signature
   - Add tests for `.INCLUDE` handling in IncrementalPreprocessor

### Phase 3: Cleanup (Day 3)

1. **Delete preprocessor.ts** (or keep only for backward compatibility)
2. **Delete source-loader.ts** (broken, incomplete)
3. **Final verification**

---

## Implementation Checklist

### Phase 1: IncrementalPreprocessor

- [ ] Add `mainFilePath: string` parameter to constructor
- [ ] Add `readFile` property (default: readFileSync)
- [ ] Add `currentDir` property (derived from mainFilePath)
- [ ] Add `includeStack` property (track circular includes)
- [ ] Add file reading logic in constructor:
  ```typescript
  const sourceText = this.readFile(mainFilePath);
  const taggedLines = preprocessSourceToTaggedLines(sourceText, {
    sourcePath: mainFilePath,
    currentDir: this.currentDir,
  });
  this.lines = [...taggedLines];
  ```
- [ ] Add `.INCLUDE` handling in `processTaggedLine()`
- [ ] Add `handleIncludeDirective()` method
- [ ] Add `parseIncludePath()` helper function
- [ ] Test with existing test suite

### Phase 2: assemble() Function

- [ ] Change signature: `assemble(mainFilePath: string, options)`
- [ ] Update IncrementalPreprocessor instantiation:
  ```typescript
  const preprocessor = new IncrementalPreprocessor(mainFilePath, {
    readFile: options.readFile,
  });
  ```
- [ ] Remove `preprocessSourceToTaggedLines()` call
- [ ] Test with existing test suite

### Phase 3: CLI

- [ ] Update `index.ts` or `cli.ts`:
  ```typescript
  const result = assemble(cliOptions.inputPath, {
    readFile: (path) => readFileSync(path, 'utf8'),
  });
  ```
- [ ] Remove `readFileSync()` call for main file
- [ ] Test CLI with sample files

### Phase 4: Tests

- [ ] Update `assembler.test.ts`:
  - Create temp files for tests
  - Pass file paths to `assemble()` instead of source text
  - Or use `readFile` callback to mock file system
- [ ] Update `cli.test.ts`
- [ ] Add tests for `.INCLUDE` handling
- [ ] Run full test suite

### Phase 5: Cleanup

- [ ] Delete or deprecate `preprocessor.ts`
- [ ] Delete `source-loader.ts`
- [ ] Update exports in `index.ts`
- [ ] Final verification

---

## Code Changes

### 1. incremental-preprocessor.ts

#### Constructor Changes

```typescript
// BEFORE:
constructor(source: string, options: PreprocessorOptions = {}) {
  this.originalLines = preprocessSourceToTaggedLines(source, options as any);
  this.lines = [...this.originalLines];
  debugLog(`Initialized with ${this.lines.length} lines`);
}

// AFTER:
constructor(
  mainFilePath: string,
  options: PreprocessorOptions = {}
) {
  this.readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  this.currentDir = dirname(mainFilePath);
  this.includeStack = [resolve(mainFilePath)];

  // Read main file
  let sourceText: string;
  try {
    sourceText = this.readFile(mainFilePath);
  } catch (error) {
    throw new IncrementalPreprocessorError(
      'E_MAIN_FILE_READ',
      `Cannot read main file: ${mainFilePath}`,
      { filename: mainFilePath, lineNumber: 0 }
    );
  }

  // Convert to TaggedLine[]
  const taggedLines = preprocessSourceToTaggedLines(sourceText, {
    sourcePath: mainFilePath,
  });

  this.originalLines = [...taggedLines];
  this.lines = [...taggedLines];
  debugLog(`Initialized with ${this.lines.length} lines`);
}
```

#### Add Properties

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
  // ... rest of class
}
```

#### Add .INCLUDE Handling

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

    // NEW: Handle .INCLUDE
    if (mnemonic === ".INCLUDE") {
      this.handleIncludeDirective(parsed.operands[0] ?? "", line.location);
      return null;
    }

    // ... rest of existing code ...
  }
  // ... rest of existing code ...
}

private handleIncludeDirective(
  operand: string,
  location: SourceLocation,
): void {
  const includePath = parseIncludePath(operand);
  if (!includePath) {
    throw new IncrementalPreprocessorError(
      "E_INCLUDE_PATH",
      `.include path must be quoted: ${operand}`,
      location,
    );
  }

  const resolvedPath = isAbsolute(includePath)
    ? resolve(includePath)
    : resolve(join(this.currentDir, includePath));

  if (this.includeStack.includes(resolvedPath)) {
    throw new IncrementalPreprocessorError(
      "E_INCLUDE_CYCLE",
      `Circular include: ${resolvedPath}`,
      location,
    );
  }

  if (this.includeDepth >= IncrementalPreprocessor.MAX_INCLUDE_DEPTH) {
    throw new IncrementalPreprocessorError(
      "E_INCLUDE_DEPTH",
      `Include depth exceeded (max ${IncrementalPreprocessor.MAX_INCLUDE_DEPTH})`,
      location,
    );
  }

  let includedText: string;
  try {
    includedText = this.readFile(resolvedPath);
  } catch {
    throw new IncrementalPreprocessorError(
      "E_INCLUDE_READ",
      `Cannot read include file: ${resolvedPath}`,
      location,
    );
  }

  const includedLines = includedText.split(/\r?\n/).map((content, idx) => ({
    content,
    location: {
      filename: resolvedPath,
      lineNumber: idx + 1,
    },
  }));

  this.lines.splice(this.lineIndex, 0, ...includedLines);
}

function parseIncludePath(operand: string): string | null {
  const trimmed = operand.trim();
  if (trimmed.length < 2) return null;
  if (trimmed[0] !== '"' || trimmed[trimmed.length - 1] !== '"') {
    return null;
  }
  return trimmed.slice(1, -1);
}
```

### 2. assembler.ts

#### Update assemble() Signature

```typescript
// BEFORE:
export function assemble(
  sourceText: string,
  options: AssembleOptions = {},
): AssemblyResult {
  // ...
  const preprocessor = new IncrementalPreprocessor(sourceText, {
    sourcePath: options.sourcePath,
    readFile: options.readFile,
  });
  // ...
}

// AFTER:
export function assemble(
  mainFilePath: string,
  options: AssembleOptions = {},
): AssemblyResult {
  // ...
  const preprocessor = new IncrementalPreprocessor(mainFilePath, {
    readFile: options.readFile,
  });
  // ...
}
```

#### Remove preprocessSourceToTaggedLines() Call

```typescript
// DELETE THIS:
let preprocessed: string = "";
const diagnostics: AssemblyDiagnostic[] = [];
try {
  preprocessed = preprocessSourceToTaggedLines(sourceText, {
    sourcePath: options.sourcePath,
    readFile: options.readFile,
  });
} catch (error) {
  // ...
}

// REPLACE WITH:
const diagnostics: AssemblyDiagnostic[] = [];
```

### 3. cli.ts / index.ts

#### Update CLI

```typescript
// BEFORE:
import { readFileSync } from "node:fs";
import { assemble } from "./assembler.js";

const sourceText = readFileSync(cliOptions.inputPath, "utf8");
const result = assemble(sourceText, {
  sourcePath: cliOptions.inputPath,
  readFile: (path) => readFileSync(path, "utf8"),
});

// AFTER:
import { assemble } from "./assembler.js";
import { readFileSync } from "node:fs";

const result = assemble(cliOptions.inputPath, {
  readFile: (path) => readFileSync(path, "utf8"),
});
```

### 4. types.ts

#### Simplify AssembleOptions

```typescript
// BEFORE:
export interface AssembleOptions {
  readonly sourcePath?: string;
  readonly readFile?: (filePath: string) => string;
}

// AFTER:
export interface AssembleOptions {
  readonly readFile?: (filePath: string) => string;
}
```

### 5. assembler.test.ts

#### Update Tests

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

// AFTER (Option 1: Use temp files):
test("assembles simple code", () => {
  const tempFile = createTempFile(`
    LDA #$42
    RTS
  `);
  const result = assemble(tempFile);
  expect(result.binary).toHaveLength(3);
});

// AFTER (Option 2: Use readFile callback):
test("assembles simple code", () => {
  const sourceText = `
    LDA #$42
    RTS
  `;
  const result = assemble("test.asm", {
    readFile: (path) => {
      if (path === "test.asm") return sourceText;
      throw new Error("File not found");
    },
  });
  expect(result.binary).toHaveLength(3);
});
```

### 6. Delete Files

- [ ] Delete `preprocessor.ts` (or keep minimal version for backward compatibility)
- [ ] Delete `source-loader.ts` (broken, incomplete)

---

## Benefits of This Approach

1. **Simpler API**: `assemble(filePath)` instead of `assemble(sourceText)`
2. **Single Entry Point**: All file I/O goes through IncrementalPreprocessor
3. **No Duplication**: File reading happens in one place
4. **Cleaner CLI**: No file reading in CLI code
5. **Better Encapsulation**: IncrementalPreprocessor owns all file I/O
6. **Easier Testing**: Can mock `readFile` callback for all file operations
7. **Fewer Files**: Delete preprocessor.ts and source-loader.ts
8. **Clearer Responsibility**: IncrementalPreprocessor is the preprocessor

---

## New Considerations & Risks

### 1. Synchronous File Reading

**Issue**: IncrementalPreprocessor uses synchronous `readFile` callback.

**Mitigation**: This is consistent with the current architecture. If async is needed later, can be added.

### 2. Path Resolution

**Issue**: Need to resolve relative paths correctly.

**Mitigation**: Use `dirname()` and `resolve()` from `node:path` module.

### 3. Macro Persistence Across Passes

**Issue**: Macros collected in first pass need to be available in subsequent passes.

**Mitigation**: `setKnownMacros()` is already called in `handleMacroDefinition()`.

### 4. Test Suite Changes

**Issue**: All tests need to be updated to use new signature.

**Mitigation**: Use `readFile` callback pattern for mocking file system in tests.

### 5. Backward Compatibility

**Issue**: Existing code calling `assemble(sourceText)` will break.

**Mitigation**: This is a breaking change. Update all call sites. Tests will catch issues.

### 6. Error Handling

**Issue**: File not found errors need clear messages.

**Mitigation**: Catch errors in constructor and throw `IncrementalPreprocessorError` with clear message.

---

## Effort Estimate

| Phase | Task | Duration |
|-------|------|----------|
| 1 | Update IncrementalPreprocessor | 2-3 hours |
| 2 | Update assemble() | 1 hour |
| 3 | Update CLI | 30 min |
| 4 | Update tests | 2-3 hours |
| 5 | Cleanup | 1 hour |
| **Total** | | **6-8 hours** |

---

## Validation Checklist

### Before Starting
- [ ] All existing tests pass
- [ ] No uncommitted changes
- [ ] Create feature branch

### After Each Phase
- [ ] TypeScript compiles without errors
- [ ] Tests pass
- [ ] No regressions
- [ ] Commit with clear message

### Final Validation
- [ ] All tests pass
- [ ] CLI works with sample files
- [ ] No duplication of preprocessing logic
- [ ] Code is cleaner than before
- [ ] Ready to merge

---

## Summary

This revised architecture is **simpler and cleaner** than the original plan:

- ✅ **No separate `loadAndPreprocessFile()` function** - IncrementalPreprocessor handles it
- ✅ **Single entry point** - All file I/O through IncrementalPreprocessor
- ✅ **Fewer files** - Delete preprocessor.ts and source-loader.ts
- ✅ **Cleaner API** - `assemble(filePath)` instead of `assemble(sourceText)`
- ✅ **Better encapsulation** - IncrementalPreprocessor owns all file I/O
- ✅ **Easier to test** - Mock `readFile` callback for all file operations
- ✅ **Faster implementation** - 6-8 hours instead of 9-13 hours

**Status**: ✅ APPROVED - Ready for implementation
