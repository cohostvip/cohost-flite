import type { ActionDefinition } from "@w6w/types";
import { FliteClient } from "../lib/client.ts";

export default {
  key: "get-ticket",
  title: "Get Ticket",
  type: "read",
  resource: "ticket",
  idempotent: true,
  description: "Fetch one ticket type with its price, capacity, sold count, availability and max per cart.",
  params: [
    { key: "eventId", label: "Event ID or URN", type: "string", required: true },
    { key: "ticketId", label: "Ticket ID or URN", type: "string", required: true },
  ],
  output: [{ key: "ticket", label: "Ticket", type: "object" }],
  async execute({ eventId, ticketId }, ctx) {
    return { ticket: await new FliteClient(ctx).getTicket(eventId, ticketId) };
  },
} satisfies ActionDefinition<{ eventId: string; ticketId: string }>;
