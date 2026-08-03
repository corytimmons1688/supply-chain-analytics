import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, stockGoalTable, globalGoalTable, materialPoTable, materialPoLineTable, ltStockTable, ltPoTable, ltRollTable, vendorContactTable, poEmailEventTable, poAgentDraftTable, poAttachmentTable, agentLessonTable, eoDispositionTable, type StockGoalRow } from "@workspace/db";
import {
  fetchUsage,
  fetchOnHandByStock,
  fetchPoLeadTimes,
  fetchPoRolls,
  fetchOpenPos,
  fetchActiveStockIds,
  fetchStockInfo,
  fetchOpenTickets,
  fetchPoReceipts,
  fetchOnHandByWidth,
  computeStockMetrics,
  vendorLeadTimeMedians,
  computeWidthAvailability,
  widthGroupKey,
  bucketHistory,
  defaultDemandWindow,
  type RollUsageRow,
  type PoRollRow,
  type OpenPoRow,
  type WidthRow,
} from "../lib/demand";
import { fetchDazpakByStock } from "../lib/dazpak-sync";
import { assemblePoDocument, PoDocumentError } from "../lib/po-document";
import { logger } from "../lib/logger";
import type { Bucket } from "../lib/cc";

// Dazpak make-and-hold horizons (Cory's settings): release when Calyx on-hand
// can't cover committed demand due within 15 business days (~21 calendar days);
// keep total coverage (on-hand + Held + In-Production) above 10 weeks of demand.
const DAZPAK_RELEASE_DAYS = 21;
const DAZPAK_MAKE_DAYS = 70;

interface StockOverrides {
  demandCv?: number;
  leadTimeCv?: number;
  seasonalityWeights?: [number, number, number] | null;
  leadTimeDays?: number;
  typicalRollFootage?: number;
  reorderPointFootage?: number;
  maxFootage?: number;
  customized: boolean;
}

function rowToOverrides(row: StockGoalRow | undefined): StockOverrides {
  if (!row) return { customized: false };
  const out: StockOverrides = { customized: false };
  if (row.demandCv != null) {
    out.demandCv = row.demandCv;
    out.customized = true;
  }
  if (row.leadTimeCv != null) {
    out.leadTimeCv = row.leadTimeCv;
    out.customized = true;
  }
  if (row.seasonalityW1 != null && row.seasonalityW2 != null && row.seasonalityW3 != null) {
    out.seasonalityWeights = [row.seasonalityW1, row.seasonalityW2, row.seasonalityW3];
    out.customized = true;
  }
  if (row.leadTimeDays != null && row.leadTimeDays > 0) {
    out.leadTimeDays = row.leadTimeDays;
    out.customized = true;
  }
  if (row.typicalRollFootage != null && row.typicalRollFootage > 0) {
    out.typicalRollFootage = row.typicalRollFootage;
    out.customized = true;
  }
  if (row.reorderPointFootage != null && row.reorderPointFootage > 0) {
    out.reorderPointFootage = row.reorderPointFootage;
    out.customized = true;
  }
  if (row.maxFootage != null && row.maxFootage > 0) {
    out.maxFootage = row.maxFootage;
    out.customized = true;
  }
  return out;
}

