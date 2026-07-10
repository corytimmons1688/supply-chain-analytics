# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Inventory Adjustments Dashboard

Read-only dashboard over Label Traxx (via gateway). Two top-level sections:
- **Inventory Control** (`/`, `/stock/:id`, `/goals`, `/snapshots`, `/root-cause`, `/cycle-counts`): rolls where `PONumber` starts with `"CC "` count as added; `UsedTikNum` starting `"CC "` counts as removed. Goal bands, weekly/monthly snapshots. **Root Cause** (per WI-INV-025 framework) lists every stock with CC variance in the selected window (net ft, net $, % of on-hand). A row only requires investigation when `|net $| > $1,000` OR `|% of on-hand| > 0.5%` (strict greater-than, OR semantics). Header toggle defaults to "show only items requiring investigation". Each above-threshold row exposes two independent flows: (1) **Investigation** — Status (`open` / `root_cause_id` / `closed`), Root Cause Category dropdown (`missing_from_system` / `missing_from_floor` / `data_error` / `consumed_without_po` / `in_use` / `damage` / `other`), Owner (text), Evidence/Notes (text); (2) **Corrective Action** — CA Status (`not_started` / `in_progress` / `complete`), Action Required (text), CA Owner (text). Below-threshold rows show a "no investigation required" note instead of the form (Save disabled). Persisted on `stock_goal` columns `variance_status`, `root_cause_category`, `root_cause` (notes), `investigation_owner`, `corrective_action_status`, `corrective_action`, `corrective_action_owner` — no new tables. Legacy `variance_status` values `'completed'` / `'no_investigation'` are normalized to `'closed'` on read. Endpoints: `GET /adjustments/root-cause?from=&to=` (joins `fetchOnHandByStock` to compute `pctOfOnHand`) and `PUT /adjustments/root-cause/:stockId`. Empty/whitespace text is canonicalized to `null` server-side. **Cycle Count Schedule** (`/cycle-counts`) generates ABC-driven count plans per financial quarter (A weekly, B monthly, C quarterly), assignment via stable djb2 hash so rotations are deterministic. Q2 2026 is a one-time consolidated cycle (May 4 → Jun 28, 8 weeks). Snapshot persisted in `global_goal.cycle_count_schedule` (jsonb) and regenerated when the stored quarter ≠ current quarter (or on manual `POST /cycle-counts/regenerate`). Per-stock check-offs persisted in `stock_goal.cycle_count_completions` (jsonb array of `{quarter, week, completedAt}`); mark/unmark uses atomic SQL upsert with in-DB `(quarter,week)` dedupe to avoid lost-update races. KPI is on_track / behind / not_started, computed cumulatively through the last fully-completed week (in-progress current week excluded). Endpoints: `GET /cycle-counts/schedule`, `GET /cycle-counts/kpi`, `POST /cycle-counts/regenerate`, `POST/DELETE /cycle-counts/complete`. Dashboard shows a clickable KPI banner card.
- **Demand Planning** (`/demand`, `/demand/:stockId`): 6-month historical footage demand, 12-week forecast with quarterly seasonality (month 3 = 50%, months 1+2 = 25% each), lead times derived from PO placed→received, suggested min/max with safety stock (`z·√(LT·σD² + d²·σLT²)`). Per-stock manual overrides (stored on `stock_goal`): `demandCv`, `leadTimeCv`, `seasonalityWeights[3]`, `leadTimeDays` (avg supplier lead time), `typicalRollFootage` (incoming roll size used to round suggested POs). Each metric returns `auto*` + `*Overridden` flags. Non-positive overrides are normalized to `null` on write to keep persistence and compute semantics consistent. **Open POs** (unreceived `purchaseorder` rows where `POType='Stock'` AND `Received < 1900-01-01` AND `Closed != 'true'`) are joined per-stock by `OrderStockNum`; estimated on-order footage = `Σ Quantity × typicalRollFootage`. The summary returns `openPoCount` / `openPoRolls` / `openPoFootage`; the detail endpoint also returns the per-PO list. The Stock-by-stock plan is always sorted with below-ROP items pinned to the top regardless of the user-selected sort key, so action items lead.

Hard rules:
- NEVER write to Label Traxx.
- NEVER add new tables to Neon Postgres (only `goals` table in `lib/db/src/schema/`).
- Active-stock filter (`stock.Inactive`) applies ONLY to `/demand/*` endpoints, NOT to Inventory Control.
- Gateway caps query responses at 1000 rows — always chunk by month for large tables (`purchaseorder`, `rollstock`, `usage`). Helper: `eachMonthRange(fromIso, toIso)` in `artifacts/api-server/src/lib/demand.ts`.
- `rollstock.FootLength` is **per-piece**, not per-incoming-roll. When a roll is slit, children share `Orig_RollID` (and `IDNumber` like `"6184-A"`, `"6184-B"`). To compute the original incoming roll size (e.g. for "typical roll"), sum `FootLength` grouped by `Orig_RollID`.
