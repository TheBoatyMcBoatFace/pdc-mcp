#!/usr/bin/env node
/**
 * Build per-provider column-description maps from CMS's data-dictionary files in
 * ../data_dictionaries/ (gitignored source; generated JSON in ../src/dictionaries/ is committed).
 *
 * The clean data dictionaries are 5-column tables:
 *   Variable Name | Variable Label | Type | Max. Length | Description
 * repeated across many pages, each page re-printing the header — and column x-positions drift
 * between pages, so we re-derive the column boundaries every time we see a header line.
 *
 * Output: src/dictionaries/<provider>.json = { normalizedLabel: description }, plus a merged
 * src/dictionaries/descriptions.json. The Worker matches a column's CMS label (normalized) to a
 * description at runtime — no PDF parsing in the Worker.
 *
 * Requires `pdftotext` (poppler). Run: node scripts/build-dictionaries.mjs
 *
 * Coverage is inherently partial: some CSV headers (the datastore labels) diverge from the PDF
 * Variable Labels (e.g. data "Facility Name" vs PDF "CMS Provider Name"), and some dictionaries
 * (notably hospital) are narrative specs, not tables. We only emit confident label matches.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "data_dictionaries");
const OUT_DIR = join(__dirname, "..", "src", "dictionaries");

// provider key -> local data-dictionary filename in data_dictionaries/
const FILES = {
  dialysis: "DF_Data_Dictionary.pdf",
  physician: "DOC_Data_Dictionary.pdf",
  hospice: "HOSPICE_Data_Dictionary.pdf",
  hospital: "HOSPITAL_Data_Dictionary.pdf",
  long_term_care_hospital: "LTCH_Data_Dictionary.pdf",
  nursing_home: "NH_Data_Dictionary.pdf",
  supplier: "Supplier_Directory_Data_Dictionary.pdf",
};

const TYPE_RE = /\b(Char|Num|Text|Int|Datetime)\b/;
const SKIP_RE = /^\s*(April \d{4}|Produced by|Page \d+ of|Table \d+:|Length\s*$)/;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function parse(text) {
  const lines = text.split("\n");
  let cLabel = -1;
  let cDesc = -1;
  const recs = [];
  let cur = null;

  const push = () => {
    if (cur) recs.push(cur);
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    // Header line: re-derive column boundaries for the following rows.
    if (line.includes("Variable Name") && line.includes("Description")) {
      push();
      cLabel = line.indexOf("Variable Label");
      cDesc = line.indexOf("Description");
      continue;
    }
    if (cLabel < 0 || cDesc < 0) continue; // before the first table
    if (!line.trim() || SKIP_RE.test(line)) continue;

    const name = line.slice(0, cLabel).trim();
    const isName = /^[A-Z0-9_]+$/.test(name);

    if (isName && cur && cur.name.endsWith("_") && name.length <= 3) {
      cur.name += name; // wrapped variable name continuation
      appendCells(cur, line, cLabel, cDesc);
      continue;
    }
    if (isName) {
      push();
      const rest = line.slice(cLabel);
      const tm = rest.match(TYPE_RE); // label ends where the Type keyword begins
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
  push();

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
  const map = {};
  for (const r of recs) {
    const key = norm(r.label);
    if (!key) continue;
    const prefer = /\(facility\)/i.test(r.desc);
    if (!(key in map) || (prefer && !/\(facility\)/i.test(map[key]))) map[key] = r.desc;
  }
  return map;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "pdc-dd-"));
  const merged = {};
  const summary = [];
  for (const [provider, file] of Object.entries(FILES)) {
    const src = join(SRC_DIR, file);
    if (!existsSync(src)) {
      summary.push({ provider, status: "missing source" });
      continue;
    }
    try {
      const txt = join(tmp, `${provider}.txt`);
      execFileSync("pdftotext", ["-layout", src, txt]);
      const recs = parse(readFileSync(txt, "utf8"));
      const map = buildMap(recs);
      // Only write per-provider files that actually extracted something (skip empties).
      if (Object.keys(map).length) {
        writeFileSync(join(OUT_DIR, `${provider}.json`), JSON.stringify(map, null, 0));
      }
      for (const [k, v] of Object.entries(map)) if (!(k in merged)) merged[k] = v;
      summary.push({ provider, records: recs.length, labels: Object.keys(map).length });
    } catch (e) {
      summary.push({ provider, status: `error: ${e.message || e}` });
    }
  }

  // Hand-authored overrides always win and are NEVER touched by this script, so re-running the
  // build (which re-parses the PDFs) can't clobber manual fixes. Keys are human labels; we
  // normalize them here to match how the Worker looks columns up.
  const overridesPath = join(OUT_DIR, "overrides.json");
  let overrideCount = 0;
  if (existsSync(overridesPath)) {
    const overrides = JSON.parse(readFileSync(overridesPath, "utf8"));
    for (const [label, desc] of Object.entries(overrides)) {
      if (label.startsWith("//") || !desc) continue; // allow "//comment" keys
      merged[norm(label)] = desc;
      overrideCount++;
    }
  }

  writeFileSync(join(OUT_DIR, "descriptions.json"), JSON.stringify(merged, null, 0));
  console.table(summary);
  console.log(
    `merged: ${Object.keys(merged).length} labels ` +
      `(${overrideCount} from overrides.json) -> ${OUT_DIR}/descriptions.json`,
  );
}

main();
