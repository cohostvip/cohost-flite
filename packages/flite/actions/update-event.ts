import type { ActionDefinition } from "@w6w/types";
import { FliteClient, resourceId } from "../lib/client.ts";
import { date, defined, flag, integer, text, time } from "../lib/fields.ts";

export interface UpdateEventInput {
  eventId: string;
  eventName?: string;
  description?: string;
  venueName?: string;
  venueLocation?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  showEvent?: boolean;
  rsvpCapacity?: number;
  startDate?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
}

/** The `update-event-properties` body: only the documented fields, only those set. */
export function eventProperties(input: UpdateEventInput) {
  const startDate = date(input.startDate, "Start date");
  const endDate = date(input.endDate, "End date");
  if (startDate && endDate && endDate < startDate) throw new Error("End date cannot be before the start date");
  const showEvent = flag(input.showEvent, "Show event");
  const properties = defined({
    eventName: text(input.eventName, "Event name", { max: 200 }),
    description: text(input.description, "Description"),
    venueName: text(input.venueName, "Venue name", { max: 200 }),
    venueLocation: text(input.venueLocation, "Venue location", { max: 500 }),
    city: text(input.city, "City", { max: 100 }),
    // Flite's reference says state and ZIP code are not updatable; the sandbox accepted both (2026-11-21).
    state: text(input.state, "State or province", { max: 100 }),
    zipCode: text(input.zipCode, "ZIP / postal code", { max: 20 }),
    // Flite documents showEvent as the string "true" or "false".
    showEvent: showEvent === undefined ? undefined : String(showEvent),
    rsvpCapacity: integer(input.rsvpCapacity, "RSVP capacity"),
    startDate,
    endDate,
    startTime: time(input.startTime, "Start time"),
    endTime: time(input.endTime, "End time"),
  });
  if (!Object.keys(properties).length) throw new Error("Choose at least one event property to update");
  return { eventId: resourceId(input.eventId, "events"), ...properties };
}

export default {
  key: "update-event",
  title: "Update Event",
  type: "perform",
  resource: "event",
  idempotent: true,
  description:
    "Change an event's name, description, venue, city, state, ZIP code, dates, times, visibility or RSVP capacity. Only the fields you set are sent. To end or reopen sales use Control Event.",
  params: [
    { key: "eventId", label: "Event ID or URN", type: "string", required: true },
    { key: "eventName", label: "Event name", type: "string" },
    { key: "description", label: "Description", type: "text" },
    { key: "venueName", label: "Venue name", type: "string" },
    { key: "venueLocation", label: "Venue address", type: "string" },
    { key: "city", label: "City", type: "string" },
    { key: "state", label: "State or province", type: "string" },
    { key: "zipCode", label: "ZIP / postal code", type: "string" },
    { key: "startDate", label: "Start date", type: "date", hint: "YYYY-MM-DD" },
    { key: "startTime", label: "Start time", type: "string", hint: "24-hour HH:mm" },
    { key: "endDate", label: "End date", type: "date", hint: "YYYY-MM-DD" },
    { key: "endTime", label: "End time", type: "string", hint: "24-hour HH:mm" },
    { key: "showEvent", label: "Show publicly", type: "boolean", advanced: true },
    { key: "rsvpCapacity", label: "RSVP capacity", type: "number", advanced: true },
  ],
  output: [{ key: "event", label: "Updated event", type: "object" }],
  async execute(input, ctx) {
    return { event: await new FliteClient(ctx).updateEvent(eventProperties(input)) };
  },
} satisfies ActionDefinition<UpdateEventInput>;
