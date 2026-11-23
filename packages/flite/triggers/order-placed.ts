import type { ParamDefinition, TriggerDefinition } from "@w6w/types";
import { FliteClient, object } from "../lib/client.ts";
import { verifyFliteDelivery } from "../lib/webhook.ts";

/**
 * Flite Partner Webhook trigger (docs/api-docs.md, "Webhooks"). Manual registration: W6W shows the
 * receive URL, the user creates the webhook in Flite (Integrations → Developers → Webhooks) and
 * copies the signing secret Flite shows into this trigger's Signing Secret.
 *
 * Flite webhooks are notification-only:
 *   { webhookEventId, eventType, orderId, organizationId, eventId, created }
 * `handleIngest` verifies the HMAC signature over the raw body before it emits anything (an unset
 * secret refuses every delivery), and `parseOutput` fetches the current order with the
 * connection's token rather than trusting the body.
 *
 * `order.created` is a pending checkout (payment not done, or a transfer not yet accepted) and is
 * acknowledged without a run: the order arrives with `order.completed`. Every other order event
 * re-fetches and emits the order, so refunds, transfers and check-ins stay in sync downstream.
 * Flite delivers at least once; `webhookEventId` is the idempotency key.
 */

/** The order events that emit a run. */
export const ORDER_EVENTS = [
  "order.completed",
  "order.refunded",
  "order.updated",
  "order.disputed",
  "order.scan",
] as const;

export type OrderEventType = (typeof ORDER_EVENTS)[number];

export interface TriggerParams {
  signingSecret?: string;
}

export interface Delivery {
  webhookEventId: string;
  eventType: OrderEventType;
  orderId: string;
  organizationId: string | null;
  eventId: string | null;
  created: string | null;
}

/** `@w6w/types@0.2.0` predates `webhook` (rfcs/trigger.md, Amendment 2026-11-22). */
interface WebhookSetup {
  registration: "manual";
  instructions?: string;
}

const SIGNING_SECRET: ParamDefinition = {
  key: "signingSecret",
  label: "Signing Secret",
  type: "secret",
  required: true,
  hint: "Shown by Flite after you create the webhook (fsec_live_…). Deliveries that do not verify are refused.",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * A verified Flite body (or an already-normalized delivery) → its delivery, or null for an event
 * that emits no run. Throws on a body that is not a Flite order notification.
 */
export function normalizeDelivery(body: unknown): Delivery | null {
  const payload = object(typeof body === "string" ? JSON.parse(body) : body);
  const eventType = text(payload.eventType);
  if (!eventType) throw new Error("Flite webhook is missing eventType");
  if (!(ORDER_EVENTS as readonly string[]).includes(eventType)) return null;
  const orderId = text(payload.orderId);
  if (!orderId) throw new Error("Flite webhook is missing orderId");
  const webhookEventId = text(payload.webhookEventId);
  if (!webhookEventId) throw new Error("Flite webhook is missing webhookEventId");
  return {
    webhookEventId,
    eventType: eventType as OrderEventType,
    orderId,
    organizationId: text(payload.organizationId),
    eventId: text(payload.eventId),
    created: text(payload.created),
  };
}

const trigger = {
  key: "order-placed",
  title: "Order Placed",
  description:
    "Receive signed Flite order webhooks and fetch the full order. Fires on completed, refunded, updated, disputed and scanned orders; pending checkouts (order.created) are skipped.",
  params: [SIGNING_SECRET],
  webhook: {
    registration: "manual",
    instructions: [
      "In Flite, open Integrations → Developers → Webhooks and click Register Webhook.",
      "Paste the URL above as the endpoint URL and choose My Organization as the event source.",
      "Select order.completed (add order.refunded, order.updated and order.scan to keep orders in sync).",
      "Copy the signing secret Flite shows (it is shown once) into this trigger's Signing Secret and save.",
    ].join("\n"),
  },
  output: [
    { key: "webhookEventId", label: "Webhook Event ID", type: "string" },
    { key: "eventType", label: "Event Type", type: "string" },
    { key: "orderId", label: "Order ID", type: "string" },
    { key: "organizationId", label: "Organization ID", type: "string" },
    { key: "eventId", label: "Event ID", type: "string" },
    { key: "created", label: "Created", type: "string" },
    { key: "order", label: "Order", type: "object" },
  ],
  sample: {
    webhookEventId: "evt_flite_example",
    eventType: "order.completed",
    orderId: "order_example",
    organizationId: "org_example",
    eventId: "event_example",
    created: "2026-01-01T12:00:00.000Z",
    order: { _id: "order_example", eventId: "event_example", status: "Complete", tickets: [] },
  },
  async handleIngest({ raw, params }) {
    if (raw.method.toUpperCase() !== "POST") throw new Error("Flite webhooks require POST");
    const body = await verifyFliteDelivery(raw, params?.signingSecret);
    const event = normalizeDelivery(body);
    return event ? [event] : [];
  },
  async parseOutput({ normalized }, ctx) {
    const event = normalizeDelivery(normalized);
    if (!event) throw new Error("Delivery is not an order notification");
    return { ...event, order: await new FliteClient(ctx).getOrder(event.orderId) };
  },
} satisfies TriggerDefinition<TriggerParams, Delivery> & { webhook: WebhookSetup };

export default trigger;
