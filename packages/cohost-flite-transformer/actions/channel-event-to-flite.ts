import type { ActionDefinition } from "@w6w/types";
import { buildDesiredState, type ChannelSnapshot, type DesiredState } from "../lib/channel-sync.ts";

export interface ChannelEventToFliteInput {
  snapshot: ChannelSnapshot;
  env: string;
  org: string;
  currency?: string;
}

export default {
  key: "channel-event-to-flite",
  title: "Channel Event to Flite",
  type: "read",
  resource: "event",
  idempotent: true,
  requiresAuth: false,
  description:
    "Convert a Cohost sales-channel event snapshot to the desired Flite state (event, tickets, mode) for Sync Event. Pure; makes no requests.",
  params: [
    { key: "snapshot", label: "Channel event snapshot", type: "json", required: true },
    { key: "env", label: "Flite environment", type: "string", required: true, hint: "sandbox or production." },
    { key: "org", label: "Flite organization", type: "string", required: true },
    { key: "currency", label: "Organization currency", type: "string", hint: "Defaults to USD." },
  ],
  output: [{ key: "desired", label: "Desired Flite state", type: "object" }],
  execute(input): { desired: DesiredState } {
    return { desired: buildDesiredState(input.snapshot, input) };
  },
} satisfies ActionDefinition<ChannelEventToFliteInput>;
