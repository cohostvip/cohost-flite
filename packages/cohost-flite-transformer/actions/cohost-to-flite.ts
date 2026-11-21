import type { ActionDefinition } from "@w6w/types";
import { cohostToFlite, type TransformInput } from "../lib/cohost-to-flite.ts";

export default {
  key: "cohost-to-flite",
  title: "Cohost → Flite",
  type: "read",
  resource: "transform",
  idempotent: true,
  requiresAuth: false,
  description:
    "Convert Cohost event status or ticket status, capacity and price into Flite app action inputs. Supply the mapped Flite target IDs. No API calls.",
  params: [
    {
      key: "resource",
      label: "Resource",
      type: "select",
      required: true,
      options: [{ label: "Event", value: "event" }, { label: "Ticket", value: "ticket" }],
    },
    { key: "data", label: "Cohost data", type: "json", required: true },
    { key: "eventId", label: "Mapped Flite event ID or URN", type: "string", required: true },
    {
      key: "ticketId",
      label: "Mapped Flite ticket ID or URN",
      type: "string",
      hint: "Required for tickets. Do not use the Cohost object's own ID.",
    },
  ],
  output: [
    { key: "actionKey", label: "Flite action key", type: "string" },
    { key: "params", label: "Flite action inputs", type: "object" },
  ],
  execute(input) {
    return cohostToFlite(input);
  },
} satisfies ActionDefinition<TransformInput>;
