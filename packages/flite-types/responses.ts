// Flite Partner API response types, derived from tests/fixtures/live and samples/documented.
// Do not edit by hand: add or refresh a capture, then run `npm run types`.

/** POST /api/partner-login, /api/partner-refresh-token and /api/switch-organization-token/{organizationId}. Derived from 2 sample(s): live. */
export interface FlitePartnerSession {
  token: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
  refreshTokenExpiresAt: string;
  user: FlitePartnerUser;
}

/** GET /api/get-all-orgs-partner (each item). Derived from 2 sample(s): live + docs. */
export interface FliteOrganization {
  _id: string;
  ownerId: string;
  name: string;
  email: string;
  /** Observed: "USD", "usd". */
  currency: string;
  tabling: boolean;
  /** Documented only; not seen in live responses. */
  profileImage?: string;
  /** Documented only; not seen in live responses. */
  id?: string;
}

/** GET /api/get-events-all (each item). Derived from 16 sample(s): live + docs. */
export interface FliteEventSummary {
  _id: string;
  userId: string;
  organizationId: string;
  eventCode: string;
  eventName: string;
  slug: string;
  venueName: string;
  venueLocation: string;
  description: string;
  startTime: string;
  endTime: string;
  visits: number;
  startDate: string;
  endDate: string;
  /** Observed: "Approved", "Pending". */
  status: string;
  hostFlyer: string[];
  isEventEnd: boolean;
  city: string;
  zipCode?: string;
  state: string;
  /** Observed: "America/Chicago", "America/Los_Angeles", "America/New_York". */
  timeZoneId: string;
  created: string;
  ebEventId: string;
}

/** GET /api/get-events-all (pagination). Derived from 2 sample(s): live. */
export interface FliteEventListPagination {
  page: number;
  limit: number;
  hasMore: boolean;
}

/** GET /api/get-event-by-id. Derived from 4 sample(s): live + docs. */
export interface FliteEvent {
  _id: string;
  userId: string;
  organizationId: string;
  eventCode: string;
  eventName: string;
  slug: string;
  venueName: string;
  venueLocation: string;
  description: string;
  startTime: string;
  endTime: string;
  visits: number;
  startDate: string;
  endDate: string;
  /** Observed: "Approved", "Deleted". */
  status: string;
  hostFlyer: string[];
  isEventEnd: boolean;
  city: string;
  zipCode: string;
  state: string;
  showEvent: boolean;
  /** Observed: "America/Los_Angeles", "America/New_York". */
  timeZoneId: string;
  rsvpCapacity: number;
  created: string;
  ebEventId: string;
}

/** GET /api/get-event-tickets-info. Derived from 3 sample(s): live + docs. */
export interface FliteEventWithTickets {
  _id: string;
  userId: string;
  organizationId: string;
  eventCode: string;
  eventName: string;
  slug: string;
  venueName: string;
  venueLocation: string;
  description: string;
  startTime: string;
  endTime: string;
  visits: number;
  startDate: string;
  endDate: string;
  /** Observed: "Approved". */
  status: string;
  hostFlyer: string[];
  isEventEnd: boolean;
  city: string;
  zipCode: string;
  state: string;
  showEvent: boolean;
  /** Observed: "America/New_York". */
  timeZoneId: string;
  rsvpCapacity: number;
  created: string;
  ebEventId: string;
  tickets: FliteTicket[];
}

/** POST /api/create-event-partner. Derived from 1 sample(s): live. */
export interface FliteCreatedEvent {
  _id: string;
  eventId: string;
  eventName: string;
  description: string;
  venueName: string;
  venueLocation: string;
  city: string;
  state: string;
  zipCode: string;
  /** Observed: "Approved". */
  status: string;
  showEvent: boolean;
  rsvpCapacity: number;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  hostFlyer: string[];
  slug: string;
  eventCode: string;
  ebEventId: string;
}

/** POST /api/update-event-flyer (undocumented by Flite). Derived from 1 sample(s): live. */
export interface FliteEventFlyerUpdate {
  _id: string;
  eventId: string;
  eventName: string;
  hostFlyer: string[];
}

/** POST /api/update-event-properties. Derived from 2 sample(s): live. */
export interface FliteEventUpdate {
  eventId: string;
  eventName: string;
  description: string;
  venueName: string;
  venueLocation: string;
  city: string;
  state: string;
  zipCode: string;
  /** Observed: "Approved". */
  status?: string;
  showEvent: boolean;
  rsvpCapacity: number;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  /** Observed: "America/New_York". */
  timeZoneId: string;
  ebEventId: string;
}

/** POST /api/update-event-end-toggle. Derived from 2 sample(s): live. */
export interface FliteEventEndState {
  eventId: string;
  eventName: string;
  isEventEnd: boolean;
}

/** DELETE /api/delete-event-partner. Derived from 1 sample(s): live. */
export interface FliteDeletedEvent {
  _id: string;
  eventId: string;
  eventName: string;
  /** Observed: "Deleted". */
  status: string;
}

/** GET /api/get-ticket-by-id; also each ticket of an event. Derived from 8 sample(s): live + docs. */
export interface FliteTicket {
  _id: string;
  ticketName: string;
  ticketPrice: number;
  capacity: number;
  sold: number;
  /** Observed: "hide", "true". */
  availability: "true" | "false" | "hide" | "soon";
  description: string;
  maxCart: number;
  ticketId: string;
  eventId: string;
  ebTicketId: string;
}

