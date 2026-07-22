# CMS Provider Data Catalog MCP

A remote [MCP](https://modelcontextprotocol.io) server that lets an LLM (Claude, ChatGPT)
search and query datasets in the [CMS Provider Data Catalog](https://data.cms.gov/provider-data)
(hospitals, dialysis facilities, nursing homes, physicians, etc.).

Runs as a Cloudflare Worker using the [`agents`](https://github.com/cloudflare/agents) `McpAgent`.
The PDC API (DKAN) is read-only and unauthenticated, so the Worker is a thin, stateless proxy.

## Discoverability

So a client (and the user) can tell at a glance what's available:

- **Server instructions** — the server advertises its 10 provider-type categories and the
  recommended workflow on connect, so the model knows its scope without any tool call.
- **`pdc://catalog` resource** — the browsable category map (themes, dataset counts, examples)
  as ambient context for clients that support MCP resources.
- **`explore_cms_data` prompt** — one-click "what CMS data can I explore?" for the user.

## Tools

| Tool | What it does |
|------|--------------|
| `list_categories` | The 10 provider-type categories (Hospitals, Dialysis facilities, …) with dataset counts + examples. Start here for "what do you have access to?" |
| `search_datasets` | Full-text search, optionally scoped to a `theme` (category) and/or `keyword` → identifiers, titles, descriptions |
| `get_dataset` | Metadata for one dataset + its **distributions** (queryable tables, each a UUID), theme, and data-dictionary link |
| `get_dataset_schema` | Column names + types for a distribution — call before querying |
| `query_dataset` | Structured query: `conditions` (filters), `properties` (column select), `sorts`, `limit`/`offset`. Returns rows + total match `count`. |

Intended workflow the tool descriptions steer the model toward:
**list_categories → search_datasets → get_dataset → get_dataset_schema → query_dataset.**

The full dataset list (used by `list_categories` and the catalog resource) is cached in-isolate
for 10 minutes, so discovery is a single upstream call.

## Develop

```bash
npm install
npm run dev          # wrangler dev, serves /mcp and /sse locally
npm run typecheck
```

Local smoke test (Streamable HTTP): POST an `initialize` to `http://localhost:8787/mcp`,
capture the `mcp-session-id` response header, send `notifications/initialized`, then
`tools/call`.

## Deploy

```bash
npm run deploy       # wrangler deploy
```

This creates the Durable Object (used by `McpAgent` for per-session state) on first deploy.

## Connect a client

After deploy you'll have a URL like `https://cms-pdc-mcp.<subdomain>.workers.dev`.

- **Streamable HTTP (preferred):** `https://.../mcp`
- **SSE (legacy clients):** `https://.../sse`

Add it as a custom connector in Claude, or via Developer Mode / connectors in ChatGPT.
No auth is required.

## Notes / next steps

- **Read-only.** Only `GET`/`POST` query endpoints of the PDC API are used; nothing writes.
- Raw SQL (`/datastore/sql`) is intentionally **not** exposed — structured queries only, to keep
  the model from writing broken/expensive queries against DKAN's bracketed SQL dialect.
- Distribution UUIDs change when CMS republishes a dataset, so always resolve them via
  `get_dataset` rather than caching them.
- Data dictionaries are published by CMS as **PDFs** (not machine-readable), so `get_dataset`
  surfaces the link but column meanings aren't returned as structured data.
- Possible additions: query-result caching (Cloudflare Cache API), aggregation/`GROUP BY`
  insights, and parsing the data-dictionary PDFs into structured column descriptions.
