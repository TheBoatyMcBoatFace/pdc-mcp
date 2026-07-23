/**
 * Thin, read-only client for the CMS Provider Data Catalog (DKAN) API.
 * Docs: https://data.cms.gov/provider-data/api/1
 * All endpoints here are unauthenticated GET/POST reads.
 */

const BASE = "https://data.cms.gov/provider-data/api/1";
const UA = "cms-pdc-mcp (+https://data.cms.gov)";

/** DKAN can be slow on cold cache; keep a bounded timeout so tool calls don't hang. */
const TIMEOUT_MS = 20_000;
/** Retry transient upstream failures (network, 5xx, 429) this many times. */
const MAX_RETRIES = 2;
/** Cache successful GET reads briefly — protects CMS's API from repeated identical reads
 * within a conversation and speeds repeats, at a freshness cost of at most a minute. */
const GET_CACHE_TTL_S = 60;

/** Turn a DKAN error body into a concise message (DKAN returns { message, status }). */
function upstreamError(status: number, text: string, path: string): Error {
  let detail = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    if (j && typeof j.message === "string") detail = j.message.replace(/\s+/g, " ").trim();
  } catch {
    /* not JSON; keep raw snippet */
  }
  return new Error(`PDC API ${status} for ${path}: ${detail}`);
}

/** Cloudflare's default cache, when available (Workers runtime). */
function defaultCache(): Cache | null {
  try {
    return (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${BASE}${path}`;
  const method = (init?.method ?? "GET").toUpperCase();
  const cache = method === "GET" ? defaultCache() : null;
  const cacheKey = cache ? new Request(url) : null;

  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      console.log(JSON.stringify({ at: "pdc", method, path, cache: "hit" }));
      const t = await hit.text();
      return t ? JSON.parse(t) : null;
    }
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const start = Date.now();
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: { Accept: "application/json", "User-Agent": UA, ...(init?.headers ?? {}) },
      });
      const text = await res.text();
      const ms = Date.now() - start;

      if (!res.ok) {
        // Retry transient statuses; fail fast on 4xx (bad query, not found, etc.).
        if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
          lastErr = upstreamError(res.status, text, path);
          await sleep(200 * (attempt + 1));
          continue;
        }
        console.log(JSON.stringify({ at: "pdc", method, path, status: res.status, ms }));
        throw upstreamError(res.status, text, path);
      }

      console.log(JSON.stringify({ at: "pdc", method, path, status: res.status, ms, attempt }));
      if (cache && cacheKey && text) {
        await cache.put(
          cacheKey,
          new Response(text, {
            headers: {
              "Cache-Control": `max-age=${GET_CACHE_TTL_S}`,
              "Content-Type": "application/json",
            },
          }),
        );
      }
      return text ? JSON.parse(text) : null;
    } catch (e) {
      clearTimeout(timer);
      const aborted = e instanceof Error && e.name === "AbortError";
      // Retry network blips (TypeError from fetch), but not timeouts (keeps latency bounded)
      // and not the upstreamError we threw above (already final).
      const transient = !aborted && e instanceof TypeError;
      if (transient && attempt < MAX_RETRIES) {
        lastErr = e;
        await sleep(200 * (attempt + 1));
        continue;
      }
      if (aborted) throw new Error(`PDC API timeout after ${TIMEOUT_MS}ms for ${path}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`PDC API request failed for ${path}`);
}

export interface DatasetSummary {
  identifier: string;
  title: string;
  description: string;
  theme?: string[];
  modified?: string;
  keyword?: string[];
  landingPage?: string;
}

export interface Distribution {
  identifier: string; // datastore distribution UUID used for queries
  title?: string;
  format?: string;
  downloadURL?: string;
}

export interface DatasetDetail extends DatasetSummary {
  distributions: Distribution[];
  /** URLs of the human-readable data dictionaries (usually PDFs) describing the columns. */
  dataDictionary?: string[];
}

export interface SchemaField {
  name: string;
  type: string;
  /** Human-readable column label from CMS (the datastore's built-in field description). */
  label?: string;
}

export interface Category {
  theme: string;
  datasetCount: number;
  examples: Array<{ identifier: string; title: string }>;
}

/** Normalize a DKAN theme/keyword entry (may be a plain string or a {data} ref object). */
function refName(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "data" in v) return String((v as any).data);
  return String(v);
}

/**
 * Best-effort in-isolate cache of the full dataset list. Powers list_categories and
 * the catalog resource with a single upstream call. Cloudflare isolates are ephemeral,
 * so this is a speedup, not a guarantee.
 */
let allCache: { at: number; data: any[] } | null = null;
const ALL_TTL_MS = 10 * 60 * 1000;

async function allDatasets(): Promise<any[]> {
  if (allCache && Date.now() - allCache.at < ALL_TTL_MS) return allCache.data;
  const data = (await req(`/metastore/schemas/dataset/items?show-reference-ids=false`)) as any[];
  allCache = { at: Date.now(), data: Array.isArray(data) ? data : [] };
  return allCache.data;
}

