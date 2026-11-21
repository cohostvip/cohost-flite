/**
 * Flite Partner API types. Response payload shapes live in `responses.ts`, derived from real
 * JSON by `scripts/derive-types.mjs`; this file adds the envelope, request and webhook types.
 * Type-only: importing it adds nothing to an app bundle.
 */
export * from "./responses.ts";

/** Every successful Partner API response wraps its payload in this envelope. */
export interface FliteResponse<T> {
  success: true;
  message?: string;
  data: T;
}

/** Error body, e.g. `get-orders-by-event` answers HTTP 404 "No completed orders found". */
export interface FliteErrorResponse {
  success: false;
  message: string;
  /** Set by the partner session endpoints; see {@link FliteAuthErrorCode}. */
  code?: FliteAuthErrorCode | (string & {});
}

/**
 * `code` values from the partner session endpoints (refresh, revoke, organization switch).
 * A revoked refresh token answers `refresh_token_reused`, as does one used after its 5-minute
 * replay window. An expired or malformed access token answers HTTP 401 with no `code`.
 */
export type FliteAuthErrorCode =
  | "refresh_token_required"
  | "invalid_refresh_token"
  | "refresh_token_reused"
  | "refresh_token_expired"
  | "account_disabled"
  | "org_access_revoked"
  | "session_required";

/** Ticket availability values accepted and returned by Flite. */
export type FliteTicketAvailability = "true" | "false" | "hide" | "soon";

/** Order webhook delivery body; the full order is fetched separately by ID. */
export interface FliteWebhookDelivery {
  action: "order-placed" | "test" | (string & {});
  orderId?: string;
  timestamp?: string;
}

// Partner session request bodies (JSON, no Authorization header).

/** `POST /api/partner-login`. The account must be a verified Pilot. */
export interface FlitePartnerLoginInput {
  email: string;
  password: string;
}

/** `POST /api/partner-refresh-token` and `POST /api/partner-revoke-token`. */
export interface FliteRefreshTokenInput {
  refreshToken: string;
}

// Request bodies. Flite documents these but returns no JSON for them, so they are written from
// Flite's API reference (https://www.flite.city/docs) rather than derived from captures.

/** `POST /api/create-event-partner` (multipart). `hostFlyer` is a required file upload. */
export interface FliteCreateEventInput {
  eventName: string;
  description: string;
  venueName: string;
  venueLocation: string;
  city?: string;
  state: string;
  zipCode: string;
  /** `"true"` or `"false"`; Flite defaults to `"true"`. */
  showEvent?: "true" | "false";
  rsvpCapacity?: number;
  /** `YYYY-MM-DD` in the event's local time zone. */
  startDate: string;
  endDate: string;
  /** `HH:mm` in the event's local time zone. */
  startTime: string;
  endTime: string;
  ebEventId?: string;
}

/** `POST /api/update-event-properties` (form-encoded). State and ZIP code are not updatable. */
export type FliteUpdateEventInput =
  & { eventId: string }
  & Partial<Omit<FliteCreateEventInput, "state" | "zipCode" | "ebEventId">>;

/** `POST /api/create-new-ticket`. */
export interface FliteCreateTicketInput {
  eventId: string;
  ticketName: string;
  /** Major units, e.g. `12.5` for $12.50. */
  ticketPrice: number;
  /** Total including sold tickets; Flite defaults to 2000. */
  capacity?: number;
  availability?: FliteTicketAvailability;
  description?: string;
  ebTicketId?: string;
}

/** `POST /api/update-ticket-properties`. Capacity cannot drop below the quantity sold. */
export type FliteUpdateTicketInput =
  & { eventId: string; ticketId: string }
  & Partial<Pick<FliteCreateTicketInput, "ticketName" | "ticketPrice" | "capacity" | "availability" | "description">>
  & { maxCart?: number };
