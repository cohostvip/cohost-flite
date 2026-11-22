// Input validation and request encoding shared by the Flite write actions. Flite answers a bad field
// with HTTP 400 and a message the client does not echo (provider bodies may carry customer data), so
// the documented rules are checked here first, where the error can name the field.

export const TICKET_AVAILABILITY = ["true", "false", "hide", "soon"] as const;
export type TicketAvailability = (typeof TICKET_AVAILABILITY)[number];

/** Select options for the ticket availability param, in `TICKET_AVAILABILITY` order. */
export const availabilityOptions: Array<{ label: string; value: TicketAvailability }> = [
  { label: "Available", value: "true" },
  { label: "Unavailable", value: "false" },
  { label: "Hidden", value: "hide" },
  { label: "Coming soon", value: "soon" },
];

export function text(value: unknown, label: string, { required = false, max = 5000 } = {}): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${label} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new Error(`${label} is required`);
    return undefined;
  }
  if (trimmed.length > max) throw new Error(`${label} must be at most ${max} characters`);
  return trimmed;
}

export function date(value: unknown, label: string, required = false): string | undefined {
  const raw = text(value, label, { required, max: 40 });
  if (raw === undefined) return undefined;
  // A date picker may hand over a full ISO instant; Flite wants the calendar date only.
  const day = /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(raw) ? raw.slice(0, 10) : "";
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!day || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error(`${label} must be a date in YYYY-MM-DD format`);
  }
  return day;
}

export function time(value: unknown, label: string, required = false): string | undefined {
  const raw = text(value, label, { required, max: 5 });
  if (raw === undefined) return undefined;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) throw new Error(`${label} must be a time in HH:mm format`);
  return raw;
}

export function integer(value: unknown, label: string, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${label} must be an integer from ${min}${max === Number.MAX_SAFE_INTEGER ? " up" : ` to ${max}`}`);
  }
  return n;
}

export function price(value: unknown, label: string, required = false): number | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${label} is required`);
    return undefined;
  }
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a nonnegative number`);
  }
  // Flite stores a sub-cent price such as 10.005 as sent (sandbox, 2026-11-21); no checkout can charge it.
  const cents = n * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-6) throw new Error(`${label} must be in whole cents`);
  return Math.round(cents) / 100;
}

export function flag(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${label} must be true or false`);
}

export function availability(value: unknown): TicketAvailability | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!TICKET_AVAILABILITY.includes(value as TicketAvailability)) throw new Error("Invalid ticket availability");
  return value as TicketAvailability;
}

/** Drops undefined entries so only the fields the caller set are sent. */
export function defined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface MultipartFile {
  name: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

function headerValue(value: string, label: string): string {
  if (/[\r\n"]/.test(value)) throw new Error(`${label} contains characters a form upload cannot carry`);
  return value;
}

/**
 * Encodes a `multipart/form-data` body as bytes. The W6W sandbox carries a request body across its
 * boundary only as a string or a `Uint8Array`, so a `FormData` cannot be handed to `ctx.fetch`.
 */
export function multipart(
  fields: Record<string, string>,
  files: MultipartFile[],
  boundary = `----w6w-flite-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")}`,
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${headerValue(name, "Field name")}"\r\n\r\n${value}\r\n`,
    ));
  }
  for (const file of files) {
    const filename = headerValue(file.filename || "upload", "File name");
    const contentType = headerValue(file.contentType || "application/octet-stream", "File type");
    parts.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${headerValue(file.name, "Field name")}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ));
    parts.push(file.bytes);
    parts.push(encoder.encode("\r\n"));
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
