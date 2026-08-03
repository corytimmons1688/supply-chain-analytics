import { db, stockGoalTable, ltStockTable, ltRollTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { fetchDazpakByStock, type DazpakStockSupply } from "./dazpak-sync";
import { widthGroupKey } from "./demand";

/**
 * Calling in material from a make-and-hold.
 *
 * The vendor has already made the rolls and is holding them. A release asks
 * them to ship some of it, so unlike a purchase order there's nothing to price
 * and no new PO to raise — but we still need a confirmation, a ship date and a
 * tracking number back, which is exactly what the follow-up agent chases. So a
 * release is created as a material_po with kind "mah_release" and rides the
 * same draft → email → agent path.
 *
 * Two constraints shape the quantity:
 *  - Rolls are indivisible. The vendor ships whole rolls, so the request is
 *    rounded UP to the stock's configured roll size (Setup › Configuration,
 *    "typical roll footage" — 10,000 ft on every Dazpak program stock today).
 *    Asking for 12,400 ft would just produce two rolls anyway.
 *  - Width is not fungible. Held 30" material cannot cover a ≤13" shortfall, so
 *    the release is planned per width bucket and becomes one line per width.
 */

/** Roll size to release in when a stock has none configured. */
const DEFAULT_ROLL_FOOTAGE = 10_000;

/**
 * Held material delivers in about a week — the same figure the make-and-hold
 * panel quotes, so the date we ask for matches what the dashboard promised.
 */
export const RELEASE_LEAD_BUSINESS_DAYS = 5;

/** Business days forward from an ISO date, skipping weekends (not holidays). */
export function addBusinessDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  let left = days;
  while (left > 0) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export interface MahReleaseLine {
  stockId: string;
  description: string | null;
  /** Representative width for the bucket (inches). */
  width: number;
  /** Label as the dashboard shows it — "≤13"" for the pooled bucket. */
  widthLabel: string;
  rolls: number;
  footage: number;
  /** Footage actually short before rounding to whole rolls. */
  neededFootage: number;
  /** Whole-roll footage the vendor is holding at this width. */
  heldFootage: number;
  /**
   * Set when the held material doesn't reach a full roll at this width, so the
   * request is "everything you're holding" rather than a roll multiple.
   */
  partialRoll: boolean;
  /** Make-and-hold PO numbers the material at this width sits on. */
  fromPoNumbers: string[];
}

export interface MahReleasePlan {
  stockId: string;
  description: string | null;
  vendorName: string;
  vendorEmails: string | null;
  rollFootage: number;
  rollFootageConfigured: boolean;
  lines: MahReleaseLine[];
  totalFootage: number;
  totalRolls: number;
  fromPoNumbers: string[];
  /** Why nothing can be released, when lines is empty. */
  blockedReason: string | null;
}

export interface WidthNeed {
  /** Representative width (inches) as the dashboard reports it. */
  width: number;
  label: string;
  /** Footage short at this width — the suggestion, or a buyer's override. */
  releaseFootage: number;
  heldFootage: number;
}

/**
 * Turn per-width shortfalls into a whole-roll release request.
 *
 * Rounds each width UP to the roll size, then caps at the whole rolls actually
 * held. When a width holds less than one full roll the request becomes that
 * exact footage, flagged partial — the vendor has what they have, and asking
 * for a full roll they can't ship would only produce a correction email.
 */
export function planReleaseLines(
  stockId: string,
  description: string | null,
  needs: WidthNeed[],
  rollFootage: number,
  poNumbersByWidth: Map<string, string[]>,
): MahReleaseLine[] {
  const out: MahReleaseLine[] = [];
  for (const n of needs) {
    if (n.releaseFootage <= 0 || n.heldFootage <= 0) continue;
    const rollsNeeded = Math.ceil(n.releaseFootage / rollFootage);
    const rollsHeld = Math.floor(n.heldFootage / rollFootage);
    let rolls: number;
    let footage: number;
    let partialRoll = false;
    if (rollsHeld === 0) {
      // Less than a full roll on hold — ask for the remnant as it stands.
      rolls = 1;
      footage = Math.round(n.heldFootage);
      partialRoll = true;
    } else {
      rolls = Math.min(rollsNeeded, rollsHeld);
      footage = rolls * rollFootage;
    }
    out.push({
      stockId,
      description,
      width: n.width,
      widthLabel: n.label,
      rolls,
      footage,
      neededFootage: Math.round(n.releaseFootage),
      heldFootage: Math.round(n.heldFootage),
      partialRoll,
      fromPoNumbers: poNumbersByWidth.get(widthGroupKey(n.width)) ?? [],
    });
  }
  return out.sort((a, b) => a.width - b.width);
}

/**
 * Held footage and source PO numbers per width bucket, from the vendor's feed.
 * "Held" is material already made: madeFootage, plus the outstanding balance on
 * lines the vendor has already marked Held.
 */
export function heldByWidth(
  supply: DazpakStockSupply,
  masterWidth: number | null,
): { held: Map<string, number>; pos: Map<string, string[]> } {
  const held = new Map<string, number>();
  const pos = new Map<string, string[]>();
  for (const l of supply.lines) {
    const madeFt = l.madeFootage + (l.status === "Held" ? l.outstandingFootage : 0);
    if (madeFt <= 0) continue;
    const key = widthGroupKey(l.width && l.width > 0 ? l.width : (masterWidth ?? 0));
    held.set(key, (held.get(key) ?? 0) + madeFt);
    const list = pos.get(key) ?? [];
    if (!list.includes(l.poNumber)) list.push(l.poNumber);
    pos.set(key, list);
  }
  return { held, pos };
}

/**
 * Build the release plan for one stock. `needs` comes from the dashboard's
 * width-level release suggestion (or a buyer's edit of it) so the plan matches
 * what they were looking at when they clicked.
 */
export async function planMahRelease(stockId: string, needs: WidthNeed[]): Promise<MahReleasePlan> {
  const [goal] = await db.select().from(stockGoalTable).where(eq(stockGoalTable.stockId, stockId));
  const [stock] = await db.select().from(ltStockTable).where(eq(ltStockTable.stockId, stockId));
  const configured = (goal?.typicalRollFootage ?? 0) > 0;
  const rollFootage = configured ? goal!.typicalRollFootage! : DEFAULT_ROLL_FOOTAGE;
  // The vendor on the LT stock record is authoritative — the make-and-hold
  // program is identified from it everywhere else in the app.
  const vendorName = (goal?.vendorName ?? stock?.supplierName ?? "").trim();
  // Descriptions live on lt_roll, not lt_stock (the stock master has no
  // description column) — same source the rest of the dashboard reads.
  const [roll] = await db
    .select({ description: ltRollTable.description })
    .from(ltRollTable)
    .where(and(eq(ltRollTable.stockId, stockId), eq(ltRollTable.used, false)))
    .limit(1);
  const description = roll?.description ?? null;

  const dz = await fetchDazpakByStock();
  const supply = dz.get(stockId);
  const base: MahReleasePlan = {
    stockId,
    description,
    vendorName,
    vendorEmails: goal?.vendorEmails ?? null,
    rollFootage,
    rollFootageConfigured: configured,
    lines: [],
    totalFootage: 0,
    totalRolls: 0,
    fromPoNumbers: [],
    blockedReason: null,
  };
  if (!vendorName) return { ...base, blockedReason: `No vendor on stock #${stockId} — set one under Setup › Configuration` };
  if (!supply) {
    return { ...base, blockedReason: `#${stockId} isn't on the make-and-hold feed, so we can't tell what's held` };
  }

  const { held, pos } = heldByWidth(supply, stock?.masterWidth ?? null);
  // Trust the caller's widths but never their held figures — those come from
  // the vendor feed, and a stale client shouldn't be able to over-request.
  const resolved: WidthNeed[] = needs.map((n) => ({
    ...n,
    heldFootage: held.get(widthGroupKey(n.width)) ?? 0,
  }));
  const lines = planReleaseLines(stockId, description, resolved, rollFootage, pos);
  if (lines.length === 0) {
    const anyHeld = [...held.values()].some((v) => v > 0);
    return {
      ...base,
      blockedReason: anyHeld
        ? `Nothing to release at the widths requested — held material is at a different width`
        : `${supply.lines.length > 0 ? "Everything on this make-and-hold is still in production" : "No material held"} for #${stockId}`,
    };
  }
  const fromPoNumbers = [...new Set(lines.flatMap((l) => l.fromPoNumbers))];
  return {
    ...base,
    lines,
    totalFootage: lines.reduce((s, l) => s + l.footage, 0),
    totalRolls: lines.reduce((s, l) => s + l.rolls, 0),
    fromPoNumbers,
  };
}

/**
 * Release request email. Deliberately not the PO template: there's no pricing,
 * no new PO number, and the vendor's job is to ship stock they already hold —
 * so it leads with their own PO number and the quantity in rolls.
 */
export function mahReleaseEmail(plan: {
  vendorName: string;
  vendorEmails: string | null;
  vendorCcEmails?: string | null;
  requestedDeliveryDate: string | null;
  fromPoNumbers: string[];
  lines: { stockId: string; description: string | null; width: number | null; rolls: number; footage: number | null; mfgSpecNum?: string | null }[];
}): { to: string; cc: string; subject: string; body: string; html: string } {
  const poRef = plan.fromPoNumbers.length
    ? plan.fromPoNumbers.length === 1
      ? `PO ${plan.fromPoNumbers[0]}`
      : `POs ${plan.fromPoNumbers.join(", ")}`
    : "our make-and-hold order";
  const totalRolls = plan.lines.reduce((s, l) => s + l.rolls, 0);
  const totalFt = plan.lines.reduce((s, l) => s + (l.footage ?? 0), 0);
  const itemLines = plan.lines
    .map(
      (l) =>
        `  • Stock #${l.stockId}${l.description ? ` — ${l.description}` : ""}: ${l.rolls} roll${l.rolls === 1 ? "" : "s"}` +
        (l.width && l.width > 0 ? ` @ ${l.width}" wide` : "") +
        (l.footage ? ` (~${Math.round(l.footage).toLocaleString()} ft)` : ""),
    )
    .join("\n");
  const subject = `Make & hold release request — ${poRef} — ${totalRolls} roll${totalRolls === 1 ? "" : "s"}`;
  const body =
    `Hi All,\n\n` +
    `Please release and ship the following from the material you're holding for us on ${poRef}:\n\n${itemLines}\n\n` +
    `Total: ${totalRolls} roll${totalRolls === 1 ? "" : "s"}` +
    (totalFt > 0 ? ` (~${Math.round(totalFt).toLocaleString()} ft)` : "") +
    `\n` +
    (plan.requestedDeliveryDate ? `Needed by: ${plan.requestedDeliveryDate}\n` : "") +
    `\nThis is a release against material already made and on hold — not a new order.\n` +
    `\nShip to:\nCalyx Containers\n1991 Parkway Blvd\nWest Valley City, UT 84119\n\n` +
    `Please confirm the release and send the ship date and tracking once it's on the way.\n\n` +
    `Thank you,\nCalyx Containers Supply Chain`;
  const esc = (v: unknown) =>
    String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const rows = plan.lines
    .map(
      (l) =>
        `<tr><td style="padding:6px 12px 6px 0">Stock #${esc(l.stockId)}` +
        `${l.mfgSpecNum?.trim() ? `<br><span style="color:#666;font-size:12px">MFG Spec ${esc(l.mfgSpecNum.trim())}</span>` : ""}</td>` +
        `<td style="padding:6px 12px 6px 0">${esc(l.description ?? "")}</td>` +
        `<td style="padding:6px 12px 6px 0;white-space:nowrap">${l.rolls} roll${l.rolls === 1 ? "" : "s"}${
          l.width && l.width > 0 ? ` @ ${esc(l.width)}&quot;` : ""
        }</td>` +
        `<td style="padding:6px 0;white-space:nowrap">${l.footage ? `~${Math.round(l.footage).toLocaleString()} ft` : ""}</td></tr>`,
    )
    .join("");
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">` +
    `<p>Hi All,</p>` +
    `<p>Please release and ship the following from the material you're holding for us on <strong>${esc(poRef)}</strong>:</p>` +
    `<table style="border-collapse:collapse;font-size:14px">${rows}</table>` +
    `<p><strong>Total: ${totalRolls} roll${totalRolls === 1 ? "" : "s"}${totalFt > 0 ? ` (~${Math.round(totalFt).toLocaleString()} ft)` : ""}</strong></p>` +
    (plan.requestedDeliveryDate ? `<p>Needed by: ${esc(plan.requestedDeliveryDate)}</p>` : "") +
    `<p style="color:#666">This is a release against material already made and on hold — not a new order.</p>` +
    `<p>Ship to:<br>Calyx Containers<br>1991 Parkway Blvd<br>West Valley City, UT 84119</p>` +
    `<p>Please confirm the release and send the ship date and tracking once it's on the way.</p>` +
    `<p>Thank you,<br>Calyx Containers Supply Chain</p></div>`;
  return {
    to: plan.vendorEmails ?? "",
    cc: plan.vendorCcEmails ?? "",
    subject,
    body,
    html,
  };
}
