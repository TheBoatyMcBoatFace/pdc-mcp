import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchDatasets,
  getDataset,
  getDistributionSchema,
  queryDistribution,
  getCategories,
} from "./pdc.js";

const INSTRUCTIONS = `This server exposes the CMS Provider Data Catalog (data.cms.gov/provider-data):
official U.S. Medicare quality, cost, and directory data for healthcare providers.

It covers ~234 datasets in 10 provider-type categories:
Hospitals, Physician office visit costs, Dialysis facilities, Nursing homes including rehab
services, Home health services, Doctors and clinicians, Hospice care, Inpatient rehabilitation
facilities, Long-term care hospitals, and a Supplier directory.

Recommended workflow:
1. list_categories — see what provider types are available (start here for "what do you have?").
2. search_datasets — find datasets by keyword, optionally scoped to a category (theme).
3. get_dataset — get a dataset's distributions (its queryable tables, each a UUID).
4. get_dataset_schema — get exact column names before querying.
5. query_dataset — filter/sort/select rows; the result 'count' is the total matching rows.

Columns are snake_case. This data is read-only. Cite the dataset title and note figures are
from CMS when presenting results.`;

/** Wrap a tool body so any thrown error becomes a readable MCP result instead of a 500. */
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export class PdcMcp extends McpAgent {
  server = new McpServer(
    {
      name: "cms-pdc",
      version: "0.2.0",
    },
    { instructions: INSTRUCTIONS },
  );

  async init() {
    this.server.tool(
      "list_categories",
      "List the provider-type categories in the CMS Provider Data Catalog (e.g. Hospitals, " +
        "Dialysis facilities, Nursing homes) with the number of datasets in each and a few example " +
        "datasets. Call this to answer 'what data do you have access to?' and to help the user pick " +
        "an area before searching.",
      {},
      async () => {
        try {
          return ok(await getCategories());
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "search_datasets",
      "Search the CMS Provider Data Catalog for datasets by keyword (e.g. 'hospital readmissions', " +
        "'dialysis facilities', 'nursing home staffing'). Optionally scope to a category with " +
        "`theme` (exact name from list_categories) and/or a `keyword`. Returns dataset identifiers, " +
        "titles, and descriptions to inspect and query.",
      {
        query: z
          .string()
          .default("")
          .describe("Free-text search terms; leave empty to browse a whole theme"),
        theme: z
          .string()
          .optional()
          .describe("Restrict to a provider-type category, exact name from list_categories"),
        keyword: z.string().optional().describe("Restrict to datasets tagged with this keyword"),
        limit: z.number().int().min(1).max(50).default(10).describe("Max datasets to return"),
      },
      async ({ query, theme, keyword, limit }) => {
        try {
          return ok(await searchDatasets(query, { theme, keyword, pageSize: limit }));
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "get_dataset",
      "Get full metadata for one dataset by its identifier, including its list of distributions " +
        "(the queryable tables). Each distribution has an `identifier` (a UUID) that you pass to " +
        "get_dataset_schema and query_dataset.",
      {
        identifier: z.string().describe("Dataset identifier from search_datasets, e.g. '23ew-n7w9'"),
      },
      async ({ identifier }) => {
        try {
          return ok(await getDataset(identifier));
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "get_dataset_schema",
      "List the column names and types for a distribution (table). ALWAYS call this before " +
        "query_dataset so you use exact column names — CMS columns are snake_case (e.g. " +
        "'facility_name', 'state', 'cms_certification_number_ccn').",
      {
        distribution_id: z.string().describe("Distribution UUID from get_dataset"),
      },
      async ({ distribution_id }) => {
        try {
          return ok(await getDistributionSchema(distribution_id));
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "query_dataset",
      "Run a structured query against a distribution (table). Filter with conditions, pick columns " +
        "with `properties`, sort, and page with limit/offset. Column names must match " +
        "get_dataset_schema exactly. `count` in the result is the total matching rows (not just " +
        "the returned page).",
      {
        distribution_id: z.string().describe("Distribution UUID from get_dataset"),
        conditions: z
          .array(
            z.object({
              property: z.string().describe("Column name (snake_case)"),
              value: z
                .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
                .describe("Value to match; array when operator is 'in'/'not in'"),
              operator: z
                .enum(["=", "<>", "<", "<=", ">", ">=", "like", "in", "not in"])
                .default("=")
                .describe("Comparison operator. 'like' uses % wildcards."),
            }),
          )
          .optional()
          .describe("AND-combined filters"),
        properties: z
          .array(z.string())
          .optional()
          .describe("Columns to return; omit for all columns"),
        sorts: z
          .array(
            z.object({
              property: z.string(),
              order: z.enum(["asc", "desc"]).default("asc"),
            }),
          )
          .optional(),
        limit: z.number().int().min(1).max(500).default(20),
        offset: z.number().int().min(0).default(0),
      },
      async ({ distribution_id, conditions, properties, sorts, limit, offset }) => {
        try {
          return ok(
            await queryDistribution(distribution_id, {
              conditions,
              properties,
              sorts,
              limit,
              offset,
            }),
          );
        } catch (e) {
          return fail(e);
        }
      },
    );

    // Ambient catalog: clients that support resources can load the full category map as context.
    this.server.resource(
      "catalog",
      "pdc://catalog",
      {
        description:
          "The CMS Provider Data Catalog map: provider-type categories with dataset counts and examples.",
        mimeType: "application/json",
      },
      async (uri) => {
        const categories = await getCategories();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(categories, null, 2),
            },
          ],
        };
      },
    );

    // One-click discovery: helps a user who doesn't know what to ask for yet.
    this.server.prompt(
      "explore_cms_data",
      "Summarize what CMS provider data is available and suggest questions to ask.",
      async () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                "Call list_categories, then give me a short, friendly overview of the CMS provider " +
                "data categories available here, and suggest 3-4 concrete questions I could ask " +
                "(e.g. comparing facilities in my state). Keep it brief.",
            },
          },
        ],
      }),
    );
  }
}

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> | Response {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return PdcMcp.serve("/mcp").fetch(request, env as never, ctx);
    }
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return PdcMcp.serveSSE("/sse").fetch(request, env as never, ctx);
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        "CMS Provider Data Catalog MCP server. Connect a client to /mcp (Streamable HTTP) or /sse.",
        { headers: { "content-type": "text/plain" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
};
