import type { ActionDefinition } from "@w6w/types";
import { FliteClient, resourceId } from "../lib/client.ts";
import {
  availability as toAvailability,
  availabilityOptions,
  defined,
  integer,
  price,
  text,
  type TicketAvailability,
} from "../lib/fields.ts";

export interface TicketInput {
  eventId: string;
  ticketId: string;
  ticketName?: string;
  availability?: TicketAvailability;
  capacity?: number;
  ticketPrice?: number;
  description?: string;
  maxCart?: number;
}

/** The `update-ticket-properties` body. At least one property must be set. */
export function ticketProperties(input: TicketInput) {
  const properties = defined({
    ticketName: text(input.ticketName, "Ticket name", { max: 200 }),
    ticketPrice: price(input.ticketPrice, "Ticket price"),
    capacity: integer(input.capacity, "Capacity"),
    availability: toAvailability(input.availability),
    // An empty description is a deliberate clear, so it is kept.
    description: input.description === "" ? "" : text(input.description, "Description"),
    maxCart: integer(input.maxCart, "Max per cart", { min: 1 }),
  });
  if (!Object.keys(properties).length) throw new Error("Choose at least one ticket property to update");
  return {
    eventId: resourceId(input.eventId, "events"),
    ticketId: resourceId(input.ticketId, "tickets"),
    ...properties,
  };
}

export default {
  key: "update-ticket",
  title: "Update Ticket",
  type: "perform",
  resource: "ticket",
  idempotent: true,
  description:
    "Change a ticket's name, price (major USD units), total capacity including sold tickets, availability, description, or max per cart. Only the fields you set are sent.",
  params: [
    { key: "eventId", label: "Event ID or URN", type: "string", required: true },
    { key: "ticketId", label: "Ticket ID or URN", type: "string", required: true },
    { key: "ticketName", label: "Ticket name", type: "string" },
    { key: "availability", label: "Availability", type: "select", options: availabilityOptions },
    { key: "capacity", label: "Total capacity", type: "number", hint: "Cannot be lower than the number sold." },
    { key: "ticketPrice", label: "Price (USD)", type: "number" },
    { key: "description", label: "Description", type: "text", advanced: true },
    { key: "maxCart", label: "Max per cart", type: "number", advanced: true },
  ],
  output: [{ key: "result", label: "Updated ticket", type: "object" }],
  async execute(input, ctx) {
    return { result: await new FliteClient(ctx).updateTicket(ticketProperties(input)) };
  },
} satisfies ActionDefinition<TicketInput>;
