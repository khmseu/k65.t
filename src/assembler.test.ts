import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble } from "./assembler.js";
import { formatListing } from "./listing.js";

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

  const result = assemble(source);

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
  assert.ok(/8000\s+A9\s+01\s+start:\s+LDA/.test(listingText));
  assert.ok(/8005\s+E8\s+loop\s+INX/.test(listingText));
  assert.ok(/8006\s+D0\s+FD\s+BNE\s+loop/.test(listingText));
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

  const result = assemble(source);

  assert.equal(result.startAddress, 0x9000);
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0xa9, 0x01, 0xa2, 0x02]);
  assert.equal(
    result.symbols.find((entry) => entry.name === "START")?.value,
    0x9000,
  );
  assert.ok(
    /9000\s+A9\s+01\s+start\s+lda\s+#1/.test(formatListing(result.listing))
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

  const result = assemble(source);

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

  const result = assemble(source);

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0x41, 0x42, 0x0a, 0xa9, 0x43]);
  assert.equal(
    result.symbols.find((entry) => entry.name === "START")?.value,
    0x8810,
  );
});

test("assemble reports multi-character string literals in expressions", () => {
  const source = [".org $8820", "      .byte 'AB'"].join("\n");

  const result = assemble(source);

  assert.equal(result.binary.length, 0);
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

  const result = assemble(source);

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

  const result = assemble(source);

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

  const result = assemble(source);

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
    '      cmp #(","&%01111111)',
  ].join("\n");

  const result = assemble(source);

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0xc9, 0x3c, 0xc9, 0x2c]);
});

test("assemble resolves cheap labels within the nearest non-cheap label scope", () => {
  const source = [
    ".org $8C00",
    "start lda #1",
    "@loop inx",
    "      bne @loop",
    "next lda #2",
    "@loop dex",
    "      bne @loop",
  ].join("\n");

  const result = assemble(source);

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(
    Array.from(result.binary),
    [0xa9, 0x01, 0xe8, 0xd0, 0xfd, 0xa9, 0x02, 0xca, 0xd0, 0xfd],
  );

  const symbolMap = new Map(
    result.symbols.map((entry) => [entry.name, entry.value]),
  );
  assert.equal(symbolMap.get("START"), 0x8c00);
  assert.equal(symbolMap.get("NEXT"), 0x8c05);
  assert.equal(symbolMap.get("START.@LOOP"), 0x8c02);
  assert.equal(symbolMap.get("NEXT.@LOOP"), 0x8c07);
});

test("assemble supports reassignable labels with .set and =", () => {
  const source = [
    ".org $8D00",
    "count .set 1",
    "start lda #count",
    "count = count + 1",
    "      ldx #count",
    "count .set count + 1",
    "      ldy #count",
  ].join("\n");

  const result = assemble(source);

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(
    Array.from(result.binary),
    [0xa9, 0x01, 0xa2, 0x02, 0xa0, 0x03],
  );

  const symbolMap = new Map(
    result.symbols.map((entry) => [entry.name, entry.value]),
  );
  assert.equal(symbolMap.get("COUNT"), 3);
  assert.equal(symbolMap.get("START"), 0x8d00);
});

test("assemble reports diagnostics for unresolved symbols and unknown mnemonics", () => {
  const source = [
    ".org $8100",
    "start lda #missing_symbol",
    "      foo $20",
  ].join("\n");

  const result = assemble(source);

  assert.equal(result.binary.length, 0);
  assert.equal(result.diagnostics.length, 2);
  assert.ok(
    result.diagnostics.some((entry) => entry.code === "E_EXPR_UNKNOWN_SYMBOL"),
  );
  assert.ok(
    result.diagnostics.some((entry) => entry.code === "E_OPCODE_UNKNOWN"),
  );
  assert.ok(
    result.diagnostics.some((entry) =>
      entry.message.includes("unknown symbol 'missing_symbol'"),
    ),
  );
});

test("assemble reports divide-by-zero in expression diagnostics", () => {
  const source = [".org $8200", "start lda #(10 / (3 - 3))"].join("\n");

  const result = assemble(source);

  assert.equal(result.binary.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "E_EXPR_DIV_BY_ZERO");
  assert.equal(result.diagnostics[0]?.column, 5);
  assert.ok(result.diagnostics[0]?.message.includes("division by zero"));
});

test("assemble supports .text and .fill directives", () => {
  const source = [
    ".org $8300",
    "start .text \"HI\", 0, '\\n'",
    "      .fill 3, $2A",
  ].join("\n");

  const result = assemble(source);

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(
    Array.from(result.binary),
    [0x48, 0x49, 0x00, 0x0a, 0x2a, 0x2a, 0x2a],
  );
  assert.equal(
    result.symbols.find((entry) => entry.name === "START")?.value,
    0x8300,
  );
});

test("assemble reports invalid .text literals", () => {
  const source = [".org $8400", 'start .text "unterminated'].join("\n");

  const result = assemble(source);

  assert.equal(result.binary.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "E_DIR_TEXT_LITERAL");
  assert.ok(result.diagnostics[0]?.message.includes("Invalid string literal"));
});

test("assemble resolves .include files relative to source path", async () => {
  const root = await mkdtemp(join(tmpdir(), "k65t-include-"));
  const mainPath = join(root, "main.asm");
  const partPath = join(root, "part.asm");

  await writeFile(
    mainPath,
    [".org $8500", '.include "part.asm"'].join("\n"),
    "utf8",
  );
  await writeFile(
    partPath,
    ["start lda #$11", "      .byte $22"].join("\n"),
    "utf8",
  );

  const mainSource = '.org $8500\n.include "part.asm"';
  const result = assemble(mainSource, { sourcePath: mainPath });

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0xa9, 0x11, 0x22]);
  assert.equal(
    result.symbols.find((entry) => entry.name === "START")?.value,
    0x8500,
  );
});

