import type { ActionDefinition } from "@w6w/types";
import { FliteClient } from "../lib/client.ts";

export default {
  key: "get-webhook",
  title: "Get Webhook URL",
  type: "read",
  resource: "webhook",
  idempotent: true,
  description: "Read the organization's current Flite webhook URL.",
  output: [{ key: "webhookUrl", label: "Webhook URL", type: "string" }],
  async execute(_input, ctx) {
    return { webhookUrl: await new FliteClient(ctx).getWebhook() };
  },
} satisfies ActionDefinition;
