import type { ActionDefinition } from "@w6w/types";
import type { FliteEventWithTickets, FliteTicket } from "@cohost/flite-types";
import { FliteClient } from "../lib/client.ts";
import {
  type DesiredState,
  type DesiredTicket,
  connectionEnv,
  scopeMappings,
  planMappings,
  registration,
  connectionSegment,
  relabelRegistrations,
  digestToSave,
  type SyncOutput,
} from "../lib/sync.ts";
import { createEventFields, FLYER_TYPES, type CreateEventInput } from "./create-event.ts";
import type { MultipartFile } from "../lib/fields.ts";
import { newTicket } from "./create-ticket.ts";
import { ticketProperties } from "./update-ticket.ts";

export interface SyncEventInput {
  desired: DesiredState;
}

export default {
  key: "sync-event",
  title: "Sync Event",
  type: "perform",
  resource: "event",
  idempotent: true,
  description:
    "Reconcile a desired Flite event state against its durable URN mappings: create once, update, stop or reopen. Never deletes.",
  params: [
    { key: "desired", label: "Desired state", type: "json", required: true },
  ],
  output: [
    { key: "eventId", label: "Flite event ID", type: "string" },
    { key: "env", label: "Environment", type: "string" },
    { key: "mode", label: "Mode", type: "string" },
    { key: "registrations", label: "URN mappings to register", type: "array" },
    { key: "operations", label: "Operations", type: "array" },
    { key: "errors", label: "Errors", type: "array" },
    { key: "warnings", label: "Warnings", type: "array" },
    { key: "unchanged", label: "Skipped: desired state unchanged since the last successful sync", type: "boolean" },
  ],
  async execute(input, ctx): Promise<SyncOutput> {
    const connectionId = connectionSegment(ctx);
    // The Flite environment is the connection's own (a staging auth targets the sandbox API).
    const env = connectionEnv(ctx);
    const desired = { ...input.desired, mappings: scopeMappings(input.desired.mappings, input.desired.companyId, connectionId) };
    const out: SyncOutput = {
      eventId: "",
      env,
      mode: desired.mode,
      registrations: [],
      operations: [],
      errors: desired.errors.map((e) => (e.ticketId ? `ticket ${e.ticketId}: ${e.message}` : e.message)),
      warnings: [],
    };
    const plan = planMappings(desired);
    out.warnings.push(...plan.warnings);
    out.eventId = plan.fliteEventId ?? "";
    const mode = desired.mode;
    // Unchanged since the last fully successful sync (digest stored on this connection's event mapping): no client, no requests.
    if (
      desired.digest &&
      mode !== "noop" &&
      desired.errors.length === 0 &&
      !plan.unusableEventMapping &&
      plan.fliteEventId !== undefined &&
      plan.storedDigest === desired.digest
    ) {
      out.unchanged = true;
      return out;
    }
    const client = new FliteClient(ctx);
    if (mode === "noop") return out;
    if (plan.unusableEventMapping) {
      out.errors.push("event mapping present but has no usable labels.id; refusing to create or write");
      return out;
    }
    // Event-level conversion failure: errors only, zero requests.
    if (mode === "publish" && !desired.event) return out;

    // Set when a flyer download fails: the digest is then not saved, so the next run retries it.
    const flyerState = { failed: false };

    // After the first successful create, nothing may throw: failures are reported in `errors`.
    const attempt = async (op: string, target: string, detail: Record<string, unknown>, run: () => Promise<unknown>) => {
      try {
        await run();
        out.operations.push({ op, target, detail });
        return true;
      } catch (error) {
        out.errors.push(`${op} ${target}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };

    if (plan.fliteEventId === undefined) {
      if (mode !== "publish" || !desired.event) return out;
      return await createPath(client, desired, env, connectionId, out, attempt, flyerState);
    }

    const eventId = plan.fliteEventId;
    const remote = await client.getEvent(eventId);
    if (mode === "stop") {
      if (!remote.isEventEnd) await attempt("end-event", eventId, { ended: true }, () => client.setEventEnded(eventId, true));
      for (const t of remote.tickets ?? []) {
        if (t.availability !== "false") {
          await attempt("update-ticket", t._id, { availability: "false" }, () =>
            client.updateTicket(ticketProperties({ eventId, ticketId: t._id, availability: "false" })));
        }
      }
      const stopDigest = out.errors.length === 0 ? digestToSave(desired, plan.storedDigest) : undefined;
      if (stopDigest !== undefined) out.registrations.push(registration(desired, env, connectionId, eventId, undefined, stopDigest));
      return out;
    }

    if (mode === "publish") {
      if (!desired.event) return out; // conversion failure: errors only, no writes
      if (remote.isEventEnd) {
        await attempt("reopen-event", eventId, { ended: false }, () => client.setEventEnded(eventId, false));
      }
      // Fill a missing flyer only: Flite re-hosts uploads, so a changed Cohost flyer cannot be detected.
      if (desired.flyerUrl && !(remote.hostFlyer ?? []).length) {
        const flyer = await downloadFlyer(client, desired.flyerUrl, out, flyerState);
        if (flyer) await attempt("update-event-flyer", eventId, {}, () => client.updateEventFlyer(eventId, flyer));
      }
      const changed = diffEvent(desired.event, remote);
      if (Object.keys(changed).length) {
        await attempt("update-event", eventId, changed, async () => {
          await client.updateEvent({ eventId, ...changed });
        });
      }
    }

    const remoteTickets = new Map((remote.tickets ?? []).map((t) => [t._id, t]));
    const matched = new Set<string>();
    const byId = new Map(desired.tickets.map((t) => [t.ticketId, t]));
    for (const tp of plan.tickets) {
      const want = byId.get(tp.ticketId)!;
      if (tp.fliteTicketId === undefined) {
        if (mode !== "publish") continue; // hold never creates
        await createTicket(client, desired, env, connectionId, eventId, want, out, attempt);
        continue;
      }
      matched.add(tp.fliteTicketId);
      const have = remoteTickets.get(tp.fliteTicketId);
      if (!have) {
        out.errors.push(`ticket ${tp.ticketId}: mapped Flite ticket ${tp.fliteTicketId} not found on event ${eventId}`);
        continue;
      }
      const body = ticketDiff(want, have);
      if (body) {
        await attempt("update-ticket", have._id, body, () =>
          client.updateTicket(ticketProperties({ eventId, ticketId: have._id, ...body })));
      }
    }
    if (mode === "publish") {
      for (const have of remote.tickets ?? []) {
        if (matched.has(have._id) || have.availability === "false") continue;
        await attempt("update-ticket", have._id, { availability: "false" }, () =>
          client.updateTicket(ticketProperties({ eventId, ticketId: have._id, availability: "false" })));
      }
    }
    const saved = out.errors.length === 0 && !flyerState.failed ? digestToSave(desired, plan.storedDigest) : undefined;
    out.registrations.push(...relabelRegistrations(desired, env, connectionId, plan, saved));
    return out;
  },
} satisfies ActionDefinition<SyncEventInput>;

type Attempt = (op: string, target: string, detail: Record<string, unknown>, run: () => Promise<unknown>) => Promise<boolean>;

const EVENT_FIELDS = ["eventName", "description", "venueName", "venueLocation", "city", "state", "zipCode", "startDate", "endDate", "startTime", "endTime", "showEvent"] as const;

/** Only the event fields whose desired value differs from the remote's. */
function diffEvent(want: Record<string, string>, remote: FliteEventWithTickets): Record<string, string> {
  const have = remote as unknown as Record<string, unknown>;
  const changed: Record<string, string> = {};
  for (const key of EVENT_FIELDS) {
    if (want[key] === undefined) continue;
    let current = have[key] === undefined || have[key] === null ? "" : String(have[key]);
    if (key === "startDate" || key === "endDate") current = current.slice(0, 10);
    if (current !== want[key]) changed[key] = want[key];
  }
  return changed;
}

/** Capacity clamped to what is already sold; price/name/description only when changed. */
function ticketDiff(want: DesiredTicket, have: FliteTicket): Record<string, unknown> | undefined {
  const body: Record<string, unknown> = {};
  let availability: "true" | "false" = want.availability;
  if (want.capacity !== undefined) {
    if (want.capacity <= have.sold) availability = "false";
    const capacity = Math.max(want.capacity, have.sold);
    if (capacity !== have.capacity) body.capacity = capacity;
  }
  if (availability !== have.availability) body.availability = availability;
  const f = want.fields ?? {};
  if (f.ticketName !== undefined && f.ticketName !== have.ticketName) body.ticketName = f.ticketName;
  if (f.ticketPrice !== undefined && Number(f.ticketPrice) !== have.ticketPrice) body.ticketPrice = f.ticketPrice;
  if (f.description !== undefined && f.description !== have.description) body.description = f.description;
  return Object.keys(body).length ? body : undefined;
}

async function createTicket(
  client: FliteClient,
  desired: DesiredState,
  env: string,
  connectionId: string,
  eventId: string,
  want: DesiredTicket,
  out: SyncOutput,
  attempt: Attempt,
) {
  let id = "";
  const ok = await attempt("create-ticket", want.ticketId, {}, async () => {
    const f = want.fields ?? {};
    const created = await client.createTicket(newTicket({
      eventId,
      ticketName: f.ticketName as string,
      ticketPrice: f.ticketPrice as number,
      description: f.description as string | undefined,
      capacity: want.capacity,
      availability: want.availability,
    }));
    id = created._id;
  });
  if (ok) out.registrations.push(registration(desired, env, connectionId, eventId, { ticketUrn: want.ticketUrn, fliteTicketId: id }));
}

async function createPath(
  client: FliteClient,
  desired: DesiredState,
  env: string,
  connectionId: string,
  out: SyncOutput,
  attempt: Attempt,
  flyerState: { failed: boolean },
): Promise<SyncOutput> {
  // Validation and the create itself may throw: nothing exists yet. A flyer problem never blocks the create.
  const fields = createEventFields(desired.event as unknown as CreateEventInput);
  const flyer = desired.flyerUrl ? await downloadFlyer(client, desired.flyerUrl, out, flyerState) : undefined;
  const created = await client.createEvent(fields, flyer);
  const eventId = created._id;
  out.eventId = eventId;
  out.operations.push({ op: "create-event", target: eventId });
  // Registered first (the event, then its tickets); the digest is added below only if everything succeeded.
  const eventRegistration = out.registrations.push(registration(desired, env, connectionId, eventId)) - 1;
  for (const want of desired.tickets) await createTicket(client, desired, env, connectionId, eventId, want, out, attempt);
  const saved = out.errors.length === 0 && !flyerState.failed ? digestToSave(desired, undefined) : undefined;
  if (saved !== undefined) out.registrations[eventRegistration] = registration(desired, env, connectionId, eventId, undefined, saved);
  return out;
}

/** Flite's own flyer limit is unpublished; this is the W6W per-file ceiling. */
const FLYER_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The flyer image for `hostFlyer`, or undefined (with a warning) when it cannot be used. The
 * request goes out unsigned: the Flite auth's `sign` adds the token only on Flite's own hosts.
 */
async function downloadFlyer(
  client: FliteClient,
  url: string,
  out: SyncOutput,
  state?: { failed: boolean },
): Promise<Omit<MultipartFile, "name"> | undefined> {
  try {
    const response = await client.ctx.fetch(url, { headers: { accept: "image/*" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!FLYER_TYPES.includes(contentType)) throw new Error(`${contentType || "unknown type"} is not a PNG, JPEG, GIF or WebP image`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > FLYER_MAX_BYTES) throw new Error(`${bytes.length} bytes is outside 1 byte to 10 MB`);
    const ext = contentType.split("/")[1].replace("jpeg", "jpg");
    return { filename: `flyer.${ext}`, contentType, bytes };
  } catch (error) {
    if (state) state.failed = true;
    out.warnings.push(`flyer not uploaded: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
