---
name: Vendor tier / track source
description: Where ASL vendor tier and track classification data comes from (not the live systems).
---

# Vendor tier / track source

ASL vendor tier and track classification is NOT available in Label Traxx or NetSuite.
It lives in an attached Excel sourcing tracker (a `Vendor_List` workbook in
`attached_assets/`). Any task that needs to fill vendor tiers must read that
spreadsheet as the source of truth, then seed the `vendor` table — there is no live
API for it.
