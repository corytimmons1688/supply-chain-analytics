---
name: Label Traxx PO vendor attribution
description: How per-vendor lead time is derived from Label Traxx purchase orders, and the gateway constraints that shape the queries.
---

# Label Traxx purchase-order vendor attribution

The Label Traxx `purchaseorder.Supplier` text column DOES carry the real material
vendor on Stock/Tool POs (e.g. Mactac, Avery Dennison, Nobelus-luxefilms, Reynolds
Brands, Acucote, KDX America; Tool POs: Maxcess-Rotometrics, Wink, Kocher+Beck).
So PO lead time is attributable per vendor by fuzzy-matching `Supplier` to a vendor
name (exact → containment → token overlap anchored on first token, ≥0.5).

**Lead time only, never true on-time.** Label Traxx has NO promised/due date, so the
only derivable metric is lead time = `PODate` → `Received`. True on-time comes from
NetSuite. The scorecard shows Label Traxx avg lead time ALONGSIDE NetSuite on-time —
they are different signals, don't conflate them.

**Why the queries are chunked by month:** the ODBC gateway caps results at 1000 rows.
`POType='Stock'` filtering only works when chunked by date. Lead-time sync queries
`purchaseorder` chunked by `Received` month (default 730-day lookback).

**Gateway SQL safety:** gateway SQL is built by string interpolation (e.g.
`Received >= {d '...'}`), NOT parameterized. Any date param from a request (like
`since`) MUST be validated strict `YYYY-MM-DD` before it reaches the SQL builder.

**Attribution integrity:** a PO is globally unique per source. Store lead-time rows
unique on `(source, po_number)` and update `vendor_id` on conflict, so a PO that gets
re-matched to a different vendor between syncs is re-attributed, not duplicated.

**Querying the gateway manually:** run via `node -e` in bash (gateway env vars are NOT
present in the code_execution sandbox).
