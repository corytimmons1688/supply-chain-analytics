import { db, stockGoalTable, materialPoTable, materialPoLineTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  fetchOnHandByWidth,
  fetchOnHandByStock,
  fetchOpenPos,
  fetchOpenTickets,
  fetchStockInfo,
  computeWidthAvailability,
  type WidthRow,
} from "./demand";
import {
  classifyOpenPo,
  classifyRelease,
  isMakeAndHoldPo,
  trackingRefs,
  PO_STATUS_LABEL,
  PO_STATUS_RANK,
  type PoStatus,
} from "./open-po-status";
import { logger } from "./logger";

/**
 * Weekday morning material digest.
 *
 * Two things a buyer needs before the day starts:
 *   1. Which materials can't cover their committed tickets — the Stock
 *      Inventory Summary narrowed to the statuses that need action (Ordered,
 *      Ordered Not Confirmed, Out). "In" and "Without Tickets" are deliberately
 *      dropped: a daily mail that lists everything gets filed unread.
 *   2. Where every inbound order stands, soonest first.
 *
 * Statuses come from the same functions the dashboard renders from
 * (computeWidthAvailability, classifyOpenPo) so the mail and the screen can't
 * disagree — someone acting on this email is acting on what the dashboard says.
 */

/** The statuses worth waking up to. */
export const DIGEST_STATUSES = ["Ordered", "Ordered Not Confirmed", "Out"] as const;

const STATUS_COLOR: Record<string, string> = {
  Ordered: "#38bdf8",
  "Ordered Not Confirmed": "#a78bfa",
  Out: "#4338ca",
};

const PO_STATUS_COLOR: Record<PoStatus, string> = {
  past_due: "#dc2626",
  pending_confirmation: "#d97706",
  release_draft: "#ea580c",
  release_requested: "#7c3aed",
  in_transit: "#2563eb",
  extended: "#0284c7",
  release_confirmed: "#059669",
  confirmed: "#059669",
};

export interface DigestWidth {
  label: string;
  status: string;
  onHandFootage: number;
  onOrderFootage: number;
  requiredFootage: number;
  shortFootage: number;
}

export interface DigestStock {
  stockId: string;
  description: string | null;
  /** Only the widths in a digest status. */
  widths: DigestWidth[];
  /** Worst status across those widths — drives ordering. */
  worstStatus: string;
  shortFootage: number;
}

export interface DigestPo {
  stockId: string;
  description: string | null;
  poNumber: string;
  status: PoStatus;
  statusNote: string;
  date: string | null;
  dateIsPromised: boolean;
  width: number | null;
  footage: number;
  rolls: number;
  tracking: { carrier: string; number: string; url: string }[];
}

export interface Digest {
  dateIso: string;
  stocks: DigestStock[];
  pos: DigestPo[];
  /** Counts across every width evaluated, including the ones filtered out. */
  totals: { out: number; unconfirmed: number; ordered: number; evaluated: number };
  pastDueCount: number;
}

function todayMountainIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const STATUS_SEVERITY: Record<string, number> = {
  In: 0,
  Ordered: 1,
  "Ordered Not Confirmed": 2,
  Out: 3,
};

