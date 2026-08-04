# HubSpot Pre-Order Support → Material Footage Forecast

**Status:** implementation plan (not yet built)
**Goal:** extend Demand Planning's horizon from *statistical projection of past LT
usage* to *known upcoming demand* by converting open HubSpot pre-order estimate
tickets into feet-of-roll-stock by stock and by month, for **Flexpack + Labels**.

This document is the spec. It was written after verifying, read-only, that the
tickets actually carry the data the footage engine needs. No HubSpot writes were
made and none are required — this integration is **read-only** end to end.

---

## 1. Why this is feasible (verification results)

Sample: **948 Estimating-pipeline tickets, created since Feb 2026**, pulled via
`POST /crm/v3/objects/2-52567425/search` filtered on `hs_pipeline = 820783656`.

The conversion in [`README.md`](../README.md) is `order → feet of a specific roll
stock`, and it needs two input classes. HubSpot owns one; we already own the other:

| Input class | Fields | Source | Status |
|---|---|---|---|
| **Job spec** — what / how much / how big / what material | qty, dimensions, substrate, copy position | **HubSpot pre-order support** | ✅ verified populated |
| **Layout** — how it lays on the web | `noAcross`, `labelRepeatIn`, column/row space, cylinder step, press | **LabelTraxx** (`gateway.ts` / `ltApi.ts`) + `label-footage.ts` derive-fallback | ✅ already in repo |

The tickets have **0% fill on `number_across` / `number_around` / repeat / gaps** —
and that is expected and fine. Those were never HubSpot's job. `label-footage.ts`
already derives layout from dimensions + web width when LT has no stored product
record yet (the normal pre-order case), and prefers LT's stored `labelRepeat` /
`noAcross` when it does.

### Measured fill rates (the fields the engine actually consumes)

**Labels (n=246)**

| Field | Fill | Maps to engine input |
|---|---|---|
| `quantity_needed` | 98% | `quantity` |
| `copy_position` | 99% | `copyPosition` (needs map — see §3) |
| `product_width` | 100% | `sizeAcrossIn` |
| `product_height` | 100% | `sizeAroundIn` |
| `label_substrate` | 99% | roll-stock selection (needs map — see §3) |
| `label_finish` | 95% | roll-stock selection |

**Flexpack (n=446)**

| Field | Fill | Maps to engine input |
|---|---|---|
| `product_width` | 100% | `sizeAcrossIn` |
| `product_height` | 100% | `sizeAroundIn` |
| `product_depth` | 72% | gusset / third dimension |
| `flexible_packaging_substrate` | 100% | roll-stock selection |
| `flexible_packaging_finish` | 100% | roll-stock selection |
| `flexible_packaging_style` | 100% | pouch geometry (compound `;`-delimited) |
| `gusset_style` | 100% | geometry |
| `quantity_needed` | 94% | `quantity` |

Dimensions are **also** parseable from `custom_item_name`
(`CQ-<company>-<type>-<W x H x D>- <id>`) — 86% of labels, 100% of flexpack — usable
as a cross-check or fallback when a numeric field is blank.

---

## 2. What this integration IS

Demand Planning today forecasts from **historical** LT usage (6-mo history →
12-week projection with seasonality). HubSpot pre-order support is the **forward
book of known-but-not-yet-ordered jobs** — the estimating pipeline. Feeding it in
turns "projection of the past" into "actual upcoming material need," which is the
"clear visibility into the next few months" the requester asked for.

It is an **additive forward-demand layer**, bucketed by ticket `due_date` (fallback
`hs_createdate` + lead offset), joined into the existing Demand Planning views.

---

## 3. The three gaps to handle (all solved below)

### 3a. `copy_position` is coded "Copy 1–4", not the LabelTraxx enum

Observed values: `Copy 2` (103), `Copy 3` (77), `Copy 4` (44), `Copy 1` (20).
Deterministic map into `CopyPosition` from `label-footage.ts`:

| HubSpot value | `CopyPosition` | Swaps dims? |
|---|---|---|
| `Copy 1` | `OUT_TOP_1` | no |
| `Copy 2` | `OUT_BTM_2` (default) | no |
| `Copy 3` | `OUT_RIGHT_3` | **yes** |
| `Copy 4` | `OUT_LEFT_4` | **yes** |
| (null) | `OUT_BTM_2` | no |

⚠️ **Load-bearing.** Per README, the LEFT/RIGHT swap moves footage by up to **37%**.
This tiny table is the single most important mapping in the integration. Flexpack
shows `copy_position` 0% because its down-web axis is carried in the pouch geometry
instead; flexpack uses the engine's flexpack path, not copy position.

### 3b. Substrate vocabulary → roll-stock material

Low-cardinality and consistent. Build one lookup table to the app's stock / material
identifiers (flexpack even embeds the code in parens, e.g. `WMETPET`).

