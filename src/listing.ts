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
  let hasContentOnCurrentPage = false; // Track if we've output any content yet
  let currentTitle: string | undefined;
  let currentSubtitle: string | undefined;
  
  for (const line of lines) {
    // Update title/subtitle if present on this line
    if (line.title !== undefined) {
      currentTitle = line.title;
      // New title clears old subtitle unless new subtitle is also provided
      currentSubtitle = undefined;
    }
    if (line.subtitle !== undefined) {
      currentSubtitle = line.subtitle;
    }
    
    // Only apply paging logic to lines with content (address !== null)
    const isContentLine = line.address !== null;
    
    if (isContentLine) {
      // Check if this line forces a page break
      const forcePageBreak = line.pageBreak ?? false;
      
      if (forcePageBreak && currentPageLineCount > 0) {
        // Force a page break - insert blank line separator
        formattedLines.push("");
        currentPageLineCount = 0;
        hasContentOnCurrentPage = false;
        pageNumber += 1;
      }
      
      // Check if we need automatic page break due to page size
      if (pageSize > 0 && currentPageLineCount >= pageSize) {
        formattedLines.push(""); // Blank line for page separation
        currentPageLineCount = 0;
        hasContentOnCurrentPage = false;
        pageNumber += 1;
      }
      
      // Insert page headers on first content or after page break (regardless of pageSize)
      if (!hasContentOnCurrentPage && (currentTitle !== undefined || currentSubtitle !== undefined)) {
        if (currentTitle !== undefined) {
          formattedLines.push(currentTitle);
        }
        if (currentSubtitle !== undefined) {
          formattedLines.push(currentSubtitle);
        }
        hasContentOnCurrentPage = true;
      }
    }
    
    // Format and output the line
    const formatted = formatListingLine(line, { bytesPerLine });
    formattedLines.push(...formatted);
    
    // Only count content lines toward page size
    if (isContentLine) {
      currentPageLineCount += formatted.length;
    }
  }
  
  return formattedLines.join("\n");
}