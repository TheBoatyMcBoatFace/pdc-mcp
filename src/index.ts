import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchDatasets,
  getDataset,
  getDistributionSchema,
  queryDistribution,
} from "./pdc.js";

/** Wrap a tool body so any thrown error becomes a readable MCP result instead of a 500. */
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export class PdcMcp extends McpAgent {
  server = new McpServer({
    name: "cms-pdc",
    version: "0.1.0",
  });

  async init() {
    this.server.tool(
      "search_datasets",
      "Search the CMS Provider Data Catalog for datasets by keyword (e.g. 'hospital readmissions', " +
        "'dialysis facilities', 'nursing home staffing'). Returns dataset identifiers, titles, and " +
        "descriptions. Use this first to find which dataset to inspect and query.",
      {
        query: z.string().describe("Free-text search terms"),
        limit: z.number().int().min(1).max(50).default(10).describe("Max datasets to return"),
      },
      async ({ query, limit }) => {
        try {
          return ok(await searchDatasets(query, limit));
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
