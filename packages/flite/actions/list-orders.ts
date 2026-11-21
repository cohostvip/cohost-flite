import type { ActionDefinition } from "@w6w/types";
import { FliteClient } from "../lib/client.ts";

export default {
  key: "list-orders",
  title: "List Orders",
  type: "read",
  resource: "order",
  idempotent: true,
  description:
    "Read one page of Flite orders. Continue with pagination.nextPage while pagination.hasMore is true.",
  params: [
    { key: "eventId", label: "Event ID or URN", type: "string", required: true },
    { key: "page", label: "Page", type: "number", default: 1 },
    { key: "limit", label: "Per page", type: "number", advanced: true, hint: "Leave empty for Flite's default." },
  ],
  output: [
    { key: "orders", label: "Orders", type: "array" },
    { key: "count", label: "Count on this page", type: "number" },
    { key: "pagination", label: "Pagination", type: "object" },
  ],
  execute({ eventId, page, limit }, ctx) {
    return new FliteClient(ctx).listOrders(eventId, page, limit ?? undefined);
  },
} satisfies ActionDefinition<{ eventId: string; page?: number; limit?: number | null }>;
