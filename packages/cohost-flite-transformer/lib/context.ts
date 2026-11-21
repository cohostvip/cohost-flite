import type { Param } from "@w6w/types";

/** Cohost source identity; a W6W connection id is not a Cohost connection id. */
export interface SourceContext {
  companyId: string;
  connectionId: string;
  organizerId?: string;
}

export const sourceParams: Param[] = [
  { key: "companyId", label: "Cohost company ID", type: "string", required: true },
  {
    key: "connectionId",
    label: "Cohost source connection ID",
    type: "string",
    required: true,
    hint: "The source identity used by your Cohost mappings, not the W6W connection ID.",
  },
];

export function resourceContext(source: SourceContext) {
  for (const key of ["companyId", "connectionId"] as const) {
    if (typeof source[key] !== "string" || !/^[^\s:/?#]+$/.test(source[key])) {
      throw new Error(`${key} is required and must be a valid URN segment`);
    }
  }
  return {
    generateResourceUri(path: string) {
      return `urn:1:${source.companyId}:${source.connectionId}:${path}`;
    },
  };
}
