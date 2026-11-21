/** Pure builder: T2 channel snapshot -> desired Flite state. */

import { cohostEventToFlite } from "../convert/event.ts";
import { cohostTicketToFlite } from "../convert/ticket.ts";
import type { CohostEvent, CohostTicket } from "../convert/cohost-types.ts";
import { htmlToText, parseAmount, summarize } from "../convert/support.ts";

export type SyncMode = "publish" | "hold" | "stop" | "noop";
export type FliteEnv = "sandbox" | "production";

/** One RMS `find-mapped-resources` result item. */
export interface MappingRecord {
  urn?: string;
  mappedUrn?: string;
  labels?: Record<string, string>;
  [key: string]: unknown;
}

/** Output of `vip.cohost.w6w` `get-channel-event-snapshot` (plan.md §Pinned interface). */
export interface ChannelSnapshot {
  channelId: string;
  eventId: string;
  companyId: string;
  eventUrn: string;
  listing: Record<string, unknown> | null;
  visibility: string | null;
  shown: boolean;
  channelEvent: Record<string, unknown> | null;
  channelTickets: Array<Record<string, unknown>>;
  event: Record<string, unknown>;
  tickets: Array<Record<string, unknown>>;
  mappings: { event: MappingRecord[]; tickets: Record<string, MappingRecord[]> };
}

export interface DesiredLabels {
  provider: string;
  env: string;
  org: string;
  channelId: string;
  listingId: string;
}

export interface DesiredTicket {
  ticketId: string;
  ticketUrn: string;
  /** Flite create/update body fields (name, price, capacity, availability…). */
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
  labels: DesiredLabels;
  /** Flite create-event fields, or null when the event cannot be converted. */
  event: Record<string, string> | null;
  tickets: DesiredTicket[];
  mappings: ChannelSnapshot["mappings"];
  errors: Array<{ message: string; ticketId?: string }>;
}

export interface BuildOptions {
  env: string;
  org: string;
  currency?: string;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function decideMode(snapshot: ChannelSnapshot): SyncMode {
  const status = snapshot.event?.status;
  let mode: SyncMode = "stop";
  if (status === "live" && snapshot.shown) mode = "publish";
  else if (status === "started" && snapshot.listing != null && snapshot.visibility === "visible") mode = "hold";
  if (mode !== "publish" && !(snapshot.mappings?.event?.length)) return "noop";
  return mode;
}

/** The channel's description block, else owner description, else summary, else name. */
function describe(snapshot: ChannelSnapshot, name: string): string {
  const blocks = snapshot.channelEvent?.contentBlocks;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      const b = rec(block);
      if (b.designation !== "description") continue;
      const html = rec(rec(b.data).content).html;
      const text = typeof html === "string" ? htmlToText(html) : "";
      if (text) return text;
    }
  }
  const owner = snapshot.event;
  return str(rec(owner.description).text) || str(owner.summary) || name;
}

function buildEvent(snapshot: ChannelSnapshot): Record<string, string> {
  const owner = rec(snapshot.event);
  const location = rec(owner.location);
  const address = rec(location.address);
  const tz = str(owner.tz) || str(location.timezone);
  if (!tz) throw new Error("event has no time zone");
  if (!str(address.region)) throw new Error("event venue has no state");
  if (!str(address.postal_code)) throw new Error("event venue has no ZIP code");
  const name = str(snapshot.channelEvent?.name) || str(owner.name);
  const cohost = {
    id: snapshot.eventId,
    companyId: snapshot.companyId,
    organizerId: null,
    name,
    summary: summarize(describe(snapshot, name)) || name,
    description: { text: describe(snapshot, name) },
    tz,
    start: str(owner.start),
    end: str(owner.end),
    isSeries: false,
    status: "live",
    public: true,
    flyer: null,
    currency: "USD",
    location: { ...location, address },
    created: "",
    changed: "",
  } as unknown as CohostEvent;
  const { eventId: _eventId, rsvpCapacity: _rsvp, ebEventId: _eb, ...fields } = cohostEventToFlite(cohost);
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)]));
}

function remaining(owner: Rec | undefined): number | undefined {
  const capacity = num(owner?.capacity);
  if (capacity === undefined) return undefined;
  return Math.max(0, capacity - (num(owner?.quantitySold) ?? 0));
}

export function buildDesiredState(snapshot: ChannelSnapshot, options: BuildOptions): DesiredState {
  const mode = decideMode(snapshot);
  const errors: Array<{ message: string; ticketId?: string }> = [];
  const eventUrn = snapshot.eventUrn;
  const labels: DesiredLabels = {
    provider: "flite",
    env: options.env,
    org: options.org,
    channelId: snapshot.channelId,
    listingId: str(snapshot.listing?.id),
  };
  const ownerById = new Map<string, Rec>();
  for (const t of snapshot.tickets ?? []) ownerById.set(str(t.id), rec(t));
  const salesOn = snapshot.channelEvent?.salesEnabled !== false;
  const tickets: DesiredTicket[] = [];
  let event: Record<string, string> | null = null;

  if (mode === "publish") {
    try {
      event = buildEvent(snapshot);
    } catch (error) {
      errors.push({ message: `event: ${error instanceof Error ? error.message : String(error)}` });
    }
    const currency = (options.currency || "USD").toUpperCase();
    for (const ct of snapshot.channelTickets ?? []) {
      const id = str(ct.id);
      try {
        if (ct.priceCategory !== "free" && ct.priceCategory !== "donation") {
          const got = parseAmount(rec(ct.costs).cost, "costs.cost").currency;
          if (got !== currency) throw new Error(`currency ${got} is not ${currency}`);
        }
        const props = cohostTicketToFlite({
          ...ct,
          id,
          refId: undefined,
          urn: undefined,
          meta: undefined,
          capacity: 0,
          quantitySold: 0,
          status: "live",
        } as unknown as CohostTicket);
        const owner = ownerById.get(id);
        const left = remaining(owner);
        const live = ct.status === "live" && owner?.status !== "sold-out";
        const open = salesOn && live && left !== 0;
        tickets.push({
          ticketId: id,
          ticketUrn: `${eventUrn}/tickets/${id}`,
          fields: { ticketName: props.ticketName, ticketPrice: props.ticketPrice, description: props.description },
          availability: open ? "true" : "false",
          ...(left !== undefined ? { capacity: left } : {}),
        });
      } catch (error) {
        errors.push({ message: `ticket ${id}: ${error instanceof Error ? error.message : String(error)}`, ticketId: String(id) });
      }
    }
  } else if (mode === "hold") {
    for (const [id, owner] of ownerById) {
      if (!snapshot.mappings?.tickets?.[id]?.length) continue;
      const left = remaining(owner);
      tickets.push({
        ticketId: id,
        ticketUrn: `${eventUrn}/tickets/${id}`,
        fields: {},
        availability: owner.status === "live" && left !== 0 ? "true" : "false",
        ...(left !== undefined ? { capacity: left } : {}),
      });
    }
  }

  return {
    mode,
    companyId: snapshot.companyId,
    channelId: snapshot.channelId,
    listingId: labels.listingId,
    eventId: snapshot.eventId,
    eventUrn,
    labels,
    event,
    tickets,
    mappings: snapshot.mappings ?? { event: [], tickets: {} },
    errors,
  };
}
