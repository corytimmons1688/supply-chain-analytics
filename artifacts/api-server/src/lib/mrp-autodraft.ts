import { db, materialPoTable, materialPoLineTable, stockGoalTable, ltStockTable, vendorContactTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { buildMrp, type MrpRow } from "./mrp";
import { appendPoEvent } from "./po-agent";
import { isMakeAndHoldPo } from "./open-po-status";
import { logger } from "./logger";

/**
 * Draft purchase orders from the plan's planned-order releases.
 *
 * The MRP already works out what to order, at which width, and the week it has
 * to be released — including the rows where the lead time means it should have
 * gone out already. Nothing consumed any of it: a buyer still assembled every PO
 * by hand from a separate list built on stock-level maths. This closes that gap,
 * so the job becomes approving orders rather than composing them.
 *
 * DRAFT ONLY. Same discipline as the agent's emails — this writes material_po
 * rows with status "draft" and createdBy "mrp". Nothing reaches Label Traxx or a
 * vendor until a human approves it.
 *
 * One PO per stock AND width, matching the existing convention that POs are
 * 1-to-1 with a material (a vendor slitting 12.75" and 30" needs two orders, not
 * one with two lines).
 */

export interface AutoDraftResult {
  rowsConsidered: number;
  drafted: number;
  skippedExistingDraft: number;
  skippedNoVendor: number;
  skippedDiscontinued: number;
  skippedBadConfig: number;
  /** Make-and-hold materials, which are released rather than purchased. */
  skippedMakeAndHold: number;
  drafts: { poId: string; stockId: string; width: number; rolls: number; footage: number; vendorName: string }[];
  skipped: { stockId: string; width: number; reason: string }[];
}

/** Release footage sitting in the current week — i.e. "order this now". */
function releaseNow(row: MrpRow): { footage: number; rolls: number } | null {
  const cell = row.cells[0];
  if (!cell || cell.plannedOrderRelease <= 0) return null;
  return { footage: cell.plannedOrderRelease, rolls: cell.plannedOrderRolls };
}

export async function draftPlannedPos(opts: { dryRun?: boolean } = {}): Promise<AutoDraftResult> {
  const plan = await buildMrp();
  const out: AutoDraftResult = {
    rowsConsidered: 0,
    drafted: 0,
    skippedExistingDraft: 0,
    skippedNoVendor: 0,
    skippedDiscontinued: 0,
    skippedBadConfig: 0,
    skippedMakeAndHold: 0,
    drafts: [],
    skipped: [],
  };

  const candidates = plan.rows.filter((r) => releaseNow(r) != null);
  out.rowsConsidered = candidates.length;
  if (candidates.length === 0) return out;

  // Existing drafts, so a cron running daily doesn't pile up a new PO for the
  // same material every morning. A draft that hasn't been approved yet already
  // represents this need; re-drafting would bury the buyer rather than help.
  const openDrafts = await db
    .select()
    .from(materialPoTable)
    .where(and(eq(materialPoTable.status, "draft"), eq(materialPoTable.kind, "po")));
  const draftLines = openDrafts.length
    ? await db
        .select()
        .from(materialPoLineTable)
        .where(inArray(materialPoLineTable.poId, openDrafts.map((p) => p.id)))
    : [];
  const alreadyDrafted = new Set(
    draftLines.map((l) => `${l.stockId}|${l.width != null ? Math.round(l.width * 100) / 100 : "x"}`),
  );

  const [goals, stocks, contacts] = await Promise.all([
    db.select().from(stockGoalTable),
    db.select().from(ltStockTable),
    db.select().from(vendorContactTable),
  ]);
  const goalBy = new Map(goals.map((g) => [g.stockId, g]));
  const stockBy = new Map(stocks.map((s) => [s.stockId, s]));
  const contactBy = new Map(contacts.map((c) => [c.vendorName, c]));

  for (const row of candidates) {
    const rel = releaseNow(row)!;
    const key = `${row.stockId}|${row.width}`;
    const goal = goalBy.get(row.stockId);
    const stock = stockBy.get(row.stockId);
    const vendorName = (goal?.vendorName ?? stock?.supplierName ?? "").trim();

    if (alreadyDrafted.has(key)) {
      out.skippedExistingDraft += 1;
      out.skipped.push({ stockId: row.stockId, width: row.width, reason: "a draft PO for this material and width already exists" });
      continue;
    }
    if (row.drivers.discontinued) {
      // Belt and braces: the plan already excludes these, but a machine that
      // orders end-of-life material is worse than one that orders nothing.
      out.skippedDiscontinued += 1;
      out.skipped.push({ stockId: row.stockId, width: row.width, reason: "marked discontinued" });
      continue;
    }
    if (!vendorName) {
      out.skippedNoVendor += 1;
      out.skipped.push({ stockId: row.stockId, width: row.width, reason: "no vendor configured — set one under Setup › Configuration" });
      continue;
    }
    if (row.makeAndHoldSupplyFootage > 0 || isMakeAndHoldPo(stock?.supplierName ?? vendorName)) {
      /**
       * Make-and-hold materials are never bought with an ordinary PO. Either the
       * vendor is already holding stock (a release calls it in) or they aren't (a
       * new make-and-hold is a different, longer conversation). Auto-raising a
       * purchase order here would order material Dazpak has already made.
       */
      out.skippedMakeAndHold += 1;
      out.skipped.push({
        stockId: row.stockId,
        width: row.width,
        reason: "make-and-hold material — request a release, or trigger a new make-and-hold, from the Make & Hold panel",
      });
      continue;
    }
    if (row.orderQuantityIgnored != null) {
      // The plan sized this order after ignoring an implausible config value.
      // Fine for a report to show; not fine to auto-raise a PO from.
      out.skippedBadConfig += 1;
      out.skipped.push({
        stockId: row.stockId,
        width: row.width,
        reason: `order quantity configured as ${Math.round(row.orderQuantityIgnored)} master rolls, which is implausible — fix it before this can be auto-drafted`,
      });
      continue;
    }

    if (opts.dryRun) {
      out.drafted += 1;
      out.drafts.push({ poId: "(dry-run)", stockId: row.stockId, width: row.width, rolls: rel.rolls, footage: rel.footage, vendorName });
      continue;
    }

    // Requested delivery = the week the material is actually needed, which is
    // the release week plus the lead time — not "today + lead time", because the
    // plan already knows when it has to land.
    const needBy = row.cells.find((c) => c.plannedOrderReceipt > 0)?.weekEnd ?? row.cells[0]!.weekEnd;
    const msiCost = goal?.msiCost ?? stock?.costMsi ?? null;
    const estCost =
      msiCost != null && row.width > 0 ? ((rel.footage * 12 * row.width) / 1000) * (msiCost + (stock?.freightMsi ?? 0)) : null;

    const [po] = await db
      .insert(materialPoTable)
      .values({
        vendorName,
        vendorEmails: contactBy.get(vendorName)?.toEmails ?? goal?.vendorEmails ?? null,
        kind: "po",
        status: "draft",
        createdBy: "mrp",
        plannedForWeek: row.cells[0]!.weekStart,
        requestedDeliveryDate: needBy,
        notes: null,
      })
      .returning();

    await db.insert(materialPoLineTable).values({
      poId: po!.id,
      stockId: row.stockId,
      description: row.description,
      rolls: rel.rolls,
      footage: rel.footage,
      width: row.width > 0 ? row.width : null,
      msiCost,
      estCost,
    });

    await appendPoEvent(po!.id, {
      direction: "system",
      kind: "note",
      summary:
        `Drafted from the plan: ${rel.rolls} roll${rel.rolls === 1 ? "" : "s"} (${Math.round(rel.footage).toLocaleString()} ft) ` +
        `of #${row.stockId} at ${row.widthLabel}, release week of ${row.cells[0]!.weekStart}, needed by ${needBy}. ` +
        `Reorder point ${Math.round(row.drivers.reorderPointFootage).toLocaleString()} ft (${row.drivers.reorderBasis}), ` +
        `lead time ${row.drivers.leadTimeDays}d from ${row.drivers.leadTimeSource}` +
        (row.lateReleaseFootage > 0
          ? `. ${Math.round(row.lateReleaseFootage).toLocaleString()} ft of this needed releasing before the horizon opened — already behind.`
          : "."),
    });

    out.drafted += 1;
    out.drafts.push({ poId: po!.id, stockId: row.stockId, width: row.width, rolls: rel.rolls, footage: rel.footage, vendorName });
    alreadyDrafted.add(key);
  }

  logger.info({ ...out, drafts: out.drafts.length, skipped: out.skipped.length }, "Planned POs drafted from the MRP");
  return out;
}
