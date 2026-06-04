import { preprocessSource } from "./dist/preprocessor.js";

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

const result = preprocessSource(source);
console.log("Preprocessed output:");
console.log(result);
console.log("\n---Split by lines---");
result.split("\n").forEach((line, i) => {
  console.log(`${i}: ${line}`);
});
