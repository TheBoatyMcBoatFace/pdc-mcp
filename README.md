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
- **Typed output schemas** — every tool declares an `outputSchema` and returns `structuredContent`,
  so clients (e.g. ChatGPT dev mode) can parse and render results reliably instead of re-reading JSON.

## Tools

| Tool | What it does |
|------|--------------|
| `list_categories` | The 10 provider-type categories (Hospitals, Dialysis facilities, …) with dataset counts + examples. Start here for "what do you have access to?" |
| `search_datasets` | Full-text search, optionally scoped to a `theme` (category) and/or `keyword` → identifiers, titles, descriptions |
| `get_dataset` | Metadata for one dataset + its **distributions** (queryable tables, each a UUID), theme, and data-dictionary link |
| `get_dataset_schema` | Column `name` + `type` + CMS's human-readable `label` for a distribution — call before querying |
| `query_dataset` | Structured query: `conditions` (filters), `properties` (column select), `sorts`, `limit`/`offset`. Returns rows + total match `count`. |
| `aggregate_dataset` | GROUP BY aggregation: `count`/`sum`/`avg`/`min`/`max` metrics, optional `group_by`, `conditions` (WHERE), and `sorts` (rank by a metric). E.g. average star rating by state, facilities per state. |
| `compare_to_benchmarks` | One entity vs. benchmarks in a single call: each measure's value for a facility alongside the national average and its group (e.g. state) average, with cohort sizes. |

Intended workflow the tool descriptions steer the model toward:
**list_categories → search_datasets → get_dataset → get_dataset_schema → query_dataset / aggregate_dataset / compare_to_benchmarks.**

`compare_to_benchmarks` computes benchmarks as simple averages over the distribution's own rows
(transparent, in 3 upstream calls) — not CMS's separately published risk-adjusted State/National
Averages datasets, whose columns don't map 1:1 to facility columns. Those remain queryable
directly via the normal tools.

Aggregation uses DKAN's structured query (expression + `groupings`), not SQL — DKAN's SQL
endpoint doesn't support GROUP BY. Numeric columns stored as text are cast automatically, and
metric values are returned as numbers.

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

## Reliability & ops

All upstream calls to CMS go through one hardened `req()` helper (`src/pdc.ts`):

- **Retries with backoff** on transient failures (network errors, 5xx, 429); fails fast on 4xx.
- **Bounded timeout** (20s) with a clear timeout error rather than a hang.
- **Clean error messages** — DKAN's `{ message }` is surfaced (e.g. "Column not found.") instead
  of a raw JSON blob.
- **Short-TTL GET caching** (60s, Cloudflare Cache API) so repeated identical reads within a
  conversation don't re-hit CMS. POST queries/aggregations are always fresh.
- **Structured logs** (`{"at":"pdc",method,path,status,ms,cache}`) surface in Workers
  observability (enabled in `wrangler.jsonc`).

## Notes / next steps

- **Read-only.** Only `GET`/`POST` query endpoints of the PDC API are used; nothing writes.
- Raw SQL (`/datastore/sql`) is intentionally **not** exposed — structured queries only, to keep
  the model from writing broken/expensive queries against DKAN's bracketed SQL dialect.
- Distribution UUIDs change when CMS republishes a dataset, so always resolve them via
  `get_dataset` rather than caching them.
- **Column labels come for free.** DKAN stores each column's original CSV header as the field's
  `description`, so `get_dataset_schema` returns a human `label` for every column of all datasets
  (e.g. `mortality_rate_upper_confidence_limit_975` → "Mortality Rate: Upper Confidence Limit
  (97.5%)") with no PDF parsing.
- **Richer, sentence-level descriptions** live only in CMS's per-provider data-dictionary **PDFs**
  (9 of them, surfaced via `get_dataset`'s `dataDictionary` link). Auto-matching those to columns
  is unreliable: the PDFs use fixed-width tables *and* their Variable Labels diverge from the CSV
  headers (e.g. PDF "CMS Provider Name" vs column "Facility Name"). If we want them, the robust
  path is a one-time, spot-checked `column → description` map per provider, not regex parsing.
- Possible additions: query-result caching (Cloudflare Cache API) and aggregation/`GROUP BY`
  insights.
