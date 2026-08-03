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

The rest of this document explains **how feet of material is calculated**, because
that number drives every material forecast, reorder point, and purchase order in
the app — and it is the single easiest thing to get subtly wrong.

---

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

## There are two footage engines, on purpose

This is the first thing to understand, and the most common source of confusion.

| | **PackOS estimating kernel** | **This repo** (`label-footage.ts`) |
|---|---|---|
| Question it answers | "What do we charge for this job?" | "How much stock will this order want?" |
| Output | Exact consumed feet, to the cent | Good length — a planning **floor** |
| Spoilage | Per-machine bracket curves from LT equipment records | Flat `FORECAST_SPOILAGE_PCT` uplift (default 8%) |
| Setup / make-ready feet | Modelled per pass | Not modelled |
| Multi-pass chain | `max(passFt)` across press → laminate → die → rewind | Not modelled |
| Must match LabelTraxx | Yes, exactly | Only on good length |

`artifacts/api-server/src/lib/label-footage.ts` is a **deliberate subset** — a faithful
port of the kernel's good-length path only. Its own header says why: the per-pass
spoilage and setup curves live on LabelTraxx equipment records this app does not pull.

**The order of operations and every `ceil`/`floor` boundary are preserved verbatim
between the two.** Those boundaries are what move the number. Do not "tidy" them.

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
        │                                                       ◄── this repo stops here
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
`DEFAULT_PRESS_MAX_REPEAT_IN = 24″`.

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

`ceil`, because a partial row still costs a whole repeat. This is the number this repo
forecasts, and what the Studio shows as "feet of material."

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
bracket is unbounded. Some machines carry a minimum spoilage floor (THERMO and ABG are
2%).

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

**Prefer the true cylinder repeat when available** — `gearTeeth × 0.125 / noAround`.
LabelTraxx prices good length on cylinder geometry, not the blank pitch. On estimate
**7761**: `320 × 0.125 / 5 = 8.000″` versus a blank pitch of 8.125″ — a **1.6%
over-charge** if the cylinder repeat is ignored.

> Verified against LabelTraxx estimates **7740**, **7745**, **7842**: in every case
> `productWidth → SizeAround` (down-web) and `productHeight → SizeAcross`.
> Estimate 7740 — `repeatIn 8.5`, `requiredRunWidthIn 12.25`, `goodLengthFt 1770.83`,
> exact match against the live kernel.

---

## What this repo implements, and what it does not

`artifacts/api-server/src/lib/label-footage.ts`:

**Implemented** — copy position and the swap rule, `deriveNoAcross`,
`computeLabelRepeatIn` including the cylinder floor, `computeGoodLengthFt`, `feetToMsi`,
and `forecastLineFootage` which explodes an order line to `{stockId, widthIn, footage}`.

**Deliberately not implemented** — per-pass spoilage curves, setup/make-ready feet,
multi-pass `max()` chaining, width selection, and cost. Those need LT equipment records
this app does not pull.

Two behaviours worth knowing:

1. **LabelTraxx's own geometry wins.** If the LT product carries `labelRepeat` and
   `noAcross`, those are used directly and the layout derivation is skipped — parity by
   construction. The layout math is a **fallback** for products missing them, and the
   result carries a `derived: true` flag so you can tell which happened.
2. **Footage is broadcast identically to every stock in the construction.** That is
   correct physics for roll-fed converting: film, laminate and zipper all run the same
   web length and differ only in width. It is *not* a bug. It does mean anything consumed
   by weight or area (adhesive, ink) cannot be represented, and the construction is
   capped at three stock slots.

---

## The floor gap — how wrong is a flat 8%?

Good length is a floor, and the app adds a flat `FORECAST_SPOILAGE_PCT` uplift on top.
That uplift is a single number standing in for a curve, so its error is
**direction-dependent**: setup feet are fixed per job, so they dominate short runs and
amortise away on long ones.

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

> **Caveat, read this before quoting the numbers.** The spoilage curve (12/6/3%) and
> setup constants (press 150 ft + 25 ft/colour, laminate 100 ft, die 120 + 30 + 40 ft)
> are the *illustrative* values from the kernel extract's demo, not real LT equipment
> records — this app does not pull those. **The magnitudes are indicative; the shape is
> robust.** Setup feet are fixed per job, so a flat percentage will always under-buy
> short runs and over-buy long ones regardless of the exact constants. Pull the real
> equipment rows before using any of these figures in a purchasing decision.

### Why this matters for planning

Short runs are disproportionately **custom, one-off jobs** — exactly the category where
a wrong material buy turns into dead stock nobody can consume. So the under-buy skew and
the excess-inventory problem hit the same jobs from both sides: you under-forecast the
material, expedite it, and then over-order to be safe.

Two candidate fixes, in order of effort:

1. **Make the uplift quantity-dependent** rather than flat — a bracket curve keyed on
   good length would remove most of the error with no new data source.
2. **Pull LT equipment records** (spoilage curves, setup feet per machine) and compute
   real per-pass consumption. Correct, and a bigger job.

---

## Reference

| Concern | File |
|---|---|
| Footage math in this repo | `artifacts/api-server/src/lib/label-footage.ts` |
| Order line → material demand | `artifacts/api-server/src/lib/forecast-sync.ts` |
| Demand metrics, seasonality, safety stock | `artifacts/api-server/src/lib/demand.ts` |
| 13-week time-phased MRP | `artifacts/api-server/src/lib/mrp.ts` |
| Spoilage uplift setting | `FORECAST_SPOILAGE_PCT` (default 8) |

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

3. GOOD FEET  goodLengthFt = ceil(qty / noAcross) × repeatIn / 12

4. PASS FEET  linearFt   = (qty / noAcross) × repeatIn / 12 × (1 + addRun%/100)
              spoilageFt = linearFt × max(bracketPct + delta, machineFloor)/100
              setupFt    = base + colorFt×colors + plateFt×tools + udfSetupFt
              passFt     = linearFt + spoilageFt + setupFt

5. STOCK      stockLengthFt = max(passFt) over the chain
              MSI  = stockLengthFt × 12 × CHARGE width / 1000
              cost = MSI × costPerMsi
```
