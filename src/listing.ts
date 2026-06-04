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

  // Calculate fixed column positions based on bytesPerLine
  // Address (4 hex digits) + space + bytes field
  const maxBytesWidth = bytesPerLine * 3 - 1; // "XX XX XX..." = 3 chars per byte minus 1

  // Format the main listing line with bytes split across multiple lines if needed
  const address =
    line.address === null
      ? "    "
      : line.address.toString(16).toUpperCase().padStart(4, "0");
  const sourceText = line.source;

  const lines: string[] = [];

  if (line.bytes.length === 0) {
    // No bytes, just address and source (pad bytes field to maintain column alignment)
    const bytesField = " ".repeat(maxBytesWidth); // Empty bytes field padded
    const line1 = address + " " + bytesField + " " + sourceText;
    lines.push(line1.trimEnd());
  } else if (line.bytes.length <= bytesPerLine) {
    // All bytes fit on one line
    const byteField = line.bytes
      .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");
    // Pad bytes field to fixed width
    let paddedBytes = byteField.padEnd(maxBytesWidth);
    if (bytesPerLine > 3 && line.target !== undefined) {
      // If there's a target, right-align it in the bytes field (overlapping last 4 chars)
      const targetStr = line.target.toString(16).toUpperCase().padStart(4, "0");
      paddedBytes = paddedBytes.substring(0, maxBytesWidth - 4) + targetStr;
    }
    const line1 = address + " " + paddedBytes + " " + sourceText;
    lines.push(line1.trimEnd());
  } else {
    // Multiple lines needed
    for (let i = 0; i < line.bytes.length; i += bytesPerLine) {
      const chunk = line.bytes.slice(i, i + bytesPerLine);
      const byteField = chunk
        .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
        .join(" ");

      const nextAddr = ((line.address ?? 0) + i) & 0xffff;
      const nextAddrStr = nextAddr.toString(16).toUpperCase().padStart(4, "0");

      if (i === 0) {
        // First line has address and source
        const paddedBytes = byteField.padEnd(maxBytesWidth);
        const firstLine = nextAddrStr + " " + paddedBytes + " " + sourceText;
        lines.push(firstLine.trimEnd());
      } else {
        // Continuation lines have indented bytes only, padded to alignment
        const paddedBytes = byteField.padEnd(maxBytesWidth);
        const contLine = nextAddrStr + " " + paddedBytes;
        lines.push(contLine.trimEnd());
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

  // Pre-compute: for each .page/.eject, collect and mark preceding listing directives to skip
  const precedingDirectives = new Map<number, number[]>(); // Maps .page index to list of directive indices before it
  const skipped = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.pageBreak) {
      // Look back for all consecutive listing directives before this .page/.eject
      const directives: number[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j];
        if (prev !== undefined && prev.address === null) {
          const src = prev.source.toUpperCase();
          // Stop if we hit another .page/.eject (but not .pagesize, .bytesperline)
          if (
            src === ".PAGE" ||
            src.startsWith(".PAGE ") ||
            src === ".EJECT" ||
            src.startsWith(".EJECT ")
          ) {
            break; // Stop at another page break
          }
          // Collect all listing directives
          if (
            src === ".TITLE" ||
            src.startsWith(".TITLE ") ||
            src === ".SUBTTL" ||
            src.startsWith(".SUBTTL ") ||
            src === ".PAGESIZE" ||
            src.startsWith(".PAGESIZE ") ||
            src === ".BYTESPERLINE" ||
            src.startsWith(".BYTESPERLINE ") ||
            src === ".LIST" ||
            src.startsWith(".LIST ") ||
            src === ".NOLIST" ||
            src.startsWith(".NOLIST ")
          ) {
            directives.unshift(j); // Add to front to maintain order
            skipped.add(j);
          } else if (prev.bytes.length === 0) {
            // Continue past non-listing directives (comments/empty lines)
            continue;
          } else {
            break; // Stop at content lines
          }
        } else if (prev !== undefined && prev.address !== null) {
          break; // Stop at content lines
        }
      }
      if (directives.length > 0) {
        precedingDirectives.set(i, directives);
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

      // Now emit any directives that preceded this .page
      // (they were marked as skipped to remove them from normal output)
      const precedingDirs = precedingDirectives.get(i);
      if (precedingDirs !== undefined) {
        for (const dirIdx of precedingDirs) {
          const dirLine = lines[dirIdx];
          if (dirLine !== undefined) {
            const formatted = formatListingLine(dirLine, { bytesPerLine });
            formattedLines.push(...formatted);
          }
        }
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
