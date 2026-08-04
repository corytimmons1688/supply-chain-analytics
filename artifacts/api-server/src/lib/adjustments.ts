import { db, ltRollTable } from "@workspace/db";
import { parseCcDate } from "./cc";
import { buildRollCosts, fetchOnHandValueFromMirror, type CostBasis } from "./roll-cost";

/**
 * Cycle-count adjustments and on-hand valuation, off ODBC.
 *
 * Both used to read `rollstock` directly for `CostOfRoll`, which the Cloud API
 * doesn't expose — the last reason the gateway existed. Everything else these
 * needed (StockNum, PONumber, UsedTikNum, FootLength, StkDate, DateRollUsed,
 * Description) is already mirrored on lt_roll, so only the cost had to be
 * replaced, and that is now derived in lib/roll-cost.ts.
 *
 * One consequence worth knowing: a derived cost is a PO's actual amount shared
 * across its rolls by MSI, so an adjustment's dollar value is what was paid for
 * that material rather than LT's stored per-roll figure. The two won't match to
 * the cent.
 */
export async function fetchOnHandValue(): Promise<{ totalValue: number; rollCount: number }> {
  const v = await fetchOnHandValueFromMirror();
  return { totalValue: v.totalValue, rollCount: v.rollCount };
}

export interface AdjustmentRecord {
  id: string;
  rollTag: string;
  stockId: string;
  description: string | null;
  direction: "added" | "removed";
  amount: number;
  footage: number;
  ccDate: string;
  ccString: string;
  poNumber: string | null;
  usedTikNum: string | null;
  rowDate: string | null;
}

interface FetchOptions {
  from: string;
  to: string;
  stockId?: string;
  /** If provided, exclude any rows whose StockNum is not in this set. */
  activeStockIds?: Set<string>;
}

/**
 * Fetch all adjustment rows whose CC date falls in [from, to].
 * We pull rows where PONumber or UsedTikNum starts with "CC " (case-insensitive),
 * parse the CC date in app code, then filter by window.
 */
export async function fetchAdjustments(opts: FetchOptions): Promise<AdjustmentRecord[]> {
  // CC rolls are tagged in PONumber (added) or UsedTikNum (removed), both mirrored.
  const rolls = await db.select().from(ltRollTable);
  const { byRollId } = await buildRollCosts();

  const out: AdjustmentRecord[] = [];
  for (const r of rolls) {
    const stockId = (r.stockId ?? "").trim();
    if (opts.stockId && stockId !== opts.stockId) continue;
    if (opts.activeStockIds && (!stockId || !opts.activeStockIds.has(stockId))) continue;

    const po = r.poNumber;
    const used = r.usedTikNum;
    const isCc = /^\s*cc\s+/i.test(po ?? "") || /^\s*cc\s+/i.test(used ?? "");
    if (!isCc) continue;

    const addedDate = parseCcDate(po);
    const removedDate = parseCcDate(used);
    const cost = byRollId.get(r.rollId);
    const row = {
      rollTag: r.rollId,
      stockId,
      description: r.description,
      amount: cost?.cost ?? 0,
      basis: cost?.basis ?? ("unknown" as CostBasis),
      footage: r.length ?? 0,
      poNumber: po,
      usedTikNum: used,
      stockDate: r.stockDate,
      dateRollUsed: r.dateRollUsed,
    };
    if (addedDate && addedDate >= opts.from && addedDate <= opts.to) {
      out.push(buildRecord(row, "added", po!, addedDate));
    }
    if (removedDate && removedDate >= opts.from && removedDate <= opts.to) {
      out.push(buildRecord(row, "removed", used!, removedDate));
    }
  }
  return out;
}

interface MirrorRow {
  rollTag: string;
  stockId: string;
  description: string | null;
  amount: number;
  basis: CostBasis;
  footage: number;
  poNumber: string | null;
  usedTikNum: string | null;
  stockDate: string | null;
  dateRollUsed: string | null;
}

function buildRecord(
  row: MirrorRow,
  direction: "added" | "removed",
  ccString: string,
  ccDate: string,
): AdjustmentRecord {
  const rowDate = direction === "added" ? row.stockDate : row.dateRollUsed;
  return {
    id: `${row.rollTag}-${direction}`,
    rollTag: row.rollTag,
    stockId: row.stockId,
    description: row.description,
    direction,
    amount: row.amount,
    footage: row.footage,
    ccDate,
    ccString,
    poNumber: row.poNumber,
    usedTikNum: row.usedTikNum,
    rowDate: normalizeDate(rowDate),
  };
}

function normalizeDate(v: string | null): string | null {
  if (!v) return null;
  // Try ISO date prefix
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Try MM/DD/YY or MM/DD/YYYY
  const m2 = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(v);
  if (m2) {
    let y = Number(m2[3]);
    if (y < 100) y = 2000 + y;
    return `${y}-${String(Number(m2[1])).padStart(2, "0")}-${String(Number(m2[2])).padStart(2, "0")}`;
  }
  return null;
}
