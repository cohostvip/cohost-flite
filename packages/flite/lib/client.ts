import type { HookContext } from "@w6w/types";
import type {
  FliteCreatedEvent,
  FliteCreatedTicket,
  FliteDeletedEvent,
  FliteDeletedTicket,
  FliteEvent,
  FliteEventEndState,
  FliteEventListPagination,
  FliteEventSummary,
  FliteEventUpdate,
  FliteEventWithTickets,
  FliteOrder,
  FliteOrderListItem,
  FliteOrganization,
  FlitePagination,
  FliteTicket,
  FliteTicketUpdate,
  FliteTicketValidation,
} from "@cohost/flite-types";
import { multipart, type MultipartFile } from "./fields.ts";

/** Flite caps `get-events-all` at 40 per page and silently clamps anything larger. */
export const MAX_EVENTS_PER_PAGE = 40;

export const API_URL = "https://api-main.fliteapi.city/api";
export const STAGING_API_URL = "https://api-staging.fliteapi.city/api";

/** Every staging auth key ends in `-staging` (`bearer-token-staging`, `partner-login-staging`). */
export function baseUrl(ctx: Pick<HookContext, "connection">): string {
  return ctx.connection?.auth?.endsWith("-staging") ? STAGING_API_URL : API_URL;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Flite returned an invalid response object");
  }
  return value as Record<string, unknown>;
}

/** The body as a JSON object, or undefined when it is not one. */
async function jsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return object(await response.json());
  } catch {
    return undefined;
  }
}

const ORDERS_BY_EVENT = "/get-orders-by-event";

/** Flite answers an event without completed orders with this failure, usually as HTTP 404. */
function noCompletedOrders(path: string, result: Record<string, unknown> | undefined): boolean {
  return path === ORDERS_BY_EVENT && result?.success !== true && result?.message === "No completed orders found";
}

function emptyOrdersPage(page: string | number = 1) {
  return { success: true, data: { orders: [], pagination: { hasMore: false, currentPage: page, nextPage: null } } };
}

