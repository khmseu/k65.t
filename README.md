# k65.t

`k65.t` is a 6502 multi-pass macro assembler written in TypeScript and Node.js.

## Goals

- Assemble 6502 source into a flat raw binary image.
- Produce a listing with address, output byte count, and source text.
- Emit a symbol table for resolved labels and constants.
- Accept optional labels, optional trailing colons, comma-separated operands, inline semicolon comments, pure comment lines starting with `;` or `*`, and blank lines.
- Expand simple macros defined with `.macro name, arg1, arg2` and terminated by `.endmacro`, using `\arg1`-style substitution inside the macro body.
- Support data directives including `.byte`, `.word`, `.text`, and `.fill`.
- Support `.include "relative/path.asm"` for source composition.
- Support `.align boundary[, fill]` for deterministic padding/layout.
- Support `.repeat count` ... `.endrepeat` blocks for simple counted source expansion.
- Support `.if` / `.elseif` / `.else` / `.endif` blocks for conditional assembly.

## Recommended VS Code extensions

- `dbaeumer.vscode-eslint` for linting.
- `esbenp.prettier-vscode` for formatting.
- `ms-vscode.vscode-typescript-next` for the TypeScript language service.
- `streetsidesoftware.code-spell-checker` for source text hygiene.

## Scripts

- `npm run build` to compile TypeScript into `dist/`.
- `npm start -- [--out-dir DIR] [--bin FILE] [--lst FILE] [--sym FILE] input.asm` to run the assembled CLI entry point.
- `npm test` to run compiled tests.

## Command line

### Basic usage

```text
npm start -- [--out-dir DIR] [--bin FILE] [--lst FILE] [--sym FILE] input.asm
```

The assembler reads `input.asm`, assembles it, and by default writes three files next to the input:

- `input.bin` for the flat binary image.
- `input.lst` for the listing output.
- `input.sym` for the symbol table.

If assembly fails, the CLI prints diagnostics in this shape:

```text
path/to/file.asm:line[:column]: CODE: message
	original source line
```

### Arguments

- `input.asm`: required input source file.
- `--out-dir DIR`: optional directory for generated outputs. If this is set, default output names are still derived from the input stem, but written below `DIR`.
- `--bin FILE`: optional binary output file name or absolute path.
- `--lst FILE`: optional listing output file name or absolute path.
- `--sym FILE`: optional symbol-table output file name or absolute path.

If `--bin`, `--lst`, or `--sym` are relative paths, they are resolved under `--out-dir` when that flag is present, otherwise relative to the input file directory.

### Examples

Write default output names next to the input:

```text
npm start -- examples/demo.asm
```

Write all default output names into a build directory:

```text
npm start -- --out-dir build examples/demo.asm
```

Override selected output files:

```text
npm start -- --out-dir build --bin demo.prg --lst demo.list examples/demo.asm
```

## Directive reference

### `.org expression`

Sets the current assembly location counter. This changes the address shown in listings and the position used for subsequent emitted bytes.

Example:

```asm
.org $8000
start lda #$01
```

### `label .equ expression`

Defines a constant symbol without emitting bytes. The label is bound to the expression value and may be referenced later in expressions or operands.

Example:

```asm
screen .equ $0400
lda #screen & $FF
```

### `label .set expression` or `label = expression`

Defines a reassignable symbol without emitting bytes. Later `.set` or `=` assignments to the same label update the value seen by following source lines.

Example:

```asm
count .set 1
count = count + 1
```

### `.byte expr[, expr ...]`

Emits one byte per operand. Each expression is truncated to `$00`-`$FF` during output.

Example:

```asm
.byte $A9, 1, %10101010
```

### `.word expr[, expr ...]`

Emits one 16-bit little-endian value per operand.

Example:

```asm
.word start, $FFFC
```

### `.text item[, item ...]`

Emits text bytes. Each item may be either a quoted string literal or a normal expression that emits one byte. Supported escapes inside string literals are `\n`, `\r`, `\t`, `\\`, `\"`, `\'`, and `\xHH`.

Example:

```asm
.text "HELLO", 13, 10
```

### `.fill count[, value]`

Emits `count` copies of `value`. When `value` is omitted, the fill byte defaults to zero.

Example:

```asm
.fill 32, $FF
```

### `.align boundary[, fill]`

Pads output until the current location is aligned to `boundary`. When `fill` is omitted, padding bytes default to zero.

Example:

```asm
.align 256, $FF
```

### `.include "path"`

Reads another source file during preprocessing and inserts its contents at the include site. Relative paths are resolved from the including source file.

Example:

```asm
.include "macros/common.asm"
```

### `.macro name[, arg ...]` / `.endmacro`

Defines a simple macro block during preprocessing. Arguments are substituted into the macro body using `\argName` or `\1`, `\2`, and so on.

Example:

```asm
.macro loadpair, left, right
	lda #\left
	ldx #\right
.endmacro

loadpair 1, 2
```

### `.repeat count` / `.endrepeat`

Repeats a source block `count` times during preprocessing. This is source expansion, not a runtime loop.

Example:

```asm
.repeat 3
	.byte $7F
.endrepeat
```

### `.if expression` / `.elseif expression` / `.else` / `.endif`

Selects exactly one source branch during preprocessing. Conditions are evaluated as expressions; zero is false and any non-zero value is true.

Example:

```asm
.if 0
	.byte $00
.elseif 1
	.byte $11
.else
	.byte $22
.endif
```

## Source format notes

- A line may contain an optional label, an opcode or directive, comma-separated operands, and an optional semicolon comment.
- Labels may be written with or without a trailing colon.
- Cheap labels begin with `@` and are scoped to the nearest preceding non-cheap label, so the same cheap label may be reused under different parent labels.
- Reassignable labels use `.set` or `=` and are resolved sequentially, so each reassignment only affects later lines.
- Pure comment lines may start with `;` or `*`.
- Blank lines are accepted.
- Expressions currently support numeric literals, symbols, `*` for current location, single-character string literals (`'A'`, `"\n"`, `'\x41'`), parentheses, unary `+`, unary `-`, `~`, arithmetic `+ - * / %`, and bitwise `& ^ |`.