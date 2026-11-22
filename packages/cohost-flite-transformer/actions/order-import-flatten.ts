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
  execute(input): ImportFlattenOutput {
    if (!Array.isArray(input.jobs) || !Array.isArray(input.pages)) throw new Error("jobs and pages must be arrays");
    if (input.jobs.length !== input.pages.length) {
      throw new Error(`pages (${input.pages.length}) must align one-to-one with jobs (${input.jobs.length})`);
    }
    const items: ImportOrderItem[] = [];
    const seen = new Set<string>();
    const last = new Map<string, { job: ImportPageJob; page: ImportPageResult }>();
    input.jobs.forEach((job, i) => {
      const page = input.pages[i];
      if (!page || !Array.isArray(page.orders)) throw new Error(`page ${job.page} of event ${job.eventId} has no orders array`);
      const key = `${job.cohostEventId}\u0000${job.eventId}`;
      const prev = last.get(key);
      if (!prev || job.page > prev.job.page) last.set(key, { job, page });
      for (const order of page.orders) {
        const id = (order as { _id?: unknown } | null)?._id;
        if (typeof id !== "string" || id === "") throw new Error(`order without _id on page ${job.page} of event ${job.eventId}`);
        const dedupe = `${key}\u0000${id}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        items.push({ order, eventId: job.eventId, cohostEventId: job.cohostEventId });
      }
    });
    // The last fetched page of an event must be the end; anything else means the page cap cut it off.
    const truncated: ImportTruncated[] = [];
    for (const { job, page } of last.values()) {
      const p = page.pagination;
      if (p && (p.hasMore === true || (p.nextPage !== null && p.nextPage !== undefined))) {
        truncated.push({ cohostEventId: job.cohostEventId, eventId: job.eventId, lastPage: job.page });
      }
    }
    return { items, count: items.length, pageCount: input.pages.length, truncated, skipped: input.skipped ?? [] };
  },
} satisfies ActionDefinition<ImportFlattenInput>;
