import type { ListingLine } from "./types.js";

export function formatListingLine(line: ListingLine): string {
  const address = line.address === null ? "    " : line.address.toString(16).toUpperCase().padStart(4, "0");
  const byteField = line.bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  const paddedBytes = byteField.length > 0 ? byteField : "";

  return [address, paddedBytes, line.source].join(" ").trimEnd();
}

export function formatListing(lines: readonly ListingLine[]): string {
  return lines.map(formatListingLine).join("\n");
}