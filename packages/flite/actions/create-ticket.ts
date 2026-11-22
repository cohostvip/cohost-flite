import type { FliteCreatedTicket } from "@cohost/flite-types";
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
  /** Not part of Flite's create, which ignores it: set by a follow-up update. */
  maxCart?: number;
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

/** The max per cart to set after the create, validated before anything is sent. */
export function maxPerCart(input: CreateTicketInput): number | undefined {
  return integer(input.maxCart, "Max per cart", { min: 1 });
}

export default {
  key: "create-ticket",
  title: "Create Ticket",
  type: "perform",
  resource: "ticket",
  idempotent: false,
  description:
    "Add a ticket type to an event. Price is in major USD units, in whole cents. Flite defaults capacity to 2000, availability to Available and max per cart to 10; it has no minimum per cart.",
  params: [
    { key: "eventId", label: "Event ID or URN", type: "string", required: true },
    { key: "ticketName", label: "Ticket name", type: "string", required: true },
    { key: "ticketPrice", label: "Price (USD)", type: "number", required: true },
    { key: "capacity", label: "Capacity", type: "number" },
    { key: "availability", label: "Availability", type: "select", options: availabilityOptions },
    { key: "description", label: "Description", type: "text", advanced: true },
    { key: "maxCart", label: "Max per cart", type: "number", advanced: true, hint: "Flite's default is 10." },
    { key: "ebTicketId", label: "External box office ticket ID", type: "string", advanced: true },
  ],
  output: [
    { key: "ticket", label: "Created ticket", type: "object" },
    { key: "ticketId", label: "Ticket ID", type: "string" },
  ],
  async execute(input, ctx): Promise<{ ticket: FliteCreatedTicket & { maxCart?: number }; ticketId: string }> {
    const body = newTicket(input);
    const maxCart = maxPerCart(input);
    const client = new FliteClient(ctx);
    const ticket = await client.createTicket(body);
    if (maxCart === undefined) return { ticket, ticketId: ticket._id };
    // Flite's create ignores maxCart (sandbox, 2026-11-21), so it is set on the new ticket.
    try {
      await client.updateTicket({ eventId: body.eventId, ticketId: ticket._id, maxCart });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new Error(
        `Created ticket ${ticket._id}, but setting max per cart failed (${reason}). ` +
          "Set it with Update Ticket; running Create Ticket again would add a second ticket.",
      );
    }
    return { ticket: { ...ticket, maxCart }, ticketId: ticket._id };
  },
} satisfies ActionDefinition<CreateTicketInput>;
