import type { FliteTicketValidation } from "@cohost/flite-types";
import type { OutputField } from "@w6w/types";

/**
 * The link to send the scanner: a scanned QR link as-is, or a ticket barcode (as in an order's
 * `tickets[].barcode`) turned into Flite's QR link.
 */
export function scanLink(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Scan link or ticket barcode is required");
  const raw = value.trim();
  if (raw.length > 2048) throw new Error("Scan link is too long");
  if (/^[A-Za-z0-9]{6,64}$/.test(raw)) return `https://flite.city/Tickets/${raw}/scan`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter the scanned Flite ticket link or the ticket barcode");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Scan link must be a web link");
  return raw;
}

export const scanParams = [
  {
    key: "scanLink",
    label: "Scan link or barcode",
    type: "string" as const,
    required: true,
    hint: "The link from the ticket QR code exactly as scanned, e.g. https://flite.city/Tickets/ABC123/scan, or the ticket barcode.",
  },
];

export const scanOutput: OutputField[] = [
  { key: "valid", label: "Valid", type: "boolean" },
  { key: "checkedIn", label: "Checked in", type: "boolean" },
  { key: "errorCode", label: "Rejection code", type: "string" },
  { key: "result", label: "Scanner result", type: "object" },
];

export function scanResult(result: FliteTicketValidation) {
  return {
    valid: result.isValid,
    checkedIn: result.checkedIn,
    errorCode: result.errorCode ?? null,
    result,
  };
}
