// Every Flite endpoint wrapped as an action, replayed against anonymized live captures
// (tests/fixtures/live/staging-*: a throwaway event and ticket created, changed and deleted on
// Flite staging; scanner verdicts from a staging ticket).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FileCapability, FileRef, HookContext } from "@w6w/types";
import listOrganizations from "../actions/list-organizations.ts";
import listEvents, { type ListEventsInput } from "../actions/list-events.ts";
import getEvent from "../actions/get-event.ts";
import createEvent from "../actions/create-event.ts";
import updateEvent from "../actions/update-event.ts";
import deleteEvent from "../actions/delete-event.ts";
import getTicket from "../actions/get-ticket.ts";
import createTicket from "../actions/create-ticket.ts";
import updateTicket from "../actions/update-ticket.ts";
import deleteTicket from "../actions/delete-ticket.ts";
import listOrders from "../actions/list-orders.ts";
import validateTicket from "../actions/validate-ticket.ts";
import checkInTicket from "../actions/check-in-ticket.ts";
import { API_URL, STAGING_API_URL } from "../lib/client.ts";
import { multipart } from "../lib/fields.ts";
import { scanLink } from "../lib/scanner.ts";
import { context } from "../../../tests/fixtures.ts";
import { readCapture, replayCapture } from "../../../tests/live-fixtures.ts";

const json = (init: RequestInit) => JSON.parse(String(init.body));
const url = (request: { url: string }) => new URL(request.url);

function textFields(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  form.forEach((value, key) => {
    if (typeof value === "string") fields[key] = value;
  });
  return fields;
}

function withFile(ctx: HookContext, contentType = "image/png", filename = "flyer.png") {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
  const reads: unknown[] = [];
  const file: FileCapability = {
    async read(ref) {
      reads.push(ref);
      const fileRef: FileRef = {
        kind: "file", id: "file_1", contentType, size: bytes.length, filename, expiresAt: "2099-01-01T00:00:00Z",
      };
      return { ref: fileRef, bytes };
    },
    async create() {
      throw new Error("not used");
    },
  };
  return { ctx: { ...ctx, file }, bytes, reads };
}

const newEvent = {
  eventName: "Summer Night",
  description: "Line one\nLine two",
  venueName: "Hall",
  venueLocation: "1 Example Avenue",
  city: "New York",
  state: "New York",
  zipCode: "10001",
  showEvent: false,
  rsvpCapacity: 10,
  startDate: "2027-07-15",
  endDate: "2027-07-16",
  startTime: "19:00",
  endTime: "02:00",
  flyer: "file_1",
};

test("list-organizations returns the account's organizations", async () => {
  const { ctx, requests } = context([replayCapture("organizations-partner")]);
  const result = await listOrganizations.execute({}, ctx);
  assert.equal(requests[0].url, `${API_URL}/get-all-orgs-partner`);
  assert.equal(result.count, 1);
  assert.equal(result.organizations[0]._id, readCapture<{ data: Array<{ _id: string }> }>("organizations-partner").body.data[0]._id);
});

test("list-events sends paging and filters, and returns Flite's pagination", async () => {
  const capture = readCapture<{ data: unknown[]; pagination: unknown }>("staging-events-page-1");
  const { ctx, requests } = context([replayCapture("staging-events-page-1")], true);
  const result = await listEvents.execute({
    page: 2, limit: 5, status: ["Approved", "Pending", "Approved"], date: "2027-07-15", search: " jazz ",
  }, ctx);
  const sent = url(requests[0]);
  assert.equal(sent.origin + sent.pathname, `${STAGING_API_URL}/get-events-all`);
  assert.deepEqual(Object.fromEntries(sent.searchParams), {
    page: "2", limit: "5", status: "Approved,Pending", date: "2027-07-15", search: "jazz",
  });
  assert.equal(result.count, capture.body.data.length);
  assert.deepEqual(result.pagination, capture.body.pagination);
});

test("list-events defaults to page 1 and accepts a CSV status; bad input never reaches Flite", async () => {
  const { ctx, requests } = context([replayCapture("staging-events-page-1")]);
  await listEvents.execute({ status: "Pending" }, ctx);
  assert.deepEqual(Object.fromEntries(url(requests[0]).searchParams), { page: "1", status: "Pending" });
  const invalid: Array<[ListEventsInput, RegExp]> = [
    [{ limit: 41 }, /1 to 40/],
    [{ page: 0 }, /Page/],
    [{ status: ["Deleted"] }, /Approved or Pending/],
    [{ date: "15/07/2027" }, /YYYY-MM-DD/],
  ];
  for (const [input, error] of invalid) {
    await assert.rejects(listEvents.execute(input, ctx), error);
  }
  assert.equal(requests.length, 1);
});

