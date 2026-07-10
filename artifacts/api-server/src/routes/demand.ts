import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, stockGoalTable, type StockGoalRow } from "@workspace/db";
import {
  fetchUsage,
  fetchOnHandByStock,
  fetchPoLeadTimes,
  fetchPoRolls,
  fetchOpenPos,
  fetchActiveStockIds,
  computeStockMetrics,
  bucketHistory,
  defaultDemandWindow,
  type RollUsageRow,
  type PoRollRow,
  type OpenPoRow,
} from "../lib/demand";
import type { Bucket } from "../lib/cc";

interface StockOverrides {
  demandCv?: number;
  leadTimeCv?: number;
  seasonalityWeights?: [number, number, number] | null;
  leadTimeDays?: number;
  typicalRollFootage?: number;
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

    const [usage, onHand, poLeadTimes, poRolls, openPos, activeStockIds, stockGoalRows] = await Promise.all([
      fetchUsage({ from, to }),
      fetchOnHandByStock(),
      fetchPoLeadTimes(),
      fetchPoRolls(),
      fetchOpenPos(),
      fetchActiveStockIds(),
      db.select().from(stockGoalTable),
    ]);
    const overridesByStock = new Map<string, StockOverrides>();
    for (const row of stockGoalRows) overridesByStock.set(row.stockId, rowToOverrides(row));

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

    const allStockIds = new Set<string>();
    for (const k of usageByStock.keys()) if (activeStockIds.has(k)) allStockIds.add(k);
    for (const k of onHand.keys()) if (activeStockIds.has(k)) allStockIds.add(k);
    // Stocks with only open POs (no recent usage and nothing on hand) still
    // matter for the buyer — surface them in the summary.
    for (const k of openPosByStock.keys()) if (activeStockIds.has(k)) allStockIds.add(k);

    // Global fallback lead time: median across all observed POs (else 14 days)
    const allLts = Array.from(poLeadTimes.values()).map((p) => p.leadTimeDays);
    const fallbackLeadTimeDays = allLts.length > 0
      ? allLts.slice().sort((a, b) => a - b)[Math.floor(allLts.length / 2)]!
      : 14;

    const items = [];
    for (const stockId of allStockIds) {
      const stockUsage = usageByStock.get(stockId) ?? [];
      const stockOnHand = onHand.get(stockId);
      const stockPoRolls = poRollsByStock.get(stockId) ?? [];
      const description = descByStock.get(stockId) ?? stockOnHand?.description ?? null;
      const overrides = overridesByStock.get(stockId) ?? { customized: false };
      // Per-stock overrides win over the request-level (global) overrides.
      const effDemandCv = overrides.demandCv ?? demandCvOverride;
      const effLeadTimeCv = overrides.leadTimeCv ?? leadTimeCvOverride;

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
        serviceLevel,
        ...(effDemandCv !== undefined ? { demandCvOverride: effDemandCv } : {}),
        ...(effLeadTimeCv !== undefined ? { leadTimeCvOverride: effLeadTimeCv } : {}),
        ...(overrides.seasonalityWeights ? { seasonalityWeightsOverride: overrides.seasonalityWeights } : {}),
        ...(overrides.leadTimeDays !== undefined ? { leadTimeDaysOverride: overrides.leadTimeDays } : {}),
        ...(overrides.typicalRollFootage !== undefined ? { typicalRollFootageOverride: overrides.typicalRollFootage } : {}),
        forecastWeeks,
        fallbackLeadTimeDays,
        customized: overrides.customized,
      });

      // Skip stocks with no signal at all (zero history AND zero on-hand AND no open POs)
      if (
        metrics.totalDemandFootage === 0 &&
        metrics.onHandFootage === 0 &&
        metrics.openPoCount === 0
      ) continue;
      items.push(metrics);
    }

    // Sort: below-min first, then by descending forecast demand
    items.sort((a, b) => {
      if (a.belowMin !== b.belowMin) return a.belowMin ? -1 : 1;
      return b.forecast12wkFootage - a.forecast12wkFootage;
    });

    res.json({
      windowFrom: from,
      windowTo: to,
      monthsBack,
      serviceLevel,
      forecastWeeks,
      generatedAt: new Date().toISOString(),
      items,
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

export default router;
