import { runGatewaySql, pickString, pickNumber } from "./gateway";

// =====================================================================
// Label Traxx purchase-order lead-time source (READ-ONLY).
//
// Label Traxx POs carry the material vendor in the `Supplier` text column
// (e.g. Stock POs: "Mactac", "Avery Dennison", "Nobelus - luxefilms"). There
// is NO promised/due date in Label Traxx, so we can only derive *lead time*
// (PODate -> Received), never true on-time. This feeds the vendor scorecard as
// an extra metric alongside the NetSuite on-time figure.
//
// We NEVER write to Label Traxx — all access is read-only SELECTs through the
// ODBC gateway. Queries are chunked by Received month to dodge the gateway's
// 1000-row result cap.
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
 * Count the distinct *master* rolls received per PO. Slit children share a
 * parent via `Orig_RollID` (or an `IDNumber` like "6184-A" -> "6184"), so we
 * dedupe to avoid slitting inflating the count above the rolls ordered. Mirrors
 * demand.fetchPoRolls' identifier logic. Chunked by StkDate month to dodge the
 * gateway 1000-row cap. READ-ONLY.
 */
async function fetchReceivedRollCounts(sinceIso: string): Promise<Map<string, number>> {
  const ranges = eachMonthRange(sinceIso, todayIso());
  const chunks = await Promise.all(
    ranges.map(async (r) => {
      const sql =
        "SELECT PONumber, FootLength, IDNumber, Orig_RollID FROM rollstock " +
        `WHERE PONumber IS NOT NULL AND StkDate >= {d '${r.from}'} AND StkDate <= {d '${r.to}'}`;
      const rows = await runGatewaySql(sql);
      if (rows.length >= 1000) {
        // eslint-disable-next-line no-console
        console.warn(`[labeltraxxPo.fetchReceivedRollCounts] chunk ${r.from}..${r.to} hit row cap (${rows.length})`);
      }
      return rows;
    }),
  );
  const perPo = new Map<string, Set<string>>();
  let unkSeq = 0;
  for (const rows of chunks) {
    for (const row of rows) {
      const poNumber = pickString(row, "PONumber");
      if (!poNumber) continue;
      if (pickNumber(row, "FootLength") <= 0) continue;
      const orig = pickString(row, "Orig_RollID");
      const idn = pickString(row, "IDNumber");
      let key = orig && orig.trim() ? orig.trim() : "";
      if (!key && idn && idn.trim()) {
        const t = idn.trim();
        const m = t.match(/^(.+)-[A-Za-z0-9]+$/);
        key = m ? m[1]! : t;
      }
      if (!key) key = `__unk:${poNumber}:${(unkSeq += 1)}`;
      let set = perPo.get(poNumber);
      if (!set) perPo.set(poNumber, (set = new Set<string>()));
      set.add(key);
    }
  }
  const counts = new Map<string, number>();
  for (const [po, set] of perPo) counts.set(po, set.size);
  return counts;
}

/**
 * Received POs with a usable lead time, attributed to their Label Traxx
 * `Supplier`. Default lookback 730 days (2 years) so trend charts have history.
 * Chunked by Received month to dodge the gateway 1000-row cap.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function fetchPoLeadTimeRows(sinceIso?: string): Promise<PoLeadTimeRow[]> {
  // Defense in depth: `since` is interpolated into SQL date literals, so accept
  // ONLY a strict YYYY-MM-DD value; anything else falls back to the default.
  const since = sinceIso && ISO_DATE.test(sinceIso) ? sinceIso : addDaysIso(todayIso(), -730);
  const ranges = eachMonthRange(since, todayIso());
  const [chunks, rollCounts] = await Promise.all([
    Promise.all(
      ranges.map(async (r) => {
        const sql =
          "SELECT PONumber, PODate, Received, Supplier, POType, Quantity FROM purchaseorder " +
          `WHERE PONumber IS NOT NULL AND Received >= {d '${r.from}'} AND Received <= {d '${r.to}'}`;
        const rows = await runGatewaySql(sql);
        if (rows.length >= 1000) {
          // eslint-disable-next-line no-console
          console.warn(`[labeltraxxPo.fetchPoLeadTimeRows] chunk ${r.from}..${r.to} hit row cap (${rows.length})`);
        }
        return rows;
      }),
    ),
    fetchReceivedRollCounts(since),
  ]);
  const out: PoLeadTimeRow[] = [];
  for (const rows of chunks) {
    for (const row of rows) {
      const poNumber = pickString(row, "PONumber");
      if (!poNumber) continue;
      const supplier = (pickString(row, "Supplier") ?? "").trim();
      if (!supplier || INTERNAL_SUPPLIERS.has(supplier.toLowerCase())) continue;
      const placed = normalizeLabelTraxxDate(pickString(row, "PODate"));
      const received = normalizeLabelTraxxDate(pickString(row, "Received"));
      if (!placed || !received || isBlankDate(placed) || isBlankDate(received)) continue;
      const days = diffDays(placed, received);
      if (days <= 0 || days > 365) continue; // sanity bounds
      const orderedRollsRaw = Math.round(pickNumber(row, "Quantity"));
      const orderedRolls = orderedRollsRaw > 0 ? orderedRollsRaw : null;
      const receivedRolls = rollCounts.get(poNumber) ?? null;
      out.push({
        poNumber,
        supplierName: supplier,
        placedDate: placed,
        receivedDate: received,
        leadDays: Math.round(days),
        poType: pickString(row, "POType"),
        orderedRolls,
        receivedRolls,
      });
    }
  }
  return out;
}
