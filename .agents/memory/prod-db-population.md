---
name: Production DB starts empty — how to populate it
description: After publishing, prod uses a separate empty Postgres; how to reseed it and the sync timeout gotcha.
---

The deployed app gets its **own separate Postgres** (Neon prod branch). On first
publish it is EMPTY — none of the dev-curated data (vendors, aliases, purchases,
shipments, lead times, quality cases) carries over. Symptom: live app shows
"NetSuite not connected yet", "No Label Traxx lead-time data yet", and on-time sync
reports "N names couldn't be matched (0 matched)" because there are 0 vendor rows.
`netsuiteConnected`/`labeltraxxConnected` are data-derived (`shipments.length>0` /
`leadTimes.length>0`), NOT credential checks — secrets DO carry to prod (NetSuite +
ODBC gateway both reachable from the deployment).

**I cannot write to prod via executeSql** (production target is read-only). The only
way to write prod data is through the app's own HTTP endpoints against the public
prod URL. Reconstruction order that reproduces dev:
1. `POST /api/vendors/seed` — creates only the ~40 Flex-Sourcing *pipeline* vendors.
2. Create the remaining active material/finished-goods vendors (ACTEGA, MacTac,
   Avery, Nobelus, …) via `POST /api/vendors` — these are NOT in the seed; in dev
   they were made from unmatched sync names. Diff dev-vs-prod vendor names, POST the
   missing ones (name/country/category/track/tier/stage/owner/notes).
3. Recreate aliases via `POST /api/vendors/aliases {name, vendorId}` — map by vendor
   NAME (vendor UUIDs differ between dev and prod).
4. `POST /api/vendors/netsuite/sync` (shipments+purchases), then
   `POST /api/vendors/labeltraxx/sync` (lead times), then
   `POST /api/vendors/netsuite/quality-sync`.

**Autoscale HTTP timeout gotcha:** `netsuite/sync` does thousands of sequential
per-row inserts and overruns the client/proxy request window (~110s) — the HTTP
response comes back empty. **But the server keeps writing after the client
disconnects.** Don't re-fire it; poll the prod DB counts (read-only executeSql)
until `vendor_purchase` stabilizes (~5103). The UI "Sync NetSuite" button hits the
same endpoint and will look like it errors while actually completing server-side.

**Why:** prod and dev DBs are isolated by design; the app has no bulk-import path,
so all prod data must be driven through its sync/seed endpoints. The prod DB
persists across redeploys, so this reseed is one-time (data just goes stale until
the next sync).
