---
name: Vendor scorecard period windowing
description: The date-window contract shared by the scorecard rollup (backend) and the PO / quality-case tables (frontend).
---

The Vendor Scorecards page resolves a single period `[periodStart, periodEnd]`
(date strings) from the top filters (period view + anchor month), returned on the
scorecards response **root** (`data.periodStart` / `data.periodEnd`), NOT on each
`Scorecard` item.

**Windowing contract (must stay in lockstep across frontend + backend):**
- Shipments / POs are windowed by `actualShipDate ?? customerDate` in
  `[start, end]`. The KPI on-time/lead numbers and the "Purchase orders" table
  use this same rule so the table's rows match the KPI population.
- Quality cases are windowed by `startDate == null || startDate in [start, end]`
  (undated cases always count). The KPI quality counts and the "Quality cases"
  table use this same rule.

**Why:** if the table date logic and the rollup date logic diverge, the table
will show a different set of rows than the KPI count claims, which reads as a bug
to the user. The architect flagged this drift risk explicitly.

**How to apply:** any change to how a table is date-filtered must be mirrored in
the corresponding rollup filter in `routes/vendors.ts` (`inWindow(...)`), and vice
versa. Date comparisons rely on ISO `YYYY-MM-DD` string ordering.
