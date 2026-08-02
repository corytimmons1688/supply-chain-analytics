import { db, materialPoTable, materialPoLineTable, stockGoalTable, ltStockTable, poEmailEventTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { updateLtStockCost, ltApiConfigured } from "./ltApi";
import { logger } from "./logger";

/**
 * Price revisions driven by what a vendor confirms.
 *
 * When an acknowledgement comes back at a different unit price — or the vendor
 * asks for an updated PO to confirm one — three things have to move together:
 *
 *   1. the PO line's price, so our PO document, print view and re-send email
 *      all show what the vendor will actually invoice;
 *   2. the stock's construction cost (CostMSI), so every downstream number
 *      (EOQ, unit value, carrying cost, E&O valuation) uses the latest price —
 *      written to BOTH our local override and the Label Traxx stock master;
 *   3. the buyer's attention, because the PO's own dollar total in Label Traxx
 *      cannot be revised through the Cloud API.
 *
 * On (3): the LT Cloud API exposes /stock-purchase-order-create but no PO
 * update endpoint (verified across all 121 documented paths). Editing a PO's
 * amount would mean raw SQL against purchaseorder + its cost subtables through
 * the ODBC gateway, bypassing LT's own costing logic on a financial record —
 * so this deliberately stops at a flag carrying the exact old→new numbers
 * rather than writing money into the ERP behind LT's back.
 */

/** Ignore floating-point noise and true rounding dust. */
const PRICE_EPSILON = 0.00005;
/** A swing this large is more likely a parse error than a real price change. */
const IMPLAUSIBLE_RATIO = 5;

export interface PriceRevisionInput {
  poId: string;
  /** Unit price the vendor confirmed. */
  confirmedUnitPrice: number;
  /** Basis it was quoted in — only MSI can be applied without conversion. */
  priceUnit: string | null;
  /** Where the price came from, for the audit note. */
  source: string;
}

export interface PriceRevisionResult {
  applied: boolean;
  /** Human-readable outcome for the timeline / attention reason. */
  detail: string;
  stockId?: string;
  oldPrice?: number | null;
  newPrice?: number;
  ltStockUpdated?: boolean;
  /** LT PO numbers whose dollar amount a human still has to revise in LT. */
  ltPoNumbers?: string;
}

/**
 * Apply a vendor-confirmed unit price to the PO line, the stock's CostMSI
 * override, and the Label Traxx stock master. Returns what happened; the
 * caller decides how to surface it.
 */
export async function applyConfirmedPrice(input: PriceRevisionInput): Promise<PriceRevisionResult> {
  const [po] = await db.select().from(materialPoTable).where(eq(materialPoTable.id, input.poId)).limit(1);
  if (!po) return { applied: false, detail: "PO not found" };

  // Only MSI is applied automatically. Anything else needs a conversion factor
  // we can't infer (per-pound needs basis weight, per-each needs roll size),
  // so it becomes a flag with the vendor's number rather than a wrong maths.
  const unit = (input.priceUnit ?? "MSI").toUpperCase();
  if (unit !== "MSI") {
    return {
      applied: false,
      detail: `Vendor confirmed ${input.confirmedUnitPrice} per ${input.priceUnit} — not per MSI, so it needs a manual conversion before prices are updated.`,
    };
  }

  const lines = await db.select().from(materialPoLineTable).where(eq(materialPoLineTable.poId, input.poId));
  const line = lines[0];
  if (!line) return { applied: false, detail: "PO has no line to price" };
  // A PO is always one material, but guard rather than silently price line 1.
  if (lines.length > 1) {
    return {
      applied: false,
      detail: `PO carries ${lines.length} lines — price left unchanged so the wrong material isn't repriced.`,
    };
  }

  const oldPrice = line.msiCost ?? null;
  const newPrice = input.confirmedUnitPrice;
  if (newPrice <= 0) return { applied: false, detail: `Ignored a non-positive confirmed price (${newPrice}).` };
  if (oldPrice != null && Math.abs(newPrice - oldPrice) <= PRICE_EPSILON) {
    return { applied: false, detail: `Vendor's price ${newPrice}/MSI matches ours — nothing to revise.` };
  }
  if (oldPrice != null && oldPrice > 0) {
    const ratio = newPrice / oldPrice;
    if (ratio > IMPLAUSIBLE_RATIO || ratio < 1 / IMPLAUSIBLE_RATIO) {
      return {
        applied: false,
        detail: `Vendor's price ${newPrice}/MSI is ${ratio > 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)}× ours (${oldPrice}) — too large a swing to apply automatically; check the document.`,
      };
    }
  }

  // 1. The PO line — drives the PO document, print view and re-send email.
  const footage = line.footage ?? 0;
  const width = line.width ?? 0;
  const estCost = footage > 0 && width > 0 ? (footage * 12 * width * newPrice) / 1000 : line.estCost;
  await db
    .update(materialPoLineTable)
    .set({ msiCost: newPrice, ...(estCost != null ? { estCost } : {}) })
    .where(eq(materialPoLineTable.id, line.id));

  // 2a. Our stock cost override — what every dashboard calculation reads.
  const [goal] = await db.select().from(stockGoalTable).where(eq(stockGoalTable.stockId, line.stockId)).limit(1);
  if (goal) {
    await db.update(stockGoalTable).set({ msiCost: newPrice }).where(eq(stockGoalTable.stockId, line.stockId));
  } else {
    await db.insert(stockGoalTable).values({ stockId: line.stockId, msiCost: newPrice }).onConflictDoNothing();
  }

  // 2b. The Label Traxx stock master, so LT's own costing matches.
  let ltStockUpdated = false;
  if (ltApiConfigured()) {
    try {
      const [st] = await db.select().from(ltStockTable).where(eq(ltStockTable.stockId, line.stockId)).limit(1);
      await updateLtStockCost({
        stockNumber: line.stockId,
        costMsi: newPrice,
        // Freight is a separate LT field; pass ours through so an omitted
        // value can't be read as a change to it.
        freightMsi: st?.freightMsi ?? null,
      });
      await db.update(ltStockTable).set({ costMsi: newPrice }).where(eq(ltStockTable.stockId, line.stockId));
      ltStockUpdated = true;
    } catch (e) {
      logger.warn(
        { stockId: line.stockId, err: e instanceof Error ? e.message : String(e) },
        "LT stock cost update failed",
      );
    }
  }

  const priceTxt = `${oldPrice != null ? `$${oldPrice}` : "(unpriced)"} → $${newPrice}/MSI`;
  const detail =
    `Price revised on stock #${line.stockId}: ${priceTxt} (${input.source}). ` +
    `PO line and our stock cost updated${ltStockUpdated ? "; Label Traxx stock master updated too" : "; Label Traxx stock master NOT updated — see logs"}.` +
    (po.ltPoNumbers ? ` Label Traxx PO ${po.ltPoNumbers} still shows the old amount — LT has no PO-edit API, so revise the PO total in Label Traxx.` : "");

  await db.insert(poEmailEventTable).values({
    poId: input.poId,
    direction: "system",
    kind: "note",
    summary: detail,
    extracted: {
      kind: "price_revision",
      stockId: line.stockId,
      oldMsiCost: oldPrice,
      newMsiCost: newPrice,
      ltStockUpdated,
      ltPoNumbers: po.ltPoNumbers,
      source: input.source,
    },
  });
  logger.info(
    { poId: input.poId, stockId: line.stockId, oldPrice, newPrice, ltStockUpdated },
    "Applied vendor-confirmed price",
  );

  return {
    applied: true,
    detail,
    stockId: line.stockId,
    oldPrice,
    newPrice,
    ltStockUpdated,
    ...(po.ltPoNumbers ? { ltPoNumbers: po.ltPoNumbers } : {}),
  };
}
