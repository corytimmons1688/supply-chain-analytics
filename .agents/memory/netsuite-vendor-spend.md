---
name: NetSuite vendor total spend
description: How total vendor spend is sourced from NetSuite for the Vendor Scorecards dashboard.
---

Total spend = NetSuite **Vendor Bills** (`transaction.type = 'VendBill'`) per vendor,
for ALL vendors — NOT purchase orders, and NOT just the SO-linked drop-ship /
special-order transactions that feed on-time/shipment data.

**Why bills, not POs:** USER CONFIRMED. Bills capture actual booked spend, including
bill-only vendors (e.g. Mactac) that never appear as drop-ship/special-order POs, so
spend is attributed for every vendor rather than only those with SO-linked POs.

**How it's computed:** SuiteQL sums item-line `netamount` (`mainline='F'`,
`netamount IS NOT NULL`, excluding ship items) grouped per bill across every
`VendBill`. NetSuite returns line net amounts as *negatives*, so take `Math.abs`.
Stored in `vendor_purchase` (vendorId, orderNo, poDate, amount). Dashboard windows
spend by `poDate` (the bill date) within the selected period.

**Why the sync full-mirrors the table:** the `/vendors/netsuite/sync` route
deletes all `source='netsuite'` rows in `vendor_purchase` before re-inserting the
freshly fetched set. Without this, re-attribution (a vendor name getting corrected
between syncs) or a removed bill would leave stale rows under the old vendor and
double-count spend, drifting over time.

**How to apply:** any future "spend"-style metric pulled from a full NetSuite scan
should mirror (delete-then-insert by source) rather than upsert-only, so the local
copy can't accumulate orphans. On-time/shipment data uses a different (SO-linked,
PurchOrd) population — don't conflate the two.
