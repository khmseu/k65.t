import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { assemble } from "./assembler.js";
import { formatListing } from "./listing.js";

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("Usage: k65t <input.asm>");
  }

  const source = await readFile(inputPath, "utf8");
  const result = assemble(source);
  const outputDir = dirname(inputPath);
  const stem = basename(inputPath, extname(inputPath));
  const binPath = join(outputDir, `${stem}.bin`);
  const lstPath = join(outputDir, `${stem}.lst`);
  const symPath = join(outputDir, `${stem}.sym`);

  await writeFile(binPath, result.binary);
  await writeFile(lstPath, `${formatListing(result.listing)}\n`);
  await writeFile(
    symPath,
    `; ORIGIN ${result.startAddress.toString(16).toUpperCase().padStart(4, "0")}\n${result.symbols
      .map((entry) => `${entry.name} ${entry.value.toString(16).toUpperCase().padStart(4, "0")}`)
      .join("\n")}\n`,
  );
}

void main();