const router: IRouter = Router();

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function parseNum(v: unknown, fallback: number): number {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseOptNum(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseInt32(v: unknown, fallback: number): number {
  const n = parseNum(v, fallback);
  return Math.max(1, Math.floor(n));
}

function parseBucket(v: unknown): Bucket {
  if (v === "day" || v === "week" || v === "month" || v === "quarter" || v === "year") return v;
  return "week";
}

router.get(
  "/demand/summary",
  asyncHandler(async (req, res) => {
    const monthsBack = parseInt32(req.query["monthsBack"], 6);
    const serviceLevel = Math.min(0.999, Math.max(0.5, parseNum(req.query["serviceLevel"], 0.95)));
    const demandCvOverride = parseOptNum(req.query["demandCv"]);
    const leadTimeCvOverride = parseOptNum(req.query["leadTimeCv"]);
    const forecastWeeks = parseInt32(req.query["forecastWeeks"], 12);

    const { from, to } = defaultDemandWindow(monthsBack);

    const [usage, onHand, poLeadTimes, poRolls, openPos, activeStockIds, stockGoalRows, openTickets, stockInfo, globalRows, onHandByWidth, dazpakByStock] = await Promise.all([
      fetchUsage({ from, to }),
      fetchOnHandByStock(),
      fetchPoLeadTimes(),
      fetchPoRolls(),
      fetchOpenPos(),
      fetchActiveStockIds(),
      db.select().from(stockGoalTable),
      fetchOpenTickets(),
      fetchStockInfo(),
      db.select().from(globalGoalTable).where(eq(globalGoalTable.id, "global")),
      fetchOnHandByWidth(),
      fetchDazpakByStock(),
    ]);

    // EOQ economics: fixed cost to place a PO and annual carrying rate. Query
    // param → saved global default → hard-coded default ($150 / 20%/yr).
    const g = globalRows[0];
    const orderingCost = parseNum(req.query["orderingCost"], g?.orderingCost ?? 150);
    const carryingRatePct = parseNum(req.query["carryingRatePct"], g?.carryingRatePct ?? 0.2);
    // Per-vendor median lead time — the fallback tier when a stock has too
    // little PO history of its own.
    const vendorLtMedians = vendorLeadTimeMedians(poLeadTimes);

    // Committed material requirements: sum each open ticket's footage against
    // every material in its BOM (fetchOpenTickets emits one row per material).
    // Also keep the per-ticket lines (footage + ship-by date) so computeStock-
    // Metrics can time-phase demand against the lead-time horizon.
    const openTicketFootageByStock = new Map<string, number>();
    const openTicketLinesByStock = new Map<
      string,
      { ticketNumber: string; footage: number; shipByDate: string | null; requiredWidth: number }[]
    >();
    for (const t of openTickets) {
      openTicketFootageByStock.set(t.stockId, (openTicketFootageByStock.get(t.stockId) ?? 0) + t.estFootage);
      let lines = openTicketLinesByStock.get(t.stockId);
      if (!lines) { lines = []; openTicketLinesByStock.set(t.stockId, lines); }
      lines.push({ ticketNumber: t.ticketNumber, footage: t.estFootage, shipByDate: t.shipByDate, requiredWidth: t.requiredWidth });
    }
    const overridesByStock = new Map<string, StockOverrides>();
    for (const row of stockGoalRows) overridesByStock.set(row.stockId, rowToOverrides(row));
    const goalRowByStock = new Map(stockGoalRows.map((r) => [r.stockId, r]));

    // Group everything by stockId
    const usageByStock = new Map<string, RollUsageRow[]>();
    const descByStock = new Map<string, string | null>();
    for (const u of usage) {
      let arr = usageByStock.get(u.stockId);
      if (!arr) { arr = []; usageByStock.set(u.stockId, arr); }
      arr.push(u);
      if (u.description && !descByStock.get(u.stockId)) descByStock.set(u.stockId, u.description);
    }
    const poRollsByStock = new Map<string, PoRollRow[]>();
    for (const r of poRolls) {
      let arr = poRollsByStock.get(r.stockId);
      if (!arr) { arr = []; poRollsByStock.set(r.stockId, arr); }
      arr.push(r);
    }
    const openPosByStock = new Map<string, OpenPoRow[]>();
    for (const p of openPos) {
      let arr = openPosByStock.get(p.stockId);
      if (!arr) { arr = []; openPosByStock.set(p.stockId, arr); }
      arr.push(p);
    }

    // Dashboard POs already submitted (recorded here and/or created in Label
    // Traxx) but not yet visible in the LT mirror — the mirror syncs every
    // ~15 min, and until it catches up a just-submitted PO must still count as
    // on-order, or the stock keeps suggesting the reorder the buyer just made.
    // Once any of the PO's LT numbers appears in the mirror, the mirror row is
    // authoritative and the dashboard record no longer adds supply.
    {
      const mirrored = new Set((await db.select({ n: ltPoTable.poNumber }).from(ltPoTable)).map((r) => r.n));
      const dashPos = (
        await db
          .select()
          .from(materialPoTable)
          .where(inArray(materialPoTable.status, ["submitted", "submitted_lt"]))
      ).filter((p) => {
        const nums = (p.ltPoNumbers ?? "").split(",").map((n) => n.trim()).filter(Boolean);
        return nums.every((n) => !mirrored.has(n));
      });
      if (dashPos.length) {
        const dashLines = await db
          .select()
          .from(materialPoLineTable)
          .where(inArray(materialPoLineTable.poId, dashPos.map((p) => p.id)));
        const poById = new Map(dashPos.map((p) => [p.id, p]));
        for (const l of dashLines) {
          const po = poById.get(l.poId)!;
          const arr = openPosByStock.get(l.stockId) ?? [];
          arr.push({
            poNumber: (po.ltPoNumbers ?? "").split(",")[0]?.trim() || `DASH-${po.id.slice(0, 6).toUpperCase()}`,
            stockId: l.stockId,
            poDateIso: po.createdAt.toISOString().slice(0, 10),
            dueDateIso: null, // nothing in LT yet → unconfirmed there
            // …but the vendor may already have committed by email.
            agentPromisedIso: po.promisedDate,
            requestedDeliveryIso: po.requestedDeliveryDate,
            quantityRolls: l.rolls,
            masterWidth: l.width ?? stockInfo.get(l.stockId)?.masterWidth ?? null,
            orderedFootage: l.footage ?? 0,
            // Dashboard-submitted PO not yet mirrored from LT — the vendor we
            // sent it to is the supplier.
            supplierName: po.vendorName,
            notes: po.notes,
            description: l.description,
            daysOpen: null,
          });
          openPosByStock.set(l.stockId, arr);
        }
      }
    }

    // Dazpak make-and-hold horizon dates (release ~15 biz days, make 10 weeks).
    const dazpakReleaseEnd = new Date(Date.now() + DAZPAK_RELEASE_DAYS * 864e5).toISOString().slice(0, 10);
    const dazpakMakeEnd = new Date(Date.now() + DAZPAK_MAKE_DAYS * 864e5).toISOString().slice(0, 10);

    // Exact-width committed shortage per stock (demand at a width covered only by
    // on-hand + on-order at that width) — drives the width-aware reorder.
    const committedShortageByStock = new Map<string, number>();
    const committedShortWidthsByStock = new Map<string, { width: number; footage: number }[]>();
    for (const [stockId, lines] of openTicketLinesByStock) {
      const widths = onHandByWidth.get(stockId) ?? [];
      const rolls = widths.reduce((s, w) => s + w.rolls, 0);
      const ft = widths.reduce((s, w) => s + w.footage, 0);
      const { committedShortageFootage, shortByExactWidth } = computeWidthAvailability({
        onHand: widths,
        openPos: (openPosByStock.get(stockId) ?? []).map((p) => ({
          masterWidth: p.masterWidth,
          quantityRolls: p.quantityRolls,
          // A vendor commitment by email counts as confirmed supply, even when

          // Label Traxx has no dueDate typed in yet.

          dueDateIso: p.dueDateIso ?? p.agentPromisedIso,
          orderedFootage: p.orderedFootage,
        })),
        lines: lines.map((l) => ({
          key: l.ticketNumber,
          requiredWidth: l.requiredWidth,
          footage: l.footage,
          shipByDate: l.shipByDate,
        })),
        avgRollFootage: rolls > 0 ? ft / rolls : 5000,
        masterWidthFallback: stockInfo.get(stockId)?.masterWidth ?? 0,
      });
      committedShortageByStock.set(stockId, committedShortageFootage);
      committedShortWidthsByStock.set(stockId, shortByExactWidth);
    }

    const allStockIds = new Set<string>();
    for (const k of usageByStock.keys()) if (activeStockIds.has(k)) allStockIds.add(k);
    for (const k of onHand.keys()) if (activeStockIds.has(k)) allStockIds.add(k);
    // Stocks with only open POs (no recent usage and nothing on hand) still
    // matter for the buyer — surface them in the summary.
    for (const k of openPosByStock.keys()) if (activeStockIds.has(k)) allStockIds.add(k);
    // Likewise, a material needed by open tickets must surface even with no
    // recent usage history (committed demand is a reorder driver on its own).
    for (const k of openTicketFootageByStock.keys()) if (activeStockIds.has(k)) allStockIds.add(k);
    // Stocks Label Traxx marks INACTIVE are excluded above, but many still hold
    // real footage on the floor (~54 stocks / 428k ft today). Keep those visible
    // for sell-through — flagged `inactive`, and never suggested for reorder —
    // rather than silently hiding physical inventory.
    for (const [k, v] of onHand) if (!activeStockIds.has(k) && (v.footage ?? 0) > 0) allStockIds.add(k);

    // Global fallback lead time: median across all observed POs (else 14 days)
    const allLts = Array.from(poLeadTimes.values()).map((p) => p.leadTimeDays);
    const fallbackLeadTimeDays = allLts.length > 0
      ? allLts.slice().sort((a, b) => a - b)[Math.floor(allLts.length / 2)]!
      : 14;

    const items = [];
    for (const stockId of allStockIds) {
      // A successor SKU merges its EOL predecessor's full usage history so its
      // forecast / reorder point reflect the demand it inherited.
      const ownUsage = usageByStock.get(stockId) ?? [];
      const predecessorId = goalRowByStock.get(stockId)?.demandFromStockId ?? null;
      const stockUsage = predecessorId
        ? [...ownUsage, ...(usageByStock.get(predecessorId) ?? [])]
        : ownUsage;
      const stockOnHand = onHand.get(stockId);
      const stockPoRolls = poRollsByStock.get(stockId) ?? [];
      const description = descByStock.get(stockId) ?? stockOnHand?.description ?? null;
      const overrides = overridesByStock.get(stockId) ?? { customized: false };
      // Per-stock overrides win over the request-level (global) overrides.
      const effDemandCv = overrides.demandCv ?? demandCvOverride;
      const effLeadTimeCv = overrides.leadTimeCv ?? leadTimeCvOverride;

      // Effective vendor (override → LT supplier) drives the lead-time fallback
      // tier; effective landed cost/ft (override → LT CostMSI) drives EOQ holding cost.
      const info = stockInfo.get(stockId);
      const goalRow = goalRowByStock.get(stockId);
      const vendorName = goalRow?.vendorName ?? info?.supplierName ?? null;
      const vendorLeadTimeDays = vendorName ? vendorLtMedians.get(vendorName) : undefined;
      const effMsiCost = goalRow?.msiCost ?? (info && info.costMsi > 0 ? info.costMsi : 0);
      const width = info?.masterWidth ?? 0;
      const unitValuePerFoot =
        effMsiCost > 0 && width > 0 ? ((effMsiCost + (info?.freightMsi ?? 0)) * 12 * width) / 1000 : 0;

      const { metrics } = computeStockMetrics({
        stockId,
        description,
        usage: stockUsage,
        windowStart: from,
        windowEnd: to,
        onHandFootage: stockOnHand?.footage ?? 0,
        onHandRollCount: stockOnHand?.rollCount ?? 0,
        poLeadTimes,
        poRolls: stockPoRolls,
        openPos: openPosByStock.get(stockId) ?? [],
        openTicketFootage: openTicketFootageByStock.get(stockId) ?? 0,
        openTicketLines: openTicketLinesByStock.get(stockId) ?? [],
        committedShortageOverride: committedShortageByStock.get(stockId) ?? 0,
        serviceLevel,
        orderingCost,
        carryingRatePct,
        unitValuePerFoot,
        discontinued: goalRow?.discontinued ?? false,
        inactive: info ? info.inactive : true,
        demandFromStockId: predecessorId,
        alternateStockIds: (goalRowByStock.get(stockId)?.alternateStockIds ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        ...(vendorLeadTimeDays !== undefined ? { vendorLeadTimeDays } : {}),
        ...(goalRow?.orderQuantityRolls != null && goalRow.orderQuantityRolls > 0
          ? { orderQuantityRollsOverride: goalRow.orderQuantityRolls }
          : {}),
        ...(effDemandCv !== undefined ? { demandCvOverride: effDemandCv } : {}),
        ...(effLeadTimeCv !== undefined ? { leadTimeCvOverride: effLeadTimeCv } : {}),
        ...(overrides.seasonalityWeights ? { seasonalityWeightsOverride: overrides.seasonalityWeights } : {}),
        ...(overrides.leadTimeDays !== undefined ? { leadTimeDaysOverride: overrides.leadTimeDays } : {}),
        ...(overrides.typicalRollFootage !== undefined ? { typicalRollFootageOverride: overrides.typicalRollFootage } : {}),
        ...(overrides.reorderPointFootage !== undefined ? { reorderPointOverride: overrides.reorderPointFootage } : {}),
        ...(overrides.maxFootage !== undefined ? { maxFootageOverride: overrides.maxFootage } : {}),
        forecastWeeks,
        fallbackLeadTimeDays,
        customized: overrides.customized,
      });

      // Dazpak make-and-hold signals: release from Held to cover near-term
      // shortfall; trigger a make-and-hold when total coverage can't span the
      // 10-week make window.
      const dz = dazpakByStock.get(stockId);
      if (dz) {
        const onHandFt = stockOnHand?.footage ?? 0;
        const lines = openTicketLinesByStock.get(stockId) ?? [];
        const demandRelease = lines.reduce(
          (s, l) => (l.shipByDate && l.shipByDate <= dazpakReleaseEnd ? s + l.footage : s),
          0,
        );
        const committedMake = lines.reduce(
          (s, l) => (l.shipByDate && l.shipByDate <= dazpakMakeEnd ? s + l.footage : s),
          0,
        );
        const demandMake = Math.max(metrics.avgWeeklyDemand * 10, committedMake);

        // Width break-out: supply at a width only covers demand at that width
        // (same pooling as everywhere else — ≤14" is one bucket, labeled ≤13").
        // Unspecified widths fall back to the stock's master-width bucket.
        const bucketOf = (w: number | null | undefined) => widthGroupKey(w && w > 0 ? w : width);
        type WBucket = {
          rep: number;
          pooled: boolean;
          onHandFootage: number;
          heldFootage: number;
          inProductionFootage: number;
          etaDate: string | null;
          demandReleaseHorizon: number;
          releaseFootage: number;
          /**
           * Demand inside the release window that on-hand doesn't cover — before
           * capping at what the vendor actually holds. releaseFootage is this
           * clamped to heldFootage, so the gap between them is the part no
           * release can fix.
           */
          shortfallFootage: number;
        };
        const wb = new Map<string, WBucket>();
        const bucket = (k: string): WBucket => {
          let b = wb.get(k);
          if (!b) {
            b = { rep: 0, pooled: k === "le13", onHandFootage: 0, heldFootage: 0, inProductionFootage: 0, etaDate: null, demandReleaseHorizon: 0, releaseFootage: 0, shortfallFootage: 0 };
            wb.set(k, b);
          }
          return b;
        };
        for (const w of onHandByWidth.get(stockId) ?? []) {
          const b = bucket(widthGroupKey(w.width));
          b.onHandFootage += w.footage;
          if (w.width > b.rep) b.rep = w.width;
        }
        for (const l of dz.lines) {
          const b = bucket(bucketOf(l.width));
          b.heldFootage += l.madeFootage + (l.status === "Held" ? l.outstandingFootage : 0);
          if (l.status !== "Held") b.inProductionFootage += l.outstandingFootage;
          if (l.status !== "Held" && l.outstandingFootage > 0 && l.planAvailDate) {
            if (!b.etaDate || l.planAvailDate < b.etaDate) b.etaDate = l.planAvailDate;
          }
          if ((l.width ?? 0) > b.rep) b.rep = l.width ?? 0;
        }
        for (const l of lines) {
          if (!l.shipByDate || l.shipByDate > dazpakReleaseEnd) continue;
          const b = bucket(bucketOf(l.requiredWidth));
          b.demandReleaseHorizon += l.footage;
          if (l.requiredWidth > b.rep) b.rep = l.requiredWidth;
        }
        for (const b of wb.values()) {
          b.shortfallFootage = Math.max(0, b.demandReleaseHorizon - b.onHandFootage);
          b.releaseFootage = Math.min(b.shortfallFootage, b.heldFootage);
        }
        const dazpakWidths = [...wb.values()]
          .filter((b) => b.heldFootage > 0 || b.inProductionFootage > 0 || b.demandReleaseHorizon > 0)
          .sort((a, b) => a.rep - b.rep)
          .map((b) => ({
            label: b.pooled ? `≤13"` : `${Math.round(b.rep * 100) / 100}"`,
            width: Math.round(b.rep * 100) / 100,
            pooled: b.pooled,
            onHandFootage: Math.round(b.onHandFootage),
            heldFootage: Math.round(b.heldFootage),
            inProductionFootage: Math.round(b.inProductionFootage),
            etaDate: b.etaDate,
            demandReleaseHorizon: Math.round(b.demandReleaseHorizon),
            releaseFootage: Math.round(b.releaseFootage),
            // What the release can't reach — nothing (or not enough) is made.
            unreleasableFootage: Math.round(Math.max(0, b.shortfallFootage - b.releaseFootage)),
          }));

        // Stock-level release = sum of the width-level releases (width-aware:
        // held 30" can't cover a ≤13" shortfall, and vice versa).
        const releaseFootage = dazpakWidths.reduce((s, b) => s + b.releaseFootage, 0);
        /**
         * Demand inside the release window that a release cannot satisfy because
         * the vendor hasn't made it yet. #307 is the case this exists for: 95,231
         * ft on hand against 228,010 ft committed, and every foot of its 440,000
         * ft make-and-hold still in production — so the panel read "covered" when
         * it meant "there is nothing to release", which are not the same thing.
         */
        const unreleasableFootage = dazpakWidths.reduce((s, b) => s + b.unreleasableFootage, 0);
        const coverage = onHandFt + dz.heldFootage + dz.inProductionFootage;
        const makeFootage = Math.max(0, demandMake - coverage);
        metrics.dazpak = {
          heldFootage: dz.heldFootage,
          inProductionFootage: dz.inProductionFootage,
          etaDate: dz.etaDate,
          demandReleaseHorizon: Math.round(demandRelease),
          demandMakeHorizon: Math.round(demandMake),
          releaseFootage: Math.round(releaseFootage),
          unreleasableFootage: Math.round(unreleasableFootage),
          makeFootage: Math.round(makeFootage),
          widths: dazpakWidths,
          lines: dz.lines,
        };
      }

      // Break the suggestion out by the width to ORDER: committed shortfalls at
      // the exact widths the tickets require (a 12.75" job means buying 12.75",
      // even though wider ≤13" stock could serve it), then any forecast/EOQ
      // remainder at the stock's own master width.
      if (metrics.suggestedOrderRolls > 0) {
        const typical = metrics.typicalRollFootage > 0 ? metrics.typicalRollFootage : 5000;
        const byWidth: { width: number; footage: number; rolls: number; reason: "committed" | "forecast" | "both" }[] = [];
        let remainingRolls = metrics.suggestedOrderRolls;
        for (const ws of committedShortWidthsByStock.get(stockId) ?? []) {
          if (remainingRolls <= 0) break;
          const rollsForWidth = Math.min(remainingRolls, Math.ceil(ws.footage / typical));
          if (rollsForWidth <= 0) continue;
          byWidth.push({ width: ws.width, footage: rollsForWidth * typical, rolls: rollsForWidth, reason: "committed" });
          remainingRolls -= rollsForWidth;
        }
        if (remainingRolls > 0) {
          // Forecast/EOQ top-up at the stock's master width (else the widest committed width).
          const mw = width > 0 ? Math.round(width * 100) / 100 : (byWidth[byWidth.length - 1]?.width ?? 0);
          const existing = byWidth.find((s) => s.width === mw);
          if (existing) {
            existing.rolls += remainingRolls;
            existing.footage += remainingRolls * typical;
            existing.reason = "both";
          } else {
            byWidth.push({ width: mw, footage: remainingRolls * typical, rolls: remainingRolls, reason: "forecast" });
          }
        }
        metrics.suggestedWidths = byWidth.sort((a, b) => a.width - b.width);
      }

      // Skip stocks with no signal at all (zero history AND zero on-hand AND
      // no open POs AND no committed open-ticket demand) — unless Dazpak covers it.
      if (
        !metrics.dazpak &&
        metrics.totalDemandFootage === 0 &&
        metrics.onHandFootage === 0 &&
        metrics.openPoCount === 0 &&
        metrics.openTicketFootage === 0
      ) continue;
      items.push(metrics);
    }

    // Sort: below-min first, then by descending forecast demand
    items.sort((a, b) => {
      if (a.belowMin !== b.belowMin) return a.belowMin ? -1 : 1;
      return b.forecast12wkFootage - a.forecast12wkFootage;
    });

    // Make-and-hold releases we've requested. The make-and-hold PO itself isn't
    // inbound material (it sits in the vendor's warehouse), but a release is —
    // so the Open POs report shows these instead of the parent orders.
    const releaseRows = await db
      .select()
      .from(materialPoTable)
      .where(eq(materialPoTable.kind, "mah_release"));
    const releaseLines = releaseRows.length
      ? await db
          .select()
          .from(materialPoLineTable)
          .where(inArray(materialPoLineTable.poId, releaseRows.map((r) => r.id)))
      : [];
    const mahReleases = releaseLines.map((l) => {
      const po = releaseRows.find((r) => r.id === l.poId)!;
      return {
        id: po.id,
        stockId: l.stockId,
        vendorName: po.vendorName,
        fromPoNumbers: po.releaseFromPoNumbers,
        rolls: l.rolls,
        footage: l.footage ?? 0,
        width: l.width,
        requestedDeliveryDate: po.requestedDeliveryDate,
        promisedDate: po.promisedDate,
        emailedAt: po.emailedAt?.toISOString() ?? null,
        agentState: po.agentState,
        needsAttention: po.needsAttention,
        attentionReason: po.attentionReason,
        notes: po.notes,
      };
    });

    res.json({
      windowFrom: from,
      windowTo: to,
      monthsBack,
      serviceLevel,
      forecastWeeks,
      generatedAt: new Date().toISOString(),
      items,
      mahReleases,
    });
  }),
);

router.get(
  "/demand/stock-detail",
  asyncHandler(async (req, res) => {
    const stockId = String(req.query["stockId"] ?? "");
    if (!stockId) {
      res.status(400).json({ error: "stockId required" });
      return;
    }
    const monthsBack = parseInt32(req.query["monthsBack"], 6);
    const bucket = parseBucket(req.query["bucket"]);
    const serviceLevel = Math.min(0.999, Math.max(0.5, parseNum(req.query["serviceLevel"], 0.95)));
    const demandCvOverride = parseOptNum(req.query["demandCv"]);
    const leadTimeCvOverride = parseOptNum(req.query["leadTimeCv"]);
    const forecastWeeks = parseInt32(req.query["forecastWeeks"], 12);

    const { from, to } = defaultDemandWindow(monthsBack);

    const [usage, onHandMap, poLeadTimes, poRolls, openPos, stockGoalRows] = await Promise.all([
      fetchUsage({ from, to, stockId }),
      fetchOnHandByStock(),
      fetchPoLeadTimes(),
      fetchPoRolls(),
      fetchOpenPos(),
      db.select().from(stockGoalTable).where(eq(stockGoalTable.stockId, stockId)),
    ]);

    const stockOnHand = onHandMap.get(stockId);
    const stockPoRolls = poRolls.filter((r) => r.stockId === stockId);
    const stockOpenPos = openPos
      .filter((p) => p.stockId === stockId)
      .sort((a, b) => (b.poDateIso ?? "").localeCompare(a.poDateIso ?? ""));
    const description = usage.find((u) => u.description)?.description ?? stockOnHand?.description ?? null;
    const allLts = Array.from(poLeadTimes.values()).map((p) => p.leadTimeDays);
    const fallbackLeadTimeDays = allLts.length > 0
      ? allLts.slice().sort((a, b) => a - b)[Math.floor(allLts.length / 2)]!
      : 14;

    const overrides = rowToOverrides(stockGoalRows[0]);
    const effDemandCv = overrides.demandCv ?? demandCvOverride;
    const effLeadTimeCv = overrides.leadTimeCv ?? leadTimeCvOverride;

    const { metrics, forecast } = computeStockMetrics({
      stockId,
      description,
      usage,
      windowStart: from,
      windowEnd: to,
      onHandFootage: stockOnHand?.footage ?? 0,
      onHandRollCount: stockOnHand?.rollCount ?? 0,
      poLeadTimes,
      poRolls: stockPoRolls,
      openPos: stockOpenPos,
      serviceLevel,
      ...(effDemandCv !== undefined ? { demandCvOverride: effDemandCv } : {}),
      ...(effLeadTimeCv !== undefined ? { leadTimeCvOverride: effLeadTimeCv } : {}),
      ...(overrides.seasonalityWeights ? { seasonalityWeightsOverride: overrides.seasonalityWeights } : {}),
      ...(overrides.leadTimeDays !== undefined ? { leadTimeDaysOverride: overrides.leadTimeDays } : {}),
      ...(overrides.typicalRollFootage !== undefined ? { typicalRollFootageOverride: overrides.typicalRollFootage } : {}),
        ...(overrides.reorderPointFootage !== undefined ? { reorderPointOverride: overrides.reorderPointFootage } : {}),
        ...(overrides.maxFootage !== undefined ? { maxFootageOverride: overrides.maxFootage } : {}),
      forecastWeeks,
      fallbackLeadTimeDays,
      customized: overrides.customized,
    });

    const history = bucketHistory(usage, from, to, bucket);

    res.json({
      stockId,
      windowFrom: from,
      windowTo: to,
      bucket,
      serviceLevel,
      metrics,
      history,
      forecast,
      openPos: stockOpenPos,
    });
  }),
);


// =====================================================================
// PURCHASING — vendor/cost config, open-ticket requirements, and
// suggested-PO workflow for Demand Planning.
// =====================================================================

const LT_WRITE_ENABLED = Boolean(process.env["LT_API_KEY"]);

function parseEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => e.includes("@"));
}

/**
 * Per-stock purchasing layer: Label Traxx stock master (vendor, MSI cost,
 * width, LT min/max), our config overrides, and open-ticket requirements.
 * The frontend joins this with /demand/summary metrics.
 */
router.get(
  "/demand/purchasing",
  asyncHandler(async (_req, res) => {
    const [stockInfo, tickets, goalRows, activeStockIds, widthsByStock, openPos, trackedPos] = await Promise.all([
      fetchStockInfo(),
      fetchOpenTickets(),
      db.select().from(stockGoalTable),
      fetchActiveStockIds(),
      fetchOnHandByWidth(),
      fetchOpenPos(),
      db.select().from(materialPoTable),
    ]);
    const goalsByStock = new Map(goalRows.map((g) => [g.stockId, g]));
    const trackedLines = trackedPos.length
      ? await db.select().from(materialPoLineTable).where(inArray(materialPoLineTable.poId, trackedPos.map((p) => p.id)))
      : [];
    const extLeadByPoId = new Map(
      trackedLines.filter((l) => l.extendedLeadTime).map((l) => [l.poId, l.extendedLeadTimeDays ?? null]),
    );

    // What the agent learned per LT PO number. A vendor's promise usually
    // arrives by email (captured here) long before it lands on LT's dueDate,
    // and the agent appends tracking references to its own notes — so the
    // inbound view has to consult both sources or it shows stale dates.
    const agentByLtPo = new Map<
      string,
      {
        promisedDate: string | null;
        promisedDateDerived: boolean;
        promisedDateBasis: string | null;
        notes: string | null;
        extendedLeadTimeDays: number | null;
      }
    >();
    for (const p of trackedPos) {
      for (const n of (p.ltPoNumbers ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
        const prev = agentByLtPo.get(n);
        agentByLtPo.set(n, {
          promisedDate: p.promisedDate ?? prev?.promisedDate ?? null,
          promisedDateDerived: p.promisedDate ? p.promisedDateDerived : (prev?.promisedDateDerived ?? false),
          promisedDateBasis: p.promisedDate ? p.promisedDateBasis : (prev?.promisedDateBasis ?? null),
          notes: [prev?.notes, p.notes].filter(Boolean).join("\n") || null,
          extendedLeadTimeDays: extLeadByPoId.has(p.id)
            ? extLeadByPoId.get(p.id) ?? null
            : prev?.extendedLeadTimeDays ?? null,
        });
      }
    }

    // Open POs grouped per stock (kept as full rows so we can bucket on-order by
    // the PO's master width for exact-width availability).
    const posListByStock = new Map<string, typeof openPos>();
    for (const po of openPos) {
      let arr = posListByStock.get(po.stockId);
      if (!arr) { arr = []; posListByStock.set(po.stockId, arr); }
      arr.push(po);
    }

    // tickets has one row per (ticket × material in the BOM). Aggregate required
    // footage per material and keep the per-material ticket lines so we can net
    // demand against inventory → POs → shortfall by WIDTH below.
    const ticketAgg = new Map<
      string,
      { requiredFootage: number; ticketCount: number; tickets: typeof tickets }
    >();
    for (const t of tickets) {
      let agg = ticketAgg.get(t.stockId);
      if (!agg) {
        agg = { requiredFootage: 0, ticketCount: 0, tickets: [] };
        ticketAgg.set(t.stockId, agg);
      }
      agg.requiredFootage += t.estFootage;
      agg.ticketCount += 1;
      agg.tickets.push(t);
    }

    const STATUS_SEVERITY: Record<string, number> = {
      In: 0,
      Ordered: 1,
      "Ordered Not Confirmed": 2,
      Out: 3,
    };
    // Worst status per ticket (across all its materials) → the donut.
    const ticketWorstStatus = new Map<string, string>();
    // Worst status among a stock's own lines → the stock's overall bar colour.
    const stockLineStatus = new Map<string, string>();
    // Per-stock per-width availability rows for the Stock Inventory Summary.
    const widthRowsByStock = new Map<string, WidthRow[]>();

    function avgRollFootage(stockId: string): number {
      const widths = widthsByStock.get(stockId) ?? [];
      let ft = 0;
      let rolls = 0;
      for (const w of widths) {
        ft += w.footage;
        rolls += w.rolls;
      }
      return rolls > 0 ? ft / rolls : 5000;
    }

    // Availability is EXACT WIDTH: demand at a width is covered only by on-hand
    // + on-order (PO master width) at that same width (no slitting across widths).
    for (const [stockId, agg] of ticketAgg) {
      const info = stockInfo.get(stockId);
      const result = computeWidthAvailability({
        onHand: widthsByStock.get(stockId) ?? [],
        openPos: (posListByStock.get(stockId) ?? []).map((p) => ({
          masterWidth: p.masterWidth,
          quantityRolls: p.quantityRolls,
          // A vendor commitment by email counts as confirmed supply, even when

          // Label Traxx has no dueDate typed in yet.

          dueDateIso: p.dueDateIso ?? p.agentPromisedIso,
          orderedFootage: p.orderedFootage,
        })),
        lines: agg.tickets.map((t) => ({
          key: t.ticketNumber,
          requiredWidth: t.requiredWidth,
          footage: t.estFootage,
          shipByDate: t.shipByDate,
        })),
        avgRollFootage: avgRollFootage(stockId),
        masterWidthFallback: info?.masterWidth ?? 0,
      });
      widthRowsByStock.set(stockId, result.widthRows);
      for (const line of agg.tickets) {
        const status = result.lineStatus.get(line.ticketNumber) ?? "In";
        line.computedStatus = status;
        const prevTicket = ticketWorstStatus.get(line.ticketNumber);
        if (prevTicket == null || STATUS_SEVERITY[status]! > STATUS_SEVERITY[prevTicket]!) {
          ticketWorstStatus.set(line.ticketNumber, status);
        }
        const prevStock = stockLineStatus.get(stockId);
        if (prevStock == null || STATUS_SEVERITY[status]! > STATUS_SEVERITY[prevStock]!) {
          stockLineStatus.set(stockId, status);
        }
      }
    }

    const statusCounts: Record<string, number> = {};
    for (const status of ticketWorstStatus.values()) {
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }

    const stockIds = new Set<string>([...stockInfo.keys(), ...ticketAgg.keys()]);
    const items = [...stockIds]
      // Active stocks, anything with committed demand, plus inactive stocks that
      // still hold footage (visible for sell-through; the Configuration tab hides
      // them via `inactive`).
      .filter(
        (id) =>
          activeStockIds.size === 0 ||
          activeStockIds.has(id) ||
          ticketAgg.has(id) ||
          (widthsByStock.get(id)?.length ?? 0) > 0,
      )
      .map((stockId) => {
        const info = stockInfo.get(stockId);
        const goal = goalsByStock.get(stockId);
        const agg = ticketAgg.get(stockId);
        const widths = widthsByStock.get(stockId) ?? [];
        // On-hand MSI = Σ (footage × 12in/ft × width) / 1000, to compare against
        // Label Traxx's MSI-denominated min/max.
        const onHandMsi = widths.reduce((s, w) => s + (w.footage * 12 * w.width) / 1000, 0);
        const invMin = info?.invMsiMinimum ?? 0;
        const invMax = info?.invMsiMaximum ?? 0;
        // A stock with no open tickets is flagged "Without Tickets"; otherwise
        // its bar shows the worst computed status among its ticket lines.
        const hasTickets = (agg?.ticketCount ?? 0) > 0;
        const computedStatus = hasTickets ? stockLineStatus.get(stockId) ?? "In" : null;
        // Per-width availability rows (exact-width). Falls back to plain on-hand
        // widths for stocks with no open tickets (nothing to net).
        const widthRows: WidthRow[] =
          widthRowsByStock.get(stockId) ??
          widths.map((w) => ({
            width: w.width,
            pooled: false,
            onHandFootage: Math.round(w.footage),
            onHandRolls: w.rolls,
            onOrderFootage: 0,
            requiredFootage: 0,
            shortFootage: 0,
            status: "Without Tickets",
          }));
        return {
          stockId,
          // Real Label Traxx inactive flag. NOTE: fetchStockInfo returns ALL
          // stocks (it does not filter inactive), so this must come from the
          // column — no stock-master row at all also counts as inactive.
          // The Configuration tab hides these.
          inactive: info ? info.inactive : true,
          classification: info?.classification ?? null,
          // Config values: override from stock_goal, else Label Traxx.
          vendorName: goal?.vendorName ?? info?.supplierName ?? null,
          vendorNameSource: goal?.vendorName ? "override" : info?.supplierName ? "labeltraxx" : "none",
          vendorEmails: goal?.vendorEmails ?? null,
          msiCost: goal?.msiCost ?? (info && info.costMsi > 0 ? info.costMsi : null),
          msiCostSource: goal?.msiCost != null ? "override" : info && info.costMsi > 0 ? "labeltraxx" : "none",
          freightMsi: info?.freightMsi ?? 0,
          masterWidth: info?.masterWidth ?? 0,
          ltEstimatedDeliveryTime: info?.estimatedDeliveryTime ?? null,
          ltInvMsiMinimum: invMin,
          ltInvMsiMaximum: invMax,
          onHandMsi: Math.round(onHandMsi),
          computedStatus,
          withoutTickets: !hasTickets,
          belowMin: invMin > 0 && onHandMsi < invMin,
          aboveMax: invMax > 0 && onHandMsi > invMax,
          leadTimeDaysOverride: goal?.leadTimeDays ?? null,
          typicalRollFootageOverride: goal?.typicalRollFootage ?? null,
          orderQuantityRolls: goal?.orderQuantityRolls ?? null,
          discontinued: goal?.discontinued ?? false,
          demandFromStockId: goal?.demandFromStockId ?? null,
          alternateStockIds: goal?.alternateStockIds ?? null,
          openTicketFootage: agg ? Math.round(agg.requiredFootage) : 0,
          openTicketCount: agg?.ticketCount ?? 0,
          mfgSpecNum: info?.mfgSpecNum ?? null,
          faceStock: info?.faceStock ?? null,
          adhesive: info?.adhesive ?? null,
          faceColor: info?.faceColor ?? null,
          topCoat: info?.topCoat ?? null,
          areaToWeightFactor: info?.areaToWeightFactor ?? 0,
          // One row per width (union of on-hand / on-order / required widths),
          // each netted exact-width. `footage` = on-hand at that width (kept for
          // back-compat); onOrder/required/short/status are per width.
          widthsOnHand: widthRows.map((w) => ({
            width: w.width,
            pooled: w.pooled,
            footage: w.onHandFootage,
            rolls: w.onHandRolls,
            onOrderFootage: w.onOrderFootage,
            requiredFootage: w.requiredFootage,
            shortFootage: w.shortFootage,
            status: w.status,
          })),
          // Open POs for this stock, so the drill-down can show what's inbound
          // (requested vs promised delivery, buyer notes, ordered footage).
          openPos: (posListByStock.get(stockId) ?? [])
            .slice()
            .sort((a, b) =>
              (a.requestedDeliveryIso ?? a.dueDateIso ?? "9999").localeCompare(
                b.requestedDeliveryIso ?? b.dueDateIso ?? "9999",
              ),
            )
            .map((p) => {
              const agent = agentByLtPo.get(p.poNumber);
              const extLead = agent?.extendedLeadTimeDays ?? null;
              return {
                poNumber: p.poNumber,
                poDate: p.poDateIso,
                requestedDeliveryDate: p.requestedDeliveryIso,
                // LT's dueDate first; otherwise the date the agent captured
                // from the vendor's acknowledgement email.
                promisedDeliveryDate: p.dueDateIso ?? agent?.promisedDate ?? null,
                promisedFromAgent: p.dueDateIso == null && agent?.promisedDate != null,
                promisedDateDerived: p.dueDateIso == null && (agent?.promisedDateDerived ?? false),
                promisedDateBasis: p.dueDateIso == null ? (agent?.promisedDateBasis ?? null) : null,
                extendedLeadTime: extLead != null || agent?.extendedLeadTimeDays != null,
                extendedLeadTimeDays: extLead,
                supplierName: p.supplierName,
                masterWidth: p.masterWidth ?? 0,
                rolls: p.quantityRolls,
                totalFootage: p.orderedFootage,
                notes: [p.notes, agent?.notes].filter(Boolean).join("\n") || null,
                daysOpen: p.daysOpen,
              };
            }),
          tickets: (agg?.tickets ?? [])
            .sort((a, b) => (a.shipByDate ?? "9999").localeCompare(b.shipByDate ?? "9999"))
            .slice(0, 40)
            .map((t) => ({
              ticketNumber: t.ticketNumber,
              estFootage: Math.round(t.estFootage),
              grossFootage: Math.round(t.grossFootage),
              consumedFootage: Math.round(t.consumedFootage),
              requiredWidth: t.requiredWidth,
              stockIn: t.stockIn,
              computedStatus: t.computedStatus ?? "In",
              shipByDate: t.shipByDate,
              description: t.description,
            })),
        };
      })
      .sort((a, b) => a.stockId.localeCompare(b.stockId, undefined, { numeric: true }));

    res.json({ statusCounts, items, ltWriteEnabled: LT_WRITE_ENABLED });
  }),
);

/** Update purchasing config for a stock (stored as stock_goal overrides). */
router.put(
  "/demand/config/:stockId",
  asyncHandler(async (req, res) => {
    const stockId = String(req.params["stockId"]);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<StockGoalRow> = {};
    if ("vendorName" in b) patch.vendorName = b["vendorName"] == null ? null : String(b["vendorName"]);
    if ("vendorEmails" in b) patch.vendorEmails = b["vendorEmails"] == null ? null : String(b["vendorEmails"]);
    if ("msiCost" in b) patch.msiCost = b["msiCost"] == null ? null : Number(b["msiCost"]);
    if ("leadTimeDays" in b) patch.leadTimeDays = b["leadTimeDays"] == null ? null : Number(b["leadTimeDays"]);
    if ("typicalRollFootage" in b)
      patch.typicalRollFootage = b["typicalRollFootage"] == null ? null : Number(b["typicalRollFootage"]);
    if ("orderQuantityRolls" in b)
      patch.orderQuantityRolls = b["orderQuantityRolls"] == null ? null : Number(b["orderQuantityRolls"]);
    if ("discontinued" in b) patch.discontinued = b["discontinued"] === true;
    // Reorder point / max / variability / seasonality overrides. These were only
    // reachable from popovers on the Stock-by-stock plan; the MRP plan replaced
    // that table, so the config panel is now the single place they live and the
    // endpoint has to accept them.
    if ("reorderPointFootage" in b)
      patch.reorderPointFootage = b["reorderPointFootage"] == null ? null : Number(b["reorderPointFootage"]);
    if ("maxFootage" in b) patch.maxFootage = b["maxFootage"] == null ? null : Number(b["maxFootage"]);
    if ("demandCv" in b) patch.demandCv = b["demandCv"] == null ? null : Number(b["demandCv"]);
    if ("leadTimeCv" in b) patch.leadTimeCv = b["leadTimeCv"] == null ? null : Number(b["leadTimeCv"]);
    // The three quarterly seasonality weights move together or not at all — a
    // partial set would silently renormalize to something nobody chose.
    if ("seasonalityW1" in b || "seasonalityW2" in b || "seasonalityW3" in b) {
      const w = [b["seasonalityW1"], b["seasonalityW2"], b["seasonalityW3"]];
      if (w.every((v) => v == null)) {
        patch.seasonalityW1 = null;
        patch.seasonalityW2 = null;
        patch.seasonalityW3 = null;
      } else if (w.every((v) => v != null && Number.isFinite(Number(v)))) {
        patch.seasonalityW1 = Number(w[0]);
        patch.seasonalityW2 = Number(w[1]);
        patch.seasonalityW3 = Number(w[2]);
      } else {
        return void res
          .status(400)
          .json({ error: "Seasonality needs all three weights, or all three null to clear" });
      }
    }
    if ("demandFromStockId" in b) {
      const v = b["demandFromStockId"];
      patch.demandFromStockId = v == null || String(v).trim() === "" ? null : String(v).trim();
    }
    if ("alternateStockIds" in b) {
      // Accept "296, 297" or "#296 297" — store a clean comma-separated list.
      const raw = b["alternateStockIds"];
      const ids = String(raw ?? "")
        .split(/[,;\s]+/)
        .map((s) => s.trim().replace(/^#/, ""))
        .filter((s) => s.length > 0 && s !== stockId);
      patch.alternateStockIds = ids.length ? [...new Set(ids)].join(",") : null;
    }
    if (Object.keys(patch).length === 0) {
      return void res.status(400).json({ error: "No config fields in body" });
    }
    await db
      .insert(stockGoalTable)
      .values({ stockId, ...patch })
      .onConflictDoUpdate({ target: stockGoalTable.stockId, set: patch });

    // The LT Cloud API has no stock-update endpoint, so purchasing config
    // lives as dashboard overrides only (no write-back to Label Traxx).
    res.json({ stockId, saved: true, ltUpdated: false });
  }),
);

interface PoLineInput {
  stockId: string;
  description?: string | null;
  rolls: number;
  footage?: number | null;
  /** Master width to order (inches); null = the stock's own master width. */
  width?: number | null;
  msiCost?: number | null;
  estCost?: number | null;
}

/** ` (MFG Spec PTS9592-2)`, or nothing when the stock has no spec number. */
function specSuffix(mfgSpecNum?: string | null): string {
  const spec = mfgSpecNum?.trim();
  return spec ? ` (MFG Spec ${spec})` : "";
}

/**
 * MFG spec numbers for the stocks on a PO, straight from the Label Traxx stock
 * mirror. About a quarter of active stocks have no spec number, so callers must
 * treat a miss as normal rather than an error.
 */
async function mfgSpecsFor(stockIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(stockIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ stockId: ltStockTable.stockId, mfgSpecNum: ltStockTable.mfgSpecNum })
    .from(ltStockTable)
    .where(inArray(ltStockTable.stockId, ids));
  const out = new Map<string, string>();
  for (const r of rows) {
    const spec = r.mfgSpecNum?.trim();
    if (spec) out.set(r.stockId, spec);
  }
  return out;
}

function poEmail(po: {
  vendorName: string;
  vendorEmails: string | null;
  vendorCcEmails?: string | null;
  /** Label Traxx PO number(s) once assigned, so the vendor can quote them. */
  ltPoNumbers?: string | null;
  requestedDeliveryDate: string | null;
  lines: {
    stockId: string;
    description: string | null;
    rolls: number;
    footage: number | null;
    /** Master width to order (inches), so the vendor supplies the right slit. */
    width?: number | null;
    estCost: number | null;
    /** The vendor's own spec number for the material, when Label Traxx has one. */
    mfgSpecNum?: string | null;
  }[];
}): { to: string; cc: string; subject: string; body: string; html: string } {
  const lines = po.lines
    .map(
      (l) =>
        `  • Stock #${l.stockId}${l.description ? ` — ${l.description}` : ""}: ${l.rolls} roll${l.rolls === 1 ? "" : "s"}` +
        (l.width && l.width > 0 ? ` @ ${l.width}" wide` : "") +
        (l.footage ? ` (~${Math.round(l.footage).toLocaleString()} ft)` : ""),
    )
    .join("\n");
  const total = po.lines.reduce((sum, l) => sum + (l.estCost ?? 0), 0);
  const poRef = po.ltPoNumbers?.trim() ? ` ${po.ltPoNumbers.trim()}` : "";
  const body =
    `Hi All,\n\n` +
    `Please find our purchase order${poRef} below:\n\n${lines}\n\n` +
    (po.requestedDeliveryDate ? `Requested delivery: ${po.requestedDeliveryDate}\n` : "") +
    (total > 0 ? `Estimated total: $${total.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n` : "") +
    `\nShip to:\nCalyx Containers\n1991 Parkway Blvd\nWest Valley City, UT 84119\n\n` +
    `Please confirm receipt and expected ship date.\n\nThank you,\nCalyx Containers Supply Chain`;
  // HTML alternative for the Gmail send — same content, readable in a vendor's
  // inbox. The plain-text part above stays the fallback.
  const esc = (v: unknown) =>
    String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const itemRows = po.lines
    .map(
      (l) =>
        `<tr><td style="padding:6px 12px 6px 0">Stock #${esc(l.stockId)}` +
        `${l.mfgSpecNum?.trim() ? `<br><span style="color:#666;font-size:12px">MFG Spec ${esc(l.mfgSpecNum.trim())}</span>` : ""}</td>` +
        `<td style="padding:6px 12px 6px 0">${esc(l.description ?? "")}</td>` +
        `<td style="padding:6px 12px 6px 0;white-space:nowrap">${l.rolls} roll${l.rolls === 1 ? "" : "s"}${
          l.width && l.width > 0 ? ` @ ${esc(l.width)}&quot;` : ""
        }</td>` +
        `<td style="padding:6px 0;white-space:nowrap">${l.footage ? `~${Math.round(l.footage).toLocaleString("en-US")} ft` : ""}</td></tr>`,
    )
    .join("");
  const html =
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.5">` +
    `<p>Hi All,</p><p>Please find our purchase order${esc(poRef)} below${
      po.lines.length === 1 ? " and attached as a PDF" : ""
    }:</p>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px"><thead><tr style="text-align:left;color:#666;font-size:11px;text-transform:uppercase">` +
    `<th style="padding:0 12px 4px 0">Material</th><th style="padding:0 12px 4px 0">Description</th>` +
    `<th style="padding:0 12px 4px 0">Qty</th><th style="padding:0 0 4px">Footage</th></tr></thead>` +
    `<tbody>${itemRows}</tbody></table>` +
    (po.requestedDeliveryDate ? `<p><strong>Requested delivery:</strong> ${esc(po.requestedDeliveryDate)}</p>` : "") +
    `<p style="margin:16px 0 4px"><strong>Ship to</strong></p>` +
    `<p style="margin:0">Calyx Containers<br>1991 Parkway Blvd<br>West Valley City, UT 84119</p>` +
    `<p>Please confirm receipt and expected ship date.</p>` +
    `<p>Thank you,<br>Calyx Containers Supply Chain</p></div>`;
  return {
    to: parseEmails(po.vendorEmails).join(","),
    cc: parseEmails(po.vendorCcEmails ?? null).join(","),
    // POs are 1 material : 1 PO, so name the stock in the subject — with the MFG
    // spec number when we have one, since that's how the vendor identifies the
    // material on their end. Falls back to a list for a legacy multi-line draft.
    subject:
      `Calyx Containers PO${poRef} — ${po.vendorName} — ` +
      (po.lines.length === 1
        ? `Stock #${po.lines[0]!.stockId}${specSuffix(po.lines[0]!.mfgSpecNum)}`
        : po.lines.length <= 3
          ? po.lines.map((l) => `#${l.stockId}`).join(", ")
          : `${po.lines.length} items`),
    body,
    html,
  };
}

/**
 * PO addresses for a vendor. Vendor-level `vendor_contact` is authoritative; the
 * legacy per-stock `stock_goal.vendorEmails` is only a To-fallback so anything
 * entered before this existed keeps working.
 */
async function vendorEmailsFor(
  vendorName: string,
  legacyTo?: string | null,
): Promise<{ to: string | null; cc: string | null }> {
  const [row] = await db
    .select()
    .from(vendorContactTable)
    .where(eq(vendorContactTable.vendorName, vendorName))
    .limit(1);
  return {
    to: row?.toEmails?.trim() || legacyTo?.trim() || null,
    cc: row?.ccEmails?.trim() || null,
  };
}

router.get(
  "/demand/pos",
  asyncHandler(async (_req, res) => {
    const [pos, lines, vendorContacts] = await Promise.all([
      db.select().from(materialPoTable),
      db.select().from(materialPoLineTable),
      db.select().from(vendorContactTable),
    ]);
    const contactByVendor = new Map(vendorContacts.map((c) => [c.vendorName, c]));
    const linesByPo = new Map<string, typeof lines>();
    for (const l of lines) {
      const arr = linesByPo.get(l.poId) ?? [];
      arr.push(l);
      linesByPo.set(l.poId, arr);
    }
    // Receipt tracking: for POs linked to Label Traxx PO numbers, read the
    // Received date live from LT and derive the actual lead time.
    const allLtNumbers = pos.flatMap((po) => (po.ltPoNumbers ?? "").split(",").filter(Boolean));
    let receipts = new Map<string, { received: string | null; poDate: string | null }>();
    try {
      receipts = await fetchPoReceipts(allLtNumbers);
    } catch {
      // gateway hiccup — show POs without receipt info rather than failing
    }
    const items = pos
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((po) => {
        const nums = (po.ltPoNumbers ?? "").split(",").map((n) => n.trim()).filter(Boolean);
        const recs = nums.map((n) => receipts.get(n)).filter(Boolean) as {
          received: string | null;
          poDate: string | null;
        }[];
        const receivedDates = recs.map((r) => r.received).filter(Boolean) as string[];
        const receivedOn =
          nums.length > 0 && receivedDates.length === nums.length
            ? receivedDates.sort().slice(-1)[0]!
            : null;
        const poDate = recs.map((r) => r.poDate).filter(Boolean).sort()[0] ?? po.createdAt.toISOString().slice(0, 10);
        const actualLeadDays = receivedOn
          ? Math.round((Date.parse(receivedOn) - Date.parse(poDate)) / 86_400_000)
          : null;
        const vc = contactByVendor.get(po.vendorName);
        return {
          id: po.id,
          vendorName: po.vendorName,
          // Vendor-level contacts win; the PO's own snapshot is the fallback.
          vendorEmails: vc?.toEmails ?? po.vendorEmails,
          vendorCcEmails: vc?.ccEmails ?? null,
          status: receivedOn ? "received" : po.status,
          kind: po.kind,
          releaseFromPoNumbers: po.releaseFromPoNumbers,
          ltPoNumbers: po.ltPoNumbers,
          requestedDeliveryDate: po.requestedDeliveryDate,
          createdAt: po.createdAt.toISOString(),
          receivedOn,
          actualLeadDays,
          emailedAt: po.emailedAt?.toISOString() ?? null,
          emailedTo: po.emailedTo,
          agentState: po.agentState,
          promisedDate: po.promisedDate,
          promisedDateDerived: po.promisedDateDerived,
          promisedDateBasis: po.promisedDateBasis,
          needsAttention: po.needsAttention,
          attentionReason: po.attentionReason,
          lines: (linesByPo.get(po.id) ?? []).map((l) => ({
            stockId: l.stockId,
            description: l.description,
            rolls: l.rolls,
            footage: l.footage,
            width: l.width,
            msiCost: l.msiCost,
            estCost: l.estCost,
            extendedLeadTime: l.extendedLeadTime,
            extendedLeadTimeDays: l.extendedLeadTimeDays,
          })),
        };
      });
    res.json({ items, ltWriteEnabled: LT_WRITE_ENABLED });
  }),
);

router.post(
  "/demand/pos",
  asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as {
      vendorName?: string;
      vendorEmails?: string | null;
      requestedDeliveryDate?: string | null;
      notes?: string | null;
      lines?: PoLineInput[];
    };
    const vendorName = (b.vendorName ?? "").trim();
    const lines = (b.lines ?? []).filter((l) => l && l.stockId && Number(l.rolls) > 0);
    if (!vendorName || lines.length === 0) {
      return void res.status(400).json({ error: "vendorName and at least one line with rolls > 0 required" });
    }
    const [po] = await db
      .insert(materialPoTable)
      .values({
        vendorName,
        vendorEmails: b.vendorEmails ?? null,
        requestedDeliveryDate: b.requestedDeliveryDate ?? null,
        notes: b.notes ?? null,
        status: "draft",
      })
      .returning();
    const lineValues = lines.map((l) => ({
      poId: po!.id,
      stockId: String(l.stockId),
      description: l.description ?? null,
      rolls: Math.round(Number(l.rolls)),
      footage: l.footage == null ? null : Number(l.footage),
      width: l.width == null || Number(l.width) <= 0 ? null : Number(l.width),
      msiCost: l.msiCost == null ? null : Number(l.msiCost),
      estCost: l.estCost == null ? null : Number(l.estCost),
    }));
    await db.insert(materialPoLineTable).values(lineValues);
    const contacts = await vendorEmailsFor(vendorName, b.vendorEmails ?? null);
    const specs = await mfgSpecsFor(lineValues.map((l) => l.stockId));
    const email = poEmail({
      vendorName,
      vendorEmails: contacts.to,
      vendorCcEmails: contacts.cc,
      requestedDeliveryDate: b.requestedDeliveryDate ?? null,
      lines: lineValues.map((l) => ({ ...l, mfgSpecNum: specs.get(l.stockId) ?? null })),
    });
    res.json({ id: po!.id, status: "draft", email });
  }),
);

/**
 * Time-phased purchase plan, per stock AND per width — replaces the
 * Stock-by-stock plan, whose reorder point and max were stock-level.
 */
router.get(
  "/demand/mrp",
  asyncHandler(async (req, res) => {
    const monthsBack = parseInt32(req.query["monthsBack"], 6);
    const weeks = Math.min(26, Math.max(4, parseInt32(req.query["weeks"], 13)));
    const { buildMrp } = await import("../lib/mrp");
    res.json(await buildMrp({ monthsBack, weeks }));
  }),
);

/**
 * Weekday digest — preview the exact HTML that goes out, or send a sample.
 *
 * The sample always goes to the signed-in user, never to the configured
 * recipient list: a preview must not be able to mail the team.
 */
router.get(
  "/demand/digest/preview",
  asyncHandler(async (_req, res) => {
    const { buildDigest, renderDigestHtml, renderDigestText, digestSubject, digestRecipients } = await import(
      "../lib/daily-digest"
    );
    const { appBaseUrl } = await import("../lib/gmail");
    const digest = await buildDigest();
    res.json({
      subject: digestSubject(digest),
      html: renderDigestHtml(digest, appBaseUrl()),
      text: renderDigestText(digest),
      recipients: digestRecipients(),
      stocks: digest.stocks.length,
      pos: digest.pos.length,
      totals: digest.totals,
      pastDueCount: digest.pastDueCount,
    });
  }),
);

router.post(
  "/demand/digest/send-sample",
  asyncHandler(async (req, res) => {
    const to = chatUserEmail(req);
    if (!to) return void res.status(401).json({ error: "Not signed in" });
    const { sendDigest } = await import("../lib/daily-digest");
    const out = await sendDigest({ to: [to], subjectPrefix: "[SAMPLE] " });
    if (!out.sent) return void res.status(409).json({ error: out.skipped ?? "Could not send" });
    res.json(out);
  }),
);

/**
 * Request a make-and-hold release: ask the vendor to ship material they've
 * already made and are holding.
 *
 * Created as a draft material_po with kind "mah_release" so it runs the same
 * email → send → agent-follow-up path as a PO (we need the same things back:
 * confirmation, ship date, tracking). It is NOT submittable to Label Traxx —
 * the material is already on the make-and-hold PO.
 */
router.post(
  "/demand/mah-release",
  asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as {
      stockId?: string;
      requestedDeliveryDate?: string | null;
      notes?: string | null;
      widths?: { width?: number; label?: string; releaseFootage?: number }[];
    };
    const stockId = String(b.stockId ?? "").trim();
    if (!stockId) return void res.status(400).json({ error: "stockId required" });
    const needs = (b.widths ?? [])
      .map((w) => ({
        width: Number(w.width) || 0,
        label: String(w.label ?? ""),
        releaseFootage: Number(w.releaseFootage) || 0,
        heldFootage: 0, // resolved server-side from the vendor feed
      }))
      .filter((w) => w.releaseFootage > 0);
    if (needs.length === 0) return void res.status(400).json({ error: "at least one width with releaseFootage > 0 required" });

    const { planMahRelease, mahReleaseEmail, addBusinessDaysIso, RELEASE_LEAD_BUSINESS_DAYS } = await import(
      "../lib/mah-release"
    );
    const plan = await planMahRelease(stockId, needs);
    if (plan.blockedReason) return void res.status(400).json({ error: plan.blockedReason });

    // Held stock delivers in ~5 business days; that's the ask unless overridden.
    const requestedDeliveryDate =
      b.requestedDeliveryDate ??
      addBusinessDaysIso(new Date().toISOString().slice(0, 10), RELEASE_LEAD_BUSINESS_DAYS);
    const [po] = await db
      .insert(materialPoTable)
      .values({
        vendorName: plan.vendorName,
        vendorEmails: plan.vendorEmails,
        kind: "mah_release",
        releaseFromPoNumbers: plan.fromPoNumbers.join(", ") || null,
        requestedDeliveryDate,
        notes: b.notes ?? null,
        status: "draft",
      })
      .returning();
    const lineValues = plan.lines.map((l) => ({
      poId: po!.id,
      stockId: l.stockId,
      description: l.description,
      rolls: l.rolls,
      footage: l.footage,
      width: l.width > 0 ? l.width : null,
      // A release has no price of its own — the material was costed on the
      // make-and-hold PO, so leaving these null keeps it out of spend math.
      msiCost: null,
      estCost: null,
    }));
    await db.insert(materialPoLineTable).values(lineValues);
    const { appendPoEvent } = await import("../lib/po-agent");
    await appendPoEvent(po!.id, {
      direction: "system",
      kind: "note",
      summary:
        `Release requested for #${stockId}: ${plan.totalRolls} roll${plan.totalRolls === 1 ? "" : "s"} ` +
        `(${Math.round(plan.totalFootage).toLocaleString()} ft) in ${plan.rollFootage.toLocaleString()} ft rolls` +
        (plan.fromPoNumbers.length ? ` from ${plan.fromPoNumbers.join(", ")}` : "") +
        (plan.rollFootageConfigured ? "" : ` — no roll size configured for this stock, used ${plan.rollFootage.toLocaleString()} ft`),
    });

    const contacts = await vendorEmailsFor(plan.vendorName, plan.vendorEmails);
    const specs = await mfgSpecsFor(lineValues.map((l) => l.stockId));
    const email = mahReleaseEmail({
      vendorName: plan.vendorName,
      vendorEmails: contacts.to,
      vendorCcEmails: contacts.cc,
      requestedDeliveryDate,
      fromPoNumbers: plan.fromPoNumbers,
      lines: plan.lines.map((l) => ({ ...l, mfgSpecNum: specs.get(l.stockId) ?? null })),
    });
    res.json({
      id: po!.id,
      status: "draft",
      kind: "mah_release",
      vendorName: plan.vendorName,
      rollFootage: plan.rollFootage,
      rollFootageConfigured: plan.rollFootageConfigured,
      totalRolls: plan.totalRolls,
      totalFootage: plan.totalFootage,
      fromPoNumbers: plan.fromPoNumbers,
      lines: plan.lines,
      email,
    });
  }),
);

