import type { HookContext } from "@w6w/types";
import type { FliteEventWithTickets, FliteOrder } from "@cohost/flite-types";

// Synthetic records in the real Flite shapes (see tests/fixtures/live). The values are chosen to
// make assertions readable: a paid order with a discount and a custom fee.
export const order: FliteOrder = {
  _id: "order_1",
  eventId: "event_1",
  transactionId: "txn_1",
  orderNumber: "#1001",
  totalAmount: 12.34,
  discountAmount: 1.25,
  promoterName: "",
  status: "Complete",
  rsvpType: "",
  eventQuestionAnswers: { "How did you hear about us?": "A friend" },
  totalCustomFee: 0.34,
  partialRefundAmount: 0,
  isPartialRefund: false,
  instaHandles: [],
  created: "2026-01-01T12:00:00.000Z",
  user: {
    firstName: "Test",
    lastName: "Buyer",
    email: "buyer@example.test",
    mobileNumber: "",
    gender: "",
    profileImage: "",
    userId: "user_1",
  },
  tickets: [{
    ticketId: "ticket_1",
    ticketName: "Admission",
    totalAmount: 12.34,
    ticketQr: "synthetic-qr",
    barcode: "synthetic-barcode",
    checkIn: false,
    checkInTime: null,
    fromOrder: null,
    isTransferred: false,
    transferStatus: null,
    ebTicketId: "",
  }],
  trackingLinkId: "",
  paymentDate: "2026-01-01T12:00:00.000Z",
  isTransferred: false,
  fromOrder: null,
  fromUser: null,
  customFees: [],
  transferStatus: null,
  disputed: false,
  disputeWonDate: null,
  currency: "usd",
};

export const event: FliteEventWithTickets = {
  _id: "event_1",
  userId: "user_9",
  organizationId: "org_1",
  eventCode: "CODE1",
  eventName: "Synthetic Event",
  slug: "synthetic-event",
  venueName: "Synthetic Venue",
  venueLocation: "1 Example Street",
  description: "<p>Synthetic description.</p>",
  startTime: "22:00",
  endTime: "02:00",
  visits: 0,
  startDate: "2026-07-04",
  endDate: "2026-07-05",
  status: "Approved",
  hostFlyer: ["https://example.com/flyer.png"],
  isEventEnd: false,
  city: "Brooklyn",
  zipCode: "11201",
  state: "New York",
  showEvent: true,
  timeZoneId: "America/New_York",
  rsvpCapacity: 0,
  created: "2026-01-01T00:00:00.000Z",
  ebEventId: "",
  tickets: [{
    _id: "ticket_1",
    ticketName: "Admission",
    ticketPrice: 12.34,
    capacity: 100,
    sold: 25,
    availability: "true",
    description: "",
    maxCart: 10,
    ticketId: "ticket_1",
    eventId: "event_1",
    ebTicketId: "",
  }],
};

export function context(responses: Array<unknown | Response> = [], staging = false) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const ctx: HookContext = {
    connection: {
      id: "w6w_connection",
      app: "vip.cohost.flite",
      auth: staging ? "bearer-token-staging" : "bearer-token",
      owner: "test",
      state: "connected",
      createdAt: "2026-01-01T00:00:00Z",
    },
    log() {},
    fetch: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      if (responses.length === 0) throw new Error("Unexpected fetch");
      const next = responses.shift();
      return next instanceof Response ? next : Response.json(next);
    },
  };
  return { ctx, requests };
}

export const source = { companyId: "company_test", connectionId: "source_test" };
