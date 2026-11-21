// Turns a local Flite capture (.local/samples/<run>) into committed, anonymized test fixtures.
//
// Usage: node scripts/anonymize-fixtures.mjs .local/samples/<capture-directory>
//
// - No network calls, no env files read.
// - Fail-closed: every string field must have a rule below; an unknown field aborts the run.
// - Shape is preserved exactly (same keys, same types, same nulls/empties). Non-identifying
//   values (money, counts, booleans, enums, currency, time zones, times, US state) are kept.
// - Identifying values are replaced with synthetic ones that keep their format (ObjectIds stay
//   24-hex, UUIDs stay UUIDs, barcodes keep their letter/digit pattern), consistently across files.
// - Dates are shifted by a fixed 52 weeks, so weekdays and intervals are preserved.
// - Before writing, the output is scanned for every original identifying string; any hit aborts.
import fs from "node:fs";
import path from "node:path";

const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/anonymize-fixtures.mjs <capture-directory>");
const output = new URL("../tests/fixtures/live/", import.meta.url);

const DAY = 86_400_000;
const DATE_SHIFT = 364 * DAY;

const FIRST = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Drew"];
const LAST = ["Rivera", "Chen", "Patel", "Okafor", "Novak", "Larsen", "Moreau", "Silva", "Kim", "Haddad"];

// Values kept verbatim: API enums and non-identifying attributes.
const KEEP = new Set([
  "availability", "code", "currency", "endTime", "errorCode", "gender", "message", "rejectionReason", "rsvpType",
  "startTime", "state", "status", "timeZoneId", "transferStatus", "validityStatus",
]);
// Mongo ObjectId fields.
const OBJECT_ID = new Set(["_id", "eventId", "id", "orderId", "organizationId", "ownerId", "ticketId", "userId"]);
// Opaque identifiers: replaced with same-format random strings.
const OPAQUE = new Set([
  "barcode", "ebEventId", "ebTicketId", "eventCode", "orderNumber", "ticketNumber", "trackingLinkId",
  "transactionId", "uniqueLinkId", "zipCode",
]);
const DATES = new Set(["checkInTime", "created", "deleted", "endDate", "paymentDate", "startDate", "refreshTokenExpiresAt"]);
const URLS = new Set(["hostFlyer", "profileImage", "ticketQr", "webhookUrl"]);
const SECRETS = new Set(["token", "refreshToken", "accessToken"]);

