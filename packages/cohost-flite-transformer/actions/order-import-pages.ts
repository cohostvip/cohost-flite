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
  /** A number, or an integer-like string (a variable set from a CLI/UI arrives as text). */
  maxPages?: number | string;
}

export interface ImportPagesOutput {
  jobs: ImportPageJob[];
  skipped: ImportSkipped[];
}

const DEFAULT_MAX_PAGES = 10;
const MAX_PAGES_LIMIT = 1000;

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
  execute(input): ImportPagesOutput {
    const raw = input.maxPages;
    const maxPages: number = typeof raw === "string" ? (/^\s*\d+\s*$/.test(raw) ? Number(raw) : Number.NaN) : raw ?? DEFAULT_MAX_PAGES;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_LIMIT) {
      throw new Error(`maxPages must be an integer between 1 and ${MAX_PAGES_LIMIT}`);
    }
    if (!Array.isArray(input.targets)) throw new Error("targets must be an array");
    const jobs: ImportPageJob[] = [];
    const skipped: ImportSkipped[] = [];
    const seenCohost = new Set<string>();
    const fliteOwner = new Map<string, string>();
    for (const t of input.targets) {
      const cohostEventId = typeof t?.cohostEventId === "string" ? t.cohostEventId : "";
      if (!cohostEventId) throw new Error("every target needs a cohostEventId");
      if (seenCohost.has(cohostEventId)) {
        skipped.push({ cohostEventId, reason: "duplicate: event listed more than once" });
        continue;
      }
      seenCohost.add(cohostEventId);
      const eventId = t.fliteEventId;
      if (t.mapped !== true || typeof eventId !== "string" || eventId === "") {
        skipped.push({ cohostEventId, reason: (t.mapped !== true && t.reason) || "unmapped: no Flite event mapped by this channel" });
        continue;
      }
      const owner = fliteOwner.get(eventId);
      if (owner !== undefined) {
        skipped.push({ cohostEventId, reason: `duplicate: Flite event ${eventId} is already imported for ${owner}` });
        continue;
      }
      fliteOwner.set(eventId, cohostEventId);
      for (let page = 1; page <= maxPages; page++) jobs.push({ cohostEventId, eventId, page });
    }
    return { jobs, skipped };
  },
} satisfies ActionDefinition<ImportPagesInput>;
