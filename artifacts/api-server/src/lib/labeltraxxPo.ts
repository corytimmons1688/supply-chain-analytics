import { db, ltRollTable, ltPoTable } from "@workspace/db";
import { and, gte, isNotNull } from "drizzle-orm";

// =====================================================================
// Label Traxx purchase-order lead-time source (READ-ONLY).
//
// Label Traxx POs carry the material vendor in the `Supplier` text column
// (e.g. Stock POs: "Mactac", "Avery Dennison", "Nobelus - luxefilms"). There
// is NO promised/due date in Label Traxx, so we can only derive *lead time*
// (PODate -> Received), never true on-time. This feeds the vendor scorecard as
// an extra metric alongside the NetSuite on-time figure.
//
// Reads come from the lt_po / lt_roll Postgres mirrors (synced from the LT
// Cloud API — see lib/lt-sync.ts).
// =====================================================================

// ---- minimal date helpers (kept local; mirror demand.ts conventions) ----
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
  return iso < "1990-01-01"; // pervasive blank-date sentinel
}

function diffDays(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.split("-").map(Number);
  const [by, bm, bd] = bIso.split("-").map(Number);
  const a = Date.UTC(ay!, am! - 1, ad!);
  const b = Date.UTC(by!, bm! - 1, bd!);
  return (b - a) / 86400000;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

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
    out.push({ from: monthStart < fromIso ? fromIso : monthStart, to: monthEnd > toIso ? toIso : monthEnd });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Internal/non-vendor supplier strings that should never be attributed.
const INTERNAL_SUPPLIERS = new Set(["calyx containers", "calyx", ""]);

export interface PoLeadTimeRow {
  poNumber: string;
  supplierName: string;
  placedDate: string; // ISO
  receivedDate: string; // ISO
  leadDays: number;
  poType: string | null;
  orderedRolls: number | null; // PO.Quantity (master rolls ordered)
  receivedRolls: number | null; // distinct master rolls booked against the PO
}

/**
 * Count the distinct *master* rolls received per PO, from the lt_roll mirror.
 * The LT API does not expose Orig_RollID, so slit children are rolled up by
 * stripping a single "-X" suffix from the roll id (same fallback the ODBC
 * path used).
 */
async function fetchReceivedRollCounts(sinceIso: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ rollId: ltRollTable.rollId, poNumber: ltRollTable.poNumber, length: ltRollTable.length })
    .from(ltRollTable)
    .where(and(isNotNull(ltRollTable.poNumber), isNotNull(ltRollTable.stockDate), gte(ltRollTable.stockDate, sinceIso)));
  const perPo = new Map<string, Set<string>>();
  for (const row of rows) {
    const poNumber = row.poNumber;
    if (!poNumber) continue;
    if ((row.length ?? 0) <= 0) continue;
    const t = row.rollId.trim();
    const m = t.match(/^(.+)-[A-Za-z0-9]+$/);
    const key = m ? m[1]! : t;
    let set = perPo.get(poNumber);
    if (!set) perPo.set(poNumber, (set = new Set<string>()));
    set.add(key);
  }
  const counts = new Map<string, number>();
  for (const [po, set] of perPo) counts.set(po, set.size);
  return counts;
}

/**
 * Received POs with a usable lead time, attributed to their Label Traxx
 * supplier. Default lookback 730 days (2 years) so trend charts have history.
 * Reads the lt_po mirror.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function fetchPoLeadTimeRows(sinceIso?: string): Promise<PoLeadTimeRow[]> {
  const since = sinceIso && ISO_DATE.test(sinceIso) ? sinceIso : addDaysIso(todayIso(), -730);
  const [rows, rollCounts] = await Promise.all([
    db
      .select()
      .from(ltPoTable)
      .where(and(isNotNull(ltPoTable.receivedDate), gte(ltPoTable.receivedDate, since))),
    fetchReceivedRollCounts(since),
  ]);
  const out: PoLeadTimeRow[] = [];
  for (const row of rows) {
    const supplier = (row.supplierName ?? "").trim();
    if (!supplier || INTERNAL_SUPPLIERS.has(supplier.toLowerCase())) continue;
    if (!row.poDate || !row.receivedDate) continue;
    const days = diffDays(row.poDate, row.receivedDate);
    if (days <= 0 || days > 365) continue; // sanity bounds
    const orderedRollsRaw = Math.round(row.quantity ?? 0);
    out.push({
      poNumber: row.poNumber,
      supplierName: supplier,
      placedDate: row.poDate,
      receivedDate: row.receivedDate,
      leadDays: Math.round(days),
      poType: row.poType,
      orderedRolls: orderedRollsRaw > 0 ? orderedRollsRaw : null,
      receivedRolls: rollCounts.get(row.poNumber) ?? null,
    });
  }
  return out;
}
