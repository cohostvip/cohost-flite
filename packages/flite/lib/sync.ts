import { baseUrl, STAGING_API_URL } from "./client.ts";

/**
 * Pure planner for Sync Event: connection scoping, mapping choice and registrations. No requests.
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
  labels: { provider: string; channelId: string; listingId: string };
  event: Record<string, string> | null;
  /** The flyer to upload on create (Flite takes `hostFlyer` only on create). Absent from older transformers. */
  flyerUrl?: string | null;
  tickets: DesiredTicket[];
  /** `v1:<sha256 hex>` content digest of the desired state. Absent from older transformers (no skip, nothing saved). */
  digest?: string;
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
  /** True when the run was skipped because the desired state's digest equals the one stored on the event mapping. */
  unchanged?: boolean;
}

export type FliteEnv = "sandbox" | "production";

/** The environment of a connection: sandbox iff it targets the staging API. Never reads process.env. */
export function connectionEnv(ctx: Parameters<typeof baseUrl>[0]): FliteEnv {
  return baseUrl(ctx) === STAGING_API_URL ? "sandbox" : "production";
}

/**
 * Only the mappings this connection made: a mapped URN is `urn:1:<company>:<connectionId>:/events/…`,
 * so the connection id scopes the Flite environment and account. Records under another Flite
 * connection (another account, or sandbox vs production) are ignored.
 */
export function scopeMappings(
  mappings: DesiredState["mappings"] | undefined,
  companyId: string,
  connectionId: string,
): DesiredState["mappings"] {
  const prefix = `urn:1:${companyId}:${connectionId}:/events/`;
  const own = (records: MappingRecord[] | undefined) =>
    (records ?? []).filter((r) => {
      const u = r?.mappedUrn ?? r?.urn;
      return typeof u === "string" && u.startsWith(prefix);
    });
  const tickets: Record<string, MappingRecord[]> = {};
  for (const [id, records] of Object.entries(mappings?.tickets ?? {})) tickets[id] = own(records);
  return { event: own(mappings?.event), tickets };
}

/** The URN source segment: the Flite connection's own id (HookContext), never a pseudo id. */
export function connectionSegment(ctx: { connection?: { id?: string } }): string {
  const id = ctx.connection?.id;
  if (typeof id !== "string" || !/^[^\s:/?#]+$/.test(id)) {
    throw new Error("connection id is required and must be a valid URN segment");
  }
  return id;
}

/** `urn:1:<companyId>:<connectionId>:/events/<id>[/tickets/<id>]`. */
export function mappedUrn(companyId: string, connectionId: string, eventId: string, ticketId?: string): string {
  const base = `urn:1:${companyId}:${connectionId}:/events/${eventId}`;
  return ticketId === undefined ? base : `${base}/tickets/${ticketId}`;
}

export interface MappingChoice {
  /** The Flite id, from the mapping's `labels.id` only. */
  id: string | undefined;
  /** The stored `listingId` label of the chosen record. */
  storedListingId: string | undefined;
  /** The stored `digest` label of the chosen record (the last successfully synced desired state). */
  storedDigest: string | undefined;
  warnings: string[];
}

function choose(records: MappingRecord[], what: string, accept: (r: MappingRecord) => boolean): MappingChoice {
  const usable = records
    .filter((r) => typeof r?.labels?.id === "string" && r.labels.id !== "" && accept(r))
    .sort((a, b) => (a.labels!.id < b.labels!.id ? -1 : a.labels!.id > b.labels!.id ? 1 : 0));
  if (!usable.length) return { id: undefined, storedListingId: undefined, storedDigest: undefined, warnings: [] };
  const ids = [...new Set(usable.map((r) => r.labels!.id))];
  const chosen = usable[0];
  return {
    id: chosen.labels!.id,
    storedListingId: chosen.labels!.listingId,
    storedDigest: chosen.labels!.digest,
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
  /** The chosen (connection-scoped) event mapping's stored digest label. */
  storedDigest: string | undefined;
  tickets: TicketPlan[];
  warnings: string[];
  /** Event mapping records exist but none carries a usable `labels.id`: fail closed, never create. */
  unusableEventMapping: boolean;
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
  const unusableEventMapping = event.id === undefined && (desired.mappings?.event?.length ?? 0) > 0;
  return { fliteEventId: event.id, storedListingId: event.storedListingId, storedDigest: event.storedDigest, tickets, warnings, unusableEventMapping };
}

/** A registration with every label field set. */
export function registration(
  desired: DesiredState,
  env: string,
  connectionId: string,
  fliteEventId: string,
  ticket?: { ticketUrn: string; fliteTicketId: string },
  digest?: string,
): Registration {
  const l = desired.labels;
  return {
    urn: ticket ? ticket.ticketUrn : desired.eventUrn,
    mappedUrn: mappedUrn(desired.companyId, connectionId, fliteEventId, ticket?.fliteTicketId),
    labels: {
      provider: l.provider,
      env,
      channelId: l.channelId,
      listingId: l.listingId,
      kind: ticket ? "ticket" : "event",
      id: ticket ? ticket.fliteTicketId : fliteEventId,
      eventId: fliteEventId,
      ...(digest !== undefined && !ticket ? { digest } : {}),
    },
  };
}

/** The digest to store after a fully successful sync: only when set and different from the stored one. */
export function digestToSave(desired: DesiredState, storedDigest: string | undefined): string | undefined {
  return desired.digest && desired.digest !== storedDigest ? desired.digest : undefined;
}

/**
 * Existing mapped resources whose stored `listingId` differs from the desired one (a relabel; never a
 * create). `digest`, when given, is stored on the event registration: the one relabel registration,
 * or one of its own when the listing is unchanged. There is never a second event registration.
 */
export function relabelRegistrations(
  desired: DesiredState,
  env: string,
  connectionId: string,
  plan: MappingPlan,
  digest?: string,
): Registration[] {
  if (plan.fliteEventId === undefined) return [];
  const out: Registration[] = [];
  if (plan.storedListingId !== desired.labels.listingId || digest !== undefined) {
    out.push(registration(desired, env, connectionId, plan.fliteEventId, undefined, digest));
  }
  for (const t of plan.tickets) {
    if (t.fliteTicketId !== undefined && t.storedListingId !== desired.labels.listingId) {
      out.push(registration(desired, env, connectionId, plan.fliteEventId, { ticketUrn: t.ticketUrn, fliteTicketId: t.fliteTicketId }));
    }
  }
  return out;
}
