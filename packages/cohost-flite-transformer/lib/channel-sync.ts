/** Pure builder: T2 channel snapshot -> desired Flite state. */

import { cohostEventToFlite } from "../convert/event.ts";
import { cohostTicketToFlite } from "../convert/ticket.ts";
import type { CohostEvent, CohostTicket } from "../convert/cohost-types.ts";
import { escapeHtml, FLITE_TEXT_MAX, fitHtml, parseAmount, summarize, textToHtml, toHtml, toPlainText } from "../convert/support.ts";

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

/** Mapping labels. The Flite environment and account are not labels: the connection id in every mapped URN scopes them. */
export interface DesiredLabels {
  provider: string;
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
  /**
   * The flyer image to upload as Flite's `hostFlyer`: the channel's own flyer, else the owner
   * event's. https only; null when there is none.
   */
  flyerUrl: string | null;
  tickets: DesiredTicket[];
  mappings: ChannelSnapshot["mappings"];
  errors: Array<{ message: string; ticketId?: string }>;
}

export interface BuildOptions {
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

/** A multipart text (`{ html, text, md }`) as event-description HTML: html first, then text, then md. */
function multipartHtml(value: unknown): string {
  const content = rec(value);
  for (const key of ["html", "text", "md"]) {
    const html = typeof content[key] === "string" ? toHtml(content[key] as string) : "";
    if (toPlainText(html)) return html;
  }
  return typeof value === "string" ? toHtml(value) : "";
}

/** Plain text on one line, HTML-escaped. */
const inline = (text: string) => escapeHtml(text.replace(/\s+/g, " "));

/** One content block as HTML: a rich-text block's content, or an FAQ's questions and answers. */
function blockHtml(block: Rec): string {
  const data = rec(block.data);
  if (Array.isArray(data.items)) {
    return data.items.map(rec)
      .sort((a, b) => (num(a.order) ?? 0) - (num(b.order) ?? 0))
      .map((item) => {
        const question = toPlainText(str(item.question));
        return (question ? `<p><strong>${inline(question)}</strong></p>` : "") + toHtml(str(item.answer));
      })
      .join("");
  }
  return data.content === undefined ? "" : multipartHtml(data.content);
}

/**
 * The Flite event description, as HTML: every live content block of the channel (else of the owner
 * event) in order, the `description` block first and untitled, each other one under an `<h3>` title;
 * blocks that would pass Flite's 5000 characters are left out. Without block content: the owner
 * description, else summary, else name.
 */
function describe(snapshot: ChannelSnapshot, name: string): string {
  const channelBlocks = snapshot.channelEvent?.contentBlocks;
  const blocks = Array.isArray(channelBlocks) && channelBlocks.length ? channelBlocks : snapshot.event?.contentBlocks;
  const parts: Array<{ first: boolean; order: number; html: string }> = [];
  for (const block of Array.isArray(blocks) ? blocks.map(rec) : []) {
    if (block.status !== undefined && block.status !== "live") continue;
    const html = blockHtml(block);
    if (!toPlainText(html)) continue;
    const first = block.designation === "description";
    const title = first ? "" : toPlainText(str(block.title) || str(rec(block.data).title));
    parts.push({ first, order: num(block.order) ?? 0, html: (title ? `<h3>${inline(title)}</h3>` : "") + html });
  }
  parts.sort((a, b) => Number(b.first) - Number(a.first) || a.order - b.order);
  const html = fitHtml(parts.map((part) => part.html), FLITE_TEXT_MAX);
  if (html) return html;
  const owner = snapshot.event;
  return multipartHtml(owner.description) || textToHtml(toPlainText(str(owner.summary)) || name);
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
  const html = describe(snapshot, name);
  const text = toPlainText(html);
  const cohost = {
    id: snapshot.eventId,
    companyId: snapshot.companyId,
    organizerId: null,
    name,
    summary: summarize(text) || name,
    description: { html, text },
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

/** The channel flyer, else the owner event's; only an https URL. */
function flyerUrl(snapshot: ChannelSnapshot): string | null {
  for (const source of [snapshot.channelEvent, snapshot.event]) {
    const url = str(rec(rec(source).flyer).url);
    if (url.startsWith("https://")) return url;
  }
  return null;
}

function remaining(owner: Rec | undefined): number | undefined {
  const capacity = num(owner?.capacity);
  if (capacity === undefined) return undefined;
  return Math.max(0, capacity - (num(owner?.quantitySold) ?? 0));
}

export function buildDesiredState(snapshot: ChannelSnapshot, _options: BuildOptions = {}): DesiredState {
  const mode = decideMode(snapshot);
  const errors: Array<{ message: string; ticketId?: string }> = [];
  const eventUrn = snapshot.eventUrn;
  const labels: DesiredLabels = {
    provider: "flite",
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
    for (const ct of snapshot.channelTickets ?? []) {
      const id = str(ct.id);
      try {
        const cost = rec(ct.costs).cost;
        if (cost !== undefined && cost !== null && cost !== "") {
          const got = parseAmount(cost, "costs.cost").currency;
          if (got !== "USD") throw new Error(`currency ${got} is not USD`);
        }
        // explicit picks: never spread the channel ticket (maximumQuantity must not be read)
        const { name, description, priceCategory, costs } = ct as Record<string, unknown>;
        const props = cohostTicketToFlite({
          id,
          name,
          description,
          priceCategory,
          costs,
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
    flyerUrl: flyerUrl(snapshot),
    tickets,
    mappings: snapshot.mappings ?? { event: [], tickets: {} },
    errors,
  };
}
