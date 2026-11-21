// Derives packages/flite-types/responses.ts, the Flite response types, from real Flite JSON.
//
//   node scripts/derive-types.mjs          write the file
//   node scripts/derive-types.mjs --check  exit 1 if the file is stale (used by the test suite)
//
// Sources: anonymized live captures (tests/fixtures/live) and the documented examples
// (samples/documented). A field is required when it appears in every live sample of its type;
// fields seen only in the docs are optional. Types without live samples fall back to the docs.
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const target = new URL("packages/flite-types/responses.ts", root);

const live = (name) => JSON.parse(fs.readFileSync(new URL(`tests/fixtures/live/${name}.response.json`, root), "utf8")).body;
const docs = (name) => JSON.parse(fs.readFileSync(new URL(`samples/documented/${name}.json`, root), "utf8"));

/** Each root: a named type and where its samples live, as [loader, file, path]. */
const ROOTS = [
  ["FlitePartnerSession", "POST /api/partner-login, /api/partner-refresh-token and /api/switch-organization-token/{organizationId}", [
    [live, "login", "data"], [live, "partner-refresh-token", "data"],
  ]],
  ["FliteOrganization", "GET /api/get-all-orgs-partner (each item)", [
    [live, "organizations-partner", "data[]"], [docs, "organizations", "data[]"],
  ]],
  ["FliteEventSummary", "GET /api/get-events-all (each item)", [
    [live, "events-page-1", "data[]"], [live, "staging-events-page-1", "data[]"], [docs, "events-page", "data[]"],
  ]],
  ["FliteEventListPagination", "GET /api/get-events-all (pagination)", [
    [live, "events-page-1", "pagination"], [live, "staging-events-page-1", "pagination"],
  ]],
  ["FliteEvent", "GET /api/get-event-by-id", [
    [live, "event-1", "data"], [live, "staging-event", "data"], [live, "staging-event-after-delete", "data"],
    [docs, "event", "data"],
  ]],
  ["FliteEventWithTickets", "GET /api/get-event-tickets-info", [
    [live, "event-1-with-tickets", "data"], [live, "staging-event-with-tickets", "data"], [docs, "event-with-tickets", "data"],
  ]],
  ["FliteCreatedEvent", "POST /api/create-event-partner", [[live, "staging-event-created", "data"]]],
  ["FliteEventUpdate", "POST /api/update-event-properties", [
    [live, "staging-event-updated", "data"], [live, "staging-event-update-unchanged", "data"],
  ]],
  ["FliteEventEndState", "POST /api/update-event-end-toggle", [
    [live, "staging-event-ended", "data"], [live, "staging-event-reopened", "data"],
  ]],
  ["FliteDeletedEvent", "DELETE /api/delete-event-partner", [[live, "staging-event-deleted", "data"]]],
  ["FliteTicket", "GET /api/get-ticket-by-id; also each ticket of an event", [
    [live, "event-1-ticket-1", "data"], [live, "event-1-ticket-2", "data"], [live, "staging-ticket", "data"],
    [docs, "ticket", "data"],
  ]],
  ["FliteCreatedTicket", "POST /api/create-new-ticket", [[live, "staging-ticket-created", "data"]]],
  ["FliteTicketUpdate", "POST /api/update-ticket-properties", [[live, "staging-ticket-updated", "data"]]],
  ["FliteDeletedTicket", "DELETE /api/delete-ticket-partner", [[live, "staging-ticket-deleted", "data"]]],
  ["FliteOrdersPage", "GET /api/get-orders-by-event", [
    [live, "event-9-orders-page-1", "data"], [docs, "orders-page", "data"],
  ]],
  ["FliteOrder", "GET /api/get-order-by-id", [[live, "event-9-order-1", "data"], [docs, "order", "data"]]],
  ["FliteTicketValidation", "POST /api/scanner/ticket/validate and /api/scanner/ticket/checkin (also on HTTP 404/409)", [
    [live, "staging-scan-validate", "data"], [live, "staging-scan-checkin", "data"],
    [live, "staging-scan-validate-not-found", "data"], [live, "staging-scan-checkin-not-found", "data"],
    [live, "staging-scan-checkin-repeat", "data"], [live, "staging-scan-validate-checked-in", "data"],
    [docs, "ticket-validation", "data"],
  ]],
  ["FliteWebhookUrl", "GET /api/get-webhook-url", [[live, "webhook-url", "data"]]],
];
/** Names for nested objects; anything else becomes Parent + Key. */
const NESTED = {
  "FlitePartnerSession.user": "FlitePartnerUser",
  "FlitePartnerUser.organization": "FliteOrganizationRef",
  "FliteEventWithTickets.tickets": "FliteTicket",
  "FliteOrdersPage.orders": "FliteOrderListItem",
  "FliteOrdersPage.pagination": "FlitePagination",
  "FliteOrderListItem.user": "FliteBuyer",
  "FliteOrder.user": "FliteBuyer",
  "FliteOrderListItem.tickets": "FliteOrderListTicket",
  "FliteOrder.tickets": "FliteOrderTicket",
};
/** Where the JSON alone cannot express the contract. */
const OVERRIDES = {
  "FliteTicket.availability": '"true" | "false" | "hide" | "soon"',
  "FliteOrder.eventQuestionAnswers": "Record<string, string>",
  "FliteOrderListItem.eventQuestionAnswers": "Record<string, string>",
  "FliteOrder.instaHandles": "string[]",
  "FliteTicketValidation.validityStatus": '"valid" | "invalid"',
  "FliteWebhookUrl.webhookUrl": "string | null",
};
/** String fields whose observed values are listed in the docs comment. */
const ENUMS = new Set(["status", "availability", "currency", "gender", "timeZoneId", "rsvpType", "transferStatus", "validityStatus", "errorCode"]);

