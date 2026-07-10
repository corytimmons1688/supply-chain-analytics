import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  GetAdjustmentsTimeseriesQueryParams,
  GetAdjustmentsTotalsQueryParams,
  GetAdjustmentsByStockQueryParams,
  GetAdjustmentsDetailsQueryParams,
  GetAdjustmentsRootCauseQueryParams,
  SetVarianceInvestigationParams,
  SetVarianceInvestigationBody,
} from "@workspace/api-zod";
import { fetchAdjustments, type AdjustmentRecord } from "../lib/adjustments";
import { fetchOnHandByStock } from "../lib/demand";
import { bucketRange, eachBucket, type Bucket } from "../lib/cc";
import { db, stockGoalTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function isoDate(v: Date | string): string {
  if (typeof v === "string") return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseStrictIsoDate(v: string): Date | null {
  if (!ISO_DATE_RE.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt;
}

function coerceQueryDates(q: unknown): Record<string, unknown> {
  const obj = { ...(q as Record<string, unknown>) };
  for (const k of ["from", "to"]) {
    const v = obj[k];
    if (typeof v === "string") {
      const d = parseStrictIsoDate(v);
      if (d === null) {
        throw new Error(
          `Invalid '${k}' parameter: '${v}'. Expected YYYY-MM-DD.`,
        );
      }
      obj[k] = d;
    }
  }
  if (typeof obj["limit"] === "string") {
    const n = Number(obj["limit"]);
    if (Number.isFinite(n)) obj["limit"] = n;
  }
  return obj;
}

router.get(
  "/adjustments/timeseries",
  asyncHandler(async (req, res) => {
    const parsed = GetAdjustmentsTimeseriesQueryParams.parse(coerceQueryDates(req.query));
    const bucket = (parsed.bucket ?? "week") as Bucket;
    const from = isoDate(parsed.from);
    const to = isoDate(parsed.to);
    const records = await fetchAdjustments({
      from,
      to,
      stockId: parsed.stockId,
    });

    const buckets = new Map<
      string,
      { start: string; end: string; label: string; added: number; removed: number; addedCount: number; removedCount: number }
    >();
    for (const start of eachBucket(from, to, bucket)) {
      const r = bucketRange(start, bucket);
      buckets.set(r.start, { ...r, added: 0, removed: 0, addedCount: 0, removedCount: 0 });
    }
    for (const rec of records) {
      const r = bucketRange(rec.ccDate, bucket);
      const slot = buckets.get(r.start);
      if (!slot) continue;
      if (rec.direction === "added") {
        slot.added += rec.amount;
        slot.addedCount += 1;
      } else {
        slot.removed += rec.amount;
        slot.removedCount += 1;
      }
    }
    const points = Array.from(buckets.values())
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((b) => ({
        periodStart: b.start,
        periodEnd: b.end,
        label: b.label,
        added: round2(b.added),
        removed: round2(b.removed),
        net: round2(b.added - b.removed),
        addedCount: b.addedCount,
        removedCount: b.removedCount,
      }));

    res.json({ bucket, from, to, points });
  }),
);

router.get(
  "/adjustments/totals",
  asyncHandler(async (req, res) => {
    const parsed = GetAdjustmentsTotalsQueryParams.parse(coerceQueryDates(req.query));
    const records = await fetchAdjustments({
      from: isoDate(parsed.from),
      to: isoDate(parsed.to),
      stockId: parsed.stockId,
    });
    const totals = aggregateTotals(records);
    res.json(totals);
  }),
);

router.get(
  "/adjustments/by-stock",
  asyncHandler(async (req, res) => {
    const parsed = GetAdjustmentsByStockQueryParams.parse(coerceQueryDates(req.query));
    const [records, onHandByStock] = await Promise.all([
      fetchAdjustments({ from: isoDate(parsed.from), to: isoDate(parsed.to) }),
      fetchOnHandByStock(),
    ]);
    const byStock = new Map<
      string,
      { stockId: string; description: string | null; added: number; removed: number; addedCount: number; removedCount: number }
    >();
    for (const rec of records) {
      let entry = byStock.get(rec.stockId);
      if (!entry) {
        entry = { stockId: rec.stockId, description: rec.description, added: 0, removed: 0, addedCount: 0, removedCount: 0 };
        byStock.set(rec.stockId, entry);
      }
      if (rec.direction === "added") {
        entry.added += rec.amount;
        entry.addedCount += 1;
      } else {
        entry.removed += rec.amount;
        entry.removedCount += 1;
      }
      if (!entry.description && rec.description) entry.description = rec.description;
    }
    const items = Array.from(byStock.values())
      .map((e) => {
        const net = round2(e.added - e.removed);
        const onHand = onHandByStock.get(e.stockId);
        const onHandValue = onHand?.value ?? 0;
        const onHandFootage = onHand?.footage ?? 0;
        const pctOfOnHand =
          onHandValue > 0 ? Math.round((net / onHandValue) * 10000) / 100 : null;
        return {
          stockId: e.stockId,
          description: e.description,
          added: round2(e.added),
          removed: round2(e.removed),
          net,
          addedCount: e.addedCount,
          removedCount: e.removedCount,
          onHandValue,
          onHandFootage,
          pctOfOnHand,
        };
      })
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    res.json({ items });
  }),
);

router.get(
  "/adjustments/details",
  asyncHandler(async (req, res) => {
    const parsed = GetAdjustmentsDetailsQueryParams.parse(coerceQueryDates(req.query));
    const limit = parsed.limit ?? 200;
    const records = await fetchAdjustments({
      from: isoDate(parsed.from),
      to: isoDate(parsed.to),
      stockId: parsed.stockId,
    });
    const items = records
      .sort((a, b) => b.ccDate.localeCompare(a.ccDate))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        rollTag: r.rollTag,
        stockId: r.stockId,
        description: r.description,
        direction: r.direction,
        amount: round2(r.amount),
        ccDate: r.ccDate,
        ccString: r.ccString,
        poNumber: r.poNumber,
        usedTikNum: r.usedTikNum,
        rowDate: r.rowDate,
      }));
    res.json({ items });
  }),
);

