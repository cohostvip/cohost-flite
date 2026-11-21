import type { ActionDefinition, FileRef } from "@w6w/types";
import { FliteClient } from "../lib/client.ts";
import { date, defined, flag, integer, text, time } from "../lib/fields.ts";

export interface CreateEventInput {
  eventName: string;
  description: string;
  venueName: string;
  venueLocation: string;
  city?: string;
  state: string;
  zipCode: string;
  showEvent?: boolean;
  rsvpCapacity?: number;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  flyer: FileRef | string;
  ebEventId?: string;
}

const FLYER_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** The documented create fields as multipart text values, validated. */
export function createEventFields(input: CreateEventInput): Record<string, string> {
  const startDate = date(input.startDate, "Start date", true)!;
  const endDate = date(input.endDate, "End date", true)!;
  if (endDate < startDate) throw new Error("End date cannot be before the start date");
  const showEvent = flag(input.showEvent, "Show event");
  const rsvpCapacity = integer(input.rsvpCapacity, "RSVP capacity");
  return defined({
    eventName: text(input.eventName, "Event name", { required: true, max: 200 }),
    description: text(input.description, "Description", { required: true }),
    venueName: text(input.venueName, "Venue name", { required: true, max: 200 }),
    venueLocation: text(input.venueLocation, "Venue location", { required: true, max: 500 }),
    city: text(input.city, "City", { max: 100 }),
    state: text(input.state, "State", { required: true, max: 100 }),
    zipCode: text(input.zipCode, "ZIP code", { required: true, max: 20 }),
    showEvent: showEvent === undefined ? undefined : String(showEvent),
    rsvpCapacity: rsvpCapacity === undefined ? undefined : String(rsvpCapacity),
    startDate,
    endDate,
    startTime: time(input.startTime, "Start time", true),
    endTime: time(input.endTime, "End time", true),
    ebEventId: text(input.ebEventId, "External event ID", { max: 200 }),
  }) as Record<string, string>;
}

export default {
  key: "create-event",
  title: "Create Event",
  type: "perform",
  resource: "event",
  idempotent: false,
  description:
    "Create an event in the connected organization, uploading its flyer image. Add tickets with Create Ticket.",
  params: [
    { key: "eventName", label: "Event name", type: "string", required: true },
    { key: "description", label: "Description", type: "text", required: true },
    { key: "venueName", label: "Venue name", type: "string", required: true },
    { key: "venueLocation", label: "Venue address", type: "string", required: true },
    { key: "city", label: "City", type: "string" },
    { key: "state", label: "State or province", type: "string", required: true },
    { key: "zipCode", label: "ZIP / postal code", type: "string", required: true },
    { key: "startDate", label: "Start date", type: "date", required: true, hint: "YYYY-MM-DD" },
    { key: "startTime", label: "Start time", type: "string", required: true, hint: "24-hour HH:mm, e.g. 19:00" },
    { key: "endDate", label: "End date", type: "date", required: true, hint: "YYYY-MM-DD" },
    { key: "endTime", label: "End time", type: "string", required: true, hint: "24-hour HH:mm, e.g. 23:00" },
    { key: "flyer", label: "Flyer image", type: "file", required: true, hint: "PNG, JPEG, GIF or WebP." },
    { key: "showEvent", label: "Show publicly", type: "boolean", default: true },
    { key: "rsvpCapacity", label: "RSVP capacity", type: "number", advanced: true },
    { key: "ebEventId", label: "External box office event ID", type: "string", advanced: true },
  ],
  output: [
    { key: "event", label: "Created event", type: "object" },
    { key: "eventId", label: "Event ID", type: "string" },
  ],
  async execute(input, ctx) {
    const fields = createEventFields(input);
    if (!input.flyer) throw new Error("Flyer image is required");
    if (!ctx.file) throw new Error("This W6W host does not provide file access, which the flyer upload needs");
    const { ref, bytes } = await ctx.file.read(input.flyer);
    const contentType = ref.contentType.split(";")[0].trim().toLowerCase();
    if (!FLYER_TYPES.includes(contentType)) {
      throw new Error("Flyer must be a PNG, JPEG, GIF or WebP image");
    }
    const filename = (ref.filename || "flyer").replace(/[\r\n"\\/]/g, "_").slice(0, 120);
    const event = await new FliteClient(ctx).createEvent(fields, { filename, contentType, bytes });
    return { event, eventId: event._id };
  },
} satisfies ActionDefinition<CreateEventInput>;
