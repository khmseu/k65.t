import { assemble } from "./assembler.js";
import assert from "node:assert/strict";
import { formatListing } from "./listing.js";
import test from "node:test";

function makeReadFile(files: Record<string, string>): (path: string) => string {
  return (path: string) => {
    // Try exact match first, then basename match
    if (path in files) return files[path];
    const basename = path.split(/[/\\]/).pop()!;
    if (basename in files) return files[basename];
    throw new Error(`File not found: ${path}`);
  };
}

test("assemble supports labels, forward references, directives, and listing format", () => {
  const source = [
    "; leading comment",
    "* alternate comment",
    "  .org $8000",
    "start: LDA #$01",
    "       STA $0200",
    "loop   INX",
    "       BNE loop",
    "tail   .byte $AA, 2",
    "       .word start",
    "",
  ].join("\n");

  const result = assemble("test.asm", {
    readFile: makeReadFile({ "test.asm": source }),
  });

  assert.equal(result.startAddress, 0x8000);
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(
    Array.from(result.binary),
    [0xa9, 0x01, 0x8d, 0x00, 0x02, 0xe8, 0xd0, 0xfd, 0xaa, 0x02, 0x00, 0x80],
  );

  const symbolMap = new Map(
    result.symbols.map((entry) => [entry.name, entry.value]),
  );
  assert.equal(symbolMap.get("LOOP"), 0x8005);
  assert.equal(symbolMap.get("START"), 0x8000);
  assert.equal(symbolMap.get("TAIL"), 0x8008);

  const listingText = formatListing(result.listing);
  // Check for listing output (format has padding for alignment)
  assert.ok(
    /8000\s+A9\s+01\s+start:\s+LDA/.test(listingText),
    JSON.stringify(result.listing, null, 2),
  );
  assert.ok(
    /8005\s+E8\s+loop\s+INX/.test(listingText),
    JSON.stringify(result.listing, null, 2),
  );
  assert.ok(
    /8006\s+D0\s+FD.*8005.*BNE\s+loop/.test(listingText),
    JSON.stringify(result.listing, null, 2),
  );
});

test("assemble expands simple macros before pass resolution", () => {
  const source = [
    ".org $9000",
    ".macro loadpair, left, right",
    "  lda #\\left",
    "  ldx #\\right",
    ".endmacro",
    "start loadpair 1, 2",
  ].join("\n");

  const result = assemble("test.asm", {
    readFile: makeReadFile({ "test.asm": source }),
  });

  assert.equal(result.startAddress, 0x9000);
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0xa9, 0x01, 0xa2, 0x02]);
  assert.equal(
    result.symbols.find((entry) => entry.name === "START")?.value,
    0x9000,
  );
  assert.ok(
    /9000\s+A9\s+01\s+start\s+lda\s+#1/.test(formatListing(result.listing)),
    JSON.stringify(result.listing, null, 2),
  );
});

test("assemble resolves equ-style constants and parenthesized expressions", () => {
  const source = [
    ".org $8800",
    "base .equ $20",
    "offset .equ (base + 3) * 2",
    "start lda #(offset - 1)",
    "      sta base + 1",
    "      .word (start + offset)",
  ].join("\n");

  const result = assemble("test.asm", {
    readFile: makeReadFile({ "test.asm": source }),
  });

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(
    Array.from(result.binary),
    [0xa9, 0x45, 0x85, 0x21, 0x46, 0x88],
  );
  assert.equal(
    result.symbols.find((entry) => entry.name === "BASE")?.value,
    0x20,
  );
  assert.equal(
    result.symbols.find((entry) => entry.name === "OFFSET")?.value,
    0x46,
  );
  assert.equal(
    result.symbols.find((entry) => entry.name === "START")?.value,
    0x8800,
  );
});

test("assemble allows single-character string literals in expressions", () => {
  const source = [
    ".org $8810",
    "start .byte 'A', \"B\", '\\n'",
    "      lda #'C'",
  ].join("\n");

  const result = assemble("test.asm", {
    readFile: makeReadFile({ "test.asm": source }),
  });

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0x41, 0x42, 0x0a, 0xa9, 0x43]);
  assert.equal(
    result.symbols.find((entry) => entry.name === "START")?.value,
    0x8810,
  );
});

test("assemble reports multi-character string literals in expressions", () => {
  const source = [".org $8820", "      .byte 'AB'"].join("\n");

  const result = assemble("test.asm", {
    readFile: makeReadFile({ "test.asm": source }),
  });

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "E_EXPR_STRING_LENGTH");
});

test("assemble accepts label-only lines as zero-size anchors", () => {
  const source = [
    ".org $8830",
    "start",
    "      .byte $AA",
    "next",
    "      .byte $BB",
  ].join("\n");

  const result = assemble("test.asm", {
    readFile: makeReadFile({ "test.asm": source }),
  });

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0xaa, 0xbb]);

  const symbolMap = new Map(
    result.symbols.map((entry) => [entry.name, entry.value]),
  );
  assert.equal(symbolMap.get("START"), 0x8830);
  assert.equal(symbolMap.get("NEXT"), 0x8831);
});

test("assemble allows accumulator instructions without explicit A operand", () => {
  const source = [
    ".org $8840",
    "      asl",
    "      lsr",
    "      rol",
    "      ror",
  ].join("\n");

  const result = assemble("test.asm", {
    readFile: makeReadFile({ "test.asm": source }),
  });

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0x0a, 0x4a, 0x2a, 0x6a]);
});

test("assemble supports unary < and > byte selectors in expressions", () => {
  const source = [
    ".org $8850",
    "pointer .equ $1234",
    "      lda #<pointer",
    "      ldy #>pointer",
    "      .byte <($BEEF), >($BEEF)",
  ].join("\n");

  const result = assemble("test.asm", {
    readFile: makeReadFile({ "test.asm": source }),
  });

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(
    Array.from(result.binary),
    [0xa9, 0x34, 0xa0, 0x12, 0xef, 0xbe],
  );
});

test("assemble preserves semicolons and commas inside quoted string expressions", () => {
  const source = [
    ".org $8860",
    '      cmp #(";"&%01111111)+1 ; this is a real comment',
    '      cmp #(",""&%01111111)',
  ].join("\n");

  const result = assemble("test.asm", {
    readFile: makeReadFile({ "test.asm": source }),
  });

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0xc9, 0x3b, 0xc9, 0x2c]);
});

test("assemble handles .include with absolute and relative paths", () => {
  const mainSource = [
    ".org $8900",
    '    .include "sub.asm"',
    "tail .byte $FF",
  ].join("\n");

  const subSource = [
    "start .byte $11",
    "      .byte $22",
  ].join("\n");

  const result = assemble("test.asm", {
    sourcePath: "test.asm",
    readFile: makeReadFile({ "test.asm": mainSource, "sub.asm": subSource }),
  });

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0x11, 0x22, 0xff]);
  assert.equal(
    result.symbols.find((entry) => entry.name === "START")?.value,
    0x8900,
  );
  assert.equal(
    result.symbols.find((entry) => entry.name === "TAIL")?.value,
    0x8902,
  );
});