// Map legacy variance_status values to the new investigation flow.
// Legacy: 'completed' | 'no_investigation' → both fold to 'closed'.
function normalizeInvestigationStatus(s: string | null | undefined): string | null {
  if (!s) return null;
  if (s === "completed" || s === "no_investigation") return "closed";
  if (s === "open" || s === "root_cause_id" || s === "closed") return s;
  return null;
}

router.get(
  "/adjustments/root-cause",
  asyncHandler(async (req, res) => {
    const parsed = GetAdjustmentsRootCauseQueryParams.parse(coerceQueryDates(req.query));
    const [records, goalRows, onHandByStock] = await Promise.all([
      fetchAdjustments({ from: isoDate(parsed.from), to: isoDate(parsed.to) }),
      db.select().from(stockGoalTable),
      fetchOnHandByStock(),
    ]);

    const goalsByStock = new Map(goalRows.map((g) => [g.stockId, g]));

    const byStock = new Map<
      string,
      {
        stockId: string;
        description: string | null;
        addedFootage: number;
        removedFootage: number;
        addedDollars: number;
        removedDollars: number;
        addedCount: number;
        removedCount: number;
      }
    >();
    for (const rec of records) {
      let entry = byStock.get(rec.stockId);
      if (!entry) {
        entry = {
          stockId: rec.stockId,
          description: rec.description,
          addedFootage: 0,
          removedFootage: 0,
          addedDollars: 0,
          removedDollars: 0,
          addedCount: 0,
          removedCount: 0,
        };
        byStock.set(rec.stockId, entry);
      }
      if (rec.direction === "added") {
        entry.addedFootage += rec.footage;
        entry.addedDollars += rec.amount;
        entry.addedCount += 1;
      } else {
        entry.removedFootage += rec.footage;
        entry.removedDollars += rec.amount;
        entry.removedCount += 1;
      }
      if (!entry.description && rec.description) entry.description = rec.description;
    }

    const items = Array.from(byStock.values())
      .map((e) => {
        const g = goalsByStock.get(e.stockId);
        const oh = onHandByStock.get(e.stockId);
        const onHandValue = round2(oh?.value ?? 0);
        const netDollars = round2(e.addedDollars - e.removedDollars);
        const pctOfOnHand =
          onHandValue > 0 ? Math.round((netDollars / onHandValue) * 10000) / 100 : null;
        return {
          stockId: e.stockId,
          description: e.description,
          addedFootage: round2(e.addedFootage),
          removedFootage: round2(e.removedFootage),
          netFootage: round2(e.addedFootage - e.removedFootage),
          addedDollars: round2(e.addedDollars),
          removedDollars: round2(e.removedDollars),
          netDollars,
          addedCount: e.addedCount,
          removedCount: e.removedCount,
          onHandValue,
          pctOfOnHand,
          status: normalizeInvestigationStatus(g?.varianceStatus),
          rootCauseCategory: g?.rootCauseCategory ?? null,
          rootCause: g?.rootCause ?? null,
          investigationOwner: g?.investigationOwner ?? null,
          correctiveActionStatus: g?.correctiveActionStatus ?? null,
          correctiveAction: g?.correctiveAction ?? null,
          correctiveActionOwner: g?.correctiveActionOwner ?? null,
        };
      })
      .sort((a, b) => Math.abs(b.netDollars) - Math.abs(a.netDollars));
    res.json({ items });
  }),
);

function trimOrNull(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  return t ? t : null;
}

router.put(
  "/adjustments/root-cause/:stockId",
  asyncHandler(async (req, res) => {
    const params = SetVarianceInvestigationParams.parse(req.params);
    const body = SetVarianceInvestigationBody.parse(req.body);
    const status = body.status ?? null;
    const rootCauseCategory = body.rootCauseCategory ?? null;
    const rootCause = trimOrNull(body.rootCause);
    const investigationOwner = trimOrNull(body.investigationOwner);
    const correctiveActionStatus = body.correctiveActionStatus ?? null;
    const correctiveAction = trimOrNull(body.correctiveAction);
    const correctiveActionOwner = trimOrNull(body.correctiveActionOwner);
    await db
      .insert(stockGoalTable)
      .values({
        stockId: params.stockId,
        varianceStatus: status,
        rootCauseCategory,
        rootCause,
        investigationOwner,
        correctiveActionStatus,
        correctiveAction,
        correctiveActionOwner,
      })
      .onConflictDoUpdate({
        target: stockGoalTable.stockId,
        set: {
          varianceStatus: status,
          rootCauseCategory,
          rootCause,
          investigationOwner,
          correctiveActionStatus,
          correctiveAction,
          correctiveActionOwner,
          updatedAt: new Date(),
        },
      });
    res.json({
      stockId: params.stockId,
      status,
      rootCauseCategory,
      rootCause,
      investigationOwner,
      correctiveActionStatus,
      correctiveAction,
      correctiveActionOwner,
    });
  }),
);

function aggregateTotals(records: AdjustmentRecord[]) {
  let added = 0;
  let removed = 0;
  let addedCount = 0;
  let removedCount = 0;
  for (const r of records) {
    if (r.direction === "added") {
      added += r.amount;
      addedCount += 1;
    } else {
      removed += r.amount;
      removedCount += 1;
    }
  }
  return {
    added: round2(added),
    removed: round2(removed),
    net: round2(added - removed),
    addedCount,
    removedCount,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default router;
