import type { ActionDefinition } from "@w6w/types";
import { FliteClient } from "../lib/client.ts";
import { scanLink, scanOutput, scanParams, scanResult } from "../lib/scanner.ts";

export default {
  key: "validate-ticket",
  title: "Validate Ticket",
  type: "read",
  resource: "scanner",
  idempotent: true,
  description:
    "Check a scanned ticket without checking it in. An unknown ticket (TICKET_NOT_FOUND) or a used one (ALREADY_CHECKED_IN) returns valid=false, not an error.",
  params: scanParams,
  output: scanOutput,
  async execute(input, ctx) {
    return scanResult(await new FliteClient(ctx).scanTicket("validate", scanLink(input.scanLink)));
  },
} satisfies ActionDefinition<{ scanLink: string }>;
