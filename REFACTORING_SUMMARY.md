# Preprocessing Refactoring - Executive Summary

## Problem Statement

The k65.t assembler has **duplicate preprocessing logic** spread across multiple files:

- **preprocessor.ts**: Handles `.INCLUDE`, `.MACRO`, `.REPEAT`, `.IF`
- **incremental-preprocessor.ts**: Re-implements `.MACRO`, `.REPEAT`, `.IF`, `.ELSE`, `.ELSEIF`, `.ENDIF`
- **source-loader.ts**: Incomplete/broken refactoring attempt

This duplication causes:

- Maintenance burden (bugs need fixing in multiple places)
- Inconsistent behavior (different evaluation contexts)
- Unclear responsibility boundaries
- Unnecessary re-processing on each assembler pass

## Solution Overview

### Key Insight

Most preprocessing should live in **IncrementalPreprocessor** because:

1. It runs in parallel with the assembler
2. It has access to the current symbol table
3. It can make decisions based on runtime values (not just static constants)
4. It's the right place for all symbol-dependent operations

### Architecture Changes

| Component               | Before                                                      | After                                                        |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| **File Loading**        | CLI reads file, passes string                               | `loadAndPreprocessFile()` reads file, returns `TaggedLine[]` |
| **String → TaggedLine** | In `preprocessSourceToTaggedLines()` with directives        | Minimal function (just split + location)                     |
| **.INCLUDE**            | In `preprocessor.ts` (no symbol access)                     | In `IncrementalPreprocessor` (has symbol table)              |
| **.MACRO**              | Collected in `preprocessor.ts`, re-collected in incremental | Only in `IncrementalPreprocessor`                            |
| **.REPEAT**             | Expanded in `preprocessor.ts`, re-processed in incremental  | Only in `IncrementalPreprocessor`                            |
| **.IF**                 | Pass-through in `preprocessor.ts`, evaluated in incremental | Only in `IncrementalPreprocessor`                            |
| **assemble() input**    | `sourceText: string`                                        | `taggedLines: readonly TaggedLine[]`                         |

### New Functions

```typescript
// Load file and prepare for assembly
export function loadAndPreprocessFile(
  filePath: string,
  options: FileLoadOptions = {},
): TaggedLine[];

// Convert string to TaggedLine (minimal - just split + location)
export function preprocessSourceToTaggedLines(
  text: string,
  options: PreprocessOptions = {},
): TaggedLine[];

// Updated to accept TaggedLine[] instead of string
export function assemble(
  taggedLines: readonly TaggedLine[],
  options: AssembleOptions = {},
): AssemblyResult;
```

### Enhanced IncrementalPreprocessor

Adds `.INCLUDE` handling to existing capabilities:

- Reads included files via `readFile` callback
- Resolves relative/absolute paths
- Detects circular includes
- Preserves source locations
- Splices included content into line stream

## Benefits

### Code Quality

- ✅ **No duplication**: Preprocessing logic in one place
- ✅ **Single responsibility**: Each function does one thing
- ✅ **Cleaner separation**: File I/O vs preprocessing vs assembly
- ✅ **Easier to test**: Each component independently testable

### Correctness

- ✅ **Symbol-aware includes**: .INCLUDE can use current symbol table
- ✅ **Consistent evaluation**: All directives use same context
- ✅ **Better error tracking**: Source locations preserved throughout
- ✅ **No re-processing**: Directives handled once, not twice

### Maintainability

- ✅ **Fewer bugs**: Changes in one place only
- ✅ **Clear responsibility**: Know where each directive is handled
- ✅ **Easier debugging**: Simpler data flow
- ✅ **Better documentation**: Each function has clear purpose

### Performance

- ✅ **No re-splitting**: Source split once, not on every pass
- ✅ **No re-parsing**: Directives parsed once by IncrementalPreprocessor
- ✅ **Potential optimizations**: Can cache included files

## Implementation Plan

### 8 Phases, ~10 hours total

