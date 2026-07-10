import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq, sql, and, ne, desc } from "drizzle-orm";
import {
  db,
  globalGoalTable,
  vendorTable,
  vendorMetricTable,
  vendorQualityIssueTable,
  vendorPricingReviewTable,
  vendorImprovementProjectTable,
  vendorShipmentTable,
  vendorPurchaseTable,
  vendorLeadTimeTable,
  aslEntryTable,
  vendorQualityCaseTable,
  vendorAliasTable,
  type VendorRow,
  type VendorMetricRow,
} from "@workspace/db";
import {
  netsuiteConfigured,
  netsuitePing,
  fetchPurchaseShipments,
  fetchVendorPurchases,
  fetchVendorQualityCases,
} from "../lib/netsuite";
import { fetchPoLeadTimeRows } from "../lib/labeltraxxPo";

const router: IRouter = Router();
const GLOBAL_KEY = "global";
const DEFAULT_ASL_GOAL = 50;

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function s(v: unknown): string | null {
  if (typeof v !== "string") return v == null ? null : String(v);
  const t = v.trim();
  return t.length ? t : null;
}
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function intOrNull(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.round(n);
}

// Vendor text columns that PUT /vendors/:id may update (excludes id/name/timestamps).
// Used for partial updates so each table only writes the fields it edits.
const VENDOR_UPDATABLE_KEYS = [
  "country", "category", "track", "tier", "stage", "owner", "subCategory",
  "capabilities", "locations", "documents", "calyxPoc", "vendorPoc",
  "vendorPocPhone", "vendorPocEmail", "externalId", "printMethod",
  "pipelineStatus", "website", "cluster", "subCapability", "primarySecondary",
  "waveSprint", "specInDate", "specInLink", "ndaLink", "supplierSelectedDate",
  "supplierSelectedLink", "poReadyDate", "poReadyLink", "ndaDate", "msaDate", "capabilityVerified", "factoryTourDate",
  "rfqSent", "quoteReceived", "quotedPrice", "targetPrice", "priceVsTargetPct",
  "moq", "depositPct", "leadTimeDays", "aqlStandard", "psiStatus", "trialOrderNo",
  "trialResult", "commandIntegrated", "packosHandoff", "ipClause", "nonCompete24mo",
  "statusRag", "nextAction", "nextActionDue", "notes",
] as const;

// ---------- Date / period helpers (UTC, ISO YYYY-MM-DD) ----------
function pad(n: number) {
  return String(n).padStart(2, "0");
}
function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function parseAnchor(v: unknown): Date {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!));
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

type View = "monthly" | "quarterly" | "qtd" | "ytd";
function resolveView(v: unknown): View {
  return v === "quarterly" || v === "qtd" || v === "ytd" ? v : "monthly";
}

function resolvePeriod(view: View, anchor: Date): { start: string; end: string; label: string; months: string[] } {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth(); // 0-11
  const q = Math.floor(m / 3); // 0-3
  const qStartMonth = q * 3;
  const monthsList = (fromM: number, toM: number): string[] => {
    const out: string[] = [];
    for (let mm = fromM; mm <= toM; mm++) out.push(`${y}-${pad(mm + 1)}`);
    return out;
  };
  let start: Date, end: Date, label: string, months: string[];
  if (view === "monthly") {
    start = new Date(Date.UTC(y, m, 1));
    end = new Date(Date.UTC(y, m + 1, 0));
    label = `${anchor.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${y}`;
    months = monthsList(m, m);
  } else if (view === "quarterly") {
    start = new Date(Date.UTC(y, qStartMonth, 1));
    end = new Date(Date.UTC(y, qStartMonth + 3, 0));
    label = `Q${q + 1} ${y}`;
    months = monthsList(qStartMonth, qStartMonth + 2);
  } else if (view === "qtd") {
    start = new Date(Date.UTC(y, qStartMonth, 1));
    end = anchor;
    label = `Q${q + 1} ${y} (QTD)`;
    months = monthsList(qStartMonth, m);
  } else {
    start = new Date(Date.UTC(y, 0, 1));
    end = anchor;
    label = `${y} (YTD)`;
    months = monthsList(0, m);
  }
  return { start: iso(start), end: iso(end), label, months };
}

