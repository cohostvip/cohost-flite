import type { ActionDefinition } from "@w6w/types";
import { FliteClient } from "../lib/client.ts";

export default {
  key: "get-order",
  title: "Get Order",
  type: "read",
  resource: "order",
  idempotent: true,
  description: "Fetch a Flite order, including its buyer and ticket barcodes.",
  params: [{ key: "orderId", label: "Order ID", type: "string", required: true }],
  output: [{ key: "order", label: "Order", type: "object" }],
  async execute({ orderId }, ctx) {
    return { order: await new FliteClient(ctx).getOrder(orderId) };
  },
} satisfies ActionDefinition<{ orderId: string }>;
