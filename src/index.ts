import { readFile, writeFile } from "node:fs/promises";
import { assemble } from "./assembler.js";
import { formatListing } from "./listing.js";

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("Usage: k65t <input.asm>");
  }

  const source = await readFile(inputPath, "utf8");
  const result = assemble(source);

  await writeFile("output.bin", result.binary);
  await writeFile("output.lst", `${formatListing(result.listing)}\n`);
  await writeFile("output.sym", `${result.symbols.map((entry) => `${entry.name} ${entry.value.toString(16).toUpperCase().padStart(4, "0")}`).join("\n")}\n`);
}

void main();