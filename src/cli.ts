import { basename, dirname, extname, isAbsolute, join } from "node:path";

export interface CliOptions {
  readonly inputPath: string;
  readonly outDir?: string;
  readonly binName?: string;
  readonly lstName?: string;
  readonly symName?: string;
}

export interface OutputPaths {
  readonly binPath: string;
  readonly lstPath: string;
  readonly symPath: string;
}

export function parseCliArgs(args: readonly string[]): CliOptions {
  let inputPath: string | undefined;
  let outDir: string | undefined;
  let binName: string | undefined;
  let lstName: string | undefined;
  let symName: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      if (inputPath !== undefined) {
        throw new Error(`Unexpected extra input path: ${arg}`);
      }
      inputPath = arg;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${arg}`);
    }

    switch (arg) {
      case "--out-dir":
        outDir = value;
        index += 1;
        break;
      case "--bin":
        binName = value;
        index += 1;
        break;
      case "--lst":
        lstName = value;
        index += 1;
        break;
      case "--sym":
        symName = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (inputPath === undefined) {
    throw new Error(
      "Usage: k65t [--out-dir DIR] [--bin FILE] [--lst FILE] [--sym FILE] <input.asm>",
    );
  }

  return {
    inputPath,
    ...(outDir !== undefined ? { outDir } : {}),
    ...(binName !== undefined ? { binName } : {}),
    ...(lstName !== undefined ? { lstName } : {}),
    ...(symName !== undefined ? { symName } : {}),
  };
}

export function resolveOutputPaths(options: CliOptions): OutputPaths {
  const inputDir = dirname(options.inputPath);
  const stem = basename(options.inputPath, extname(options.inputPath));
  const baseDir = options.outDir ?? inputDir;

  return {
    binPath: resolveOutputPath(baseDir, options.binName ?? `${stem}.bin`),
    lstPath: resolveOutputPath(baseDir, options.lstName ?? `${stem}.lst`),
    symPath: resolveOutputPath(baseDir, options.symName ?? `${stem}.sym`),
  };
}

function resolveOutputPath(baseDir: string, fileName: string): string {
  return isAbsolute(fileName) ? fileName : join(baseDir, fileName);
}
