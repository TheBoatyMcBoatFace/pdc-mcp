/**
 * Thin, read-only client for the CMS Provider Data Catalog (DKAN) API.
 * Docs: https://data.cms.gov/provider-data/api/1
 * All endpoints here are unauthenticated GET/POST reads.
 */

const BASE = "https://data.cms.gov/provider-data/api/1";

/** DKAN can be slow on cold cache; keep a bounded timeout so tool calls don't hang. */
const TIMEOUT_MS = 20_000;

async function req(path: string, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "cms-pdc-mcp/0.1 (+https://data.cms.gov)",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`PDC API ${res.status} ${res.statusText} for ${path}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
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
