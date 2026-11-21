import type { ActionDefinition } from "@w6w/types";
import { FliteClient } from "../lib/client.ts";

export default {
  key: "delete-event",
  title: "Delete Event",
  type: "perform",
  resource: "event",
  idempotent: false,
  description:
    "Delete an event (Flite marks it Deleted). Flite refuses events that have held or completed orders; to stop sales instead, use Control Event.",
  params: [{ key: "eventId", label: "Event ID or URN", type: "string", required: true }],
  output: [
    { key: "event", label: "Deleted event", type: "object" },
    { key: "status", label: "Status", type: "string" },
  ],
  async execute({ eventId }, ctx) {
    const event = await new FliteClient(ctx).deleteEvent(eventId);
    return { event, status: event.status };
  },
} satisfies ActionDefinition<{ eventId: string }>;
