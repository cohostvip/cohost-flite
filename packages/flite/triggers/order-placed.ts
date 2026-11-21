import type { TriggerDefinition } from "@w6w/types";
import { FliteClient, object } from "../lib/client.ts";

export interface Delivery {
  action: "order-placed";
  orderId: string;
  timestamp?: string;
}

export function normalizeDelivery(body: unknown): Delivery | null {
  const payload = object(typeof body === "string" ? JSON.parse(body) : body);
  if (payload.action === "test") return null;
  if (typeof payload.action !== "string") throw new Error("Flite webhook is missing action");
  if (payload.action !== "order-placed") return null;
  if (typeof payload.orderId !== "string" || !payload.orderId.trim()) {
    throw new Error("Flite webhook is missing orderId");
  }
  return {
    action: "order-placed",
    orderId: payload.orderId,
    ...(typeof payload.timestamp === "string" ? { timestamp: payload.timestamp } : {}),
  };
}

export default {
  key: "order-placed",
  title: "Order Placed",
  description:
    "Receive Flite order notifications and fetch the full order. Register this trigger's callback URL using Register Webhook.",
  output: [
    { key: "orderId", label: "Order ID", type: "string" },
    { key: "timestamp", label: "Timestamp", type: "string" },
    { key: "order", label: "Order", type: "object" },
  ],
  sample: {
    orderId: "order_example",
    timestamp: "2026-01-01T12:00:00Z",
    order: { _id: "order_example", eventId: "event_example", status: "completed", tickets: [] },
  },
  handleIngest({ raw }) {
    if (raw.method.toUpperCase() !== "POST") throw new Error("Flite webhooks require POST");
    const event = normalizeDelivery(raw.body);
    return event ? [event] : [];
  },
  async parseOutput({ normalized }, ctx) {
    const event = normalizeDelivery(normalized);
    if (!event) throw new Error("Delivery is not an order notification");
    return { ...event, order: await new FliteClient(ctx).getOrder(event.orderId) };
  },
} satisfies TriggerDefinition<Record<string, never>, Delivery>;