/**
 * Assemble the full data for a print-ready PO document in the Label Traxx PO
 * format (single material). Supplier address comes live from the LT API;
 * material spec from the lt_stock mirror.
 */
router.get(
  "/demand/pos/:id/document",
  asyncHandler(async (req, res) => {
    try {
      res.json(await assemblePoDocument(String(req.params["id"])));
    } catch (e) {
      if (e instanceof PoDocumentError) return void res.status(e.status).json({ error: e.message });
      throw e;
    }
  }),
);

/** The same document as a PDF — what gets attached to the vendor email. */
router.get(
  "/demand/pos/:id/pdf",
  asyncHandler(async (req, res) => {
    try {
      const doc = await assemblePoDocument(String(req.params["id"]));
      const { renderPoPdf, poPdfFilename } = await import("../lib/po-pdf");
      const pdf = await renderPoPdf(doc);
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", `inline; filename="${poPdfFilename(doc)}"`);
      res.send(pdf);
    } catch (e) {
      if (e instanceof PoDocumentError) return void res.status(e.status).json({ error: e.message });
      throw e;
    }
  }),
);

/** Attach manually-entered Label Traxx PO number(s) to a PO record. */
router.put(
  "/demand/pos/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params["id"]);
    const b = (req.body ?? {}) as { ltPoNumbers?: string | null };
    if (!("ltPoNumbers" in b)) return void res.status(400).json({ error: "ltPoNumbers required" });
    const [po] = await db.select().from(materialPoTable).where(eq(materialPoTable.id, id)).limit(1);
    if (!po) return void res.status(404).json({ error: "PO not found" });
    await db
      .update(materialPoTable)
      .set({ ltPoNumbers: b.ltPoNumbers?.trim() || null, updatedAt: new Date() })
      .where(eq(materialPoTable.id, id));
    res.json({ id, saved: true });
  }),
);

