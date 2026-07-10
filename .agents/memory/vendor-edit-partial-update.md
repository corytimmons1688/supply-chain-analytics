---
name: Vendor edit partial-update rule
description: Why PUT /vendors/:id must patch only present keys, and how the two ASL tables share one vendor record.
---
The inventory-adjustments ASL page has two tables (Current Approved Suppliers and
Flex Sourcing Pipeline) whose edit dialogs each expose a *different subset* of the
same vendor record's columns. A pipeline vendor and an ASL vendor are the same
`vendor` row — the tables only differ by the linked `asl_entry.status`
(onboarded → ASL, else pipeline).

Rule: `PUT /vendors/:id` must be a **partial update** — only write columns whose
key is actually present in the request body (`if (k in b)`), never a full
`.set()` of every column.

**Why:** the frontend edit dialog only sends its variant's field subset. A
full-replace would apply `s(undefined) → null` to every unsent column, so editing
an ASL row would wipe all pipeline-only columns (externalId, printMethod, quotes,
dates, etc.) and vice versa — silent data loss. This was caught in code review.
**How to apply:** keep `VENDOR_UPDATABLE_KEYS` as the allow-list and iterate it for
any partial vendor update; if you add a vendor column, add it there too.

Related: "Move to ASL" sets `asl_entry.status = onboarded`; the PUT /asl/entries
handler then deletes that vendor's *other* non-onboarded entries, and GET /asl
drops pipeline rows whose `nameNorm` matches an approved supplier — both prevent a
vendor showing in both tables at once.