function avg(vals: number[]): number | null {
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
// NetSuite lead time in days: PO date ("sent") -> actual ship date. Bounded to
// a sane window so bad/legacy data does not skew the average.
function nsLeadDays(poDate: string | null, actualShipDate: string | null): number | null {
  if (!poDate || !actualShipDate) return null;
  const a = Date.parse(`${poDate}T00:00:00Z`);
  const b = Date.parse(`${actualShipDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = Math.round((b - a) / 86_400_000);
  if (d < 0 || d > 365) return null;
  return d;
}
function gradeFromScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function vendorOut(r: VendorRow) {
  return {
    id: r.id,
    name: r.name,
    country: r.country,
    category: r.category,
    track: r.track,
    tier: r.tier,
    stage: r.stage,
    owner: r.owner,
    subCategory: r.subCategory,
    capabilities: r.capabilities,
    locations: r.locations,
    documents: r.documents,
    calyxPoc: r.calyxPoc,
    vendorPoc: r.vendorPoc,
    vendorPocPhone: r.vendorPocPhone,
    vendorPocEmail: r.vendorPocEmail,
    externalId: r.externalId,
    printMethod: r.printMethod,
    pipelineStatus: r.pipelineStatus,
    website: r.website,
    cluster: r.cluster,
    subCapability: r.subCapability,
    primarySecondary: r.primarySecondary,
    waveSprint: r.waveSprint,
    specInDate: r.specInDate,
    specInLink: r.specInLink,
    ndaLink: r.ndaLink,
    supplierSelectedDate: r.supplierSelectedDate,
    supplierSelectedLink: r.supplierSelectedLink,
    poReadyDate: r.poReadyDate,
    poReadyLink: r.poReadyLink,
    ndaDate: r.ndaDate,
    msaDate: r.msaDate,
    capabilityVerified: r.capabilityVerified,
    factoryTourDate: r.factoryTourDate,
    rfqSent: r.rfqSent,
    quoteReceived: r.quoteReceived,
    quotedPrice: r.quotedPrice,
    targetPrice: r.targetPrice,
    priceVsTargetPct: r.priceVsTargetPct,
    moq: r.moq,
    depositPct: r.depositPct,
    leadTimeDays: r.leadTimeDays,
    aqlStandard: r.aqlStandard,
    psiStatus: r.psiStatus,
    trialOrderNo: r.trialOrderNo,
    trialResult: r.trialResult,
    commandIntegrated: r.commandIntegrated,
    packosHandoff: r.packosHandoff,
    ipClause: r.ipClause,
    nonCompete24mo: r.nonCompete24mo,
    statusRag: r.statusRag,
    nextAction: r.nextAction,
    nextActionDue: r.nextActionDue,
    notes: r.notes,
  };
}
function metricOut(r: VendorMetricRow) {
  return {
    id: r.id,
    vendorId: r.vendorId,
    period: r.period,
    onTimePct: r.onTimePct,
    ppvSavings: r.ppvSavings,
    fillRatePct: r.fillRatePct,
    leadTimeAdherencePct: r.leadTimeAdherencePct,
  };
}

// =====================================================================
// VENDORS CRUD
// =====================================================================
router.get(
  "/vendors",
  asyncHandler(async (_req, res) => {
    const rows = await db.select().from(vendorTable).orderBy(vendorTable.name);
    res.json({ items: rows.map(vendorOut) });
  }),
);

router.post(
  "/vendors",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const name = s(b.name);
    if (!name) return void res.status(400).json({ error: "name required" });
    const [row] = await db
      .insert(vendorTable)
      .values({
        name,
        country: s(b.country),
        category: s(b.category),
        track: s(b.track),
        tier: s(b.tier),
        stage: s(b.stage),
        owner: s(b.owner),
        notes: s(b.notes),
      })
      .returning();
    res.json(vendorOut(row!));
  }),
);

router.put(
  "/vendors/:vendorId",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const name = s(b.name);
    if (!name) return void res.status(400).json({ error: "name required" });
    // Partial update: only write columns actually present in the request body.
    // Each table (ASL vs pipeline) edits its own subset of columns, so omitted
    // fields must be left untouched — otherwise editing one table would null
    // out the other table's columns.
    const updates: Partial<typeof vendorTable.$inferInsert> = {
      name,
      updatedAt: new Date(),
    };
    for (const k of VENDOR_UPDATABLE_KEYS) {
      if (k in b) (updates as Record<string, unknown>)[k] = s(b[k]);
    }
    const [row] = await db
      .update(vendorTable)
      .set(updates)
      .where(eq(vendorTable.id, String(req.params.vendorId)))
      .returning();
    if (!row) return void res.status(404).json({ error: "not found" });
    res.json(vendorOut(row));
  }),
);

router.delete(
  "/vendors/:vendorId",
  asyncHandler(async (req, res) => {
    const id = String(req.params.vendorId);
    await db.delete(vendorMetricTable).where(eq(vendorMetricTable.vendorId, id));
    await db.delete(vendorQualityIssueTable).where(eq(vendorQualityIssueTable.vendorId, id));
    await db.delete(vendorPricingReviewTable).where(eq(vendorPricingReviewTable.vendorId, id));
    await db.delete(vendorImprovementProjectTable).where(eq(vendorImprovementProjectTable.vendorId, id));
    await db.delete(vendorShipmentTable).where(eq(vendorShipmentTable.vendorId, id));
    await db.delete(aslEntryTable).where(eq(aslEntryTable.vendorId, id));
    await db.delete(vendorTable).where(eq(vendorTable.id, id));
    res.status(204).end();
  }),
);

// =====================================================================
// METRICS upsert
// =====================================================================
router.put(
  "/vendors/metrics",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const vendorId = s(b.vendorId);
    const period = s(b.period);
    if (!vendorId || !period || !/^\d{4}-\d{2}$/.test(period)) {
      return void res.status(400).json({ error: "vendorId and period (YYYY-MM) required" });
    }
    const values = {
      vendorId,
      period,
      onTimePct: num(b.onTimePct),
      ppvSavings: num(b.ppvSavings),
      fillRatePct: num(b.fillRatePct),
      leadTimeAdherencePct: num(b.leadTimeAdherencePct),
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(vendorMetricTable)
      .values(values)
      .onConflictDoUpdate({
        target: [vendorMetricTable.vendorId, vendorMetricTable.period],
        set: {
          onTimePct: values.onTimePct,
          ppvSavings: values.ppvSavings,
          fillRatePct: values.fillRatePct,
          leadTimeAdherencePct: values.leadTimeAdherencePct,
          updatedAt: new Date(),
        },
      })
      .returning();
    res.json(metricOut(row!));
  }),
);

// =====================================================================
// QUALITY ISSUES CRUD
// =====================================================================
function qiOut(r: typeof vendorQualityIssueTable.$inferSelect) {
  return {
    id: r.id,
    vendorId: r.vendorId,
    occurredOn: r.occurredOn,
    title: r.title,
    description: r.description,
    severity: r.severity,
    status: r.status,
  };
}

function qcOut(r: typeof vendorQualityCaseTable.$inferSelect) {
  return {
    id: r.id,
    vendorId: r.vendorId,
    caseNumber: r.caseNumber,
    subject: r.subject,
    statusName: r.statusName,
    openCase: r.openCase,
    soTranid: r.soTranid,
    poNumber: r.poNumber,
    caseUrl: r.caseUrl,
    startDate: r.startDate,
  };
}

function shipmentOut(r: typeof vendorShipmentTable.$inferSelect) {
  const fillPct =
    r.qtyOrdered != null && r.qtyOrdered > 0 && r.qtyShipped != null
      ? Math.round((r.qtyShipped / r.qtyOrdered) * 1000) / 10
      : null;
  return {
    id: r.id,
    vendorId: r.vendorId,
    orderNo: r.orderNo,
    poDate: r.poDate,
    customerDate: r.customerDate,
    actualShipDate: r.actualShipDate,
    onTime: r.onTime,
    qtyOrdered: r.qtyOrdered,
    qtyShipped: r.qtyShipped,
    nsLeadDays: nsLeadDays(r.poDate, r.actualShipDate),
    fillPct,
  };
}
router.get(
  "/vendors/quality-issues",
  asyncHandler(async (req, res) => {
    const vendorId = s(req.query.vendorId);
    const rows = vendorId
      ? await db.select().from(vendorQualityIssueTable).where(eq(vendorQualityIssueTable.vendorId, vendorId))
      : await db.select().from(vendorQualityIssueTable);
    rows.sort((a, b) => b.occurredOn.localeCompare(a.occurredOn));
    res.json({ items: rows.map(qiOut) });
  }),
);
// NetSuite-sourced quality cases (read-only). One row per (vendor, case).
router.get(
  "/vendors/quality-cases",
  asyncHandler(async (req, res) => {
    const vendorId = s(req.query.vendorId);
    const rows = vendorId
      ? await db.select().from(vendorQualityCaseTable).where(eq(vendorQualityCaseTable.vendorId, vendorId))
      : await db.select().from(vendorQualityCaseTable);
    rows.sort((a, b) => {
      // Open first, then most recent start date, then case number.
      if (a.openCase !== b.openCase) return a.openCase ? -1 : 1;
      const ad = a.startDate ?? "";
      const bd = b.startDate ?? "";
      if (ad !== bd) return bd.localeCompare(ad);
      return (b.caseNumber ?? "").localeCompare(a.caseNumber ?? "");
    });
    res.json({ items: rows.map(qcOut) });
  }),
);

// All POs (shipments) for a vendor with on-time + lead-time details.
router.get(
  "/vendors/shipments",
  asyncHandler(async (req, res) => {
    const vendorId = s(req.query.vendorId);
    const rows = vendorId
      ? await db.select().from(vendorShipmentTable).where(eq(vendorShipmentTable.vendorId, vendorId))
      : await db.select().from(vendorShipmentTable);
    rows.sort((a, b) => {
      const ad = a.poDate ?? a.customerDate ?? "";
      const bd = b.poDate ?? b.customerDate ?? "";
      return bd.localeCompare(ad);
    });
    res.json({ items: rows.map(shipmentOut) });
  }),
);

router.post(
  "/vendors/quality-issues",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const vendorId = s(b.vendorId);
    const occurredOn = s(b.occurredOn);
    const title = s(b.title);
    if (!vendorId || !occurredOn || !title) return void res.status(400).json({ error: "vendorId, occurredOn, title required" });
    const [row] = await db
      .insert(vendorQualityIssueTable)
      .values({
        vendorId,
        occurredOn,
        title,
        description: s(b.description),
        severity: s(b.severity) ?? "medium",
        status: s(b.status) ?? "open",
      })
      .returning();
    res.json(qiOut(row!));
  }),
);
router.put(
  "/vendors/quality-issues/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const occurredOn = s(b.occurredOn);
    const title = s(b.title);
    if (!occurredOn || !title) return void res.status(400).json({ error: "occurredOn, title required" });
    const [row] = await db
      .update(vendorQualityIssueTable)
      .set({
        occurredOn,
        title,
        description: s(b.description),
        severity: s(b.severity) ?? "medium",
        status: s(b.status) ?? "open",
      })
      .where(eq(vendorQualityIssueTable.id, String(req.params.id)))
      .returning();
    if (!row) return void res.status(404).json({ error: "not found" });
    res.json(qiOut(row));
  }),
);
router.delete(
  "/vendors/quality-issues/:id",
  asyncHandler(async (req, res) => {
    await db.delete(vendorQualityIssueTable).where(eq(vendorQualityIssueTable.id, String(req.params.id)));
    res.status(204).end();
  }),
);

// =====================================================================
// PRICING REVIEWS CRUD
// =====================================================================
function prOut(r: typeof vendorPricingReviewTable.$inferSelect) {
  return {
    id: r.id,
    vendorId: r.vendorId,
    reviewedOn: r.reviewedOn,
    title: r.title,
    outcome: r.outcome,
    impactUsd: r.impactUsd,
    notes: r.notes,
  };
}
router.get(
  "/vendors/pricing-reviews",
  asyncHandler(async (req, res) => {
    const vendorId = s(req.query.vendorId);
    const rows = vendorId
      ? await db.select().from(vendorPricingReviewTable).where(eq(vendorPricingReviewTable.vendorId, vendorId))
      : await db.select().from(vendorPricingReviewTable);
    rows.sort((a, b) => b.reviewedOn.localeCompare(a.reviewedOn));
    res.json({ items: rows.map(prOut) });
  }),
);
router.post(
  "/vendors/pricing-reviews",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const vendorId = s(b.vendorId);
    const reviewedOn = s(b.reviewedOn);
    const title = s(b.title);
    if (!vendorId || !reviewedOn || !title) return void res.status(400).json({ error: "vendorId, reviewedOn, title required" });
    const [row] = await db
      .insert(vendorPricingReviewTable)
      .values({
        vendorId,
        reviewedOn,
        title,
        outcome: s(b.outcome),
        impactUsd: num(b.impactUsd),
        notes: s(b.notes),
      })
      .returning();
    res.json(prOut(row!));
  }),
);
router.put(
  "/vendors/pricing-reviews/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const reviewedOn = s(b.reviewedOn);
    const title = s(b.title);
    if (!reviewedOn || !title) return void res.status(400).json({ error: "reviewedOn, title required" });
    const [row] = await db
      .update(vendorPricingReviewTable)
      .set({
        reviewedOn,
        title,
        outcome: s(b.outcome),
        impactUsd: num(b.impactUsd),
        notes: s(b.notes),
      })
      .where(eq(vendorPricingReviewTable.id, String(req.params.id)))
      .returning();
    if (!row) return void res.status(404).json({ error: "not found" });
    res.json(prOut(row));
  }),
);
router.delete(
  "/vendors/pricing-reviews/:id",
  asyncHandler(async (req, res) => {
    await db.delete(vendorPricingReviewTable).where(eq(vendorPricingReviewTable.id, String(req.params.id)));
    res.status(204).end();
  }),
);

// =====================================================================
// IMPROVEMENT PROJECTS CRUD
// =====================================================================
function ipOut(r: typeof vendorImprovementProjectTable.$inferSelect) {
  return {
    id: r.id,
    vendorId: r.vendorId,
    title: r.title,
    description: r.description,
    status: r.status,
    startedOn: r.startedOn,
    targetOn: r.targetOn,
    owner: r.owner,
  };
}
router.get(
  "/vendors/improvement-projects",
  asyncHandler(async (req, res) => {
    const vendorId = s(req.query.vendorId);
    const rows = vendorId
      ? await db.select().from(vendorImprovementProjectTable).where(eq(vendorImprovementProjectTable.vendorId, vendorId))
      : await db.select().from(vendorImprovementProjectTable);
    rows.sort((a, b) => (b.startedOn ?? "").localeCompare(a.startedOn ?? ""));
    res.json({ items: rows.map(ipOut) });
  }),
);
router.post(
  "/vendors/improvement-projects",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const vendorId = s(b.vendorId);
    const title = s(b.title);
    if (!vendorId || !title) return void res.status(400).json({ error: "vendorId, title required" });
    const [row] = await db
      .insert(vendorImprovementProjectTable)
      .values({
        vendorId,
        title,
        description: s(b.description),
        status: s(b.status) ?? "not_started",
        startedOn: s(b.startedOn),
        targetOn: s(b.targetOn),
        owner: s(b.owner),
      })
      .returning();
    res.json(ipOut(row!));
  }),
);
router.put(
  "/vendors/improvement-projects/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const title = s(b.title);
    if (!title) return void res.status(400).json({ error: "title required" });
    const [row] = await db
      .update(vendorImprovementProjectTable)
      .set({
        title,
        description: s(b.description),
        status: s(b.status) ?? "not_started",
        startedOn: s(b.startedOn),
        targetOn: s(b.targetOn),
        owner: s(b.owner),
        updatedAt: new Date(),
      })
      .where(eq(vendorImprovementProjectTable.id, String(req.params.id)))
      .returning();
    if (!row) return void res.status(404).json({ error: "not found" });
    res.json(ipOut(row));
  }),
);
router.delete(
  "/vendors/improvement-projects/:id",
  asyncHandler(async (req, res) => {
    await db.delete(vendorImprovementProjectTable).where(eq(vendorImprovementProjectTable.id, String(req.params.id)));
    res.status(204).end();
  }),
);

// =====================================================================
// SCORECARDS (aggregated by time view)
// =====================================================================
router.get(
  "/vendors/scorecards",
  asyncHandler(async (req, res) => {
    const view = resolveView(req.query.view);
    const anchor = parseAnchor(req.query.anchor);
    const { start, end, label, months } = resolvePeriod(view, anchor);
    const monthSet = new Set(months);
    const inWindow = (d: string | null) => !!d && d >= start && d <= end;

    const [vendors, metrics, shipments, purchases, leadTimes, issues, reviews, projects, qualityCases] =
      await Promise.all([
        db.select().from(vendorTable).orderBy(vendorTable.name),
        db.select().from(vendorMetricTable),
        db.select().from(vendorShipmentTable),
        db.select().from(vendorPurchaseTable),
        db.select().from(vendorLeadTimeTable),
        db.select().from(vendorQualityIssueTable),
        db.select().from(vendorPricingReviewTable),
        db.select().from(vendorImprovementProjectTable),
        db.select().from(vendorQualityCaseTable),
      ]);

    const netsuiteConnected = shipments.length > 0;
    const labeltraxxConnected = leadTimes.length > 0;

    const items = vendors.map((v) => {
      const vMetrics = metrics.filter((m) => m.vendorId === v.id && monthSet.has(m.period));
      const vShip = shipments.filter((sh) => sh.vendorId === v.id && inWindow(sh.actualShipDate ?? sh.customerDate));
      // Total spend: NetSuite Vendor Bills for the vendor, dated in the period.
      const vPurch = purchases.filter((p) => p.vendorId === v.id && inWindow(p.poDate));
      const totalSpend = vPurch.length ? vPurch.reduce((a, p) => a + (p.amount ?? 0), 0) : null;
      const purchaseCount = vPurch.length;
      const vLead = leadTimes.filter((lt) => lt.vendorId === v.id && inWindow(lt.receivedDate));
      const vIssues = issues.filter((i) => i.vendorId === v.id && inWindow(i.occurredOn));
      const vReviews = reviews.filter((p) => p.vendorId === v.id && inWindow(p.reviewedOn));
      const vProjects = projects.filter((p) => p.vendorId === v.id && (p.startedOn == null || p.startedOn <= end));
      // NetSuite quality cases attributed to this vendor. A case with no start
      // date still counts (the link is what matters, not the timing).
      const vCases = qualityCases.filter(
        (c) => c.vendorId === v.id && (c.startDate == null || inWindow(c.startDate)),
      );

      // On-time: prefer NetSuite shipment data; else manual metric override.
      const totalShipments = vShip.length;
      const onTimeShipments = vShip.filter((sh) => sh.onTime === true).length;
      let onTimePct: number | null = null;
      if (totalShipments > 0) {
        onTimePct = (onTimeShipments / totalShipments) * 100;
      } else {
        onTimePct = avg(vMetrics.map((m) => m.onTimePct).filter((x): x is number => x != null));
      }

      const ppvSavings = (() => {
        const vals = vMetrics.map((m) => m.ppvSavings).filter((x): x is number => x != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      })();
      // Finished-goods fill rate from NetSuite quantities (shipped / ordered);
      // fall back to the manual monthly metric when no NetSuite quantity data.
      const fillQtyOrdered = vShip.reduce((a, sh) => a + (sh.qtyOrdered ?? 0), 0);
      const fillQtyShipped = vShip.reduce((a, sh) => a + (sh.qtyShipped ?? 0), 0);
      const fillRatePct =
        fillQtyOrdered > 0
          ? (fillQtyShipped / fillQtyOrdered) * 100
          : avg(vMetrics.map((m) => m.fillRatePct).filter((x): x is number => x != null));

      // Materials fill rate (Label Traxx, USER CONFIRMED roll-based, NOT MSI):
      // rolls received / rolls ordered across the period's received POs.
      const matRollsOrdered = vLead.reduce((a, lt) => a + (lt.orderedRolls ?? 0), 0);
      const matRollsReceived = vLead.reduce((a, lt) => a + (lt.receivedRolls ?? 0), 0);
      const materialsFillRatePct = matRollsOrdered > 0 ? (matRollsReceived / matRollsOrdered) * 100 : null;

      // NetSuite lead time: PO date ("sent") -> actual ship date.
      const nsLeadValues = vShip
        .map((sh) => nsLeadDays(sh.poDate, sh.actualShipDate))
        .filter((x): x is number => x != null);
      const avgNsLeadDays = avg(nsLeadValues);
      const nsLeadPoCount = nsLeadValues.length;

      const leadTimeAdherencePct = avg(vMetrics.map((m) => m.leadTimeAdherencePct).filter((x): x is number => x != null));

      // Data-derived category gating (USER CONFIRMED): Label Traxx => materials,
      // NetSuite SO-linked shipments => finished goods. A vendor with both
      // (e.g. Dazpak) shows both. Derived from all-time data presence so the
      // section still renders when the active period happens to be empty.
      const hasFinishedGoods = shipments.some((sh) => sh.vendorId === v.id);
      const hasMaterials = leadTimes.some((lt) => lt.vendorId === v.id);
      const dataCategory =
        hasMaterials && hasFinishedGoods
          ? "both"
          : hasMaterials
            ? "materials"
            : hasFinishedGoods
              ? "finished_goods"
              : null;

      // Label Traxx lead time (PODate -> Received), in days. Extra metric only.
      const leadPoCount = vLead.length;
      const avgLeadDays = avg(vLead.map((lt) => lt.leadDays));

      const qualityIssueCount = vIssues.length + vCases.length;
      const openQualityIssueCount =
        vIssues.filter((i) => i.status !== "closed").length + vCases.filter((c) => c.openCase).length;
      const pricingReviewCount = vReviews.length;
      const improvementProjectCount = vProjects.length;
      const activeImprovementProjectCount = vProjects.filter(
        (p) => p.status === "in_progress" || p.status === "not_started",
      ).length;

      // Weighted score from available components (quality always present).
      // Responsiveness removed (USER) — weights rebalanced to sum to 1.0. Fill
      // uses the vendor's relevant figure: finished-goods qty fill when present,
      // else the materials roll-based fill.
      const effectiveFillPct = fillRatePct != null ? fillRatePct : materialsFillRatePct;
      const comps: { w: number; v: number }[] = [];
      if (onTimePct != null) comps.push({ w: 0.35, v: clamp(onTimePct, 0, 100) });
      if (effectiveFillPct != null) comps.push({ w: 0.25, v: clamp(effectiveFillPct, 0, 100) });
      if (leadTimeAdherencePct != null) comps.push({ w: 0.15, v: clamp(leadTimeAdherencePct, 0, 100) });
      const qualityScore = clamp(100 - openQualityIssueCount * 15, 0, 100);
      comps.push({ w: 0.25, v: qualityScore });

      const hasData =
        onTimePct != null ||
        fillRatePct != null ||
        materialsFillRatePct != null ||
        leadTimeAdherencePct != null ||
        ppvSavings != null ||
        qualityIssueCount > 0 ||
        pricingReviewCount > 0 ||
        improvementProjectCount > 0 ||
        totalShipments > 0 ||
        purchaseCount > 0 ||
        leadPoCount > 0;

      const wSum = comps.reduce((a, c) => a + c.w, 0);
      const score = hasData && wSum > 0 ? comps.reduce((a, c) => a + c.w * c.v, 0) / wSum : null;
      const grade = score != null ? gradeFromScore(score) : null;

      return {
        vendor: vendorOut(v),
        hasData,
        score: score != null ? Math.round(score * 10) / 10 : null,
        grade,
        onTimePct: onTimePct != null ? Math.round(onTimePct * 10) / 10 : null,
        onTimeShipments,
        totalShipments,
        totalSpend: totalSpend != null ? Math.round(totalSpend * 100) / 100 : null,
        purchaseCount,
        ppvSavings,
        fillRatePct: fillRatePct != null ? Math.round(fillRatePct * 10) / 10 : null,
        materialsFillRatePct: materialsFillRatePct != null ? Math.round(materialsFillRatePct * 10) / 10 : null,
        materialsRollsOrdered: matRollsOrdered,
        materialsRollsReceived: matRollsReceived,
        dataCategory,
        leadTimeAdherencePct: leadTimeAdherencePct != null ? Math.round(leadTimeAdherencePct * 10) / 10 : null,
        avgLeadDays: avgLeadDays != null ? Math.round(avgLeadDays * 10) / 10 : null,
        leadPoCount,
        avgNsLeadDays: avgNsLeadDays != null ? Math.round(avgNsLeadDays * 10) / 10 : null,
        nsLeadPoCount,
        qualityIssueCount,
        openQualityIssueCount,
        pricingReviewCount,
        improvementProjectCount,
        activeImprovementProjectCount,
      };
    });

    res.json({ view, periodStart: start, periodEnd: end, periodLabel: label, netsuiteConnected, labeltraxxConnected, items });
  }),
);

// =====================================================================
// ASL (Approved Supplier List)
// =====================================================================
async function getAslGoal(): Promise<number> {
  const [g] = await db.select().from(globalGoalTable).where(eq(globalGoalTable.id, GLOBAL_KEY));
  return g?.aslVendorGoal ?? DEFAULT_ASL_GOAL;
}
function aslEntryOut(r: typeof aslEntryTable.$inferSelect) {
  return {
    id: r.id,
    vendorId: r.vendorId,
    segment: r.segment,
    status: r.status,
    onboardedOn: r.onboardedOn,
    notes: r.notes,
  };
}
router.get(
  "/asl",
  asyncHandler(async (_req, res) => {
    const [entries, vendors, goal] = await Promise.all([
      db.select().from(aslEntryTable),
      db.select().from(vendorTable),
      getAslGoal(),
    ]);
    const vendorById = new Map(vendors.map((v) => [v.id, v]));
    const rows = entries
      .filter((e) => vendorById.has(e.vendorId))
      .map((e) => ({ entry: aslEntryOut(e), vendor: vendorOut(vendorById.get(e.vendorId)!) }));
    const byName = (a: { vendor: { name: string } }, b: { vendor: { name: string } }) =>
      a.vendor.name.localeCompare(b.vendor.name);
    const rawMaterials = rows.filter((r) => r.entry.segment === "raw_materials").sort(byName);
    const finishedGoods = rows.filter((r) => r.entry.segment === "finished_goods").sort(byName);

    const onboardedVendors = new Set(entries.filter((e) => e.status === "onboarded").map((e) => e.vendorId));
    const allVendors = new Set(entries.map((e) => e.vendorId));

    // Two full tables split by onboarded status:
    //  - aslSuppliers = current approved suppliers (vendor onboarded in any segment)
    //  - pipeline     = Flex Sourcing candidates not yet onboarded
    // Keyed per-vendor (de-duped so a vendor appears once even with two entries).
    const seenAsl = new Set<string>();
    const seenPipeline = new Set<string>();
    const aslSuppliers: typeof rows = [];
    const pipeline: typeof rows = [];
    const sorted = [...rows].sort(byName);
    for (const r of sorted) {
      const vid = r.entry.vendorId;
      if (onboardedVendors.has(vid) && !seenAsl.has(vid)) {
        seenAsl.add(vid);
        aslSuppliers.push(r);
      }
    }
    // Names already approved on the ASL (normalized) — a tracker vendor that
    // matches one of these is a duplicate of an approved supplier and is
    // dropped from the pipeline ("already on the ASL → remove from tracker").
    const aslNames = new Set(aslSuppliers.map((r) => nameNorm(r.vendor.name)));
    for (const r of sorted) {
      const vid = r.entry.vendorId;
      if (onboardedVendors.has(vid)) continue;
      if (seenPipeline.has(vid)) continue;
      if (aslNames.has(nameNorm(r.vendor.name))) continue;
      seenPipeline.add(vid);
      pipeline.push(r);
    }
    res.json({
      goal,
      onboardedCount: onboardedVendors.size,
      totalCount: allVendors.size,
      rawMaterials,
      finishedGoods,
      aslSuppliers,
      pipeline,
    });
  }),
);
router.post(
  "/asl/entries",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const vendorId = s(b.vendorId);
    const segment = s(b.segment);
    if (!vendorId || (segment !== "raw_materials" && segment !== "finished_goods")) {
      return void res.status(400).json({ error: "vendorId and segment (raw_materials|finished_goods) required" });
    }
    const [row] = await db
      .insert(aslEntryTable)
      .values({
        vendorId,
        segment,
        status: s(b.status) ?? "identified",
        onboardedOn: s(b.onboardedOn),
        notes: s(b.notes),
      })
      .onConflictDoUpdate({
        target: [aslEntryTable.vendorId, aslEntryTable.segment],
        set: { status: s(b.status) ?? "identified", onboardedOn: s(b.onboardedOn), notes: s(b.notes), updatedAt: new Date() },
      })
      .returning();
    res.json(aslEntryOut(row!));
  }),
);
router.put(
  "/asl/entries/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const segment = s(b.segment);
    if (segment !== "raw_materials" && segment !== "finished_goods") {
      return void res.status(400).json({ error: "segment (raw_materials|finished_goods) required" });
    }
    const [row] = await db
      .update(aslEntryTable)
      .set({
        segment,
        status: s(b.status) ?? "identified",
        onboardedOn: s(b.onboardedOn),
        notes: s(b.notes),
        updatedAt: new Date(),
      })
      .where(eq(aslEntryTable.id, String(req.params.id)))
      .returning();
    if (!row) return void res.status(404).json({ error: "not found" });
    // Once a vendor is onboarded it belongs on the ASL, not the pipeline:
    // drop any of its remaining non-onboarded (tracker) entries.
    if (row.status === "onboarded") {
      await db
        .delete(aslEntryTable)
        .where(
          and(
            eq(aslEntryTable.vendorId, row.vendorId),
            ne(aslEntryTable.id, row.id),
            ne(aslEntryTable.status, "onboarded"),
          ),
        );
    }
    res.json(aslEntryOut(row));
  }),
);
router.delete(
  "/asl/entries/:id",
  asyncHandler(async (req, res) => {
    await db.delete(aslEntryTable).where(eq(aslEntryTable.id, String(req.params.id)));
    res.status(204).end();
  }),
);
router.put(
  "/asl/goal",
  asyncHandler(async (req, res) => {
    const goal = intOrNull(req.body?.goal);
    if (goal == null || goal < 0) return void res.status(400).json({ error: "goal (non-negative integer) required" });
    await db
      .insert(globalGoalTable)
      .values({ id: GLOBAL_KEY, aslVendorGoal: goal })
      .onConflictDoUpdate({ target: globalGoalTable.id, set: { aslVendorGoal: goal, updatedAt: new Date() } });
    res.json({ goal });
  }),
);

// =====================================================================
// SEED (pre-load from the Flex Sourcing tracker; idempotent by name)
// =====================================================================
type SeedVendor = {
  name: string;
  externalId?: string | null;
  printMethod?: string | null;
  pipelineStatus?: string | null;
  website?: string | null;
  track?: string | null;
  country?: string | null;
  cluster?: string | null;
  category?: string | null;
  subCapability?: string | null;
  tier?: string | null;
  primarySecondary?: string | null;
  stage?: string | null;
  owner?: string | null;
  waveSprint?: string | null;
  ndaDate?: string | null;
  status?: string;
};
const SEED: SeedVendor[] = [
  { name: "DazPak Flexible Packaging", externalId: "FLEX-D-001", printMethod: "Flexographic", pipelineStatus: "Active", website: null, track: "domestic", country: "USA", cluster: "US-CA", category: "Domestic Flexographic", subCapability: "Pouches/rollstock, low MOQ", tier: "T1", primarySecondary: "Primary", stage: "Qualify", owner: "Jake King", waveSprint: "S1", ndaDate: null, status: "in_progress" },
  { name: "Ross Print & Packaging", externalId: "FLEX-D-002", printMethod: "Digital", pipelineStatus: "Active", website: null, track: "domestic", country: "USA", cluster: "US-WA", category: "Domestic Digital", subCapability: "HP Indigo + flexo + labels", tier: "T2", primarySecondary: "Secondary", stage: "Qualify", owner: "Jake King", waveSprint: "S1", ndaDate: null, status: "in_progress" },
  { name: "Morris Packaging", externalId: "FLEX-D-004", printMethod: "Flexographic", pipelineStatus: "Active", website: null, track: "domestic", country: "USA", cluster: "US-IL", category: "Domestic Flexographic", subCapability: "Pouches/roll stock, sustainable films", tier: "T2", primarySecondary: "Secondary", stage: "Identify", owner: "Jake King", waveSprint: "S2", ndaDate: null, status: "identified" },
  { name: "InkWorks Printing", externalId: "FLEX-D-005", printMethod: "Digital", pipelineStatus: "Active", website: null, track: "domestic", country: "USA", cluster: "US-WI", category: "Domestic Digital", subCapability: "PS labels, pouch/mailer print", tier: "T3", primarySecondary: "Secondary", stage: "Identify", owner: "Jake King", waveSprint: "S2", ndaDate: null, status: "identified" },
  { name: "Takigawa Corp. America", externalId: "FLEX-D-007", printMethod: "Rotogravure", pipelineStatus: "Active", website: null, track: "domestic", country: "USA", cluster: "US-KY", category: "Domestic Rotogravure", subCapability: "High-barrier pouches/rollstock", tier: "T1", primarySecondary: "Primary", stage: "Identify", owner: "Jake King", waveSprint: "S3", ndaDate: null, status: "identified" },
  { name: "TedPack Company Ltd.", externalId: "FLEX-I-002", printMethod: "Rotogravure", pipelineStatus: "Active", website: null, track: "international", country: "China", cluster: "Guangdong", category: "International Rotogravure", subCapability: "Custom pouches; ISO/BRCGS/BSCI", tier: "T1", primarySecondary: "Primary", stage: "Identify", owner: "Steven Yao", waveSprint: "S2", ndaDate: null, status: "identified" },
  { name: "Lauterbach Group", externalId: "FLEX-D-003", printMethod: "Digital", pipelineStatus: "Not Contacted", website: "https://www.lauterbachgroup.com/", track: "domestic", country: "USA", cluster: "US-WI", category: "Domestic Digital", subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "Brand my Bags", externalId: "FLEX-D-006", printMethod: "Digital", pipelineStatus: "In Process", website: "https://brandmybags.com/", track: "domestic", country: "USA", cluster: "US-WI", category: "Domestic Digital", subCapability: null, tier: null, primarySecondary: null, stage: null, owner: "Jake King", waveSprint: "S1", ndaDate: "2026-06-24", status: "identified" },
  { name: "Impackt", externalId: "FLEX-D-008", printMethod: "Digital", pipelineStatus: "In Process", website: null, track: "domestic", country: "USA", cluster: "US-CA", category: "Domestic Digital", subCapability: null, tier: null, primarySecondary: null, stage: null, owner: "Jake King", waveSprint: "S1", ndaDate: null, status: "identified" },
  { name: "The Pouch House", externalId: "FLEX-D-009", printMethod: "Digital", pipelineStatus: "Not Contacted", website: "https://www.thepouchhouse.com/", track: "domestic", country: "USA", cluster: "US-MN", category: "Domestic Digital", subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "Dongguan Xueliang Packaging", externalId: "FLEX-I-001", printMethod: "Rotogravure", pipelineStatus: "Not Contacted", website: "http://dgbpack.com/Cases.html", track: "international", country: "China", cluster: "Guangdong", category: "International Digital", subCapability: "CR Pouch — verify digital print", tier: "T3", primarySecondary: "Secondary", stage: "Identify", owner: "Steven Yao", waveSprint: "S1", ndaDate: null, status: "identified" },
  { name: "BowePack (Guangdong Bowe Packaging)", externalId: "FLEX-I-003", printMethod: "Digital / Rotogravure", pipelineStatus: "Not Contacted", website: "https://bowepack.com/", track: "international", country: "China", cluster: "Yunfu City, Guangdong", category: null, subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "Wellfapack (Shantou Wellfa)", externalId: "FLEX-I-004", printMethod: "Rotogravure", pipelineStatus: "Not Contacted", website: "https://wellfapack.com/about-shantou-wellfa-print-pack-co-ltd/", track: "international", country: "China", cluster: "Shantou, Guangdong", category: null, subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "Gozen Packaging", externalId: "FLEX-I-005", printMethod: "Digital / Rotogravure", pipelineStatus: "Not Contacted", website: "https://www.gozenpackaging.com/pcr-packaging-bags/", track: "international", country: "China", cluster: null, category: null, subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "Qiyu Pack", externalId: "FLEX-I-006", printMethod: "Rotogravure", pipelineStatus: "Not Contacted", website: "https://qiyupack.com/", track: "international", country: "China", cluster: null, category: null, subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "Saigon Trapaco", externalId: "FLEX-I-007", printMethod: "Rotogravure", pipelineStatus: "Not Contacted", website: "https://saigontrapaco.com.vn/vi/index.html", track: "international", country: "Vietnam", cluster: "Ho Chi Minh City area", category: null, subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "Ngai Mee Packaging Vietnam", externalId: "FLEX-I-008", printMethod: "Rotogravure", pipelineStatus: "Not Contacted", website: "https://ngaimee.com/", track: "international", country: "Vietnam", cluster: null, category: null, subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "Amiba", externalId: "FLEX-I-009", printMethod: "Rotogravure", pipelineStatus: "Not Contacted", website: "https://amibapack.com/en/product/tui-dung-2/", track: "international", country: "Vietnam", cluster: null, category: null, subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "SIVICO JSC", externalId: "FLEX-I-010", printMethod: "Rotogravure", pipelineStatus: "Not Contacted", website: "https://www.sivico.com.vn/en/contact.html", track: "international", country: "Vietnam", cluster: "Hai Phong", category: null, subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "ASUWANT PACKAGING", externalId: "FLEX-I-011", printMethod: "Digital", pipelineStatus: "In Process", website: "https://www.asuwantpackaging.com/", track: "international", country: "China", cluster: "Jiang Men", category: "International Digital", subCapability: "International Rotogravure + Paper Box", tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "Yiwu Sucheng Packaging", externalId: "TUBE-I-001", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "China", cluster: "East China", category: "Pop-top Tubes", subCapability: "Pop Top Tube", tier: "T2", primarySecondary: "Primary", stage: "Identify", owner: "Steven Yao", waveSprint: "S6", ndaDate: null, status: "identified" },
  { name: "Mitsuiwa Shinko (MTS)", externalId: "TUBE-I-002", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "Taiwan", cluster: "Taiwan", category: "Pop-top Tubes", subCapability: "Paper tube, paper box", tier: "T3", primarySecondary: "Secondary", stage: "Identify", owner: "Steven Yao", waveSprint: "S6", ndaDate: null, status: "identified" },
  { name: "ZAAM INTERNATIONAL CO., LTD", externalId: "TUBE-I-003", printMethod: "Maybe Broker?", pipelineStatus: "Not Contacted", website: null, track: "international", country: "Vietnam", cluster: null, category: null, subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "JK Packaging", externalId: "TUBE-I-004", printMethod: null, pipelineStatus: "Not Contacted", website: "https://jk-packaging.com/", track: "international", country: "China", cluster: null, category: null, subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "Dewei Plastics", externalId: "TUBE-I-005", printMethod: null, pipelineStatus: "Not Contacted", website: "https://www.dwplastic.com/", track: "international", country: "China", cluster: null, category: null, subCapability: null, tier: null, primarySecondary: null, stage: null, owner: null, waveSprint: null, ndaDate: null, status: "identified" },
  { name: "TinWonder (Dongguan)", externalId: "TIN-I-001", printMethod: null, pipelineStatus: "Early Conversations", website: null, track: "international", country: "China", cluster: "Guangdong", category: "Tins", subCapability: "Tinplate boxes & cans, 2,000+ molds", tier: "T1", primarySecondary: "Primary", stage: "Identify", owner: "Steven Yao", waveSprint: "S5", ndaDate: null, status: "identified" },
  { name: "Andylots Tin Box", externalId: "TIN-I-002", printMethod: null, pipelineStatus: "Early Conversations", website: null, track: "international", country: "China", cluster: "Guangdong", category: "Tins", subCapability: "CR tins for cannabis", tier: "T1", primarySecondary: "Primary", stage: "Identify", owner: "Steven Yao", waveSprint: "S5", ndaDate: null, status: "identified" },
  { name: "Dongguan Lianglvfang", externalId: "TIN-I-003", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "China", cluster: "Guangdong", category: "Tins", subCapability: "Tin CR/Non-CR, Slide Tin CR", tier: "T2", primarySecondary: "Secondary", stage: "Identify", owner: "Steven Yao", waveSprint: "S5", ndaDate: null, status: "identified" },
  { name: "Dongguan Xinyu Tin Can", externalId: "TIN-I-004", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "China", cluster: "Guangdong", category: "Tins", subCapability: "Tin", tier: "T3", primarySecondary: "Secondary", stage: "Identify", owner: "Steven Yao", waveSprint: "S5", ndaDate: null, status: "identified" },
  { name: "Foshan Yuelida Metal Cap", externalId: "TIN-I-005", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "China", cluster: "Guangdong", category: "Tins", subCapability: "Tin", tier: "T3", primarySecondary: "Secondary", stage: "Identify", owner: "Steven Yao", waveSprint: "S6", ndaDate: null, status: "identified" },
  { name: "Paulin Vina", externalId: "TIN-I-006", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "Vietnam", cluster: "Vietnam", category: "Tins", subCapability: "Tin (Vietnam tariff hedge)", tier: "T2", primarySecondary: "Secondary", stage: "Identify", owner: "Steven Yao", waveSprint: "S6", ndaDate: null, status: "identified" },
  { name: "California Packaging & Display", externalId: "BOX-D-001", printMethod: null, pipelineStatus: "Different Scope/ Not Contacted", website: null, track: "domestic", country: "USA", cluster: "US-CA", category: "Boxes (SBS/Display)", subCapability: "Folding cartons, POP displays", tier: "T1", primarySecondary: "Primary", stage: "Identify", owner: "Jake King", waveSprint: "S7", ndaDate: null, status: "identified" },
  { name: "Virtual Packaging", externalId: "BOX-D-002", printMethod: null, pipelineStatus: "Active", website: null, track: "domestic", country: "USA", cluster: "US-TX", category: "Boxes (Rigid/CR)", subCapability: "Rigid boxes, CR, prototyping", tier: "T2", primarySecondary: "Secondary", stage: "Identify", owner: "Jake King", waveSprint: "S7", ndaDate: null, status: "identified" },
  { name: "Dongguan Fuyang Printing", externalId: "BOX-I-001", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "China", cluster: "Guangdong", category: "Boxes (Rigid/CR)", subCapability: "Paper/CR/Rigid/Magnetic box", tier: "T2", primarySecondary: "Primary", stage: "Identify", owner: "Steven Yao", waveSprint: "S7", ndaDate: null, status: "identified" },
  { name: "TaPuMei Printing", externalId: "BOX-I-002", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "China", cluster: "Guangdong", category: "Boxes (Rigid/CR)", subCapability: "CR/Set-up/Flat/Magnetic box", tier: "T2", primarySecondary: "Secondary", stage: "Identify", owner: "Steven Yao", waveSprint: "S7", ndaDate: null, status: "identified" },
  { name: "Intramedia Dongguan", externalId: "BOX-I-003", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "China", cluster: "Guangdong", category: "Boxes (Rigid/CR)", subCapability: "CR/Flat/Setup box", tier: "T3", primarySecondary: "Secondary", stage: "Identify", owner: "Steven Yao", waveSprint: "S7", ndaDate: null, status: "identified" },
  { name: "Intramedia Minh Duc", externalId: "BOX-I-004", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "Vietnam", cluster: "Vietnam", category: "Boxes (SBS/Display)", subCapability: "Paper box (Vietnam)", tier: "T3", primarySecondary: "Secondary", stage: "Identify", owner: "Steven Yao", waveSprint: "S7", ndaDate: null, status: "identified" },
  { name: "Putian Jusheng Packing", externalId: "BOX-I-005", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "China", cluster: "Fujian", category: "Boxes (SBS/Display)", subCapability: "Paper box, shopping bag", tier: "T3", primarySecondary: "Secondary", stage: "Identify", owner: "Steven Yao", waveSprint: "S8", ndaDate: null, status: "identified" },
  { name: "Zhongshan Daqian Display", externalId: "BOX-I-006", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "China", cluster: "Guangdong", category: "Boxes (SBS/Display)", subCapability: "Pedestal display", tier: "T3", primarySecondary: "Secondary", stage: "Identify", owner: "Steven Yao", waveSprint: "S8", ndaDate: null, status: "identified" },
  { name: "Ningbo Brothers Printing", externalId: "LBL-I-001", printMethod: null, pipelineStatus: "Not Contacted", website: null, track: "international", country: "China", cluster: "East China", category: "Labels", subCapability: "Label printing (beachhead pair)", tier: "T3", primarySecondary: "Secondary", stage: "Identify", owner: "Steven Yao", waveSprint: "S2", ndaDate: null, status: "identified" },
];
router.post(
  "/vendors/seed",
  asyncHandler(async (_req, res) => {
    const [existing, entries] = await Promise.all([
      db.select().from(vendorTable),
      db.select().from(aslEntryTable),
    ]);
    const byName = new Map(existing.map((v) => [v.name.toLowerCase(), v]));
    const onboarded = new Set(
      entries.filter((e) => e.status === "onboarded").map((e) => e.vendorId),
    );
    // Tracker-derived fields, shared by insert and update of pipeline vendors.
    const trackerFields = (sv: SeedVendor) => ({
      externalId: sv.externalId ?? null,
      printMethod: sv.printMethod ?? null,
      pipelineStatus: sv.pipelineStatus ?? null,
      website: sv.website ?? null,
      track: sv.track ?? null,
      country: sv.country ?? null,
      cluster: sv.cluster ?? null,
      category: sv.category ?? null,
      subCapability: sv.subCapability ?? null,
      tier: sv.tier ?? null,
      primarySecondary: sv.primarySecondary ?? null,
      stage: sv.stage ?? null,
      owner: sv.owner ?? null,
      waveSprint: sv.waveSprint ?? null,
      ndaDate: sv.ndaDate ?? null,
    });
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const sv of SEED) {
      const match = byName.get(sv.name.toLowerCase());
      if (match) {
        // Never overwrite an already-onboarded (current ASL) supplier.
        if (onboarded.has(match.id)) {
          skipped++;
          continue;
        }
        await db
          .update(vendorTable)
          .set({ ...trackerFields(sv), updatedAt: new Date() })
          .where(eq(vendorTable.id, match.id));
        await db
          .insert(aslEntryTable)
          .values({ vendorId: match.id, segment: "finished_goods", status: sv.status ?? "identified" })
          .onConflictDoNothing();
        updated++;
        continue;
      }
      const [v] = await db
        .insert(vendorTable)
        .values({ name: sv.name, ...trackerFields(sv) })
        .returning();
      // Flex Sourcing tracker = finished-goods packaging suppliers.
      await db
        .insert(aslEntryTable)
        .values({ vendorId: v!.id, segment: "finished_goods", status: sv.status ?? "identified" })
        .onConflictDoNothing();
      created++;
    }
    res.json({ created, updated, skipped });
  }),
);

// =====================================================================
// CURRENT ASL (detailed active Approved Supplier List, from Vendor List).
// These are already-approved suppliers (status = onboarded). Loaded
// separately from the new-vendor pipeline; idempotent, matched by name.
// =====================================================================
type AslSeedVendor = {
  name: string;
  segment: "raw_materials" | "finished_goods";
  category: string | null;
  tier: string | null;
  subCategory: string | null;
  capabilities: string | null;
  locations: string | null;
  calyxPoc: string | null;
  vendorPoc: string | null;
  vendorPocPhone: string | null;
  vendorPocEmail: string | null;
};
const ASL_SEED: AslSeedVendor[] = [
  { name: "American Durafilm", segment: "finished_goods", category: "Finished Goods Components", tier: "Tier 5", subCategory: "FEP Forming", capabilities: "FEP Film\nSheeting\nDie Cutting\nThermoforming", locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Mitchel Mei", vendorPocPhone: "508-429-8000", vendorPocEmail: "jgoodwin@americandurafilm.com" },
  { name: "Avery Dennison Corporation", segment: "raw_materials", category: "Raw Materials - Labels", tier: "Tier 2", subCategory: "Facestock", capabilities: "Roll Stock Label Material\nMinimal Flexible packaging Materials", locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Ashleigh Kosanka", vendorPocPhone: "419-618-5965", vendorPocEmail: "Ashleigh.kosanka@averydennison.com" },
  { name: "Compax Packaging", segment: "finished_goods", category: "Finished Goods - Rigid", tier: "Tier 5", subCategory: "Injection molding", capabilities: "Injection Molding", locations: "Salt Lake City, UT", calyxPoc: "Cory Timmons", vendorPoc: "Danelle Devine\nLucinda Blackburn", vendorPocPhone: "801-440-0581\n208-313-1533", vendorPocEmail: "danelle@compaxpackaging.com, lblackburn@compaxpackaging.com" },
  { name: "H. Loeb Corporation", segment: "finished_goods", category: "Finished Goods Components", tier: "Tier 3", subCategory: "FEP Die Cutting", capabilities: "Die cutting\nCNC Routing\nLaser Cutting", locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Geoffrey Faucher", vendorPocPhone: "508 944-8629", vendorPocEmail: "gfaucher@hloeb.com" },
  { name: "HP Indigo", segment: "raw_materials", category: "Raw Materials - Labels", tier: null, subCategory: "Ink", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Zak Callahan", vendorPocPhone: "858-449-6969", vendorPocEmail: "zak.callahan@hp.com" },
  { name: "MACTAC (Morgan Adhesives Co LLC)", segment: "raw_materials", category: "Raw Materials - Labels", tier: "Tier 2", subCategory: "Facestock", capabilities: "Roll Stock Label Material", locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Duane Stevenson", vendorPocPhone: "916-715-9332", vendorPocEmail: "orders@mactac.com" },
  { name: "Propeller Warehouse Inc", segment: "finished_goods", category: "Finished Goods Components", tier: null, subCategory: "FEP Insert", capabilities: "Kitting/ Assembly\n3PL Services", locations: "Santiquin, UT", calyxPoc: "Cory Timmons", vendorPoc: "Avery Christensen", vendorPocPhone: "801-592-1805", vendorPocEmail: "avery@propellerinc.com" },
  { name: "Rotometrics/ Maxacess", segment: "raw_materials", category: "Raw Materials", tier: null, subCategory: "Die", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Phil Taylor", vendorPocPhone: "909-957-2128", vendorPocEmail: null },
  { name: "Virtual Packaging", segment: "finished_goods", category: "Finished Goods", tier: "Tier 3", subCategory: "Boxes", capabilities: "Digital Box Printing/ converting\nSpot Varnish\nFoil", locations: "Grapevine, TX", calyxPoc: "Cory Timmons", vendorPoc: "Jodie Echols", vendorPocPhone: "817-714-7129", vendorPocEmail: "jodie@virtualpackaging.com" },
  { name: "Dazpak", segment: "finished_goods", category: "Finished Goods", tier: "Tier 3", subCategory: "Flexible Packaging", capabilities: "Flexographic Printing\nFlexible Packaging Converting\n - K Seal\n - 3 side seal (Top/Bottom)\n - CR Zipper\n - Non CR Zipper\nInolok Zipper\nBox Pouch Converting\nStorage Available\nSlitting\nLaminating", locations: "Southern California\nColumbus, Ohio", calyxPoc: "Cory Timmons", vendorPoc: "Kevin Vance", vendorPocPhone: "916-716-7907", vendorPocEmail: "kvance@dazpak.com" },
  { name: "Ross Print and Packaging", segment: "finished_goods", category: "Finished Goods", tier: "Tier 3", subCategory: "Flexible Packaging", capabilities: "Mid-web Digital Printing\nLamination\nSpot Varnish\nFlexible Packaging Converting", locations: "Spokane, WA", calyxPoc: "Cory Timmons", vendorPoc: "Kerry Ann Kauder", vendorPocPhone: "509-954-5844", vendorPocEmail: "kkauder@rossprint.com" },
  { name: "Print Rush LLC", segment: "finished_goods", category: "Finished Goods", tier: null, subCategory: "Flexible Packaging", capabilities: "Mid-web Digital Printing\nLamination", locations: "Orem, UT", calyxPoc: "Cory Timmons", vendorPoc: "Hugh Olmstead", vendorPocPhone: "801-845-6525", vendorPocEmail: "hugh@printrush.net" },
  { name: "Source One Packaging", segment: "finished_goods", category: "Finished Goods", tier: "Tier 4", subCategory: "Shrink Bands", capabilities: "Shrink Sleeves\nFlexographic Flexpack\nDessicants", locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Nick Griffo", vendorPocPhone: "631-258-3073", vendorPocEmail: "ng@sourceonepackagingllc.com" },
  { name: "Sun Centre USA Inc", segment: "finished_goods", category: "Finished Goods", tier: "Tier 2", subCategory: "Converting", capabilities: "Flexible Packaging Converting\n - K Seal\n - 3 side seal (Top/Bottom)\n - CR Zipper\n - Non CR Zipper", locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Sean Pease", vendorPocPhone: "224-699-9058", vendorPocEmail: "cust.serv@suncentre.us" },
  { name: "Nobelus, LLC", segment: "raw_materials", category: "Raw Materials", tier: "Tier 2", subCategory: "Laminate", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Sara Perry", vendorPocPhone: null, vendorPocEmail: "sara.perry@nobelus.com" },
  { name: "ACTEGA North America, Inc.", segment: "raw_materials", category: "Raw Materials", tier: null, subCategory: "Varinish/ Primer", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Marc Pittier", vendorPocPhone: "925-451-1960", vendorPocEmail: "marc.pittier@altana.com" },
  { name: "CTI", segment: "raw_materials", category: "Raw Materials", tier: null, subCategory: "Ink", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Tracy Lewis", vendorPocPhone: "719-592-1557", vendorPocEmail: "tlewis@ctiinks.com" },
  { name: "Inhance Technologies LLC", segment: "raw_materials", category: "Raw Materials", tier: "Tier 3", subCategory: "Flourination", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Chris Ridenour", vendorPocPhone: "281-813-8144", vendorPocEmail: "cridenour@inhancetechnologies.com" },
  { name: "JetFx Inc.", segment: "raw_materials", category: "Raw Materials", tier: null, subCategory: "Varinish/ Primer", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Chris Padilla", vendorPocPhone: null, vendorPocEmail: "consumables@jetfx.com" },
  { name: "K LASER TECHNOLOGY (USA) CO., LTD.", segment: "raw_materials", category: "Raw Materials", tier: "Tier 2", subCategory: "Foil", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Richard Jackson", vendorPocPhone: "561-373-0251", vendorPocEmail: "richardj@coldfoil.com" },
  { name: "Kurz", segment: "raw_materials", category: "Raw Materials", tier: null, subCategory: "Foil", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Michael Aumann", vendorPocPhone: "704-519-6391", vendorPocEmail: "Michael.Aumann@kurzusa.com" },
  { name: "Pacific Color", segment: "raw_materials", category: "Raw Materials", tier: null, subCategory: "Plate", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Jason Jordan", vendorPocPhone: "801-721-6355", vendorPocEmail: "sales@pacificolor.com" },
  { name: "S-One", segment: "raw_materials", category: "Raw Materials", tier: "Tier 2", subCategory: "Varinish/ Primer", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Haley Hollister", vendorPocPhone: "941-866-6125", vendorPocEmail: null },
  { name: "Siegwerk Environmental Inks", segment: "raw_materials", category: "Raw Materials", tier: null, subCategory: "Varinish/ Primer", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Jake Melcher", vendorPocPhone: "719-332-1920", vendorPocEmail: "jake.melcher@siegwerk.com" },
  { name: "Spectragraphics", segment: "finished_goods", category: "Finished Goods", tier: "Tier 3", subCategory: "Labels", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Erik Rodriguez", vendorPocPhone: null, vendorPocEmail: "erikr@spectragraphics.com" },
  { name: "Wellpac (Brokered through Compax)", segment: "finished_goods", category: "Finished Goods", tier: null, subCategory: "Injection molding", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Danelle Devine\nLucinda Blackburn", vendorPocPhone: "801-440-0581\n208-313-1533", vendorPocEmail: "danelle@compaxpackaging.com, lblackburn@compaxpackaging.com" },
  { name: "Wink", segment: "raw_materials", category: "Raw Materials", tier: null, subCategory: "Die", capabilities: null, locations: null, calyxPoc: "Cory Timmons", vendorPoc: "Dreana Helmick", vendorPocPhone: "704-804-3220", vendorPocEmail: "dreanah@wink-us.com" },
  { name: "Reynolds Packaging LLC", segment: "finished_goods", category: "Finished Goods", tier: "Tier 3", subCategory: "Flexible Packaging", capabilities: "Flexible Packaging Converting\n - K Seal\n - 3 side seal (Top/Bottom)\n - CR Zipper\n - Non CR Zipper", locations: "Green Bay, WI", calyxPoc: "Cory Timmons", vendorPoc: null, vendorPocPhone: null, vendorPocEmail: null },
];
// Generic words stripped when matching supplier names to existing vendors so
// e.g. "DazPak Flexible Packaging" (tracker) matches "Dazpak" (ASL).
const NAME_STOPWORDS = new Set([
  "flexible", "packaging", "package", "company", "companies", "inc", "llc",
  "corp", "corporation", "co", "ltd", "group", "the", "printing", "print",
  "and", "technology", "technologies", "usa", "north", "america", "american",
]);
function nameNorm(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function nameCore(name: string): string {
  return nameNorm(name)
    .split(" ")
    .filter((w) => w && !NAME_STOPWORDS.has(w))
    .join(" ");
}
router.post(
  "/vendors/seed-asl",
  asyncHandler(async (_req, res) => {
    const existing = await db.select().from(vendorTable);
    // Exact normalized-name index (authoritative match).
    const byNorm = new Map<string, VendorRow>();
    for (const v of existing) byNorm.set(nameNorm(v.name), v);
    // Core index for fuzzy match; track ambiguity so colliding cores never
    // silently merge two distinct vendors.
    const byCore = new Map<string, VendorRow>();
    const ambiguousCores = new Set<string>();
    for (const v of existing) {
      const c = nameCore(v.name);
      if (!c) continue;
      if (byCore.has(c) && byCore.get(c)!.id !== v.id) ambiguousCores.add(c);
      else byCore.set(c, v);
    }
    let created = 0;
    let updated = 0;
    for (const sv of ASL_SEED) {
      const detail = {
        category: sv.category,
        tier: sv.tier,
        stage: "Active",
        subCategory: sv.subCategory,
        capabilities: sv.capabilities,
        locations: sv.locations,
        calyxPoc: sv.calyxPoc,
        vendorPoc: sv.vendorPoc,
        vendorPocPhone: sv.vendorPocPhone,
        vendorPocEmail: sv.vendorPocEmail,
      };
      const norm = nameNorm(sv.name);
      const core = nameCore(sv.name);
      // Prefer exact normalized match; fall back to a non-ambiguous core match.
      const match = byNorm.get(norm) ?? (core && !ambiguousCores.has(core) ? byCore.get(core) : undefined);
      let vendorId: string;
      if (match) {
        await db
          .update(vendorTable)
          .set({ ...detail, updatedAt: new Date() })
          .where(eq(vendorTable.id, match.id));
        vendorId = match.id;
        updated++;
      } else {
        const [v] = await db
          .insert(vendorTable)
          .values({ name: sv.name, country: "USA", ...detail })
          .returning();
        vendorId = v!.id;
        byNorm.set(norm, v!);
        if (core) byCore.set(core, v!);
        created++;
      }
      // Active suppliers are already approved → onboarded in their segment.
      await db
        .insert(aslEntryTable)
        .values({ vendorId, segment: sv.segment, status: "onboarded" })
        .onConflictDoUpdate({
          target: [aslEntryTable.vendorId, aslEntryTable.segment],
          set: { status: "onboarded", updatedAt: new Date() },
        });
    }
    res.json({ created, updated });
  }),
);

// =====================================================================
// NETSUITE (read-only on-time shipment sync)
// =====================================================================
router.get(
  "/vendors/netsuite/status",
  asyncHandler(async (_req, res) => {
    if (!netsuiteConfigured()) {
      return void res.json({ configured: false, connected: false });
    }
    try {
      const ping = await netsuitePing();
      res.json({ configured: true, connected: true, vendorCount: ping.vendorCount });
    } catch (e) {
      res.json({ configured: true, connected: false, error: e instanceof Error ? e.message : String(e) });
    }
  }),
);

// Normalize a vendor name for matching: lowercase, treat "&" and "and" as
// equivalent (so "Ross Print & Packaging" == "Ross Print and Packaging"),
// and collapse remaining punctuation/whitespace.
function normVendorName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Canonical normalization for user-defined aliases. Stable & source-agnostic so
// the same raw string saved as an alias resolves on both NetSuite and Label
// Traxx syncs. lowercase, treat "&"=="and", collapse punctuation/whitespace.
function normAliasName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Load all saved aliases as a normalized-name -> vendor lookup. A name that
// matches an alias is attributed to that vendor before any fuzzy matching runs.
async function loadAliasMap(vendors: VendorRow[]): Promise<Map<string, VendorRow>> {
  const byId = new Map(vendors.map((v) => [v.id, v]));
  const rows = await db.select().from(vendorAliasTable);
  const map = new Map<string, VendorRow>();
  for (const r of rows) {
    const v = byId.get(r.vendorId);
    if (v) map.set(r.normAlias, v);
  }
  return map;
}

// Persist alias usage after a sync: for every alias that resolved at least one
// source name this run, stamp lastUsedAt to now and overwrite lastHitCount with
// the number of rows it matched. Aliases not hit this run are left untouched so
// a prior lastUsedAt remains visible. Keyed by normAlias (unique per alias).
async function recordAliasHits(hits: Map<string, number>): Promise<void> {
  if (hits.size === 0) return;
  const now = new Date();
  await Promise.all(
    [...hits.entries()].map(([normAlias, count]) =>
      db
        .update(vendorAliasTable)
        .set({ lastUsedAt: now, lastHitCount: count })
        .where(eq(vendorAliasTable.normAlias, normAlias)),
    ),
  );
}

function matchVendor(
  name: string | null,
  vendors: VendorRow[],
  aliases?: Map<string, VendorRow>,
  onAliasHit?: (normAlias: string) => void,
): VendorRow | null {
  if (!name) return null;
  // User-defined alias wins over automatic matching.
  if (aliases) {
    const norm = normAliasName(name);
    const a = aliases.get(norm);
    if (a) {
      onAliasHit?.(norm);
      return a;
    }
  }
  const n = normVendorName(name);
  if (!n) return null;
  // exact (normalized), then containment
  let m = vendors.find((v) => normVendorName(v.name) === n);
  if (m) return m;
  m = vendors.find((v) => {
    const vn = normVendorName(v.name);
    return !!vn && (vn.includes(n) || n.includes(vn));
  });
  return m ?? null;
}

// Map an unmatched source name to an existing vendor by saving an alias, so the
// next sync attributes that name automatically. Optionally re-attribute already
// synced rows that carry the raw supplier name (Label Traxx lead times).
router.post(
  "/vendors/aliases",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const name = s(b.name);
    const vendorId = s(b.vendorId);
    if (!name || !vendorId) return void res.status(400).json({ error: "name and vendorId required" });
    const norm = normAliasName(name);
    if (!norm) return void res.status(400).json({ error: "name is empty after normalization" });
    const [vendor] = await db.select().from(vendorTable).where(eq(vendorTable.id, vendorId));
    if (!vendor) return void res.status(404).json({ error: "vendor not found" });

    const [row] = await db
      .insert(vendorAliasTable)
      .values({ vendorId, alias: name, normAlias: norm })
      .onConflictDoUpdate({
        target: [vendorAliasTable.normAlias],
        set: { vendorId, alias: name },
      })
      .returning();

    res.json({ id: row!.id, vendorId: row!.vendorId, alias: row!.alias });
  }),
);

// List all saved vendor-name aliases (raw name -> mapped vendor), joined to the
// vendor so the management UI can show the mapped vendor name. Aliases whose
// vendor was deleted are skipped.
router.get(
  "/vendors/aliases",
  asyncHandler(async (_req, res) => {
    const [rows, vendors] = await Promise.all([
      db.select().from(vendorAliasTable),
      db.select().from(vendorTable),
    ]);
    const byId = new Map(vendors.map((v) => [v.id, v]));
    const items = rows
      .map((r) => {
        const v = byId.get(r.vendorId);
        if (!v) return null;
        return {
          id: r.id,
          alias: r.alias,
          vendorId: r.vendorId,
          vendorName: v.name,
          createdAt: r.createdAt.toISOString(),
          lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
          lastHitCount: r.lastHitCount,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => a.alias.localeCompare(b.alias));
    res.json({ items });
  }),
);

// Re-point an existing alias to a different vendor. Used by the management UI to
// fix a wrong mapping without deleting and re-creating it.
router.put(
  "/vendors/aliases/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const vendorId = s(b.vendorId);
    if (!vendorId) return void res.status(400).json({ error: "vendorId required" });
    const [vendor] = await db.select().from(vendorTable).where(eq(vendorTable.id, vendorId));
    if (!vendor) return void res.status(404).json({ error: "vendor not found" });
    const [row] = await db
      .update(vendorAliasTable)
      .set({ vendorId })
      .where(eq(vendorAliasTable.id, String(req.params.id)))
      .returning();
    if (!row) return void res.status(404).json({ error: "alias not found" });
    res.json({ id: row.id, vendorId: row.vendorId, alias: row.alias });
  }),
);

// Delete a saved alias so the name no longer auto-resolves on future syncs.
router.delete(
  "/vendors/aliases/:id",
  asyncHandler(async (req, res) => {
    await db.delete(vendorAliasTable).where(eq(vendorAliasTable.id, String(req.params.id)));
    res.status(204).end();
  }),
);

router.post(
  "/vendors/netsuite/sync",
  asyncHandler(async (_req, res) => {
    if (!netsuiteConfigured()) {
      return void res.status(400).json({ error: "NetSuite credentials are not configured" });
    }
    const { rows, truncated } = await fetchPurchaseShipments();
    const vendors = await db.select().from(vendorTable);
    const aliases = await loadAliasMap(vendors);

    let upserted = 0;
    let unmatched = 0;
    const unmatchedNames = new Set<string>();
    const aliasHits = new Map<string, number>();
    const bumpAlias = (norm: string) => aliasHits.set(norm, (aliasHits.get(norm) ?? 0) + 1);

    for (const r of rows) {
      const vendor = matchVendor(r.vendorName, vendors, aliases, bumpAlias);
      if (!vendor) {
        unmatched++;
        if (r.vendorName) unmatchedNames.add(r.vendorName);
        continue;
      }
      const onTime =
        r.customerDate != null && r.actualShipDate != null ? r.actualShipDate <= r.customerDate : null;
      await db
        .insert(vendorShipmentTable)
        .values({
          vendorId: vendor.id,
          orderNo: r.orderId,
          customerDate: r.customerDate,
          actualShipDate: r.actualShipDate,
          onTime,
          poDate: r.poDate,
          qtyOrdered: r.qtyOrdered,
          qtyShipped: r.qtyShipped,
          source: "netsuite",
        })
        .onConflictDoUpdate({
          target: [vendorShipmentTable.vendorId, vendorShipmentTable.orderNo],
          set: {
            customerDate: r.customerDate,
            actualShipDate: r.actualShipDate,
            onTime,
            poDate: r.poDate,
            qtyOrdered: r.qtyOrdered,
            qtyShipped: r.qtyShipped,
            syncedAt: new Date(),
          },
        });
      upserted++;
    }

    // Also refresh total-spend data: NetSuite Vendor Bills per vendor (all
    // vendors, not just SO-linked), so bill-only vendors still show spend.
    let purchasesUpserted = 0;
    let purchasesTruncated = false;
    try {
      const { rows: purchaseRows, truncated: pTrunc } = await fetchVendorPurchases();
      purchasesTruncated = pTrunc;
      // Full mirror of NetSuite: clear prior NetSuite-sourced purchases first so
      // re-attribution (vendor name corrections) or removed POs can't leave
      // stale rows that double-count spend.
      await db.delete(vendorPurchaseTable).where(eq(vendorPurchaseTable.source, "netsuite"));
      for (const p of purchaseRows) {
        const vendor = matchVendor(p.vendorName, vendors, aliases, bumpAlias);
        if (!vendor) {
          if (p.vendorName) unmatchedNames.add(p.vendorName);
          continue;
        }
        await db
          .insert(vendorPurchaseTable)
          .values({
            vendorId: vendor.id,
            orderNo: p.orderId,
            poDate: p.poDate,
            amount: p.amount,
            source: "netsuite",
          })
          .onConflictDoUpdate({
            target: [vendorPurchaseTable.vendorId, vendorPurchaseTable.orderNo],
            set: { poDate: p.poDate, amount: p.amount, syncedAt: new Date() },
          });
        purchasesUpserted++;
      }
    } catch (e) {
      console.warn(
        "NetSuite vendor purchase fetch failed; total spend will be stale:",
        e instanceof Error ? e.message : String(e),
      );
    }

    await recordAliasHits(aliasHits);

    res.json({
      fetched: rows.length,
      upserted,
      unmatched,
      truncated: truncated || purchasesTruncated,
      purchasesUpserted,
      unmatchedVendors: Array.from(unmatchedNames).slice(0, 50),
    });
  }),
);

// Sync NetSuite support cases as vendor quality cases (READ-ONLY from NetSuite).
router.post(
  "/vendors/netsuite/quality-sync",
  asyncHandler(async (_req, res) => {
    if (!netsuiteConfigured()) {
      return void res.status(400).json({ error: "NetSuite credentials are not configured" });
    }
    const rows = await fetchVendorQualityCases();
    const vendors = await db.select().from(vendorTable);
    const aliases = await loadAliasMap(vendors);

    let upserted = 0;
    let unmatched = 0;
    const unmatchedNames = new Set<string>();
    const seenKeys = new Set<string>();
    const aliasHits = new Map<string, number>();
    const bumpAlias = (norm: string) => aliasHits.set(norm, (aliasHits.get(norm) ?? 0) + 1);

    for (const r of rows) {
      const vendor = matchVendor(r.vendorName, vendors, aliases, bumpAlias);
      if (!vendor) {
        unmatched++;
        unmatchedNames.add(r.vendorName);
        continue;
      }
      // A case can map to one vendor via several SOs; keep the first row only.
      const key = `${vendor.id}:${r.caseId}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      await db
        .insert(vendorQualityCaseTable)
        .values({
          vendorId: vendor.id,
          caseId: r.caseId,
          caseNumber: r.caseNumber,
          subject: r.subject,
          statusName: r.statusName,
          openCase: r.openCase,
          soTranid: r.soTranid,
          poNumber: r.poNumber,
          caseUrl: r.caseUrl,
          startDate: r.startDate,
        })
        .onConflictDoUpdate({
          target: [vendorQualityCaseTable.vendorId, vendorQualityCaseTable.caseId],
          set: {
            caseNumber: r.caseNumber,
            subject: r.subject,
            statusName: r.statusName,
            openCase: r.openCase,
            soTranid: r.soTranid,
            poNumber: r.poNumber,
            caseUrl: r.caseUrl,
            startDate: r.startDate,
            syncedAt: new Date(),
          },
        });
      upserted++;
    }

    await recordAliasHits(aliasHits);

    res.json({
      fetched: rows.length,
      upserted,
      unmatched,
      unmatchedVendors: Array.from(unmatchedNames).slice(0, 50),
    });
  }),
);

