/**
 * The Cohost shapes this app produces and accepts. They mirror the zod schemas in
 * cohostvip/core-types (`schemas/event.ts`, `ticket.ts`, `offering.ts`, `order.ts`,
 * `orderItem.ts`, `person.ts`, `location.ts`, `costs.ts`) and are kept local because W6W apps
 * ship as dependency-free bundles. Fields the converters never read or write are omitted.
 */

/** `"<CUR>,<integer minor units>"`, e.g. `"USD,1250"` for $12.50. */
export type CurrencyAmount = string;

export interface CohostOfferingCosts {
  cost: CurrencyAmount;
  delivery: CurrencyAmount;
  fee: CurrencyAmount;
  tax: CurrencyAmount;
  gross: CurrencyAmount;
  total: CurrencyAmount;
}

export interface CohostAddress {
  address_1: string;
  address_2?: string;
  city: string;
  country: string;
  postal_code: string;
  /** Upper-case region code, e.g. `NY`. */
  region: string;
  formattedAddress?: string;
}

export interface CohostLocation {
  venueId: string | null;
  placeId: string | null;
  name: string;
  geometry: { lat: number; lng: number } | null;
  address: CohostAddress | null;
  timezone?: string;
}

export type CohostEventStatus =
  | "archived" | "queued" | "draft" | "live" | "started" | "ended" | "completed" | "canceled";

export interface CohostEvent {
  id: string;
  urn?: string;
  refId?: string;
  source?: string;
  appId?: string;
  companyId: string;
  organizerId: string | null;
  name: string;
  summary: string;
  description?: { text?: string; blocks?: unknown[] | null };
  /** IANA time zone. */
  tz: string;
  /** ISO 8601 instants. */
  start: string;
  end: string;
  isSeries: boolean;
  status: CohostEventStatus;
  public: boolean;
  flyer: { url: string } | null;
  currency: string;
  locale?: string;
  location?: CohostLocation;
  capacity?: number;
  slug?: string;
  tags?: string[];
  created: string;
  changed: string;
  version?: string;
  meta?: Record<string, unknown>;
}

export type CohostOfferingStatus =
  | "live" | "hidden" | "sold-out" | "draft" | "archived" | "deleted" | "unavailable";

export type CohostPriceCategory = "donation" | "free" | "paid" | "other";

export interface CohostTicket {
  id: string;
  urn?: string;
  refId?: string;
  source: string;
  name: string;
  type: "admission" | "package" | "admission.tableCommitment";
  category: string;
  description: string | null;
  instructions: string | null;
  /** Total capacity, including tickets already sold. */
  capacity: number;
  quantitySold: number;
  status: CohostOfferingStatus;
  priceCategory: CohostPriceCategory;
  sorting: number;
  step: number;
  minimumQuantity: number;
  maximumQuantity: number;
  costs: CohostOfferingCosts;
  transferable: boolean;
  created?: string;
  changed?: string;
  meta?: Record<string, unknown>;
}

export interface CohostCustomer {
  uid: string | null;
  name: string;
  displayName?: string | null;
  first: string;
  last: string;
  gender: string | null;
  email: string | null;
  phone: string | null;
  birthdate: string | null;
  photoURL: string | null;
}

export interface CohostOfferingSnapshot {
  id: string;
  urn?: string;
  name: string;
  type: string;
  category?: string;
  description: string | null;
  costs?: CohostOfferingCosts;
  sorting: number;
  meta?: Record<string, unknown>;
}

export interface CohostOrderItemCosts extends CohostOfferingCosts {
  subtotal: CurrencyAmount;
  discount: CurrencyAmount;
  preDiscount: CurrencyAmount;
}

export interface CohostItemAttendee {
  urn: string;
  profile: CohostCustomer | null;
  checkedIn: boolean;
  checkedInAt?: string | null;
  barcodes: string[];
  ticketQr?: string;
  status: string;
}

export interface CohostOrderItemMeta extends Record<string, unknown> {
  barcode?: string;
  barcodes?: string[];
  ticketQr?: string;
  attendees?: CohostItemAttendee[];
}

export interface CohostOrderItem {
  id: string;
  purchaseGroupId: string | null;
  offeringType: string;
  offeringId: string;
  quantity: number;
  /** Line totals. */
  costs: CohostOrderItemCosts;
  includedWithItemId: string | null;
  costComponents: unknown[];
  meta: CohostOrderItemMeta | null;
  details: string | null;
  options: unknown;
  offering: CohostOfferingSnapshot;
}

export type CohostOrderStatus = "placed" | "voided" | "refunded";

export interface CohostOrderCosts {
  subtotal: CurrencyAmount;
  fee: CurrencyAmount;
  tax: CurrencyAmount;
  discount: CurrencyAmount;
  delivery: CurrencyAmount;
  gross: CurrencyAmount;
  preDiscount: CurrencyAmount;
  total: CurrencyAmount;
}

export interface CohostOrder {
  id?: string;
  urn?: string;
  orderNumber: string;
  currency: string;
  coupons: unknown[];
  organizerId: string | null;
  companyId: string;
  /** URN of the event the order belongs to. */
  contextId: string;
  costs: CohostOrderCosts;
  customer: CohostCustomer;
  status: CohostOrderStatus;
  items: CohostOrderItem[];
  agreements?: Record<string, boolean>;
  answers?: Record<string, string | boolean>;
  forwarded?: unknown;
  meta: Record<string, unknown>;
  context?: Record<string, unknown>;
  uid: string | null;
  created?: string;
  changed?: string;
  version?: string;
}
