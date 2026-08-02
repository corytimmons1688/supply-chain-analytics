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
  /** Footage this run has produced into Dazpak's warehouse (their "Recd"). */
  madeFootage: number;
  planAvailDate: string | null;
}
export interface DazpakStockSupply {
  /** Made & holding at Dazpak — releasable (~5 business days). */
  heldFootage: number;
  /** Still in production — arrives by the earliest Plan Avail Date. */
  inProductionFootage: number;
  /** Earliest Plan Avail ETA across in-production lines. */
  etaDate: string | null;
  lines: DazpakLine[];
}

/**
 * Dazpak make-and-hold supply per Calyx stock, joined by
 * dazpak_job.custPo → lt_po.po_number (supplier "Dazpak") → lt_po.stock_num.
 *
 * QUANTITY SEMANTICS (proven against POs 2387/2556/2535 on 2026-08-02):
 * Dazpak's "Recd" is footage produced INTO THEIR warehouse, not footage we
 * received — a job with recd>0 on an LT PO we have NOT yet received is the
 * made-and-hold inventory sitting at Dazpak. Their "Held" status is rarely
 * used (roll jobs stay "Authorised" through production and holding), so
 * held = produced-on-unreceived-POs + explicit Held rows. Rows on POs LT has
 * received (receivedDate set or closed) are delivered — excluded entirely.
 */
export async function fetchDazpakByStock(): Promise<Map<string, DazpakStockSupply>> {
  const rows = await db
    .select({
      stockNum: ltPoTable.stockNum,
      poNumber: ltPoTable.poNumber,
      custItemRef: dazpakJobTable.custItemRef,
      status: dazpakJobTable.orderStatus,
      outst: dazpakJobTable.jobOutstQty,
      made: dazpakJobTable.jobRecdQty,
      planAvail: dazpakJobTable.planAvailDate,
      ltClosed: ltPoTable.closed,
      ltReceivedDate: ltPoTable.receivedDate,
    })
    .from(dazpakJobTable)
    .innerJoin(
      ltPoTable,
      and(eq(dazpakJobTable.custPo, ltPoTable.poNumber), eq(ltPoTable.supplierName, "Dazpak")),
    );

  const out = new Map<string, DazpakStockSupply>();
  for (const r of rows) {
    const stockId = r.stockNum;
    if (!stockId) continue;
    if (r.ltClosed === true || r.ltReceivedDate != null) continue; // delivered to Calyx
    const outst = r.outst ?? 0;
    const made = r.made ?? 0;
    if (outst <= 0 && made <= 0) continue; // run not started, nothing produced
    const status = (r.status ?? "").trim();
    let entry = out.get(stockId);
    if (!entry) {
      entry = { heldFootage: 0, inProductionFootage: 0, etaDate: null, lines: [] };
      out.set(stockId, entry);
    }
    entry.heldFootage += made + (status === "Held" ? outst : 0);
    if (status !== "Held") entry.inProductionFootage += outst;
    if (status !== "Held" && outst > 0 && r.planAvail) {
      if (!entry.etaDate || r.planAvail < entry.etaDate) entry.etaDate = r.planAvail;
    }
    entry.lines.push({
      poNumber: r.poNumber,
      custItemRef: r.custItemRef,
      status: status || "Unknown",
      outstandingFootage: Math.round(outst),
      madeFootage: Math.round(made),
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
