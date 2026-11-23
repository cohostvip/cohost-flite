import type { FliteTicket, FliteTicketAvailability } from "@cohost/flite-types";
import type { CohostOfferingStatus, CohostTicket } from "./cohost-types.ts";
import { resourceContext, type SourceContext } from "../lib/context.ts";
import {
  amount,
  APP_SOURCE,
  clipText,
  cohostCurrency,
  FLITE_TEXT_MAX,
  fliteMeta,
  idFrom,
  parseAmount,
  toMajor,
  toMinor,
  toPlainText,
} from "./support.ts";

export interface FliteTicketOptions {
  /** Defaults to the ticket's own `eventId`. */
  eventId?: string;
  /** Organization currency; tickets carry none. Defaults to USD. */
  currency?: string;
  /** Position in the event's ticket list. */
  sorting?: number;
}

function ticketStatus(ticket: FliteTicket): CohostOfferingStatus {
  switch (ticket.availability) {
    case "true":
      return ticket.capacity > 0 && ticket.sold >= ticket.capacity ? "sold-out" : "live";
    case "hide":
      return "hidden";
    case "soon":
      return "draft";
    default:
      return "unavailable";
  }
}

/** Flite ticket type → Cohost ticket (an admission offering). */
export function fliteTicketToCohost(
  source: SourceContext,
  ticket: FliteTicket,
  options: FliteTicketOptions = {},
): CohostTicket {
  const eventId = options.eventId ?? ticket.eventId;
  if (!eventId) throw new Error("eventId is required: not found on ticket and not provided");
  const urn = resourceContext(source).generateResourceUri(`/events/${eventId}/tickets/${ticket._id}`);
  const currency = cohostCurrency(options.currency);
  const price = amount(currency, toMinor(ticket.ticketPrice, "ticketPrice"));
  const zero = amount(currency, 0);

  return {
    id: urn,
    urn,
    refId: ticket._id,
    source: APP_SOURCE,
    name: ticket.ticketName,
    type: "admission",
    category: "admission",
    description: ticket.description || null,
    instructions: null,
    capacity: ticket.capacity,
    quantitySold: ticket.sold,
    status: ticketStatus(ticket),
    priceCategory: ticket.ticketPrice > 0 ? "paid" : "free",
    sorting: options.sorting ?? 0,
    step: 1,
    minimumQuantity: 1,
    maximumQuantity: ticket.maxCart,
    // Flite stores one price; fees are set per order (`totalCustomFee`).
    costs: { cost: price, delivery: zero, fee: zero, tax: zero, gross: price, total: price },
    transferable: false,
    meta: {
      flite: {
        originalId: ticket._id,
        eventId,
        availability: ticket.availability,
        ...(ticket.ebTicketId ? { ebTicketId: ticket.ebTicketId } : {}),
      },
    },
  };
}

/**
 * The Flite ticket properties a Cohost ticket describes, in the form `create-new-ticket` and
 * `update-ticket-properties` accept. IDs are set when the ticket came from Flite.
 */
export interface FliteTicketProperties {
  eventId?: string;
  ticketId?: string;
  ticketName: string;
  ticketPrice: number;
  capacity: number;
  availability: FliteTicketAvailability;
  description: string;
  maxCart: number;
  ebTicketId?: string;
}

const AVAILABILITY: Record<CohostOfferingStatus, FliteTicketAvailability> = {
  live: "true",
  "sold-out": "true", // Flite derives sold-out from sold >= capacity.
  hidden: "hide",
  draft: "soon",
  unavailable: "false",
  archived: "false",
  deleted: "false",
};

/** Cohost ticket → Flite ticket properties. */
export function cohostTicketToFlite(ticket: CohostTicket): FliteTicketProperties {
  if (ticket.priceCategory === "donation") {
    throw new Error("Flite fixed-price tickets cannot represent donation pricing");
  }
  const availability = AVAILABILITY[ticket.status];
  if (!availability) throw new Error(`Unsupported Cohost ticket status: ${ticket.status}`);
  const meta = fliteMeta(ticket.meta);
  const price = ticket.priceCategory === "free" ? 0 : toMajor(parseAmount(ticket.costs.cost, "costs.cost").minor);
  const ticketId = typeof meta.originalId === "string" ? meta.originalId : idFrom(ticket.refId ?? ticket.urn, "tickets");
  const eventId = typeof meta.eventId === "string" ? meta.eventId : idFrom(ticket.urn, "events");
  // A ticket hidden in Flite and later sold out stays hidden there.
  const keep = ticket.status === "sold-out" && typeof meta.availability === "string"
    ? meta.availability as FliteTicketAvailability
    : availability;

  return {
    ...(eventId ? { eventId } : {}),
    ...(ticketId ? { ticketId } : {}),
    ticketName: ticket.name,
    ticketPrice: price,
    capacity: ticket.capacity,
    availability: keep,
    description: clipText(toPlainText(ticket.description ?? ""), FLITE_TEXT_MAX),
    maxCart: ticket.maximumQuantity,
    ...(typeof meta.ebTicketId === "string" ? { ebTicketId: meta.ebTicketId } : {}),
  };
}
