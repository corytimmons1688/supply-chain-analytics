---
name: Vendor name dedupe
description: How vendor records are matched/merged across the two seed sources in the inventory-adjustments vendor domain.
---
The vendor domain has two seed sources that overlap: the Flex Sourcing tracker
(new-vendor pipeline) and the current ASL (active approved suppliers). The same
supplier appears under slightly different names (e.g. "DazPak Flexible Packaging"
vs "Dazpak", "Ross Print & Packaging" vs "Ross Print and Packaging").

Matching rule (in /vendors/seed-asl): try exact normalized-name match first
(`nameNorm`: lowercase, & → and, strip non-alnum, collapse spaces). Only if that
misses, fall back to a "core" match (`nameCore`: nameNorm minus generic stopwords
like packaging/inc/llc/the/and). Core matches that collide between two distinct
existing vendors are flagged ambiguous and skipped, never auto-merged.

**Why:** core stripping is lossy and can collapse two genuinely different vendors
to the same string; an exact-first + ambiguity-guard avoids silently overwriting
the wrong vendor on future imports.
**How to apply:** reuse this two-tier match for any new vendor import/seed rather
than matching on raw names or core-only.
