import { db, dazpakJobTable, ltPoTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { fetchDazpakRows, dazpakConfigured } from "./dazpakApi";
import { logger } from "./logger";

/** Chunk helper (mirrors lt-sync). */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Pull all Dazpak job rows into the mirror (upsert by rowId). */
export async function performDazpakSync(): Promise<{ dazpak: number }> {
  if (!dazpakConfigured()) throw new Error("DAZPAK_API_KEY is not configured");
  const rows = await fetchDazpakRows();
  const values = rows.map((r) => ({
    rowId: r.rowId,
    custPo: r.custPo,
    custItemRef: r.custItemRef,
    itemDesc: r.itemDesc,
    itemCode: r.itemCode,
    orderStatus: r.orderStatus,
    unit: r.unit,
    jobOrdQty: r.jobOrdQty,
    jobOutstQty: r.jobOutstQty,
    jobRecdQty: r.jobRecdQty,
    planAvailDate: r.planAvailDate,
    salesOrderNum: r.salesOrderNum,
    plant: r.plant,
    syncedAt: new Date(),
  }));
  for (const batch of chunk(values, 200)) {
    await db
      .insert(dazpakJobTable)
      .values(batch)
      .onConflictDoUpdate({
        target: dazpakJobTable.rowId,
        set: {
          custPo: sql`excluded.cust_po`,
          custItemRef: sql`excluded.cust_item_ref`,
          itemDesc: sql`excluded.item_desc`,
          itemCode: sql`excluded.item_code`,
          orderStatus: sql`excluded.order_status`,
          unit: sql`excluded.unit`,
          jobOrdQty: sql`excluded.job_ord_qty`,
          jobOutstQty: sql`excluded.job_outst_qty`,
          jobRecdQty: sql`excluded.job_recd_qty`,
          planAvailDate: sql`excluded.plan_avail_date`,
          salesOrderNum: sql`excluded.sales_order_num`,
          plant: sql`excluded.plant`,
          syncedAt: new Date(),
        },
      });
  }
  logger.info({ dazpak: values.length }, "Dazpak sync ran");
  return { dazpak: values.length };
}

export interface DazpakLine {
  poNumber: string;
  custItemRef: string | null;
  status: string; // Held | Authorised | Complete | ...
  outstandingFootage: number;
  planAvailDate: string | null;
}
export interface DazpakStockSupply {
  /** Made & waiting at Dazpak — releasable (~5 business days). */
  heldFootage: number;
  /** In production (Authorised) — arrives by the earliest Plan Avail Date. */
  inProductionFootage: number;
  /** Earliest Plan Avail ETA across in-production lines. */
  etaDate: string | null;
  lines: DazpakLine[];
}

/**
 * Dazpak make-and-hold supply per Calyx stock, joined by
 * dazpak_job.custPo → lt_po.po_number (supplier "Dazpak") → lt_po.stock_num.
 * Only outstanding (not-yet-received) footage counts; Complete lines drop out.
 */
export async function fetchDazpakByStock(): Promise<Map<string, DazpakStockSupply>> {
  const rows = await db
    .select({
      stockNum: ltPoTable.stockNum,
      poNumber: ltPoTable.poNumber,
      custItemRef: dazpakJobTable.custItemRef,
      status: dazpakJobTable.orderStatus,
      outst: dazpakJobTable.jobOutstQty,
      planAvail: dazpakJobTable.planAvailDate,
    })
    .from(dazpakJobTable)
    .innerJoin(
      ltPoTable,
      and(eq(dazpakJobTable.custPo, ltPoTable.poNumber), eq(ltPoTable.supplierName, "Dazpak")),
    );

  const out = new Map<string, DazpakStockSupply>();
  for (const r of rows) {
    const stockId = r.stockNum;
    const outst = r.outst ?? 0;
    if (!stockId || outst <= 0) continue; // Complete / delivered lines have 0 outstanding
    const status = (r.status ?? "").trim();
    let entry = out.get(stockId);
    if (!entry) {
      entry = { heldFootage: 0, inProductionFootage: 0, etaDate: null, lines: [] };
      out.set(stockId, entry);
    }
    if (status === "Held") entry.heldFootage += outst;
    else entry.inProductionFootage += outst; // Authorised (and any other open state)
    if (status !== "Held" && r.planAvail) {
      if (!entry.etaDate || r.planAvail < entry.etaDate) entry.etaDate = r.planAvail;
    }
    entry.lines.push({
      poNumber: r.poNumber,
      custItemRef: r.custItemRef,
      status: status || "Unknown",
      outstandingFootage: Math.round(outst),
      planAvailDate: r.planAvail,
    });
  }
  for (const entry of out.values()) {
    entry.heldFootage = Math.round(entry.heldFootage);
    entry.inProductionFootage = Math.round(entry.inProductionFootage);
    entry.lines.sort((a, b) => (a.planAvailDate ?? "9999").localeCompare(b.planAvailDate ?? "9999"));
  }
  return out;
}
