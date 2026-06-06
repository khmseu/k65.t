import * as fs from "fs";

import { URL } from "url";
import { parse } from "path";

/**
 * Converts MACRO-10 assembler format to k65.t format.
 * @param content The original MACRO-10 source code as a string.
 * @returns The converted k65.t source code.
 */
export function convertMacro10ToK65(content: string): string {
  const lines = content.split(/\r?\n/);
  const outLines: string[] = [];

  interface Block {
    type: "macro" | "if" | "repeat";
    args: string[];
    startDepth: number;
  }
  const blockStack: Block[] = [];
  let angleDepth = 0;
  let inBlockComment = false;

  for (let line of lines) {
    if (!line.trim() && !inBlockComment) {
      outLines.push("");
      continue;
    }

    // $Z:
    line = line.replace(/^\s*\$([A-Za-z0-9_]+):/, "_$1:");

    // 1. Handle block comments (COMMENT * ... *)
    if (!inBlockComment && line.includes("COMMENT *")) {
      inBlockComment = true;
      outLines.push(line.replace("COMMENT *", "*").trimEnd());
      const afterCommentStart = line.split("COMMENT *")[1];
      if (afterCommentStart && afterCommentStart.includes("*")) {
        inBlockComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      outLines.push("* " + line.trimEnd());
      if (line.includes("*")) {
        inBlockComment = false;
      }
      continue;
    }

    // 2. Convert Octal numbers: ^O123 -> 0o123
    line = line.replace(/\^O([0-7]+)/g, "0o$1");

    // 3. PC reference: . -> * (Only when '.' is a standalone token)
    line = line.replace(/(^|[^A-Za-z0-9_.])\.(?=[^A-Za-z0-9_.]|$)/g, "$1*");

    // 4. Cheap labels: % -> @
    line = line.replace(/%([A-Za-z0-9_]+)/g, "@$1");

    // 5. Extract labels to their own lines to make instruction parsing easier
    const labelMatch = line.match(/^(\s*)([@A-Za-z0-9_\$]+)::?(.*)/);
    if (
      labelMatch &&
      labelMatch[1] !== undefined &&
      labelMatch[2] !== undefined &&
      labelMatch[3] !== undefined
    ) {
      outLines.push(`${labelMatch[1]}${labelMatch[2]}:`);
      line = labelMatch[1] + labelMatch[3];
    }

    // 6. Assignments: == or =
    line = line.replace(/([@A-Za-z0-9_\$]+)\s*==\s*(.*)/, "$1 = $2");
    line = line.replace(/^(\s*)([@A-Za-z0-9_\$]+)\s*=\s*(.*)/, "$1$2 = $3");

    // 7. Instructions with Immediate addressing macros
    line = line.replace(/\bLDAI\s+(.*)/, "LDA #$1");
    line = line.replace(/\bLDXI\s+(.*)/, "LDX #$1");
    line = line.replace(/\bLDYI\s+(.*)/, "LDY #$1");
    line = line.replace(/\bADCI\s+(.*)/, "ADC #$1");
    line = line.replace(/\bSBCI\s+(.*)/, "SBC #$1");
    line = line.replace(/\bCMPI\s+(.*)/, "CMP #$1");
    line = line.replace(/\bCPXI\s+(.*)/, "CPX #$1");
    line = line.replace(/\bCPYI\s+(.*)/, "CPY #$1");
    line = line.replace(/\bANDI\s+(.*)/, "AND #$1");
    line = line.replace(/\bORAI\s+(.*)/, "ORA #$1");
    line = line.replace(/\bEORI\s+(.*)/, "EOR #$1");

    // 8. Accumulator addressing
    line = line.replace(/\bASL\s+A\b/, "ASL A");
    line = line.replace(/\bLSR\s+A\b/, "LSR A");
    line = line.replace(/\bROL\s+A\b/, "ROL A");
    line = line.replace(/\bROR\s+A\b/, "ROR A");

    // 9. Indirect Y addressing macros: LDADY foo -> LDA (foo),Y
    line = line.replace(/\bLDADY\s+(.*)/, "LDA ($1),Y");
    line = line.replace(/\bSTADY\s+(.*)/, "STA ($1),Y");
    line = line.replace(/\bCMPDY\s+(.*)/, "CMP ($1),Y");
    line = line.replace(/\bSBCDY\s+(.*)/, "SBC ($1),Y");

    // 10. Directives
    line = line.replace(/^\s*TITLE\s+(.*)/, '.title "$1"');
    line = line.replace(/^\s*SUBTTL\s+(.*)/, '.subttl "$1"');
    line = line.replace(/^\s*PAGE/, ".page");
    line = line.replace(/^\s*ORG\s+(.*)/, ".org $1");
    line = line.replace(/\bBLOCK\s+(.*)/, ".fill $1");
    line = line.replace(/^\s*EXP\s+(.*)/, ".word $1");
    line = line.replace(/^\s*SEARCH\s+(.*)/, '.include "$1.asm"');

    // 11. Strings (DC, DT, DCI)
    line = line.replace(/\bDC\s*"(.*?)"/g, '.textc "$1"');
    line = line.replace(/\bDT\s*"(.*?)"/g, '.text "$1"');

    // 12. Address words
    line = line.replace(/\bADR\((.*?)\)/g, ".word $1");

    // 13. Numbers without directive -> .byte
    if (/^\s*(0o[0-7]+|[0-9]+|\$[@A-Fa-f0-9]+)\s*(;.*)?$/.test(line)) {
      line = line.replace(
        /^(\s*)(0o[0-7]+|[0-9]+|\$[@A-Fa-f0-9]+)(\s*(;.*)?)$/,
        "$1.byte $2$3",
      );
    }

    // 14. Block Starters
    let match;
    if (
      (match = line.match(
        /^(\s*)DEFINE\s+([A-Za-z0-9_\$]+)(?:\s*\((.*?)\))?\s*,?\s*<(.*)/,
      )) &&
      match[1] !== undefined &&
      match[2] !== undefined &&
      match[4] !== undefined
    ) {
      const indent = match[1];
      const name = match[2];
      const argsStr = match[3] || "";
      const args = argsStr
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s);

      outLines.push(
        `${indent}.macro ${name}${args.length > 0 ? ", " + args.join(", ") : ""}`,
      );
      blockStack.push({ type: "macro", args, startDepth: angleDepth });
      angleDepth++;
      line = indent + match[4];
    } else if (
      (match = line.match(
        /^(\s*)DEFINE\s+([A-Za-z0-9_\$]+)(?:\s*\((.*?)\))?\s*,(.*)/,
      )) &&
      match[1] !== undefined &&
      match[2] !== undefined &&
      match[4] !== undefined
    ) {
      // DEFINE block without a '<' (usually a single line macro command)
      const indent = match[1];
      const name = match[2];
      const argsStr = match[3] || "";
      const args = argsStr
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s);

      outLines.push(
        `${indent}.macro ${name}${args.length > 0 ? ", " + args.join(", ") : ""}`,
      );
      let outRest = match[4];
      for (const arg of args) {
        outRest = outRest.replace(new RegExp(`\\b${arg}\\b`, "g"), `\\${arg}`);
      }
      // Pre-process PRINTX in outRest
      outRest = outRest.replace(
        /\bPRINTX\s*([^\sA-Za-z0-9])(.*?)\1/g,
        '.print "$2"',
      );
      outRest = outRest.replace(/^\s*PRINTX\s+([^\/">][^>]*)/, '.print "$1"');

      outLines.push(`${indent}    ${outRest.trim()}`);
      outLines.push(`${indent}.endmacro`);
      line = "";
    } else if (
      (match = line.match(/^(\s*)(IFE|IFN)\s+(.*?),?\s*<(.*)/)) &&
      match[1] !== undefined &&
      match[2] !== undefined &&
      match[3] !== undefined &&
      match[4] !== undefined
    ) {
      const indent = match[1];
      const condType = match[2];
      const cond = match[3];

      let outCond = "";
      const minusMatch = cond.match(
        /^([A-Za-z0-9_\$]+)\s*-\s*([A-Za-z0-9_\$]+)$/,
      );
      if (
        minusMatch &&
        minusMatch[1] !== undefined &&
        minusMatch[2] !== undefined
      ) {
        if (condType === "IFE")
          outCond = `${minusMatch[1]} == ${minusMatch[2]}`;
        else if (condType === "IFN")
          outCond = `${minusMatch[1]} != ${minusMatch[2]}`;
      } else {
        if (condType === "IFE") outCond = `(${cond}) == 0`;
        else if (condType === "IFN") outCond = `(${cond}) != 0`;
      }

      outLines.push(`${indent}.if ${outCond}`);
      blockStack.push({ type: "if", args: [], startDepth: angleDepth });
      angleDepth++;
      line = indent + match[4];
    } else if (
      (match = line.match(/^(\s*)(IF1|IF2)\s*,\s*<(.*)/)) &&
      match[1] !== undefined &&
      match[2] !== undefined &&
      match[3] !== undefined
    ) {
      // Handle IF1,< or IF2,< without an expression
      const indent = match[1];
      const condType = match[2];

      let outCond = "";
      if (condType === "IF1") outCond = `1`;
      else if (condType === "IF2") outCond = `1`;

      outLines.push(`${indent}.if ${outCond}`);
      blockStack.push({ type: "if", args: [], startDepth: angleDepth });
      angleDepth++;
      line = indent + match[3];
    } else if (
      (match = line.match(/^(\s*)REPEAT\s+(.*?),?\s*<(.*)/)) &&
      match[1] !== undefined &&
      match[2] !== undefined &&
      match[3] !== undefined
    ) {
      const indent = match[1];
      const count = match[2];

      outLines.push(`${indent}.repeat ${count}`);
      blockStack.push({ type: "repeat", args: [], startDepth: angleDepth });
      angleDepth++;
      line = indent + match[3];
    }

    // Process PRINTX on the remainder of the line
    line = line.replace(/\bPRINTX\s*([^\sA-Za-z0-9])(.*?)\1/g, '.print "$2"');
    line = line.replace(/^\s*PRINTX\s+([^\/">][^>]*)/, '.print "$1"');

    // 11. Strings (DC, DT, DCI)
    line = line.replace(/\bDC\s*\((.*)\)/g, ".textc $1");
    line = line.replace(/\bDT\s*\((.*)\)/g, ".text $1");

    line = line.replace(/^\s*ORG\s+(.*)/, ".org $1");

    // 13. Numbers without directive -> .byte
    if (/^\s*(0o[0-7]+|[0-9]+|\$[@A-Fa-f0-9]+)\s*([>;].*)?$/.test(line)) {
      line = line.replace(
        /^(\s*)(0o[0-7]+|[0-9]+|\$[@A-Fa-f0-9]+)(\s*([>;].*)?)$/,
        "$1.byte $2$3",
      );
    }

    if (!line.trim() && !line.includes(";")) continue;

    // 15. Character by character scan for <, >, and macro arguments
    let outLine = "";
    let i = 0;
    while (i < line.length) {
      const c = line[i];

      // Match identifiers for macro args
      const wordMatch = line.substring(i).match(/^[@A-Za-z0-9_\$]+/);
      if (wordMatch && wordMatch[0] !== undefined) {
        const word = wordMatch[0];
        let isArg = false;
        const lastBlock = blockStack[blockStack.length - 1];
        if (lastBlock && lastBlock.type === "macro") {
          if (lastBlock.args.includes(word)) {
            outLine += "\\" + word;
            isArg = true;
          }
        }
        if (!isArg) {
          outLine += word;
        }
        i += word.length;
        continue;
      }

      if (c === "<") {
        outLine += "(";
        angleDepth++;
        i++;
        continue;
      }

      if (c === ">") {
        angleDepth--;
        const lastBlock = blockStack[blockStack.length - 1];
        if (lastBlock && angleDepth === lastBlock.startDepth) {
          const block = blockStack.pop()!;
          const blockIndent = outLine.match(/^\s*/)?.[0] || "";
          if (outLine.trim()) {
            outLines.push(outLine);
          }
          outLine = blockIndent; // Preserve indentation for the line after the block (like comments)

          if (block.type === "macro") outLines.push(`${blockIndent}.endmacro`);
          else if (block.type === "if") outLines.push(`${blockIndent}.endif`);
          else if (block.type === "repeat")
            outLines.push(`${blockIndent}.endrepeat`);
        } else {
          outLine += ")";
        }
        i++;
        continue;
      }

      outLine += c;
      i++;
    }

    if (outLine.trim() || outLine.includes(";")) {
      // Ignored directives
      if (/^\s*(SALL|RADIX)/.test(outLine)) {
        outLines.push(";" + outLine.trimEnd());
      } else {
        outLines.push(outLine.trimEnd());
      }
    }
  }

  return outLines.join("\n");
}

// CLI Execution (ES Module compatible)
// @ts-ignore
const isMainModule =
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1] &&
  // @ts-ignore
  (import.meta.url === new URL(`file://${process.argv[1]}`).href ||
    // @ts-ignore
    parse(process.argv[1]).name ===
      parse(new URL(import.meta.url).pathname).name);

if (isMainModule) {
  const myPath = process.argv[1] || "convert.js";
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(`Usage: node ${myPath} <input.asm> <output.asm>`);
    process.exit(1);
  }

  const inputFile = args[0];
  const outputFile = args[1];

  if (!inputFile || !outputFile) {
    console.error("Invalid arguments.");
    // @ts-ignore
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(inputFile, "utf-8");
    const converted = convertMacro10ToK65(content);
    fs.writeFileSync(outputFile, converted + "\n", "utf-8");
    console.log(`Successfully converted '${inputFile}' to '${outputFile}'`);
  } catch (err) {
    console.error("Error processing files:", err);
    // @ts-ignore
    process.exit(1);
  }
}
