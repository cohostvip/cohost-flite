import type { AppDefinition } from "@w6w/types";
import { production as bearerProduction, staging as bearerStaging } from "./auth/bearer-token.ts";
import { production, staging } from "./auth/partner-session.ts";
import listOrganizations from "./actions/list-organizations.ts";
import listEvents from "./actions/list-events.ts";
import getEvent from "./actions/get-event.ts";
import createEvent from "./actions/create-event.ts";
import updateEvent from "./actions/update-event.ts";
import controlEvent from "./actions/control-event.ts";
import deleteEvent from "./actions/delete-event.ts";
import getTicket from "./actions/get-ticket.ts";
import createTicket from "./actions/create-ticket.ts";
import updateTicket from "./actions/update-ticket.ts";
import deleteTicket from "./actions/delete-ticket.ts";
import listOrders from "./actions/list-orders.ts";
import getOrder from "./actions/get-order.ts";
import validateTicket from "./actions/validate-ticket.ts";
import checkInTicket from "./actions/check-in-ticket.ts";
import getWebhook from "./actions/get-webhook.ts";
import registerWebhook from "./actions/register-webhook.ts";
import orderPlaced from "./triggers/order-placed.ts";

export default {
  actions: [
    listOrganizations,
    listEvents,
    getEvent,
    createEvent,
    updateEvent,
    controlEvent,
    deleteEvent,
    getTicket,
    createTicket,
    updateTicket,
    deleteTicket,
    listOrders,
    getOrder,
    validateTicket,
    checkInTicket,
    getWebhook,
    registerWebhook,
  ],
  // Partner sessions renew themselves; pasted bearer tokens remain for existing connections.
  auth: [production, staging, bearerProduction, bearerStaging],
  triggers: [orderPlaced],
} satisfies AppDefinition;