export async function buildDigest(): Promise<Digest> {
  const todayIso = todayMountainIso();
  const [onHandByWidth, onHandByStock, openPos, tickets, stockInfo, goals, releases] = await Promise.all([
    fetchOnHandByWidth(),
    fetchOnHandByStock(),
    fetchOpenPos(),
    fetchOpenTickets(),
    fetchStockInfo(),
    db.select().from(stockGoalTable),
    db.select().from(materialPoTable).where(eq(materialPoTable.kind, "mah_release")),
  ]);
  const goalByStock = new Map(goals.map((g) => [g.stockId, g]));

  const posByStock = new Map<string, typeof openPos>();
  for (const p of openPos) {
    const arr = posByStock.get(p.stockId) ?? [];
    arr.push(p);
    posByStock.set(p.stockId, arr);
  }
  const ticketsByStock = new Map<string, typeof tickets>();
  for (const t of tickets) {
    const arr = ticketsByStock.get(t.stockId) ?? [];
    arr.push(t);
    ticketsByStock.set(t.stockId, arr);
  }

  const descOf = (stockId: string): string | null => onHandByStock.get(stockId)?.description ?? null;

  // ---- 1. Stock availability, same math as the dashboard ----
  const stocks: DigestStock[] = [];
  const totals = { out: 0, unconfirmed: 0, ordered: 0, evaluated: 0 };
  for (const [stockId, stockTickets] of ticketsByStock) {
    const widths = onHandByWidth.get(stockId) ?? [];
    let ft = 0;
    let rolls = 0;
    for (const w of widths) {
      ft += w.footage;
      rolls += w.rolls;
    }
    const info = stockInfo.get(stockId);
    const result = computeWidthAvailability({
      onHand: widths,
      openPos: (posByStock.get(stockId) ?? []).map((p) => ({
        masterWidth: p.masterWidth,
        quantityRolls: p.quantityRolls,
        // A vendor commitment by email counts as confirmed supply, exactly as
        // the dashboard treats it.
        dueDateIso: p.dueDateIso ?? p.agentPromisedIso,
        orderedFootage: p.orderedFootage,
      })),
      lines: stockTickets.map((t) => ({
        key: t.ticketNumber,
        requiredWidth: t.requiredWidth,
        footage: t.estFootage,
        shipByDate: t.shipByDate,
      })),
      avgRollFootage: rolls > 0 ? ft / rolls : 5000,
      masterWidthFallback: info?.masterWidth ?? 0,
    });

    const keep: DigestWidth[] = [];
    for (const w of result.widthRows as WidthRow[]) {
      if (w.status === "Out") totals.out += 1;
      else if (w.status === "Ordered Not Confirmed") totals.unconfirmed += 1;
      else if (w.status === "Ordered") totals.ordered += 1;
      if (w.status !== "Without Tickets") totals.evaluated += 1;
      if (!(DIGEST_STATUSES as readonly string[]).includes(w.status)) continue;
      keep.push({
        label: w.pooled ? `≤13"` : `${w.width}"`,
        status: w.status,
        onHandFootage: w.onHandFootage,
        onOrderFootage: w.onOrderFootage,
        requiredFootage: w.requiredFootage,
        shortFootage: w.shortFootage,
      });
    }
    if (keep.length === 0) continue;
    const worstStatus = keep.reduce(
      (worst, w) => ((STATUS_SEVERITY[w.status] ?? 0) > (STATUS_SEVERITY[worst] ?? 0) ? w.status : worst),
      keep[0]!.status,
    );
    stocks.push({
      stockId,
      description: descOf(stockId),
      widths: keep.sort((a, b) => (STATUS_SEVERITY[b.status] ?? 0) - (STATUS_SEVERITY[a.status] ?? 0)),
      worstStatus,
      shortFootage: keep.reduce((s, w) => s + w.shortFootage, 0),
    });
  }
  // Worst first, then the biggest hole.
  stocks.sort(
    (a, b) =>
      (STATUS_SEVERITY[b.worstStatus] ?? 0) - (STATUS_SEVERITY[a.worstStatus] ?? 0) ||
      b.shortFootage - a.shortFootage ||
      a.stockId.localeCompare(b.stockId),
  );

  // ---- 2. Open POs, excluding make-and-hold; releases included ----
  const pos: DigestPo[] = [];
  for (const p of openPos) {
    if (isMakeAndHoldPo(p.supplierName)) continue;
    const goal = goalByStock.get(p.stockId);
    const typicalRoll = goal?.typicalRollFootage ?? 0;
    const c = classifyOpenPo({
      promisedDeliveryDate: p.dueDateIso ?? p.agentPromisedIso,
      requestedDeliveryDate: p.requestedDeliveryIso,
      notes: p.notes,
      extendedLeadTime: false,
      extendedLeadTimeDays: null,
      todayIso,
    });
    pos.push({
      stockId: p.stockId,
      // Roll description first: the LT PO's own description repeats the stock
      // number ("Stock#286 1.2 Mil PET…"), which reads as noise next to the
      // bolded number and disagrees with the table above.
      description: descOf(p.stockId) ?? p.description,
      poNumber: p.poNumber,
      status: c.status,
      statusNote: c.note,
      date: c.date,
      dateIsPromised: c.dateIsPromised,
      width: p.masterWidth,
      footage: p.orderedFootage > 0 ? p.orderedFootage : Math.round(p.quantityRolls * (typicalRoll || 0)),
      rolls: p.quantityRolls,
      tracking: trackingRefs(p.notes),
    });
  }
  const releaseLines = releases.length
    ? await db.select().from(materialPoLineTable)
    : [];
  for (const rel of releases) {
    for (const l of releaseLines.filter((x) => x.poId === rel.id)) {
      const c = classifyRelease({
        promisedDate: rel.promisedDate,
        requestedDeliveryDate: rel.requestedDeliveryDate,
        notes: rel.notes,
        emailedAt: rel.emailedAt?.toISOString() ?? null,
        needsAttention: rel.needsAttention,
        attentionReason: rel.attentionReason,
        todayIso,
      });
      pos.push({
        stockId: l.stockId,
        description: l.description ?? descOf(l.stockId),
        poNumber: rel.releaseFromPoNumbers ? `Release · ${rel.releaseFromPoNumbers}` : "Release",
        status: c.status,
        statusNote: c.note,
        date: c.date,
        dateIsPromised: c.dateIsPromised,
        width: l.width,
        footage: l.footage ?? 0,
        rolls: l.rolls,
        tracking: trackingRefs(rel.notes),
      });
    }
  }
  // Soonest expected first; status breaks ties. Same order as the report.
  pos.sort(
    (a, b) =>
      (a.date ?? "9999").localeCompare(b.date ?? "9999") ||
      PO_STATUS_RANK[a.status] - PO_STATUS_RANK[b.status],
  );

  const digest: Digest = {
    dateIso: todayIso,
    stocks,
    pos,
    totals,
    pastDueCount: pos.filter((p) => p.status === "past_due").length,
  };
  logger.info(
    { stocks: stocks.length, pos: pos.length, out: totals.out, unconfirmed: totals.unconfirmed },
    "Daily digest built",
  );
  return digest;
}

