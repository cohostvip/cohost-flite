import type { ActionDefinition } from "@w6w/types";
import type { FliteEventWithTickets } from "@cohost/flite-types";
import { type SourceContext, sourceParams } from "../lib/context.ts";
import { fliteEventSnapshot } from "../convert/snapshot.ts";

export default {
  key: "event-snapshot",
  title: "Event Snapshot",
  type: "read",
  resource: "event",
  idempotent: true,
  requiresAuth: false,
  description:
    "Convert a Flite event with its ticket types to a Cohost-compatible snapshot with availability, prices, capacity, and source URNs.",
  params: [
    { key: "event", label: "Flite event with tickets", type: "json", required: true },
    ...sourceParams,
    { key: "currency", label: "Organization currency", type: "string", hint: "Defaults to USD." },
  ],
  output: [{ key: "snapshot", label: "Event snapshot", type: "object" }],
  execute(input) {
    return { snapshot: fliteEventSnapshot(input, input.event, input.currency) };
  },
} satisfies ActionDefinition<SourceContext & { event: FliteEventWithTickets; currency?: string }>;
