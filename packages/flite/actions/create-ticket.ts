import type { ActionDefinition } from "@w6w/types";
import { FliteClient, resourceId } from "../lib/client.ts";
import { availability, availabilityOptions, defined, integer, price, text, type TicketAvailability } from "../lib/fields.ts";

export interface CreateTicketInput {
  eventId: string;
  ticketName: string;
  ticketPrice: number;
  capacity?: number;
  availability?: TicketAvailability;
  description?: string;
  ebTicketId?: string;
}

export function newTicket(input: CreateTicketInput) {
  return {
    eventId: resourceId(input.eventId, "events"),
    ticketName: text(input.ticketName, "Ticket name", { required: true, max: 200 }),
    ticketPrice: price(input.ticketPrice, "Ticket price", true),
    ...defined({
      capacity: integer(input.capacity, "Capacity"),
      availability: availability(input.availability),
      description: text(input.description, "Description"),
      ebTicketId: text(input.ebTicketId, "External ticket ID", { max: 200 }),
    }),
  };
}

export default {
  key: "create-ticket",
  title: "Create Ticket",
  type: "perform",
  resource: "ticket",
  idempotent: false,
  description:
    "Add a ticket type to an event. Price is in major USD units. Flite defaults capacity to 2000 and availability to Available.",
  params: [
    { key: "eventId", label: "Event ID or URN", type: "string", required: true },
    { key: "ticketName", label: "Ticket name", type: "string", required: true },
    { key: "ticketPrice", label: "Price (USD)", type: "number", required: true },
    { key: "capacity", label: "Capacity", type: "number" },
    { key: "availability", label: "Availability", type: "select", options: availabilityOptions },
    { key: "description", label: "Description", type: "text", advanced: true },
    { key: "ebTicketId", label: "External box office ticket ID", type: "string", advanced: true },
  ],
  output: [
    { key: "ticket", label: "Created ticket", type: "object" },
    { key: "ticketId", label: "Ticket ID", type: "string" },
  ],
  async execute(input, ctx) {
    const ticket = await new FliteClient(ctx).createTicket(newTicket(input));
    return { ticket, ticketId: ticket._id };
  },
} satisfies ActionDefinition<CreateTicketInput>;
