import {
  db,
  ltRollTable,
  ltStockTable,
  ltTicketTable,
  ltPoTable,
  syncStateTable,
} from "@workspace/db";
import { eq, sql, inArray } from "drizzle-orm";
import { ltGet, ltGetAllPages, ltMapConcurrent, ltDate, ltApiConfigured } from "./ltApi";
import { runGatewaySql, pickString } from "./gateway";
import { logger } from "./logger";

/**
 * Label Traxx → Postgres mirror sync (through the LT Cloud API).
 *
 * Cadence (driven by /cron/netsuite-sync):
 *  - every run: stocks, open/changed tickets, changed POs, on-hand rolls
 *  - `full` runs (nightly / backfill): also the complete used-roll history
 *    (the API has no date filter on roll inventory, ~220 pages)
 */

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function recordLtSyncState(source: string, detail: unknown): Promise<void> {
  const detailJson = JSON.stringify(detail);
  await db
    .insert(syncStateTable)
    .values({ source, syncedAt: new Date(), detail: detailJson })
    .onConflictDoUpdate({ target: syncStateTable.source, set: { syncedAt: new Date(), detail: detailJson } });
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// ---------------------------------------------------------------------
// Stocks — full pull (~70 records) with per-stock details.
// ---------------------------------------------------------------------
export async function syncLtStocks(): Promise<{ stocks: number }> {
  type StockListRow = { number: string };
  const list = await ltGetAllPages<StockListRow>("/stocks");
  const details = await ltMapConcurrent(list, 4, (row) =>
    ltGet<Record<string, unknown>>("/stock-details", { StockNumber: row.number }).catch((err) => {
      logger.warn({ err, stock: row.number }, "LT stock-details failed");
      return null;
    }),
  );
  const values = details
    .filter((d): d is Record<string, unknown> => d != null && !!str(d["stockNumber"]))
    .map((d) => ({
      stockId: str(d["stockNumber"])!,
      classification: str(d["classification"]),
      supplierNumber: str(d["supplierNumber"]),
      supplierName: str(d["supplierName"]),
      mfgSpecNum: str(d["mfgSpecNumber"]),
      masterWidth: num(d["masterWidth"]),
      costMsi: num(d["costMSI"]),
      freightMsi: num(d["freightMSI"]),
      faceStock: str(d["faceStock"]),
      faceColor: str(d["faceColor"]),
      adhesive: str(d["adhesive"]),
      topCoat: str(d["topCoat"]),
      estimatedDeliveryTime: str(d["estimatedDeliveryTime"]),
      invMsiMinimum: num(d["invMSIMinimum"]),
      invMsiMaximum: num(d["invMSIMaximum"]),
      areaToWeightFactor: num(d["areaToWeightFactor"]),
      inventoryCost: num(d["inventoryCost"]),
      totalInventoryMsi: num(d["totalInventoryMSI"]),
      // LT exposes `isActive` (there is no `inactive` field — reading one meant
      // every stock looked active). Missing/unknown → treat as active.
      inactive: d["isActive"] === false,
      syncedAt: new Date(),
    }));
  for (const batch of chunkArray(values, 200)) {
    await db
      .insert(ltStockTable)
      .values(batch)
      .onConflictDoUpdate({
        target: ltStockTable.stockId,
        set: {
          classification: sql`excluded.classification`,
          supplierNumber: sql`excluded.supplier_number`,
          supplierName: sql`excluded.supplier_name`,
          mfgSpecNum: sql`excluded.mfg_spec_num`,
          masterWidth: sql`excluded.master_width`,
          costMsi: sql`excluded.cost_msi`,
          freightMsi: sql`excluded.freight_msi`,
          faceStock: sql`excluded.face_stock`,
          faceColor: sql`excluded.face_color`,
          adhesive: sql`excluded.adhesive`,
          topCoat: sql`excluded.top_coat`,
          estimatedDeliveryTime: sql`excluded.estimated_delivery_time`,
          invMsiMinimum: sql`excluded.inv_msi_minimum`,
          invMsiMaximum: sql`excluded.inv_msi_maximum`,
          areaToWeightFactor: sql`excluded.area_to_weight_factor`,
          inventoryCost: sql`excluded.inventory_cost`,
          totalInventoryMsi: sql`excluded.total_inventory_msi`,
          inactive: sql`excluded.inactive`,
          syncedAt: new Date(),
        },
      });
  }
  return { stocks: values.length };
}

// ---------------------------------------------------------------------
// Tickets — open sweep + incremental by ModifyDateSince.
// ---------------------------------------------------------------------
type TicketListRow = { number: string; modifiedDate?: string };

/**
 * Reconcile mirror tickets that still look OPEN but are absent from Label Traxx's
 * live open list. The mirror upserts and never deletes, so two things go stale and
 * keep driving phantom demand:
 *   - deleted/voided tickets (details endpoint replies `... was not found`)
 *   - tickets completed since the last detail fetch (dateDone set in LT, still
 *     null here because the incremental pass only re-fetches changed tickets)
 * We re-fetch details for each suspect: gone → delete the row; still there →
 * upsert so dateDone/status land. Bounded by the demand window, so it's cheap.
 */
async function reconcileMissingTickets(liveOpen: Set<string>): Promise<{ deleted: number; refreshed: number }> {
  const suspects = await db
    .select({ n: ltTicketTable.ticketNumber })
    .from(ltTicketTable)
    .where(
      sql`${ltTicketTable.dateDone} IS NULL
          AND ${ltTicketTable.shipByDate} >= (current_date - interval '30 days')::text
          AND ${ltTicketTable.shipByDate} <= (current_date + interval '180 days')::text`,
    );
  const missing = suspects.map((s) => s.n).filter((n) => !liveOpen.has(n));
  if (missing.length === 0) return { deleted: 0, refreshed: 0 };

  // `null` here means the ticket no longer exists in LT (details 4xx / "not found").
  const probes = await ltMapConcurrent(missing, 4, async (n) => {
    try {
      const d = await ltGet<Record<string, unknown>>("/custom-ticket-details", { TicketNumber: n });
      const o = Array.isArray(d) ? (d[0] as Record<string, unknown> | undefined) : d;
      return { ticket: n, detail: o && str(o["number"]) ? o : null };
    } catch {
      return { ticket: n, detail: null };
    }
  });

  const gone = probes.filter((p) => p.detail == null).map((p) => p.ticket);
  const stillThere = probes.filter((p) => p.detail != null).map((p) => p.ticket);
  for (const batch of chunkArray(gone, 200)) {
    await db.delete(ltTicketTable).where(inArray(ltTicketTable.ticketNumber, batch));
  }
  let refreshed = 0;
  if (stillThere.length > 0) refreshed = await upsertTicketDetails(stillThere);
  if (gone.length > 0 || refreshed > 0) {
    logger.info({ deleted: gone.length, refreshed, tickets: gone.slice(0, 20) }, "Reconciled stale LT tickets");
  }
  return { deleted: gone.length, refreshed };
}

async function upsertTicketDetails(numbers: string[]): Promise<number> {
  const details = await ltMapConcurrent(numbers, 4, (n) =>
    ltGet<Record<string, unknown>>("/custom-ticket-details", { TicketNumber: n }).catch((err) => {
      logger.warn({ err, ticket: n }, "LT ticket-details failed");
      return null;
    }),
  );
  const values = details
    .filter((d): d is Record<string, unknown> => d != null && !!str(d["number"]))
    .map((d) => ({
      ticketNumber: str(d["number"])!,
      status: str(d["status"]),
      priority: str(d["priority"]),
      stockIn: str(d["stockIn"]),
      shipByDate: ltDate(str(d["shipByDate"]) ?? str(d["shipDate"])),
      dateDone: ltDate(str(d["dateDone"])),
      orderDate: ltDate(str(d["orderDate"])),
      description: str(d["generalDescription"]) ?? str(d["description"]),
      customerName: str(d["customerName"]),
      totalNeeded: num(d["totalNeeded"]),
      stockAllocs: d["ticketStockAlloc"] ?? [],
      modifiedDate: str(d["modifiedDate"]),
      syncedAt: new Date(),
    }));
  for (const batch of chunkArray(values, 200)) {
    await db
      .insert(ltTicketTable)
      .values(batch)
      .onConflictDoUpdate({
        target: ltTicketTable.ticketNumber,
        set: {
          status: sql`excluded.status`,
          priority: sql`excluded.priority`,
          stockIn: sql`excluded.stock_in`,
          shipByDate: sql`excluded.ship_by_date`,
          dateDone: sql`excluded.date_done`,
          orderDate: sql`excluded.order_date`,
          description: sql`excluded.description`,
          customerName: sql`excluded.customer_name`,
          totalNeeded: sql`excluded.total_needed`,
          stockAllocs: sql`excluded.stock_allocs`,
          modifiedDate: sql`excluded.modified_date`,
          syncedAt: new Date(),
        },
      });
  }
  return values.length;
}

export async function syncLtTickets(
  opts: { sinceDays?: number; full?: boolean } = {},
): Promise<{ tickets: number; deleted: number; refreshed: number }> {
  const since = new Date();
  since.setDate(since.getDate() - (opts.sinceDays ?? 3));
  // Query params take ISO dates (responses use MM/DD/YYYY).
  const sinceParam = since.toISOString().slice(0, 10);

  // Bound the open sweep by ship date — LT keeps years of never-closed
  // tickets; the dashboard only reads open tickets shipping from -30d on.
  const shipSince = new Date();
  shipSince.setDate(shipSince.getDate() - 45);
  const [openList, changedList] = await Promise.all([
    ltGetAllPages<TicketListRow>("/custom-tickets", {
      Status: "Open",
      ShipDateSince: shipSince.toISOString().slice(0, 10),
    }),
    ltGetAllPages<TicketListRow>("/custom-tickets", { ModifyDateSince: sinceParam }),
  ]);
  const openNums = openList.map((t) => t.number).filter(Boolean);
  const changed = new Set(changedList.map((t) => t.number).filter(Boolean));
  // `full` re-fetches details for EVERY open ticket (used to backfill new
  // fields like priority across the existing book). The default is incremental:
  // only tickets that changed (the ModifyDateSince list) or are new to the
  // mirror — re-fetching all open tickets each run pushed the step past 250s and
  // the whole sync past the 300s serverless limit (the 2026-07-22 outage). As
  // long as the sync runs at least every `sinceDays` days, no change is missed.
  let numbers: string[];
  if (opts.full) {
    numbers = [...new Set([...openNums, ...changed])];
  } else {
    const existing = new Set(
      (await db.select({ n: ltTicketTable.ticketNumber }).from(ltTicketTable)).map((r) => r.n),
    );
    numbers = [...new Set([...openNums, ...changed].filter((n) => changed.has(n) || !existing.has(n)))];
  }
  const upserted = await upsertTicketDetails(numbers);
  // Prune/refresh mirror rows that still look open but LT no longer lists as open
  // (deleted tickets, or ones completed since our last detail fetch).
  const { deleted, refreshed } = await reconcileMissingTickets(new Set(openNums));
  return { tickets: upserted, deleted, refreshed };
}

// ---------------------------------------------------------------------
// Purchase orders — incremental by ChangedSinceDate (Stock POs).
// ---------------------------------------------------------------------
type PoListRow = { number: string };

/** supplierNumber → company name, from the LT suppliers list. */
async function fetchSupplierNames(): Promise<Map<string, string>> {
  type SupplierRow = { number?: string; company?: string };
  const rows = await ltGetAllPages<SupplierRow>("/suppliers");
  const out = new Map<string, string>();
  for (const r of rows) {
    const n = str(r.number);
    const c = str(r.company);
    if (n && c) out.set(n, c);
  }
  return out;
}

async function upsertPoDetails(numbers: string[], supplierNames: Map<string, string>): Promise<number> {
  const details = await ltMapConcurrent(numbers, 4, (n) =>
    ltGet<Record<string, unknown>>("/purchase-order-details", { PONumber: n }).catch((err) => {
      logger.warn({ err, po: n }, "LT purchase-order-details failed");
      return null;
    }),
  );
  const values = details
    .filter((d): d is Record<string, unknown> => d != null && !!str(d["poNumber"]))
    .map((d) => {
      const items = Array.isArray(d["poItems"]) ? (d["poItems"] as Record<string, unknown>[]) : [];
      const firstItem = items[0] ?? {};
      const supplierNumber = str(d["supplierNum"]);
      // Master-roll count = number of PO line items (one line per master
      // roll). Matches ODBC purchaseorder.Quantity exactly; NOT the sum of
      // orderedLineQty (a per-line measure in different units).
      const quantity = items.length;
      // Ordered area in MSI across all lines; exact footage is derived from this
      // plus masterWidth (see lt_po.orderedMsi).
      let orderedMsi = 0;
      for (const it of items) orderedMsi += num(it?.["orderedLineQty"]) ?? 0;
      return {
        poNumber: str(d["poNumber"])!,
        poType: str(d["poType"]),
        poDate: ltDate(str(d["orderDate"])),
        dueDate: ltDate(str(d["dueDate"])),
        receivedDate: ltDate(str(d["receivedDate"])),
        closed: d["closed"] === true,
        supplierNumber,
        supplierName: supplierNumber ? (supplierNames.get(supplierNumber) ?? null) : null,
        stockNum: str(firstItem["partNum"]) ?? null,
        quantity: quantity > 0 ? quantity : null,
        masterWidth: num(d["masterWidth"]),
        notes: str(d["notes"]),
        orderedMsi,
        subTotal: num(d["subTotal"]),
        description: str(firstItem["description"]),
        items: items,
        modDate: ltDate(str(d["modDate"])),
        syncedAt: new Date(),
      };
    });
  for (const batch of chunkArray(values, 200)) {
    await db
      .insert(ltPoTable)
      .values(batch)
      .onConflictDoUpdate({
        target: ltPoTable.poNumber,
        set: {
          poType: sql`excluded.po_type`,
          poDate: sql`excluded.po_date`,
          dueDate: sql`excluded.due_date`,
          receivedDate: sql`excluded.received_date`,
          closed: sql`excluded.closed`,
          supplierNumber: sql`excluded.supplier_number`,
          supplierName: sql`excluded.supplier_name`,
          stockNum: sql`excluded.stock_num`,
          quantity: sql`excluded.quantity`,
          masterWidth: sql`excluded.master_width`,
          notes: sql`excluded.notes`,
          orderedMsi: sql`excluded.ordered_msi`,
          subTotal: sql`excluded.sub_total`,
          description: sql`excluded.description`,
          items: sql`excluded.items`,
          modDate: sql`excluded.mod_date`,
          syncedAt: new Date(),
        },
      });
  }
  return values.length;
}

export async function syncLtPos(opts: { sinceDays?: number; full?: boolean } = {}): Promise<{ pos: number }> {
  const supplierNames = await fetchSupplierNames();
  // All PO types — vendor lead-time scorecards cover plate/tooling/art
  // suppliers too, not just Stock POs.
  let numbers: string[];
  if (opts.full) {
    const list = await ltGetAllPages<PoListRow>("/purchase-orders", {});
    numbers = list.map((p) => p.number).filter(Boolean);
  } else {
    const since = new Date();
    since.setDate(since.getDate() - (opts.sinceDays ?? 3));
    const sinceParam = since.toISOString().slice(0, 10);
    const list = await ltGetAllPages<PoListRow>("/purchase-orders", { ChangedSinceDate: sinceParam });
    numbers = [...new Set(list.map((p) => p.number).filter(Boolean))];
  }
  const upserted = await upsertPoDetails(numbers, supplierNames);
  return { pos: upserted };
}

/**
 * Requested-delivery dates for open Stock POs. The LT Cloud API only exposes the
 * vendor-PROMISED date (`dueDate`); what Calyx actually asked for lives in ODBC
 * as purchaseorder.RequestedDeliveryDate (verified distinct — promised is
 * typically later). Hybrid read, same rationale as per-roll cost.
 */
export async function syncLtPoRequestedDates(): Promise<{ requestedDates: number }> {
  const rows = await runGatewaySql(
    "SELECT PONumber, RequestedDeliveryDate FROM purchaseorder " +
      `WHERE POType = 'Stock' AND Received < {d '1900-01-01'}`,
  );
  let updated = 0;
  for (const row of rows) {
    const poNumber = pickString(row, "PONumber");
    const raw = pickString(row, "RequestedDeliveryDate");
    if (!poNumber) continue;
    // Gateway returns "M/D/YYYY HH:mm"; pre-1900 is LT's blank sentinel.
    const iso = (() => {
      if (!raw) return null;
      const [datePart] = raw.split(" ");
      const [m, d, y] = (datePart ?? "").split("/");
      if (!m || !d || !y || Number(y) < 1900) return null;
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    })();
    try {
      await db.update(ltPoTable).set({ requestedDeliveryDate: iso }).where(eq(ltPoTable.poNumber, poNumber));
      updated++;
    } catch (err) {
      logger.warn({ err, poNumber }, "lt_po requested-date update failed");
    }
  }
  return { requestedDates: updated };
}

// ---------------------------------------------------------------------
// Rolls — on-hand every run; full used-roll history on `full` runs only.
// ---------------------------------------------------------------------
type RollListRow = {
  rollID: string;
  stockID: string;
  description?: string;
  poNumber?: string;
  allocatedTiket?: string;
  width?: number;
  length?: number;
  usedTikNumber?: string;
  location?: string;
};

function rollValues(rows: RollListRow[], used: boolean) {
  const byId = new Map<string, typeof ltRollTable.$inferInsert>();
  for (const r of rows) {
    if (!r.rollID) continue;
    byId.set(String(r.rollID), {
      rollId: String(r.rollID),
      stockId: String(r.stockID ?? "").trim(),
      poNumber: str(r.poNumber),
      width: num(r.width),
      length: num(r.length),
      usedTikNum: str(r.usedTikNumber),
      allocTikNum: str(r.allocatedTiket),
      used,
      dateRollUsed: null, // filled from details on full sync; list lacks dates
      stockDate: null,
      location: str(r.location),
      description: str(r.description),
      syncedAt: new Date(),
    });
  }
  return [...byId.values()];
}

const rollUpsertSet = () => ({
  stockId: sql`excluded.stock_id`,
  poNumber: sql`excluded.po_number`,
  width: sql`excluded.width`,
  length: sql`excluded.length`,
  usedTikNum: sql`excluded.used_tik_num`,
  allocTikNum: sql`excluded.alloc_tik_num`,
  used: sql`excluded.used`,
  location: sql`excluded.location`,
  description: sql`excluded.description`,
  syncedAt: new Date(),
});

/**
 * On-hand rolls: full replacement each run (rolls leave on-hand when used).
 * Rolls that disappeared from the on-hand list but aren't yet mirrored as
 * used get flagged used so on-hand queries stay truthful between full syncs.
 */
export async function syncLtOnHandRolls(): Promise<{ onHand: number; newlyUsed: number }> {
  const rows = await ltGetAllPages<RollListRow>("/roll-inventory", { Used: false });
  const values = rollValues(rows, false);
  const seen = values.map((v) => v.rollId);

  for (const batch of chunkArray(values, 500)) {
    await db.insert(ltRollTable).values(batch).onConflictDoUpdate({ target: ltRollTable.rollId, set: rollUpsertSet() });
  }
  // Anything previously on-hand that is no longer in the list has been used.
  const stale = await db
    .select({ rollId: ltRollTable.rollId })
    .from(ltRollTable)
    .where(eq(ltRollTable.used, false));
  const seenSet = new Set(seen);
  const staleIds = stale.map((r) => r.rollId).filter((id) => !seenSet.has(id));
  for (const batch of chunkArray(staleIds, 500)) {
    await db.update(ltRollTable).set({ used: true, syncedAt: new Date() }).where(inArray(ltRollTable.rollId, batch));
  }
  return { onHand: values.length, newlyUsed: staleIds.length };
}

/**
 * Roll detail dates (dateRollUsed, stockDate) — needed for usage history and
 * PO-receipt roll matching. Fetched per roll (details endpoint), so we only
 * do it for rolls missing dates, newest first, bounded per run.
 */
export async function syncLtRollDates(opts: { limit?: number } = {}): Promise<{ enriched: number }> {
  const limit = opts.limit ?? 3000;
  // Also (re)enrich recently-consumed rolls that are missing their used-ticket
  // number — the hourly on-hand sync flags a roll used but can't set which
  // ticket consumed it; without this, consumption-netting for open tickets has
  // no data until the nightly full used-roll pull. Bounded to the last 60 days
  // (only recent consumption maps to still-open tickets).
  const usedTikSince = new Date();
  usedTikSince.setDate(usedTikSince.getDate() - 60);
  const usedTikSinceIso = usedTikSince.toISOString().slice(0, 10);
  const missing = await db
    .select({ rollId: ltRollTable.rollId })
    .from(ltRollTable)
    .where(sql`${ltRollTable.stockDate} IS NULL OR (${ltRollTable.used} = true AND ${ltRollTable.dateRollUsed} IS NULL) OR (${ltRollTable.used} = true AND ${ltRollTable.usedTikNum} IS NULL AND ${ltRollTable.dateRollUsed} >= ${usedTikSinceIso})`)
    // Roll ids are mostly numeric but slit children look like "3860-A" —
    // order by the leading digits so the newest rolls enrich first.
    .orderBy(sql`NULLIF(regexp_replace(${ltRollTable.rollId}, '[^0-9].*$', ''), '')::bigint DESC NULLS LAST`)
    .limit(limit);
  if (missing.length === 0) return { enriched: 0 };

  const details = await ltMapConcurrent(missing, 4, (r) =>
    ltGet<Record<string, unknown>>("/roll-inventory-details", { RollInventoryNumber: r.rollId }).catch(() => null),
  );
  let enriched = 0;
  for (const batch of chunkArray(details.filter((d): d is Record<string, unknown> => d != null), 200)) {
    for (const d of batch) {
      const rollId = str(d["number"]);
      if (!rollId) continue;
      try {
        await db
          .update(ltRollTable)
          .set({
            dateRollUsed: ltDate(str(d["dateRollUsed"])),
            stockDate: ltDate(str(d["stockDate"])),
            used: d["stockUsed"] === true || ltDate(str(d["dateRollUsed"])) != null,
            usedTikNum: str(d["usedTikNumber"]),
            allocTikNum: str(d["allocTikNumber"]),
            syncedAt: new Date(),
          })
          .where(eq(ltRollTable.rollId, rollId));
        enriched++;
      } catch (err) {
        // transient DB/network blips: skip this roll, it stays "missing"
        // and gets picked up by a later pass
        logger.warn({ err, rollId }, "lt_roll date enrichment update failed");
      }
    }
  }
  return { enriched };
}

/** Full used-roll pull (nightly/backfill): list all used rolls (~220 pages). */
export async function syncLtUsedRolls(): Promise<{ used: number }> {
  const rows = await ltGetAllPages<RollListRow>("/roll-inventory", { Used: true });
  const values = rollValues(rows, true);
  for (const batch of chunkArray(values, 500)) {
    await db
      .insert(ltRollTable)
      .values(batch)
      .onConflictDoUpdate({
        target: ltRollTable.rollId,
        set: {
          stockId: sql`excluded.stock_id`,
          poNumber: sql`excluded.po_number`,
          width: sql`excluded.width`,
          length: sql`excluded.length`,
          usedTikNum: sql`excluded.used_tik_num`,
          used: sql`excluded.used`,
          syncedAt: new Date(),
        },
      });
  }
  return { used: values.length };
}

/** Hourly incremental sync; `full` adds the complete used-roll history. */
export async function performLtApiSync(opts: { full?: boolean } = {}): Promise<Record<string, unknown>> {
  if (!ltApiConfigured()) throw new Error("LT_API_KEY is not configured");
  const out: Record<string, unknown> = {};
  out["stocks"] = (await syncLtStocks()).stocks;
  const tix = await syncLtTickets({ full: opts.full });
  out["tickets"] = tix.tickets;
  out["ticketsDeleted"] = tix.deleted;
  out["ticketsRefreshed"] = tix.refreshed;
  out["pos"] = (await syncLtPos({ full: opts.full })).pos;
  // Requested-delivery dates come from ODBC; never let a gateway blip stall the
  // rest of the LT sync.
  try {
    out["poRequestedDates"] = (await syncLtPoRequestedDates()).requestedDates;
  } catch (err) {
    out["poRequestedDates"] = { error: err instanceof Error ? err.message : String(err) };
  }
  const onHand = await syncLtOnHandRolls();
  out["onHandRolls"] = onHand.onHand;
  out["newlyUsedRolls"] = onHand.newlyUsed;
  if (opts.full) {
    out["usedRolls"] = (await syncLtUsedRolls()).used;
  }
  const dates = await syncLtRollDates({ limit: opts.full ? 5000 : 1500 });
  out["rollDatesEnriched"] = dates.enriched;
  await recordLtSyncState("labeltraxx_api", out);
  return out;
}
