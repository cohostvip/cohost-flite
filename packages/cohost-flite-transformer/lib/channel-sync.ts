/** Pure builder: T2 channel snapshot -> desired Flite state. Skeleton; logic lands in a later slice. */

export type SyncMode = "publish" | "hold" | "stop" | "noop";
export type FliteEnv = "sandbox" | "production";

/** One RMS `find-mapped-resources` result item. */
export interface MappingRecord {
  urn?: string;
  mappedUrn?: string;
  labels?: Record<string, string>;
  [key: string]: unknown;
}

/** Output of `vip.cohost.w6w` `get-channel-event-snapshot` (plan.md §Pinned interface). */
export interface ChannelSnapshot {
  channelId: string;
  eventId: string;
  companyId: string;
  eventUrn: string;
  listing: Record<string, unknown> | null;
  visibility: string | null;
  shown: boolean;
  channelEvent: Record<string, unknown> | null;
  channelTickets: Array<Record<string, unknown>>;
  event: Record<string, unknown>;
  tickets: Array<Record<string, unknown>>;
  mappings: { event: MappingRecord[]; tickets: Record<string, MappingRecord[]> };
}

export interface DesiredLabels {
  provider: string;
  env: string;
  org: string;
  channelId: string;
  listingId: string;
}

export interface DesiredTicket {
  ticketId: string;
  ticketUrn: string;
  /** Flite create/update body fields (name, price, capacity, availability…). */
  fields: Record<string, unknown>;
  availability: "true" | "false";
  capacity?: number;
}

export interface DesiredState {
  mode: SyncMode;
  companyId: string;
  channelId: string;
  listingId: string;
  eventId: string;
  eventUrn: string;
  labels: DesiredLabels;
  /** Flite create-event fields, or null when the event cannot be converted. */
  event: Record<string, string> | null;
  tickets: DesiredTicket[];
  mappings: ChannelSnapshot["mappings"];
  errors: string[];
}

export interface BuildOptions {
  env: string;
  org: string;
  currency?: string;
}

export function buildDesiredState(_snapshot: ChannelSnapshot, _options: BuildOptions): DesiredState {
  throw new Error("buildDesiredState: not implemented");
}
