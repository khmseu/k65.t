import type { ListingLine } from "./types.js";

interface ListingFormatOptions {
  bytesPerLine?: number;
  pageSize?: number;
}

export function formatListingLine(
  line: ListingLine,
  options: ListingFormatOptions = {},
): string[] {
  const bytesPerLine = options.bytesPerLine ?? 16;

  // Format the main listing line with bytes split across multiple lines if needed
  const address =
    line.address === null
      ? "    "
      : line.address.toString(16).toUpperCase().padStart(4, "0");
  const sourceText = line.source;

  const lines: string[] = [];

  if (line.bytes.length === 0) {
    // No bytes, just address and source
    lines.push([address, sourceText].join(" ").trimEnd());
  } else if (line.bytes.length <= bytesPerLine) {
    // All bytes fit on one line
    const byteField = line.bytes
      .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");
    lines.push([address, byteField, sourceText].join(" ").trimEnd());
  } else {
    // Multiple lines needed
    for (let i = 0; i < line.bytes.length; i += bytesPerLine) {
      const chunk = line.bytes.slice(i, i + bytesPerLine);
      const byteField = chunk
        .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
        .join(" ");

      if (i === 0) {
        // First line has address and source
        lines.push([address, byteField, sourceText].join(" ").trimEnd());
      } else {
        // Continuation lines have indented bytes only
        const nextAddr = ((line.address ?? 0) + i) & 0xffff;
        const nextAddrStr = nextAddr
          .toString(16)
          .toUpperCase()
          .padStart(4, "0");
        lines.push([nextAddrStr, byteField].join(" ").trimEnd());
      }
    }
  }

  return lines;
}

export function formatListing(
  lines: readonly ListingLine[],
  options: ListingFormatOptions = {},
): string {
  const pageSize = options.pageSize ?? 0;
  const bytesPerLine = options.bytesPerLine ?? 16;
  const formattedLines: string[] = [];

  let currentPageLineCount = 0;
  let pageNumber = 1;
  let hasContentOnCurrentPage = false; // Track if we've output any content yet
  let currentTitle: string | undefined;
  let currentSubtitle: string | undefined;

  // Pre-compute: for each .page/.eject, find and mark preceding .title/.subttl directives to skip
  const skipped = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.pageBreak) {
      // Look back immediately before this line for .title and .subttl directives
      for (let j = i - 1; j >= 0 && j >= i - 2; j--) {
        const prev = lines[j];
        if (prev !== undefined && prev.address === null) {
          const src = prev.source.toUpperCase();
          if (src.startsWith(".SUBTTL") || src.startsWith(".TITLE")) {
            skipped.add(j); // Mark for skipping from normal output
          }
        }
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (skipped.has(i)) {
      continue; // Skip lines already processed
    }

    const line = lines[i];
    if (line === undefined) {
      continue; // Should not happen, but satisfy TypeScript
    }

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

    // Check if this line forces a page break (can be directive or content)
    const forcePageBreak = line.pageBreak ?? false;

    if (forcePageBreak) {
      // Only insert form feed if we already have content on this page
      if (currentPageLineCount > 0) {
        formattedLines.push("\f");
        currentPageLineCount = 0;
        hasContentOnCurrentPage = false;
        pageNumber += 1;
      }

      // Insert page headers (before the directives), whether at start or after form feed
      if (currentTitle !== undefined || currentSubtitle !== undefined) {
        if (currentTitle !== undefined) {
          formattedLines.push(currentTitle);
        }
        if (currentSubtitle !== undefined) {
          formattedLines.push(currentSubtitle);
        }
        formattedLines.push(""); // Blank line after header
        hasContentOnCurrentPage = true;
      }

      // Now emit .title and .subttl directives that preceded this .page
      // (they were marked as skipped to remove them from normal output)
      // Emit in order: .title first, then .subttl (they appear before .page in reverse index order)
      const titleLine = i > 1 ? lines[i - 2] : undefined;
      const subttlLine = i > 0 ? lines[i - 1] : undefined;

      if (
        titleLine !== undefined &&
        titleLine.address === null &&
        titleLine.source.toUpperCase().startsWith(".TITLE")
      ) {
        const formatted = formatListingLine(titleLine, { bytesPerLine });
        formattedLines.push(...formatted);
      }
      if (
        subttlLine !== undefined &&
        subttlLine.address === null &&
        subttlLine.source.toUpperCase().startsWith(".SUBTTL")
      ) {
        const formatted = formatListingLine(subttlLine, { bytesPerLine });
        formattedLines.push(...formatted);
      }
    }

    if (isContentLine) {
      // Check if we need automatic page break due to page size
      if (pageSize > 0 && currentPageLineCount >= pageSize) {
        formattedLines.push("\f"); // Form feed for page separation
        currentPageLineCount = 0;
        hasContentOnCurrentPage = false;
        pageNumber += 1;

        // Insert page headers right after the form feed
        if (currentTitle !== undefined || currentSubtitle !== undefined) {
          if (currentTitle !== undefined) {
            formattedLines.push(currentTitle);
          }
          if (currentSubtitle !== undefined) {
            formattedLines.push(currentSubtitle);
          }
          formattedLines.push(""); // Blank line after header
          hasContentOnCurrentPage = true;
        }
      }

      // Insert page headers at start of page if not already done (for non-paged content at start of file)
      if (
        !hasContentOnCurrentPage &&
        (currentTitle !== undefined || currentSubtitle !== undefined)
      ) {
        if (currentTitle !== undefined) {
          formattedLines.push(currentTitle);
        }
        if (currentSubtitle !== undefined) {
          formattedLines.push(currentSubtitle);
        }
        formattedLines.push(""); // Blank line after header
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
