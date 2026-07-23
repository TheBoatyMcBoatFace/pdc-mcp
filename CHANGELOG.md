# Changelog

All notable changes to the CMS Provider Data Catalog MCP server. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses semantic-ish `0.x` versions.

## [0.9.0] — 2026-07-22 — Rich column descriptions (initial)

### Added

- `get_dataset_schema` now returns a sentence-level `description` per column when a confident match
  exists, sourced from committed maps in `src/dictionaries/` built by `scripts/build-dictionaries.mjs`
  from the CMS data-dictionary files. Matching is conservative (exact label or the facility variant
  of a "… (Facility)" label). Initial coverage: dialysis (~39%) and physician; other providers use
  different PDF layouts and need bespoke extraction.

### Changed

- `scripts/build-dictionaries.mjs` reads local `data_dictionaries/` files and re-derives table
  column boundaries per page-header (fixes low extraction from multi-page dictionaries).

## [0.8.0] — 2026-07-22 — Tool annotations

### Added

- Every tool now has a human `title` and `readOnlyHint`/`idempotentHint`/`openWorldHint`
  annotations, so clients can label them and know they never modify data.

## [0.7.0] — 2026-07-22 — Reliability & ops

### Added

- Hardened upstream client (`src/pdc.ts` `req()`): retries with backoff on transient failures
  (network errors, 5xx, 429), a bounded 20s timeout with a clear timeout error, short-TTL (60s)
  GET caching via the Cloudflare Cache API, and structured per-call logs for Workers observability.

### Changed

- DKAN error bodies are now parsed to a concise message (e.g. "Column not found.") instead of a
  raw JSON blob.

## [0.6.0] — 2026-07-22 — Benchmark comparison

### Added

- `compare_to_benchmarks` tool: in one call, returns an entity's measures alongside the national
  (overall) average and its group (e.g. state) average, with cohort sizes. Benchmarks are simple
  averages computed from the distribution's own rows (transparent), in 3 upstream calls.

## [0.5.0] — 2026-07-22 — Aggregation & insights

### Added

- `aggregate_dataset` tool: GROUP BY aggregation with `count`/`sum`/`avg`/`min`/`max` metrics,
  optional `group_by`, pre-aggregation `conditions` (WHERE), and `sorts` for rankings. Uses DKAN's
  structured expression + `groupings` query (its SQL endpoint can't GROUP BY). Text-typed numeric
  columns are cast automatically; metric values are returned as numbers.

## [0.4.0] — 2026-07-22 — Typed output schemas

### Added

- Every tool now declares an `outputSchema` and returns validated `structuredContent`, so clients
  (e.g. ChatGPT developer mode) can parse and render results reliably instead of re-reading JSON.

### Changed

- Migrated tool registration to `registerTool`. Array-returning tools now wrap results in an
  object key (`{ categories }`, `{ datasets }`, `{ columns }`).

## [0.3.0] — 2026-07-22 — Human column labels

### Added

- `get_dataset_schema` now returns a human-readable `label` for every column, sourced from the
  datastore's built-in field description (the original CSV header) — available for all datasets
  with no PDF parsing.

## [0.2.0] — 2026-07-22 — Discoverability

### Added

- `list_categories` tool: the 10 provider-type categories with dataset counts and examples.
- `theme` and `keyword` filters on `search_datasets`.
- `pdc://catalog` MCP resource (browsable category map) and `explore_cms_data` MCP prompt.
- Server `instructions` advertising scope and the recommended workflow on connect.
- In-isolate caching (10 min) of the full dataset list behind discovery.
- Data-dictionary PDF link and `theme` surfaced on `get_dataset`.

## [0.1.0] — 2026-07-22 — Initial release

### Added

- Remote MCP server on Cloudflare Workers (`agents` `McpAgent`) over Streamable HTTP (`/mcp`) and
  SSE (`/sse`), read-only and unauthenticated.
- Core tools: `search_datasets`, `get_dataset`, `get_dataset_schema`, `query_dataset`
  (structured filters, sorts, column selection, paging — no raw SQL).
