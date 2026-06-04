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

## Listing control directives

Listing control directives do not emit any code bytes; they control the formatting of the listing output.

### `.list`

Enables listing output for subsequent lines. This is the default state.

Example:

```asm
.nolist
	.byte $00, $00, $00	; Not included in listing
.list
	lda #$01		; Included in listing
```

### `.nolist`

Disables listing output for subsequent lines. Source is suppressed in the listing until a `.list` directive is encountered.

### `.page` / `.eject`

Marks a page break point in the listing. Tools that process the listing can use this to insert page headers/footers or split long listings.

Example:

```asm
	ldy #$00
.page
	ldx #$00
```

### `.title text`

Sets the page title for listing output. This text typically appears in page headers when listings are printed or formatted.

Example:

```asm
.title "6502 Monitor ROM"
```

### `.subttl text`

Sets the page subtitle for listing output. This text typically appears below the title in page headers.

Example:

```asm
.title "Applesoft BASIC"
.subttl "Main Entry Point"
```

### `.pagesize lines`

Sets the number of lines per page in the listing output. This directive tells listing formatters where to insert page breaks. A value of 0 (the default) means no page paging.

Example:

```asm
.pagesize 60
```

### `.bytesperline count`

Sets the number of bytes to display per line in the listing output. When an instruction or data directive emits more bytes than specified, the listing continues on additional lines with updated address prefixes. Default is 16 bytes per line.

Example:

```asm
.bytesperline 8
.byte $00, $01, $02, $03, $04, $05, $06, $07, $08, $09
```

In the listing, this produces:

```text
8000 00 01 02 03 04 05 06 07
8008 08 09
```

### `.print arguments...`

Outputs its arguments to stdout during assembly. This directive is useful for debugging, displaying configuration information, or providing feedback during the build process. Arguments are joined with spaces and printed as-is.

Example:

```asm
.if REALIO == 3
	.print Configuration: COMMODORE platform selected
	DISKO = 1
	RAMLOC = $0400
.endif
```

When assembling with `REALIO = 3`, the output would be:

```
Configuration: COMMODORE platform selected
```

## Expressions

Expressions are used in directives and addressing modes to compute values. All expressions evaluate to 16-bit unsigned integers (0–65535).

### Numeric Literals

| Format           | Example       | Result |
| ---------------- | ------------- | ------ |
| Decimal          | `1000`        | 1000   |
| Hexadecimal ($)  | `$3E8`        | 1000   |
| Hexadecimal (0x) | `0x3E8`       | 1000   |
| Octal (0o)       | `0o1750`      | 1000   |
| Binary (%)       | `%1111101000` | 1000   |

### Primitives

| Primitive      | Description                      | Example                 |
| -------------- | -------------------------------- | ----------------------- |
| `*`            | Current program counter location | `JMP *` (infinite loop) |
| `symbol`       | Reference to a label or constant | `LDA START`             |
| String literal | Single character in quotes       | `'A'` = 65, `"\n"` = 10 |

String escape sequences: `\n` (newline = 0x0A), `\r` (carriage return = 0x0D), `\t` (tab = 0x09), `\\` (backslash), `\"` (quote), `\'` (apostrophe), `\xHH` (hex byte).

### Operators

#### Unary Operators (right-associative)

| Operator | Description                     | Example            |
| -------- | ------------------------------- | ------------------ |
| `+value` | Unary plus (no-op)              | `+$100` = 256      |
| `-value` | Negation (two's complement)     | `-1` = 65535       |
| `~value` | Bitwise NOT                     | `~0` = 65535       |
| `!value` | Logical NOT (0→1, nonzero→0)    | `!0` = 1, `!5` = 0 |
| `<value` | Low byte (mask with 0xFF)       | `<$1234` = 0x34    |
| `>value` | High byte (shift right 8, mask) | `>$1234` = 0x12    |

#### Binary Operators (left-associative, listed by precedence)

| Operator | Precedence | Description                      | Example            |
| -------- | ---------- | -------------------------------- | ------------------ |
| `*`      | Highest    | Multiplication                   | `2*3` = 6          |
| `/`      |            | Integer division                 | `7/2` = 3          |
| `%`      |            | Modulo (remainder)               | `7%3` = 1          |
| `+`      |            | Addition                         | `1+2` = 3          |
| `-`      |            | Subtraction                      | `5-2` = 3          |
| `&`      |            | Bitwise AND                      | `$0F & $F0` = 0    |
| `^`      |            | Bitwise XOR                      | `$0F ^ $F0` = 255  |
| `\|`     |            | Bitwise OR                       | `$0F \| $F0` = 255 |
| `==`     |            | Equality (1 if true, 0 if false) | `1==1` = 1         |
| `=`      |            | Equality (alternative syntax)    | `1=1` = 1          |
| `!=`     |            | Not equal                        | `1!=2` = 1         |
| `<>`     |            | Not equal (alternative syntax)   | `1<>2` = 1         |
| `<`      | Lowest     | Less than                        | `1<2` = 1          |
| `>`      |            | Greater than                     | `2>1` = 1          |
| `<=`     |            | Less than or equal               | `1<=2` = 1         |
| `>=`     |            | Greater than or equal            | `2>=1` = 1         |

### Examples

```asm
; Numeric literals
.byte $FF           ; Hex: 255
.byte 0o377         ; Octal: 255
.byte %11111111     ; Binary: 255
.byte 255           ; Decimal: 255

; Current location
START: LDA #0
       BNE START    ; Branch target is current PC

; Symbol references
PI = $3.14          ; Error: invalid format, use integer
TWOPI = PI*2        ; Error: PI is not defined yet

MODE = 3
.if MODE==3
  DISKO = 1
.endif

; Byte selectors
.word $1234         ; 16-bit value
.byte >$1234        ; High byte: $12
.byte <$1234        ; Low byte: $34

; Bitwise operations
MASK = $FF00 & $00FF  ; Result: 0
VALUE = $0F | $F0     ; Result: $FF
TOGGLE = $AA ^ $55    ; Result: $FF

; Complex expressions with operators
SIZE = 256 * 4 - 10   ; Result: 1014
ADDR = BASE + (OFFSET / 2)
```

## Source format notes

- A line may contain an optional label, an opcode or directive, comma-separated operands, and an optional semicolon comment.
- Labels may be written with or without a trailing colon.
- Cheap labels begin with `@` and are scoped to the nearest preceding non-cheap label, so the same cheap label may be reused under different parent labels.
- Reassignable labels use `.set` or `=` and are resolved sequentially, so each reassignment only affects later lines.
- Pure comment lines may start with `;` or `*`.
- Blank lines are accepted.
