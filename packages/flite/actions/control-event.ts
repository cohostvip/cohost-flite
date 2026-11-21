import type { ActionDefinition } from "@w6w/types";
import { FliteClient, resourceId } from "../lib/client.ts";
// One builder for the update-ticket-properties body, shared with Update Ticket.
import { ticketProperties } from "./update-ticket.ts";

export interface ControlInput {
  eventId: string;
  action: "start" | "stop";
  ticketId?: string;
  capacity?: number;
  price?: string;
}

export default {
  key: "control-event",
  title: "Control Event or Ticket",
  type: "perform",
  resource: "event",
  idempotent: true,
  description:
    "Start or stop an event or ticket. Optionally set ticket capacity and a USD price in minor units.",
  params: [
    { key: "eventId", label: "Event ID or URN", type: "string", required: true },
    {
      key: "action",
      label: "Action",
      type: "select",
      required: true,
      options: [{ label: "Start", value: "start" }, { label: "Stop", value: "stop" }],
    },
    { key: "ticketId", label: "Ticket ID or URN", type: "string" },
    { key: "capacity", label: "Total ticket capacity", type: "number" },
    { key: "price", label: "Ticket price", type: "string", hint: "USD,1000 means $10.00." },
  ],
  output: [
    { key: "success", label: "Success", type: "boolean" },
    { key: "eventId", label: "Event ID", type: "string" },
    { key: "ticketId", label: "Ticket ID", type: "string" },
    { key: "status", label: "Status", type: "string" },
  ],
  async execute(input, ctx) {
    if (input.action !== "start" && input.action !== "stop") {
      throw new Error("Action must be start or stop");
    }
    const eventId = resourceId(input.eventId, "events");
    const active = input.action === "start";
    const client = new FliteClient(ctx);
    if (input.ticketId) {
      let ticketPrice: number | undefined;
      if (input.price !== undefined) {
        if (!/^USD,\d+$/.test(input.price)) {
          throw new Error("Price must be USD followed by integer minor units, e.g. USD,1000");
        }
        const minor = Number(input.price.slice(4));
        if (!Number.isSafeInteger(minor)) throw new Error("Price exceeds safe integer range");
        ticketPrice = minor / 100;
      }
      const body = ticketProperties({
        ...input,
        ticketId: input.ticketId,
        eventId,
        availability: active ? "true" : "false",
        ticketPrice,
      });
      await client.updateTicket(body);
      return {
        success: true,
        eventId,
        ticketId: body.ticketId,
        status: active ? "active" : "ended",
      };
    }
    if (input.capacity !== undefined || input.price !== undefined) {
      throw new Error("Ticket ID is required to update capacity or price");
    }
    await client.setEventEnded(eventId, !active);
    return { success: true, eventId, status: active ? "active" : "ended" };
  },
} satisfies ActionDefinition<ControlInput>;
