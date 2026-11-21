import type { ActionDefinition } from "@w6w/types";
import { FliteClient } from "../lib/client.ts";
import { scanLink, scanOutput, scanParams, scanResult } from "../lib/scanner.ts";

export default {
  key: "check-in-ticket",
  title: "Check In Ticket",
  type: "perform",
  resource: "scanner",
  // A repeat answers ALREADY_CHECKED_IN, so a blind retry would report a successful check-in as rejected.
  idempotent: false,
  description:
    "Validate a scanned ticket and check it in. An unknown ticket (TICKET_NOT_FOUND) or one already checked in (ALREADY_CHECKED_IN) returns valid=false, not an error.",
  params: scanParams,
  output: scanOutput,
  async execute(input, ctx) {
    return scanResult(await new FliteClient(ctx).scanTicket("checkin", scanLink(input.scanLink)));
  },
} satisfies ActionDefinition<{ scanLink: string }>;
