import { db, ltRollTable, ltStockTable, ltPoTable } from "@workspace/db";

/**
 * Per-roll dollar cost, derived instead of read from ODBC.
 *
 * `rollstock.CostOfRoll` exists only in the Label Traxx database — the Cloud API
 * returns 18 fields on a roll and not one of them is a cost. It was the last
 * reason the ODBC gateway existed, so it has to be reconstructed from what the
 * API does give.
 *
 * Two sources, best first:
 *
 *  1. THE ROLL'S OWN PURCHASE ORDER. Every roll carries its poNumber, and
 *     purchase-order-details exposes receivedTotal / total / subTotal. Sharing a
 *     PO's actual cost across the rolls it delivered, weighted by MSI, gives a
 *     real purchase cost — arguably better than CostOfRoll, because it reflects
 *     what was actually paid on that order rather than a standing rate.
 *
 *  2. THE STOCK'S COST/MSI when the PO is unknown or carries no total: rolls
 *     received before the mirror started, cycle-count rolls with a "CC" tag
 *     instead of a PO, and make-and-hold stock. This is list cost, not paid
 *     cost, so it's flagged so callers can say which they're showing.
 *
 * Everything reads the Neon mirror, so no live API calls and no gateway.
 */

export type CostBasis = "po_actual" | "stock_rate" | "unknown";

export interface RollCost {
  rollId: string;
  stockId: string;
  footage: number;
  widthIn: number;
  msi: number;
  cost: number;
  basis: CostBasis;
}

/** footage x width -> MSI (thousand square inches), the unit LT prices in. */
export function toMsi(footage: number, widthIn: number): number {
  return (footage * 12 * widthIn) / 1000;
}

export interface RollCostTable {
  byRollId: Map<string, RollCost>;
  /** Coverage, so a caller can report how much of a total is paid vs rated. */
  counts: Record<CostBasis, number>;
}

/**
 * Cost every roll in the mirror. Built once and reused — the maps are small
 * (~23k rolls) and the alternative is a query per roll.
 */
export async function buildRollCosts(): Promise<RollCostTable> {
  const [rolls, stocks, pos] = await Promise.all([
    db.select().from(ltRollTable),
    db.select().from(ltStockTable),
    db.select().from(ltPoTable),
  ]);
  const stockBy = new Map(stocks.map((s) => [s.stockId, s]));
  const poBy = new Map(pos.map((p) => [p.poNumber, p]));

  // MSI delivered per PO, so a PO's total can be shared out proportionally.
  const msiByPo = new Map<string, number>();
  for (const r of rolls) {
    const po = (r.poNumber ?? "").trim();
    if (!po) continue;
    const w = r.width ?? stockBy.get(r.stockId ?? "")?.masterWidth ?? 0;
    const ft = r.length ?? 0;
    if (w <= 0 || ft <= 0) continue;
    msiByPo.set(po, (msiByPo.get(po) ?? 0) + toMsi(ft, w));
  }

  /** The amount actually paid on a PO, preferring received over ordered. */
  const poAmount = (poNumber: string): number => {
    const p = poBy.get(poNumber);
    if (!p) return 0;
    // receivedTotal reflects what arrived; total/subTotal are the order.
    return Number(p.receivedTotal ?? 0) || Number(p.total ?? 0) || Number(p.subTotal ?? 0) || 0;
  };

  const byRollId = new Map<string, RollCost>();
  const counts: Record<CostBasis, number> = { po_actual: 0, stock_rate: 0, unknown: 0 };

  for (const r of rolls) {
    const stockId = (r.stockId ?? "").trim();
    const st = stockBy.get(stockId);
    const widthIn = r.width ?? st?.masterWidth ?? 0;
    const footage = r.length ?? 0;
    const msi = widthIn > 0 && footage > 0 ? toMsi(footage, widthIn) : 0;
    const po = (r.poNumber ?? "").trim();

    let cost = 0;
    let basis: CostBasis = "unknown";
    const poTotal = po ? poAmount(po) : 0;
    const poMsi = po ? (msiByPo.get(po) ?? 0) : 0;
    if (poTotal > 0 && poMsi > 0 && msi > 0) {
      cost = poTotal * (msi / poMsi);
      basis = "po_actual";
    } else if (msi > 0 && st) {
      cost = msi * ((st.costMsi ?? 0) + (st.freightMsi ?? 0));
      if (cost > 0) basis = "stock_rate";
    }
    counts[basis] += 1;
    byRollId.set(r.rollId, {
      rollId: r.rollId,
      stockId,
      footage,
      widthIn,
      msi,
      cost: Math.round(cost * 100) / 100,
      basis,
    });
  }
  return { byRollId, counts };
}

export interface OnHandValue {
  totalValue: number;
  rollCount: number;
  /** How much of the total came from real PO amounts vs a standing rate. */
  valueFromPoActual: number;
  valueFromStockRate: number;
  rollsWithoutCost: number;
}

/**
 * On-hand dollar value and roll count — the replacement for the ODBC
 * `SELECT CostOfRoll FROM rollstock WHERE DateRollUsed < 1900` read.
 */
export async function fetchOnHandValueFromMirror(): Promise<OnHandValue> {
  const { byRollId } = await buildRollCosts();
  const rolls = await db.select().from(ltRollTable);
  let totalValue = 0;
  let rollCount = 0;
  let fromPo = 0;
  let fromRate = 0;
  let noCost = 0;
  for (const r of rolls) {
    if (r.used) continue; // on hand only
    const c = byRollId.get(r.rollId);
    rollCount += 1;
    if (!c || c.cost <= 0) {
      noCost += 1;
      continue;
    }
    totalValue += c.cost;
    if (c.basis === "po_actual") fromPo += c.cost;
    else fromRate += c.cost;
  }
  return {
    totalValue: Math.round(totalValue * 100) / 100,
    rollCount,
    valueFromPoActual: Math.round(fromPo * 100) / 100,
    valueFromStockRate: Math.round(fromRate * 100) / 100,
    rollsWithoutCost: noCost,
  };
}
