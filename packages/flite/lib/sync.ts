import { baseUrl, STAGING_API_URL } from "./client.ts";

/**
 * Pure planner for Sync Event: env guard, mapping choice and registrations. No requests.
 * The desired-state types are a structural copy of the transformer's `lib/channel-sync.ts`:
 * each app is bundled standalone, so the two packages cannot import each other.
 */

export type SyncMode = "publish" | "hold" | "stop" | "noop";

export interface MappingRecord {
  urn?: string;
  mappedUrn?: string;
  labels?: Record<string, string>;
  [key: string]: unknown;
}

export interface DesiredTicket {
  ticketId: string;
  ticketUrn: string;
  fields: Record<string, unknown>;
  availability: "true" | "false";
  capacity?: number;
}

export interface DesiredState {
  mode: SyncMode;
  companyId: string;
  channelId: string;
  listingId: string;
  eventId: string;
  eventUrn: string;
  labels: { provider: string; env: string; org: string; channelId: string; listingId: string };
  event: Record<string, string> | null;
  tickets: DesiredTicket[];
  mappings: { event: MappingRecord[]; tickets: Record<string, MappingRecord[]> };
  errors: Array<{ message: string; ticketId?: string }>;
}

export interface Registration {
  urn: string;
  mappedUrn: string;
  labels: Record<string, string>;
}

export interface SyncOperation {
  op: string;
  target: string;
  detail?: Record<string, unknown>;
}

export interface SyncOutput {
  eventId: string;
  env: string;
  mode: SyncMode;
  registrations: Registration[];
  operations: SyncOperation[];
  errors: string[];
  warnings: string[];
}

export type FliteEnv = "sandbox" | "production";

/** The environment of a connection: sandbox iff it targets the staging API. Never reads process.env. */
export function connectionEnv(ctx: Parameters<typeof baseUrl>[0]): FliteEnv {
  return baseUrl(ctx) === STAGING_API_URL ? "sandbox" : "production";
}

/** Throws before any request when the connection disagrees with the workflow or the desired labels. */
export function guardEnv(
  ctx: Parameters<typeof baseUrl>[0],
  expectedEnv: string,
  desired: Pick<DesiredState, "labels">,
): FliteEnv {
  const env = connectionEnv(ctx);
  if (expectedEnv !== "sandbox" && expectedEnv !== "production") {
    throw new Error("expectedEnv must be sandbox or production");
  }
  if (env !== expectedEnv || env !== desired.labels?.env) {
    throw new Error(`Connection is ${env} but the workflow expects ${expectedEnv}`);
  }
  return env;
}

/** `urn:1:<companyId>:flite-<env>:/events/<id>[/tickets/<id>]` (plan.md §Pinned interface). */
export function mappedUrn(companyId: string, env: string, eventId: string, ticketId?: string): string {
  const base = `urn:1:${companyId}:flite-${env}:/events/${eventId}`;
  return ticketId === undefined ? base : `${base}/tickets/${ticketId}`;
}

export interface MappingChoice {
  /** The Flite id, from the mapping's `labels.id` only. */
  id: string | undefined;
  /** The stored `listingId` label of the chosen record. */
  storedListingId: string | undefined;
  warnings: string[];
}

function choose(records: MappingRecord[], what: string, accept: (r: MappingRecord) => boolean): MappingChoice {
  const usable = records
    .filter((r) => typeof r?.labels?.id === "string" && r.labels.id !== "" && accept(r))
    .sort((a, b) => (a.labels!.id < b.labels!.id ? -1 : a.labels!.id > b.labels!.id ? 1 : 0));
  if (!usable.length) return { id: undefined, storedListingId: undefined, warnings: [] };
  const ids = [...new Set(usable.map((r) => r.labels!.id))];
  const chosen = usable[0];
  return {
    id: chosen.labels!.id,
    storedListingId: chosen.labels!.listingId,
    warnings: ids.length > 1
      ? [`${ids.length} ${what} mappings found (${ids.join(", ")}); using the smallest id ${chosen.labels!.id}`]
      : [],
  };
}

/** One event mapping ⇒ use it; several ⇒ the lexicographically smallest Flite id plus a warning. `listingId` never selects. */
export function chooseEventMapping(records: MappingRecord[] | undefined): MappingChoice {
  return choose(records ?? [], "event", () => true);
}

/** A ticket mapping counts only when its `labels.eventId` is the chosen Flite event. */
export function chooseTicketMapping(records: MappingRecord[] | undefined, fliteEventId: string): MappingChoice {
  return choose(records ?? [], "ticket", (r) => r.labels!.eventId === fliteEventId);
}

export interface TicketPlan {
  ticketId: string;
  ticketUrn: string;
  /** The mapped Flite ticket id; undefined ⇒ one create on the chosen event. */
  fliteTicketId: string | undefined;
  storedListingId: string | undefined;
}

export interface MappingPlan {
  /** The chosen Flite event id; undefined ⇒ one create (publish only). */
  fliteEventId: string | undefined;
  storedListingId: string | undefined;
  tickets: TicketPlan[];
  warnings: string[];
}

/** Resolve every Flite id from `desired.mappings` alone. */
export function planMappings(desired: DesiredState): MappingPlan {
  const event = chooseEventMapping(desired.mappings?.event);
  const warnings = [...event.warnings];
  const tickets: TicketPlan[] = desired.tickets.map((t) => {
    if (event.id === undefined) {
      return { ticketId: t.ticketId, ticketUrn: t.ticketUrn, fliteTicketId: undefined, storedListingId: undefined };
    }
    const choice = chooseTicketMapping(desired.mappings?.tickets?.[t.ticketId], event.id);
    warnings.push(...choice.warnings.map((w) => `ticket ${t.ticketId}: ${w}`));
    return {
      ticketId: t.ticketId,
      ticketUrn: t.ticketUrn,
      fliteTicketId: choice.id,
      storedListingId: choice.storedListingId,
    };
  });
  return { fliteEventId: event.id, storedListingId: event.storedListingId, tickets, warnings };
}

/** A registration with every label field set. */
export function registration(
  desired: DesiredState,
  env: string,
  fliteEventId: string,
  ticket?: { ticketUrn: string; fliteTicketId: string },
): Registration {
  const l = desired.labels;
  return {
    urn: ticket ? ticket.ticketUrn : desired.eventUrn,
    mappedUrn: mappedUrn(desired.companyId, env, fliteEventId, ticket?.fliteTicketId),
    labels: {
      provider: l.provider,
      env,
      org: l.org,
      channelId: l.channelId,
      listingId: l.listingId,
      kind: ticket ? "ticket" : "event",
      id: ticket ? ticket.fliteTicketId : fliteEventId,
      eventId: fliteEventId,
    },
  };
}

/** Existing mapped resources whose stored `listingId` differs from the desired one (a relabel; never a create). */
export function relabelRegistrations(desired: DesiredState, env: string, plan: MappingPlan): Registration[] {
  if (plan.fliteEventId === undefined) return [];
  const out: Registration[] = [];
  if (plan.storedListingId !== desired.labels.listingId) {
    out.push(registration(desired, env, plan.fliteEventId));
  }
  for (const t of plan.tickets) {
    if (t.fliteTicketId !== undefined && t.storedListingId !== desired.labels.listingId) {
      out.push(registration(desired, env, plan.fliteEventId, { ticketUrn: t.ticketUrn, fliteTicketId: t.fliteTicketId }));
    }
  }
  return out;
}