/** POST /api/create-new-ticket. Derived from 1 sample(s): live. */
export interface FliteCreatedTicket {
  _id: string;
  ticketId: string;
  eventId: string;
  ticketName: string;
  ticketPrice: number;
  capacity: number;
  /** Observed: "hide". */
  availability: string;
  description: string;
  ticketOrder: number;
  ebTicketId: string;
}

/** POST /api/update-ticket-properties. Derived from 1 sample(s): live. */
export interface FliteTicketUpdate {
  _id: string;
  ticketId: string;
  eventId: string;
  ticketName: string;
  ticketPrice: number;
  capacity: number;
  /** Observed: "hide". */
  availability: string;
  description: string;
  maxCart: number;
  ebTicketId: string;
}

/** DELETE /api/delete-ticket-partner. Derived from 1 sample(s): live. */
export interface FliteDeletedTicket {
  _id: string;
  ticketId: string;
  eventId: string;
  ticketName: string;
  isDeleted: boolean;
  deleted: string;
  ebTicketId: string;
}

/** GET /api/get-orders-by-event. Derived from 2 sample(s): live + docs. */
export interface FliteOrdersPage {
  orders: FliteOrderListItem[];
  pagination: FlitePagination;
}

/** GET /api/get-order-by-id. Derived from 2 sample(s): live + docs. */
export interface FliteOrder {
  _id: string;
  eventId: string;
  transactionId: string;
  orderNumber: string;
  totalAmount: number;
  discountAmount: number;
  promoterName: string;
  /** Observed: "Complete". */
  status: string;
  /** Observed: "". */
  rsvpType: string;
  eventQuestionAnswers: Record<string, string>;
  totalCustomFee: number;
  partialRefundAmount: number;
  isPartialRefund: boolean;
  instaHandles: string[];
  created: string;
  user: FliteBuyer;
  tickets: FliteOrderTicket[];
  trackingLinkId: string;
  paymentDate: string;
  isTransferred: boolean;
  /** Only null observed; type assumed. */
  fromOrder: string | null;
  /** Only null observed; type assumed. */
  fromUser: string | null;
  customFees: unknown[];
  /** Only null observed; type assumed. */
  transferStatus: string | null;
  disputed: boolean;
  /** Only null observed; type assumed. */
  disputeWonDate: string | null;
  /** Observed: "USD", "usd". */
  currency: string;
}

/** POST /api/scanner/ticket/validate and /api/scanner/ticket/checkin (also on HTTP 404/409). Derived from 7 sample(s): live + docs. */
export interface FliteTicketValidation {
  ticketNumber: string;
  /** Observed: "invalid", "valid". */
  validityStatus: "valid" | "invalid";
  isValid: boolean;
  rejectionReason: string | null;
  /** Observed: "ALREADY_CHECKED_IN", "TICKET_NOT_FOUND". */
  errorCode: string | null;
  ticketType: string | null;
  checkedIn: boolean;
  checkInTime: string | null;
}

/** GET /api/get-webhook-url. Derived from 1 sample(s): live. */
export interface FliteWebhookUrl {
  webhookUrl: string | null;
}

/** Derived from 2 sample(s): live. */
export interface FlitePartnerUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  organization: FliteOrganizationRef;
}

/** Derived from 2 sample(s): live. */
export interface FliteOrganizationRef {
  _id: string;
  name: string;
}

/** Derived from 2 sample(s): live + docs. */
export interface FliteOrderListItem {
  _id: string;
  transactionId: string;
  orderNumber: string;
  totalAmount: number;
  discountAmount: number;
  promoterName: string;
  /** Observed: "Complete". */
  status: string;
  uniqueLinkId: string;
  /** Observed: "". */
  rsvpType: string;
  isTransferred: boolean;
  eventQuestionAnswers: Record<string, string>;
  totalCustomFee: number;
  partialRefundAmount: number;
  isPartialRefund: boolean;
  instaHandles: string[];
  onGround: boolean;
  created: string;
  user: FliteBuyer;
  tickets: FliteOrderListTicket[];
  /** Observed: "usd". */
  currency: string;
  /** Documented only; not seen in live responses. */
  couponCode?: string;
  /** Documented only; not seen in live responses. Only null observed; type assumed. */
  refundDate?: string | null;
}

/** Derived from 4 sample(s): live + docs. */
export interface FliteBuyer {
  firstName: string;
  lastName: string;
  email: string;
  mobileNumber: string;
  /** Observed: "Male", "female". */
  gender: string;
  profileImage: string;
  userId: string;
  /** Documented only; not seen in live responses. */
  id?: string;
}

/** Derived from 2 sample(s): live + docs. */
export interface FliteOrderListTicket {
  ticketId: string;
  ticketName: string;
  totalAmount: number;
  promoterAmount: number;
  discountAmount: number;
  ticketQr: string;
  barcode: string;
  ebTicketId: string;
}

/** Derived from 2 sample(s): live + docs. */
export interface FlitePagination {
  hasMore: boolean;
  currentPage: number;
  nextPage: number | null;
}

/** Derived from 4 sample(s): live + docs. */
export interface FliteOrderTicket {
  ticketId: string;
  ticketName: string;
  totalAmount: number;
  ticketQr: string;
  barcode: string;
  checkIn: boolean;
  checkInTime: string | null;
  /** Only null observed; type assumed. */
  fromOrder: string | null;
  isTransferred: boolean;
  /** Only null observed; type assumed. */
  transferStatus: string | null;
  ebTicketId: string;
}
