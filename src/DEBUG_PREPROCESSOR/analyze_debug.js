import path from "path";
import { readFileSync } from "fs";

const logFile = process.argv[2];
if (!logFile) {
  console.error("Usage: node analyze_debug.js <debug.log>");
  process.exit(1);
}

const log = readFileSync(logFile, "utf8").split("\n");

// Parse log entries
const entries = [];
log.forEach((line, idx) => {
  if (!line.includes("[PREPROC]")) return;

  const content = line.substring(line.indexOf("[PREPROC]") + 9).trim();
  entries.push({ logLine: idx + 1, content, rawLine: line });
});

// Extract events
const ifEvents = [];
const endifEvents = [];
const emitEvents = [];
const skipEvents = [];
const processEvents = [];

entries.forEach((entry) => {
  if (entry.content.includes("PUSH .if")) {
    const match = entry.content.match(/line=(\d+)/);
    const lineNum = match ? parseInt(match[1]) : null;
    ifEvents.push({ logLine: entry.logLine, sourceLineNum: lineNum, entry });
  }
  if (entry.content.includes("POP .endif")) {
    const match = entry.content.match(/line=(\d+)/);
    const lineNum = match ? parseInt(match[1]) : null;
    endifEvents.push({ logLine: entry.logLine, sourceLineNum: lineNum, entry });
  }
  if (entry.content.includes("EMIT line=")) {
    const match = entry.content.match(/line=(\d+)/);
    const lineNum = match ? parseInt(match[1]) : null;
    emitEvents.push({ logLine: entry.logLine, sourceLineNum: lineNum, entry });
  }
  if (entry.content.includes("SKIP line=")) {
    const match = entry.content.match(/line=(\d+)/);
    const lineNum = match ? parseInt(match[1]) : null;
    skipEvents.push({ logLine: entry.logLine, sourceLineNum: lineNum, entry });
  }
  if (entry.content.includes("PROCESS line=")) {
    const match = entry.content.match(/line=(\d+)/);
    const lineNum = match ? parseInt(match[1]) : null;
    processEvents.push({
      logLine: entry.logLine,
      sourceLineNum: lineNum,
      entry,
    });
  }
});

// Check for .endif that are EMIT'd (should be POP'd)
const emittedEndifs = emitEvents.filter((e) =>
  entries[e.logLine - 1]?.content.includes(".endif"),
);

// Simulate stack to find mismatches
const stack = [];
const problems = [];

ifEvents.forEach((ifEvent) => {
  stack.push(ifEvent);
});

endifEvents.forEach((endifEvent) => {
  if (stack.length === 0) {
    problems.push({
      type: "UNDERFLOW",
      sourceLineNum: endifEvent.sourceLineNum,
      logLine: endifEvent.logLine,
      message: ".endif without matching .if",
      stackDepth: 0,
    });
  } else {
    const matchingIf = stack.pop();
    // Check if this .endif was EMIT'd
    const wasEmitted = emittedEndifs.some(
      (e) => e.sourceLineNum === endifEvent.sourceLineNum,
    );
    if (wasEmitted) {
      problems.push({
        type: "EMITTED",
        sourceLineNum: endifEvent.sourceLineNum,
        logLine: endifEvent.logLine,
        matchingIfLine: matchingIf.sourceLineNum,
        message: ".endif was EMIT'd instead of being consumed",
        stackDepth: stack.length + 1,
      });
    }
  }
});

// Unmatched .if
stack.forEach((unmatched) => {
  problems.push({
    type: "UNMATCHED_IF",
    sourceLineNum: unmatched.sourceLineNum,
    logLine: unmatched.logLine,
    message: ".if was never closed by .endif",
  });
});

// Print summary
console.log("=".repeat(70));
console.log("DEBUG_PREPROCESSOR LOG ANALYSIS");
console.log("=".repeat(70));
console.log();

console.log("SUMMARY:");
console.log(`  Total .if directives:     ${ifEvents.length}`);
console.log(`  Total .endif directives:  ${endifEvents.length}`);
console.log(
  `  Properly matched pairs:   ${endifEvents.length - problems.filter((p) => p.type === "UNDERFLOW").length}`,
);
console.log(`  .endif EMIT'd (wrong!):   ${emittedEndifs.length}`);
console.log(
  `  Stack underflows:         ${problems.filter((p) => p.type === "UNDERFLOW").length}`,
);
console.log(
  `  Unmatched .if:            ${problems.filter((p) => p.type === "UNMATCHED_IF").length}`,
);
console.log();

if (problems.length === 0) {
  console.log("✓ No problems detected!");
} else {
  console.log("PROBLEMS DETECTED:");
  console.log();

  problems.forEach((problem, idx) => {
    console.log(
      `${idx + 1}. ${problem.type} at source line ${problem.sourceLineNum} (log line ${problem.logLine})`,
    );
    console.log(`   ${problem.message}`);
    if (problem.matchingIfLine) {
      console.log(`   Matching .if at line ${problem.matchingIfLine}`);
    }
    console.log();
  });
}

// Show context for first few problems
if (problems.length > 0) {
  console.log("=".repeat(70));
  console.log("DETAILED CONTEXT FOR FIRST 3 PROBLEMS:");
  console.log("=".repeat(70));
  console.log();

  problems.slice(0, 3).forEach((problem, idx) => {
    console.log(`PROBLEM ${idx + 1}: Line ${problem.sourceLineNum}`);
    console.log("-".repeat(70));

    // Find entries around this problem
    const problemLogLine = problem.logLine;
    const start = Math.max(0, problemLogLine - 10);
    const end = Math.min(entries.length, problemLogLine + 5);

    for (let i = start; i < end; i++) {
      const marker = i === problemLogLine - 1 ? ">>> " : "    ";
      console.log(`${marker}${entries[i].content}`);
    }
    console.log();
  });
}
