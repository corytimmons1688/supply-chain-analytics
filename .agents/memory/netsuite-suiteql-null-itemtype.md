---
name: NetSuite SuiteQL NULL itemtype trap
description: Why a transactionLine itemtype filter can silently drop whole bills/transactions.
---

In NetSuite SuiteQL, many `transactionLine` rows have a **NULL `itemtype`**
(e.g. account/expense lines, or item lines NetSuite simply doesn't tag). SQL
three-valued logic means `itemtype <> 'ShipItem'` evaluates to NULL (not TRUE)
for those rows, so a filter like `AND tl.itemtype <> 'ShipItem'` silently
**excludes every NULL-itemtype line** — and if that was a bill's only money line,
the whole bill vanishes from the result with no error.

**Symptom seen:** vendor total spend (from VendBill) was missing recent bills for
some vendors (Mactac, Actega) while older bills for the same vendor showed up —
because the older bills happened to have a populated itemtype and the newer ones
did not. Looked like "stale sync" but a re-sync didn't fix it.

**Fix:** keep NULL rows explicitly: `AND (tl.itemtype IS NULL OR tl.itemtype <> 'ShipItem')`.

**How to apply:** any SuiteQL `<>` / `NOT IN` / `!=` filter on a nullable column
(itemtype, custom fields, etc.) must add an explicit `IS NULL OR ...` branch when
NULL rows should be kept. Verify totals against a NetSuite native report
("Purchase by Vendor Detail") — sum should match to the penny once the date
window lines up.

**Bill credits caveat:** "Bill Credit" rows are transaction type `VendCred`, not
`VendBill`; a VendBill-only spend query intentionally excludes them, so a native
report that nets credits will read slightly lower than the bills-only sum.
