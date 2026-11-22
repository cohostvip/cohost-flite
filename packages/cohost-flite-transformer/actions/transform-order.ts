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
    ...sourceParams.map((p) => (p.key === "connectionId" ? { ...p, required: false } : p)),
    {
      key: "env",
      label: "Flite environment",
      type: "string",
      hint: "Used as connectionId `flite-<env>` when no connectionId is given.",
    },
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
    const connectionId = input.connectionId || (input.env ? `flite-${input.env}` : undefined);
    if (!connectionId) throw new Error("connectionId is required and must be a valid URN segment");
    const { id: urn, ...order } = fliteOrderToCohost({ ...input, connectionId }, input.order, { eventId: input.eventId });
    return { order, context: { urn: urn! } };
  },
} satisfies ActionDefinition<Omit<SourceContext, "connectionId"> & { connectionId?: string; env?: string; order: AnyFliteOrder; eventId?: string }>;
