# File Loading & Preprocessing Refactoring - Implementation Checklist

## Phase 1: Prepare IncrementalPreprocessor (Day 1)

### 1.1 Add Include Handling to IncrementalPreprocessor

- [ ] Add `readFile` property to IncrementalPreprocessor constructor options
- [ ] Add `currentDir` property (derived from sourcePath)
- [ ] Add `includeStack` property (track circular includes)
- [ ] Add `MAX_INCLUDE_DEPTH` constant
- [ ] Implement `handleIncludeDirective()` method
  - [ ] Parse include path from operand
  - [ ] Resolve relative/absolute paths
  - [ ] Check circular include
  - [ ] Read file via readFile callback
  - [ ] Convert to TaggedLine[] with proper locations
  - [ ] Splice into lines array at current position
- [ ] Update `processTaggedLine()` to call `handleIncludeDirective()` for `.INCLUDE`

### 1.2 Test IncrementalPreprocessor Changes

- [ ] Run existing tests (should all pass)
- [ ] Add unit tests for `.INCLUDE` handling
  - [ ] Simple include
  - [ ] Nested includes
  - [ ] Circular include detection
  - [ ] File not found error
  - [ ] Path resolution (relative/absolute)

---

## Phase 2: Update assemble() Signature (Day 1)

### 2.1 Change assemble() to Accept TaggedLine[]

- [ ] Update function signature:
  ```typescript
  export function assemble(
    taggedLines: readonly TaggedLine[],
    options: AssembleOptions = {},
  ): AssemblyResult;
  ```
- [ ] Update IncrementalPreprocessor instantiation:
  ```typescript
  const preprocessor = new IncrementalPreprocessor(taggedLines, {
    sourcePath: options.sourcePath,
    readFile: options.readFile,
  });
  ```
- [ ] Remove `preprocessSourceToTaggedLines()` call from assemble()

### 2.2 Update IncrementalPreprocessor Constructor

- [ ] Change constructor signature:
  ```typescript
  constructor(
    taggedLines: readonly TaggedLine[],
    options: PreprocessorOptions = {}
  )
  ```
- [ ] Store taggedLines instead of calling preprocessSourceToTaggedLines()
- [ ] Initialize `this.lines = [...taggedLines]`

### 2.3 Test assemble() Changes

- [ ] Run existing tests (should all pass)
- [ ] Verify symbol table behavior unchanged
- [ ] Verify error reporting unchanged

---

## Phase 3: Create loadAndPreprocessFile() (Day 2)

### 3.1 Create New file-loader.ts (or add to preprocessor.ts)

- [ ] Create `FileLoadOptions` interface
- [ ] Implement `loadAndPreprocessFile()` function:
  ```typescript
  export function loadAndPreprocessFile(
    filePath: string,
    options: FileLoadOptions = {},
  ): TaggedLine[];
  ```
- [ ] Implementation:
  - [ ] Get readFile from options or use readFileSync
  - [ ] Read file: `const sourceText = readFile(filePath)`
  - [ ] Call preprocessSourceToTaggedLines():
    ```typescript
    return preprocessSourceToTaggedLines(sourceText, {
      sourcePath: filePath,
      currentDir: dirname(filePath),
      readFile,
    });
    ```
- [ ] Export from index.ts

### 3.2 Test loadAndPreprocessFile()

- [ ] Unit tests for file loading
  - [ ] Load simple file
  - [ ] Load file with includes
  - [ ] File not found error
  - [ ] Include path resolution
- [ ] Integration tests
  - [ ] Full assembly flow with loadAndPreprocessFile()

---

## Phase 4: Simplify preprocessSourceToTaggedLines() (Day 2)

### 4.1 Remove Include/Macro/Repeat/If Handling

- [ ] Remove `.INCLUDE` handling code
- [ ] Remove `.MACRO` collection code
- [ ] Remove `.REPEAT` expansion code
- [ ] Remove `.IF` pass-through code
- [ ] Remove `collectConstants()` function (no longer needed)
- [ ] Remove `parseIncludePath()` function (move to incremental-preprocessor.ts)
- [ ] Remove `IncludeContext` interface

### 4.2 Implement Minimal Version