export function resourceId(value: string, resource: "events" | "tickets" | "orders"): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${resource} ID is required`);
  if (!value.startsWith("urn:") && !value.startsWith("/")) return value.trim();
  const match = value.match(new RegExp(`/${resource}/([^/?#]+)$`));
  if (!match) throw new Error(`Invalid ${resource} URN or path`);
  return match[1];
}

export class FliteClient {
  readonly ctx: HookContext;
  constructor(ctx: HookContext) {
    this.ctx = ctx;
  }

  async request(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string | number>;
      body?: unknown;
      /** A pre-encoded body (multipart upload) with its content type. */
      raw?: { body: Uint8Array<ArrayBuffer>; contentType: string };
      /**
       * Failure statuses whose JSON body is the answer rather than an error (the scanner reports an
       * unknown or already-used ticket as 404/409 with a verdict in `data`). Returned unchanged when
       * the body has a `data` object.
       */
      answers?: number[];
    } = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${baseUrl(this.ctx)}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const json = options.body !== undefined;
    const response = await this.ctx.fetch(url.toString(), {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(json ? { "content-type": "application/json" } : {}),
        ...(options.raw ? { "content-type": options.raw.contentType } : {}),
      },
      ...(json ? { body: JSON.stringify(options.body) } : {}),
      ...(options.raw ? { body: options.raw.body } : {}),
    });
    // Do not echo provider bodies: they may contain customer data or credentials.
    const httpError = () => new Error(`Flite ${options.method ?? "GET"} ${path} failed (HTTP ${response.status})`);
    if (options.answers?.includes(response.status)) {
      const answer = await jsonObject(response);
      if (answer?.data && typeof answer.data === "object" && !Array.isArray(answer.data)) return answer;
      throw httpError();
    }
    if (!response.ok) {
      if (response.status === 404 && noCompletedOrders(path, await jsonObject(response))) {
        return emptyOrdersPage(options.query?.page);
      }
      throw httpError();
    }
    const result = object(await response.json());
    if (result.success === true) return result;
    if (noCompletedOrders(path, result)) return emptyOrdersPage(options.query?.page);
    throw new Error(`Flite ${path} reported failure`);
  }

  async getOrder(orderId: string): Promise<FliteOrder> {
    const result = await this.request("/get-order-by-id", {
      query: { orderId: resourceId(orderId, "orders") },
    });
    const data = object(result.data);
    const order = object(data.order ?? data);
    if (typeof order._id !== "string" || !order._id) {
      throw new Error("Flite returned an invalid order");
    }
    return order as unknown as FliteOrder;
  }

  async getEvent(eventId: string): Promise<FliteEventWithTickets> {
    const result = await this.request("/get-event-tickets-info", {
      query: { eventId: resourceId(eventId, "events") },
    });
    const event = object(result.data);
    if (typeof event._id !== "string" || !Array.isArray(event.tickets)) {
      throw new Error("Flite returned an invalid event");
    }
    return event as unknown as FliteEventWithTickets;
  }

  async listOrders(
    eventId: string,
    page = 1,
    limit?: number,
  ): Promise<{ orders: FliteOrderListItem[]; count: number; pagination: FlitePagination | null }> {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("Page must be a positive integer");
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error("Limit must be a positive integer");
    }
    const result = await this.request(ORDERS_BY_EVENT, {
      query: { eventId: resourceId(eventId, "events"), page, ...(limit === undefined ? {} : { limit }) },
    });
    const data = object(result.data);
    if (!Array.isArray(data.orders)) throw new Error("Flite returned an invalid orders list");
    return {
      orders: data.orders as FliteOrderListItem[],
      count: data.orders.length,
      pagination: (data.pagination as FlitePagination | undefined) ?? null,
    };
  }

  async listOrganizations(): Promise<FliteOrganization[]> {
    const result = await this.request("/get-all-orgs-partner");
    if (!Array.isArray(result.data)) throw new Error("Flite returned an invalid organization list");
    return result.data as FliteOrganization[];
  }

  async listEvents(options: {
    page?: number;
    limit?: number;
    status?: string[];
    date?: string;
    search?: string;
  } = {}): Promise<{ events: FliteEventSummary[]; count: number; pagination: FliteEventListPagination | null }> {
    const page = options.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("Page must be a positive integer");
    const { limit } = options;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS_PER_PAGE)) {
      throw new Error(`Limit must be an integer from 1 to ${MAX_EVENTS_PER_PAGE}`);
    }
    const query: Record<string, string | number> = { page };
    if (limit !== undefined) query.limit = limit;
    if (options.status?.length) query.status = options.status.join(",");
    if (options.date) query.date = options.date;
    if (options.search) query.search = options.search;
    const result = await this.request("/get-events-all", { query });
    if (!Array.isArray(result.data)) throw new Error("Flite returned an invalid event list");
    return {
      events: result.data as FliteEventSummary[],
      count: result.data.length,
      pagination: (result.pagination as FliteEventListPagination | undefined) ?? null,
    };
  }

  /** The event without its tickets. A deleted event is still returned, with status `Deleted`. */
  async getEventById(eventId: string): Promise<FliteEvent> {
    const result = await this.request("/get-event-by-id", { query: { eventId: resourceId(eventId, "events") } });
    const event = object(result.data);
    if (typeof event._id !== "string") throw new Error("Flite returned an invalid event");
    return event as unknown as FliteEvent;
  }

  async createEvent(fields: Record<string, string>, flyer: Omit<MultipartFile, "name">): Promise<FliteCreatedEvent> {
    const result = await this.request("/create-event-partner", {
      method: "POST",
      raw: multipart(fields, [{ ...flyer, name: "hostFlyer" }]),
    });
    const event = object(result.data);
    if (typeof event._id !== "string") throw new Error("Flite returned an invalid event");
    return event as unknown as FliteCreatedEvent;
  }

  async updateEvent(body: Record<string, unknown>): Promise<FliteEventUpdate> {
    const result = await this.request("/update-event-properties", { method: "POST", body });
    return object(result.data) as unknown as FliteEventUpdate;
  }

  async setEventEnded(eventId: string, ended: boolean): Promise<FliteEventEndState> {
    const result = await this.request("/update-event-end-toggle", {
      method: "POST",
      body: { eventId: resourceId(eventId, "events"), isEventEnd: ended },
    });
    // A successful write without a body echo is still a success.
    return object(result.data ?? {}) as unknown as FliteEventEndState;
  }

  /** Soft delete. Flite refuses events with Hold or Complete orders. */
  async deleteEvent(eventId: string): Promise<FliteDeletedEvent> {
    const result = await this.request("/delete-event-partner", {
      method: "DELETE",
      query: { eventId: resourceId(eventId, "events") },
    });
    return object(result.data) as unknown as FliteDeletedEvent;
  }

  async createTicket(body: Record<string, unknown>): Promise<FliteCreatedTicket> {
    const result = await this.request("/create-new-ticket", { method: "POST", body });
    const ticket = object(result.data);
    if (typeof ticket._id !== "string") throw new Error("Flite returned an invalid ticket");
    return ticket as unknown as FliteCreatedTicket;
  }

  /** Only tickets that are not deleted are returned; a deleted ticket is HTTP 404. */
  async getTicket(eventId: string, ticketId: string): Promise<FliteTicket> {
    const result = await this.request("/get-ticket-by-id", {
      query: { eventId: resourceId(eventId, "events"), ticketId: resourceId(ticketId, "tickets") },
    });
    const ticket = object(result.data);
    if (typeof ticket._id !== "string") throw new Error("Flite returned an invalid ticket");
    return ticket as unknown as FliteTicket;
  }

  async updateTicket(body: Record<string, unknown>): Promise<FliteTicketUpdate> {
    const result = await this.request("/update-ticket-properties", { method: "POST", body });
    return object(result.data ?? {}) as unknown as FliteTicketUpdate;
  }

  async deleteTicket(eventId: string, ticketId: string): Promise<FliteDeletedTicket> {
    const result = await this.request("/delete-ticket-partner", {
      method: "DELETE",
      query: { eventId: resourceId(eventId, "events"), ticketId: resourceId(ticketId, "tickets") },
    });
    return object(result.data) as unknown as FliteDeletedTicket;
  }

  /**
   * Scanner verdict for a ticket QR link. `validate` only reads; `checkin` marks the ticket used.
   * An unknown ticket (404) or an already checked-in one (409) is a verdict, not an error.
   */
  async scanTicket(mode: "validate" | "checkin", scanLink: string): Promise<FliteTicketValidation> {
    const result = await this.request(`/scanner/ticket/${mode}`, {
      method: "POST",
      body: { scanLink },
      answers: [404, 409],
    });
    const verdict = object(result.data);
    if (typeof verdict.isValid !== "boolean") throw new Error("Flite returned an invalid scanner verdict");
    return verdict as unknown as FliteTicketValidation;
  }

  async getWebhook(): Promise<string | null> {
    const result = await this.request("/get-webhook-url");
    // Live responses wrap the URL in `data`; the original runtime app read it top-level.
    const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    const webhookUrl = "webhookUrl" in data ? data.webhookUrl : result.webhookUrl;
    if (webhookUrl == null || webhookUrl === "") return null;
    if (typeof webhookUrl !== "string") {
      throw new Error("Flite returned an invalid webhook URL");
    }
    return webhookUrl;
  }

  async registerWebhook(webhookUrl: string, replaceExisting = false) {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("Webhook URL must use HTTPS without user credentials");
    }
    const previousUrl = await this.getWebhook();
    if (previousUrl === webhookUrl) {
      return { success: true, webhookUrl, previousUrl, changed: false };
    }
    if (previousUrl && !replaceExisting) {
      throw new Error("Flite already has a webhook URL. Set replaceExisting to replace it.");
    }
    await this.request("/update-webhook-url", { method: "PUT", body: { webhookUrl } });
    return { success: true, webhookUrl, previousUrl, changed: true };
  }
}
