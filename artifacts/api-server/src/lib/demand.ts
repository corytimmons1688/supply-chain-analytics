import { runGatewaySql, pickString, pickNumber, type GatewayRow } from "./gateway";
import { ltGet, ltMapConcurrent, ltDate } from "./ltApi";
import { bucketRange, eachBucket, type Bucket } from "./cc";
import { db, ltRollTable, ltStockTable, ltTicketTable, ltPoTable } from "@workspace/db";
import { and, eq, gte, lte, isNull, isNotNull, inArray, sql as dsql } from "drizzle-orm";

// ---------- Date helpers ----------

function normalizeLabelTraxxDate(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!s) return null;
  const isoM = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (isoM) return `${isoM[1]}-${isoM[2]}-${isoM[3]}`;
  const slashM = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (slashM) {
    let y = Number(slashM[3]);
    if (y < 100) y = 2000 + y;
    const mm = String(Number(slashM[1])).padStart(2, "0");
    const dd = String(Number(slashM[2])).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }
  return null;
}

function isBlankDate(iso: string | null): boolean {
  if (!iso) return true;
  // Pervasive blank date sentinel; anything before 1990 we treat as blank.
  return iso < "1990-01-01";
}

function diffDays(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.split("-").map(Number);
  const [by, bm, bd] = bIso.split("-").map(Number);
  const a = Date.UTC(ay!, am! - 1, ad!);
  const b = Date.UTC(by!, bm! - 1, bd!);
  return (b - a) / 86400000;
}

/** Yield month-aligned [start, end] ISO date ranges that cover [fromIso, toIso]. */
function eachMonthRange(fromIso: string, toIso: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  const [fy, fm] = fromIso.split("-").map(Number);
  const [ty, tm] = toIso.split("-").map(Number);
  let y = fy!;
  let m = fm!;
  while (y < ty! || (y === ty! && m <= tm!)) {
    const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const monthEnd = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    const segFrom = monthStart < fromIso ? fromIso : monthStart;
    const segTo = monthEnd > toIso ? toIso : monthEnd;
    out.push({ from: segFrom, to: segTo });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1 + months, d!));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function nextMondayIso(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  const dow = dt.getUTCDay();
  const daysToAdd = ((8 - dow) % 7) || 7;
  return addDaysIso(iso, daysToAdd);
}

function startsWithCc(s: string | null): boolean {
  if (!s) return false;
  return /^\s*cc\s+/i.test(s);
}

// ---------- Stats ----------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Linear-interpolated percentile (p in [0,1]). Used to read a service-level
 * quantile straight off an empirical demand distribution — no normality
 * assumption, which is what makes it robust for lumpy label-stock demand.
 */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0]!;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

/**
 * Empirical distribution of "demand during one lead time" built by sliding an
 * `leadTimeDays`-wide window (step = 1 day) across the daily-bucketed usage
 * series. Overlapping windows are autocorrelated, so this is a practical (not
 * statistically pristine) estimator, but for lumpy demand it beats assuming
 * normality. Returns the window sums, or null when history is too short to
 * form a meaningful number of windows (caller falls back to the σ model).
 */
function leadTimeDemandSamples(dailyFootage: number[], leadTimeDays: number): number[] | null {
  const L = Math.max(1, Math.round(leadTimeDays));
  // Need at least ~20 windows for a stable service-level quantile.
  if (dailyFootage.length < L + 20) return null;
  const samples: number[] = [];
  let windowSum = 0;
  for (let i = 0; i < dailyFootage.length; i++) {
    windowSum += dailyFootage[i]!;
    if (i >= L) windowSum -= dailyFootage[i - L]!;
    if (i >= L - 1) samples.push(windowSum);
  }
  return samples;
}

/**
 * "Typical roll size" estimate. A naive median across all received rolls is
 * skewed downward by partial rolls / rework / returns; a buyer thinks of the
 * "standard" full incoming roll length (e.g. 10,000 ft).
 *
 * Algorithm:
 *   1. Bucket each roll's footage to the nearest 500 ft.
 *   2. Find the bucket with the most rolls (the "mode bucket").
 *   3. Return the mean footage of rolls in that bucket.
 *
 * Falls back to the 90th-percentile footage if no clear mode emerges.
 */
function typicalRollSize(footages: number[]): number {
  if (footages.length === 0) return 0;
  if (footages.length === 1) return footages[0]!;
  const STEP = 500;
  const buckets = new Map<number, number[]>();
  for (const f of footages) {
    const key = Math.round(f / STEP) * STEP;
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    arr.push(f);
  }
  let best: { key: number; rolls: number[] } | null = null;
  for (const [key, rolls] of buckets) {
    if (!best || rolls.length > best.rolls.length || (rolls.length === best.rolls.length && key > best.key)) {
      best = { key, rolls };
    }
  }
  // Require the mode to cover at least 25% of rolls; otherwise fall back to p90.
  if (best && best.rolls.length / footages.length >= 0.25) {
    return mean(best.rolls);
  }
  // Nearest-rank p90: for n=10, idx = ceil(10*0.9) - 1 = 8 (the 9th element).
  // Plain floor(n*0.9) returns the max for n=10 (off-by-one), biasing high.
  const sorted = [...footages].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.9) - 1));
  return sorted[idx]!;
}