- [ ] Simplify to:
  ```typescript
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
- [ ] Update JSDoc to reflect new minimal responsibility
- [ ] Remove unused imports

### 4.3 Move Helper Functions

- [ ] Move `parseIncludePath()` to incremental-preprocessor.ts
- [ ] Update imports in incremental-preprocessor.ts

### 4.4 Test preprocessSourceToTaggedLines()

- [ ] Unit tests for string → TaggedLine conversion
  - [ ] Simple lines
  - [ ] Empty lines
  - [ ] Comments
  - [ ] CRLF vs LF line endings
  - [ ] Source location accuracy

---

## Phase 5: Update CLI (Day 2)

### 5.1 Update CLI Entry Point

- [ ] In `cli.ts` or `index.ts`:

  ```typescript
  // OLD:
  const sourceText = readFileSync(cliOptions.inputPath, "utf8");
  const result = assemble(sourceText, {
    sourcePath: cliOptions.inputPath,
    readFile: (path) => readFileSync(path, "utf8"),
  });

  // NEW:
  const taggedLines = loadAndPreprocessFile(cliOptions.inputPath);
  const result = assemble(taggedLines, {
    sourcePath: cliOptions.inputPath,
    readFile: (path) => readFileSync(path, "utf8"),
  });
  ```

- [ ] Remove direct file reading from CLI
- [ ] Update imports

### 5.2 Test CLI

- [ ] Run existing CLI tests
- [ ] Test with sample assembly files
- [ ] Test with include files

---

## Phase 6: Update Types (Day 2)

### 6.1 Update types.ts

- [ ] Add `FileLoadOptions` interface:
  ```typescript
  export interface FileLoadOptions {
    readonly readFile?: (filePath: string) => string;
  }
  ```
- [ ] Verify `PreprocessorOptions` interface is correct
- [ ] Verify `TaggedLine` interface is exported

### 6.2 Update Exports

- [ ] Ensure `loadAndPreprocessFile` is exported from index.ts
- [ ] Ensure `preprocessSourceToTaggedLines` is still exported
- [ ] Ensure `IncrementalPreprocessor` is still exported
- [ ] Ensure `assemble` is still exported

---

## Phase 7: Update Tests (Day 3)

### 7.1 Update assembler.test.ts

- [ ] Update test setup to use new signatures
- [ ] Change from: `assemble(sourceText, options)`
- [ ] Change to: `assemble(preprocessSourceToTaggedLines(sourceText), options)`
- [ ] Or: `assemble(loadAndPreprocessFile(testFile), options)`
- [ ] Run all tests (should pass)

### 7.2 Update cli.test.ts

- [ ] Update to test loadAndPreprocessFile()
- [ ] Run all tests (should pass)

### 7.3 Add New Tests

- [ ] Test loadAndPreprocessFile() with includes
- [ ] Test IncrementalPreprocessor.handleIncludeDirective()
- [ ] Test circular include detection
- [ ] Test include path resolution
- [ ] Test nested includes

### 7.4 Regression Testing

- [ ] Run full test suite
- [ ] Verify no regressions
- [ ] Check code coverage (should not decrease)

---

## Phase 8: Cleanup (Day 3-4)

### 8.1 Remove Broken Code

- [ ] Delete `source-loader.ts` (incomplete, broken)
- [ ] Remove any deprecated functions

### 8.2 Update Documentation

- [ ] Update README.md if it mentions preprocessing
- [ ] Update JSDoc comments
- [ ] Update inline comments

### 8.3 Final Verification

- [ ] Run full test suite
- [ ] Test with real assembly files
- [ ] Check for any remaining duplication
- [ ] Code review checklist:
  - [ ] No circular dependencies
  - [ ] All exports documented
  - [ ] Error handling consistent
  - [ ] Source locations preserved
  - [ ] No dead code

---

## Validation Checklist

### Before Starting

- [ ] All existing tests pass
- [ ] No uncommitted changes
- [ ] Create feature branch

### After Each Phase

- [ ] Run tests
- [ ] No regressions
- [ ] Commit with clear message

### Final Validation

- [ ] All tests pass
- [ ] No duplication of preprocessing logic
- [ ] No broken imports
- [ ] CLI works with sample files
- [ ] Error messages are clear
- [ ] Source locations are accurate
- [ ] Code is cleaner/simpler than before

---

## Estimated Effort

| Phase                            | Duration       | Status |
| -------------------------------- | -------------- | ------ |
| Phase 1: IncrementalPreprocessor | 2-3 hours      | ⬜     |
| Phase 2: assemble() signature    | 1-2 hours      | ⬜     |
| Phase 3: loadAndPreprocessFile() | 1 hour         | ⬜     |
| Phase 4: Simplify preprocessor   | 1 hour         | ⬜     |
| Phase 5: Update CLI              | 30 min         | ⬜     |
| Phase 6: Update types            | 30 min         | ⬜     |
| Phase 7: Update tests            | 2-3 hours      | ⬜     |
| Phase 8: Cleanup                 | 1 hour         | ⬜     |
| **Total**                        | **9-13 hours** |        |

---

## Risk Mitigation

| Risk                   | Mitigation                                    |
| ---------------------- | --------------------------------------------- |
| Tests break            | Run tests after each phase, revert if needed  |
| Circular includes      | Add includeStack tracking, test thoroughly    |
| Source locations lost  | Verify locations preserved through all passes |
| Performance regression | Benchmark before/after, profile if needed     |
| Incomplete refactoring | Follow checklist strictly, don't skip phases  |
