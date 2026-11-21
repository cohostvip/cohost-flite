import { record } from "../convert/support.ts";

export interface TransformInput {
  resource: "event" | "ticket";
  data: unknown;
  /** IDs resolved from Flite mappings, never the Cohost object's own id. */
  eventId: string;
  ticketId?: string;
}

type TicketProperties = {
  eventId: string;
  ticketId: string;
  availability?: "true" | "false" | "hide" | "soon";
  capacity?: number;
  ticketPrice?: number;
};

export type FliteOperation =
  | { actionKey: "control-event"; params: { eventId: string; action: "start" | "stop" } }
  | { actionKey: "update-ticket"; params: TicketProperties };

function targetId(value: unknown, resource: "events" | "tickets"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`A mapped Flite ${resource} ID is required`);
  }
  if (value.startsWith("urn:")) {
    const match = /^urn:1:([^:\s/]+):([^:\s/]+):(\/[^\s?#]+)$/.exec(value);
    if (!match || match[2].startsWith("cohost")) {
      throw new Error("Expected a Flite source URN, not a Cohost URN");
    }
    const id = new RegExp(`/${resource}/([^/]+)$`).exec(match[3]);
    if (!id) throw new Error(`Expected a Flite ${resource} URN`);
    return id[1];
  }
  if (/[\s/:?#]/.test(value)) throw new Error(`Invalid Flite ${resource} ID`);
  return value;
}

const ACTIVE_EVENT_STATUSES = ["live", "started"];
const INACTIVE_EVENT_STATUSES = ["draft", "queued", "ended", "completed", "canceled", "cancelled", "archived"];

function amount(value: unknown): number {
  if (typeof value !== "string" || !/^USD,\d+$/i.test(value)) {
    throw new Error("Ticket cost must be USD in integer minor units, e.g. USD,1234");
  }
  const minor = Number(value.split(",")[1]);
  if (!Number.isSafeInteger(minor)) throw new Error("Ticket cost exceeds safe integer range");
  return minor / 100;
}

/** Produce only inputs supported by the Flite API app's documented write operations. */
export function cohostToFlite(input: TransformInput): FliteOperation {
  const data = record(input.data, "Cohost data");
  const eventId = targetId(input.eventId, "events");
  if (data.currency != null && data.currency !== "USD") {
    throw new Error("Flite conversion currently supports USD only");
  }
  if (input.resource === "event") {
    let active: boolean;
    if (data.status != null) {
      const status = String(data.status);
      if (ACTIVE_EVENT_STATUSES.includes(status)) active = true;
      else if (INACTIVE_EVENT_STATUSES.includes(status)) active = false;
      else throw new Error("Unsupported Cohost event status");
    } else if (typeof data.enabled === "boolean") {
      active = data.enabled;
    } else {
      throw new Error("Event status or enabled flag is required");
    }
    return { actionKey: "control-event", params: { eventId, action: active ? "start" : "stop" } };
  }
  if (input.resource !== "ticket") {
    throw new Error("Only event and ticket writes are supported by Flite");
  }
  const params: TicketProperties = { eventId, ticketId: targetId(input.ticketId, "tickets") };
  if (data.status != null) {
    const statusMap: Record<string, TicketProperties["availability"]> = {
      live: "true",
      active: "true",
      hidden: "hide",
      draft: "soon",
      "sold-out": "false",
      unavailable: "false",
      archived: "false",
    };
    const status = String(data.status);
    if (!Object.hasOwn(statusMap, status)) throw new Error("Unsupported Cohost ticket status");
    params.availability = statusMap[status];
  } else if (typeof data.enabled === "boolean") {
    params.availability = data.enabled ? "true" : "false";
  }
  if (data.capacity != null) {
    if (typeof data.capacity !== "number" || !Number.isSafeInteger(data.capacity) || data.capacity < 0) {
      throw new Error("Ticket capacity must be a nonnegative integer");
    }
    params.capacity = data.capacity;
  }
  if (data.priceCategory === "donation") {
    throw new Error("Flite fixed-price tickets cannot represent donation pricing");
  }
  const costs = data.costs == null ? undefined : record(data.costs, "Cohost data");
  const price = costs?.cost ?? data.price;
  if (data.priceCategory === "free") params.ticketPrice = 0;
  else if (price != null) params.ticketPrice = amount(price);
  if (params.availability === undefined && params.capacity === undefined && params.ticketPrice === undefined) {
    throw new Error("Ticket has no supported status, capacity, or price to convert");
  }
  return { actionKey: "update-ticket", params };
}
