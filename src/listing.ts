import type { ListingLine } from "./types.js";

interface ListingFormatOptions {
  bytesPerLine?: number;
  pageSize?: number;
}

export function formatListingLine(line: ListingLine, options: ListingFormatOptions = {}): string[] {
  const bytesPerLine = options.bytesPerLine ?? 16;
  
  // Format the main listing line with bytes split across multiple lines if needed
  const address = line.address === null ? "    " : line.address.toString(16).toUpperCase().padStart(4, "0");
  const sourceText = line.source;
  
  const lines: string[] = [];
  
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
  const pageSize = options.pageSize ?? 0;
  const bytesPerLine = options.bytesPerLine ?? 16;
  const formattedLines: string[] = [];
  
  let currentPageLineCount = 0;
  let pageNumber = 1;
  let currentTitle: string | undefined;
  let currentSubtitle: string | undefined;
  let pageHeaderNeeded = true;
  
  for (const line of lines) {
    // Check if we need to start a new page
    const forcePageBreak = line.pageBreak ?? false;
    
    // Insert page break if needed
    if (forcePageBreak && currentPageLineCount > 0) {
      // Force a page break
      formattedLines.push(""); // Blank line to show page separation
      currentPageLineCount += 1;
      pageHeaderNeeded = true;
      pageNumber += 1;
    }
    
    // Check if we need automatic page break due to page size
    if (pageSize > 0 && currentPageLineCount >= pageSize) {
      formattedLines.push(""); // Blank line for page separation
      currentPageLineCount = 1;
      pageHeaderNeeded = true;
      pageNumber += 1;
    }
    
    // Insert page header if needed
    if (pageHeaderNeeded && pageSize > 0) {
      if (currentTitle !== undefined) {
        formattedLines.push(currentTitle);
        currentPageLineCount += 1;
      }
      if (currentSubtitle !== undefined) {
        formattedLines.push(currentSubtitle);
        currentPageLineCount += 1;
      }
      pageHeaderNeeded = false;
    }
    
    // Update title/subtitle if present on this line
    if (line.title !== undefined) {
      currentTitle = line.title;
    }
    if (line.subtitle !== undefined) {
      currentSubtitle = line.subtitle;
    }
    
    // Format the actual line
    const formatted = formatListingLine(line, { bytesPerLine });
    formattedLines.push(...formatted);
    currentPageLineCount += formatted.length;
  }
  
  return formattedLines.join("\n");
}