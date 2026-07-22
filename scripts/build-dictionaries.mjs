#!/usr/bin/env node
/**
 * Build per-provider column-description maps from CMS's data-dictionary PDFs.
 *
 * CMS publishes one data-dictionary PDF per provider type. Each is a 5-column table:
 *   Variable Name | Variable Label | Type | Max. Length | Description
 * We extract { normalizedLabel -> description } and write src/dictionaries/<provider>.json,
 * plus a merged src/dictionaries/descriptions.json the Worker imports at runtime.
 *
 * This is BUILD-TIME only (needs `pdftotext` from poppler + network). The Worker never
 * parses PDFs; it only imports the generated JSON. Re-run to refresh:
 *   node scripts/build-dictionaries.mjs
 *
 * STATUS (2026-07): Superseded pending authoritative structured dictionaries. Automated PDF
 * parsing was proven NOT viable across providers:
 *   - The 9 PDFs have incompatible layouts. The clean 5-column table (dialysis) parses; the
 *     hospital dictionary is a 105-page narrative System Requirements Spec and yields 0 rows.
 *   - Even for dialysis, PDF "Variable Label" diverges from the CSV headers CMS loads
 *     (data "Facility Name" vs PDF "CMS Provider Name"; data "Mortality Rate (Facility)" vs
 *     PDF "Mortality Rate"), so label-join coverage caps ~17%.
 * Kept as scaffolding: when the structured source lands, repoint this at it and emit the same
 * output format (src/dictionaries/<provider>.json = { columnName: description }), then wire
 * getDistributionSchema to attach `description` by exact column name (no fuzzy matching).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "src", "dictionaries");
const DD_BASE =
  "https://data.cms.gov/provider-data/sites/default/files/data_dictionaries";

// provider key -> data-dictionary PDF path (relative to DD_BASE)
const PDFS = {
  hospital: "hospital/HOSPITAL_Data_Dictionary.pdf",
  dialysis: "dialysis/DF_Data_Dictionary.pdf",
  nursing_home: "nursing_home/NH_Data_Dictionary.pdf",
  home_health: "home_health/HHS_Data_Dictionary.pdf",
  hospice: "hospice/HOSPICE_Data_Dictionary.pdf",
  physician: "physician/DOC_Data_Dictionary.pdf",
  inpatient: "inpatient/IRF_Data_Dictionary.pdf",
  long_term_care_hospital: "long_term_care_hospital/LTCH_Data_Dictionary.pdf",
  supplier: "supplier/Supplier_Directory_Data_Dictionary.pdf",
};

const TYPE_RE = /\b(Char|Num|Text|Int|Datetime)\b/;
const SKIP_RE = /^\s*(April \d{4}|Produced by|Page \d+ of|Table \d+:|Variable Name|Length\s*$)/;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function parse(text) {
  const lines = text.split("\n");
  const hdr = lines.find((l) => l.includes("Variable Name") && l.includes("Description"));
  if (!hdr) return [];
  const cLabel = hdr.indexOf("Variable Label");
  const cDesc = hdr.indexOf("Description");

  const recs = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || SKIP_RE.test(line)) continue;
    const name = line.slice(0, cLabel).trim();
    const isName = /^[A-Z0-9_]+$/.test(name);

    // Wrapped variable name (e.g. "SMR_RATE_UCI_" then "F"): treat as continuation.
    if (isName && cur && cur.name.endsWith("_") && name.length <= 3) {
      cur.name += name;
      appendCells(cur, line, cLabel, cDesc);
      continue;
    }
    if (isName) {
      if (cur) recs.push(cur);
      // First line of a record: label runs from cLabel up to the Type keyword.
      const rest = line.slice(cLabel);
      const tm = rest.match(TYPE_RE);
      const labelEnd = tm ? cLabel + tm.index : cDesc;
      cur = {
        name,
        label: line.slice(cLabel, labelEnd).trim(),
        desc: line.length > cDesc ? line.slice(cDesc).trim() : "",
      };
    } else if (cur) {
      appendCells(cur, line, cLabel, cDesc);
    }
  }
  if (cur) recs.push(cur);
  for (const r of recs) {
    r.label = r.label.replace(/\s+/g, " ").trim();
    r.desc = r.desc.replace(/\s+/g, " ").trim();
  }
  return recs.filter((r) => r.label && r.desc);
}

function appendCells(cur, line, cLabel, cDesc) {
  const lbl = line.slice(cLabel, cDesc).trim();
  const dsc = line.length > cDesc ? line.slice(cDesc).trim() : "";
  if (lbl) cur.label += " " + lbl;
  if (dsc) cur.desc += " " + dsc;
}

function buildMap(recs) {
  // normalizedLabel -> description. On duplicate labels (FACILITY/STATE/US share a
  // label), prefer the facility-scoped description.
  const map = {};
  for (const r of recs) {
    const key = norm(r.label);
    if (!key) continue;
    const prefer = /\(facility\)/i.test(r.desc);
    if (!(key in map) || (prefer && !/\(facility\)/i.test(map[key]))) {
      map[key] = r.desc;
    }
  }
  return map;
}

async function fetchPdf(rel, dest) {
  const res = await fetch(`${DD_BASE}/${rel}`);
  if (!res.ok) throw new Error(`fetch ${rel}: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "pdc-dd-"));
  const merged = {};
  const summary = [];
  for (const [provider, rel] of Object.entries(PDFS)) {
    const pdf = join(tmp, `${provider}.pdf`);
    const txt = join(tmp, `${provider}.txt`);
    try {
      await fetchPdf(rel, pdf);
      execFileSync("pdftotext", ["-layout", pdf, txt]);
      const recs = parse(readFileSync(txt, "utf8"));
      const map = buildMap(recs);
      writeFileSync(join(OUT_DIR, `${provider}.json`), JSON.stringify(map, null, 0));
      for (const [k, v] of Object.entries(map)) if (!(k in merged)) merged[k] = v;
      summary.push({ provider, records: recs.length, labels: Object.keys(map).length });
    } catch (e) {
      summary.push({ provider, error: String(e.message || e) });
    }
  }
  writeFileSync(join(OUT_DIR, "descriptions.json"), JSON.stringify(merged, null, 0));
  console.table(summary);
  console.log(`merged unique labels: ${Object.keys(merged).length}`);
  console.log(`written to ${OUT_DIR}`);
}

main();