Labels: `White BOPP` (125), `Silver / Metallic BOPP` (65), `Clear BOPP`, `Thermal
Transfer Paper`, `Direct Thermal Paper`, `Holographic BOPP`, `Other - Please specify
in notes`.
Flexpack: `Flooded White Metalized PET (WMETPET)` (167), `Metalized PET (METPET)`
(127), `High Barrier Clear PET` (77), `Standard Clear PET` (39), `Custom Substrate -
Please specify in Notes` (35).

`Other/Custom - specify in notes` (~5%) cannot auto-map → route to the exception
list (§5), do not silently drop.

### 3c. Quantity data-quality tail

`quantity_needed = 0/blank` on 24/445 flexpack and 4/246 labels. These can't be
forecast → **exception list**, not silent drop.

---

## 4. Confidence weighting (raw + stage-weighted)

Output BOTH: **raw** (every open ticket at full quantity) and **stage-weighted**.

The pre-order object's own stages (`Request Que → Quote Completed → Quote
Accepted/Rejected`) track the *estimating workflow*, not deal-win, and carry no
probability metadata. But **95% of tickets associate to a Deal** (association
`Estimate Request`, typeId 223 / default 219). So:

- **Primary weight = the associated Deal's stage probability** (via
  `crm/v4/objects/2-52567425/{id}/associations/deals`, then read
  `hs_deal_stage_probability` on the deal). This reuses the exact probabilities from
  the deal pipelines already in the app.
- **Fallback map** for the ~5% orphan tickets, keyed on the pre-order stage:

  | Pre-order stage | Weight |
  |---|---|
  | Quote Accepted | 0.9 |
  | Quote Approved (Old) | 0.9 |
  | Quote Completed | 0.5 |
  | In Progress | 0.3 |
  | Request Que / Pending Information | 0.2 |
  | Quote Rejected | 0.0 (exclude) |

Exclude `Quote Rejected` (238 in the 6-mo sample) from both views.

---

## 5. Build plan (follows existing repo conventions)

### Connection
HubSpot **private app token** (`pat-na1-…`), sent as `Authorization: Bearer <token>`.
Single-account internal app — no OAuth flow. Store in `.env`.
**Hardening (recommended, requester's call):** create a *second* private app scoped
`crm.objects.custom.read` only, so the app physically cannot write. Creating that app
is a HubSpot settings action — out of scope for the code here.

### Endpoint used (read-only)
`POST /crm/v3/objects/2-52567425/search`
- filter `hs_pipeline = 820783656` (Estimating), `hs_is_closed`/stage ≠ Rejected
- properties: `quantity_needed, custom_item_name, copy_position, product_width,
  product_height, product_depth, label_substrate, label_finish,
  flexible_packaging_substrate, flexible_packaging_finish, flexible_packaging_style,
  gusset_style, due_date, hs_createdate, hs_pipeline_stage`
- paginate on `paging.next.after` (200/page)
- batch deal-probability via `crm/v4/associations/2-52567425/deals/batch/read`

### Files (mirror existing patterns)
```
lib/integrations/hubspot/                 ← new pkg, mirror lib/carrier-tracking/
  package.json                              "@workspace/hubspot-preorder"
  src/index.ts                              client + search + Zod types
  src/copy-position.ts                      §3a map → CopyPosition
  src/substrate-map.ts                      §3b map → stock/material id

artifacts/api-server/src/lib/
  hubspot-preorder-sync.ts                ← mirror lt-sync.ts / forecast-sync.ts:
                                            fetch → normalize spec → map copy/substrate
                                            → forecastLineFootage() → feet by stock/month
                                            (raw + weighted), + exceptions list

artifacts/api-server/src/routes/
  demand.ts (extend) or preorder.ts       GET /demand/preorder?from=&to=&weighted=
```

### Contract-first (hard rule in README)
Add `PreorderForecast` response shape to `lib/api-spec/openapi.yaml`, then
`pnpm --filter @workspace/api-spec run codegen` before writing the route.

### Persistence (hard rule: NEVER add Neon tables)
Start **on-demand** (compute per request; HubSpot search is fast). If caching is
needed later, use existing `global_goal` jsonb (same pattern as cycle-count
schedule) — **no new table**.

### Engine reuse
Feed `product_width` → `sizeAcrossIn`, `product_height` → `sizeAroundIn`,
`quantity_needed` → `quantity`, mapped copy position → `copyPosition`, into the
**existing** `forecastLineFootage()` in
`artifacts/api-server/src/lib/label-footage.ts`. Labels use the good-length +
derive-`noAcross` path; flexpack uses the flexpack compounding path. Do not
reimplement any footage math — the `ceil`/`floor` boundaries are parity-critical.

---

## 6. Output shape (target)

Per stock × month: `rawFeet`, `weightedFeet`, `ticketCount`, drill-down to the
contributing tickets (id, company, qty, dims, mapped stock, weight, deal link), plus
a top-level `exceptions[]` for tickets missing qty or with unmappable substrate.

## 7. Open decisions for the implementer
- `due_date` vs `hs_createdate + lead-time offset` as the month bucket (due_date is
  62–72% filled; needs a fallback rule).
- Whether to also fold **New Product Request** stage tickets in, or estimates only.
- Exact substrate→stock id mapping values (needs a pass with the roll-stock master).
