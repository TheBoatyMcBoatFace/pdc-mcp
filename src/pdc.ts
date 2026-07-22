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
}

export interface SchemaField {
  name: string;
  type: string;
}

/** Full-text search across datasets. Returns lightweight summaries. */
export async function searchDatasets(fulltext: string, pageSize = 10): Promise<DatasetSummary[]> {
  const q = new URLSearchParams({ fulltext, "page-size": String(pageSize) });
  const data = (await req(`/search?${q}`)) as { results?: Record<string, any> };
  const results = data.results ? Object.values(data.results) : [];
  return results.map((r: any) => ({
    identifier: r.identifier,
    title: r.title,
    description: (r.description ?? "").slice(0, 500),
    modified: r.modified,
    keyword: r.keyword,
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
  return {
    identifier: d.identifier,
    title: d.title,
    description: d.description ?? "",
    modified: d.modified,
    keyword: d.keyword,
    landingPage: d.landingPage,
    distributions: dists,
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

/** Fetch just the column names + types for a distribution (limit=1 to read schema). */
export async function getDistributionSchema(distributionId: string): Promise<SchemaField[]> {
  const data = (await req(`/datastore/query/${encodeURIComponent(distributionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 1, offset: 0, count: false, results: false, schema: true }),
  })) as { schema?: Record<string, { fields?: Record<string, { type?: string }> }> };

  const schemaObj = data.schema ? Object.values(data.schema)[0] : undefined;
  const fields = schemaObj?.fields ?? {};
  return Object.entries(fields).map(([name, meta]) => ({
    name,
    type: meta?.type ?? "unknown",
  }));
}
