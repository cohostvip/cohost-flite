import type { FliteBuyer, FliteOrder, FliteOrderListItem, FliteOrderListTicket, FliteOrderTicket } from "@cohost/flite-types";
import type {
  CohostCustomer,
  CohostOrder,
  CohostOrderItem,
  CohostOrderStatus,
} from "./cohost-types.ts";
import { resourceContext, type SourceContext } from "../lib/context.ts";
import { amount, API_VERSION, APP_SOURCE, cohostCurrency, fliteMeta, idFrom, parseAmount, toMajor, toMinor } from "./support.ts";

/** Any order shape Flite returns: list item (`get-orders-by-event`) or detail (`get-order-by-id`). */
export type AnyFliteOrder = FliteOrder | FliteOrderListItem;
type AnyFliteOrderTicket = FliteOrderTicket | FliteOrderListTicket;

export interface FliteOrderOptions {
  /** Required for list items, which carry no `eventId`. Detail orders use their own. */
  eventId?: string;
}

export function orderStatus(status: string): CohostOrderStatus {
  switch (status.toLowerCase()) {
    case "refunded":
      return "refunded";
    case "cancelled":
    case "canceled":
    case "voided":
      return "voided";
    default: // "Complete" is the only status observed; Flite returns completed orders only.
      return "placed";
  }
}

function customer(user: FliteBuyer): CohostCustomer {
  const first = user.firstName || "";
  const last = user.lastName || "";
  return {
    uid: null,
    name: [first, last].filter(Boolean).join(" "),
    displayName: first,
    first,
    last,
    gender: user.gender || null,
    email: user.email || null,
    phone: user.mobileNumber || null,
    birthdate: null,
    photoURL: user.profileImage || null,
  };
}

function orderItem(
  source: SourceContext,
  ticket: AnyFliteOrderTicket,
  eventId: string,
  currency: string,
  sorting: number,
): CohostOrderItem {
  if (!ticket.ticketId) {
    // Flite's documented list example omits it; live responses include it. Without it the item
    // cannot be matched to a ticket type, so fail rather than invent one.
    throw new Error(`Order ticket ${ticket.barcode || ticket.ticketName} has no ticketId; convert the order detail instead`);
  }
  const agent = resourceContext(source);
  const offeringUrn = agent.generateResourceUri(`/events/${eventId}/tickets/${ticket.ticketId}`);
  const attendeeUrn = agent.generateResourceUri(`/orders/attendees/${ticket.barcode}`);
  const total = toMinor(ticket.totalAmount, "ticket totalAmount");
  const discount = "discountAmount" in ticket ? toMinor(ticket.discountAmount ?? 0, "ticket discountAmount") : 0;
  const money = (minor: number) => amount(currency, minor);
  const checkIn = "checkIn" in ticket ? ticket.checkIn : false;

  return {
    id: ticket.barcode,
    purchaseGroupId: null,
    offeringType: "admission",
    offeringId: offeringUrn,
    quantity: 1,
    costs: {
      cost: money(total),
      delivery: money(0),
      fee: money(0),
      tax: money(0),
      gross: money(total),
      total: money(total),
      subtotal: money(total),
      discount: money(discount),
      preDiscount: money(total + discount),
    },
    includedWithItemId: null,
    costComponents: [],
    details: null,
    options: null,
    offering: {
      id: offeringUrn,
      urn: offeringUrn,
      name: ticket.ticketName,
      type: "admission",
      category: "admission",
      description: null,
      sorting,
    },
    meta: {
      source: APP_SOURCE,
      urn: attendeeUrn,
      barcode: ticket.barcode,
      barcodes: [ticket.barcode],
      ticketQr: ticket.ticketQr,
      attendees: [{
        urn: attendeeUrn,
        profile: null,
        checkedIn: checkIn,
        ...("checkInTime" in ticket ? { checkedInAt: ticket.checkInTime } : {}),
        barcodes: [ticket.barcode],
        ticketQr: ticket.ticketQr,
        status: checkIn ? "checkedIn" : "attending",
      }],
      flite: {
        ticketId: ticket.ticketId,
        ...("promoterAmount" in ticket ? { promoterAmount: ticket.promoterAmount } : {}),
        ...("isTransferred" in ticket ? { isTransferred: ticket.isTransferred, transferStatus: ticket.transferStatus } : {}),
        ...(ticket.ebTicketId ? { ebTicketId: ticket.ebTicketId } : {}),
      },
    },
  };
}