// ---------------------------------------------------------------------
// Rendering. Email clients ignore <style> blocks and external CSS, so
// everything is inline on table cells — no flexbox, no grid.
// ---------------------------------------------------------------------

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const num = (n: number) => Math.round(n).toLocaleString("en-US");

const TD = "padding:7px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;vertical-align:top";
const TH =
  "padding:7px 10px;border-bottom:2px solid #d1d5db;font-size:11px;text-transform:uppercase;" +
  "letter-spacing:.04em;color:#6b7280;text-align:left;white-space:nowrap";

function chip(text: string, color: string): string {
  return (
    `<span style="display:inline-block;background:${color};color:#fff;border-radius:10px;` +
    `padding:2px 8px;font-size:11px;font-weight:600;white-space:nowrap">${esc(text)}</span>`
  );
}

export function renderDigestHtml(d: Digest, appUrl: string): string {
  const dateLabel = new Date(`${d.dateIso}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  const headline =
    d.totals.out > 0
      ? `${d.totals.out} material width${d.totals.out === 1 ? "" : "s"} short with nothing on order`
      : d.totals.unconfirmed > 0
        ? `Nothing uncovered — ${d.totals.unconfirmed} width${d.totals.unconfirmed === 1 ? "" : "s"} waiting on vendor confirmation`
        : "Every committed ticket is covered";

  const stockRows =
    d.stocks.length === 0
      ? `<tr><td style="${TD}" colspan="6">Nothing in these statuses — every material with open tickets is covered by stock on hand.</td></tr>`
      : d.stocks
          .flatMap((s) =>
            s.widths.map(
              (w, i) =>
                `<tr>` +
                (i === 0
                  ? `<td style="${TD}" rowspan="${s.widths.length}">` +
                    `<a href="${esc(appUrl)}/demand/${encodeURIComponent(s.stockId)}" style="color:#1d4ed8;text-decoration:none;font-weight:600">#${esc(s.stockId)}</a>` +
                    `<div style="color:#6b7280;font-size:12px;margin-top:2px">${esc(s.description ?? "")}</div></td>`
                  : "") +
                `<td style="${TD};white-space:nowrap">${esc(w.label)}</td>` +
                `<td style="${TD}">${chip(w.status, STATUS_COLOR[w.status] ?? "#6b7280")}</td>` +
                `<td style="${TD};text-align:right;white-space:nowrap">${num(w.requiredFootage)} ft</td>` +
                `<td style="${TD};text-align:right;white-space:nowrap">${num(w.onHandFootage)} ft` +
                (w.onOrderFootage > 0
                  ? `<div style="color:#6b7280;font-size:11px">+${num(w.onOrderFootage)} on order</div>`
                  : "") +
                `</td>` +
                `<td style="${TD};text-align:right;white-space:nowrap;${w.shortFootage > 0 ? "color:#b91c1c;font-weight:600" : "color:#6b7280"}">` +
                `${w.shortFootage > 0 ? `${num(w.shortFootage)} ft` : "covered"}</td>` +
                `</tr>`,
            ),
          )
          .join("");

  const poRows =
    d.pos.length === 0
      ? `<tr><td style="${TD}" colspan="7">No open purchase orders.</td></tr>`
      : d.pos
          .map(
            (p) =>
              `<tr>` +
              `<td style="${TD};white-space:nowrap"><strong>#${esc(p.stockId)}</strong>` +
              `<div style="color:#6b7280;font-size:12px;max-width:260px">${esc(p.description ?? "")}</div></td>` +
              `<td style="${TD};white-space:nowrap">${esc(p.poNumber)}</td>` +
              `<td style="${TD}">${chip(PO_STATUS_LABEL[p.status], PO_STATUS_COLOR[p.status])}` +
              `<div style="color:#6b7280;font-size:11px;max-width:240px;margin-top:3px">${esc(p.statusNote)}</div></td>` +
              `<td style="${TD};white-space:nowrap${p.status === "past_due" ? ";color:#b91c1c;font-weight:600" : ""}">` +
              `${esc(p.date ?? "—")}${p.date && !p.dateIsPromised ? ` <span style="color:#9ca3af;font-size:11px">req</span>` : ""}</td>` +
              `<td style="${TD};text-align:right;white-space:nowrap">${p.width ? `${p.width}"` : "—"}</td>` +
              `<td style="${TD};text-align:right;white-space:nowrap">${p.footage > 0 ? `${num(p.footage)} ft` : "—"}` +
              `<div style="color:#6b7280;font-size:11px">${p.rolls} roll${p.rolls === 1 ? "" : "s"}</div></td>` +
              `<td style="${TD};white-space:nowrap">` +
              (p.tracking.length === 0
                ? `<span style="color:#9ca3af">—</span>`
                : p.tracking
                    .map(
                      (t) =>
                        `<a href="${esc(t.url)}" style="color:#1d4ed8;text-decoration:none">${esc(t.carrier)} ${esc(t.number)}</a>`,
                    )
                    .join("<br>")) +
              `</td></tr>`,
          )
          .join("");

  return (
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111827;max-width:900px">` +
    `<p style="margin:0 0 2px;font-size:12px;color:#6b7280">${esc(dateLabel)}</p>` +
    `<h2 style="margin:0 0 4px;font-size:19px">Material status</h2>` +
    `<p style="margin:0 0 18px;font-size:14px;color:#374151">${esc(headline)}.` +
    (d.pastDueCount > 0
      ? ` <span style="color:#b91c1c;font-weight:600">${d.pastDueCount} open order${d.pastDueCount === 1 ? "" : "s"} past due.</span>`
      : "") +
    `</p>` +
    `<h3 style="margin:0 0 2px;font-size:15px">Needs attention</h3>` +
    `<p style="margin:0 0 8px;font-size:12px;color:#6b7280">` +
    `Materials whose committed tickets aren't covered by stock on hand. ` +
    `<strong>Out</strong> = short with nothing on order · <strong>Ordered Not Confirmed</strong> = covered only by a PO the vendor hasn't confirmed · ` +
    `<strong>Ordered</strong> = covered by a confirmed PO. Widths above 14&quot; aren't interchangeable.</p>` +
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:26px">` +
    `<tr><th style="${TH}">Stock</th><th style="${TH}">Width</th><th style="${TH}">Status</th>` +
    `<th style="${TH};text-align:right">Required</th><th style="${TH};text-align:right">On hand</th>` +
    `<th style="${TH};text-align:right">Short</th></tr>${stockRows}</table>` +
    `<h3 style="margin:0 0 2px;font-size:15px">Open purchase orders</h3>` +
    `<p style="margin:0 0 8px;font-size:12px;color:#6b7280">` +
    `Everything inbound, soonest first. Dates are the vendor's commitment where we have one, otherwise what we requested (&ldquo;req&rdquo;). ` +
    `Make-and-hold orders aren't listed — that material sits at the vendor; only a release is on its way.</p>` +
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">` +
    `<tr><th style="${TH}">Stock</th><th style="${TH}">PO</th><th style="${TH}">Status</th><th style="${TH}">Expected</th>` +
    `<th style="${TH};text-align:right">Width</th><th style="${TH};text-align:right">On order</th><th style="${TH}">Tracking</th></tr>` +
    `${poRows}</table>` +
    `<p style="margin:22px 0 0;font-size:12px;color:#6b7280">` +
    `<a href="${esc(appUrl)}/demand" style="color:#1d4ed8">Open the dashboard</a> for the full picture, ` +
    `including materials that are covered.</p>` +
    `</div>`
  );
}

