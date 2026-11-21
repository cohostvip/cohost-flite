import type { ActionDefinition } from "@w6w/types";
import type { FliteEventWithTickets } from "@cohost/flite-types";
import { resourceContext, type SourceContext, sourceParams } from "../lib/context.ts";

export default {
  key: "list-mapping-objects",
  title: "List Ticket Mapping Objects",
  type: "read",
  resource: "ticket",
  idempotent: true,
  requiresAuth: false,
  description: "List ticket types and their source URNs for Cohost mapping.",
  params: [
    { key: "event", label: "Flite event with tickets", type: "json", required: true },
    ...sourceParams,
  ],
  output: [{ key: "objects", label: "Mapping objects", type: "array" }],
  execute(input) {
    const source = resourceContext(input);
    const event = input.event;
    return {
      objects: (event.tickets ?? []).map((ticket) => ({
        id: ticket._id,
        name: ticket.ticketName,
        urn: source.generateResourceUri(`/events/${event._id}/tickets/${ticket._id}`),
      })),
    };
  },
} satisfies ActionDefinition<SourceContext & { event: FliteEventWithTickets }>;
