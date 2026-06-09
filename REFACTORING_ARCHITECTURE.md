```markdown
# File Loading & Preprocessing Architecture Refactoring

## Current Architecture Problem

The assembler has **duplicate preprocessing logic** across three files:

- **preprocessor.ts**: Handles `.INCLUDE` (recursive), `.MACRO` collection, `.REPEAT` expansion, `.IF` pass-through
- **incremental-preprocessor.ts**: Re-implements `.MACRO` collection, `.REPEAT`, `.IF`, `.ELSE`, `.ELSEIF`, `.ENDIF`
- **source-loader.ts**: Incomplete refactoring (broken, imports non-existent files)

### Current Data Flow

~~~
CLI (index.ts)
  ↓ readFileSync(inputPath)
  ↓ sourceText: string
assemble(sourceText)
  ↓
IncrementalPreprocessor(sourceText)
  ↓ calls preprocessSourceToTaggedLines(sourceText)
  ↓ (handles .INCLUDE recursively)
  ↓ returns TaggedLine[]
  ↓ processes with symbol table (handles .MACRO, .REPEAT, .IF)
  ↓
SourceLine[] (to assembler passes)
~~~

**Problems:**
1. `.INCLUDE` handled in preprocessor.ts, not available to symbol table
2. `.MACRO` collection happens twice (preprocessor.ts → setKnownMacros, then incremental-preprocessor.ts)
3. `.REPEAT` expansion happens in preprocessor.ts, then re-processed in incremental-preprocessor.ts
4. Source locations may be lost or inconsistent
5. `assemble()` takes string, not structured data

---

## Proposed Architecture

### Design Principle

**Separate concerns:**
1. **File I/O** → `loadAndPreprocessFile(filename)`
2. **String → TaggedLine conversion** → `preprocessor.ts` (minimal)
3. **All structural preprocessing** → `IncrementalPreprocessor` (with symbol table access)

### New Data Flow

~~~
CLI (index.ts)
  ↓
loadAndPreprocessFile(inputPath, options)
  ├─ readFile(inputPath) → sourceText
  ├─ preprocessSourceToTaggedLines(sourceText, { sourcePath, readFile })
  │  └─ (ONLY: string → TaggedLine, with location tracking)
  └─ returns TaggedLine[]
  ↓
assemble(taggedLines)
  ↓
IncrementalPreprocessor(taggedLines)
  ├─ handles .INCLUDE (recursive, with symbol table)
  ├─ collects .MACRO definitions
  ├─ expands .REPEAT blocks
  ├─ evaluates .IF/.ELSE/.ELSEIF/.ENDIF
  └─ returns SourceLine[] (one at a time via nextLine())
  ↓
Assembler passes (sizing, diagnostics, emission)
~~~

### Key Changes

#### 1. New Function: `loadAndPreprocessFile()`

**Location:** `preprocessor.ts` or new `file-loader.ts`

```typescript
export interface FileLoadOptions {
  readonly readFile?: (filePath: string) => string;
}

/**
 * Load a source file and prepare it for assembly.
 * 
 * Responsibility:
 * - Read the file from disk
 * - Convert to TaggedLine[] (preserving source locations)
 * - Return structured data ready for IncrementalPreprocessor
 * 
 * Does NOT handle:
 * - .INCLUDE (moved to IncrementalPreprocessor)
 * - .MACRO collection (moved to IncrementalPreprocessor)
 * - .REPEAT expansion (moved to IncrementalPreprocessor)
 * - .IF evaluation (moved to IncrementalPreprocessor)
 */
export function loadAndPreprocessFile(
  filePath: string,
  options: FileLoadOptions = {}
): TaggedLine[] {
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const sourceText = readFile(filePath);
  
  return preprocessSourceToTaggedLines(sourceText, {
    sourcePath: filePath,
    currentDir: dirname(filePath),
    readFile,
  });
}
```

#### 2. Simplified `preprocessSourceToTaggedLines()`

**Location:** `preprocessor.ts`

**Current responsibility (KEEP):**
- Split source string by newlines
- Attach SourceLocation to each line
- Return `TaggedLine[]`

**Current responsibility (REMOVE):**
- ~~`.INCLUDE` handling~~ → Move to IncrementalPreprocessor
- ~~`.MACRO` collection~~ → Move to IncrementalPreprocessor
- ~~`.REPEAT` expansion~~ → Move to IncrementalPreprocessor
- ~~`.IF` pass-through~~ → Move to IncrementalPreprocessor

```typescript
/**
 * Convert source string to TaggedLine array.
 * 
 * ONLY responsibility:
 * - Split by newlines
 * - Attach SourceLocation to each line
 * - Return TaggedLine[]
 * 
 * All preprocessing directives (.INCLUDE, .MACRO, .REPEAT, .IF)
 * are handled by IncrementalPreprocessor with symbol table access.
 */
