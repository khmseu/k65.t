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
    let bytesField = " ".repeat(maxBytesWidth); // Empty bytes field padded
    // For assignment directives, show the assigned value as target
    if (bytesPerLine > 3 && line.target !== undefined) {
      const targetStr = line.target.toString(16).toUpperCase().padStart(4, "0");
      bytesField = bytesField.substring(0, maxBytesWidth - 4) + targetStr;
    }
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

  const pages: string[] = [];
  let current: string[] = [];
  let currentTitle: string | undefined;
  let currentSubtitle: string | undefined;

  const flushPage = (): void => {
    if (current.length === 0) return;
    if (currentTitle !== undefined || currentSubtitle !== undefined) {
      current.unshift(""); // Blank line under the page header.
      if (currentSubtitle !== undefined) current.unshift(currentSubtitle);
      if (currentTitle !== undefined) current.unshift(currentTitle);
    }
    if (pageSize) pages.push(current.splice(0, pageSize).join("\n"));
    else pages.push(current.splice(0).join("\n"));
  };

  for (const line of lines) {
    // .title / .subttl just update the running page header; they emit no body line.
    if (line.title !== undefined) {
      currentTitle = line.title;
      currentSubtitle = undefined; // A fresh title clears a stale subtitle.
    }
    if (line.subtitle !== undefined) currentSubtitle = line.subtitle;

    const formatted = formatListingLine(line, { bytesPerLine });
    current.push(...formatted);

    // .page / .eject begin a fresh page; the next body line re-emits the header.
    if (line.pageBreak) flushPage();

    // Automatic page break once the body fills a page.
    if (pageSize > 0) while (current.length >= pageSize) flushPage();
  }

  if (pageSize > 0) while (current.length >= pageSize) flushPage();
  return pages.join("\f");
}