export function renderDigestText(d: Digest): string {
  const lines: string[] = [];
  lines.push(`Material status — ${d.dateIso}`);
  lines.push("");
  lines.push(
    `${d.totals.out} width(s) short with nothing on order · ${d.totals.unconfirmed} awaiting vendor confirmation · ` +
      `${d.totals.ordered} covered by a confirmed PO · ${d.pastDueCount} open order(s) past due`,
  );
  lines.push("");
  lines.push("NEEDS ATTENTION");
  if (d.stocks.length === 0) lines.push("  Nothing — every material with open tickets is covered.");
  for (const s of d.stocks) {
    lines.push(`  #${s.stockId} ${s.description ?? ""}`);
    for (const w of s.widths) {
      lines.push(
        `    ${w.label.padEnd(7)} ${w.status.padEnd(22)} need ${num(w.requiredFootage)} ft · ` +
          `on hand ${num(w.onHandFootage)} ft${w.onOrderFootage > 0 ? ` (+${num(w.onOrderFootage)} on order)` : ""}` +
          `${w.shortFootage > 0 ? ` · SHORT ${num(w.shortFootage)} ft` : ""}`,
      );
    }
  }
  lines.push("");
  lines.push("OPEN PURCHASE ORDERS (soonest first)");
  if (d.pos.length === 0) lines.push("  None.");
  for (const p of d.pos) {
    lines.push(
      `  ${(p.date ?? "no date").padEnd(11)} #${p.stockId} ${p.poNumber} · ${PO_STATUS_LABEL[p.status]}` +
        `${p.width ? ` · ${p.width}"` : ""}${p.footage > 0 ? ` · ${num(p.footage)} ft` : ""}`,
    );
    lines.push(`      ${p.statusNote}`);
    for (const t of p.tracking) lines.push(`      ${t.carrier} ${t.number} — ${t.url}`);
  }
  return lines.join("\n");
}

