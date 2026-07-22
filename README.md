# CMS Provider Data Catalog MCP

A remote [MCP](https://modelcontextprotocol.io) server that lets an LLM (Claude, ChatGPT)
search and query datasets in the [CMS Provider Data Catalog](https://data.cms.gov/provider-data)
(hospitals, dialysis facilities, nursing homes, physicians, etc.).

Runs as a Cloudflare Worker using the [`agents`](https://github.com/cloudflare/agents) `McpAgent`.
The PDC API (DKAN) is read-only and unauthenticated, so the Worker is a thin, stateless proxy.

## Tools

| Tool | What it does |
|------|--------------|
| `search_datasets` | Full-text search for datasets by keyword → identifiers, titles, descriptions |
| `get_dataset` | Metadata for one dataset + its **distributions** (the queryable tables, each with a UUID) |
| `get_dataset_schema` | Column names + types for a distribution — call before querying |
| `query_dataset` | Structured query: `conditions` (filters), `properties` (column select), `sorts`, `limit`/`offset`. Returns rows + total match `count`. |

Intended workflow the tool descriptions steer the model toward:
**search → get_dataset → get_dataset_schema → query_dataset.**

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
- Possible additions: result caching (Cloudflare Cache API), a `list_datasets` browse tool,
  and per-dataset data-dictionary lookups for human-readable column labels.