export function preprocessSourceToTaggedLines(
  text: string,
  options: PreprocessOptions = {}
): TaggedLine[] {
  const sourcePath = options.sourcePath ?? '<source>';
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

#### 3. Enhanced `IncrementalPreprocessor`

**Location:** `incremental-preprocessor.ts`

**Add to existing responsibilities:**
- Handle `.INCLUDE` directives (recursive file loading)
  - Use `readFile` option to load included files
  - Convert to TaggedLine[] and splice into lines array
  - Track include stack to prevent circular includes

**Keep existing responsibilities:**
- Collect `.MACRO` definitions
- Expand macro invocations
- Handle `.REPEAT` blocks
- Evaluate `.IF`/`.ELSE`/`.ELSEIF`/`.ENDIF`

```typescript
export interface PreprocessorOptions {
  readonly sourcePath?: string;
  readonly readFile?: (filePath: string) => string;
}

export class IncrementalPreprocessor {
  constructor(
    taggedLines: readonly TaggedLine[],
    options: PreprocessorOptions = {}
  ) {
    this.originalLines = [...taggedLines];
    this.lines = [...taggedLines];
    this.readFile = options.readFile ?? 
      ((path) => readFileSync(path, 'utf8'));
    this.currentDir = options.sourcePath 
      ? dirname(options.sourcePath)
      : process.cwd();
  }

  // NEW: Handle .INCLUDE directive
  private handleIncludeDirective(
    operand: string,
    location: SourceLocation
  ): void {
    const includePath = parseIncludePath(operand);
    if (!includePath) {
      throw new IncrementalPreprocessorError(
        'E_INCLUDE_PATH',
        `.include path must be quoted: ${operand}`,
        location
      );
    }

    const resolvedPath = isAbsolute(includePath)
      ? resolve(includePath)
      : resolve(join(this.currentDir, includePath));

    if (this.includeStack.includes(resolvedPath)) {
      throw new IncrementalPreprocessorError(
        'E_INCLUDE_CYCLE',
        `Circular include: ${resolvedPath}`,
        location
      );
    }

    let includedText: string;
    try {
      includedText = this.readFile(resolvedPath);
    } catch {
      throw new IncrementalPreprocessorError(
        'E_INCLUDE_READ',
        `Cannot read include file: ${resolvedPath}`,
        location
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
}
```

#### 4. Updated `assemble()`

**Location:** `assembler.ts`

**Before:**
```typescript
export interface AssembleOptions {
  readonly sourcePath?: string;
  readonly readFile?: (filePath: string) => string;
}

export function assemble(
  sourceText: string,
  options: AssembleOptions = {}
): AssemblyResult {
  // ...
}
```

**After:**
```typescript
export interface AssembleOptions {
  readonly sourcePath?: string;
  readonly readFile?: (filePath: string) => string;
}

export function assemble(
  taggedLines: readonly TaggedLine[],
  options: AssembleOptions = {}
): AssemblyResult {
  // ... passes taggedLines to IncrementalPreprocessor
  const preprocessor = new IncrementalPreprocessor(taggedLines, {
    sourcePath: options.sourcePath,
    readFile: options.readFile,
  });
  // ...
}
```

#### 5. Updated CLI

**Location:** `cli.ts` / `index.ts`

**Before:**
```typescript
const sourceText = readFileSync(cliOptions.inputPath, 'utf8');
const result = assemble(sourceText, {
  sourcePath: cliOptions.inputPath,
  readFile: (path) => readFileSync(path, 'utf8'),
});
```

**After:**
```typescript
const taggedLines = loadAndPreprocessFile(cliOptions.inputPath);
const result = assemble(taggedLines, {
  sourcePath: cliOptions.inputPath,
  readFile: (path) => readFileSync(path, 'utf8'),
});
```

---

## Migration Strategy

### Phase 1: Prepare IncrementalPreprocessor (Day 1)
- Add `.INCLUDE` handling to IncrementalPreprocessor
- Add `readFile` and `currentDir` properties
- Test with existing test suite

### Phase 2: Update assemble() signature (Day 1)
- Change `assemble(sourceText, options)` → `assemble(taggedLines, options)`
- Update IncrementalPreprocessor instantiation
- Maintain backward compatibility with wrapper if needed

### Phase 3: Create loadAndPreprocessFile() (Day 2)
- Implement new function in preprocessor.ts
- Export from index.ts
- Update CLI to use it

### Phase 4: Simplify preprocessSourceToTaggedLines() (Day 2)
- Remove `.INCLUDE` handling
- Remove `.MACRO` collection
- Remove `.REPEAT` expansion
- Keep only string → TaggedLine conversion

### Phase 5: Update tests (Day 3)
- Update existing tests to use new signatures
- Add tests for loadAndPreprocessFile()
- Add tests for .INCLUDE in IncrementalPreprocessor
- Verify all existing tests still pass

### Phase 6: Cleanup (Day 3-4)
- Remove source-loader.ts (incomplete/broken)
- Remove old preprocessor string-based logic
- Update documentation
- Remove any deprecated exports

---

## Benefits

### Architectural
- **Single responsibility**: Each function does one thing
- **No duplication**: Preprocessing logic in one place (IncrementalPreprocessor)
- **Symbol table aware**: .INCLUDE can use current symbols if needed
- **Cleaner separation**: File I/O vs. preprocessing vs. assembly

### Code Quality
- **Fewer bugs**: Less duplicated code = fewer places to fix bugs
- **Easier to test**: Each component independently testable
- **Better maintainability**: Changes to preprocessing logic in one place
- **Consistent behavior**: All directives use same evaluation context

### Performance
- **No re-splitting**: Source string split once, not on every pass
- **No re-parsing**: Directives parsed once by IncrementalPreprocessor
- **Potential for optimization**: Could cache included files

### User Experience
- **Better error messages**: Source locations preserved throughout
- **Clearer diagnostics**: Errors point to actual source files
- **Include-aware symbols**: Macros/symbols from includes visible in dependent code

---

## Files Changed

| File | Changes | Impact |
|------|---------|--------|
| `preprocessor.ts` | Add `loadAndPreprocessFile()`, simplify `preprocessSourceToTaggedLines()` | Medium |
| `incremental-preprocessor.ts` | Add `.INCLUDE` handling | Medium |
| `assembler.ts` | Change `assemble(sourceText)` → `assemble(taggedLines)` | Medium |
| `cli.ts` / `index.ts` | Use `loadAndPreprocessFile()` | Low |
| `types.ts` | Add `FileLoadOptions` interface | Low |
| `source-loader.ts` | Delete (broken, incomplete) | Low |
| Tests | Update to new signatures | Medium |

---

## Testing Strategy

### Existing Tests (Must Pass)
- All `assembler.test.ts` tests
- All `cli.test.ts` tests
- All `incremental-preprocessor.ts` tests (if any)

### New Tests Needed
1. **loadAndPreprocessFile()**
   - Load simple file
   - Load file with includes
   - Circular include detection
   - File not found error
   - Include path resolution (relative/absolute)

2. **IncrementalPreprocessor with .INCLUDE**
   - .INCLUDE directive processing
   - Nested includes
   - Include with macros
   - Include with symbols
   - Include depth limit

3. **Integration**
   - Full assembly with includes
   - Includes with macros
   - Includes with .REPEAT
   - Includes with .IF

### Regression Tests
- All existing functionality must work unchanged
- Symbol table behavior unchanged
- Error reporting unchanged or improved
- Listing output unchanged

---

## Open Questions

1. **Should loadAndPreprocessFile() be in preprocessor.ts or new file-loader.ts?**
   - Recommendation: New `file-loader.ts` (cleaner separation)

2. **Should .INCLUDE require readFile option or use readFileSync by default?**
   - Recommendation: Default to readFileSync, allow override for testing

3. **Should .INCLUDE be able to use current symbol table?**
   - Recommendation: Not yet (would complicate semantics), but architecture allows it

4. **Should we deprecate assemble(sourceText) or remove it immediately?**
   - Recommendation: Remove immediately (clean break, tests will catch issues)
```