test("assemble reports include read failures as diagnostics", () => {
  const source = [".org $8600", '.include "missing-file.asm"'].join("\n");

  const result = assemble(source, { sourcePath: "/tmp/k65t/main.asm" });

  assert.equal(result.binary.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "E_INCLUDE_READ");
});

test("assemble supports .align with optional fill value", () => {
  const source = [
    ".org $8701",
    "start .byte $AA",
    "      .align 4, $FF",
    "      .byte $55",
  ].join("\n");

  const result = assemble(source);

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0xaa, 0xff, 0xff, 0x55]);
  assert.equal(
    result.symbols.find((entry) => entry.name === "START")?.value,
    0x8701,
  );
});

test("assemble reports invalid .align boundary", () => {
  const source = [".org $8800", "      .align 0"].join("\n");

  const result = assemble(source);

  assert.equal(result.binary.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "E_DIR_ALIGN_RANGE");
});

test("assemble expands .repeat blocks before assembly", () => {
  const source = [
    ".org $8900",
    ".repeat 3",
    "  .byte $7F",
    ".endrepeat",
    "tail .byte $55",
  ].join("\n");

  const result = assemble(source);

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0x7f, 0x7f, 0x7f, 0x55]);
  assert.equal(
    result.symbols.find((entry) => entry.name === "TAIL")?.value,
    0x8903,
  );
});

test("assemble reports unterminated .repeat blocks", () => {
  const source = [".org $8A00", ".repeat 2", "  .byte 1"].join("\n");

  const result = assemble(source);

  assert.equal(result.binary.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "E_REPEAT_UNTERMINATED");
});

test("assemble reports unexpected .endrepeat", () => {
  const result = assemble(".endrepeat");

  assert.equal(result.binary.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "E_REPEAT_UNEXPECTED_END");
});

test("assemble expands conditional assembly blocks", () => {
  const source = [
    ".org $8B00",
    ".if 0",
    "  .byte $00",
    ".elseif 1",
    "  .byte $11",
    ".else",
    "  .byte $22",
    ".endif",
    "tail .byte $33",
  ].join("\n");

  const result = assemble(source);

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(Array.from(result.binary), [0x11, 0x33]);
  assert.equal(
    result.symbols.find((entry) => entry.name === "TAIL")?.value,
    0x8b01,
  );
});

test("assemble reports unterminated conditional assembly blocks", () => {
  const result = assemble([".if 1", "  .byte 1"].join("\n"));

  assert.equal(result.binary.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "E_IF_UNTERMINATED");
});

test("assemble reports unexpected .endif", () => {
  const result = assemble(".endif");

  assert.equal(result.binary.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "E_IF_UNEXPECTED_END");
});

test("listing metadata directives produce visible effects in output", async () => {
  const root = await mkdtemp(join(tmpdir(), "k65t-listing-"));
  const sourcePath = join(root, "test.asm");
  const listingPath = join(root, "test.lst");

  const source = [
    '.title "Test Program"',
    '.subttl "Version 1.0"',
    ".pagesize 5",
    ".bytesperline 8",
    ".org $8000",
    "lda #$01",
    "lda #$02",
    "lda #$03",
    ".page",
    '.title "Second Page"',
    "lda #$04",
    "lda #$05",
  ].join("\n");

  // Write source file to disk
  await writeFile(sourcePath, source, "utf8");

  // Assemble the file
  const result = assemble(source, { sourcePath });
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.pageSize, 5);
  assert.equal(result.bytesPerLine, 8);

  // Format and write listing to disk
  const listingText = formatListing(result.listing, {
    pageSize: result.pageSize,
    bytesPerLine: result.bytesPerLine,
  });
  await writeFile(listingPath, listingText, "utf8");

  // Read the listing file from disk
  const diskListing = await readFile(listingPath, "utf8");

  // Verify title and subtitle appear on first page
  assert.ok(
    diskListing.includes("Test Program"),
    "First page should have title",
  );
  assert.ok(
    diskListing.includes("Version 1.0"),
    "First page should have subtitle",
  );

  // Verify page break (form feed character) appears between pages
  assert.ok(
    diskListing.includes("\f"),
    "Listing should have form feed characters for page breaks",
  );

  // Verify second page title appears
  assert.ok(
    diskListing.includes("Second Page"),
    "Second page should have new title",
  );

  // Verify metadata directives themselves do NOT appear as listing lines
  assert.equal(
    !diskListing.match(/^[0-9A-F]{4}\s+\.title/m),
    true,
    ".title directive should not appear in listing",
  );
  assert.equal(
    !diskListing.match(/^[0-9A-F]{4}\s+\.subttl/m),
    true,
    ".subttl directive should not appear in listing",
  );
  assert.equal(
    !diskListing.match(/^[0-9A-F]{4}\s+\.pagesize/m),
    true,
    ".pagesize directive should not appear in listing",
  );
  assert.equal(
    !diskListing.match(/^[0-9A-F]{4}\s+\.bytesperline/m),
    true,
    ".bytesperline directive should not appear in listing",
  );
  assert.equal(
    !diskListing.match(/^[0-9A-F]{4}\s+\.page/m),
    true,
    ".page directive should not appear in listing",
  );

  // Verify actual code appears
  assert.ok(diskListing.includes("lda #$01"), "Code should appear in listing");
  assert.ok(
    diskListing.includes("lda #$04"),
    "Code after page break should appear in listing",
  );
});
