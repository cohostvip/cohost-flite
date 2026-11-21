import type { ActionDefinition } from "@w6w/types";
import { FliteClient } from "../lib/client.ts";

export default {
  key: "get-event",
  title: "Get Event",
  type: "read",
  resource: "event",
  idempotent: true,
  description:
    "Fetch a Flite event with all its ticket types, or the event alone. A deleted event is returned with status Deleted.",
  params: [
    { key: "eventId", label: "Event ID or URN", type: "string", required: true },
    { key: "includeTickets", label: "Include tickets", type: "boolean", default: true },
  ],
  output: [{ key: "event", label: "Event", type: "object" }],
  async execute({ eventId, includeTickets }, ctx) {
    const client = new FliteClient(ctx);
    return { event: includeTickets === false ? await client.getEventById(eventId) : await client.getEvent(eventId) };
  },
} satisfies ActionDefinition<{ eventId: string; includeTickets?: boolean }>;
