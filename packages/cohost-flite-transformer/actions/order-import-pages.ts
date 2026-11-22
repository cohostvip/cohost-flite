import type { ActionDefinition } from "@w6w/types";

/** One per-event result of the import root's `ev_target` step. */
export interface ImportTarget {
  /** Cohost event id on the channel. */
  cohostEventId: string;
  /** True when this channel's own mapping to a Flite event was found. */
  mapped: boolean;
  /** Flite event id (last segment of the mapped `/events/<id>` URN); set when mapped. */
  fliteEventId?: string;
  /** Why the event is skipped; set when not mapped. */
  reason?: string;
}

/** One list-orders call to make. Jobs align by index with the foreach output that consumes them. */
export interface ImportPageJob {
  cohostEventId: string;
  /** Flite event id passed to `list-orders` as `eventId`. */
  eventId: string;
  /** 1-based page number passed to `list-orders` as `page`. */
  page: number;
}

export interface ImportSkipped {
  cohostEventId: string;
  reason: string;
}

export interface ImportPagesInput {
  targets: ImportTarget[];
  maxPages?: number;
}

export interface ImportPagesOutput {
  jobs: ImportPageJob[];
  skipped: ImportSkipped[];
}

export default {
  key: "order-import-pages",
  title: "Plan Order Import Pages",
  type: "read",
  resource: "order",
  idempotent: true,
  requiresAuth: false,
  description:
    "Expand per-event import targets into the list-orders page jobs (pages 1..maxPages per mapped event) and the visibly skipped, unmapped events. The workflow has no while-loop, so paging is a bounded foreach; Flite answers pages past the end with an empty page and order-import-flatten reports when the cap truncated an event. Pure; makes no requests.",
  params: [
    { key: "targets", label: "Per-event targets", type: "json", required: true },
    { key: "maxPages", label: "Max pages per event", type: "number", default: 10, hint: "Upper bound on list-orders pages fetched per event." },
  ],
  output: [
    { key: "jobs", label: "list-orders page jobs", type: "array" },
    { key: "skipped", label: "Skipped events", type: "array" },
  ],
  execute(_input): ImportPagesOutput {
    // TODO(T9 S2): implement — see worklist/T9.md "Design pins".
    throw new Error("not implemented");
  },
} satisfies ActionDefinition<ImportPagesInput>;