/** The catalog's provider-type categories (themes) with counts and example datasets. */
export async function getCategories(): Promise<Category[]> {
  const all = await allDatasets();
  const byTheme = new Map<string, any[]>();
  for (const d of all) {
    for (const t of d.theme ?? []) {
      const name = refName(t);
      if (!byTheme.has(name)) byTheme.set(name, []);
      byTheme.get(name)!.push(d);
    }
  }
  return [...byTheme.entries()]
    .map(([theme, items]) => ({
      theme,
      datasetCount: items.length,
      examples: items.slice(0, 3).map((x) => ({ identifier: x.identifier, title: x.title })),
    }))
    .sort((a, b) => b.datasetCount - a.datasetCount);
}

export interface SearchFilters {
  theme?: string;
  keyword?: string;
  pageSize?: number;
}

/**
 * Search datasets by free text, optionally scoped to a provider-type `theme` and/or `keyword`.
 * All three are optional; with none set it returns the first page of the whole catalog.
 */
export async function searchDatasets(
  fulltext: string,
  filters: SearchFilters = {},
): Promise<DatasetSummary[]> {
  const q = new URLSearchParams({ "page-size": String(filters.pageSize ?? 10) });
  if (fulltext) q.set("fulltext", fulltext);
  if (filters.theme) q.set("theme", filters.theme);
  if (filters.keyword) q.set("keyword", filters.keyword);
  const data = (await req(`/search?${q}`)) as { results?: Record<string, any> };
  const results = data.results ? Object.values(data.results) : [];
  return results.map((r: any) => ({
    identifier: r.identifier,
    title: r.title,
    description: (r.description ?? "").slice(0, 500),
    theme: (r.theme ?? []).map(refName),
    modified: r.modified,
    keyword: (r.keyword ?? []).map(refName),
    landingPage: r.landingPage,
  }));
}

/** Get one dataset's metadata plus its queryable distributions (tables). */
export async function getDataset(identifier: string): Promise<DatasetDetail> {
  const d = (await req(
    `/metastore/schemas/dataset/items/${encodeURIComponent(identifier)}?show-reference-ids=false`,
  )) as any;
  const dists: Distribution[] = (d.distribution ?? []).map((dist: any) => ({
    identifier: dist.identifier,
    title: dist.data?.title ?? dist.title,
    format: dist.data?.format ?? dist.data?.mediaType,
    downloadURL: dist.data?.downloadURL,
  }));
  const describedBy: string[] = (d.distribution ?? [])
    .map((dist: any) => dist.data?.describedBy)
    .filter((u: unknown): u is string => typeof u === "string");
  const dataDictionary: string[] = [...new Set(describedBy)];
  return {
    identifier: d.identifier,
    title: d.title,
    description: d.description ?? "",
    theme: (d.theme ?? []).map(refName),
    modified: d.modified,
    keyword: (d.keyword ?? []).map(refName),
    landingPage: d.landingPage,
    distributions: dists,
    dataDictionary: dataDictionary.length ? dataDictionary : undefined,
  };
}

export type Operator = "=" | "<>" | "<" | "<=" | ">" | ">=" | "like" | "in" | "not in";

export interface Condition {
  property: string;
  value: string | number | Array<string | number>;
  operator?: Operator;
}

export interface Sort {
  property: string;
  order?: "asc" | "desc";
}

export interface QueryOptions {
  conditions?: Condition[];
  properties?: string[];
  sorts?: Sort[];
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  count: number;
  results: Array<Record<string, unknown>>;
}