// =====================================================================
// LABEL TRAXX (read-only PO lead-time sync)
// =====================================================================

// Normalize a supplier / vendor name for fuzzy matching: lowercase, strip
// punctuation, drop common corporate suffixes / filler words.
function normSupplierName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|llc|corp|corporation|co|ltd|limited|company|companies|products|product|usa|lp|the|group|holdings|brands)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface NormVendor {
  v: VendorRow;
  norm: string;
  tokens: Set<string>;
}

// Match a Label Traxx Supplier string to a vendor record. Tries exact, then
// substring containment, then token overlap (anchored on the supplier's first
// token to avoid spurious matches). Returns null when no confident match.
function matchSupplier(
  name: string,
  normVendors: NormVendor[],
  aliases?: Map<string, VendorRow>,
  onAliasHit?: (normAlias: string) => void,
): VendorRow | null {
  // User-defined alias wins over automatic matching.
  if (aliases) {
    const norm = normAliasName(name);
    const a = aliases.get(norm);
    if (a) {
      onAliasHit?.(norm);
      return a;
    }
  }
  const n = normSupplierName(name);
  if (!n) return null;
  for (const nv of normVendors) if (nv.norm && nv.norm === n) return nv.v;
  for (const nv of normVendors) {
    if (!nv.norm) continue;
    if (nv.norm.includes(n) || n.includes(nv.norm)) return nv.v;
  }
  const nTokens = n.split(" ").filter(Boolean);
  if (nTokens.length === 0) return null;
  const firstTok = nTokens[0]!;
  let best: VendorRow | null = null;
  let bestScore = 0;
  for (const nv of normVendors) {
    if (!nv.tokens.has(firstTok)) continue;
    const inter = nTokens.filter((t) => nv.tokens.has(t)).length;
    if (inter === 0) continue;
    const score = inter / Math.min(nTokens.length, nv.tokens.size);
    if (score > bestScore) {
      bestScore = score;
      best = nv.v;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

router.post(
  "/vendors/labeltraxx/sync",
  asyncHandler(async (req, res) => {
    const since = s(req.query.since);
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return void res.status(400).json({ error: "since must be a YYYY-MM-DD date" });
    }
    const rows = await fetchPoLeadTimeRows(since ?? undefined);
    const vendors = await db.select().from(vendorTable);
    const normVendors: NormVendor[] = vendors.map((v) => {
      const norm = normSupplierName(v.name);
      return { v, norm, tokens: new Set(norm.split(" ").filter(Boolean)) };
    });
    const aliases = await loadAliasMap(vendors);

    let upserted = 0;
    let unmatched = 0;
    const unmatchedNames = new Map<string, number>();
    const aliasHits = new Map<string, number>();
    const bumpAlias = (norm: string) => aliasHits.set(norm, (aliasHits.get(norm) ?? 0) + 1);

    for (const r of rows) {
      const vendor = matchSupplier(r.supplierName, normVendors, aliases, bumpAlias);
      if (!vendor) {
        unmatched++;
        unmatchedNames.set(r.supplierName, (unmatchedNames.get(r.supplierName) ?? 0) + 1);
        continue;
      }
      await db
        .insert(vendorLeadTimeTable)
        .values({
          vendorId: vendor.id,
          poNumber: r.poNumber,
          supplierName: r.supplierName,
          placedDate: r.placedDate,
          receivedDate: r.receivedDate,
          leadDays: r.leadDays,
          orderedRolls: r.orderedRolls,
          receivedRolls: r.receivedRolls,
          source: "labeltraxx",
        })
        .onConflictDoUpdate({
          target: [vendorLeadTimeTable.source, vendorLeadTimeTable.poNumber],
          set: {
            vendorId: vendor.id,
            supplierName: r.supplierName,
            placedDate: r.placedDate,
            receivedDate: r.receivedDate,
            leadDays: r.leadDays,
            orderedRolls: r.orderedRolls,
            receivedRolls: r.receivedRolls,
            syncedAt: new Date(),
          },
        });
      upserted++;
    }

    const unmatchedSuppliers = [...unmatchedNames.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([name, count]) => ({ name, count }));

    await recordAliasHits(aliasHits);

    res.json({ fetched: rows.length, upserted, unmatched, unmatchedSuppliers });
  }),
);

// =====================================================================
// VENDOR LEAD TIMES (Label Traxx PO list for the materials PO table)
// =====================================================================
router.get(
  "/vendors/lead-times",
  asyncHandler(async (req, res) => {
    const vendorId = s(req.query.vendorId);
    if (!vendorId) return void res.status(400).json({ error: "vendorId required" });
    const rows = await db
      .select()
      .from(vendorLeadTimeTable)
      .where(eq(vendorLeadTimeTable.vendorId, vendorId))
      .orderBy(desc(vendorLeadTimeTable.receivedDate));
    const items = rows.map((r) => {
      const fillRatePct =
        r.orderedRolls != null && r.orderedRolls > 0 && r.receivedRolls != null
          ? Math.round((r.receivedRolls / r.orderedRolls) * 1000) / 10
          : null;
      return {
        id: r.id,
        poNumber: r.poNumber,
        supplierName: r.supplierName,
        placedDate: r.placedDate,
        receivedDate: r.receivedDate,
        leadDays: r.leadDays,
        orderedRolls: r.orderedRolls,
        receivedRolls: r.receivedRolls,
        fillRatePct,
      };
    });
    res.json({ vendorId, items });
  }),
);

// =====================================================================
// VENDOR TREND (monthly time series for a single vendor)
// =====================================================================
router.get(
  "/vendors/trend",
  asyncHandler(async (req, res) => {
    const vendorId = s(req.query.vendorId);
    if (!vendorId) return void res.status(400).json({ error: "vendorId required" });
    const months = clamp(intOrNull(req.query.months) ?? 12, 1, 36);
    const anchor = parseAnchor(req.query.anchor);
    const ay = anchor.getUTCFullYear();
    const am = anchor.getUTCMonth();

    const periods: { period: string; label: string; start: string; end: string }[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(ay, am - i, 1));
      const y = d.getUTCFullYear();
      const mm = d.getUTCMonth();
      periods.push({
        period: `${y}-${pad(mm + 1)}`,
        label: d.toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }),
        start: iso(new Date(Date.UTC(y, mm, 1))),
        end: iso(new Date(Date.UTC(y, mm + 1, 0))),
      });
    }

    const [vendorRows, metrics, shipments, leadTimes, issues, qualityCases] = await Promise.all([
      db.select().from(vendorTable).where(eq(vendorTable.id, vendorId)),
      db.select().from(vendorMetricTable).where(eq(vendorMetricTable.vendorId, vendorId)),
      db.select().from(vendorShipmentTable).where(eq(vendorShipmentTable.vendorId, vendorId)),
      db.select().from(vendorLeadTimeTable).where(eq(vendorLeadTimeTable.vendorId, vendorId)),
      db.select().from(vendorQualityIssueTable).where(eq(vendorQualityIssueTable.vendorId, vendorId)),
      db.select().from(vendorQualityCaseTable).where(eq(vendorQualityCaseTable.vendorId, vendorId)),
    ]);
    if (vendorRows.length === 0) return void res.status(404).json({ error: "vendor not found" });

    const nz = (x: number | null) => (x != null ? Math.round(x * 10) / 10 : null);

    const points = periods.map((p) => {
      const inWin = (d: string | null) => !!d && d >= p.start && d <= p.end;
      const sh = shipments.filter((x) => inWin(x.actualShipDate ?? x.customerDate));
      const lt = leadTimes.filter((x) => inWin(x.receivedDate));
      const mt = metrics.filter((m) => m.period === p.period);
      const iss = issues.filter((i) => inWin(i.occurredOn));
      // Match the rollup's windowing: a case with no start date still counts.
      const cas = qualityCases.filter((c) => c.startDate == null || inWin(c.startDate));

      const totalShipments = sh.length;
      const onTimeShipments = sh.filter((x) => x.onTime === true).length;
      const onTimePct =
        totalShipments > 0
          ? (onTimeShipments / totalShipments) * 100
          : avg(mt.map((m) => m.onTimePct).filter((x): x is number => x != null));
      const fillQtyOrdered = sh.reduce((a, x) => a + (x.qtyOrdered ?? 0), 0);
      const fillQtyShipped = sh.reduce((a, x) => a + (x.qtyShipped ?? 0), 0);
      const fillRatePct =
        fillQtyOrdered > 0
          ? (fillQtyShipped / fillQtyOrdered) * 100
          : avg(mt.map((m) => m.fillRatePct).filter((x): x is number => x != null));
      const matRollsOrdered = lt.reduce((a, x) => a + (x.orderedRolls ?? 0), 0);
      const matRollsReceived = lt.reduce((a, x) => a + (x.receivedRolls ?? 0), 0);
      const materialsFillRatePct = matRollsOrdered > 0 ? (matRollsReceived / matRollsOrdered) * 100 : null;
      const leadTimeAdherencePct = avg(mt.map((m) => m.leadTimeAdherencePct).filter((x): x is number => x != null));
      const ppvVals = mt.map((m) => m.ppvSavings).filter((x): x is number => x != null);
      const ppvSavings = ppvVals.length ? ppvVals.reduce((a, b) => a + b, 0) : null;
      const openQualityIssueCount =
        iss.filter((i) => i.status !== "closed").length + cas.filter((c) => c.openCase).length;
      const avgLeadDays = avg(lt.map((x) => x.leadDays));
      const nsLeadVals = sh
        .map((x) => nsLeadDays(x.poDate, x.actualShipDate))
        .filter((d): d is number => d != null);
      const avgNsLeadDays = avg(nsLeadVals);

      // Mirror the rollup score: responsiveness removed, weights sum to 1.0;
      // fill uses finished-goods qty fill when present else materials roll fill.
      const effectiveFillPct = fillRatePct != null ? fillRatePct : materialsFillRatePct;
      const comps: { w: number; v: number }[] = [];
      if (onTimePct != null) comps.push({ w: 0.35, v: clamp(onTimePct, 0, 100) });
      if (effectiveFillPct != null) comps.push({ w: 0.25, v: clamp(effectiveFillPct, 0, 100) });
      if (leadTimeAdherencePct != null) comps.push({ w: 0.15, v: clamp(leadTimeAdherencePct, 0, 100) });
      const hasData =
        onTimePct != null ||
        fillRatePct != null ||
        materialsFillRatePct != null ||
        leadTimeAdherencePct != null ||
        ppvSavings != null ||
        iss.length > 0 ||
        cas.length > 0 ||
        totalShipments > 0 ||
        lt.length > 0;
      const qualityScore = clamp(100 - openQualityIssueCount * 15, 0, 100);
      comps.push({ w: 0.25, v: qualityScore });
      const wSum = comps.reduce((a, c) => a + c.w, 0);
      const score = hasData && wSum > 0 ? comps.reduce((a, c) => a + c.w * c.v, 0) / wSum : null;

      return {
        period: p.period,
        label: p.label,
        onTimePct: nz(onTimePct),
        onTimeShipments,
        totalShipments,
        avgLeadDays: nz(avgLeadDays),
        leadPoCount: lt.length,
        avgNsLeadDays: nz(avgNsLeadDays),
        nsLeadPoCount: nsLeadVals.length,
        fillRatePct: nz(fillRatePct),
        materialsFillRatePct: nz(materialsFillRatePct),
        ppvSavings,
        qualityIssueCount: iss.length + cas.length,
        score: nz(score),
        grade: score != null ? gradeFromScore(score) : null,
      };
    });

    res.json({ vendorId, months, points });
  }),
);

export default router;
