import type { Param } from "@w6w/types";

/** Cohost source identity; a W6W connection id is not a Cohost connection id. */
export interface SourceContext {
  companyId: string;
  connectionId: string;
  organizerId?: string;
}

const companyIdParam = (): Param => {
  const param: Param & { hidden: boolean } = {
    key: "companyId",
    label: "Company ID",
    type: "string",
    required: true,
    hidden: true,
    default: "{{ const.account_id }}",
  };
  return param;
};

export const sourceParams: Param[] = [
  companyIdParam(),
  {
    key: "connectionId",
    label: "Flite connection ID",
    type: "string",
    required: true,
    hint: "The Flite connection the data came through: bind it to the Flite step's Connection ID ({{ steps.<flite step>.meta.connectionId }}). It is the source segment of every URN, the same one Sync Event registers mappings under. No connection, no transform.",
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