/**
 * Flite order → Cohost order. Each issued Flite ticket (one barcode) becomes one order item.
 *
 * Money: Flite's `totalAmount` is what the buyer paid, so it is the Cohost `total`; custom fees
 * are part of it and reported as `fee`; `discountAmount` was taken off before it.
 */
export function fliteOrderToCohost(
  source: SourceContext,
  order: AnyFliteOrder,
  options: FliteOrderOptions = {},
): CohostOrder {
  const agent = resourceContext(source);
  const eventId = ("eventId" in order && order.eventId) || options.eventId;
  if (!eventId) throw new Error("eventId is required: not found on order and not provided as parameter");
  const currency = cohostCurrency(order.currency);
  const money = (minor: number) => amount(currency, minor);
  const total = toMinor(order.totalAmount, "totalAmount");
  const discount = toMinor(order.discountAmount, "discountAmount");
  const fee = Math.min(toMinor(order.totalCustomFee, "totalCustomFee"), total);
  const urn = agent.generateResourceUri(`/orders/${order._id}`);
  const tickets: AnyFliteOrderTicket[] = order.tickets ?? [];
  const sortingOf = new Map<string, number>();
  for (const t of tickets) if (!sortingOf.has(t.ticketId)) sortingOf.set(t.ticketId, sortingOf.size);
  const detail = "paymentDate" in order ? order : undefined;
  const list = "uniqueLinkId" in order ? order : undefined;

  return {
    id: urn,
    urn,
    orderNumber: `FLITE-${order._id}`,
    currency,
    coupons: list?.couponCode ? [{ code: list.couponCode }] : [],
    organizerId: source.organizerId ?? null,
    companyId: source.companyId,
    contextId: agent.generateResourceUri(`/events/${eventId}`),
    costs: {
      subtotal: money(total - fee),
      fee: money(fee),
      tax: money(0),
      discount: money(discount),
      delivery: money(0),
      gross: money(total),
      preDiscount: money(total + discount),
      total: money(total),
    },
    customer: customer(order.user),
    status: orderStatus(order.status),
    items: tickets.map((t) => orderItem(source, t, eventId, currency, sortingOf.get(t.ticketId)!)),
    agreements: {
      agreedToOrganizerTerms: false,
      agreedToTerms: false,
      emailOptIn: false,
      textOptIn: false,
    },
    answers: { ...order.eventQuestionAnswers },
    forwarded: {},
    meta: {
      urn,
      flite: {
        originalId: order._id,
        eventId,
        orderNumber: order.orderNumber,
        transactionId: order.transactionId,
        status: order.status,
        promoterName: order.promoterName,
        rsvpType: order.rsvpType,
        isTransferred: order.isTransferred,
        isPartialRefund: order.isPartialRefund,
        partialRefundAmount: order.partialRefundAmount,
        instaHandles: order.instaHandles,
        userId: order.user.userId,
        ...(detail ? {
          paymentDate: detail.paymentDate,
          trackingLinkId: detail.trackingLinkId,
          disputed: detail.disputed,
          disputeWonDate: detail.disputeWonDate,
          transferStatus: detail.transferStatus,
          fromOrder: detail.fromOrder,
          fromUser: detail.fromUser,
          customFees: detail.customFees,
        } : {}),
        ...(list ? { uniqueLinkId: list.uniqueLinkId, onGround: list.onGround } : {}),
        ...(list?.refundDate ? { refundDate: list.refundDate } : {}),
      },
    },
    context: { source: APP_SOURCE },
    uid: null,
    created: order.created,
    changed: order.created,
    version: API_VERSION,
  };
}