/**
 * Who gets the weekday digest. Comma-separated in DIGEST_RECIPIENTS; falls back
 * to the connected mailbox so a misconfigured list can't silently send to nobody.
 */
export function digestRecipients(): string[] {
  return (process.env["DIGEST_RECIPIENTS"] ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.includes("@"));
}

export interface SendDigestResult {
  sent: boolean;
  to: string[];
  subject: string;
  stocks: number;
  pos: number;
  skipped?: string;
}

/**
 * Build and send the digest. `to` overrides the configured recipients, which is
 * how the "send me a sample" button works — a sample must never fan out to the
 * whole list.
 */
export async function sendDigest(opts: { to?: string[]; subjectPrefix?: string } = {}): Promise<SendDigestResult> {
  const gmail = await import("./gmail");
  if (!gmail.gmailConfigured()) {
    return { sent: false, to: [], subject: "", stocks: 0, pos: 0, skipped: "Gmail is not set up on this deployment" };
  }
  const connection = await gmail.gmailConnection();
  if (!connection) {
    return {
      sent: false,
      to: [],
      subject: "",
      stocks: 0,
      pos: 0,
      skipped: "Gmail is not connected — connect it under Setup › Configuration",
    };
  }
  const to = opts.to?.length ? opts.to : digestRecipients();
  const resolved = to.length ? to : connection.accountEmail ? [connection.accountEmail] : [];
  if (resolved.length === 0) {
    return { sent: false, to: [], subject: "", stocks: 0, pos: 0, skipped: "No recipients — set DIGEST_RECIPIENTS" };
  }

  const digest = await buildDigest();
  const subject = `${opts.subjectPrefix ?? ""}${digestSubject(digest)}`;
  await gmail.sendMail({
    to: resolved,
    subject,
    text: renderDigestText(digest),
    html: renderDigestHtml(digest, gmail.appBaseUrl()),
  });
  logger.info({ to: resolved, subject }, "Daily digest sent");
  return { sent: true, to: resolved, subject, stocks: digest.stocks.length, pos: digest.pos.length };
}

export function digestSubject(d: Digest): string {
  const bits: string[] = [];
  if (d.totals.out > 0) bits.push(`${d.totals.out} out`);
  if (d.totals.unconfirmed > 0) bits.push(`${d.totals.unconfirmed} unconfirmed`);
  if (d.pastDueCount > 0) bits.push(`${d.pastDueCount} PO${d.pastDueCount === 1 ? "" : "s"} past due`);
  const label = new Date(`${d.dateIso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  // Lead with the numbers so the inbox list alone is useful.
  return `Material status ${label}${bits.length ? ` — ${bits.join(" · ")}` : " — all covered"}`;
}
