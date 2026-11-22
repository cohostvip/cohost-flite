import type { ActionDefinition } from "@w6w/types";
import type { ImportPageJob, ImportSkipped } from "./order-import-pages.ts";

/** A `list-orders` output, as collected by the page foreach. */
export interface ImportPageResult {
  orders: unknown[];
  count?: number;
  pagination: { hasMore: boolean; currentPage: number; nextPage: number | null } | null;
}

export interface ImportOrderItem {
  /** Flite list order, passed to `transform-order` as `order`. */
  order: unknown;
  /** Flite event id, passed to `transform-order` as `eventId` (list orders carry none). */
  eventId: string;
  cohostEventId: string;
}

export interface ImportTruncated {
  cohostEventId: string;
  eventId: string;
  /** Last page fetched; it still reported hasMore. */
  lastPage: number;
}

export interface ImportFlattenInput {
  jobs: ImportPageJob[];
  /** Foreach `items` of the page fetch: one `list-orders` output per job, same order as `jobs`. */
  pages: ImportPageResult[];
  skipped?: ImportSkipped[];
}

export interface ImportFlattenOutput {
  items: ImportOrderItem[];
  count: number;
  pageCount: number;
  truncated: ImportTruncated[];
  skipped: ImportSkipped[];
}

export default {
  key: "order-import-flatten",
  title: "Flatten Order Import Pages",
  type: "read",
  resource: "order",
  idempotent: true,
  requiresAuth: false,
  description:
    "Merge the per-page list-orders results of an import into one order list tagged with their event, de-duplicated by Flite order id, and report events whose last fetched page still had more. Pure; makes no requests.",
  params: [
    { key: "jobs", label: "Page jobs", type: "json", required: true },
    { key: "pages", label: "list-orders results (aligned with jobs)", type: "json", required: true },
    { key: "skipped", label: "Skipped events (passed through)", type: "json" },
  ],
  output: [
    { key: "items", label: "Orders to import", type: "array" },
    { key: "count", label: "Order count", type: "number" },
    { key: "pageCount", label: "Pages read", type: "number" },
    { key: "truncated", label: "Events cut off by the page cap", type: "array" },
    { key: "skipped", label: "Skipped events", type: "array" },
  ],
  execute(_input): ImportFlattenOutput {
    // TODO(T9 S2): implement — see worklist/T9.md "Design pins".
    throw new Error("not implemented");
  },
} satisfies ActionDefinition<ImportFlattenInput>;
