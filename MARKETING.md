# Ask Medicare's Provider Data Anything

This connector puts the **official CMS Provider Data Catalog** — ~234 public datasets covering
hospitals, nursing homes, dialysis facilities, home health agencies, hospices, physicians, and
more — one plain-language question away. No spreadsheets, no SQL, no hunting through data.cms.gov.

Just ask. The assistant finds the right dataset, understands its columns, and pulls, ranks,
averages, or benchmarks the numbers for you.

---

## What you can do

### 🗺️ Discover what's available

Not sure what's in here? Just ask.

- *"What kinds of CMS provider data can I explore?"*
- *"What datasets do you have about hospital patient experience?"*
- *"Show me everything related to nursing home staffing."*

### 🔎 Look things up

Find specific facilities, providers, or records with filters.

- *"List the dialysis facilities in New York and their star ratings."*
- *"Which hospitals in Ohio have an emergency department?"*
- *"Find non-profit dialysis centers in California that offer home hemodialysis training."*

### 📊 Aggregate & rank

Turn thousands of rows into an answer — averages, counts, and leaderboards.

- *"What's the average dialysis star rating in each state?"*
- *"Which 10 states have the most Medicare-certified dialysis facilities?"*
- *"How many nursing homes are there per state?"*
- *"Rank states by their average hospital readmission rate."*

### ⚖️ Benchmark one against the field

See how a single facility stacks up against its state and the nation — in one shot.

- *"How does Huntington Hospital's dialysis mortality rate compare to New York and the nation?"*
- *"Is this nursing home's staffing above or below its state average?"*
- *"Compare this facility's star rating to state and national averages."*

---

## Creative questions to try

**For patients & families**
- *"I'm looking for a dialysis center near Albany, NY — which ones have 4 or 5 stars?"*
- *"Which nursing homes in my state have the fewest health deficiencies?"*
- *"Find hospices that scored well on family survey ratings."*

**For researchers & analysts**
- *"Which states have the widest gap between their best and worst dialysis facilities?"*
- *"What's the national average mortality rate for dialysis facilities, and which states beat it?"*
- *"Break down facilities by profit vs. non-profit ownership across states."*

**For journalists & policy folks**
- *"Rank states by average hospital patient-experience scores."*
- *"How many facilities nationwide are chain-owned versus independent?"*
- *"Where are the biggest concentrations of a given provider type?"*

**For quick sanity checks**
- *"How many dialysis facilities does CMS track in total?"*
- *"What columns are in the hospital general information dataset, and what do they mean?"*
- *"What's the highest star rating any facility in Hawaii has?"*

---

## Good to know

- **It's official, public CMS data** from data.cms.gov — the same numbers behind Medicare's
  Care Compare tools.
- **Read-only.** It answers questions; it never changes anything.
- **Every column comes with CMS's own label**, so the assistant knows what each number means
  before it uses it.
- **Benchmarks are computed transparently** as straight averages across the facilities in a
  dataset. For CMS's official risk-adjusted state/national figures, the published averages
  datasets are also available to query directly.
- **The data is a point-in-time snapshot** of what CMS currently publishes — great for "how
  things look now" and comparisons, not historical trends.

---

*Powered by the CMS Provider Data Catalog MCP server. Connect it in Claude (custom connector) or
ChatGPT (connectors / developer mode).*
