import type { FliteEventWithTickets } from "@cohost/flite-types";
import { resourceContext, type SourceContext } from "../lib/context.ts";
import { amount, cohostCurrency, toMinor } from "./support.ts";

/** A compact view of a Flite event and its ticket types, for sync decisions and mapping UIs. */
export function fliteEventSnapshot(source: SourceContext, event: FliteEventWithTickets, currency?: string) {
  const agent = resourceContext(source);
  const code = cohostCurrency(currency);
  return {
    id: event._id,
    name: event.eventName,
    urn: agent.generateResourceUri(`/events/${event._id}`),
    enabled: !event.isEventEnd && event.status === "Approved",
    currency: code,
    tickets: (event.tickets ?? []).map((ticket) => ({
      id: ticket._id,
      name: ticket.ticketName,
      urn: agent.generateResourceUri(`/events/${event._id}/tickets/${ticket._id}`),
      enabled: ticket.availability === "true",
      price: amount(code, toMinor(ticket.ticketPrice, "ticketPrice")),
      capacity: ticket.capacity,
      sold: ticket.sold,
    })),
  };
}