/** Approx inverse standard normal CDF (Acklam's algorithm) for service-level → z. */
export function zForServiceLevel(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

// ---------- Raw fetchers ----------

export interface RollUsageRow {
  stockId: string;
  dateUsed: string; // ISO
  footage: number;
  usedTikNum: string | null;
  poNumber: string | null;
  description: string | null;
}

/**
 * Real ticket consumption (excludes CC adjustment-removals). Reads the
 * lt_roll mirror (synced from the LT Cloud API — see lib/lt-sync.ts).
 */
export async function fetchUsage(opts: { from: string; to: string; stockId?: string }): Promise<RollUsageRow[]> {
  const conds = [
    eq(ltRollTable.used, true),
    isNotNull(ltRollTable.dateRollUsed),
    gte(ltRollTable.dateRollUsed, opts.from),
    lte(ltRollTable.dateRollUsed, opts.to),
  ];
  if (opts.stockId) conds.push(eq(ltRollTable.stockId, opts.stockId));
  const rows = await db.select().from(ltRollTable).where(and(...conds));

  const out: RollUsageRow[] = [];
  for (const row of rows) {
    if (startsWithCc(row.usedTikNum)) continue; // exclude CC adjustment removals
    const footage = row.length ?? 0;
    if (footage <= 0 || !row.stockId || !row.dateRollUsed) continue;
    out.push({
      stockId: row.stockId,
      dateUsed: row.dateRollUsed,
      footage,
      usedTikNum: row.usedTikNum,
      poNumber: row.poNumber,
      description: row.description,
    });
  }
  return out;
}

export interface OnHandRow {
  stockId: string;
  footage: number;
  rollCount: number;
  value: number;
  description: string | null;
}

/** Sum of FootLength and dollar value per stock for rolls still on-hand (DateRollUsed blank). */
export async function fetchOnHandByStock(): Promise<Map<string, OnHandRow>> {
  const sql =
    "SELECT StockNum, FootLength, CostOfRoll * 10 AS Tenths, Description FROM rollstock WHERE DateRollUsed < {d '1900-01-01'}";
  const rows = await runGatewaySql(sql);
  const m = new Map<string, OnHandRow>();
  const tenthsByStock = new Map<string, number>();
  for (const row of rows) {
    const stockId = pickString(row, "StockNum") ?? "";
    if (!stockId) continue;
    const footage = pickNumber(row, "FootLength");
    const tenths = pickNumber(row, "Tenths");
    let entry = m.get(stockId);
    if (!entry) {
      entry = { stockId, footage: 0, rollCount: 0, value: 0, description: pickString(row, "Description") };
      m.set(stockId, entry);
    }
    entry.footage += footage;
    entry.rollCount += 1;
    tenthsByStock.set(stockId, (tenthsByStock.get(stockId) ?? 0) + tenths);
    if (!entry.description) entry.description = pickString(row, "Description");
  }
  for (const [stockId, tenths] of tenthsByStock.entries()) {
    const entry = m.get(stockId);
    if (entry) entry.value = Math.round((tenths / 10) * 100) / 100;
  }
  return m;
}

/** Set of StockNum that are NOT marked Inactive in Label Traxx (lt_stock mirror). */
export async function fetchActiveStockIds(): Promise<Set<string>> {
  const rows = await db
    .select({ stockId: ltStockTable.stockId })
    .from(ltStockTable)
    .where(eq(ltStockTable.inactive, false));
  return new Set(rows.map((r) => r.stockId));
}

// ---------------------------------------------------------------------
// Label Traxx stock master (vendor / cost / width) and open-ticket
// material requirements — read-only SELECTs through the gateway.
// ---------------------------------------------------------------------

export interface StockInfoRow {
  stockId: string;
  supplierName: string | null;
  costMsi: number;
  freightMsi: number;
  masterWidth: number;
  estimatedDeliveryTime: string | null;
  invMsiMinimum: number;
  invMsiMaximum: number;
  classification: string | null;
  // PO-document spec fields (mirrors the Label Traxx PO form)
  mfgSpecNum: string | null;
  faceStock: string | null;
  adhesive: string | null;
  faceColor: string | null;
  topCoat: string | null;
  areaToWeightFactor: number;
}

export async function fetchStockInfo(): Promise<Map<string, StockInfoRow>> {
  const rows = await db.select().from(ltStockTable);
  const out = new Map<string, StockInfoRow>();
  for (const r of rows) {
    out.set(r.stockId, {
      stockId: r.stockId,
      supplierName: r.supplierName,
      costMsi: r.costMsi ?? 0,
      freightMsi: r.freightMsi ?? 0,
      masterWidth: r.masterWidth ?? 0,
      estimatedDeliveryTime: r.estimatedDeliveryTime,
      invMsiMinimum: r.invMsiMinimum ?? 0,
      invMsiMaximum: r.invMsiMaximum ?? 0,
      classification: r.classification,
      mfgSpecNum: r.mfgSpecNum,
      faceStock: r.faceStock,
      adhesive: r.adhesive,
      faceColor: r.faceColor,
      topCoat: r.topCoat,
      areaToWeightFactor: r.areaToWeightFactor ?? 0,
    });
  }
  return out;
}

export interface OpenTicketRow {
  ticketNumber: string;
  stockId: string;
  /** Remaining requirement = grossFootage − consumedFootage (what still must be produced). */
  estFootage: number;
  /** Full run requirement (LT totalNeeded), before netting consumption. */
  grossFootage: number;
  /** Footage already run (rolls consumed) against this ticket for this stock. */
  consumedFootage: number;
  stockIn: string; // Label Traxx availability status: In / Ordered / Out / ...
  shipByDate: string | null;
  description: string | null;
  /** True when this material is the ticket's primary (first BOM) stock. */
  primary: boolean;
  /**
   * Availability status computed by netting demand against inventory/POs in the
   * purchasing route (In / Ordered / Ordered Not Confirmed / Out). Undefined
   * until that netting runs.
   */
  computedStatus?: string;
}

/**
 * Open tickets (jobs not yet done) with their primary-stock material
 * requirement. EstFootage is attributed to StockNum1 — laminate/secondary
 * stocks (StockNum2/3) share the run length but LT does not split footage.
 */
export async function fetchOpenTickets(): Promise<OpenTicketRow[]> {
  // "Open" = not done, ship-by from 30 days ago onward (lt_ticket mirror).
  const since = addDaysIso(todayIso(), -30);
  const rows = await db
    .select()
    .from(ltTicketTable)
    .where(
      and(
        isNull(ltTicketTable.dateDone),
        gte(ltTicketTable.shipByDate, since),
        // "Digital Proof" tickets are proofing jobs, not production runs — they
        // don't consume material, so exclude them from demand. IS DISTINCT FROM
        // keeps tickets whose priority is null/anything else.
        dsql`${ltTicketTable.priority} IS DISTINCT FROM 'Digital Proof'`,
      ),
    );

  // Footage already RUN (rolls consumed) against these open tickets, per
  // (ticket × stock). A partially-produced ticket still reports its full
  // totalNeeded, but the footage already consumed is no longer a requirement —
  // net it off so we don't reorder to cover demand that's already been made.
  const ticketNumbers = rows.map((r) => r.ticketNumber);
  const consumedByTicketStock = new Map<string, number>();
  if (ticketNumbers.length > 0) {
    const consumedRows = await db
      .select({
        tik: ltRollTable.usedTikNum,
        stockId: ltRollTable.stockId,
        ft: dsql<number>`coalesce(sum(${ltRollTable.length}), 0)`,
      })
      .from(ltRollTable)
      .where(and(eq(ltRollTable.used, true), inArray(ltRollTable.usedTikNum, ticketNumbers)))
      .groupBy(ltRollTable.usedTikNum, ltRollTable.stockId);
    for (const c of consumedRows) {
      if (c.tik) consumedByTicketStock.set(`${c.tik}|${c.stockId}`, Number(c.ft) || 0);
    }
  }

  const out: OpenTicketRow[] = [];
  for (const row of rows) {
    const allocs = Array.isArray(row.stockAllocs)
      ? (row.stockAllocs as { stockNumber?: string }[])
      : [];
    // Emit one row per material in the ticket's BOM (all stock allocations),
    // not just the primary. Calyx does NOT run LT stock allocation, but the
    // BOM (stock numbers + widths) is populated from the job spec regardless
    // of allocation state, so a run needs its full footage of EACH material
    // it lists — laminates/zippers ride as secondary and must still count.
    const rawStatus = row.stockIn?.trim();
    const stockIn = !rawStatus || rawStatus === "***" ? "Not Evaluated" : rawStatus;
    const seen = new Set<string>();
    allocs.forEach((a, i) => {
      const stockId = a.stockNumber?.trim() ?? "";
      if (!stockId || seen.has(stockId)) return;
      seen.add(stockId);
      // Remaining requirement = total needed − footage already run for this
      // material on this ticket.
      const gross = row.totalNeeded ?? 0;
      const consumed = consumedByTicketStock.get(`${row.ticketNumber}|${stockId}`) ?? 0;
      out.push({
        ticketNumber: row.ticketNumber,
        stockId,
        estFootage: Math.max(0, gross - consumed),
        grossFootage: gross,
        consumedFootage: Math.round(consumed),
        stockIn,
        shipByDate: row.shipByDate,
        description: row.description,
        primary: i === 0,
      });
    });
  }
  return out;
}

export interface OnHandWidthRow {
  width: number;
  footage: number;
  rolls: number;
}

/** On-hand inventory broken out by roll width per stock (production planning). */
export async function fetchOnHandByWidth(): Promise<Map<string, OnHandWidthRow[]>> {
  const rows = await db
    .select({
      stockId: ltRollTable.stockId,
      width: ltRollTable.width,
      footage: dsql<number>`COALESCE(SUM(${ltRollTable.length}), 0)`,
      rolls: dsql<number>`COUNT(*)::float`,
    })
    .from(ltRollTable)
    .where(eq(ltRollTable.used, false))
    .groupBy(ltRollTable.stockId, ltRollTable.width);
  const out = new Map<string, OnHandWidthRow[]>();
  for (const row of rows) {
    if (!row.stockId) continue;
    const arr = out.get(row.stockId) ?? [];
    arr.push({ width: row.width ?? 0, footage: Number(row.footage), rolls: Number(row.rolls) });
    out.set(row.stockId, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.width - b.width);
  return out;
}

/** Receipt status for specific Label Traxx PO numbers. */
export async function fetchPoReceipts(
  poNumbers: string[],
): Promise<Map<string, { received: string | null; poDate: string | null }>> {
  const out = new Map<string, { received: string | null; poDate: string | null }>();
  const clean = [...new Set(poNumbers.map((n) => n.trim()).filter((n) => /^[0-9]+$/.test(n)))];
  if (clean.length === 0) return out;
  const details = await ltMapConcurrent(clean, 4, (n) =>
    ltGet<Record<string, unknown>>("/purchase-order-details", { PONumber: n }).catch(() => null),
  );
  for (const d of details) {
    if (!d) continue;
    const po = typeof d["poNumber"] === "string" ? d["poNumber"].trim() : null;
    if (!po) continue;
    out.set(po, {
      received: ltDate(d["receivedDate"] as string | null),
      poDate: ltDate(d["orderDate"] as string | null),
    });
  }
  return out;
}

export interface PoLeadTime {
  poNumber: string;
  leadTimeDays: number;
  supplierName: string | null;
}

/** Per-PO lead time (days between PODate placed and Received). Chunked by month to dodge gateway 1000-row cap. */
export async function fetchPoLeadTimes(sinceIso?: string): Promise<Map<string, PoLeadTime>> {
  const since = sinceIso ?? addDaysIso(todayIso(), -540);
  const rows = await db
    .select()
    .from(ltPoTable)
    .where(and(isNotNull(ltPoTable.receivedDate), gte(ltPoTable.receivedDate, since)));
  const m = new Map<string, PoLeadTime>();
  for (const row of rows) {
    if (!row.poDate || !row.receivedDate) continue;
    const days = diffDays(row.poDate, row.receivedDate);
    if (days <= 0 || days > 365) continue; // sanity bounds
    m.set(row.poNumber, { poNumber: row.poNumber, leadTimeDays: days, supplierName: row.supplierName ?? null });
  }
  return m;
}

/**
 * Median lead time per supplier, across all their received POs — the fallback
 * tier for a stock that has too little PO history of its own to trust.
 */
export function vendorLeadTimeMedians(poLeadTimes: Map<string, PoLeadTime>): Map<string, number> {
  const byVendor = new Map<string, number[]>();
  for (const lt of poLeadTimes.values()) {
    if (!lt.supplierName) continue;
    let arr = byVendor.get(lt.supplierName);
    if (!arr) { arr = []; byVendor.set(lt.supplierName, arr); }
    arr.push(lt.leadTimeDays);
  }
  const out = new Map<string, number>();
  for (const [vendor, days] of byVendor) out.set(vendor, median(days));
  return out;
}

export interface PoRollRow {
  stockId: string;
  poNumber: string;
  footage: number;
  stkDateIso: string | null;
  /**
   * Identifier for the *original* incoming roll. Slit/split children share the
   * same `Orig_RollID` (children appear as `IDNumber` like "6184-A", "6184-B"
   * etc.). Falls back to `IDNumber` for un-slit rolls. Used to reconstruct the
   * full incoming roll size from per-piece FootLength rows.
   */
  origRollId: string;
}

/** All received rolls (have a real PO, not a CC adjustment), from the lt_roll mirror. */
export async function fetchPoRolls(sinceIso?: string): Promise<PoRollRow[]> {
  const since = sinceIso ?? addDaysIso(todayIso(), -540);
  const rows = await db
    .select()
    .from(ltRollTable)
    .where(and(isNotNull(ltRollTable.poNumber), isNotNull(ltRollTable.stockDate), gte(ltRollTable.stockDate, since)));
  const out: PoRollRow[] = [];
  for (const row of rows) {
    const poNumber = row.poNumber;
    if (!poNumber || startsWithCc(poNumber)) continue;
    if (!row.stockId) continue;
    const footage = row.length ?? 0;
    if (footage <= 0) continue;
    // The LT API does not expose Orig_RollID; slit children carry an
    // "-A"/"-B" suffix on the roll id, so strip one trailing suffix to roll
    // them up to their parent (same fallback the ODBC path used).
    const t = row.rollId.trim();
    const m2 = t.match(/^(.+)-[A-Za-z0-9]+$/);
    const origRollId = m2 ? m2[1]! : t;
    out.push({
      stockId: row.stockId,
      poNumber,
      footage,
      stkDateIso: row.stockDate,
      origRollId,
    });
  }
  return out;
}

export interface OpenPoRow {
  poNumber: string;
  stockId: string;
  poDateIso: string | null;
  dueDateIso: string | null;
  quantityRolls: number;
  description: string | null;
  daysOpen: number | null;
}

/**
 * Open ("unreceived") Stock-type purchase orders. Convention: a blank
 * `Received` date is stored as a placeholder before 1900-01-01 (matches
 * `fetchOnHandByStock`). We exclude POs marked Closed = 'true' (cancelled).
 * Quantity is in master rolls; footage is reconstructed downstream using the
 * per-stock typical-roll-size. Chunked by PODate month to dodge gateway
 * 1000-row cap; default lookback 5 years easily covers any plausibly-open PO.
 */
export async function fetchOpenPos(sinceIso?: string): Promise<OpenPoRow[]> {
  const since = sinceIso ?? addDaysIso(todayIso(), -365 * 5);
  const rows = await db
    .select()
    .from(ltPoTable)
    .where(
      and(
        eq(ltPoTable.poType, "Stock"),
        isNull(ltPoTable.receivedDate),
        eq(ltPoTable.closed, false),
        gte(ltPoTable.poDate, since),
      ),
    );
  const today = todayIso();
  const out: OpenPoRow[] = [];
  for (const row of rows) {
    if (!row.stockNum) continue;
    const quantityRolls = row.quantity ?? 0;
    if (quantityRolls <= 0) continue;
    out.push({
      poNumber: row.poNumber,
      stockId: row.stockNum,
      poDateIso: row.poDate,
      dueDateIso: row.dueDate,
      quantityRolls,
      description: row.description,
      daysOpen: row.poDate ? diffDays(row.poDate, today) : null,
    });
  }
  return out;
}

// ---------- Forecast ----------

export interface ForecastPoint {
  periodStart: string;
  periodEnd: string;
  label: string;
  footage: number;
}

export const DEFAULT_SEASONALITY_WEIGHTS: [number, number, number] = [0.25, 0.25, 0.5];

/**
 * Normalize a 3-tuple of weights so they sum to 1.0. Falls back to defaults
 * if the weights are invalid (non-positive sum, NaN, etc).
 */
export function normalizeSeasonalityWeights(
  w: [number, number, number] | null | undefined,
): [number, number, number] {
  if (!w) return DEFAULT_SEASONALITY_WEIGHTS;
  const [a, b, c] = w;
  if (![a, b, c].every((v) => Number.isFinite(v) && v >= 0)) return DEFAULT_SEASONALITY_WEIGHTS;
  const sum = a + b + c;
  if (sum <= 0) return DEFAULT_SEASONALITY_WEIGHTS;
  return [a / sum, b / sum, c / sum];
}

/**
 * Forecast next `weeks` weeks (Mon-start) from history, using quarterly
 * seasonality. `seasonalityWeights` are the share of a quarter's demand that
 * falls in months 1, 2, and 3 of that quarter (must sum to ~1.0). Defaults to
 * [0.25, 0.25, 0.5].
 */
export function forecastWeekly(
  historyByMonth: Map<string, number>,
  weeks: number,
  startIso?: string,
  seasonalityWeights?: [number, number, number] | null,
): ForecastPoint[] {
  const monthlyValues = Array.from(historyByMonth.values());
  if (monthlyValues.length === 0) return [];
  const avgMonthly = mean(monthlyValues);
  const weights = normalizeSeasonalityWeights(seasonalityWeights ?? null);

  const start = nextMondayIso(startIso ?? todayIso());
  const out: ForecastPoint[] = [];

  for (let i = 0; i < weeks; i++) {
    const wkStart = addDaysIso(start, i * 7);
    const wkEnd = addDaysIso(wkStart, 6);
    // Weight allocation by daily seasonality so weeks crossing month boundaries
    // distribute across both months naturally. A weight of 1/3 = neutral
    // (no seasonality), so the per-month factor is `weight * 3`.
    let footage = 0;
    for (let d = 0; d < 7; d++) {
      const dayIso = addDaysIso(wkStart, d);
      const [y, m] = dayIso.split("-").map(Number);
      const monthInQuarter = ((m! - 1) % 3) + 1;
      const factor = (weights[monthInQuarter - 1] ?? 1 / 3) * 3;
      const monthDemand = avgMonthly * factor;
      const daysInMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
      footage += monthDemand / daysInMonth;
    }
    out.push({
      periodStart: wkStart,
      periodEnd: wkEnd,
      label: `Wk of ${wkStart}`,
      footage: Math.round(footage),
    });
  }
  return out;
}

// ---------- Bucketing ----------

export function bucketHistory(usage: RollUsageRow[], from: string, to: string, bucket: Bucket): { periodStart: string; periodEnd: string; label: string; footage: number }[] {
  const buckets = new Map<string, { start: string; end: string; label: string; footage: number }>();
  for (const start of eachBucket(from, to, bucket)) {
    const r = bucketRange(start, bucket);
    buckets.set(r.start, { ...r, footage: 0 });
  }
  for (const u of usage) {
    const r = bucketRange(u.dateUsed, bucket);
    const slot = buckets.get(r.start);
    if (!slot) continue;
    slot.footage += u.footage;
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((b) => ({ periodStart: b.start, periodEnd: b.end, label: b.label, footage: Math.round(b.footage) }));
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

// ---------- Per-stock metrics ----------

export interface StockMetricsInput {
  stockId: string;
  description: string | null;
  usage: RollUsageRow[]; // pre-filtered to this stock + window
  windowStart: string;
  windowEnd: string;
  onHandFootage: number;
  onHandRollCount: number;
  poLeadTimes: Map<string, PoLeadTime>;
  poRolls: PoRollRow[]; // pre-filtered to this stock
  openPos?: OpenPoRow[]; // pre-filtered to this stock; unreceived Stock-type POs
  /** Committed footage required by open (undone) tickets that list this material. */
  openTicketFootage?: number;
  /**
   * Per-ticket committed lines (footage + ship-by date) for this material, used
   * to time-phase demand: requirements due within the lead-time horizon are
   * treated as firm and drive the reorder point directly.
   */
  openTicketLines?: { footage: number; shipByDate: string | null }[];
  serviceLevel: number;
  demandCvOverride?: number;
  leadTimeCvOverride?: number;
  seasonalityWeightsOverride?: [number, number, number] | null;
  /** Override the average lead time (days) used in safety-stock / reorder-point math. */
  leadTimeDaysOverride?: number;
  /** Median lead time (days) for this stock's supplier — fallback when the stock has too little PO history of its own. */
  vendorLeadTimeDays?: number;
  /** Override the typical roll size (footage) used to size suggested POs. */
  typicalRollFootageOverride?: number;
  /** Manual order quantity (master rolls) — a fixed batch overriding EOQ. Acts as a floor. */
  orderQuantityRollsOverride?: number;
  /** End-of-life: keep the SKU visible but never suggest a reorder. */
  discontinued?: boolean;
  /** Predecessor stock whose usage history is merged into this SKU (echoed for display). */
  demandFromStockId?: string | null;
  /** Landed value per foot ($/ft = (msiCost + freightMsi) × 12 × width / 1000) — drives EOQ holding cost. */
  unitValuePerFoot?: number;
  /** Fixed cost to place one PO ($) — the EOQ ordering-cost term. */
  orderingCost?: number;
  /** Annual inventory carrying rate (fraction, e.g. 0.20 = 20%/yr) — EOQ holding-cost term. */
  carryingRatePct?: number;
  forecastWeeks: number;
  fallbackLeadTimeDays?: number;
  customized?: boolean;
}

export interface StockMetrics {
  stockId: string;
  description: string | null;
  onHandFootage: number;
  onHandRollCount: number;
  totalDemandFootage: number;
  weeksOfHistory: number;
  avgWeeklyDemand: number;
  weeklyDemandStdDev: number;
  demandCv: number;
  autoDemandCv: number;
  demandCvOverridden: boolean;
  avgLeadTimeDays: number;
  autoLeadTimeDays: number;
  leadTimeDaysOverridden: boolean;
  /** Where avgLeadTimeDays came from: this stock's own PO history, its vendor's median, a global median, or a manual override. */
  leadTimeSource: "stock" | "vendor" | "global" | "override";
  /** How many of this stock's own received POs backed the lead-time estimate. */
  leadTimeObservations: number;
  leadTimeStdDev: number;
  leadTimeCv: number;
  autoLeadTimeCv: number;
  leadTimeCvOverridden: boolean;
  seasonalityWeights: [number, number, number];
  defaultSeasonalityWeights: [number, number, number];
  seasonalityWeightsOverridden: boolean;
  poObservations: number;
  typicalRollFootage: number;
  autoTypicalRollFootage: number;
  typicalRollFootageOverridden: boolean;
  safetyStockFootage: number;
  reorderPointFootage: number;
  maxFootage: number;
  /** Economic order quantity (footage), rounded to whole rolls; 0 when cost inputs are unavailable. */
  eoqFootage: number;
  /** Economic order quantity expressed in whole master rolls. */
  eoqRolls: number;
  /** How the order quantity was sized: manual override, EOQ (economic), or the lead-time+4-week heuristic. */
  orderQtySource: "manual" | "eoq" | "heuristic";
  suggestedOrderFootage: number;
  suggestedOrderRolls: number;
  belowMin: boolean;
  /** End-of-life: still counted for on-hand, but never suggested for reorder. */
  discontinued: boolean;
  /** Predecessor stock whose demand history is merged into this SKU (null = none). */
  demandFromStockId: string | null;
  /** Committed footage required by open tickets that list this material. */
  openTicketFootage: number;
  /** Committed footage due within the lead-time horizon (drives the ROP). */
  committedWithinLeadFootage: number;
  /** How short the inventory position is vs committed open-ticket demand (>0 = short). */
  committedShortageFootage: number;
  /**
   * How the reorder point was sized: "empirical" = service-level percentile of
   * the historical lead-time-demand distribution; "statistical" = the σ-based
   * safety-stock fallback used when history is too short.
   */
  reorderMethod: "empirical" | "statistical";
  /** Number of lead-time-demand windows behind an empirical ROP (0 = fallback). */
  leadTimeDemandSamples: number;
  /** Why a reorder is suggested: forecast reorder point, committed orders, both, or none. */
  reorderReason: "below_rop" | "committed" | "both" | "none";
  daysOfCover: number;
  forecast12wkFootage: number;
  openPoCount: number;
  openPoRolls: number;
  openPoFootage: number;
  lastUsedDate: string | null;
  daysSinceLastUse: number | null;
  activityStatus: "active" | "slowing" | "dormant" | "never";
  customized: boolean;
}

/** Bucket recent-activity into a flag for the UI. Thresholds in days. */
export function classifyActivity(daysSinceLastUse: number | null): "active" | "slowing" | "dormant" | "never" {
  if (daysSinceLastUse === null) return "never";
  if (daysSinceLastUse <= 60) return "active";
  if (daysSinceLastUse <= 180) return "slowing";
  return "dormant";
}

export function computeStockMetrics(input: StockMetricsInput): { metrics: StockMetrics; forecast: ForecastPoint[] } {
  const z = zForServiceLevel(input.serviceLevel);

  // Weekly history buckets
  const weekly = bucketHistory(input.usage, input.windowStart, input.windowEnd, "week");
  const weeklyValues = weekly.map((w) => w.footage);
  const totalDemand = weeklyValues.reduce((s, v) => s + v, 0);
  const weeksOfHistory = weeklyValues.length;
  const avgWeekly = mean(weeklyValues);
  const sdWeekly = stdDev(weeklyValues);
  const autoDemandCv = avgWeekly > 0 ? sdWeekly / avgWeekly : 0;
  const demandCv = input.demandCvOverride ?? autoDemandCv;
  const sigmaD = avgWeekly * demandCv;

  // Lead time across POs that included this stock
  const poNumbersForStock = new Set(input.poRolls.map((r) => r.poNumber));
  const ltDays: number[] = [];
  for (const po of poNumbersForStock) {
    const lt = input.poLeadTimes.get(po);
    if (lt) ltDays.push(lt.leadTimeDays);
  }
  // Lead time per STOCK NUMBER, with a graceful fallback chain. A stock's own
  // received-PO history is primary (median, to resist a single outlier PO), but
  // only once there are enough observations to trust; below that we fall back to
  // the stock's supplier median, then a global median.
  const MIN_LT_OBS = 2;
  const stockLtDays = ltDays.length >= MIN_LT_OBS ? median(ltDays) : null;
  let autoLtDays: number;
  let leadTimeSource: StockMetrics["leadTimeSource"];
  if (stockLtDays != null) {
    autoLtDays = stockLtDays;
    leadTimeSource = "stock";
  } else if (input.vendorLeadTimeDays != null && input.vendorLeadTimeDays > 0) {
    autoLtDays = input.vendorLeadTimeDays;
    leadTimeSource = "vendor";
  } else {
    autoLtDays = input.fallbackLeadTimeDays ?? 0;
    leadTimeSource = "global";
  }
  const avgLtDays = input.leadTimeDaysOverride ?? autoLtDays;
  if (input.leadTimeDaysOverride != null) leadTimeSource = "override";
  const sdLtDays = stdDev(ltDays);
  const ltWeeks = avgLtDays / 7;
  const sdLtWeeks = sdLtDays / 7;
  const autoLeadTimeCv = avgLtDays > 0 ? sdLtDays / avgLtDays : 0;
  const leadTimeCv = input.leadTimeCvOverride ?? autoLeadTimeCv;
  const sigmaLtWeeks = ltWeeks * leadTimeCv;

  // ---- Reorder point: empirical lead-time-demand percentile (σ-model fallback) ----
  // Build the empirical distribution of "demand during one lead time" from the
  // daily-bucketed usage history. For lumpy label-stock demand this is far more
  // faithful than assuming demand is normal, and it never collapses a sporadic
  // slow mover to a zero reorder point.
  const dailyFootage = bucketHistory(input.usage, input.windowStart, input.windowEnd, "day").map((d) => d.footage);
  const ltdSamples = leadTimeDemandSamples(dailyFootage, avgLtDays);
  const ltdSampleCount = ltdSamples?.length ?? 0;

  // σ-model safety stock — the fallback when history is too short to be empirical.
  const statSafetyStock = avgLtDays > 0 && avgWeekly > 0
    ? z * Math.sqrt(ltWeeks * sigmaD * sigmaD + avgWeekly * avgWeekly * sigmaLtWeeks * sigmaLtWeeks)
    : 0;

  let safetyStock: number;
  let expectedLtd: number; // expected (mean) demand over one lead time
  let reorderMethod: StockMetrics["reorderMethod"];
  if (ltdSamples && ltdSamples.length > 0) {
    const meanLtd = mean(ltdSamples);
    const ropLtd = percentile(ltdSamples, input.serviceLevel); // service-level quantile
    expectedLtd = meanLtd;
    safetyStock = Math.max(0, ropLtd - meanLtd); // variability cushion
    reorderMethod = "empirical";
  } else {
    expectedLtd = avgWeekly * ltWeeks;
    safetyStock = statSafetyStock;
    reorderMethod = "statistical";
  }

  // Time-phase against the order book: committed footage due to ship within the
  // lead-time horizon is firm, known demand that must be covered before a fresh
  // PO could arrive. Lean on it — base demand-over-lead-time is the larger of
  // the historical expectation and what's actually booked, plus safety on top.
  const leadHorizonEnd = addDaysIso(todayIso(), Math.max(1, Math.round(avgLtDays)));
  const openTicketLines = input.openTicketLines ?? [];
  const committedWithinLead = openTicketLines.reduce(
    (s, t) => (t.shipByDate && t.shipByDate <= leadHorizonEnd ? s + t.footage : s),
    0,
  );
  const reorderPoint = Math.max(expectedLtd, committedWithinLead) + safetyStock;

  // Typical roll size: a buyer thinks of the *original* incoming roll length
  // (e.g. 10,000 ft). Per-row FootLength is per-piece — slit children share an
  // Orig_RollID — so we sum FootLength per origRollId before taking the mode.
  const parentSizes = new Map<string, number>();
  for (const r of input.poRolls) {
    if (r.footage <= 0) continue;
    parentSizes.set(r.origRollId, (parentSizes.get(r.origRollId) ?? 0) + r.footage);
  }
  const autoTypicalRoll = typicalRollSize(Array.from(parentSizes.values()));
  let typicalRoll = input.typicalRollFootageOverride != null && input.typicalRollFootageOverride > 0
    ? input.typicalRollFootageOverride
    : autoTypicalRoll;
  // Fallback when a material has no received-PO roll history (common for
  // components only ever consumed, or brand-new stocks with committed demand):
  // use the average on-hand roll size, else a modest default, so a roll count
  // can still be suggested and the material isn't silently dropped.
  if (typicalRoll <= 0 && input.onHandRollCount > 0 && input.onHandFootage > 0) {
    typicalRoll = input.onHandFootage / input.onHandRollCount;
  }
  if (typicalRoll <= 0) typicalRoll = 5000;

  // Order quantity: economic order quantity (EOQ) when we have the cost inputs,
  // else the legacy heuristic. EOQ = sqrt(2·D·S / H), balancing ordering cost
  // against holding cost, then rounded to whole master rolls.
  //   D = annual demand (ft)         S = fixed cost to place a PO ($)
  //   H = annual holding $/ft = landed value/ft × carrying rate
  const annualDemand = avgWeekly * 52;
  const holdingPerFoot = (input.unitValuePerFoot ?? 0) * (input.carryingRatePct ?? 0);
  const orderingCost = input.orderingCost ?? 0;
  const eoqRaw =
    holdingPerFoot > 0 && annualDemand > 0 && orderingCost > 0
      ? Math.sqrt((2 * annualDemand * orderingCost) / holdingPerFoot)
      : 0;
  let eoqRolls = 0;
  let eoqFootage = 0;
  let orderQtySource: StockMetrics["orderQtySource"] = "heuristic";
  const orderQtyOverride = input.orderQuantityRollsOverride;
  if (orderQtyOverride != null && orderQtyOverride > 0 && typicalRoll > 0) {
    // Manual per-stock order quantity wins over the computed EOQ.
    eoqRolls = Math.round(orderQtyOverride);
    eoqFootage = eoqRolls * typicalRoll;
    orderQtySource = "manual";
  } else if (eoqRaw > 0 && typicalRoll > 0) {
    eoqRolls = Math.max(1, Math.round(eoqRaw / typicalRoll));
    eoqFootage = eoqRolls * typicalRoll;
    orderQtySource = "eoq";
  }

  // Max (order-up-to) = reorder point + one order quantity. EOQ when available,
  // otherwise cover the lead time + ~4 weeks of demand (rounded to a roll).
  const orderCycleFootage = eoqFootage > 0 ? eoqFootage : Math.max(avgWeekly * 4, typicalRoll);
  const maxFootage = reorderPoint + orderCycleFootage;

  // Open (unreceived) Stock POs for this stock. Footage estimated as
  // quantity (rolls) * effective typical roll size — the same number a buyer
  // would use to size a fresh PO. Computed before the reorder decision so
  // inbound stock counts toward the inventory position below.
  const openPosForStock = input.openPos ?? [];
  const openPoCount = openPosForStock.length;
  const openPoRolls = openPosForStock.reduce((s, p) => s + p.quantityRolls, 0);
  const openPoFootage = typicalRoll > 0 ? openPoRolls * typicalRoll : 0;

  // Reorder against inventory POSITION (on-hand + on-order), not on-hand
  // alone. Otherwise a material with a replenishment PO already inbound keeps
  // triggering a reorder, and the suggested quantity double-counts what is
  // already on the way.
  const inventoryPosition = input.onHandFootage + openPoFootage;

  // Two reorder drivers:
  //  1. Forecast — position below the reorder point. The ROP already folds in
  //     committed demand due within the lead time, so this captures both the
  //     steady-state replenishment need and near-term booked spikes.
  //  2. Committed (beyond lead) — position can't cover the *entire* open-ticket
  //     book, even demand booked past the lead-time horizon. Surfaces a large
  //     order backlog early so one PO can cover it (1 material = 1 PO).
  const openTicketFootage = input.openTicketFootage ?? 0;
  // End-of-life SKUs still show on-hand for sell-through but never reorder.
  const discontinued = input.discontinued ?? false;
  const forecastShort = !discontinued && reorderPoint > 0 && inventoryPosition < reorderPoint;
  const committedShortageFootage = Math.max(0, openTicketFootage - inventoryPosition);
  const committedShort = !discontinued && committedShortageFootage > 0;
  const belowMin = forecastShort || committedShort;
  const reorderReason: StockMetrics["reorderReason"] = forecastShort && committedShort
    ? "both"
    : committedShort
      ? "committed"
      : forecastShort
        ? "below_rop"
        : "none";

  let suggestedOrderFootage = 0;
  let suggestedOrderRolls = 0;
  if (belowMin) {
    // Order up to whichever is higher: the forecast max level, or enough to
    // cover all committed open tickets. Then net out the current position.
    const targetLevel = Math.max(maxFootage, openTicketFootage);
    const rawNeed = targetLevel - inventoryPosition;
    if (typicalRoll > 0) {
      // Never order below the economic batch — a (Q,r) policy places at least
      // EOQ each time, but a big committed backlog can push the quantity higher.
      suggestedOrderRolls = Math.max(eoqRolls, Math.ceil(rawNeed / typicalRoll));
      suggestedOrderFootage = suggestedOrderRolls * typicalRoll;
    } else {
      suggestedOrderFootage = Math.max(eoqFootage, Math.ceil(rawNeed));
    }
  }

  // Days of cover reflects PHYSICAL stock only — inbound rolls can't be
  // consumed until they arrive — so this stays on on-hand footage.
  const daysOfCover = avgWeekly > 0 ? (input.onHandFootage / avgWeekly) * 7 : Infinity;

  // Last-used date across the window (max DateRollUsed).
  let lastUsedIso: string | null = null;
  for (const u of input.usage) {
    if (!lastUsedIso || u.dateUsed > lastUsedIso) lastUsedIso = u.dateUsed;
  }
  const daysSinceLastUse = lastUsedIso ? diffDays(lastUsedIso, todayIso()) : null;
  const activityStatus = classifyActivity(daysSinceLastUse);

  // Forecast 12 weeks
  const monthly = new Map<string, number>();
  for (const u of input.usage) {
    const k = monthKey(u.dateUsed);
    monthly.set(k, (monthly.get(k) ?? 0) + u.footage);
  }
  const effectiveSeasonalityWeights = normalizeSeasonalityWeights(
    input.seasonalityWeightsOverride ?? null,
  );
  const forecast = forecastWeekly(
    monthly,
    input.forecastWeeks,
    undefined,
    input.seasonalityWeightsOverride ?? null,
  );
  const forecast12wkTotal = forecast.reduce((s, p) => s + p.footage, 0);

  return {
    metrics: {
      stockId: input.stockId,
      description: input.description,
      onHandFootage: Math.round(input.onHandFootage),
      onHandRollCount: input.onHandRollCount,
      totalDemandFootage: Math.round(totalDemand),
      weeksOfHistory,
      avgWeeklyDemand: Math.round(avgWeekly),
      weeklyDemandStdDev: Math.round(sdWeekly),
      demandCv: Math.round(demandCv * 10000) / 10000,
      autoDemandCv: Math.round(autoDemandCv * 10000) / 10000,
      demandCvOverridden: input.demandCvOverride !== undefined,
      avgLeadTimeDays: Math.round(avgLtDays * 10) / 10,
      autoLeadTimeDays: Math.round(autoLtDays * 10) / 10,
      leadTimeDaysOverridden: input.leadTimeDaysOverride !== undefined,
      leadTimeSource,
      leadTimeObservations: ltDays.length,
      leadTimeStdDev: Math.round(sdLtDays * 10) / 10,
      leadTimeCv: Math.round(leadTimeCv * 10000) / 10000,
      autoLeadTimeCv: Math.round(autoLeadTimeCv * 10000) / 10000,
      leadTimeCvOverridden: input.leadTimeCvOverride !== undefined,
      seasonalityWeights: [
        Math.round(effectiveSeasonalityWeights[0] * 10000) / 10000,
        Math.round(effectiveSeasonalityWeights[1] * 10000) / 10000,
        Math.round(effectiveSeasonalityWeights[2] * 10000) / 10000,
      ],
      defaultSeasonalityWeights: [...DEFAULT_SEASONALITY_WEIGHTS],
      seasonalityWeightsOverridden: input.seasonalityWeightsOverride != null,
      poObservations: ltDays.length,
      typicalRollFootage: Math.round(typicalRoll),
      autoTypicalRollFootage: Math.round(autoTypicalRoll),
      typicalRollFootageOverridden:
        input.typicalRollFootageOverride != null && input.typicalRollFootageOverride > 0,
      safetyStockFootage: Math.round(safetyStock),
      reorderPointFootage: Math.round(reorderPoint),
      maxFootage: Math.round(maxFootage),
      eoqFootage: Math.round(eoqFootage),
      eoqRolls,
      orderQtySource,
      discontinued,
      demandFromStockId: input.demandFromStockId ?? null,
      suggestedOrderFootage: Math.round(suggestedOrderFootage),
      suggestedOrderRolls,
      belowMin,
      openTicketFootage: Math.round(openTicketFootage),
      committedWithinLeadFootage: Math.round(committedWithinLead),
      committedShortageFootage: Math.round(committedShortageFootage),
      reorderMethod,
      leadTimeDemandSamples: ltdSampleCount,
      reorderReason,
      daysOfCover: Number.isFinite(daysOfCover) ? Math.round(daysOfCover) : -1,
      forecast12wkFootage: Math.round(forecast12wkTotal),
      openPoCount,
      openPoRolls,
      openPoFootage: Math.round(openPoFootage),
      lastUsedDate: lastUsedIso,
      daysSinceLastUse: daysSinceLastUse,
      activityStatus,
      customized: input.customized ?? false,
    },
    forecast,
  };
}

export function defaultDemandWindow(monthsBack: number): { from: string; to: string } {
  const to = todayIso();
  const from = addMonthsIso(to, -monthsBack);
  return { from, to };
}

export type { GatewayRow };
