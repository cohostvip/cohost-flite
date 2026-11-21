import type { ActionDefinition } from "@w6w/types";
import { FliteClient } from "../lib/client.ts";

export default {
  key: "delete-ticket",
  title: "Delete Ticket",
  type: "perform",
  resource: "ticket",
  idempotent: false,
  description:
    "Delete a ticket type and remove it from the event's coupons. To stop selling it but keep it, use Update Ticket.",
  params: [
    { key: "eventId", label: "Event ID or URN", type: "string", required: true },
    { key: "ticketId", label: "Ticket ID or URN", type: "string", required: true },
  ],
  output: [{ key: "ticket", label: "Deleted ticket", type: "object" }],
  async execute({ eventId, ticketId }, ctx) {
    return { ticket: await new FliteClient(ctx).deleteTicket(eventId, ticketId) };
  },
} satisfies ActionDefinition<{ eventId: string; ticketId: string }>;