const FLITE_STATUS: Record<CohostOrderStatus, string> = {
  placed: "Complete",
  refunded: "Refunded",
  voided: "Cancelled",
};

/**
 * Cohost order → a Flite order record (the `get-order-by-id` shape). Flite has no endpoint that
 * creates orders, so this is for comparing, exporting and reconciling, not for writing.
 * Items with a quantity above one and no per-unit barcodes become one ticket per unit.
 */
export function cohostOrderToFlite(order: CohostOrder): FliteOrder {
  const flite = fliteMeta(order.meta);
  const str = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
  const major = (value: string, label: string) => toMajor(parseAmount(value, label).minor);
  const id = str(flite.originalId) || idFrom(order.urn ?? order.id, "orders") || "";
  const eventId = str(flite.eventId) || idFrom(order.contextId, "events") || "";

  const tickets: FliteOrderTicket[] = order.items.flatMap((item) => {
    const meta = item.meta ?? {};
    const itemFlite = fliteMeta(meta);
    const barcodes = meta.barcodes?.length ? meta.barcodes : meta.barcode ? [meta.barcode] : [];
    const units = Math.max(item.quantity, barcodes.length, 1);
    const each = Math.round(parseAmount(item.costs.total, "item total").minor / units);
    const ticketId = str(itemFlite.ticketId) || idFrom(item.offeringId, "tickets") || item.offeringId;
    return Array.from({ length: units }, (_, i) => {
      const attendee = meta.attendees?.[i];
      return {
        ticketId,
        ticketName: item.offering.name,
        totalAmount: toMajor(each),
        ticketQr: attendee?.ticketQr ?? meta.ticketQr ?? "",
        barcode: barcodes[i] ?? "",
        checkIn: attendee?.checkedIn ?? false,
        checkInTime: attendee?.checkedInAt ?? null,
        fromOrder: null,
        isTransferred: (itemFlite.isTransferred as boolean | undefined) ?? false,
        transferStatus: (itemFlite.transferStatus as string | null | undefined) ?? null,
        ebTicketId: str(itemFlite.ebTicketId),
      };
    });
  });

  return {
    _id: id,
    eventId,
    transactionId: str(flite.transactionId),
    orderNumber: str(flite.orderNumber, order.orderNumber),
    totalAmount: major(order.costs.total, "costs.total"),
    discountAmount: major(order.costs.discount, "costs.discount"),
    promoterName: str(flite.promoterName),
    status: str(flite.status) && orderStatus(str(flite.status)) === order.status
      ? str(flite.status)
      : FLITE_STATUS[order.status],
    rsvpType: str(flite.rsvpType),
    eventQuestionAnswers: Object.fromEntries(
      Object.entries(order.answers ?? {}).map(([k, v]) => [k, String(v)]),
    ),
    totalCustomFee: major(order.costs.fee, "costs.fee"),
    partialRefundAmount: typeof flite.partialRefundAmount === "number" ? flite.partialRefundAmount : 0,
    isPartialRefund: flite.isPartialRefund === true,
    instaHandles: Array.isArray(flite.instaHandles) ? flite.instaHandles as string[] : [],
    created: order.created ?? "",
    user: {
      firstName: order.customer.first,
      lastName: order.customer.last,
      email: order.customer.email ?? "",
      mobileNumber: order.customer.phone ?? "",
      gender: order.customer.gender ?? "",
      profileImage: order.customer.photoURL ?? "",
      userId: str(flite.userId),
    },
    tickets,
    trackingLinkId: str(flite.trackingLinkId),
    paymentDate: str(flite.paymentDate, order.created ?? ""),
    isTransferred: flite.isTransferred === true,
    fromOrder: (flite.fromOrder as string | null | undefined) ?? null,
    fromUser: (flite.fromUser as string | null | undefined) ?? null,
    customFees: Array.isArray(flite.customFees) ? flite.customFees : [],
    transferStatus: (flite.transferStatus as string | null | undefined) ?? null,
    disputed: flite.disputed === true,
    disputeWonDate: (flite.disputeWonDate as string | null | undefined) ?? null,
    currency: order.currency.toLowerCase(),
  };
}
