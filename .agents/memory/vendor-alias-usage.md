---
name: Vendor alias usage tracking
description: Semantics of vendor_alias lastUsedAt / lastHitCount and how syncs stamp them.
---

# Vendor alias usage tracking

`vendor_alias` has `last_used_at` (nullable) and `last_hit_count` (default 0).

Each sync route (NetSuite shipments+purchases, NetSuite quality, Label Traxx)
collects per-alias hit counts during matching (matchVendor / matchSupplier take an
optional `onAliasHit(normAlias)` callback), then calls `recordAliasHits(hits)` once
before responding.

**Decision:** `last_hit_count` is OVERWRITTEN with the count from the most recent
sync run that used the alias (not cumulative), and `last_used_at` is set to that
run's timestamp. Aliases not hit in a run are left untouched so a prior
`last_used_at` stays visible. `last_used_at == null` ⇒ never matched since tracking
began ⇒ safe-to-prune (UI highlights these).

**Why:** task asked for "when it last resolved a name" + "how many rows it matched
on the most recent sync" — overwrite semantics match that wording and avoid an
ever-growing counter that can't tell recent activity from historical.

**How to apply:** any NEW sync route that resolves names through aliases must also
pass `onAliasHit` and call `recordAliasHits`, or its aliases will look stale.