/**
 * Vendor PO contacts. Lists every vendor currently in use (stock_goal override,
 * else the LT supplier) joined to its saved To/CC addresses, so the Configuration
 * tab can show all vendors — including ones with nothing entered yet.
 */
router.get(
  "/demand/vendor-contacts",
  asyncHandler(async (_req, res) => {
    const [stockInfo, goalRows, contacts] = await Promise.all([
      fetchStockInfo(),
      db.select().from(stockGoalTable),
      db.select().from(vendorContactTable),
    ]);
    const goalByStock = new Map(goalRows.map((g) => [g.stockId, g]));
    // Effective vendor per active stock, with the materials each one supplies.
    const stocksByVendor = new Map<string, string[]>();
    const legacyByVendor = new Map<string, string>();
    for (const [stockId, info] of stockInfo) {
      if (info.inactive) continue;
      const goal = goalByStock.get(stockId);
      const vendor = (goal?.vendorName ?? info.supplierName ?? "").trim();
      if (!vendor) continue;
      const arr = stocksByVendor.get(vendor) ?? [];
      arr.push(stockId);
      stocksByVendor.set(vendor, arr);
      // Carry any address entered on the old per-stock field as a starting point.
      const legacy = goal?.vendorEmails?.trim();
      if (legacy && !legacyByVendor.has(vendor)) legacyByVendor.set(vendor, legacy);
    }
    const byVendor = new Map(contacts.map((c) => [c.vendorName, c]));
    const items = [...stocksByVendor.entries()]
      .map(([vendorName, stockIds]) => {
        const c = byVendor.get(vendorName);
        return {
          vendorName,
          toEmails: c?.toEmails ?? null,
          ccEmails: c?.ccEmails ?? null,
          agentEnabled: c?.agentEnabled ?? false,
          legacyStockEmails: legacyByVendor.get(vendorName) ?? null,
          stockCount: stockIds.length,
          stockIds: stockIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 12),
        };
      })
      .sort((a, b) => a.vendorName.localeCompare(b.vendorName));
    res.json({ items });
  }),
);

