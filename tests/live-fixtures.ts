import { readFileSync } from "node:fs";

/** Shared by both packages; resolves relative to this module, independent of cwd. */
export function readFixture<T>(name: string): T {
  if (!/^[a-z0-9-]+\.(response|derived)\.json$/.test(name)) {
    throw new Error("Invalid fixture filename");
  }
  return JSON.parse(readFileSync(new URL(`./fixtures/live/${name}`, import.meta.url), "utf8"));
}

export function readCapture<T>(name: string): { status: number; body: T } {
  return readFixture<{ status: number; body: T }>(`${name}.response.json`);
}

export function replayCapture(name: string): Response {
  const { status, body } = readCapture<unknown>(name);
  return Response.json(body, { status });
}
