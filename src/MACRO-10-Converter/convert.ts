import * as fs from "fs";

/**
 * Converts MACRO-10 assembler format to k65.t format.
 * @param content The original MACRO-10 source code as a string.
 * @returns The converted k65.t source code.
 */
export function convertMacro10ToK65(content: string): string {
  const lines = content.split(/\r?\n/);
  const outLines: string[] = [];
  let inMacro = false;

  for (let line of lines) {
    const originalLine = line;

    // 1. Handle block comments (COMMENT * ... *)
    if (line.includes("COMMENT *")) {
      outLines.push(";" + line.trimEnd());
      continue;
    }

    // 2. Convert Octal numbers: ^O123 -> 0o123
    line = line.replace(/\^O([0-7]+)/g, "0o$1");

    // 3. Assignments: == or =
    line = line.replace(/([A-Za-z0-9_\$]+)\s*==\s*(.*)/, "$1 = $2");
    line = line.replace(/^([A-Za-z0-9_\$]+)\s*=\s*(.*)/, "$1 = $2");

    // 4. Labels: :: -> :
    line = line.replace(/^([A-Za-z0-9_\$]+)::/, "$1:");

    // 5. Instructions with Immediate addressing macros
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

    // 6. Accumulator addressing
    line = line.replace(/\bASL\s+A,?/, "ASL A");
    line = line.replace(/\bLSR\s+A,?/, "LSR A");
    line = line.replace(/\bROL\s+A,?/, "ROL A");
    line = line.replace(/\bROR\s+A,?/, "ROR A");

    // 7. Indirect Y addressing macros: LDADY foo -> LDA (foo),Y
    line = line.replace(/\bLDADY\s+(.*)/, "LDA ($1),Y");
    line = line.replace(/\bSTADY\s+(.*)/, "STA ($1),Y");
    line = line.replace(/\bCMPDY\s+(.*)/, "CMP ($1),Y");
    line = line.replace(/\bSBCDY\s+(.*)/, "SBC ($1),Y");

    // 8. Directives
    line = line.replace(/^\s*TITLE\s+(.*)/, '.title "$1"');
    line = line.replace(/^\s*SUBTTL\s+(.*)/, '.subttl "$1"');
    line = line.replace(/^\s*PAGE/, ".page");
    line = line.replace(/^\s*ORG\s+(.*)/, ".org $1");
    line = line.replace(/^\s*BLOCK\s+(.*)/, ".fill $1");
    line = line.replace(/^\s*EXP\s+(.*)/, ".word $1");

    // 9. Strings (DC, DT, DCI)
    line = line.replace(/\bDCI"(.*?)"/g, '.text "$1"');
    line = line.replace(/\bDC"(.*?)"/g, '.text "$1"');
    line = line.replace(/\bDT"(.*?)"/g, '.text "$1"');

    // 10. Address words
    line = line.replace(/\bADR\((.*?)\)/g, ".word $1");

    // 11. Macros (DEFINE)
    const matchMacroArgs = line.match(
      /^DEFINE\s+([A-Za-z0-9_\$]+)\s*\((.*?)\),<(.*)/,
    );
    if (matchMacroArgs && matchMacroArgs[1] && matchMacroArgs[2]) {
      const name = matchMacroArgs[1];
      const args = matchMacroArgs[2];
      let rest = matchMacroArgs[3];

      outLines.push(`.macro ${name}, ${args}`);
      if (rest && rest.trim()) {
        rest = rest.split(`<${args}>`).join(`\\${args}`);
        rest = rest.split(args).join(`\\${args}`);

        if (rest.endsWith(">")) {
          outLines.push("    " + rest.slice(0, -1));
          outLines.push(".endmacro");
        } else {
          outLines.push("    " + rest);
          inMacro = true;
        }
      } else {
        inMacro = true;
      }
      continue;
    }

    const matchMacroNoArgs = line.match(/^DEFINE\s+([A-Za-z0-9_\$]+),<(.*)/);
    if (matchMacroNoArgs && matchMacroNoArgs[1]) {
      const name = matchMacroNoArgs[1];
      const rest = matchMacroNoArgs[2];

      outLines.push(`.macro ${name}`);
      if (rest && rest.trim()) {
        if (rest.endsWith(">")) {
          outLines.push("    " + rest.slice(0, -1));
          outLines.push(".endmacro");
        } else {
          outLines.push("    " + rest);
          inMacro = true;
        }
      } else {
        inMacro = true;
      }
      continue;
    }

    if (inMacro) {
      if (line.trim() === ">") {
        outLines.push(".endmacro");
        inMacro = false;
        continue;
      } else if (line.trim().endsWith(">")) {
        line = line.slice(0, line.lastIndexOf(">"));
        outLines.push(line);
        outLines.push(".endmacro");
        inMacro = false;
        continue;
      }
    }

    // 12. Conditionals (IFE, IFN, IF1, IF2)
    const matchCond = line.match(/^(\s*)(IFE|IFN|IF1|IF2)\s+(.*?),<(.*)/);
    if (matchCond && matchCond[2] && matchCond[3]) {
      const indent = matchCond[1] || "";
      const condType = matchCond[2];
      const cond = matchCond[3];
      const rest = matchCond[4];

      if (condType === "IFE") outLines.push(`${indent}.if (${cond}) == 0`);
      else if (condType === "IFN") outLines.push(`${indent}.if (${cond}) != 0`);
      else if (condType === "IF1") outLines.push(`${indent}.if 1`);
      else if (condType === "IF2") outLines.push(`${indent}.if 0`);

      if (rest && rest.trim()) {
        if (rest.endsWith(">")) {
          outLines.push(`${indent}    ${rest.slice(0, -1)}`);
          outLines.push(`${indent}.endif`);
        } else {
          outLines.push(`${indent}    ${rest}`);
        }
      }
      continue;
    }

    // 13. REPEAT
    const matchRepeat = line.match(/^(\s*)REPEAT\s+(.*?),<(.*)/);
    if (matchRepeat && matchRepeat[2]) {
      const indent = matchRepeat[1] || "";
      const count = matchRepeat[2];
      const rest = matchRepeat[3];

      outLines.push(`${indent}.repeat ${count}`);
      if (rest && rest.trim()) {
        if (rest.endsWith(">")) {
          outLines.push(`${indent}    ${rest.slice(0, -1)}`);
          outLines.push(`${indent}.endrepeat`);
        } else {
          outLines.push(`${indent}    ${rest}`);
        }
      }
      continue;
    }

    // 14. Closing blocks (>)
    let trailingGt = 0;
    let stripped = line.trimEnd();
    while (stripped.endsWith(">")) {
      trailingGt++;
      stripped = stripped.slice(0, -1);
    }

    // Only close if it's not part of an inline expression (like <<WD>&0o377>)
    if (trailingGt > 0 && (stripped.match(/</g) || []).length === 0) {
      line = stripped;
    } else {
      trailingGt = 0;
    }

    // 15. Ignored directives
    if (/^\s*(SEARCH|SALL|RADIX)/.test(line)) {
      outLines.push(";" + line.trimEnd());
      continue;
    }

    if (line.trim() || !originalLine.trim()) {
      outLines.push(line.trimEnd());
    }

    // Append block closures if any
    for (let i = 0; i < trailingGt; i++) {
      outLines.push(".endif ; or .endrepeat");
    }
  }

  return outLines.join("\n");
}

// CLI Execution
if (require.main === module) {
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
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(inputFile, "utf-8");
    const converted = convertMacro10ToK65(content);
    fs.writeFileSync(outputFile, converted + "\n", "utf-8");
    console.log(`Successfully converted '${inputFile}' to '${outputFile}'`);
  } catch (err) {
    console.error("Error processing files:", err);
    process.exit(1);
  }
}
