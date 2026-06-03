import { parseSource } from "./parser.js";

const MAX_EXPANSION_DEPTH = 25;

interface MacroDefinition {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly body: readonly string[];
}

export function preprocessSource(text: string): string {
  const lines = text.split(/\r?\n/);
  const macros = new Map<string, MacroDefinition>();
  const output: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const parsed = parseSource(line)[0]!;
    const mnemonic = parsed.mnemonic?.toUpperCase();

    if (parsed.kind === "code" && mnemonic === ".MACRO") {
      const name = parsed.operands[0]?.trim();
      if (!name) {
        throw new Error(`Missing macro name on line ${parsed.lineNumber}`);
      }

      const body: string[] = [];
      let foundEnd = false;

      for (i += 1; i < lines.length; i += 1) {
        const bodyLine = lines[i]!;
        const bodyParsed = parseSource(bodyLine)[0]!;
        if (bodyParsed.kind === "code" && bodyParsed.mnemonic?.toUpperCase() === ".ENDMACRO") {
          foundEnd = true;
          break;
        }
        body.push(bodyLine);
      }

      if (!foundEnd) {
        throw new Error(`Unterminated macro ${name}`);
      }

      macros.set(name.toUpperCase(), {
        name,
        parameters: parsed.operands.slice(1),
        body,
      });
      continue;
    }

    output.push(...expandLine(line, macros, 0));
  }

  return output.join("\n");
}

function expandLine(line: string, macros: ReadonlyMap<string, MacroDefinition>, depth: number): string[] {
  if (depth > MAX_EXPANSION_DEPTH) {
    throw new Error("Macro expansion depth exceeded");
  }

  const parsed = parseSource(line)[0]!;
  if (parsed.kind !== "code" || parsed.mnemonic === undefined) {
    return [line];
  }

  const macro = macros.get(parsed.mnemonic.toUpperCase());
  if (macro === undefined) {
    return [line];
  }

  const replacements = buildReplacementMap(macro.parameters, parsed.operands);
  const expandedLines = macro.body.map((bodyLine) => substituteParameters(bodyLine, replacements));

  if (parsed.label !== undefined && expandedLines.length > 0) {
    expandedLines[0] = attachLabel(parsed.label, expandedLines[0]!);
  }

  return expandedLines.flatMap((expandedLine) => expandLine(expandedLine, macros, depth + 1));
}

function buildReplacementMap(parameters: readonly string[], values: readonly string[]): Map<string, string> {
  const replacements = new Map<string, string>();

  parameters.forEach((parameter, index) => {
    replacements.set(parameter, values[index] ?? "");
    replacements.set(String(index + 1), values[index] ?? "");
  });

  return replacements;
}

function substituteParameters(line: string, replacements: ReadonlyMap<string, string>): string {
  let expanded = line;

  for (const [name, value] of replacements.entries()) {
    expanded = expanded.replaceAll(`\\${name}`, value);
  }

  return expanded;
}

function attachLabel(label: string, line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.length === 0) {
    return `${label}`;
  }

  if (trimmed.startsWith(";") || trimmed.startsWith("*")) {
    return `${label} ${trimmed}`;
  }

  return `${label} ${trimmed}`;
}