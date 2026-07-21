import { runGatewaySql, pickString, pickNumber, sqlEscape, type GatewayRow } from "./gateway";
import { bucketRange, eachBucket, type Bucket } from "./cc";

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
 * Fetch real ticket consumption from rollstock (excludes CC adjustment-removals).
 * The gateway caps responses at 1000 rows; for unfiltered (no stockId) calls we
 * chunk by month so that each chunk stays well below the cap.
 */
export async function fetchUsage(opts: { from: string; to: string; stockId?: string }): Promise<RollUsageRow[]> {
  const ranges = opts.stockId ? [{ from: opts.from, to: opts.to }] : eachMonthRange(opts.from, opts.to);
  const stockClause = opts.stockId ? ` AND StockNum = '${sqlEscape(opts.stockId)}'` : "";

  const chunks = await Promise.all(
    ranges.map(async (r) => {
      const sql =
        `SELECT StockNum, FootLength, DateRollUsed, UsedTikNum, PONumber, Description FROM rollstock ` +
        `WHERE DateRollUsed >= {d '${r.from}'} AND DateRollUsed <= {d '${r.to}'}${stockClause}`;
      const rows = await runGatewaySql(sql);
      if (rows.length >= 1000) {
        // eslint-disable-next-line no-console
        console.warn(`[demand.fetchUsage] chunk ${r.from}..${r.to} hit row cap (${rows.length}); demand totals may be undercounted`);
      }
      return rows;
    }),
  );

  const out: RollUsageRow[] = [];
  for (const rows of chunks) {
    for (const row of rows) {
      const usedTikNum = pickString(row, "UsedTikNum");
      if (startsWithCc(usedTikNum)) continue; // exclude CC adjustment removals
      const dateUsed = normalizeLabelTraxxDate(pickString(row, "DateRollUsed"));
      if (!dateUsed || isBlankDate(dateUsed)) continue;
      if (dateUsed < opts.from || dateUsed > opts.to) continue;
      const stockId = pickString(row, "StockNum") ?? "";
      if (!stockId) continue;
      const footage = pickNumber(row, "FootLength");
      if (footage <= 0) continue;
      out.push({
        stockId,
        dateUsed,
        footage,
        usedTikNum,
        poNumber: pickString(row, "PONumber"),
        description: pickString(row, "Description"),
      });
    }
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

/** Set of StockNum that are NOT marked Inactive in Label Traxx. */
export async function fetchActiveStockIds(): Promise<Set<string>> {
  const sql = "SELECT StockNum, Inactive FROM stock";
  const rows = await runGatewaySql(sql);
  const out = new Set<string>();
  for (const row of rows) {
    const id = pickString(row, "StockNum");
    if (!id) continue;
    const inactive = (pickString(row, "Inactive") ?? "").toLowerCase().trim();
    if (inactive === "true" || inactive === "yes" || inactive === "1") continue;
    out.add(id);
  }
  return out;
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
}

export async function fetchStockInfo(): Promise<Map<string, StockInfoRow>> {
  const sql =
    "SELECT StockNum, SupplierName, CostMSI, FreightMSI, MasterWidth, EstimatedDeliveryTime, " +
    "InvMSI_Minimum, InvMSI_Maximum, Classification FROM stock";
  const rows = await runGatewaySql(sql);
  const out = new Map<string, StockInfoRow>();
  for (const row of rows) {
    const stockId = pickString(row, "StockNum")?.trim();
    if (!stockId) continue;
    out.set(stockId, {
      stockId,
      supplierName: pickString(row, "SupplierName")?.trim() || null,
      costMsi: pickNumber(row, "CostMSI"),
      freightMsi: pickNumber(row, "FreightMSI"),
      masterWidth: pickNumber(row, "MasterWidth"),
      estimatedDeliveryTime: pickString(row, "EstimatedDeliveryTime")?.trim() || null,
      invMsiMinimum: pickNumber(row, "InvMSI_Minimum"),
      invMsiMaximum: pickNumber(row, "InvMSI_Maximum"),
      classification: pickString(row, "Classification")?.trim() || null,
    });
  }
  return out;
}

export interface OpenTicketRow {
  ticketNumber: string;
  stockId: string;
  estFootage: number;
  stockIn: string; // Label Traxx availability status: In / Ordered / Out / ...
  shipByDate: string | null;
  description: string | null;
}

/**
 * Open tickets (jobs not yet done) with their primary-stock material
 * requirement. EstFootage is attributed to StockNum1 — laminate/secondary
 * stocks (StockNum2/3) share the run length but LT does not split footage.
 */
export async function fetchOpenTickets(): Promise<OpenTicketRow[]> {
  // "Open" = not done, with a ship-by date from 30 days ago onward. Label
  // Traxx keeps years of never-closed tickets; the recency window keeps this
  // to genuinely current work (and under the gateway's 1000-row cap).
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceIso = since.toISOString().slice(0, 10);
  // Label Traxx stores "no date" as a pre-1900 sentinel, not SQL NULL —
  // the same trick the on-hand query uses for DateRollUsed.
  const sql =
    "SELECT Number, StockNum1, EstFootage, StockIn, Ship_by_Date, GeneralDescr FROM ticket " +
    `WHERE DateDone < {d '1900-01-01'} AND StockNum1 <> '' ` +
    `AND Ship_by_Date >= {d '${sinceIso}'}`;
  const rows = await runGatewaySql(sql);
  const out: OpenTicketRow[] = [];
  for (const row of rows) {
    const stockId = pickString(row, "StockNum1")?.trim();
    const ticketNumber = pickString(row, "Number")?.trim();
    if (!stockId || !ticketNumber) continue;
    const rawShip = pickString(row, "Ship_by_Date");
    out.push({
      ticketNumber,
      stockId,
      estFootage: pickNumber(row, "EstFootage"),
      stockIn: (() => {
        const v = pickString(row, "StockIn")?.trim();
        return !v || v === "***" ? "Not Evaluated" : v;
      })(),
      shipByDate: rawShip ? rawShip.split(" ")[0] ?? null : null,
      description: pickString(row, "GeneralDescr")?.trim() || null,
    });
  }
  return out;
}

export interface PoLeadTime {
  poNumber: string;
  leadTimeDays: number;
}

/** Per-PO lead time (days between PODate placed and Received). Chunked by month to dodge gateway 1000-row cap. */
export async function fetchPoLeadTimes(sinceIso?: string): Promise<Map<string, PoLeadTime>> {
  const since = sinceIso ?? addDaysIso(todayIso(), -540);
  const ranges = eachMonthRange(since, todayIso());
  const chunks = await Promise.all(
    ranges.map(async (r) => {
      const sql =
        "SELECT PONumber, PODate, Received FROM purchaseorder " +
        `WHERE PONumber IS NOT NULL AND Received >= {d '${r.from}'} AND Received <= {d '${r.to}'}`;
      const rows = await runGatewaySql(sql);
      if (rows.length >= 1000) {
        // eslint-disable-next-line no-console
        console.warn(`[demand.fetchPoLeadTimes] chunk ${r.from}..${r.to} hit row cap (${rows.length})`);
      }
      return rows;
    }),
  );
  const m = new Map<string, PoLeadTime>();
  for (const rows of chunks) {
    for (const row of rows) {
      const poNumber = pickString(row, "PONumber");
      if (!poNumber) continue;
      const placed = normalizeLabelTraxxDate(pickString(row, "PODate"));
      const received = normalizeLabelTraxxDate(pickString(row, "Received"));
      if (!placed || !received || isBlankDate(placed) || isBlankDate(received)) continue;
      const days = diffDays(placed, received);
      if (days <= 0 || days > 365) continue; // sanity bounds
      m.set(poNumber, { poNumber, leadTimeDays: days });
    }
  }
  return m;
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

/** All received rolls (have a real PO, not a CC adjustment). Chunked by month to dodge gateway 1000-row cap. */
export async function fetchPoRolls(sinceIso?: string): Promise<PoRollRow[]> {
  const since = sinceIso ?? addDaysIso(todayIso(), -540);
  const ranges = eachMonthRange(since, todayIso());
  const chunks = await Promise.all(
    ranges.map(async (r) => {
      const sql =
        "SELECT StockNum, PONumber, FootLength, StkDate, IDNumber, Orig_RollID FROM rollstock " +
        `WHERE PONumber IS NOT NULL AND StkDate >= {d '${r.from}'} AND StkDate <= {d '${r.to}'}`;
      const rows = await runGatewaySql(sql);
      if (rows.length >= 1000) {
        // eslint-disable-next-line no-console
        console.warn(`[demand.fetchPoRolls] chunk ${r.from}..${r.to} hit row cap (${rows.length})`);
      }
      return rows;
    }),
  );
  const out: PoRollRow[] = [];
  let unkSeq = 0; // monotonic counter for rows lacking any roll identifier
  for (const rows of chunks) {
    for (const row of rows) {
      const poNumber = pickString(row, "PONumber");
      if (!poNumber || startsWithCc(poNumber)) continue;
      const stockId = pickString(row, "StockNum") ?? "";
      if (!stockId) continue;
      const footage = pickNumber(row, "FootLength");
      if (footage <= 0) continue;
      const orig = pickString(row, "Orig_RollID");
      const idn = pickString(row, "IDNumber");
      // Prefer Orig_RollID; else strip a single trailing "-X" suffix from
      // IDNumber so slit children (e.g. "6184-A") roll up to their parent
      // ("6184"); else use IDNumber as-is. As a last resort assign a unique
      // synthetic id — never collapse distinct rolls into one parent, which
      // would inflate the reconstructed roll size.
      let origRollId = orig && orig.trim() ? orig.trim() : "";
      if (!origRollId && idn && idn.trim()) {
        const t = idn.trim();
        const m = t.match(/^(.+)-[A-Za-z0-9]+$/);
        origRollId = m ? m[1]! : t;
      }
      if (!origRollId) {
        unkSeq += 1;
        origRollId = `__unk:${stockId}:${poNumber}:${unkSeq}`;
      }
      out.push({
        stockId,
        poNumber,
        footage,
        stkDateIso: normalizeLabelTraxxDate(pickString(row, "StkDate")),
        origRollId,
      });
    }
  }
  return out;
}

export interface OpenPoRow {
  poNumber: string;
  stockId: string;
  poDateIso: string | null;
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
  const ranges = eachMonthRange(since, todayIso());
  const chunks = await Promise.all(
    ranges.map(async (r) => {
      const sql =
        "SELECT PONumber, PODate, OrderStockNum, Quantity, Closed, Description " +
        "FROM purchaseorder " +
        `WHERE POType = 'Stock' AND Received < {d '1900-01-01'} ` +
        `AND PODate >= {d '${r.from}'} AND PODate <= {d '${r.to}'}`;
      const rows = await runGatewaySql(sql);
      if (rows.length >= 1000) {
        // eslint-disable-next-line no-console
        console.warn(`[demand.fetchOpenPos] chunk ${r.from}..${r.to} hit row cap (${rows.length})`);
      }
      return rows;
    }),
  );
  const today = todayIso();
  const out: OpenPoRow[] = [];
  for (const rows of chunks) {
    for (const row of rows) {
      const closed = (pickString(row, "Closed") ?? "").toLowerCase().trim();
      if (closed === "true" || closed === "yes" || closed === "1") continue;
      const poNumber = pickString(row, "PONumber");
      if (!poNumber) continue;
      const stockId = pickString(row, "OrderStockNum") ?? "";
      if (!stockId) continue;
      const quantityRolls = pickNumber(row, "Quantity");
      if (quantityRolls <= 0) continue;
      const placed = normalizeLabelTraxxDate(pickString(row, "PODate"));
      const poDateIso = placed && !isBlankDate(placed) ? placed : null;
      const daysOpen = poDateIso ? diffDays(poDateIso, today) : null;
      out.push({
        poNumber,
        stockId,
        poDateIso,
        quantityRolls,
        description: pickString(row, "Description"),
        daysOpen,
      });
    }
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
  serviceLevel: number;
  demandCvOverride?: number;
  leadTimeCvOverride?: number;
  seasonalityWeightsOverride?: [number, number, number] | null;
  /** Override the average lead time (days) used in safety-stock / reorder-point math. */
  leadTimeDaysOverride?: number;
  /** Override the typical roll size (footage) used to size suggested POs. */
  typicalRollFootageOverride?: number;
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
  suggestedOrderFootage: number;
  suggestedOrderRolls: number;
  belowMin: boolean;
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
  const autoLtDays = ltDays.length > 0 ? mean(ltDays) : (input.fallbackLeadTimeDays ?? 0);
  const avgLtDays = input.leadTimeDaysOverride ?? autoLtDays;
  const sdLtDays = stdDev(ltDays);
  const ltWeeks = avgLtDays / 7;
  const sdLtWeeks = sdLtDays / 7;
  const autoLeadTimeCv = avgLtDays > 0 ? sdLtDays / avgLtDays : 0;
  const leadTimeCv = input.leadTimeCvOverride ?? autoLeadTimeCv;
  const sigmaLtWeeks = ltWeeks * leadTimeCv;

  // Safety stock = z * sqrt( LT * sigmaD^2 + d^2 * sigmaLT^2 )
  const safetyStock = avgLtDays > 0 && avgWeekly > 0
    ? z * Math.sqrt(ltWeeks * sigmaD * sigmaD + avgWeekly * avgWeekly * sigmaLtWeeks * sigmaLtWeeks)
    : 0;
  const reorderPoint = avgWeekly * ltWeeks + safetyStock;

  // Typical roll size: a buyer thinks of the *original* incoming roll length
  // (e.g. 10,000 ft). Per-row FootLength is per-piece — slit children share an
  // Orig_RollID — so we sum FootLength per origRollId before taking the mode.
  const parentSizes = new Map<string, number>();
  for (const r of input.poRolls) {
    if (r.footage <= 0) continue;
    parentSizes.set(r.origRollId, (parentSizes.get(r.origRollId) ?? 0) + r.footage);
  }
  const autoTypicalRoll = typicalRollSize(Array.from(parentSizes.values()));
  const typicalRoll = input.typicalRollFootageOverride != null && input.typicalRollFootageOverride > 0
    ? input.typicalRollFootageOverride
    : autoTypicalRoll;

  // Max = enough to cover lead time + 4 weeks of demand on top of safety stock,
  // rounded up to a typical roll. Falls back to ROP + one roll if no roll history.
  const orderUpTo = reorderPoint + Math.max(avgWeekly * 4, typicalRoll);
  const maxFootage = orderUpTo;

  let suggestedOrderFootage = 0;
  let suggestedOrderRolls = 0;
  const belowMin = input.onHandFootage < reorderPoint && reorderPoint > 0;
  if (belowMin) {
    const rawNeed = maxFootage - input.onHandFootage;
    if (typicalRoll > 0) {
      suggestedOrderRolls = Math.ceil(rawNeed / typicalRoll);
      suggestedOrderFootage = suggestedOrderRolls * typicalRoll;
    } else {
      suggestedOrderFootage = Math.ceil(rawNeed);
    }
  }

  const daysOfCover = avgWeekly > 0 ? (input.onHandFootage / avgWeekly) * 7 : Infinity;

  // Open (unreceived) Stock POs for this stock. Footage estimated as
  // quantity (rolls) * effective typical roll size — the same number a buyer
  // would use to size a fresh PO.
  const openPosForStock = input.openPos ?? [];
  const openPoCount = openPosForStock.length;
  const openPoRolls = openPosForStock.reduce((s, p) => s + p.quantityRolls, 0);
  const openPoFootage = typicalRoll > 0 ? openPoRolls * typicalRoll : 0;

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
      suggestedOrderFootage: Math.round(suggestedOrderFootage),
      suggestedOrderRolls,
      belowMin,
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
