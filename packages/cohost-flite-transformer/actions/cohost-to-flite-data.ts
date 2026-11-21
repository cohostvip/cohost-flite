import type { ActionDefinition } from "@w6w/types";
import type { FliteOrder } from "@cohost/flite-types";
import { cohostEventToFlite, type FliteEventProperties } from "../convert/event.ts";
import { cohostTicketToFlite, type FliteTicketProperties } from "../convert/ticket.ts";
import { cohostOrderToFlite } from "../convert/order.ts";
import type { CohostEvent, CohostOrder, CohostTicket } from "../convert/cohost-types.ts";
import { record } from "../convert/support.ts";

export interface CohostToFliteDataInput {
  resource: "event" | "ticket" | "order";
  data: unknown;
}

export function cohostToFliteData(input: CohostToFliteDataInput): {
  data: FliteEventProperties | FliteTicketProperties | FliteOrder;
} {
  switch (input.resource) {
    case "event":
      return { data: cohostEventToFlite(record<CohostEvent>(input.data, "Cohost data")) };
    case "ticket":
      return { data: cohostTicketToFlite(record<CohostTicket>(input.data, "Cohost data")) };
    case "order":
      return { data: cohostOrderToFlite(record<CohostOrder>(input.data, "Cohost data")) };
    default:
      throw new Error("resource must be event, ticket or order");
  }
}

export default {
  key: "cohost-to-flite-data",
  title: "Cohost → Flite Data",
  type: "read",
  resource: "transform",
  idempotent: true,
  requiresAuth: false,
  description:
    "Convert a Cohost event, ticket or order into Flite's own fields: event and ticket properties as Flite's create and update endpoints take them, and orders as Flite's order record (Flite cannot create orders). No API calls.",
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
    { key: "data", label: "Cohost data", type: "json", required: true },
  ],
  output: [{ key: "data", label: "Flite data", type: "object" }],
  execute(input) {
    return cohostToFliteData(input);
  },
} satisfies ActionDefinition<CohostToFliteDataInput>;