/** Save a vendor's To/CC PO addresses (blank clears). */
// Vendor name travels in the BODY, not the path — names like
// "Derprosa/Taghleef" contain a slash, which a path segment can't carry
// reliably (Express saw a different route and 404'd).
router.put(
  "/demand/vendor-contacts/save",
  asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as {
      vendorName?: string;
      toEmails?: string | null;
      ccEmails?: string | null;
      agentEnabled?: boolean;
    };
    const vendorName = String(b.vendorName ?? "").trim();
    if (!vendorName) return void res.status(400).json({ error: "vendorName required" });
    // Keep only well-formed addresses so a stray word can't end up as a recipient.
    const clean = (raw: string | null | undefined): string | null => {
      const list = parseEmails(raw ?? null);
      return list.length ? list.join(", ") : null;
    };
    const toEmails = clean(b.toEmails);
    const ccEmails = clean(b.ccEmails);
    const agentEnabled = Boolean(b.agentEnabled);
    await db
      .insert(vendorContactTable)
      .values({ vendorName, toEmails, ccEmails, agentEnabled })
      .onConflictDoUpdate({
        target: vendorContactTable.vendorName,
        set: { toEmails, ccEmails, agentEnabled, updatedAt: new Date() },
      });
    res.json({ vendorName, toEmails, ccEmails, agentEnabled, saved: true });
  }),
);

