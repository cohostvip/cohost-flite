import type { ActionDefinition } from "@w6w/types";
import { type SourceContext, sourceParams } from "../lib/context.ts";
import { type AnyFliteOrder, type CohostOrderPayload, fliteOrderToCohostPayload } from "../convert/order.ts";

export interface TransformOrderInput extends SourceContext {
  order: AnyFliteOrder;
  channelId?: string;
}

/**
 * Flite order → the body of Cohost's Upsert Order (`{ order, source, attendees }`). Pass the
 * output's `data` to Upsert Order as is. The Flite event id comes from the order itself: detail
 * orders carry it, and the import's flatten step stamps it on list orders.
 */
export default {
  key: "transform-order",
  title: "Transform Order to Cohost",
  type: "read",
  resource: "order",
  idempotent: true,
  requiresAuth: false,
  description:
    "Convert a Flite order into the body of Cohost's Upsert Order: { order, source, attendees }. The source names Flite as the system of record (order id, event, URN, status, raw order); one attendee per issued ticket carries its barcode and check-in. Makes no API calls.",
  params: [
    { key: "order", label: "Flite order", type: "json", required: true },
    ...sourceParams,
    { key: "organizerId", label: "Cohost organizer ID", type: "string" },
    {
      key: "channelId",
      label: "Cohost sales channel ID",
      type: "string",
      hint: "The Cohost sales channel Flite sells for; recorded as the order's context.channelId (which partner sold it).",
    },
  ],
  output: [
    { key: "data", label: "Upsert Order data ({ order, source, attendees })", type: "object" },
    { key: "urn", label: "Order URN", type: "string" },
  ],
  execute(input): { data: CohostOrderPayload; urn: string } {
    const channelId = typeof input.channelId === "string" && input.channelId.trim() ? input.channelId.trim() : undefined;
    const data = fliteOrderToCohostPayload(input, input.order, { channelId });
    return { data, urn: data.order.urn! };
  },
} satisfies ActionDefinition<TransformOrderInput>;
