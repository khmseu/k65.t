import test from "node:test";
import assert from "node:assert/strict";
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
  assert.deepEqual(Array.from(result.binary), [0xa9, 0x01, 0x8d, 0x00, 0x02, 0xe8, 0xd0, 0xfd, 0xaa, 0x02, 0x00, 0x80]);

  const symbolMap = new Map(result.symbols.map((entry) => [entry.name, entry.value]));
  assert.equal(symbolMap.get("LOOP"), 0x8005);
  assert.equal(symbolMap.get("START"), 0x8000);
  assert.equal(symbolMap.get("TAIL"), 0x8008);

  const listingText = formatListing(result.listing);
  assert.ok(listingText.includes("8000 A9 01 start: LDA #$01"));
  assert.ok(listingText.includes("8005 E8 loop   INX"));
  assert.ok(listingText.includes("8006 D0 FD        BNE loop"));
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
  assert.equal(result.symbols.find((entry) => entry.name === "START")?.value, 0x9000);
  assert.ok(formatListing(result.listing).includes("9000 A9 01 start lda #1"));
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
  assert.deepEqual(Array.from(result.binary), [0xa9, 0x45, 0x85, 0x21, 0x46, 0x88]);
  assert.equal(result.symbols.find((entry) => entry.name === "BASE")?.value, 0x20);
  assert.equal(result.symbols.find((entry) => entry.name === "OFFSET")?.value, 0x46);
  assert.equal(result.symbols.find((entry) => entry.name === "START")?.value, 0x8800);
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
  assert.ok(result.diagnostics.some((entry) => entry.code === "E_EXPR_UNKNOWN_SYMBOL"));
  assert.ok(result.diagnostics.some((entry) => entry.code === "E_OPCODE_UNKNOWN"));
  assert.ok(result.diagnostics.some((entry) => entry.message.includes("unknown symbol 'missing_symbol'")));
});

test("assemble reports divide-by-zero in expression diagnostics", () => {
  const source = [
    ".org $8200",
    "start lda #(10 / (3 - 3))",
  ].join("\n");

  const result = assemble(source);

  assert.equal(result.binary.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "E_EXPR_DIV_BY_ZERO");
  assert.equal(result.diagnostics[0]?.column, 5);
  assert.ok(result.diagnostics[0]?.message.includes("division by zero"));
});