import type { ActionDefinition } from "@w6w/types";
import type { FliteTicket } from "@cohost/flite-types";
import { type SourceContext, sourceParams } from "../lib/context.ts";
import { type AnyFliteEvent, fliteEventToCohost } from "../convert/event.ts";
import { fliteTicketToCohost } from "../convert/ticket.ts";
import { type AnyFliteOrder, fliteOrderToCohost } from "../convert/order.ts";
import type { CohostEvent, CohostOrder, CohostTicket } from "../convert/cohost-types.ts";
import { record } from "../convert/support.ts";

export type FliteToCohostInput = SourceContext & {
  resource: "event" | "ticket" | "order";
  data: unknown;
  eventId?: string;
  currency?: string;
};

export interface FliteToCohostOutput {
  data: CohostEvent | CohostTicket | CohostOrder;
  /** Ticket types of an event fetched with its tickets. */
  tickets?: CohostTicket[];
}

export function fliteToCohost(input: FliteToCohostInput): FliteToCohostOutput {
  const options = { eventId: input.eventId, currency: input.currency };
  switch (input.resource) {
    case "event": {
      const event = record<AnyFliteEvent>(input.data, "Flite data");
      const data = fliteEventToCohost(input, event, options);
      if (!("tickets" in event)) return { data };
      const tickets = event.tickets.map((ticket, sorting) =>
        fliteTicketToCohost(input, ticket, { ...options, eventId: event._id, sorting })
      );
      return { data, tickets };
    }
    case "ticket":
      return { data: fliteTicketToCohost(input, record<FliteTicket>(input.data, "Flite data"), options) };
    case "order":
      return { data: fliteOrderToCohost(input, record<AnyFliteOrder>(input.data, "Flite data"), options) };
    default:
      throw new Error("resource must be event, ticket or order");
  }
}

export default {
  key: "flite-to-cohost",
  title: "Flite → Cohost",
  type: "read",
  resource: "transform",
  idempotent: true,
  requiresAuth: false,
  description:
    "Convert a Flite event, ticket type or order, as the Flite app returns it, into the Cohost record with source URNs. No API calls.",
  params: [
    {
      key: "resource",
      label: "Resource",
      type: "select",
      required: true,
      options: [
        { label: "Event", value: "event" },
        { label: "Ticket", value: "ticket" },
        { label: "Order", value: "order" },
      ],
    },
    { key: "data", label: "Flite data", type: "json", required: true },
    ...sourceParams,
    {
      key: "eventId",
      label: "Flite event ID",
      type: "string",
      hint: "Needed for orders from the order list, which carry no event ID.",
    },
    { key: "currency", label: "Organization currency", type: "string", hint: "Events and tickets carry none. Defaults to USD." },
    { key: "organizerId", label: "Cohost organizer ID", type: "string" },
  ],
  output: [
    { key: "data", label: "Cohost record", type: "object" },
    { key: "tickets", label: "Cohost tickets", type: "array" },
  ],
  execute(input) {
    return fliteToCohost(input);
  },
} satisfies ActionDefinition<FliteToCohostInput>;