const maps = new Map();
function indexOf(kind, value) {
  if (!maps.has(kind)) maps.set(kind, new Map());
  const map = maps.get(kind);
  if (!map.has(value)) map.set(value, map.size + 1);
  return map.get(value);
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h;
}
/** Same length, same character classes (digit/lower/upper/hex), punctuation kept. */
function samePattern(kind, value) {
  const n = indexOf(kind, value);
  const rand = rng(seedOf(`${kind}:${n}`));
  const pick = (chars) => chars[Math.floor(rand() * chars.length)];
  const hexOnly = /^[0-9a-f-]+$/.test(value);
  return value.replace(/[0-9]/g, () => pick("0123456789"))
    .replace(/[a-z]/g, () => pick(hexOnly ? "abcdef" : "abcdefghijklmnopqrstuvwxyz"))
    .replace(/[A-Z]/g, () => pick("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
}
function objectId(value) {
  return "65f1e" + indexOf("objectId", value).toString(16).padStart(19, "0");
}
function shiftDate(value) {
  const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) throw new Error(`Unparseable date: ${value.length} chars`);
  const shifted = new Date(date.getTime() + DATE_SHIFT).toISOString();
  return value.length === 10 ? shifted.slice(0, 10) : shifted;
}
function fakeUrl(key, value) {
  const ext = (value.match(/\.(png|jpe?g|gif|webp|svg|pdf)(?:[?#]|$)/i)?.[1] ?? "png").toLowerCase();
  return `https://example.com/assets/${key}/${indexOf(`url:${key}`, value)}.${ext}`;
}
function text(kind, value, label) {
  const n = indexOf(kind, value);
  const plain = `${label} ${n}`;
  return /<[a-z][\s\S]*>/i.test(value) ? `<p>${plain}.</p>` : plain;
}
function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function person(original) {
  const key = original.email ?? `${original.firstName ?? ""} ${original.lastName ?? ""}`;
  const i = indexOf("person", key) - 1;
  const firstName = FIRST[i % FIRST.length];
  const lastName = LAST[Math.floor(i / FIRST.length) % LAST.length];
  return { firstName, lastName, email: `${firstName}.${lastName}${i >= FIRST.length ? i : ""}@example.com`.toLowerCase() };
}

function anonymizeString(key, value, parent) {
  if (value === "") return value;
  if (KEEP.has(key)) return value;
  if (SECRETS.has(key)) return `fixture-${key}`;
  if (OBJECT_ID.has(key)) {
    if (!/^[a-f0-9]{24}$/i.test(value)) throw new Error(`${key} is not an ObjectId`);
    return objectId(value);
  }
  if (OPAQUE.has(key)) return samePattern(key, value);
  if (DATES.has(key)) return shiftDate(value);
  if (URLS.has(key)) return fakeUrl(key, value);
  switch (key) {
    case "firstName":
    case "lastName":
      return person(parent)[key];
    case "email":
      // People have names next to their email; organizations do not.
      return "firstName" in parent || "lastName" in parent ? person(parent).email : `organizer${indexOf("orgEmail", value)}@example.com`;
    case "mobileNumber":
      return `+120255501${String(indexOf("phone", value) % 100).padStart(2, "0")}`;
    case "name":
      return text("orgName", value, "Sample Organization");
    case "eventName":
      return text("eventName", value, "Sample Event");
    case "slug":
      return slugify(`sample-event-${indexOf("slug", value)}`);
    case "venueName":
      return text("venueName", value, "Sample Venue");
    case "venueLocation":
      return `${100 + indexOf("venueLocation", value)} Example Avenue`;
    case "city":
      return text("city", value, "Sample City");
    case "description":
      return text("description", value, "Sample description");
    case "ticketName":
    case "ticketType": // the scanner's name for the ticket type
      return text("ticketName", value, "Ticket Tier");
    case "promoterName":
      return text("promoter", value, "Sample Promoter");
    case "instaHandles":
      return `sample_handle_${indexOf("insta", value)}`;
    default:
      throw new Error(`No anonymization rule for string field "${key}". Add one before regenerating.`);
  }
}

const originals = new Set();
function anonymize(value, key = "", parent = {}) {
  if (Array.isArray(value)) return value.map((item) => anonymize(item, key, parent));
  if (value && typeof value === "object") {
    if (key === "eventQuestionAnswers") {
      return Object.fromEntries(Object.entries(value).map(([k, v], i) => {
        if (typeof v === "string") originals.add(v);
        return [`question_${i + 1}`, typeof v === "string" ? `Sample answer ${i + 1}` : v];
      }));
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, anonymize(v, k, value)]));
  }
  if (typeof value !== "string") return value;
  if (!KEEP.has(key) && value.length >= 3) originals.add(value);
  return anonymizeString(key, value, parent);
}

const files = fs.readdirSync(input).filter((name) => /\.(response|derived)\.json$/.test(name)).sort();
if (!files.length) throw new Error("No response or derived JSON captures found");
const artifacts = files.map((name) => {
  const capture = JSON.parse(fs.readFileSync(path.join(input, name), "utf8"));
  // Drop request metadata, headers, timestamps and local notes; keep HTTP status for replay.
  const payload = name.endsWith(".response.json")
    ? { status: capture.response.status, body: capture.response.body }
    : Object.fromEntries(Object.entries(capture).filter(([key]) => !["source", "note"].includes(key)));
  return [name, anonymize(payload)];
});

// Leak check: no original identifying value, nor any long word from one, may survive.
// Compare against synthesized values only: field names and deliberately kept values are not leaks.
const synthesized = [];
(function collect(value, key = "") {
  if (Array.isArray(value)) return value.forEach((item) => collect(item, key));
  if (value && typeof value === "object") return Object.entries(value).forEach(([k, v]) => collect(v, k));
  if (typeof value === "string" && !KEEP.has(key)) synthesized.push(value);
})(artifacts.map(([, payload]) => payload));
const out = synthesized.join("\n");
const vocabulary = new Set("sample organization event venue example avenue description ticket promoter answer handle organizer fixture".split(" "));
const leaks = [];
for (const original of originals) {
  if (out.includes(original)) leaks.push(`value(${original.length} chars)`);
  for (const word of original.replace(/<[^>]+>/g, " ").split(/[^A-Za-z0-9]+/)) {
    if (word.length >= 6 && !vocabulary.has(word.toLowerCase()) && !/^\d+$/.test(word) &&
      new RegExp(`\\b${word}\\b`, "i").test(out)) {
      leaks.push(`word(${word.length} chars)`);
    }
  }
}
if (leaks.length) {
  throw new Error(`Anonymization leak check failed (${leaks.length}): ${[...new Set(leaks)].join(", ")}. Nothing written.`);
}

fs.mkdirSync(output, { recursive: true });
for (const stale of fs.readdirSync(output).filter((name) => name.endsWith(".json"))) {
  fs.rmSync(new URL(stale, output));
}
for (const [name, payload] of artifacts) {
  fs.writeFileSync(new URL(name, output), JSON.stringify(payload, null, 2) + "\n");
}
console.log(`Wrote ${artifacts.length} anonymized fixtures; leak check passed on ${originals.size} original values.`);
