import type { FliteEvent, FliteEventSummary, FliteEventWithTickets } from "@cohost/flite-types";
import type { CohostEvent, CohostEventStatus } from "./cohost-types.ts";
import { resourceContext, type SourceContext } from "../lib/context.ts";
import {
  API_VERSION,
  APP_SOURCE,
  cohostCurrency,
  fitHtml,
  FLITE_TEXT_MAX,
  fliteMeta,
  idFrom,
  stateCode,
  stateName,
  summarize,
  toHtml,
  toPlainText,
  utcToZoned,
  zonedToUtc,
} from "./support.ts";

/** Any event shape Flite returns: list item, detail, or detail with ticket types. */
export type AnyFliteEvent = FliteEvent | FliteEventSummary | FliteEventWithTickets;

export interface FliteEventOptions {
  /** Organization currency (`FliteOrganization.currency`); events carry none. Defaults to USD. */
  currency?: string;
}

function eventStatus(event: AnyFliteEvent): CohostEventStatus {
  if (event.isEventEnd) return "ended";
  // A soft-deleted event still reads back, with status "Deleted".
  if (event.status === "Deleted") return "archived";
  if (event.status === "Approved") return "live";
  if (event.status === "Pending") return "queued";
  return "draft";
}

/** Flite event → Cohost event. Ticket types, if present, convert separately with `fliteTicketToCohost`. */
export function fliteEventToCohost(
  source: SourceContext,
  event: AnyFliteEvent,
  options: FliteEventOptions = {},
): CohostEvent {
  const urn = resourceContext(source).generateResourceUri(`/events/${event._id}`);
  const start = zonedToUtc(event.startDate, event.startTime, event.timeZoneId);
  let end = zonedToUtc(event.endDate, event.endTime, event.timeZoneId);
  // Defensive: an overnight event saved with the start date as its end date.
  if (Date.parse(end) <= Date.parse(start)) end = new Date(Date.parse(end) + 86_400_000).toISOString();
  const text = toPlainText(event.description ?? "");
  const showEvent = "showEvent" in event ? event.showEvent : undefined;
  const tickets = "tickets" in event ? event.tickets : undefined;
  const address = [event.venueLocation, event.city, [event.state && stateCode(event.state), event.zipCode].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ");

  return {
    id: urn,
    urn,
    refId: event._id,
    source: APP_SOURCE,
    appId: APP_SOURCE,
    companyId: source.companyId,
    organizerId: source.organizerId ?? null,
    name: event.eventName,
    summary: summarize(text) || event.eventName,
    description: { text, blocks: null },
    tz: event.timeZoneId,
    start,
    end,
    isSeries: false,
    status: eventStatus(event),
    public: event.status === "Approved" && showEvent !== false,
    flyer: event.hostFlyer?.[0] ? { url: event.hostFlyer[0] } : null,
    currency: cohostCurrency(options.currency),
    locale: "en-US",
    location: {
      venueId: null,
      placeId: null,
      name: event.venueName,
      geometry: null,
      address: {
        address_1: event.venueLocation,
        city: event.city ?? "",
        region: event.state ? stateCode(event.state) : "",
        postal_code: event.zipCode ?? "",
        country: "US",
        formattedAddress: address,
      },
      timezone: event.timeZoneId,
    },
    ...(tickets ? { capacity: tickets.reduce((sum, t) => sum + t.capacity, 0) } : {}),
    slug: event.slug,
    tags: [],
    created: event.created,
    changed: event.created,
    version: API_VERSION,
    meta: {
      flite: {
        originalId: event._id,
        eventCode: event.eventCode,
        status: event.status,
        organizationId: event.organizationId,
        userId: event.userId,
        visits: event.visits,
        ...("rsvpCapacity" in event ? { rsvpCapacity: event.rsvpCapacity } : {}),
        ...(event.ebEventId ? { ebEventId: event.ebEventId } : {}),
        description: event.description,
        // Flite's local schedule as written, so an unchanged event writes back exactly (some
        // captured times fall in a DST gap and have no exact UTC equivalent).
        schedule: { start, end, startDate: event.startDate, startTime: event.startTime, endDate: event.endDate, endTime: event.endTime },
      },
    },
  };
}

/**
 * The Flite event properties a Cohost event describes, in the form `create-event-partner` and
 * `update-event-properties` accept. `eventId` is set when the event came from Flite.
 */
export interface FliteEventProperties {
  eventId?: string;
  eventName: string;
  description: string;
  venueName: string;
  venueLocation: string;
  city: string;
  state: string;
  zipCode: string;
  showEvent: "true" | "false";
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  rsvpCapacity?: number;
  ebEventId?: string;
}

/** Cohost event → Flite event properties. Times are written in the event's own time zone. */
export function cohostEventToFlite(event: CohostEvent): FliteEventProperties {
  if (!event.tz) throw new Error("Cohost event tz is required");
  const flite = fliteMeta(event.meta);
  const schedule = (flite.schedule ?? {}) as Record<string, string>;
  const start = schedule.start === event.start
    ? { date: schedule.startDate, time: schedule.startTime }
    : utcToZoned(event.start, event.tz);
  const end = schedule.end === event.end
    ? { date: schedule.endDate, time: schedule.endTime }
    : utcToZoned(event.end, event.tz);
  const address = event.location?.address;
  // Flite renders the event description as HTML; its own HTML is kept while the text is unchanged.
  const source = [event.description?.html, event.description?.text, event.summary].find((v) => typeof v === "string" && v.trim());
  const html = fitHtml([toHtml(source ?? "")], FLITE_TEXT_MAX);
  const original = typeof flite.description === "string" ? flite.description : undefined;
  const description = original !== undefined && toPlainText(original) === toPlainText(html) ? original : html;
  const eventId = typeof flite.originalId === "string" ? flite.originalId : idFrom(event.refId ?? event.urn, "events");

  return {
    ...(eventId ? { eventId } : {}),
    eventName: event.name,
    description,
    venueName: event.location?.name ?? "",
    venueLocation: address?.address_1 ?? "",
    city: address?.city ?? "",
    state: address?.region ? stateName(address.region) : "",
    zipCode: address?.postal_code ?? "",
    showEvent: event.public ? "true" : "false",
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    ...(typeof flite.rsvpCapacity === "number" ? { rsvpCapacity: flite.rsvpCapacity } : {}),
    ...(typeof flite.ebEventId === "string" ? { ebEventId: flite.ebEventId } : {}),
  };
}
