import type { ListingLine } from "./types.js";

interface ListingFormatOptions {
  bytesPerLine?: number;
  pageSize?: number;
}

export function formatListingLine(line: ListingLine, options: ListingFormatOptions = {}): string[] {
  const bytesPerLine = options.bytesPerLine ?? 16;
  
  // Handle title
  const lines: string[] = [];
  if (line.title !== undefined) {
    lines.push(line.title);
  }
  
  // Handle subtitle
  if (line.subtitle !== undefined) {
    lines.push(line.subtitle);
  }
  
  // Handle page break
  if (line.pageBreak) {
    lines.push(""); // Empty line for page break
  }
  
  // Format the main listing line with bytes split across multiple lines if needed
  const address = line.address === null ? "    " : line.address.toString(16).toUpperCase().padStart(4, "0");
  const sourceText = line.source;
  
  if (line.bytes.length === 0) {
    // No bytes, just address and source
    lines.push([address, sourceText].join(" ").trimEnd());
  } else if (line.bytes.length <= bytesPerLine) {
    // All bytes fit on one line
    const byteField = line.bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
    lines.push([address, byteField, sourceText].join(" ").trimEnd());
  } else {
    // Multiple lines needed
    for (let i = 0; i < line.bytes.length; i += bytesPerLine) {
      const chunk = line.bytes.slice(i, i + bytesPerLine);
      const byteField = chunk.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
      
      if (i === 0) {
        // First line has address and source
        lines.push([address, byteField, sourceText].join(" ").trimEnd());
      } else {
        // Continuation lines have indented bytes only
        const nextAddr = ((line.address ?? 0) + i) & 0xffff;
        const nextAddrStr = nextAddr.toString(16).toUpperCase().padStart(4, "0");
        lines.push([nextAddrStr, byteField].join(" ").trimEnd());
      }
    }
  }
  
  return lines;
}

export function formatListing(lines: readonly ListingLine[], options: ListingFormatOptions = {}): string {
  const formattedLines: string[] = [];
  
  for (const line of lines) {
    const formatted = formatListingLine(line, options);
    formattedLines.push(...formatted);
  }
  
  return formattedLines.join("\n");
}