| Phase | Task                                       | Duration | Day |
| ----- | ------------------------------------------ | -------- | --- |
| 1     | Add `.INCLUDE` to IncrementalPreprocessor  | 2-3 hrs  | 1   |
| 2     | Update `assemble()` signature              | 1-2 hrs  | 1   |
| 3     | Create `loadAndPreprocessFile()`           | 1 hr     | 2   |
| 4     | Simplify `preprocessSourceToTaggedLines()` | 1 hr     | 2   |
| 5     | Update CLI                                 | 30 min   | 2   |
| 6     | Update types                               | 30 min   | 2   |
| 7     | Update tests                               | 2-3 hrs  | 3   |
| 8     | Cleanup                                    | 1 hr     | 3-4 |

### Key Milestones

1. **Day 1 EOD**: IncrementalPreprocessor handles `.INCLUDE`, `assemble()` accepts `TaggedLine[]`
2. **Day 2 EOD**: CLI uses `loadAndPreprocessFile()`, preprocessor simplified
3. **Day 3 EOD**: All tests updated and passing
4. **Day 4 EOD**: Cleanup complete, ready to merge

## Files Changed

| File                          | Changes                                 | Lines    | Risk   |
| ----------------------------- | --------------------------------------- | -------- | ------ |
| `incremental-preprocessor.ts` | Add `.INCLUDE` handling                 | +100     | Low    |
| `assembler.ts`                | Change signature, remove preprocessing  | -20      | Low    |
| `preprocessor.ts`             | Add `loadAndPreprocessFile()`, simplify | -300     | Low    |
| `cli.ts` / `index.ts`         | Use new function                        | -5       | Low    |
| `types.ts`                    | Add `FileLoadOptions`                   | +5       | Low    |
| `source-loader.ts`            | Delete                                  | -300     | Low    |
| Tests                         | Update signatures                       | +50      | Medium |
| **Total**                     |                                         | **-465** |        |

## Risk Assessment

| Risk                   | Likelihood | Impact | Mitigation                                 |
| ---------------------- | ---------- | ------ | ------------------------------------------ |
| Tests break            | Low        | High   | Run tests after each phase                 |
| Circular includes      | Low        | High   | Add includeStack tracking, test thoroughly |
| Source locations lost  | Low        | High   | Verify locations preserved in tests        |
| Performance regression | Very Low   | Medium | Benchmark before/after                     |
| Incomplete refactoring | Very Low   | Medium | Follow checklist strictly                  |

**Overall Risk**: ⬜⬜⬜ **LOW** - Well-defined scope, clear migration path, good test coverage

## Success Criteria

- ✅ All existing tests pass
- ✅ No duplication of preprocessing logic
- ✅ Source locations preserved throughout pipeline
- ✅ CLI works with sample files (simple and with includes)
- ✅ Error messages are clear and accurate
- ✅ Code is cleaner/simpler than before
- ✅ No circular dependencies
- ✅ No broken imports

## Documentation

Three detailed documents have been created:

1. **REFACTORING_ARCHITECTURE.md** (12.4 KB)
   - Complete architecture overview
   - Current vs proposed data flow
   - Function signatures
   - Benefits analysis

2. **REFACTORING_CHECKLIST.md** (8.6 KB)
   - Step-by-step implementation checklist
   - 8 phases with detailed tasks
   - Validation points
   - Effort estimates

3. **REFACTORING_CODE_CHANGES.md** (12.5 KB)
   - Exact code changes for each file
   - Before/after code snippets
   - Migration path summary
   - Validation checklist

## Next Steps

1. **Review** these documents with team
2. **Create feature branch**: `refactor/preprocessing-architecture`
3. **Follow REFACTORING_CHECKLIST.md** phase by phase
4. **Reference REFACTORING_CODE_CHANGES.md** for exact changes
5. **Run tests** after each phase
6. **Create PR** when complete
7. **Code review** before merge

## Questions?

Refer to the detailed documents:

- Architecture questions → REFACTORING_ARCHITECTURE.md
- Implementation questions → REFACTORING_CODE_CHANGES.md
- Progress tracking → REFACTORING_CHECKLIST.md

---

**Status**: 📋 Ready for implementation
**Effort**: 9-13 hours
**Risk**: Low
**Benefit**: High (code quality, maintainability, correctness)
