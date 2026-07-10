---
name: NetSuite vendor on-time link types
description: NetSuite vendor scorecard rules — on-time link types (DropShip+SpecOrd), vendor name "&"/"and" matching, plus fill-rate (shipped/ordered) and NetSuite lead time (trandate->actualshipdate) definitions.
---

# NetSuite vendor on-time (scorecard)

The NetSuite shipment/on-time query (`fetchPurchaseShipments`) pulls POs linked to a
Sales Order via `previousTransactionLineLink.linktype`. It MUST include **both**
`DropShip` and `SpecOrd`:

- **DropShip** — vendor ships directly to the customer; SO `shipdate` is the vendor's
  own commitment.
- **SpecOrd** (special order) — vendor ships to Calyx (creates an item receipt), then
  Calyx fulfills the customer. The PO `duedate` is null on these, but the linked SO
  `shipdate` is present and meaningful: the vendor must deliver to Calyx by that date
  for Calyx to make the customer commitment. Same benchmark `actualShipDate <= SO.shipdate`.

**Why:** Some vendors (e.g. Compax, Ross) do most recent business as special orders.
Restricting to DropShip alone made them show 0 shipments in a YTD window even though
they have thousands of SO-linked POs (Compax's last DropShip was 2024-12-16; all 2025+
activity is SpecOrd).

**Vendor name matching:** the sync matches NetSuite `companyname` to the local vendor by
normalized name and MUST treat `&` and `and` as equivalent — e.g. NetSuite
"Ross Print and Packaging" vs local "Ross Print & Packaging". A naive lowercase/trim
exact+containment match silently drops these (fetched but unmatched → no data).

**How to apply:** when a known-active vendor shows 0 shipments / no on-time, check (a)
link-type filter includes SpecOrd, (b) the YTD window isn't excluding old DropShip-only
data, and (c) name matching reconciles `&`/`and` and punctuation.

## NetSuite lead time & fill rate (scorecard)

- **Fill rate** = `SUM(quantityshiprecv) / SUM(quantity)` over a vendor's SO-linked PO
  lines (mainline='F', itemtype<>'ShipItem'), windowed by `actualShipDate`. Prefer this
  over the manual monthly `vendorMetricTable.fillRatePct`, but keep that as a fallback
  when no NetSuite quantity data exists. UI green band = `|fillRate - 100| <= 10` (fill
  rates legitimately exceed 100 when over-shipped, e.g. Ross ~103%).
- **NetSuite lead time** = `actualshipdate - trandate` (PO `trandate` is the date sent),
  bounded `0..365` days, negatives skipped. Shown ALONGSIDE the Label Traxx lead time
  (PODate->Received), not replacing it — they are different sources and both are wanted.
- Quantities/dates are fetched via a separate per-PO aggregation query merged by PO
  number into the shipment rows, then persisted to `vendor_shipment`
  (`poDate`/`qtyOrdered`/`qtyShipped`). Both the scorecard rollup and `/vendors/trend`
  must compute these in lockstep.
- **Why:** Cory wanted fill rate as a true shipped/ordered ratio and a NetSuite-based
  lead time to compare against Label Traxx's.

## NetSuite quality cases -> vendor attribution

Support cases (`supportcase`) have NO clean transaction link to a vendor. The SO
reference lives in the free-text custom field `custeventcust_1st_lttn` (messy, e.g.
"TN25692\r\nSO15101", may contain several SO refs or none). Parse `SO\d+` tokens out
of it; `custevent5` is unreliable (points at an ItemReceipt, not the SO).

- Case status stage comes from `supportcasestatus.stage` ∈ {OPEN, ESCALATED, CLOSED};
  treat `openCase = stage !== 'CLOSED'`. `supportcase.title` is the subject.
- Resolve each parsed SO -> its special-order/drop-ship PO -> vendor using the **same**
  `previousTransactionLineLink` join as `fetchPurchaseShipments` (previousdoc=SO.id,
  nextdoc=PO.id, linktype IN ('DropShip','SpecOrd'), PO.entity=vendor). Only ~1 in 6
  case-SOs resolve to a vendor — the rest are fulfilled from stock (no PO) and are
  dropped (this is expected, not a bug).
- A single case can map to multiple vendors -> emit one row per (case, vendor); the
  scorecard rollup AND `/vendors/trend` add NS-case counts on top of the manual
  `vendorQualityIssueTable` counts (qualityIssueCount / openQualityIssueCount).
- Deep link: `https://{ACCOUNT-lowercased,_→-}.app.netsuite.com/app/crm/support/supportcase.nl?id={caseId}`.
  Build it backend-side; never log/expose the account string.
- Vendor name match reuses `matchVendor` (same normalization as shipments); unmatched
  NetSuite vendor names (e.g. "Propeller, Inc." with no local vendor) are reported, not
  inserted — expected.
