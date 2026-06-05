import { parseCliArgs, resolveOutputPaths } from "./cli.js";

import assert from "node:assert/strict";
import test from "node:test";

test("parseCliArgs uses default output naming when no flags are provided", () => {
  const parsed = parseCliArgs(["program.asm"]);

  assert.equal(parsed.inputPath, "program.asm");
  const outputs = resolveOutputPaths(parsed);
  assert.equal(outputs.binPath, "program.bin");
  assert.equal(outputs.lstPath, "program.lst");
  assert.equal(outputs.symPath, "program.sym");
});

test("parseCliArgs supports explicit output flags and shared output directory", () => {
  const parsed = parseCliArgs([
    "--out-dir",
    "build/out",
    "--bin",
    "custom.bin",
    "--lst",
    "custom.lst",
    "source/main.asm",
  ]);

  assert.equal(parsed.inputPath, "source/main.asm");
  const outputs = resolveOutputPaths(parsed);
  assert.equal(outputs.binPath, "build/out/custom.bin");
  assert.equal(outputs.lstPath, "build/out/custom.lst");
  assert.equal(outputs.symPath, "build/out/main.sym");
});

test("parseCliArgs rejects unknown flags", () => {
  assert.throws(
    () => parseCliArgs(["--bogus", "program.asm"]),
    /Unknown option: --bogus/,
  );
});

test("parseCliArgs rejects missing option values", () => {
  assert.throws(() => parseCliArgs(["--bin"]), /Missing value for --bin/);
});