test("get-event reads the event alone when tickets are not wanted; deleted events still resolve", async () => {
  const { ctx, requests } = context([replayCapture("staging-event-after-delete"), replayCapture("staging-event-with-tickets")]);
  const alone = await getEvent.execute({ eventId: "urn:1:c:s:/events/abc", includeTickets: false }, ctx);
  assert.equal(requests[0].url, `${API_URL}/get-event-by-id?eventId=abc`);
  assert.equal(alone.event.status, "Deleted");
  assert.equal("tickets" in alone.event, false);
  const full = await getEvent.execute({ eventId: "abc" }, ctx);
  assert.equal(url(requests[1]).pathname, "/api/get-event-tickets-info");
  assert.ok("tickets" in full.event && Array.isArray(full.event.tickets));
});

test("an event Flite does not let the organization read fails without echoing Flite's message", async () => {
  const { ctx } = context([replayCapture("staging-event-unauthorized")]);
  await assert.rejects(getEvent.execute({ eventId: "abc", includeTickets: false }, ctx), (error: Error) => {
    assert.match(error.message, /HTTP 400/);
    assert.doesNotMatch(error.message, /authorized/);
    return true;
  });
});

test("create-event uploads the documented fields and the flyer as multipart bytes", async () => {
  const base = context([replayCapture("staging-event-created")]);
  const { ctx, bytes, reads } = withFile(base.ctx);
  const result = await createEvent.execute(newEvent, ctx);
  const created = readCapture<{ data: { _id: string } }>("staging-event-created").body.data;
  assert.equal(result.eventId, created._id);
  assert.deepEqual(reads, ["file_1"]);

  const [request] = base.requests;
  assert.equal(request.url, `${API_URL}/create-event-partner`);
  assert.equal(request.init.method, "POST");
  assert.ok(request.init.body instanceof Uint8Array, "the sandbox carries bytes, not FormData");
  const contentType = new Headers(request.init.headers).get("content-type")!;
  assert.match(contentType, /^multipart\/form-data; boundary=----w6w-flite-[0-9a-f]{32}$/);
  const form = await new Response(request.init.body as Uint8Array<ArrayBuffer>, { headers: { "content-type": contentType } }).formData();
  assert.deepEqual(
    textFields(form),
    {
      eventName: "Summer Night", description: "Line one\nLine two", venueName: "Hall", venueLocation: "1 Example Avenue",
      city: "New York", state: "New York", zipCode: "10001", showEvent: "false", rsvpCapacity: "10",
      startDate: "2027-07-15", endDate: "2027-07-16", startTime: "19:00", endTime: "02:00",
    },
  );
  const flyer = form.get("hostFlyer") as File;
  assert.equal(flyer.name, "flyer.png");
  assert.equal(flyer.type, "image/png");
  assert.deepEqual(new Uint8Array(await flyer.arrayBuffer()), bytes);
});

test("create-event validates before reading the flyer or calling Flite", async () => {
  const base = context();
  const { ctx, reads } = withFile(base.ctx);
  for (const [patch, error] of [
    [{ venueName: "" }, /Venue name is required/],
    [{ startDate: "2027-02-30" }, /YYYY-MM-DD/],
    [{ endDate: "2027-07-14" }, /before the start date/],
    [{ startTime: "7pm" }, /HH:mm/],
    [{ rsvpCapacity: -1 }, /RSVP capacity/],
    [{ flyer: "" }, /Flyer image is required/],
  ] as const) {
    await assert.rejects(createEvent.execute({ ...newEvent, ...patch }, ctx), error);
  }
  assert.equal(reads.length, 0);
  assert.equal(base.requests.length, 0);
  await assert.rejects(createEvent.execute(newEvent, base.ctx), /file access/);
  await assert.rejects(createEvent.execute(newEvent, withFile(base.ctx, "application/pdf").ctx), /PNG, JPEG/);
  assert.equal(base.requests.length, 0);
});

test("create-event surfaces Flite's validation rejection as an HTTP error", async () => {
  const base = context([replayCapture("staging-event-create-invalid")]);
  await assert.rejects(createEvent.execute(newEvent, withFile(base.ctx).ctx), /create-event-partner failed \(HTTP 400\)/);
});

