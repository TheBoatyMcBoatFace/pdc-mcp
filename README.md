# CMS Provider Data Catalog MCP

A remote [MCP](https://modelcontextprotocol.io) server that lets an LLM (Claude, ChatGPT)
**explore, query, aggregate, and benchmark** the ~234 datasets in the
[CMS Provider Data Catalog](https://data.cms.gov/provider-data) — hospitals, dialysis facilities,
nursing homes, home health, hospice, physicians, and more — in plain language.

Runs as a Cloudflare Worker using the [`agents`](https://github.com/cloudflare/agents) `McpAgent`.
The PDC API (DKAN) is read-only and unauthenticated, so the Worker is a thin, stateless proxy.

**What it can do:** find datasets by category or keyword → inspect their columns (with CMS's
human labels) → filter/sort individual rows → run GROUP BY aggregates (averages, counts,
rankings) → compare one facility against its state and national benchmarks — all read-only.

- 📣 See [MARKETING.md](MARKETING.md) for capabilities and example questions users can ask.
- 📝 See [CHANGELOG.md](CHANGELOG.md) for version history.

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

## Column descriptions (data dictionaries)

Sentence-level column descriptions are built **once, locally** and committed as JSON — the Worker
never parses anything at runtime.

```text
data_dictionaries/*.pdf  ──►  npm run build:dictionaries  ──►  src/dictionaries/*.json  ──►  git push ──► wrangler deploy
   (gitignored, local)         (one-time, local, pdftotext)       (committed)                              (imports JSON at bundle time)
```

- **Source files** (`data_dictionaries/`) are **gitignored** — the PDFs are never pushed.
- **`npm run build:dictionaries`** extracts `{ normalizedLabel: description }` into
  `src/dictionaries/<provider>.json` and a merged `descriptions.json`. This runs `pdftotext`
  locally; it is **not** part of `deploy`.
- **The Worker imports `descriptions.json`**, which esbuild inlines into the bundle. At runtime
  `get_dataset_schema` does an in-memory label lookup — **no PDF parsing, no reprocessing on push**.
- **`src/dictionaries/overrides.json`** holds hand-authored fixes keyed by CMS label. They always
  win and are **never overwritten** by the build, so re-running it can't clobber manual work. To
  improve coverage: add lines to `overrides.json`, run `npm run build:dictionaries`, commit.

Coverage is partial and per-provider (dialysis ~46% after overrides; the hospital dictionary is a
narrative spec that doesn't table-parse) — fill gaps via `overrides.json`.

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
- **Richer, sentence-level descriptions** are built locally from `data_dictionaries/` and attached
  by `get_dataset_schema` via a conservative label match (a missing description beats a wrong one).
  See [Column descriptions](#column-descriptions-data-dictionaries) above for the full workflow.

## Roadmap

- ✅ Discovery, search, schema, structured queries
- ✅ Human column labels + typed output schemas
- ✅ Aggregation & insights (`aggregate_dataset`)
- ✅ Benchmark comparison (`compare_to_benchmarks`)
- ✅ Reliability & ops (retries, caching, clean errors, logs)
- 🟡 Rich column descriptions — mechanism live and wired into `get_dataset_schema`; dialysis
  (~39%) and physician auto-extracted from `data_dictionaries/`. Remaining providers use
  different PDF layouts (hospital is a narrative spec) and need bespoke extraction or
  hand-authoring; coverage improves by editing the committed `src/dictionaries/*.json`.