/** Run a structured datastore query against a distribution UUID. */
export async function queryDistribution(
  distributionId: string,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  const body: Record<string, unknown> = {
    limit: opts.limit ?? 20,
    offset: opts.offset ?? 0,
    count: true,
    results: true,
    schema: false,
  };
  if (opts.conditions?.length) body.conditions = opts.conditions;
  if (opts.properties?.length) body.properties = opts.properties;
  if (opts.sorts?.length) body.sorts = opts.sorts;

  const data = (await req(`/datastore/query/${encodeURIComponent(distributionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as { count?: number | string; results?: Array<Record<string, unknown>> };

  return {
    count: Number(data.count ?? 0),
    results: data.results ?? [],
  };
}

export type AggregateOperator = "count" | "sum" | "avg" | "min" | "max";

export interface Metric {
  operator: AggregateOperator;
  column: string;
  alias?: string;
}

export interface AggregateOptions {
  metrics: Metric[];
  groupBy?: string[];
  conditions?: Condition[];
  sorts?: Sort[];
  limit?: number;
  offset?: number;
}

/**
 * Run an aggregation (GROUP BY) against a distribution: compute count/sum/avg/min/max over
 * columns, optionally grouped and filtered. DKAN casts the text-typed numeric columns for us.
 * Metric values are coerced to numbers; grouping columns stay as-is.
 */
export async function aggregateDistribution(
  distributionId: string,
  opts: AggregateOptions,
): Promise<QueryResult> {
  const metricAliases: string[] = [];
  const properties: Array<string | Record<string, unknown>> = [...(opts.groupBy ?? [])];
  for (const m of opts.metrics) {
    const alias = m.alias?.trim() || `${m.operator}_${m.column}`;
    metricAliases.push(alias);
    properties.push({ expression: { operator: m.operator, operands: [m.column] }, alias });
  }

  const body: Record<string, unknown> = {
    properties,
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
    count: false,
    results: true,
    schema: false,
  };
  if (opts.groupBy?.length) body.groupings = opts.groupBy;
  if (opts.conditions?.length) body.conditions = opts.conditions;
  if (opts.sorts?.length) body.sorts = opts.sorts;

  const data = (await req(`/datastore/query/${encodeURIComponent(distributionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as { results?: Array<Record<string, unknown>> };

  const results = (data.results ?? []).map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const alias of metricAliases) {
      const v = out[alias];
      out[alias] = v === null || v === undefined || v === "" ? null : Number(v);
    }
    return out;
  });
  return { count: results.length, results };
}

/** Coerce a datastore text value to a number, or null when blank/non-numeric. */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export interface CompareOptions {
  idColumn: string;
  idValue: string;
  measures: string[];
  groupColumn?: string;
}

export interface Comparison {
  measure: string;
  entity: number | null;
  group?: number | null;
  national: number | null;
}

export interface CompareResult {
  entity: {
    column: string;
    value: string;
    group?: { column: string; value: string | null };
  };
  nationalCount: number;
  groupCount?: number;
  comparisons: Comparison[];
}

/**
 * Compare one entity's measures against benchmarks computed from the same distribution:
 * the national (overall) average and, if `groupColumn` is given, the average within the
 * entity's own group (e.g. its state). Benchmarks are simple averages of the facility-level
 * data — transparent, not CMS's separately published risk-adjusted averages. Runs in 3
 * upstream calls regardless of how many measures are requested.
 */
export async function compareToBenchmarks(
  distributionId: string,
  opts: CompareOptions,
): Promise<CompareResult> {
  // 1) The entity's own row.
  const { results } = await queryDistribution(distributionId, {
    conditions: [{ property: opts.idColumn, value: opts.idValue, operator: "=" }],
    limit: 1,
  });
  const row = results[0];
  if (!row) throw new Error(`No row found where ${opts.idColumn} = "${opts.idValue}".`);

  const COUNT = "__count";
  const metrics: Metric[] = opts.measures.map((m) => ({ operator: "avg", column: m, alias: m }));
  const withCount: Metric[] = [...metrics, { operator: "count", column: opts.idColumn, alias: COUNT }];

  // 2) National (overall) averages.
  const nat = await aggregateDistribution(distributionId, { metrics: withCount });
  const natRow = nat.results[0] ?? {};

  // 3) The entity's group averages (optional).
  const groupValue = opts.groupColumn ? (row[opts.groupColumn] ?? null) : undefined;
  let grpRow: Record<string, unknown> = {};
  let groupCount: number | undefined;
  if (opts.groupColumn && groupValue !== null && groupValue !== "") {
    const grp = await aggregateDistribution(distributionId, {
      metrics: withCount,
      conditions: [{ property: opts.groupColumn, value: String(groupValue), operator: "=" }],
    });
    grpRow = grp.results[0] ?? {};
    groupCount = toNum(grpRow[COUNT]) ?? undefined;
  }

  const comparisons: Comparison[] = opts.measures.map((m) => {
    const c: Comparison = { measure: m, entity: toNum(row[m]), national: toNum(natRow[m]) };
    if (opts.groupColumn) c.group = toNum(grpRow[m]);
    return c;
  });

  return {
    entity: {
      column: opts.idColumn,
      value: opts.idValue,
      ...(opts.groupColumn
        ? { group: { column: opts.groupColumn, value: groupValue == null ? null : String(groupValue) } }
        : {}),
    },
    nationalCount: toNum(natRow[COUNT]) ?? 0,
    ...(groupCount !== undefined ? { groupCount } : {}),
    comparisons,
  };
}

/** Fetch column names, types, and CMS's human-readable labels for a distribution. */
export async function getDistributionSchema(distributionId: string): Promise<SchemaField[]> {
  const data = (await req(`/datastore/query/${encodeURIComponent(distributionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 1, offset: 0, count: false, results: false, schema: true }),
  })) as {
    schema?: Record<string, { fields?: Record<string, { type?: string; description?: string }> }>;
  };

  const schemaObj = data.schema ? Object.values(data.schema)[0] : undefined;
  const fields = schemaObj?.fields ?? {};
  return Object.entries(fields).map(([name, meta]) => ({
    name,
    type: meta?.type ?? "unknown",
    // DKAN stores the original CSV column header as the field's `description`.
    label: meta?.description?.trim() || undefined,
  }));
}