/**
 * Pull an assigned PO number out of the (undocumented) create response, which
 * may be a bare number/string or an object under any of several key names.
 */
function extractPoNumber(created: unknown): string | null {
  if (created == null) return null;
  if (typeof created === "number" && Number.isFinite(created)) return String(created);
  if (typeof created === "string") {
    const t = created.trim();
    return /^\d+$/.test(t) ? t : null;
  }
  if (typeof created === "object") {
    const o = created as Record<string, unknown>;
    for (const key of ["poNumber", "number", "poNo", "purchaseOrderNumber", "id"]) {
      const v = o[key];
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
      if (typeof v === "string" && /^\d+$/.test(v.trim())) return v.trim();
    }
  }
  return null;
}

/**
 * Locate a just-created LT PO by the marker our note embeds (the draft id), for
 * when the create response carries no usable number. Scans recently-changed POs
 * newest-first so it stays a handful of calls.
 */
async function findLtPoByMarker(marker: string): Promise<string | null> {
  try {
    const { ltGet, ltGetAllPages } = await import("../lib/ltApi");
    const since = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    const list = await ltGetAllPages<{ number?: string }>("/purchase-orders", {
      ChangedSinceDate: since,
    });
    const numbers = list
      .map((p) => p.number)
      .filter((n): n is string => Boolean(n))
      .sort((a, b) => Number(b.replace(/\D/g, "")) - Number(a.replace(/\D/g, "")))
      .slice(0, 30);
    for (const n of numbers) {
      const d = await ltGet<unknown>("/purchase-order-details", { PONumber: n });
      const o = (Array.isArray(d) ? d[0] : d) as Record<string, unknown> | undefined;
      if (String(o?.["notes"] ?? "").includes(marker)) return n;
    }
  } catch (err) {
    logger.warn({ err, marker }, "could not locate the created LT PO by note marker");
  }
  return null;
}

/**
 * Delete a draft PO that never got sent (lines cascade).
 *
 * Only `draft` status is deletable: once a PO is submitted — especially to Label
 * Traxx, where a real purchaseorder now exists — removing our record would hide
 * an order that still exists upstream. Those must be voided in LT instead.
 */
router.delete(
  "/demand/pos/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params["id"]);
    const [po] = await db.select().from(materialPoTable).where(eq(materialPoTable.id, id)).limit(1);
    if (!po) return void res.status(404).json({ error: "PO not found" });
    if (po.status !== "draft") {
      return void res.status(409).json({
        error:
          po.ltPoNumbers
            ? `Already submitted to Label Traxx as PO ${po.ltPoNumbers}. Void it in Label Traxx instead of deleting the record.`
            : "Only unsent drafts can be deleted — this PO has already been submitted.",
        status: po.status,
        ltPoNumbers: po.ltPoNumbers ?? null,
      });
    }
    await db.delete(materialPoLineTable).where(eq(materialPoLineTable.poId, id));
    await db.delete(materialPoTable).where(eq(materialPoTable.id, id));
    res.json({ id, deleted: true });
  }),
);

/**
 * Submit a PO: marks it submitted here and (when LT writes are enabled)
 * creates one Label Traxx purchaseorder row per line through the gateway.
 */
router.post(
  "/demand/pos/:id/submit",
  asyncHandler(async (req, res) => {
    const id = String(req.params["id"]);
    const [po] = await db.select().from(materialPoTable).where(eq(materialPoTable.id, id)).limit(1);
    if (!po) return void res.status(404).json({ error: "PO not found" });
    // A make-and-hold release is a call-in against material that's already on
    // an existing LT PO. Creating a second PO for it would double the on-order
    // position and bill us twice.
    if (po.kind === "mah_release") {
      return void res.status(400).json({
        error:
          "This is a make-and-hold release, not a new order — the material is already on " +
          (po.releaseFromPoNumbers ?? "an existing PO") + ". Email it to the vendor instead of submitting to Label Traxx.",
      });
    }
    const lines = await db.select().from(materialPoLineTable).where(eq(materialPoLineTable.poId, id));

    let ltPoNumbers: string[] = [];
    let ltCreated = 0;
    let ltError: string | null = null;
    const { ltApiConfigured, ltPost } = await import("../lib/ltApi");
    const ltEnabled = ltApiConfigured();
    // When LT writes are enabled the PO is only "submitted" once Label Traxx has
    // actually created it. A failed write must leave the record as-is (draft) so
    // Submit stays retryable and Delete still works — previously a rejected write
    // still flipped the status to "submitted", stranding it in both directions.
    let status = ltEnabled ? po.status : "submitted";
    if (ltEnabled) {
      // Official LT Cloud API: POST /stock-purchase-order-create goes through
      // Label Traxx's own app layer (PO numbering, supplier, costing). One PO
      // per line; slittingSpec carries one row per master roll at the stock's
      // master width (mirrors LT's own stock-PO form).
      const stockInfo = await fetchStockInfo();
      const today = new Date().toISOString().slice(0, 10);
      const dateReq = po.requestedDeliveryDate ?? today;
      // LT requires a signer ("'Signer Assoc Num' must not be empty"), so be
      // forgiving about how the env var was entered: accept "87", " 87 ", or a
      // whole line pasted into the value field ("LT_PO_SIGNER=87").
      const signerRaw = (process.env["LT_PO_SIGNER"] ?? "").trim();
      const signerDigits = signerRaw.match(/\d+/)?.[0];
      const poSigner = signerDigits ? Number(signerDigits) : undefined;
      if (signerRaw && signerRaw !== String(poSigner)) {
        logger.warn(
          { signerRaw, parsed: poSigner },
          "LT_PO_SIGNER was not a bare number — parsed the digits out; consider cleaning up the env value",
        );
      }
      if (poSigner === undefined) {
        logger.warn("LT_PO_SIGNER is not set — Label Traxx will reject the PO (signer is required)");
      }
      try {
        for (const l of lines) {
          const info = stockInfo.get(l.stockId);
          const footagePerRoll =
            l.footage != null && l.rolls > 0 ? Math.round(l.footage / l.rolls) : 0;
          const rollCount = Math.min(Math.max(1, l.rolls), 200);
          // The draft's own notes ride along, so anything the buyer typed (e.g.
          // "TEST — please void") is visible on the PO inside Label Traxx rather
          // than only in this dashboard.
          const ltNotes = [
            po.notes?.trim() || null,
            `Created by Supply Chain Dashboard (PO ${po.id.slice(0, 8)})`,
          ]
            .filter(Boolean)
            .join(" — ");
          const body: Record<string, unknown> = {
            stockNo: l.stockId,
            poDate: today,
            requestedDelivery: dateReq,
            notes: ltNotes,
            slittingSpec: Array.from({ length: rollCount }, () => ({
              ordered: footagePerRoll,
              exact: true,
              no1: 1,
              // Order at the width the demand requires; the stock's master
              // width only when the line doesn't specify one.
              cut1: l.width && l.width > 0 ? l.width : (info?.masterWidth ?? 0),
            })),
          };
          if (poSigner !== undefined) body["poSigner"] = poSigner;
          const created = await ltPost<unknown>("/stock-purchase-order-create", body);
          ltCreated += 1; // the POST succeeded — a PO now exists in LT
          let assigned = extractPoNumber(created);
          if (!assigned) {
            // The create response shape isn't documented and has returned no
            // usable number, which once left a real LT PO (2597) unrecorded here
            // and invited a duplicate on retry. Our note embeds the draft id, so
            // find the PO by that marker instead of guessing the payload shape.
            assigned = await findLtPoByMarker(`(PO ${po.id.slice(0, 8)})`);
          }
          if (assigned) ltPoNumbers.push(String(assigned));
        }
        // If LT created anything, never fall back to "draft" — that would offer a
        // Submit retry and duplicate the PO. Unknown numbers get linked by hand.
        status = ltCreated > 0 ? "submitted_lt" : po.status;
      } catch (e) {
        ltError = e instanceof Error ? e.message : String(e);
        status = po.status; // stay draft; the caller sees ltError and can retry
      }
    }

    await db
      .update(materialPoTable)
      .set({ status, ltPoNumbers: ltPoNumbers.length ? ltPoNumbers.join(",") : null, updatedAt: new Date() })
      .where(eq(materialPoTable.id, id));

    const submitContacts = await vendorEmailsFor(po.vendorName, po.vendorEmails);
    const submitSpecs = await mfgSpecsFor(lines.map((l) => l.stockId));
    const email = poEmail({
      vendorName: po.vendorName,
      vendorEmails: submitContacts.to,
      vendorCcEmails: submitContacts.cc,
      ltPoNumbers: ltPoNumbers.length ? ltPoNumbers.join(", ") : po.ltPoNumbers,
      requestedDeliveryDate: po.requestedDeliveryDate,
      lines: lines.map((l) => ({
        stockId: l.stockId,
        description: l.description,
        rolls: l.rolls,
        footage: l.footage,
        width: l.width,
        estCost: l.estCost,
        mfgSpecNum: submitSpecs.get(l.stockId) ?? null,
      })),
    });
    res.json({ id, status, ltPoNumbers, ltWriteEnabled: true, ltError, email });
  }),
);

/**
 * Everything the send-confirmation dialog needs: resolved recipients, the exact
 * subject/body that will go out, and the attachment name. Read-only — nothing is
 * sent until the buyer confirms.
 */
