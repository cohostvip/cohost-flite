import type { ActionDefinition } from "@w6w/types";
import { type SourceContext, sourceParams } from "../lib/context.ts";
import { type AnyFliteOrder, fliteOrderToCohost } from "../convert/order.ts";

export default {
  key: "transform-order",
  title: "Transform Order to Cohost",
  type: "read",
  resource: "order",
  idempotent: true,
  requiresAuth: false,
  description:
    "Convert a Flite order into a Cohost import payload with explicit source identity. Makes no API calls.",
  params: [
    { key: "order", label: "Flite order", type: "json", required: true },
    ...sourceParams,
    {
      key: "eventId",
      label: "Fallback event ID",
      type: "string",
      hint: "Required for orders from the order list, which carry no event ID.",
    },
    { key: "organizerId", label: "Cohost organizer ID", type: "string" },
  ],
  output: [
    { key: "order", label: "Cohost order", type: "object" },
    { key: "context", label: "Import context", type: "object" },
  ],
  execute(input) {
    const { id: urn, ...order } = fliteOrderToCohost(input, input.order, { eventId: input.eventId });
    return { order, context: { urn: urn! } };
  },
} satisfies ActionDefinition<SourceContext & { order: AnyFliteOrder; eventId?: string }>;
