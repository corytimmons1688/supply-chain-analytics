# supply-chain-analytics

Internal analytics app for Calyx supply chain: roll inventory, cycle counts, demand
planning, vendor scorecards, and material purchasing.

- **Frontend** — `artifacts/inventory-adjustments` (Vite + React 19, wouter, TanStack Query, Tailwind 4)
- **API** — `artifacts/api-server` (Express 5, mounted at `/api`, port 8080)
- **Database** — Neon Postgres via Drizzle (`lib/db`). The live database is
  **`supply_chain_analytics`**, not `neondb`.
- **Contract** — `lib/api-spec/openapi.yaml` is the source of truth; Orval generates
  the Zod schemas (`lib/api-zod`) and react-query hooks (`lib/api-client-react`).

Conventions, hard rules, and the gotchas that cost people hours live in
[`replit.md`](./replit.md) and [`.agents/memory/`](./.agents/memory/). Read those first.

This document covers two things:

1. **[Part A — the live forecasting pipeline](#part-a--the-live-forecasting-pipeline)**:
   what data comes from where, which scope rules apply, and which assumptions are real
   versus still missing. Start here if you want to know *what the app is doing*.
2. **[Part B — how feet of material is calculated](#part-b--how-feet-of-material-is-calculated)**:
   the geometry, verbatim from the PackOS kernel. Start here if you are touching the math.

---
---

# Part A — the live forecasting pipeline

> **Status: Phase 1 (HubSpot) is live. Phase 2 (deeper NetSuite) is not.**
> Figures below were measured **2026-08-04** and move with the data.

## Everything is read-only. This is enforced, not just intended.

| System | Access | How it is enforced |
|---|---|---|
| **HubSpot** | read | `lib/integrations/hubspot-preorder` has exactly one network primitive. Its `method` is typed `"GET" \| "POST"` and it **throws** on any POST that is not `/search`. No create/update/delete path exists in the package. |
| **Neon Postgres** | read | Forecast code uses `db.select()` only. No `INSERT`/`UPDATE`/`DELETE`, no migrations. Ad-hoc sessions should set `SET default_transaction_read_only = on`. |
| **LabelTraxx** | read | Repo hard rule: **never write to Label Traxx.** `ltApi.ts` does contain a `ltPut`; the forecasting path never calls it. |
| **NetSuite** | read | Consumed only via the `ns_forecast_line` mirror. |

**Do not add write paths to any of these without an explicit decision.** A wrong write
to LT or HubSpot corrupts the system of record for the whole business, not just a report.

## Where the numbers come from

```
 HubSpot Pre-Order Support ──┐
 (open quotes, internal)     │
                             ├──► quote-stage-forecast.ts ──► GET /api/forecasting/quote-stage
 ns_forecast_line ───────────┤         │
 (NetSuite firm SOs)         │         ├─ footage: label-footage.ts geometry
                             │         ├─ spoilage: real LT curves (below)
 lt_stock ───────────────────┤         ├─ dedupe: quote ↔ SO fuzzy match
 (master width, cost, vendor)│         └─ policy: DERIVED safety stock / ROP
 lt_roll ────────────────────┤
 (real on-hand footage)      │
 lt_po ──────────────────────┤
 (open POs, measured leads)  │
 stock_goal ─────────────────┘
 (operator overrides)
```

| Source | Table / endpoint | Rows (2026-08-04) | Used for |
|---|---|---|---|
| HubSpot pre-order support | object `2-52567425`, pipeline `820783656` | 403 internal | open quote demand |
| NetSuite sales orders | `ns_forecast_line` | 66 (62 with footage) | firm demand |
| LT stock master | `lt_stock` | 248 | master width, cost/MSI, supplier |
| LT rolls | `lt_roll` | 23,222 | **real on-hand footage** |
| LT purchase orders | `lt_po` | 1,512 | open POs, measured lead times |
| Operator overrides | `stock_goal` | 34 | SS/ROP/lead time **where set** |

## Scope rules — these change the answer materially

### 1. Internal only (`location = "Internal"`)

External jobs are made by a vendor and consume **none** of our roll stock, so they are
not material demand. This halves the dataset: **403 internal / 409 external**.

It is also the *clean* half. On the internal subset the fields the forecast needs are
essentially fully populated:

| Field | Internal labels (n=212) | Internal flexpack (n=189) |
|---|---|---|
| `quantity_needed` | 100% | 98% |
| `product_width` / `product_height` | 100% | 100% |
| `copy_position` | **100%** | n/a (geometry carries the axis) |
| substrate | 100% | 100% |
| finish | 95% | 100% |
| `embellishment` | 100% | 100% |

`copy_position` is 29% filled across *all* records but **100%** on internal labels — and
it is worth up to 37% of the footage number (see [Part B](#1-copy-position--the-part-people-miss)).
Filtering to internal removes the single largest source of assumed orientation.

**Fields that look useful and are not:** `class` (0% filled — derive Labels vs Flexpack
from which substrate field is present) and `usa_or_import` (0% filled).

### 2. Forward window: In Progress onward

Ordered farthest-out → closest-to-decided:

`In Progress` → `Quote Completed` → `Quote Accepted` → `Quote Rejected`

`Request Que` and `Pending Information` are excluded — too speculative to buy against.
**`Quote Rejected` is pulled deliberately**: it is the attrition arm of the flow and
contributes zero committed demand. It is not noise; it is 2.5M ft of footage that did
*not* convert, which is the whole point of showing a flow.

Stage probabilities (`DERIVED`, not a HubSpot field — the pre-order object carries no
probability metadata, unlike deals):

| Stage | p | Outcome |
|---|---|---|
| In Progress | 0.30 | open |
| Quote Completed | 0.50 | open |
| Quote Accepted | 0.90 | won |
| Quote Rejected | 0 | lost |

### 3. All referenced stocks are tracked

Demand landing on a stock outside the 19-item tracked material list is **counted and
flagged**, never dropped. Live examples: NetSuite references stocks `195`, `206`, `258`,
which are not on the list. Dropping them would hide real consumption.

## The real spoilage curves

Transcribed verbatim from the LabelTraxx **Press Speeds and Spoilage** screens. These are
Calyx engineering assumptions; the app reports them, it does not tune them. See
`lib/integrations/hubspot-preorder/src/spoilage.ts`.

Machine routing, confirmed against the real LT equipment chain:

| Product | Chain | Laminating machine |
|---|---|---|
| Label, no embellishment | `HP 6900 → ABG A` | **ABGA** |
| Label, any embellishment | `HP 6900 → ABG 3` | **ABG3** |
| Flexpack | `HP 6900 → Thermo → (ABG 3) → Suncentre1` | **Thermo** |

"Any embellishment" = Flat Spot UV · Tactile Spot UV · Cold Foil · Cast & Cure · an
"Other" embellishment in notes · or a peel-and-reveal label. ABG3 **replaces** ABGA for
that job; it is not an extra pass.

```
ABGA    0–50:20%  51–101:6%  101–3k:5%  3k–4k:4%  4k–5k:3%
        5k–7.5k:3%  7.5k–10k:3%  10k–12.5k:2.5%  12.5k–15k:2.25%  15k–100k:2.25%
ABG3    0–100:100%  101–200:50%  201–1k:8%  1k–2.5k:6%  2.5k–5k:5%  5k+:4%
Thermo  0–500:3%  501–2.5k:1%  2.5k–5k:1%  5k+:1%
```

All three carry **`Spoilage Percent Min = 2`**.

> ### ⚠️ The 2% floor overrides Thermo's own brackets
>
> Thermo's brackets say 1% above 500 ft, but the minimum floor is 2%, so **effective
> flexpack spoilage above 500 ft is 2%, never 1%**. This is not a transcription error —
> it is what LT computes. Verified: 501 ft → bracket 1% → applied **2% [FLOOR]**; 400 ft
> → 3% (bracket wins). Lines where the floor won are flagged `floor (1%)` in the UI
> rather than silently reported as 2%.

**Bracket lookup is single-bracket, first-match — never a banded sum.** LT's ranges
overlap at the seams (ABGA has `51–101` immediately followed by `101–3,000`), so at
exactly 101 ft the **first** matching bracket wins (6%). Do not "tidy" the boundaries;
parity depends on them staying as entered.

**Past the top bracket:** ABGA stops at 100,000 ft. A longer run applies the last bracket
and is flagged `past curve` — returning 0% would understate a PO.

## Materials — HubSpot vocabulary → LT stock construction ID

`lib/integrations/hubspot-preorder/src/materials.ts`. `ltStockId` is what a PO is actually
raised against, so this map is the join between a quote and real inventory. **All 19
tracked IDs exist in `lt_stock`, are active, and carry real width/cost/supplier.**

| HubSpot value | LT stock |
|---|---|
| White BOPP | 177 |
| Silver / Metallic BOPP | 6 |
| Clear BOPP | 141 |
| Holographic BOPP | 249 |
| Thermal Transfer Paper | 73 |
| Direct Thermal Paper | 72 |
| Matte / Gloss / Soft Touch Laminate (label) | 160 / 161 / 71 |
| Flooded White Metalized PET (WMETPET) | **288** |
| Metalized PET (METPET) | **307** |
| High Barrier Clear PET | 278 |
| Standard Clear PET | 199 |
| Gloss / Matte / Soft Touch (flexpack laminate) | 193 / 286 / 296 |
| Zippers — CR gen1 / Non-CR / Gen2 CR | 174 / 176 / 303 |

**Standardisations in force:** all white met pet → **288**, all met pet → **307**, both at
2.5 mil LLDPE.

Two deliberate behaviours:

- **Varnishes map to `null`, not "missing".** Matte/Gloss Varnish are coatings, not roll
  stock — they consume no film.
- **An unmappable substrate goes to the review queue, never to a default.** A silent
  default would raise a PO for the wrong film. `"Other — please specify in notes"` and
  `"Custom Substrate"` are the common cases.

## Derived stock policy — and why it says "derived"

`stock_goal.min` and `reorder_point_footage` are **empty for every tracked material**, and
`lead_time_days` is set on exactly one. So safety stock and reorder point are derived:

```
leadTimeDays  = stock_goal.lead_time_days ?? median(measured PO order→receipt for vendor)
safetyStockFt = z(0.95) × √leadTimeDays × σ(daily usage)      [180-day history]
reorderPtFt   = dailyDemandFt × leadTimeDays + safetyStockFt
projectedFt   = onHand + openPO − firmDemand − weightedQuoteDemand
```

Every derived value is badged **"derived policy"** in the UI. Where no lead time or usage
history exists, thresholds are **not invented** — the card shows the position with no
threshold and says *"no policy could be derived"*.

The σ<sub>LT</sub> term of the full formula (`z·√(LT·σD² + d²·σLT²)`) is omitted because
per-stock lead-time spread is not available. That makes safety stock a **floor**.

## Control tower — the assumption registry

Every rule that moves a purchase order is registered with a provenance tag in
`lib/integrations/hubspot-preorder/src/equipment.ts` and rendered at the bottom of the
forecasting page. Tags: `LT_RECORD` · `USER_CONFIRMED` · `DERIVED` · `REPO_RULE` ·
`NOT_SOURCED`.

**Sourced:** HP make-ready 150 ft/job · ABGA, ABG3, Thermo curves · internal-only scope ·
the forward stage window · MetPet standardisation · column/row spacing 0.125″ (independently
confirmed on live LT products).

**NOT SOURCED — these contribute zero feet, so the forecast is a floor, not a number:**

| Missing | Effect |
|---|---|
| Make-ready on ABG A / ABG 3 / Thermo | every job understated by real laminating make-ready |
| HP's own spoilage curve | press pass carries make-ready only |
| Colour-change footage | multi-colour jobs understated (live products carry 4–5 colours) |
| Plate / die-tool change footage | new-die jobs get no extra make-ready |
| Flexographic / Rotogravure curves | 9 internal flexpack jobs route to non-digital presses and are costed on the digital assumption |

Supply any of these and every number on the page rises. That is the point of the panel:
you can audit the forecast instead of trusting it.

## What the LabelTraxx Cloud API does and does not expose

Probed read-only against `https://api.labeltraxx.com` (auth is a **bare**
`Authorization: <key>` header — no `Bearer` prefix).

**Available and valuable** — `GET /product-details?UniqueProdId=` returns **324 fields**,
including LT's own stored construction:

- `labelRepeat`, `noAcross`, `noAround`, `columnSpace`, `rowSpace` — real layout, so
  parity by construction instead of deriving
- `stockNum1..3` + `stockWidth1..3` + `stockDescr1..3` — real material assignment
  **including zippers**
- `press`, `equipId`, `equip3Id`..`equip6Id` — the real equipment chain
- `noOfColors`, `noFloods`, `toolNo1..5`
- `flexPackType`, `flexPackHeight`, `flexPackGusset`, `flexPackLeftTrim/RightTrim`

**Not available** — the spoilage curves and make-ready footage. `GET /equipments` returns
only 5 summary fields (`number`, `type`, `description`, `isActive`, `locationTag`), the
`number=` filter is ignored, and product `userDefMR1/2` are **booleans, not footage**.
Those numbers live in the LT desktop "Press Speeds and Spoilage" screens and must be
transcribed by hand.

`LT_API_KEY` is read from the environment. Requires `Page` (0-based) + `PageSize` (≤100).

## Corrections log — bugs the real data caught

Worth reading before trusting an older branch.

1. **Flexpack footage was overstated.** The code did `repeatIn = height + 0.125`, but real
   LT flexpack products carry `rowSpace = 0.0` and `labelRepeat == sizeAround` exactly
   (4.75→4.75, 3.25→3.25). Fixed. Total raw fell 5.53M → **5.438M ft**.
2. **`FLEXLAM` was not a real machine.** Flexpack laminating runs on **Thermo**; ABG 3
   also appears in flexpack chains, not labels-only as first encoded. Renamed to the real
   LT records.
3. **The double-count guard was silently returning zero.** It extracted the customer
   positionally from `custom_item_name`, but the format is inconsistent — both
   `CQ-Pure Buds-Labels-…` and `CQ-1725-Sugarhouse Farms-…` occur, so it was reading a job
   number as the customer. Now a normalised substring match plus an **exact quantity**
   match, so a shared customer alone can never suppress real demand.

## Double-count guard

A quote and the sales order it became are one demand. HubSpot's `netsuite_so_` only
populates once a deal reaches "Sales Order Created in NS" — measured **empty on 25 of 25**
open deals — so before that the fuzzy match is the only defence against a doubled PO.

## Pages and endpoints

| Route | Page | Endpoint |
|---|---|---|
| `/forecasting` | **Forecasting — quote stage** (live) | `GET /api/forecasting/quote-stage` |
| `/forward-demand` | **Forward Material Demand** (live) | `GET /api/forecasting/preorder` |

Both compute **on demand** — nothing is persisted (workspace hard rule: **never add Neon
tables**).

> `src/pages/forecasting.tsx` is the old **prototype on invented data**. It is kept on disk
> as a design reference but is **unrouted** — nothing false is reachable. Do not route it.

Neither endpoint is in `openapi.yaml` yet; both are called through `customFetch`. Adding
the schema and running Orval codegen is outstanding work.

### Running locally with live HubSpot

```bash
# API server (no watch — rebuild after every backend edit)
cd <repo> && set -a && . ./.env && set +a && PORT=8080 pnpm --filter @workspace/api-server run dev

# frontend — API_PROXY_TARGET is REQUIRED or /api will not proxy
PORT=5178 API_PROXY_TARGET=http://localhost:8080 pnpm --filter @workspace/inventory-adjustments run dev
```

Every `/api` route is behind `requireAuth`, so sign in through the browser; a bare curl
returns `401` (which is also how you tell "route mounted" from "route missing" — 404 means
the bundle is stale, see `.agents/memory/api-server-dev-rebuild.md`).

---
---

# Part B — how feet of material is calculated

This is the number that drives every material forecast, reorder point, and purchase order
in the app — and it is the single easiest thing to get subtly wrong.

## Why this matters

Every question the supply chain team asks — *how much substrate do we need, when do we
order it, are we about to run out, are we sitting on excess* — reduces to one
conversion:

> **A customer order (quantity of labels or pouches) → feet of a specific roll stock.**

That conversion is not a multiplication. It depends on how the label is laid out on the
web, which way it is rotated, what press it runs on, and how much material gets wasted
setting up. Two orders for the same label quantity can want materially different
footage.

---

## Three footage paths, on purpose

This is the most common source of confusion.

| | **PackOS estimating kernel** | **`label-footage.ts`** | **`quote-stage-forecast.ts`** |
|---|---|---|---|
| Question | "What do we charge?" | "How much stock will this want?" | "What do we buy, across the whole pipeline?" |
| Output | Exact consumed feet | Good length — a **floor** | Good length + real spoilage + HP make-ready |
| Spoilage | Real LT per-machine curves | none (caller adds an uplift) | **real ABGA / ABG3 / Thermo curves** |
| Make-ready | Modelled per pass | not modelled | HP 150 ft only — laminating **NOT SOURCED** |
| Multi-pass | `max(passFt)` over the chain | not modelled | `max()` for labels, `Π(1+sᵢ)` for flexpack |
| Must match LT | Yes, exactly | Only on good length | Good length exactly; totals are a floor |

`label-footage.ts` is a **deliberate subset** — a faithful port of the kernel's good-length
path only. `quote-stage-forecast.ts` layers the real curves on top of it.

**The order of operations and every `ceil`/`floor` boundary are preserved verbatim.**
Those boundaries are what move the number. Do not "tidy" them.

The legacy `forecast-sync.ts` path still writes a flat **8%** spoilage into
`ns_forecast_line.stock_demand`. `quote-stage-forecast.ts` **ignores that stored value and
recomputes on the real curves**, so HubSpot and NetSuite demand share one model. See
[the floor gap](#the-floor-gap--how-wrong-is-a-flat-8) for how wrong flat 8% is.

---

## The pipeline

```
 user enters:  sizeAcross × sizeAround  +  copyPosition
        │
        ▼
 [1] COPY POSITION ──► may SWAP the two dimensions (LEFT/RIGHT = 90° rotation)
        │              effectiveAcross = cross-web   effectiveAround = down-web
        ▼
 [2] LAYOUT ─────────► noAcross   how many fit across the web
                       noAround   how many fit around the cylinder
                       repeatIn   down-web pitch per row
        │
        ▼
 [3] GOOD LENGTH ────► ceil(qty / noAcross) × repeatIn / 12   = feet of SELLABLE web
        │                                                       ◄── label-footage.ts stops here
        ▼
 [4] PER-PASS FEET ──► linear + spoilage + setup, once per machine pass
        │
        ▼
 [5] STOCK TO BUY ───► max(passFt) across the chain × CHARGE width → MSI → $
```

---

## [1] Copy position — the part people miss

Copy position says which edge of the label peels first. There are 11 canonical
LabelTraxx values. Four of them **swap the dimensions**, because the label is rotated
90° on the web:

| Swaps | Does not swap |
|---|---|
| `OUT_LEFT_4`, `OUT_RIGHT_3`, `IN_LEFT_8`, `IN_RIGHT_7` | `OUT_TOP_1`, `OUT_BTM_2`, `IN_TOP_5`, `IN_BTM_6`, `OUT_BLANK`, `IN_BLANK`, `NA` |

`OUT_BTM_2` is the default and the most common.

**Wind direction (`IN_` vs `OUT_`) never affects footage.** It only decides how the
finished roll is wound. Only the TOP/BTM vs LEFT/RIGHT axis matters for material,
because that is what decides which edge runs down-web.

HubSpot stores this as `Copy 1`–`Copy 4`, mapped `→ OUT_TOP_1 / OUT_BTM_2 / OUT_RIGHT_3 /
OUT_LEFT_4`. **Copy 3 and Copy 4 are the swapping ones.**

### Why it is load-bearing

Rotation does not change the label's area. It changes *which edge runs down-web* — and
that drives both `repeatIn` and `noAcross`. Real job, Curaleaf 7g flower jar label,
7.42″ × 1.2″, 20,000 units:

| Copy position | Effective across × around | Repeat | noAcross | Good length |
|---|---|---|---|---|
| `OUT_BTM_2` | 7.42″ × 1.2″ | 1.325″ | 1 | **2,208 ft** |
| `OUT_LEFT_4` | 1.2″ × 7.42″ | 7.545″ | 9 | **1,398 ft** |

Same label, same quantity, **37% less material** in one orientation. If a forecast
assumes the wrong copy position, it is wrong by that much before anything else happens.

> Verified against LabelTraxx estimate **5516**: `LabelRepeat = 1.325″`, `NoAcross = 1`.

---

## [2] Layout

```
noAcross = floor((webWidth − effectiveAcross) / (effectiveAcross + columnSpace)) + 1
repeatIn = max(effectiveAround + rowSpace, cylinderRepeatStep)
noAround = max(1, floor(maxRepeat / repeatIn))
```

The `+ 1` in `noAcross` is the first label. Gaps only sit *between* labels, which is why
this is **not** `floor(webWidth / (across + gap))`.

Defaults when nothing supplies a value: `USABLE_WEB_WIDTH = 12.5″`,
`DEFAULT_PRESS_MAX_REPEAT_IN = 24″`. Where a stock is known, the forecast uses its real
`lt_stock.master_width` instead.

**Label spacing is 0.125″ / 0.125″** — independently confirmed on live LT products
(`columnSpace: 0.125, rowSpace: 0.125`). **Flexpack spacing is 0.0** — see the flexpack
section; getting this wrong overstated every pouch line.

### The cylinder repeat floor

A press cylinder turns in discrete steps. When the press supplies a
`cylinderRepeatStepIn` **greater than** the additive pitch, the repeat is raised to the
cylinder step. The extra web between labels is real stock you buy.

For a 1.2″ label with 0.125″ row space on a cylinder with a 2.0″ step:

- additive pitch — 1.325″
- applied repeat — **2.0″**
- good length at 20,000 — 2,208 ft → **3,333 ft (+51%)**

Ignoring the cylinder step **under-quotes small labels on flexo presses**, badly.

### Gear teeth

```
gearTeeth = round(repeatIn × noAround / 0.125)
```

0.125″ is the gear-tooth pitch. LabelTraxx stores this per estimate — it is the physical
proof of the repeat, and the best cross-check that a derived layout matches reality.

---

## [3] Good length

```
goodLengthFt = ceil(quantity / noAcross) × repeatIn / 12
```

`ceil`, because a partial row still costs a whole repeat.

---

## [4] Per-pass consumption

Each machine pass consumes its own footage:

```
linearFt   = (qty / noAcross) × repeatIn / 12 × (1 + Σ addRunLength% / 100)
spoilageFt = linearFt × max(bracketPct + Σ spoilageChange, machineFloor) / 100
setupFt    = base + colorFt × numColors + plateFt × numTools + Σ stockSetUpLength
passFt     = linearFt + spoilageFt + setupFt
```

**Spoilage is a single bracket lookup, not a banded sum.** Short runs waste a much larger
fraction, so the percentage falls as length rises. A `highFt` of `0` means the top
bracket is unbounded. All three Calyx curves carry a **2% minimum floor** — and on Thermo
that floor overrides the brackets entirely (see
[The real spoilage curves](#the-real-spoilage-curves) in Part A).

`omitMakeReadyCycle` zeroes setup entirely — used by passes that piggyback an
already-set-up machine.

> ### ⚠️ `ceil` in step 3, plain division in step 4
>
> `goodLengthFt` uses `ceil(qty / noAcross)`. `linearFt` uses plain `qty / noAcross`.
>
> This is deliberate and matches LabelTraxx: good length is the quoted sellable web,
> while pass consumption is continuous. The difference is sub-foot on large quantities
> and visible on tiny ones. **Do not "fix" one to match the other** — parity depends on
> both staying as they are.

---

## [5] Stock to buy

```
stockLengthFt = max(passFt) across the chain      ← NOT the sum
MSI           = stockLengthFt × 12 × chargeWidthIn / 1000
cost          = MSI × costPerMsi
```

**Max, not sum.** The same physical web travels through press, laminator, die and
rewind. You buy enough for the hungriest pass.

*(Flexpack differs: converting steps compound, `Π(1 + sᵢ)`, because each step spoils what
the previous one already spoiled.)*

### Charge width ≠ required width

You cannot buy 7.545″ of web. You buy the smallest stocked **RUN** width that fits, and
depending on `chargeWidthBasis` you may be **billed** for the parent **LOG** width — so
the offcut is charged to the job.

```
required 7.545″  →  RUN 7.5″ … 8.5″  →  LOG 12.5″
chargeWidth = RUN or LOG per policy;  offcut = LOG − RUN  (paid for, not printed)
```

Feet alone do not give cost. **Feet × charge width → MSI → dollars.**

---

## Flexpack — the axes are inverted

This trips up everyone once. The convention is the **opposite** of labels:

| | Down-web (drives pitch) | Cross-web (drives web width) |
|---|---|---|
| **Label** | `sizeAround` | `sizeAcross` |
| **Flexpack** | `productWidth` | `productHeight` |

```
pouchPitch   = cylinderRepeatIn ?? (productWidth + interPouchGap)
webWidth     = (productHeight + gusset + leftTrim + rightTrim) × noAcross
               + interPouchGap × (noAcross − 1)
```

Mixing these up produces a plausible-but-wrong number with no error, which is why labels
and pouches have separate helpers.

> **⚠️ Flexpack `rowSpace` is 0.0, not 0.125.** Real LT flexpack products carry
> `rowSpace: 0.0` and `labelRepeat == sizeAround` **exactly** (4.75→4.75, 3.25→3.25).
> Adding label row-spacing to a pouch overstates every line. This was a live bug; see the
> [corrections log](#corrections-log--bugs-the-real-data-caught).

**Prefer the true cylinder repeat when available** — `gearTeeth × 0.125 / noAround`.
LabelTraxx prices good length on cylinder geometry, not the blank pitch. On estimate
**7761**: `320 × 0.125 / 5 = 8.000″` versus a blank pitch of 8.125″ — a **1.6%
over-charge** if the cylinder repeat is ignored.

> Verified against LabelTraxx estimates **7740**, **7745**, **7842**: in every case
> `productWidth → SizeAround` (down-web) and `productHeight → SizeAcross`.
> Estimate 7740 — `repeatIn 8.5`, `requiredRunWidthIn 12.25`, `goodLengthFt 1770.83`,
> exact match against the live kernel.

---

## What `label-footage.ts` implements, and what it does not

**Implemented** — copy position and the swap rule, `deriveNoAcross`,
`computeLabelRepeatIn` including the cylinder floor, `computeGoodLengthFt`, `feetToMsi`,
and `forecastLineFootage` which explodes an order line to `{stockId, widthIn, footage}`.

**Deliberately not implemented** — per-pass spoilage curves, setup/make-ready feet,
multi-pass `max()` chaining, width selection, and cost. (`quote-stage-forecast.ts` now
supplies the spoilage curves, the `max()` / compounding rule, and HP make-ready.)

Two behaviours worth knowing:

1. **LabelTraxx's own geometry wins.** If the LT product carries `labelRepeat` and
   `noAcross`, those are used directly and the layout derivation is skipped — parity by
   construction. The layout math is a **fallback** for products missing them, and the
   result carries a `derived: true` flag so you can tell which happened.
   *(The quote-stage path currently derives from HubSpot geometry; wiring it to LT's
   stored construction via `/product-details` is outstanding work.)*
2. **Footage is broadcast identically to every stock in the construction.** That is
   correct physics for roll-fed converting: film, laminate and zipper all run the same
   web length and differ only in width. It is *not* a bug. It does mean anything consumed
   by weight or area (adhesive, ink) cannot be represented, and the construction is
   capped at three stock slots.

---

## The floor gap — how wrong is a flat 8%?

Relevant to the **legacy** `forecast-sync.ts` path, which still stores a flat
`FORECAST_SPOILAGE_PCT` uplift. A single number standing in for a curve has
**direction-dependent** error: setup feet are fixed per job, so they dominate short runs
and amortise away on long ones.

Curaleaf label above, 1-across at a 1.325″ repeat, through a press → laminate → die
chain:

| Quantity | Good length | True stock needed | True uplift | Flat 8% gives | Error |
|---:|---:|---:|---:|---:|---:|
| 500 | 55 ft | 312 ft | +465% | 60 ft | **−81%** |
| 1,000 | 110 ft | 374 ft | +238% | 119 ft | **−68%** |
| 2,500 | 276 ft | 559 ft | +103% | 298 ft | **−47%** |
| 5,000 | 552 ft | 868 ft | +57% | 596 ft | **−31%** |
| 10,000 | 1,104 ft | 1,420 ft | +29% | 1,193 ft | **−16%** |
| 20,000 | 2,208 ft | 2,591 ft | +17% | 2,385 ft | **−8%** |
| 50,000 | 5,521 ft | 5,936 ft | +7.5% | 5,963 ft | +0.4% |
| 100,000 | 11,042 ft | 11,623 ft | +5.3% | 11,925 ft | +2.6% |
| 250,000 | 27,604 ft | 28,682 ft | +3.9% | 29,813 ft | +3.9% |

**Break-even is around 45,000 units.** Below it the forecast **under-buys**; above it,
it over-buys slightly.

> **Caveat.** The curve (12/6/3%) and setup constants in *this table* are the
> *illustrative* values from the kernel extract's demo. **The real Calyx curves are now
> in `spoilage.ts`** and are what the quote-stage forecast uses. The magnitudes here are
> indicative; **the shape is robust** — a flat percentage will always under-buy short runs
> and over-buy long ones regardless of the constants.

### Why this matters for planning

Short runs are disproportionately **custom, one-off jobs** — exactly the category where
a wrong material buy turns into dead stock nobody can consume. So the under-buy skew and
the excess-inventory problem hit the same jobs from both sides: you under-forecast the
material, expedite it, and then over-order to be safe.

The fix is in progress: the quote-stage path already uses the real bracket curves. What
remains is the missing **make-ready** footage — which is precisely the term that dominates
short runs, so **short-run jobs are still the least accurate**.

---

## Reference

| Concern | File |
|---|---|
| Footage geometry | `artifacts/api-server/src/lib/label-footage.ts` |
| **Quote-stage forecast (live, real data)** | `artifacts/api-server/src/lib/quote-stage-forecast.ts` |
| **HubSpot forward demand** | `artifacts/api-server/src/lib/hubspot-preorder-forecast.ts` |
| **Read-only HubSpot client, materials, curves, assumptions** | `lib/integrations/hubspot-preorder/` |
| Legacy NetSuite order → material demand | `artifacts/api-server/src/lib/forecast-sync.ts` |
| Demand metrics, seasonality, on-hand, open POs | `artifacts/api-server/src/lib/demand.ts` |
| 13-week time-phased MRP | `artifacts/api-server/src/lib/mrp.ts` |
| Sankey (stage sections, collision-resolved labels) | `artifacts/inventory-adjustments/src/components/footage-flow-sankey.tsx` |
| Legacy flat spoilage setting | `FORECAST_SPOILAGE_PCT` (default 8) |

Upstream kernel, in call order:

1. `shared/copy-position.ts` → `applyCopyPositionToLayout()`
2. `shared/estimating/derive-layout-counts.ts` → `deriveLayoutCounts()`
3. `server/estimating/kernel/formulas/footage.ts` → `computeLabelRepeatIn()`,
   `computeGearTeeth()`, `computeLabelGoodLengthFt()`, `computeLabelRequiredRunWidth()`,
   `selectLabelWidths()`, `computeFlexpackGoodLengthFt()`
4. `server/estimating/kernel.ts` → `computeSlotFootage()`

### Summary of the formulas

```
1. SWAP       effectiveAcross/Around = swap(copyPosition), applied FIRST
              swap iff LEFT/RIGHT (OUT_LEFT_4, OUT_RIGHT_3, IN_LEFT_8, IN_RIGHT_7)

2. LAYOUT     noAcross = floor((webWidth − across) / (across + colSpace)) + 1
              repeatIn = max(around + rowSpace, cylinderRepeatStep)
              noAround = max(1, floor(maxRepeat / repeatIn))
              labels: colSpace = rowSpace = 0.125    flexpack: rowSpace = 0

3. GOOD FEET  goodLengthFt = ceil(qty / noAcross) × repeatIn / 12

4. PASS FEET  linearFt   = (qty / noAcross) × repeatIn / 12 × (1 + addRun%/100)
              spoilageFt = linearFt × max(bracketPct, machineFloor=2%)/100
              setupFt    = HP 150 ft/job  (+ laminating make-ready: NOT SOURCED)
              passFt     = linearFt + spoilageFt + setupFt

5. STOCK      labels:   stockLengthFt = max(passFt) over the chain
              flexpack: stockLengthFt = goodFt × Π(1 + sᵢ) + make-ready
              MSI  = stockLengthFt × 12 × CHARGE width / 1000
              cost = MSI × costPerMsi
```

### Next steps, in order of value

1. **Supply the missing make-ready footage** (ABG A / ABG 3 / Thermo, colour change, plate
   change). This is the largest remaining source of error and the reason short runs
   under-buy.
2. **Wire the quote-stage path to LT's stored construction** via `/product-details` —
   parity by construction instead of derived layout, plus real stock and zipper assignment.
3. **Add both endpoints to `openapi.yaml`** and generate hooks, per the repo contract rule.
4. **Populate `stock_goal`** so safety stock and reorder point stop being derived.