const buckets = new Map(); // type -> { samples: [{origin, value}], source }
function bucket(type) {
  if (!buckets.has(type)) buckets.set(type, { samples: [], source: null });
  return buckets.get(type);
}
const nestedName = (type, key) => NESTED[`${type}.${key}`] ?? `${type}${key[0].toUpperCase()}${key.slice(1)}`;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function collect(type, value, origin) {
  bucket(type).samples.push({ origin, value });
  for (const [key, v] of Object.entries(value)) {
    if (OVERRIDES[`${type}.${key}`]) continue;
    for (const item of Array.isArray(v) ? v : [v]) if (isObject(item)) collect(nestedName(type, key), item, origin);
  }
}
function select(value, path) {
  let current = [value];
  for (const part of path.split(".")) {
    const many = part.endsWith("[]");
    current = current.map((v) => v[many ? part.slice(0, -2) : part]);
    if (many) current = current.flat();
  }
  return current;
}
for (const [type, source, inputs] of ROOTS) {
  bucket(type).source = source;
  for (const [load, file, path] of inputs) {
    const origin = load === live ? "live" : "docs";
    for (const value of select(load(file), path)) collect(type, value, origin);
  }
}

function typeOf(type, key, values) {
  if (OVERRIDES[`${type}.${key}`]) return OVERRIDES[`${type}.${key}`];
  const kinds = new Set();
  const items = [];
  for (const v of values) {
    if (v === null) kinds.add("null");
    else if (Array.isArray(v)) { kinds.add("array"); items.push(...v); }
    else if (isObject(v)) kinds.add(nestedName(type, key));
    else kinds.add(typeof v);
  }
  const parts = [...kinds].filter((k) => k !== "array" && k !== "null").sort();
  if (kinds.has("array")) {
    const element = items.length ? typeOf(type, key, items) : "unknown";
    parts.push(element.includes("|") ? `Array<${element}>` : `${element}[]`);
  }
  // Only null observed: the real type is unknown; assume a nullable string and say so.
  if (kinds.size === 1 && kinds.has("null")) return "string | null";
  if (kinds.has("null")) parts.push("null");
  return parts.join(" | ") || "unknown";
}

let out = `// Flite Partner API response types, derived from tests/fixtures/live and samples/documented.
// Do not edit by hand: add or refresh a capture, then run \`npm run types\`.
`;
const order = [...ROOTS.map(([t]) => t), ...[...buckets.keys()].filter((t) => !ROOTS.some(([r]) => r === t))];
for (const type of order) {
  const { samples, source } = buckets.get(type);
  const liveSamples = samples.filter((s) => s.origin === "live");
  const basis = liveSamples.length ? liveSamples : samples;
  const keys = [];
  for (const { value } of [...liveSamples, ...samples]) for (const k of Object.keys(value)) if (!keys.includes(k)) keys.push(k);
  const origins = [...new Set(samples.map((s) => s.origin))].join(" + ");
  out += `\n/** ${source ? `${source}. ` : ""}Derived from ${samples.length} sample(s): ${origins}. */\n`;
  out += `export interface ${type} {\n`;
  for (const key of keys) {
    const values = samples.filter((s) => key in s.value).map((s) => s.value[key]);
    const required = basis.every((s) => key in s.value);
    const observed = ENUMS.has(key) ? [...new Set(values.filter((v) => typeof v === "string"))].sort() : [];
    const notes = [];
    if (observed.length) notes.push(`Observed: ${observed.map((v) => JSON.stringify(v)).join(", ")}`);
    if (!liveSamples.some((s) => key in s.value) && liveSamples.length) notes.push("Documented only; not seen in live responses");
    if (!OVERRIDES[`${type}.${key}`] && values.length && values.every((v) => v === null)) notes.push("Only null observed; type assumed");
    if (notes.length) out += `  /** ${notes.join(". ")}. */\n`;
    const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    out += `  ${name}${required ? "" : "?"}: ${typeOf(type, key, values)};\n`;
  }
  out += "}\n";
}

if (process.argv.includes("--check")) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (current !== out) {
    console.error("packages/flite-types/responses.ts is out of date with the JSON samples. Run: npm run types");
    process.exit(1);
  }
  console.log("Flite types are up to date with the JSON samples.");
} else {
  fs.mkdirSync(new URL(".", target), { recursive: true });
  fs.writeFileSync(target, out);
  console.log(`Wrote ${order.length} types to packages/flite-types/responses.ts`);
}
