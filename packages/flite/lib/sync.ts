/**
 * Pure planner for Sync Event. Skeleton; logic lands in a later slice.
 * The desired-state types are a structural copy of the transformer's `lib/channel-sync.ts`:
 * each app is bundled standalone, so the two packages cannot import each other.
 */

export type SyncMode = "publish" | "hold" | "stop" | "noop";

export interface MappingRecord {
  urn?: string;
  mappedUrn?: string;
  labels?: Record<string, string>;
  [key: string]: unknown;
}

export interface DesiredTicket {
  ticketId: string;
  ticketUrn: string;
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
  labels: { provider: string; env: string; org: string; channelId: string; listingId: string };
  event: Record<string, string> | null;
  tickets: DesiredTicket[];
  mappings: { event: MappingRecord[]; tickets: Record<string, MappingRecord[]> };
  errors: Array<{ message: string; ticketId?: string }>;
}

export interface Registration {
  urn: string;
  mappedUrn: string;
  labels: Record<string, string>;
}

export interface SyncOperation {
  op: string;
  target: string;
  detail?: Record<string, unknown>;
}

export interface SyncOutput {
  eventId: string;
  env: string;
  mode: SyncMode;
  registrations: Registration[];
  operations: SyncOperation[];
  errors: string[];
  warnings: string[];
}
