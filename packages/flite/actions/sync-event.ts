import type { ActionDefinition } from "@w6w/types";
import { baseUrl, STAGING_API_URL } from "../lib/client.ts";
import type { DesiredState, SyncOutput } from "../lib/sync.ts";

export interface SyncEventInput {
  desired: DesiredState;
  expectedEnv: "sandbox" | "production";
}

export default {
  key: "sync-event",
  title: "Sync Event",
  type: "perform",
  resource: "event",
  idempotent: true,
  description:
    "Reconcile a desired Flite event state against its durable URN mappings: create once, update, stop or reopen. Never deletes.",
  params: [
    { key: "desired", label: "Desired state", type: "json", required: true },
    {
      key: "expectedEnv",
      label: "Expected environment",
      type: "select",
      required: true,
      options: [{ label: "Sandbox", value: "sandbox" }, { label: "Production", value: "production" }],
    },
  ],
  output: [
    { key: "eventId", label: "Flite event ID", type: "string" },
    { key: "env", label: "Environment", type: "string" },
    { key: "mode", label: "Mode", type: "string" },
    { key: "registrations", label: "URN mappings to register", type: "array" },
    { key: "operations", label: "Operations", type: "array" },
    { key: "errors", label: "Errors", type: "array" },
    { key: "warnings", label: "Warnings", type: "array" },
  ],
  async execute(input, ctx): Promise<SyncOutput> {
    const env = baseUrl(ctx) === STAGING_API_URL ? "sandbox" : "production";
    if (env !== input.expectedEnv || env !== input.desired.labels.env) {
      throw new Error(`Connection is ${env} but the workflow expects ${input.expectedEnv}`);
    }
    throw new Error("sync-event: not implemented");
  },
} satisfies ActionDefinition<SyncEventInput>;
