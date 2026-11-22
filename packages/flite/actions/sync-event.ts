import type { ActionDefinition } from "@w6w/types";
import type { FliteEventWithTickets, FliteTicket } from "@cohost/flite-types";
import { FliteClient } from "../lib/client.ts";
import {
  type DesiredState,
  type DesiredTicket,
  guardEnv,
  planMappings,
  registration,
  connectionSegment,
  relabelRegistrations,
  type SyncOutput,
} from "../lib/sync.ts";
import { createEventFields, type CreateEventInput } from "./create-event.ts";
import { newTicket } from "./create-ticket.ts";
import { ticketProperties } from "./update-ticket.ts";

export interface SyncEventInput {
  desired: DesiredState;
  expectedEnv: "sandbox" | "production";
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
    {
      key: "expectedEnv",
      label: "Expected environment",
      type: "select",
      required: true,
      options: [{ label: "Sandbox", value: "sandbox" }, { label: "Production", value: "production" }],
    },
  ],
  output: [
    { key: "eventId", label: "Flite event ID", type: "string" },
    { key: "env", label: "Environment", type: "string" },
    { key: "mode", label: "Mode", type: "string" },
    { key: "registrations", label: "URN mappings to register", type: "array" },
    { key: "operations", label: "Operations", type: "array" },
    { key: "errors", label: "Errors", type: "array" },
    { key: "warnings", label: "Warnings", type: "array" },
  ],
  async execute(input, ctx): Promise<SyncOutput> {
    const desired = input.desired;
    // The env guard runs before any request.
    const env = guardEnv(ctx, input.expectedEnv, desired);
    const connectionId = connectionSegment(ctx);
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
    const client = new FliteClient(ctx);
    const mode = desired.mode;
    if (mode === "noop") return out;
    if (plan.unusableEventMapping) {
      out.errors.push("event mapping present but has no usable labels.id; refusing to create or write");
      return out;
    }
    // Event-level conversion failure: errors only, zero requests.
    if (mode === "publish" && !desired.event) return out;

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
      return await createPath(client, desired, env, connectionId, out, attempt);
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
      return out;
    }

    if (mode === "publish") {
      if (!desired.event) return out; // conversion failure: errors only, no writes
      if (remote.isEventEnd) {
        await attempt("reopen-event", eventId, { ended: false }, () => client.setEventEnded(eventId, false));
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
    out.registrations.push(...relabelRegistrations(desired, env, connectionId, plan));
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
): Promise<SyncOutput> {
  // Validation and the create itself may throw: nothing exists yet.
  const created = await client.createEvent(createEventFields(desired.event as unknown as CreateEventInput));
  const eventId = created._id;
  out.eventId = eventId;
  out.operations.push({ op: "create-event", target: eventId });
  out.registrations.push(registration(desired, env, connectionId, eventId));
  for (const want of desired.tickets) await createTicket(client, desired, env, connectionId, eventId, want, out, attempt);
  return out;
}
