---
name: ASL / Flex Sourcing tracker columns
description: Why many vendor tracker columns are present in schema/UI but empty, and how the two ASL tables are split.
---

# ASL page: two tables + full tracker columns

The Suppliers > ASL page shows TWO separate full-width, horizontally-scrollable tables,
split by onboarded status (NOT a `source` column):
- **Current Approved Suppliers** = vendors with an `onboarded` asl_entry (current ASL detail).
- **Flex Sourcing Pipeline** = vendors with only identified/in_progress entries.
`GET /asl` returns `aslSuppliers` + `pipeline` (deduped per vendor).

## Why many tracker columns are empty
The vendor schema carries the FULL Flex Sourcing tracker (msaDate, capabilityVerified,
factoryTourDate, rfq/quote, pricing, moq, lead time, aql, psi, trial, ipClause,
nonCompete24mo, statusRag, nextAction, etc.) and the ASL `documents` column.
**The source spreadsheets are empty for all of these** — only one `ndaDate` cell was
populated, and the ASL "Documents" column had 0 populated cells.
**Why:** columns exist so the team can fill them in over time; they are intentional
placeholders, not a bug. Do NOT treat empty late-stage columns as a seeding gap.
**How to apply:** `/vendors/seed` `trackerFields` only maps columns that actually have
source data (through `ndaDate`). If a future updated tracker populates later columns,
extend `SeedVendor` + `trackerFields` then.

## Seed safety
`/vendors/seed` UPSERTs tracker fields onto existing non-onboarded vendors but SKIPS any
vendor already `onboarded` — so re-running the tracker seed never clobbers current-ASL
supplier detail. Excel serial dates (e.g. ndaDate "46197") are converted to ISO at
seed-array build time.
