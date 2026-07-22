import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, stockGoalTable, materialPoTable, materialPoLineTable, type StockGoalRow } from "@workspace/db";
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
    const [stockInfo, tickets, goalRows, activeStockIds, widthsByStock] = await Promise.all([
      fetchStockInfo(),
      fetchOpenTickets(),
      db.select().from(stockGoalTable),
      fetchActiveStockIds(),
      fetchOnHandByWidth(),
    ]);
    const goalsByStock = new Map(goalRows.map((g) => [g.stockId, g]));

    const ticketAgg = new Map<
      string,
      { requiredFootage: number; ticketCount: number; tickets: typeof tickets }
    >();
    const statusCounts: Record<string, number> = {};
    for (const t of tickets) {
      statusCounts[t.stockIn] = (statusCounts[t.stockIn] ?? 0) + 1;
      let agg = ticketAgg.get(t.stockId);
      if (!agg) {
        agg = { requiredFootage: 0, ticketCount: 0, tickets: [] };
        ticketAgg.set(t.stockId, agg);
      }
      agg.requiredFootage += t.estFootage;
      agg.ticketCount += 1;
      agg.tickets.push(t);
    }

    const stockIds = new Set<string>([...stockInfo.keys(), ...ticketAgg.keys()]);
    const items = [...stockIds]
      .filter((id) => activeStockIds.size === 0 || activeStockIds.has(id) || ticketAgg.has(id))
      .map((stockId) => {
        const info = stockInfo.get(stockId);
        const goal = goalsByStock.get(stockId);
        const agg = ticketAgg.get(stockId);
        return {
          stockId,
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
          ltInvMsiMinimum: info?.invMsiMinimum ?? 0,
          ltInvMsiMaximum: info?.invMsiMaximum ?? 0,
          leadTimeDaysOverride: goal?.leadTimeDays ?? null,
          typicalRollFootageOverride: goal?.typicalRollFootage ?? null,
          openTicketFootage: agg ? Math.round(agg.requiredFootage) : 0,
          openTicketCount: agg?.ticketCount ?? 0,
          mfgSpecNum: info?.mfgSpecNum ?? null,
          faceStock: info?.faceStock ?? null,
          adhesive: info?.adhesive ?? null,
          faceColor: info?.faceColor ?? null,
          topCoat: info?.topCoat ?? null,
          areaToWeightFactor: info?.areaToWeightFactor ?? 0,
          widthsOnHand: (widthsByStock.get(stockId) ?? []).map((w) => ({
            width: w.width,
            footage: Math.round(w.footage),
            rolls: w.rolls,
          })),
          tickets: (agg?.tickets ?? [])
            .sort((a, b) => (a.shipByDate ?? "9999").localeCompare(b.shipByDate ?? "9999"))
            .slice(0, 40)
            .map((t) => ({
              ticketNumber: t.ticketNumber,
              estFootage: Math.round(t.estFootage),
              stockIn: t.stockIn,
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
  msiCost?: number | null;
  estCost?: number | null;
}

function poEmail(po: {
  vendorName: string;
  vendorEmails: string | null;
  requestedDeliveryDate: string | null;
  lines: { stockId: string; description: string | null; rolls: number; footage: number | null; estCost: number | null }[];
}): { to: string; subject: string; body: string } {
  const lines = po.lines
    .map(
      (l) =>
        `  • Stock #${l.stockId}${l.description ? ` — ${l.description}` : ""}: ${l.rolls} roll${l.rolls === 1 ? "" : "s"}` +
        (l.footage ? ` (~${Math.round(l.footage).toLocaleString()} ft)` : ""),
    )
    .join("\n");
  const total = po.lines.reduce((sum, l) => sum + (l.estCost ?? 0), 0);
  const body =
    `Hi ${po.vendorName} team,\n\n` +
    `Please find our purchase order below:\n\n${lines}\n\n` +
    (po.requestedDeliveryDate ? `Requested delivery: ${po.requestedDeliveryDate}\n` : "") +
    (total > 0 ? `Estimated total: $${total.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n` : "") +
    `\nShip to:\nCalyx Containers\n1991 Parkway Blvd\nWest Valley City, UT 84119\n\n` +
    `Please confirm receipt and expected ship date.\n\nThank you,\nCalyx Containers Supply Chain`;
  return {
    to: parseEmails(po.vendorEmails).join(","),
    subject: `Calyx Containers PO — ${po.vendorName} — ${po.lines.length} item${po.lines.length === 1 ? "" : "s"}`,
    body,
  };
}

router.get(
  "/demand/pos",
  asyncHandler(async (_req, res) => {
    const [pos, lines] = await Promise.all([
      db.select().from(materialPoTable),
      db.select().from(materialPoLineTable),
    ]);
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
        return {
          id: po.id,
          vendorName: po.vendorName,
          vendorEmails: po.vendorEmails,
          status: receivedOn ? "received" : po.status,
          ltPoNumbers: po.ltPoNumbers,
          requestedDeliveryDate: po.requestedDeliveryDate,
          createdAt: po.createdAt.toISOString(),
          receivedOn,
          actualLeadDays,
          lines: (linesByPo.get(po.id) ?? []).map((l) => ({
            stockId: l.stockId,
            description: l.description,
            rolls: l.rolls,
            footage: l.footage,
            msiCost: l.msiCost,
            estCost: l.estCost,
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
      msiCost: l.msiCost == null ? null : Number(l.msiCost),
      estCost: l.estCost == null ? null : Number(l.estCost),
    }));
    await db.insert(materialPoLineTable).values(lineValues);
    const email = poEmail({
      vendorName,
      vendorEmails: b.vendorEmails ?? null,
      requestedDeliveryDate: b.requestedDeliveryDate ?? null,
      lines: lineValues,
    });
    res.json({ id: po!.id, status: "draft", email });
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
 * Submit a PO: marks it submitted here and (when LT writes are enabled)
 * creates one Label Traxx purchaseorder row per line through the gateway.
 */
router.post(
  "/demand/pos/:id/submit",
  asyncHandler(async (req, res) => {
    const id = String(req.params["id"]);
    const [po] = await db.select().from(materialPoTable).where(eq(materialPoTable.id, id)).limit(1);
    if (!po) return void res.status(404).json({ error: "PO not found" });
    const lines = await db.select().from(materialPoLineTable).where(eq(materialPoLineTable.poId, id));

    let ltPoNumbers: string[] = [];
    let status = "submitted";
    let ltError: string | null = null;
    const { ltApiConfigured, ltPost } = await import("../lib/ltApi");
    if (ltApiConfigured()) {
      // Official LT Cloud API: POST /stock-purchase-order-create goes through
      // Label Traxx's own app layer (PO numbering, supplier, costing). One PO
      // per line; slittingSpec carries one row per master roll at the stock's
      // master width (mirrors LT's own stock-PO form).
      const stockInfo = await fetchStockInfo();
      const today = new Date().toISOString().slice(0, 10);
      const dateReq = po.requestedDeliveryDate ?? today;
      const signerRaw = process.env["LT_PO_SIGNER"];
      const poSigner = signerRaw && Number.isFinite(Number(signerRaw)) ? Number(signerRaw) : undefined;
      try {
        for (const l of lines) {
          const info = stockInfo.get(l.stockId);
          const footagePerRoll =
            l.footage != null && l.rolls > 0 ? Math.round(l.footage / l.rolls) : 0;
          const rollCount = Math.min(Math.max(1, l.rolls), 200);
          const body: Record<string, unknown> = {
            stockNo: l.stockId,
            poDate: today,
            requestedDelivery: dateReq,
            notes: `Created by Supply Chain Dashboard (PO ${po.id.slice(0, 8)})`,
            slittingSpec: Array.from({ length: rollCount }, () => ({
              ordered: footagePerRoll,
              exact: true,
              no1: 1,
              cut1: info?.masterWidth ?? 0,
            })),
          };
          if (poSigner !== undefined) body["poSigner"] = poSigner;
          const created = await ltPost<Record<string, unknown>>("/stock-purchase-order-create", body);
          const assigned =
            (typeof created?.["poNumber"] === "string" && created["poNumber"]) ||
            (typeof created?.["number"] === "string" && created["number"]) ||
            (created?.["poNumber"] != null ? String(created["poNumber"]) : null);
          if (assigned) ltPoNumbers.push(String(assigned));
        }
        status = ltPoNumbers.length > 0 ? "submitted_lt" : "submitted";
      } catch (e) {
        ltError = e instanceof Error ? e.message : String(e);
      }
    }

    await db
      .update(materialPoTable)
      .set({ status, ltPoNumbers: ltPoNumbers.length ? ltPoNumbers.join(",") : null, updatedAt: new Date() })
      .where(eq(materialPoTable.id, id));

    const email = poEmail({
      vendorName: po.vendorName,
      vendorEmails: po.vendorEmails,
      requestedDeliveryDate: po.requestedDeliveryDate,
      lines: lines.map((l) => ({
        stockId: l.stockId,
        description: l.description,
        rolls: l.rolls,
        footage: l.footage,
        estCost: l.estCost,
      })),
    });
    res.json({ id, status, ltPoNumbers, ltWriteEnabled: true, ltError, email });
  }),
);

export default router;
