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

/** Success result: return data as both structured content (validated against outputSchema)
 * and a JSON text block for clients that only read text. */
function ok(data: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}
/** Turn a thrown error into a readable MCP error result instead of a 500. */
function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

// ---- Output schemas (so clients like ChatGPT know the shape of each tool's result) ----
const zExample = z.object({ identifier: z.string(), title: z.string() });
const zCategory = z.object({
  theme: z.string(),
  datasetCount: z.number().int(),
  examples: z.array(zExample),
});
const zDatasetSummary = z.object({
  identifier: z.string(),
  title: z.string(),
  description: z.string(),
  theme: z.array(z.string()).optional(),
  modified: z.string().optional(),
  keyword: z.array(z.string()).optional(),
  landingPage: z.string().optional(),
});
const zDistribution = z.object({
  identifier: z.string(),
  title: z.string().optional(),
  format: z.string().optional(),
  downloadURL: z.string().optional(),
});
const zDatasetDetail = zDatasetSummary.extend({
  distributions: z.array(zDistribution),
  dataDictionary: z.array(z.string()).optional(),
});
const zColumn = z.object({
  name: z.string(),
  type: z.string(),
  label: z.string().optional(),
});
const zRow = z.record(z.string(), z.unknown());

export class PdcMcp extends McpAgent {
  server = new McpServer(
    {
      name: "cms-pdc",
      version: "0.4.0",
    },
    { instructions: INSTRUCTIONS },
  );

  async init() {
    this.server.registerTool(
      "list_categories",
      {
        description:
          "List the provider-type categories in the CMS Provider Data Catalog (e.g. Hospitals, " +
          "Dialysis facilities, Nursing homes) with the number of datasets in each and a few " +
          "example datasets. Call this to answer 'what data do you have access to?' and to help " +
          "the user pick an area before searching. Takes no arguments.",
        inputSchema: {},
        outputSchema: { categories: z.array(zCategory) },
      },
      async () => {
        try {
          return ok({ categories: await getCategories() });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "search_datasets",
      {
        description:
          "Search the CMS Provider Data Catalog for datasets by keyword (e.g. 'hospital " +
          "readmissions', 'dialysis facilities', 'nursing home staffing'). Optionally scope to a " +
          "category with `theme` (exact name from list_categories) and/or a `keyword`. Returns " +
          "dataset identifiers, titles, and descriptions to inspect and query.",
        inputSchema: {
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
        outputSchema: { datasets: z.array(zDatasetSummary) },
      },
      async ({ query, theme, keyword, limit }) => {
        try {
          return ok({ datasets: await searchDatasets(query, { theme, keyword, pageSize: limit }) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "get_dataset",
      {
        description:
          "Get full metadata for one dataset by its identifier, including its list of distributions " +
          "(the queryable tables). Each distribution has an `identifier` (a UUID) that you pass to " +
          "get_dataset_schema and query_dataset.",
        inputSchema: {
          identifier: z
            .string()
            .describe("Dataset identifier from search_datasets, e.g. '23ew-n7w9'"),
        },
        outputSchema: zDatasetDetail.shape,
      },
      async ({ identifier }) => {
        try {
          return ok(await getDataset(identifier));
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "get_dataset_schema",
      {
        description:
          "List the columns for a distribution (table): the snake_case `name` to use in queries, " +
          "its `type`, and CMS's human-readable `label` explaining what the column is (e.g. name " +
          "'mortality_rate_upper_confidence_limit_975' → label 'Mortality Rate: Upper Confidence " +
          "Limit (97.5%)'). ALWAYS call this before query_dataset so you use exact column names and " +
          "understand what each column means.",
        inputSchema: {
          distribution_id: z.string().describe("Distribution UUID from get_dataset"),
        },
        outputSchema: { columns: z.array(zColumn) },
      },
      async ({ distribution_id }) => {
        try {
          return ok({ columns: await getDistributionSchema(distribution_id) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.registerTool(
      "query_dataset",
      {
        description:
          "Run a structured query against a distribution (table). Filter with conditions, pick " +
          "columns with `properties`, sort, and page with limit/offset. Column names must match " +
          "get_dataset_schema exactly. `count` in the result is the total matching rows (not just " +
          "the returned page).",
        inputSchema: {
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
        outputSchema: { count: z.number().int(), results: z.array(zRow) },
      },
      async ({ distribution_id, conditions, properties, sorts, limit, offset }) => {
        try {
          const { count, results } = await queryDistribution(distribution_id, {
            conditions,
            properties,
            sorts,
            limit,
            offset,
          });
          return ok({ count, results });
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
