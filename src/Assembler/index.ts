import { parseCliArgs, resolveOutputPaths } from "./cli.js";
import { readFile, writeFile } from "node:fs/promises";

import { assemble } from "./assembler.js";
import { error } from "node:console";
import { formatListing } from "./listing.js";

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const inputPath = cli.inputPath;

  const source = await readFile(inputPath, "utf8");
  const result = assemble(source, { sourcePath: inputPath });

  if (result.diagnostics.length > 0) {
    for (const diagnostic of result.diagnostics) {
      const lineNum = diagnostic.location.lineNumber;
      const text = diagnostic.location.text ?? "";
      const position =
        diagnostic.column === undefined
          ? `${lineNum}`
          : `${lineNum}:${diagnostic.column}`;
      console.error(
        `${inputPath}:${position}: ${diagnostic.code}: ${diagnostic.message}`,
      );
      console.error(`  ${text}`);
    }
    error(`Assembly failed with ${result.diagnostics.length} diagnostic(s)`);
  }

  const { binPath, lstPath, symPath } = resolveOutputPaths(cli);

  await writeFile(binPath, result.binary);
  await writeFile(
    lstPath,
    `${formatListing(result.listing, { bytesPerLine: result.bytesPerLine, pageSize: result.pageSize })}\n`,
  );
  await writeFile(
    symPath,
    `; ORIGIN ${result.startAddress.toString(16).toUpperCase().padStart(4, "0")}\n${result.symbols
      .map(
        (entry) =>
          `${entry.name} ${entry.value.toString(16).toUpperCase().padStart(4, "0")}`,
      )
      .join("\n")}\n`,
  );
}

void main();