async function poMailPayload(id: string) {
  const [po] = await db.select().from(materialPoTable).where(eq(materialPoTable.id, id)).limit(1);
  if (!po) throw new PoDocumentError("PO not found", 404);
  const lines = await db.select().from(materialPoLineTable).where(eq(materialPoLineTable.poId, id));
  if (lines.length === 0) throw new PoDocumentError("PO has no line", 400);
  const [contacts, specs] = await Promise.all([
    vendorEmailsFor(po.vendorName, po.vendorEmails),
    mfgSpecsFor(lines.map((l) => l.stockId)),
  ]);
  // A make-and-hold release is a different ask — ship what you're already
  // holding on your PO — so it gets its own template, no pricing and no PO PDF.
  if (po.kind === "mah_release") {
    const { mahReleaseEmail } = await import("../lib/mah-release");
    const email = mahReleaseEmail({
      vendorName: po.vendorName,
      vendorEmails: contacts.to,
      vendorCcEmails: contacts.cc,
      requestedDeliveryDate: po.requestedDeliveryDate,
      fromPoNumbers: (po.releaseFromPoNumbers ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      lines: lines.map((l) => ({
        stockId: l.stockId,
        description: l.description,
        width: l.width,
        rolls: l.rolls,
        footage: l.footage,
        mfgSpecNum: specs.get(l.stockId) ?? null,
      })),
    });
    return { po, email };
  }
  const email = poEmail({
    vendorName: po.vendorName,
    vendorEmails: contacts.to,
    vendorCcEmails: contacts.cc,
    ltPoNumbers: po.ltPoNumbers,
    requestedDeliveryDate: po.requestedDeliveryDate,
    lines: lines.map((l) => ({
      stockId: l.stockId,
      description: l.description,
      rolls: l.rolls,
      footage: l.footage,
      width: l.width,
      estCost: l.estCost,
      mfgSpecNum: specs.get(l.stockId) ?? null,
    })),
  });
  return { po, email };
}

/**
 * A release carries no PO document — the material was ordered on the
 * make-and-hold PO, so there's nothing to attach and a DRAFT-stamped PDF would
 * only confuse the vendor.
 */
function attachesPoPdf(po: { kind: string }): boolean {
  return po.kind !== "mah_release";
}

router.get(
  "/demand/pos/:id/email-preview",
  asyncHandler(async (req, res) => {
    try {
      const id = String(req.params["id"]);
      const [{ po, email }, gmail] = await Promise.all([
        poMailPayload(id),
        import("../lib/gmail").then(async (g) => ({
          configured: g.gmailConfigured(),
          connection: g.gmailConfigured() ? await g.gmailConnection() : null,
        })),
      ]);
      // Releases have no PO document, and assembling one would fail anyway
      // (no LT PO number, no pricing).
      const doc = attachesPoPdf(po) ? await assemblePoDocument(id) : null;
      const { poPdfFilename } = await import("../lib/po-pdf");
      res.json({
        to: parseEmails(email.to),
        cc: parseEmails(email.cc),
        subject: email.subject,
        body: email.body,
        attachmentName: doc ? poPdfFilename(doc) : null,
        kind: po.kind,
        releaseFromPoNumbers: po.releaseFromPoNumbers,
        /** The PDF says DRAFT until the PO exists in Label Traxx — worth a warning. */
        isDraft: doc?.isDraft ?? false,
        emailedAt: po.emailedAt?.toISOString() ?? null,
        emailedTo: po.emailedTo,
        gmailConfigured: gmail.configured,
        gmailAccount: gmail.connection?.accountEmail ?? null,
      });
    } catch (e) {
      if (e instanceof PoDocumentError) return void res.status(e.status).json({ error: e.message });
      throw e;
    }
  }),
);

/**
 * Send the PO to the connected mailbox instead of the vendor — a dry run to see
 * exactly what a vendor would receive, attachment included.
 *
 * The recipient is deliberately not a parameter: it's always the connected
 * account, so a test can never misfire to a vendor. It also leaves emailedAt
 * alone, because nothing was sent to the vendor.
 */
router.post(
  "/demand/pos/:id/send-test",
  asyncHandler(async (req, res) => {
    const id = String(req.params["id"]);
    try {
      const gmail = await import("../lib/gmail");
      if (!gmail.gmailConfigured()) {
        return void res.status(409).json({
          error: "Gmail is not set up on this deployment — GOOGLE_OAUTH_CLIENT_ID/SECRET are missing.",
        });
      }
      const connection = await gmail.gmailConnection();
      if (!connection) {
        return void res
          .status(409)
          .json({ error: "Gmail is not connected — connect it in Demand Planning → Configuration." });
      }
      if (!connection.accountEmail) {
        return void res
          .status(409)
          .json({ error: "The connected mailbox address is unknown — reconnect Gmail to capture it." });
      }

      const { po, email } = await poMailPayload(id);
      const realTo = parseEmails(email.to);
      const realCc = parseEmails(email.cc);
      const doc = attachesPoPdf(po) ? await assemblePoDocument(id) : null;
      const { renderPoPdf, poPdfFilename } = await import("../lib/po-pdf");
      const pdf = doc ? await renderPoPdf(doc) : null;

      // Make it unmistakable that this is a test, in case it ever gets forwarded.
      const banner =
        `[TEST — this copy went only to you, not to ${po.vendorName}]\n` +
        `A real send would go to: ${realTo.join(", ") || "(no To address set)"}` +
        (realCc.length ? `\nand CC: ${realCc.join(", ")}` : "") +
        `\n\n----------------------------------------\n\n`;

      const sent = await gmail.sendMail({
        to: [connection.accountEmail],
        subject: `[TEST] ${email.subject}`,
        text: banner + email.body,
        html:
          `<div style="font-family:Helvetica,Arial,sans-serif;font-size:13px;background:#fff8e1;border:1px solid #ffe082;` +
          `padding:10px 12px;margin-bottom:16px;border-radius:4px">` +
          `<strong>TEST — this copy went only to you, not to ${po.vendorName}.</strong><br>` +
          `A real send would go to: ${realTo.join(", ") || "(no To address set)"}` +
          (realCc.length ? `<br>and CC: ${realCc.join(", ")}` : "") +
          `</div>` +
          email.html,
        attachments:
          doc && pdf ? [{ filename: poPdfFilename(doc), mimeType: "application/pdf", content: pdf }] : [],
      });

      logger.info({ poId: id, to: connection.accountEmail, messageId: sent.id }, "Test PO email sent to self");
      res.json({
        sent: true,
        test: true,
        to: [connection.accountEmail],
        cc: [],
        subject: `[TEST] ${email.subject}`,
        attachmentName: doc ? poPdfFilename(doc) : null,
        messageId: sent.id,
        threadId: sent.threadId,
      });
    } catch (e) {
      if (e instanceof PoDocumentError) return void res.status(e.status).json({ error: e.message });
      const message = e instanceof Error ? e.message : String(e);
      logger.error({ poId: id, err: message }, "Test PO send failed");
      res.status(502).json({ error: message });
    }
  }),
);

/**
 * Email the PO to the vendor through Gmail, with the PO PDF attached. Sends as
 * the connected mailbox, so it lands in that account's Sent folder and vendor
 * replies come straight back. Only ever called from an explicit confirmation.
 */
router.post(
  "/demand/pos/:id/send",
  asyncHandler(async (req, res) => {
    const id = String(req.params["id"]);
    try {
      const gmail = await import("../lib/gmail");
      if (!gmail.gmailConfigured()) {
        return void res.status(409).json({
          error: "Gmail is not set up on this deployment — GOOGLE_OAUTH_CLIENT_ID/SECRET are missing.",
        });
      }
      const connection = await gmail.gmailConnection();
      if (!connection) {
        return void res
          .status(409)
          .json({ error: "Gmail is not connected — connect it in Demand Planning → Configuration." });
      }

      const { po, email } = await poMailPayload(id);
      const to = parseEmails(email.to);
      const cc = parseEmails(email.cc);
      if (to.length === 0) {
        return void res.status(400).json({
          error: `No To address for ${po.vendorName} — add one under Configuration → Vendor PO contacts.`,
        });
      }

      const doc = attachesPoPdf(po) ? await assemblePoDocument(id) : null;
      const { renderPoPdf, poPdfFilename } = await import("../lib/po-pdf");
      const pdf = doc ? await renderPoPdf(doc) : null;

      const sent = await gmail.sendMail({
        to,
        cc,
        subject: email.subject,
        text: email.body,
        html: email.html,
        attachments:
          doc && pdf ? [{ filename: poPdfFilename(doc), mimeType: "application/pdf", content: pdf }] : [],
      });

      const emailedAt = new Date();
      // Start (or reset) agent tracking when the vendor is opted in — a re-send
      // means we're waiting on an acknowledgement again.
      const [vc] = await db
        .select()
        .from(vendorContactTable)
        .where(eq(vendorContactTable.vendorName, po.vendorName))
        .limit(1);
      const agentTracking = Boolean(vc?.agentEnabled);
      await db
        .update(materialPoTable)
        .set({
          emailedAt,
          emailedTo: [...to, ...cc].join(", "),
          gmailThreadId: sent.threadId || po.gmailThreadId,
          ...(agentTracking ? { agentState: "awaiting_ack", needsAttention: false, attentionReason: null } : {}),
          updatedAt: emailedAt,
        })
        .where(eq(materialPoTable.id, id));
      // Timeline: record the send with its RFC 822 Message-ID so later
      // follow-ups can reference it. Reading the sent message needs the
      // readonly scope — tolerate its absence.
      try {
        const { appendPoEvent } = await import("../lib/po-agent");
        let rfc822: string | null = null;
        if (gmail.scopeSupportsRead(connection.scope)) {
          rfc822 = gmail.header(await gmail.fetchMessage(sent.id), "Message-ID");
        }
        await appendPoEvent(id, {
          direction: "outbound",
          kind: "sent",
          gmailMessageId: sent.id,
          gmailThreadId: sent.threadId,
          rfc822MessageId: rfc822,
          fromAddr: connection.accountEmail,
          subject: email.subject,
          summary:
            `${po.kind === "mah_release" ? "Release request" : "PO"} emailed to ${to.join(", ")}` +
            `${cc.length ? ` (cc ${cc.join(", ")})` : ""}`,
        });
      } catch (e) {
        logger.warn({ poId: id, err: String(e) }, "Could not record send event");
      }

      logger.info({ poId: id, to, cc, messageId: sent.id }, "PO emailed to vendor via Gmail");
      res.json({
        sent: true,
        to,
        cc,
        subject: email.subject,
        attachmentName: doc ? poPdfFilename(doc) : null,
        messageId: sent.id,
        threadId: sent.threadId,
        emailedAt: emailedAt.toISOString(),
        from: connection.accountEmail,
      });
    } catch (e) {
      if (e instanceof PoDocumentError) return void res.status(e.status).json({ error: e.message });
      const message = e instanceof Error ? e.message : String(e);
      logger.error({ poId: id, err: message }, "PO send failed");
      res.status(502).json({ error: message });
    }
  }),
);

// --- Excess & Obsolete review -------------------------------------------------

/**
 * Every stock holding inventory, ranked by months of supply: on-hand footage
 * against average monthly consumption over the past 12 months (E&O wants a
 * long window — slow movers are the whole point). Null monthsOfSupply = zero
 * recorded usage in 12 months, the strongest obsolescence signal.
 * $ value is the ODBC per-roll cost when the gateway is up, else estimated
 * from footage × Label Traxx CostMSI (flagged so the buyer knows which).
 */
router.get(
  "/demand/eo-report",
  asyncHandler(async (_req, res) => {
    const windowFrom = new Date();
    windowFrom.setMonth(windowFrom.getMonth() - 12);
    const from = windowFrom.toISOString().slice(0, 10);
    const [onHand, usage, stockInfo, goalRows, notes] = await Promise.all([
      fetchOnHandByStock(),
      fetchUsage({ from, to: new Date().toISOString().slice(0, 10) }),
      fetchStockInfo(),
      db.select().from(stockGoalTable),
      db.select().from(eoDispositionTable),
    ]);
    const usedByStock = new Map<string, { footage: number; lastUsed: string | null }>();
    for (const u of usage) {
      const e = usedByStock.get(u.stockId) ?? { footage: 0, lastUsed: null };
      e.footage += u.footage;
      if (!e.lastUsed || u.dateUsed > e.lastUsed) e.lastUsed = u.dateUsed;
      usedByStock.set(u.stockId, e);
    }
    const goalByStock = new Map(goalRows.map((g) => [g.stockId, g]));
    const notesByStock = new Map(notes.map((n) => [n.stockId, n.notes]));

    const items = [];
    for (const [stockId, oh] of onHand) {
      if ((oh.footage ?? 0) <= 0) continue;
      const info = stockInfo.get(stockId);
      const used = usedByStock.get(stockId);
      const avgMonthly = (used?.footage ?? 0) / 12;
      const width = info?.masterWidth ?? 0;
      const estValue =
        info && info.costMsi > 0 && width > 0 ? ((oh.footage * 12 * width) / 1000) * (info.costMsi + (info.freightMsi ?? 0)) : null;
      const odbcValue = oh.value && oh.value > 0 ? oh.value : null;
      items.push({
        stockId,
        description: oh.description ?? info?.faceStock ?? null,
        inactive: info?.inactive ?? false,
        discontinued: goalByStock.get(stockId)?.discontinued ?? false,
        onHandFootage: Math.round(oh.footage),
        rollCount: oh.rollCount,
        valueUsd: odbcValue ?? (estValue != null ? Math.round(estValue * 100) / 100 : null),
        valueIsEstimate: odbcValue == null,
        avgMonthlyFootage: Math.round(avgMonthly),
        monthsOfSupply: avgMonthly > 0 ? Math.round((oh.footage / avgMonthly) * 10) / 10 : null,
        lastUsedIso: used?.lastUsed ?? null,
        notes: notesByStock.get(stockId) ?? null,
      });
    }
    // Worst first: never-used (∞ supply) on top, then by months of supply.
    items.sort((a, b) => {
      if ((a.monthsOfSupply == null) !== (b.monthsOfSupply == null)) return a.monthsOfSupply == null ? -1 : 1;
      if (a.monthsOfSupply == null && b.monthsOfSupply == null) return (b.valueUsd ?? 0) - (a.valueUsd ?? 0);
      return (b.monthsOfSupply ?? 0) - (a.monthsOfSupply ?? 0);
    });
    res.json({ items, windowFrom: from });
  }),
);

/** Save the disposition note for a stock (empty string clears it). */
router.put(
  "/demand/eo-report/notes",
  asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as { stockId?: string; notes?: string | null };
    const stockId = (b.stockId ?? "").trim();
    if (!stockId) return void res.status(400).json({ error: "stockId required" });
    const notes = b.notes?.trim() || null;
    await db
      .insert(eoDispositionTable)
      .values({ stockId, notes, updatedAt: new Date() })
      .onConflictDoUpdate({ target: eoDispositionTable.stockId, set: { notes, updatedAt: new Date() } });
    res.json({ stockId, saved: true });
  }),
);

/** On-hand rolls for a stock — the physical roll tag numbers on the floor. */
router.get(
  "/demand/stocks/:stockId/rolls",
  asyncHandler(async (req, res) => {
    const stockId = String(req.params["stockId"]);
    const rolls = await db
      .select()
      .from(ltRollTable)
      .where(and(eq(ltRollTable.stockId, stockId), eq(ltRollTable.used, false)));
    res.json({
      rolls: rolls
        .sort((a, b) => (a.stockDate ?? "").localeCompare(b.stockDate ?? ""))
        .map((r) => ({
          rollId: r.rollId,
          footage: Math.round(r.length ?? 0),
          width: r.width,
          poNumber: r.poNumber,
          receivedIso: r.stockDate,
          location: r.location,
        })),
    });
  }),
);

// --- PO follow-up agent ------------------------------------------------------

/** Agent work queue: pending follow-up drafts + POs flagged for a human. */
router.get(
  "/demand/po-agent",
  asyncHandler(async (_req, res) => {
    const [drafts, flagged, tracked, lessons] = await Promise.all([
      db.select().from(poAgentDraftTable).where(eq(poAgentDraftTable.status, "pending")),
      db.select().from(materialPoTable).where(eq(materialPoTable.needsAttention, true)),
      db.select().from(materialPoTable).where(isNotNull(materialPoTable.agentState)),
      db.select().from(agentLessonTable),
    ]);

    /**
     * The vendor's own message for each flagged PO.
     *
     * The queue used to show only the agent's one-line summary, so answering
     * "vendor asked a question" meant leaving the dashboard to find the mail.
     * The watcher already stores the sender, subject and the first 1,200
     * characters of the body on the inbound event, so this is a read — no new
     * copy of vendor mail is kept anywhere.
     */
    const flaggedIds = flagged.map((p) => p.id);
    const inboundByPo = new Map<
      string,
      { fromAddr: string | null; subject: string | null; at: string; bodyPreview: string | null; gmailThreadId: string | null }
    >();
    if (flaggedIds.length > 0) {
      const events = await db
        .select()
        .from(poEmailEventTable)
        .where(and(inArray(poEmailEventTable.poId, flaggedIds), eq(poEmailEventTable.direction, "inbound")));
      // Latest inbound per PO — that's the one being asked about.
      for (const e of events.sort((a, b) => a.at.getTime() - b.at.getTime())) {
        const ex = e.extracted as { bodyPreview?: string } | null;
        inboundByPo.set(e.poId, {
          fromAddr: e.fromAddr,
          subject: e.subject,
          at: e.at.toISOString(),
          bodyPreview: ex?.bodyPreview ?? null,
          gmailThreadId: e.gmailThreadId,
        });
      }
    }
    /**
     * Deep-link replies into the connected mailbox.
     *
     * NOT `/mail/u/<email>/` — that path segment takes an account INDEX (0, 1, 2),
     * so an address there returns Gmail's "Temporary Error (404)". The documented
     * way to name an account is the `authuser` query parameter.
     */
    const gmailAccount = await import("../lib/gmail")
      .then((g) => (g.gmailConfigured() ? g.gmailConnection() : null))
      .then((c) => c?.accountEmail ?? null)
      .catch(() => null);
    const poIds = [...new Set([...drafts.map((d) => d.poId), ...flagged.map((p) => p.id)])];
    const lines = poIds.length
      ? await db.select().from(materialPoLineTable).where(inArray(materialPoLineTable.poId, poIds))
      : [];
    const lineByPo = new Map(lines.map((l) => [l.poId, l]));
    const poById = new Map(tracked.map((p) => [p.id, p]));
    for (const p of flagged) poById.set(p.id, p);
    res.json({
      drafts: drafts
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((d) => ({
          id: d.id,
          poId: d.poId,
          kind: d.kind,
          vendorName: poById.get(d.poId)?.vendorName ?? "",
          stockId: lineByPo.get(d.poId)?.stockId ?? null,
          toEmails: d.toEmails,
          ccEmails: d.ccEmails,
          subject: d.subject,
          body: d.body,
          createdAt: d.createdAt.toISOString(),
        })),
      needsAttention: flagged.map((p) => {
        const inbound = inboundByPo.get(p.id) ?? null;
        return {
          poId: p.id,
          vendorName: p.vendorName,
          stockId: lineByPo.get(p.id)?.stockId ?? null,
          ltPoNumbers: p.ltPoNumbers,
          agentState: p.agentState,
          reason: p.attentionReason,
          // The message that caused the flag, so it can be answered in place.
          fromAddr: inbound?.fromAddr ?? null,
          subject: inbound?.subject ?? null,
          receivedAt: inbound?.at ?? null,
          bodyPreview: inbound?.bodyPreview ?? null,
          replyUrl:
            inbound?.gmailThreadId && gmailAccount
              ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(gmailAccount)}#all/${inbound.gmailThreadId}`
              : null,
          gmailThreadId: inbound?.gmailThreadId ?? null,
          vendorEmails: p.emailedTo ?? p.vendorEmails ?? null,
        };
      }),
      lessons: lessons
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((l) => ({ id: l.id, vendorName: l.vendorName, lesson: l.lesson, createdAt: l.createdAt.toISOString() })),
      trackedCount: tracked.filter((p) => p.agentState !== "closed").length,
    });
  }),
);