test("multipart encoding round-trips and refuses header injection", async () => {
  const { body, contentType } = multipart({ a: "1", b: "x\r\ny" }, [
    { name: "f", filename: "a b.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
  ], "BOUNDARY");
  assert.equal(contentType, "multipart/form-data; boundary=BOUNDARY");
  const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  assert.equal(form.get("b"), "x\r\ny");
  assert.equal((form.get("f") as File).name, "a b.png");
  assert.throws(() => multipart({ 'x"; filename="evil': "1" }, []), /Field name/);
  assert.throws(() => multipart({}, [{ name: "f", filename: "a\r\nX-Injected: 1", contentType: "image/png", bytes: new Uint8Array() }]), /File name/);
});

test("update-event sends only the fields that are set, with showEvent as Flite's string", async () => {
  const { ctx, requests } = context([replayCapture("staging-event-updated")]);
  const { event } = await updateEvent.execute({ eventId: "abc", eventName: " New name ", showEvent: true, rsvpCapacity: 12, endTime: "23:30" }, ctx);
  assert.equal(requests[0].url, `${API_URL}/update-event-properties`);
  assert.deepEqual(json(requests[0].init), { eventId: "abc", eventName: "New name", showEvent: "true", rsvpCapacity: 12, endTime: "23:30" });
  assert.equal(event.eventId, readCapture<{ data: { eventId: string } }>("staging-event-updated").body.data.eventId);
  await assert.rejects(updateEvent.execute({ eventId: "abc" }, ctx), /at least one/);
  await assert.rejects(updateEvent.execute({ eventId: "abc", startDate: "2027-07-16", endDate: "2027-07-15" }, ctx), /before/);
  assert.equal(requests.length, 1);
});

test("delete-event soft-deletes by query and reports the Deleted status", async () => {
  const { ctx, requests } = context([replayCapture("staging-event-deleted")]);
  const result = await deleteEvent.execute({ eventId: "abc" }, ctx);
  assert.equal(requests[0].init.method, "DELETE");
  assert.equal(requests[0].url, `${API_URL}/delete-event-partner?eventId=abc`);
  assert.equal(requests[0].init.body, undefined);
  assert.equal(result.status, "Deleted");
});

test("create-ticket sends the required name and price plus the optional fields set", async () => {
  const { ctx, requests } = context([replayCapture("staging-ticket-created")]);
  const result = await createTicket.execute({
    eventId: "abc", ticketName: "GA", ticketPrice: 0, capacity: 5, availability: "hide",
  }, ctx);
  assert.equal(requests[0].url, `${API_URL}/create-new-ticket`);
  assert.deepEqual(json(requests[0].init), { eventId: "abc", ticketName: "GA", ticketPrice: 0, capacity: 5, availability: "hide" });
  assert.equal(result.ticketId, readCapture<{ data: { _id: string } }>("staging-ticket-created").body.data._id);
  for (const [patch, error] of [
    [{ ticketPrice: -1 }, /nonnegative/],
    [{ ticketPrice: undefined }, /price is required/],
    [{ ticketName: " " }, /name is required/],
    [{ availability: "maybe" }, /availability/],
    [{ capacity: 1.5 }, /Capacity/],
  ] as const) {
    const valid = { eventId: "abc", ticketName: "GA", ticketPrice: 10 };
    await assert.rejects(createTicket.execute({ ...valid, ...patch } as never, ctx), error);
  }
  assert.equal(requests.length, 1);
});

test("get-ticket reads one ticket; a deleted ticket is Flite's 404", async () => {
  const { ctx, requests } = context([replayCapture("staging-ticket"), replayCapture("staging-ticket-not-found")]);
  const { ticket } = await getTicket.execute({ eventId: "urn:1:c:s:/events/e1", ticketId: "urn:1:c:s:/events/e1/tickets/t1" }, ctx);
  assert.equal(requests[0].url, `${API_URL}/get-ticket-by-id?eventId=e1&ticketId=t1`);
  assert.equal(typeof ticket.sold, "number");
  await assert.rejects(getTicket.execute({ eventId: "e1", ticketId: "t1" }, ctx), /HTTP 404/);
});

test("update-ticket covers name, description and max per cart; an empty description clears it", async () => {
  const { ctx, requests } = context([replayCapture("staging-ticket-updated"), replayCapture("staging-ticket-updated")]);
  const { result } = await updateTicket.execute({ eventId: "e1", ticketId: "t1", ticketName: "VIP", maxCart: 4 }, ctx);
  assert.deepEqual(json(requests[0].init), { eventId: "e1", ticketId: "t1", ticketName: "VIP", maxCart: 4 });
  assert.equal(result.maxCart, readCapture<{ data: { maxCart: number } }>("staging-ticket-updated").body.data.maxCart);
  await updateTicket.execute({ eventId: "e1", ticketId: "t1", description: "" }, ctx);
  assert.deepEqual(json(requests[1].init), { eventId: "e1", ticketId: "t1", description: "" });
  await assert.rejects(updateTicket.execute({ eventId: "e1", ticketId: "t1", maxCart: 0 }, ctx), /Max per cart/);
});

test("delete-ticket deletes by event and ticket ID", async () => {
  const { ctx, requests } = context([replayCapture("staging-ticket-deleted")]);
  const { ticket } = await deleteTicket.execute({ eventId: "e1", ticketId: "t1" }, ctx);
  assert.equal(requests[0].init.method, "DELETE");
  assert.equal(requests[0].url, `${API_URL}/delete-ticket-partner?eventId=e1&ticketId=t1`);
  assert.equal(ticket.isDeleted, true);
});

test("list-orders passes an optional page size", async () => {
  const { ctx, requests } = context([replayCapture("event-9-orders-page-1")]);
  await listOrders.execute({ eventId: "e1", page: 1, limit: 2 }, ctx);
  assert.equal(requests[0].url, `${API_URL}/get-orders-by-event?eventId=e1&page=1&limit=2`);
  await assert.rejects(listOrders.execute({ eventId: "e1", limit: 0 }, ctx), /Limit/);
});

test("validate-ticket: valid, unknown (404) and already used (409) are all verdicts", async () => {
  const { ctx, requests } = context([
    replayCapture("staging-scan-validate"),
    replayCapture("staging-scan-validate-not-found"),
    replayCapture("staging-scan-validate-checked-in"),
  ], true);
  const valid = await validateTicket.execute({ scanLink: "https://flite.city/Tickets/ABC123XYZ/scan" }, ctx);
  assert.equal(requests[0].url, `${STAGING_API_URL}/scanner/ticket/validate`);
  assert.deepEqual(json(requests[0].init), { scanLink: "https://flite.city/Tickets/ABC123XYZ/scan" });
  assert.deepEqual([valid.valid, valid.checkedIn, valid.errorCode], [true, false, null]);
  const unknown = await validateTicket.execute({ scanLink: "NOTAREALTICKET" }, ctx);
  assert.deepEqual(json(requests[1].init), { scanLink: "https://flite.city/Tickets/NOTAREALTICKET/scan" });
  assert.deepEqual([unknown.valid, unknown.errorCode], [false, "TICKET_NOT_FOUND"]);
  const used = await validateTicket.execute({ scanLink: "ABC123XYZ" }, ctx);
  assert.deepEqual([used.valid, used.checkedIn, used.errorCode], [false, true, "ALREADY_CHECKED_IN"]);
});

test("check-in-ticket checks in once; a repeat is ALREADY_CHECKED_IN", async () => {
  const { ctx, requests } = context([replayCapture("staging-scan-checkin"), replayCapture("staging-scan-checkin-repeat")]);
  const first = await checkInTicket.execute({ scanLink: "ABC123XYZ" }, ctx);
  assert.equal(requests[0].url, `${API_URL}/scanner/ticket/checkin`);
  assert.deepEqual([first.valid, first.checkedIn], [true, true]);
  assert.ok(first.result.checkInTime);
  const again = await checkInTicket.execute({ scanLink: "ABC123XYZ" }, ctx);
  assert.deepEqual([again.valid, again.errorCode], [false, "ALREADY_CHECKED_IN"]);
});

test("scanner failures that carry no verdict are errors", async () => {
  const { ctx } = context([
    Response.json({ success: false, message: "Not found" }, { status: 404 }),
    new Response("oops", { status: 409 }),
    Response.json({ success: false, data: { isValid: false } }, { status: 500 }),
  ]);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(checkInTicket.execute({ scanLink: "ABC123XYZ" }, ctx), /HTTP (404|409|500)/);
  }
  for (const bad of ["", "ab", "javascript:alert(1)", "not a link"]) {
    assert.throws(() => scanLink(bad), /Scan link|barcode|web link|link/);
  }
});
