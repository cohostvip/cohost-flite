import type { ActionDefinition } from "@w6w/types";
import { FliteClient } from "../lib/client.ts";

export default {
  key: "register-webhook",
  title: "Register Webhook",
  type: "perform",
  resource: "webhook",
  idempotent: true,
  description:
    "Set Flite's single organization webhook URL. Paste the URL issued for the Order Placed trigger.",
  params: [
    { key: "webhookUrl", label: "Webhook URL", type: "string", required: true },
    {
      key: "replaceExisting",
      label: "Replace existing webhook",
      type: "boolean",
      default: false,
      hint:
        "Flite supports one URL per organization. Replacing it stops delivery to the previous consumer.",
    },
  ],
  output: [
    { key: "success", label: "Success", type: "boolean" },
    { key: "webhookUrl", label: "Webhook URL", type: "string" },
    { key: "previousUrl", label: "Previous URL", type: "string" },
    { key: "changed", label: "Changed", type: "boolean" },
  ],
  execute({ webhookUrl, replaceExisting }, ctx) {
    return new FliteClient(ctx).registerWebhook(webhookUrl, replaceExisting);
  },
} satisfies ActionDefinition<{ webhookUrl: string; replaceExisting?: boolean }>;
