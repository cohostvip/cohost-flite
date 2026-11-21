import type { ActionDefinition } from "@w6w/types";
import { FliteClient, MAX_EVENTS_PER_PAGE } from "../lib/client.ts";
import { date, integer, text } from "../lib/fields.ts";

export interface ListEventsInput {
  page?: number;
  limit?: number;
  status?: string[] | string;
  date?: string;
  search?: string;
}

const STATUSES = ["Approved", "Pending"];

export function eventStatuses(value: ListEventsInput["status"]): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const statuses = list.map((s) => String(s).trim()).filter(Boolean);
  for (const status of statuses) {
    if (!STATUSES.includes(status)) throw new Error(`Status must be ${STATUSES.join(" or ")}`);
  }
  return [...new Set(statuses)];
}

export default {
  key: "list-events",
  title: "List Events",
  type: "search",
  resource: "event",
  idempotent: true,
  description:
    "Read one page of the organization's events. Continue with the next page while pagination.hasMore is true.",
  params: [
    { key: "page", label: "Page", type: "number", default: 1 },
    { key: "limit", label: "Per page", type: "number", hint: `1 to ${MAX_EVENTS_PER_PAGE}.` },
    {
      key: "status",
      label: "Status",
      type: "multiselect",
      options: STATUSES.map((value) => ({ label: value, value })),
      hint: "Leave empty for every status.",
    },
    { key: "date", label: "Date", type: "date", hint: "Only events on this date (YYYY-MM-DD)." },
    { key: "search", label: "Search", type: "string", hint: "Matches the event name." },
  ],
  output: [
    {
      key: "events",
      label: "Events",
      type: "array",
      items: [
        { key: "_id", label: "Event ID", type: "string" },
        { key: "eventName", label: "Name", type: "string" },
        { key: "status", label: "Status", type: "string" },
        { key: "startDate", label: "Start date", type: "string" },
        { key: "startTime", label: "Start time", type: "string" },
        { key: "venueName", label: "Venue", type: "string" },
        { key: "isEventEnd", label: "Ended", type: "boolean" },
      ],
    },
    { key: "count", label: "Count on this page", type: "number" },
    { key: "pagination", label: "Pagination", type: "object" },
  ],
  async execute(input, ctx) {
    return await new FliteClient(ctx).listEvents({
      page: integer(input.page, "Page", { min: 1 }),
      limit: integer(input.limit, "Per page", { min: 1, max: MAX_EVENTS_PER_PAGE }),
      status: eventStatuses(input.status),
      date: date(input.date, "Date"),
      search: text(input.search, "Search", { max: 200 }),
    });
  },
} satisfies ActionDefinition<ListEventsInput>;