/**
 * Approve a pending draft: send it as a reply in the PO's thread. The body may
 * carry edited subject/body — the buyer can rewrite the agent's wording before
 * it goes out; what actually sent is stored back on the draft row.
 */
router.post(
  "/demand/po-agent/drafts/:id/approve",
  asyncHandler(async (req, res) => {
    const id = String(req.params["id"]);
    const overrides = (req.body ?? {}) as { subject?: string; body?: string };
    const [draft] = await db.select().from(poAgentDraftTable).where(eq(poAgentDraftTable.id, id)).limit(1);
    if (!draft) return void res.status(404).json({ error: "Draft not found" });
    if (draft.status !== "pending") return void res.status(409).json({ error: `Draft already ${draft.status}` });
    const [po] = await db.select().from(materialPoTable).where(eq(materialPoTable.id, draft.poId)).limit(1);
    if (!po) return void res.status(404).json({ error: "PO not found" });

    const subject = overrides.subject?.trim() || draft.subject;
    const body = overrides.body?.trim() || draft.body;

    try {
      const gmail = await import("../lib/gmail");
      // Reply threading: reference the most recent message we know of in the thread.
      const events = await db.select().from(poEmailEventTable).where(eq(poEmailEventTable.poId, po.id));
      const lastWithRfc = events
        .filter((e) => e.rfc822MessageId)
        .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
      const sent = await gmail.sendMail({
        to: parseEmails(draft.toEmails),
        cc: parseEmails(draft.ccEmails),
        subject,
        text: body,
        threadId: po.gmailThreadId,
        inReplyTo: lastWithRfc?.rfc822MessageId ?? null,
      });
      const now = new Date();
      await db
        .update(poAgentDraftTable)
        .set({ status: "sent", sentAt: now, gmailMessageId: sent.id, subject, body })
        .where(eq(poAgentDraftTable.id, id));
      const { appendPoEvent } = await import("../lib/po-agent");
      await appendPoEvent(po.id, {
        direction: "outbound",
        kind: "follow_up",
        gmailMessageId: sent.id,
        gmailThreadId: sent.threadId,
        subject,
        summary: `Follow-up sent (${draft.kind}) to ${draft.toEmails}${overrides.body ? " (edited before send)" : ""}`,
      });
      res.json({ sent: true, id, messageId: sent.id });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error({ draftId: id, err: message }, "Draft approval send failed");
      res.status(502).json({ error: message });
    }
  }),
);

router.post(
  "/demand/po-agent/drafts/:id/dismiss",
  asyncHandler(async (req, res) => {
    const id = String(req.params["id"]);
    const [draft] = await db.select().from(poAgentDraftTable).where(eq(poAgentDraftTable.id, id)).limit(1);
    if (!draft) return void res.status(404).json({ error: "Draft not found" });
    await db.update(poAgentDraftTable).set({ status: "dismissed" }).where(eq(poAgentDraftTable.id, id));
    /**
     * Record the dismissal on the timeline.
     *
     * Without this, dismissing was a no-op that lasted until the next cron: the
     * nudge condition counts only PENDING drafts and SENT follow-ups, so a
     * dismissed draft left both unchanged and the agent redrafted the identical
     * nudge minutes later. The agent reads these events as "the buyer has dealt
     * with this outreach" and holds off.
     */
    const { appendPoEvent } = await import("../lib/po-agent");
    await appendPoEvent(draft.poId, {
      direction: "system",
      kind: "draft_dismissed",
      subject: draft.subject,
      summary:
        `Buyer dismissed the ${draft.kind.replace(/_/g, " ")} draft — treating this outreach as handled, ` +
        `so it won't be redrafted for a while.`,
      extracted: { draftKind: draft.kind },
    });
    res.json({ dismissed: true, id });
  }),
);

/**
 * Clear a needs-attention flag. An optional explanation becomes a vendor
 * lesson — a buyer-approved convention every future classification for that
 * vendor honors, so the same known quirk stops being flagged. This is how the
 * agent "learns": plain language, visible and deletable in the dashboard.
 */
router.post(
  "/demand/pos/:id/resolve-attention",
  asyncHandler(async (req, res) => {
    const id = String(req.params["id"]);
    const explanation = ((req.body ?? {}) as { explanation?: string }).explanation?.trim();
    const [po] = await db.select().from(materialPoTable).where(eq(materialPoTable.id, id)).limit(1);
    if (!po) return void res.status(404).json({ error: "PO not found" });
    await db
      .update(materialPoTable)
      .set({ needsAttention: false, attentionReason: null, updatedAt: new Date() })
      .where(eq(materialPoTable.id, id));
    const { appendPoEvent } = await import("../lib/po-agent");
    if (explanation) {
      await db.insert(agentLessonTable).values({ vendorName: po.vendorName, lesson: explanation, poId: id });
      await appendPoEvent(id, {
        direction: "system",
        kind: "note",
        summary: `Flag resolved by buyer — lesson saved for ${po.vendorName}: ${explanation}`,
      });
    } else if (po.needsAttention) {
      await appendPoEvent(id, { direction: "system", kind: "note", summary: "Flag resolved by buyer" });
    }
    res.json({ resolved: true, id });
  }),
);

/**
 * Material forecast from NetSuite orders still in Pending Approval — demand
 * that exists commercially but hasn't reached Label Traxx as a ticket yet.
 */
router.get(
  "/demand/forecast",
  asyncHandler(async (_req, res) => {
    const { nsForecastLineTable } = await import("@workspace/db");
    const { forecastSpoilagePct, countsAsForecast, planningShipDate } = await import("../lib/forecast-sync");
    const rows = await db.select().from(nsForecastLineTable);
    const open = rows.filter((r) => !r.ltTicketNum);
    const items = open
      .map((r) => {
        const sd = r.stockDemand as
          | { stocks?: { stockId: string; widthIn: number; footage: number }[]; goodLengthFt?: number; derived?: boolean }
          | null;
        // A ship date already in the past means the line is still waiting on
        // approval — plan it for the current week instead.
        const plan = planningShipDate(r.expectedShipDate);
        return {
          id: r.id,
          soNumber: r.tranId,
          lineNo: r.lineNo,
          customerName: r.customerName,
          sku: r.sku,
          itemClass: r.itemClass,
          quantity: r.quantity,
          expectedShipDate: r.expectedShipDate,
          planningShipDate: plan.date,
          shipDateAdjusted: plan.adjusted,
          orderDate: r.orderDate,
          ltProductNumber: r.ltProductNumber,
          isFlexpack: r.isFlexpack,
          unresolvedReason: r.unresolvedReason,
          goodLengthFt: sd?.goodLengthFt != null ? Math.round(sd.goodLengthFt) : null,
          geometryDerived: Boolean(sd?.derived),
          inferredTicketNum: r.inferredTicketNum,
          inferredTicketConfidence: r.inferredTicketConfidence,
          inferredTicketShipDate: r.inferredTicketShipDate,
          inferredTicketPriority: r.inferredTicketPriority,
          // False only when a production ticket already covers this job.
          countsInForecast: countsAsForecast(r),
          stocks: (sd?.stocks ?? []).map((s) => ({
            stockId: s.stockId,
            widthIn: s.widthIn,
            footage: Math.round(s.footage),
          })),
        };
      })
      .sort((a, b) => a.planningShipDate.localeCompare(b.planningShipDate));

    // Roll up per stock so a buyer sees the material impact, not just orders.
    // Lines already covered by a production ticket are excluded — their footage
    // lives in the committed open-ticket book.
    const byStock = new Map<string, { stockId: string; footage: number; lines: number; earliestShipDate: string | null }>();
    for (const it of items) {
      if (!it.countsInForecast) continue;
      for (const s of it.stocks) {
        const cur = byStock.get(s.stockId) ?? { stockId: s.stockId, footage: 0, lines: 0, earliestShipDate: null };
        cur.footage += s.footage;
        cur.lines += 1;
        if (!cur.earliestShipDate || it.planningShipDate < cur.earliestShipDate) {
          cur.earliestShipDate = it.planningShipDate;
        }
        byStock.set(s.stockId, cur);
      }
    }

    // Lines whose job we found in Label Traxx even though NetSuite's LT Ticket
    // field is blank. Both a double-count guard and a data-hygiene list.
    const linked = items.filter((i) => i.inferredTicketNum);
    res.json({
      spoilagePct: forecastSpoilagePct(),
      unresolvedCount: items.filter((i) => i.unresolvedReason).length,
      // Lines replanned into the current week because their NetSuite ship date
      // had already passed while the order waited for approval.
      shipDateAdjustedCount: items.filter((i) => i.shipDateAdjusted).length,
      linkage: {
        // Suppressed: a production ticket already carries this demand.
        production: linked.filter((i) => i.inferredTicketConfidence === "high").length,
        // Counted: proofs are ~100 ft flat and excluded from committed footage.
        proof: linked.filter((i) => i.inferredTicketConfidence === "proof").length,
        // Counted, needs eyes: SKU matched but the customer didn't.
        weak: linked.filter((i) => i.inferredTicketConfidence === "low").length,
      },
      items,
      byStock: [...byStock.values()].sort((a, b) => b.footage - a.footage),
    });
  }),
);

/**
 * Conversation with the agent. The thread is per signed-in user, so two
 * buyers don't read each other's chat; the agent's tools act on shared data.
 */
function chatUserEmail(req: Request): string {
  return ((req as Request & { user?: { email?: string } }).user?.email ?? "").toLowerCase();
}

router.get(
  "/demand/agent-chat",
  asyncHandler(async (req, res) => {
    const { getChatHistory } = await import("../lib/agent-chat");
    const rows = await getChatHistory(chatUserEmail(req));
    res.json({
      configured: Boolean(process.env["ANTHROPIC_API_KEY"]?.trim()),
      messages: rows.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCalls: (m.toolLog ?? []) as { tool: string; result: string }[],
        at: m.createdAt.toISOString(),
      })),
    });
  }),
);

router.post(
  "/demand/agent-chat",
  asyncHandler(async (req, res) => {
    const message = ((req.body ?? {}) as { message?: string }).message?.trim();
    if (!message) return void res.status(400).json({ error: "message required" });
    const { chatWithAgent } = await import("../lib/agent-chat");
    const r = await chatWithAgent(chatUserEmail(req), message);
    if (!r.ok) return void res.status(502).json({ error: r.error ?? "Agent chat failed" });
    res.json({
      reply: r.reply,
      toolCalls: r.toolCalls.map((t) => ({ tool: t.tool, result: t.result })),
    });
  }),
);

router.delete(
  "/demand/agent-chat",
  asyncHandler(async (req, res) => {
    const { clearChatHistory } = await import("../lib/agent-chat");
    await clearChatHistory(chatUserEmail(req));
    res.json({ cleared: true });
  }),
);

/** Remove a learned lesson the buyer no longer wants applied. */
router.delete(
  "/demand/po-agent/lessons/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params["id"]);
    await db.delete(agentLessonTable).where(eq(agentLessonTable.id, id));
    res.json({ deleted: true, id });
  }),
);

/** Everything that happened around a PO's email conversation. */
router.get(
  "/demand/pos/:id/timeline",
  asyncHandler(async (req, res) => {
    const id = String(req.params["id"]);
    const [events, attachments] = await Promise.all([
      db.select().from(poEmailEventTable).where(eq(poEmailEventTable.poId, id)),
      db.select().from(poAttachmentTable).where(eq(poAttachmentTable.poId, id)),
    ]);
    res.json({
      events: events
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .map((e) => ({
          id: e.id,
          at: e.at.toISOString(),
          direction: e.direction,
          kind: e.kind,
          fromAddr: e.fromAddr,
          subject: e.subject,
          summary: e.summary,
          // First ~1200 chars of the vendor's message, so "review the message"
          // is possible without leaving the dashboard.
          preview: ((e.extracted ?? {}) as Record<string, unknown>)["bodyPreview"] ?? null,
        })),
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  }),
);

/** Download a captured vendor document (order acknowledgement PDF etc). */
router.get(
  "/demand/pos/:id/attachments/:attId",
  asyncHandler(async (req, res) => {
    const [att] = await db
      .select()
      .from(poAttachmentTable)
      .where(and(eq(poAttachmentTable.id, String(req.params["attId"])), eq(poAttachmentTable.poId, String(req.params["id"]))))
      .limit(1);
    if (!att) return void res.status(404).json({ error: "Attachment not found" });
    res.setHeader("content-type", att.mimeType);
    res.setHeader("content-disposition", `attachment; filename="${att.filename.replace(/[^\w.\- ]+/g, "_")}"`);
    res.send(Buffer.from(att.contentBase64, "base64"));
  }),
);

export default router;
