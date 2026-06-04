import { assemble } from "./dist/assembler.js";

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
console.log("Diagnostics:", result.diagnostics);
console.log("Binary:", Array.from(result.binary));
console.log("Symbols:", result.symbols);
