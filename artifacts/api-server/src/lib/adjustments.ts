import { runGatewaySql, pick, pickString, pickNumber, sqlEscape, type GatewayRow } from "./gateway";
import { parseCcDate } from "./cc";

/**
 * Total on-hand dollar value + roll count. Per-roll CostOfRoll is only
 * available through the ODBC gateway (the LT Cloud API does not expose roll
 * cost), so this intentionally stays on ODBC — the only reads that do, along
 * with fetchAdjustments below.
 */
export async function fetchOnHandValue(): Promise<{ totalValue: number; rollCount: number }> {
  const sql =
    "SELECT IDNumber, CostOfRoll * 10 AS Tenths FROM rollstock WHERE DateRollUsed < {d '1900-01-01'}";
  const rows = await runGatewaySql(sql);
  let totalTenths = 0;
  for (const row of rows) totalTenths += pickNumber(row, "Tenths");
  return {
    totalValue: Math.round((totalTenths / 10) * 100) / 100,
    rollCount: rows.length,
  };
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
  const where: string[] = [
    "(UPPER(PONumber) LIKE 'CC %' OR UPPER(UsedTikNum) LIKE 'CC %')",
  ];
  if (opts.stockId) {
    where.push(`StockNum = '${sqlEscape(opts.stockId)}'`);
  }
  const sql = `SELECT IDNumber, StockNum, PONumber, UsedTikNum, CostOfRoll, FootLength, StkDate, DateRollUsed, Description FROM rollstock WHERE ${where.join(" AND ")}`;

  const rows = await runGatewaySql(sql);
  const out: AdjustmentRecord[] = [];
  for (const row of rows) {
    if (opts.activeStockIds) {
      const sid = pickString(row, "StockNum");
      if (!sid || !opts.activeStockIds.has(sid)) continue;
    }
    const po = pickString(row, "PONumber");
    const used = pickString(row, "UsedTikNum");
    const addedDate = parseCcDate(po);
    const removedDate = parseCcDate(used);

    if (addedDate && addedDate >= opts.from && addedDate <= opts.to) {
      out.push(buildRecord(row, "added", po!, addedDate));
    }
    if (removedDate && removedDate >= opts.from && removedDate <= opts.to) {
      out.push(buildRecord(row, "removed", used!, removedDate));
    }
  }
  return out;
}

function buildRecord(
  row: GatewayRow,
  direction: "added" | "removed",
  ccString: string,
  ccDate: string,
): AdjustmentRecord {
  const idRaw = pick(row, "IDNumber");
  const rollTag = String(idRaw ?? "");
  const stockId = pickString(row, "StockNum") ?? "";
  const description = pickString(row, "Description");
  const amount = pickNumber(row, "CostOfRoll");
  const footage = pickNumber(row, "FootLength");
  const poNumber = pickString(row, "PONumber");
  const usedTikNum = pickString(row, "UsedTikNum");
  const stkDate = pickString(row, "StkDate");
  const usedRowDate = pickString(row, "DateRollUsed");
  const rowDate = direction === "added" ? stkDate : usedRowDate;
  return {
    id: `${rollTag}-${direction}`,
    rollTag,
    stockId,
    description,
    direction,
    amount,
    footage,
    ccDate,
    ccString,
    poNumber,
    usedTikNum,
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
