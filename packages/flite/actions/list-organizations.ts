import type { ActionDefinition } from "@w6w/types";
import { FliteClient } from "../lib/client.ts";

export default {
  key: "list-organizations",
  title: "List Organizations",
  type: "read",
  resource: "organization",
  idempotent: true,
  description:
    "List the Flite organizations the connected account belongs to. The connection acts for one of them.",
  params: [],
  output: [
    {
      key: "organizations",
      label: "Organizations",
      type: "array",
      items: [
        { key: "_id", label: "Organization ID", type: "string" },
        { key: "name", label: "Name", type: "string" },
        { key: "email", label: "Email", type: "string" },
        { key: "currency", label: "Currency", type: "string" },
      ],
    },
    { key: "count", label: "Count", type: "number" },
  ],
  async execute(_input, ctx) {
    const organizations = await new FliteClient(ctx).listOrganizations();
    return { organizations, count: organizations.length };
  },
} satisfies ActionDefinition<Record<string, never>>;
