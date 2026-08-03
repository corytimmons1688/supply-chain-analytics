import { db, nsForecastLineTable, ltTicketTable } from "@workspace/db";
import { isNull, notInArray } from "drizzle-orm";
import { runSuiteQL, netsuiteConfigured } from "./netsuite";
import { ltGet, ltApiConfigured } from "./ltApi";
import { forecastLineFootage, type LtConstruction, type CopyPosition } from "./label-footage";
import { logger } from "./logger";

/**
 * Material forecast from NetSuite orders that haven't reached Label Traxx yet.
 *
 * Pipeline:
 *   1. NetSuite  — sales-order lines in Pending Approval carrying a label or
 *                  flexpack item.
 *   2. Label Traxx — resolve the line's SKU to a product (LT stores the SKU as
 *                  the product DESCRIPTION; product.number is a sequential id,
 *                  so matching on number finds nothing). The product carries
 *                  the construction: repeat, no-across, and stockNum1..3 with
 *                  widths.
 *   3. Footage   — lib/label-footage.ts turns quantity + construction into feet
 *                  per material.
 *
 * The line drops out the moment NetSuite's "LT Ticket" field is populated: a
 * real ticket then exists in LT and the demand is already counted as committed
 * open-ticket footage, so keeping the forecast would double-count it.
 *
 * That field can't be the only handoff signal. Measured 2026-08-02: of 42
 * pending label/flexpack lines NONE carried an LT Ticket number, yet 6 already
 * had an open LT ticket for the same SKU and customer — the write-back
 * generally happens after the order leaves Pending Approval, so we'd never see
 * it. `linkOpenTickets` below therefore matches on SKU + customer as a
 * fallback, which both prevents the double-count and gives the buyer a list of
 * NetSuite lines whose LT Ticket field needs filling in.
 */

/** NetSuite item classes that are printed on our own stock. */
const FORECAST_ITEM_CLASSES = ["Labels", "Flex Pack"];
/** Pending Approval. NetSuite stores SO status as a bare letter. */
const PENDING_APPROVAL = "A";
/**
 * Good length excludes spoilage and make-ready. Without LT equipment curves we
 * can't compute those per job, so a flat allowance keeps the forecast from
 * being systematically short. Tunable without a deploy.
 */
export function forecastSpoilagePct(): number {
  const raw = Number(process.env["FORECAST_SPOILAGE_PCT"]);
  return Number.isFinite(raw) && raw >= 0 ? raw : 8;
}

interface NsLine {
  uniquekey: string | number;
  soid: string | number;
  tranid: string;
  lineno: number | null;
  customer: string | null;
  sku: string;
  itemclass: string | null;
  qty: number | string;
  lt_ticket: string | null;
  expectedshipdate: string | null;
  trandate: string | null;
}

/** NetSuite hands dates back as M/D/YYYY; the rest of the app speaks ISO. */
function toIso(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  const iso = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

async function fetchPendingLines(): Promise<NsLine[]> {
  const classList = FORECAST_ITEM_CLASSES.map((c) => `'${c.replace(/'/g, "''")}'`).join(",");
  // Excludes fee/service lines (Tooling Fee, application fees) — they carry a
  // label class but consume no stock of their own.
  const q = `
    SELECT tl.uniquekey AS uniquekey, t.id AS soid, t.tranid AS tranid,
           tl.linesequencenumber AS lineno, BUILTIN.DF(t.entity) AS customer,
           i.itemid AS sku, BUILTIN.DF(i.class) AS itemclass,
           ABS(tl.quantity) AS qty, tl.custcollt_ticket_num AS lt_ticket,
           tl.expectedshipdate AS expectedshipdate, t.trandate AS trandate
      FROM transaction t, transactionline tl, item i
     WHERE t.id = tl.transaction AND tl.item = i.id
       AND t.type = 'SalesOrd' AND t.status = '${PENDING_APPROVAL}'
       AND tl.mainline = 'F' AND tl.taxline = 'F'
       AND BUILTIN.DF(i.class) IN (${classList})
       AND i.itemtype IN ('InvtPart','Assembly')
       AND ABS(tl.quantity) > 1`;
  const rows: NsLine[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const r = await runSuiteQL<NsLine>(q, { limit: 1000, offset });
    rows.push(...(r.items ?? []));
    if (!r.hasMore) break;
  }
  return rows;
}

interface LtProductLite {
  number: string;
  uniqueProdId: number;
  description: string;
  customerName: string;
}

/**
 * Resolve a SKU to its LT product. LT's `Description` filter is a partial
 * match, so we take the exact (case-insensitive) description hit only —
 * a near-miss would silently forecast the wrong construction.
 */
async function resolveLtProduct(sku: string): Promise<LtProductLite | null> {
  const list = await ltGet<LtProductLite[]>("/products", {
    Page: 0,
    PageSize: 50,
    Description: sku,
  }).catch(() => [] as LtProductLite[]);
  const want = sku.trim().toUpperCase();
  return (list ?? []).find((p) => (p.description ?? "").trim().toUpperCase() === want) ?? null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function constructionFrom(d: Record<string, unknown>): LtConstruction {
  const stocks: { stockId: string; widthIn: number }[] = [];
  for (const i of [1, 2, 3]) {
    const id = String(d[`stockNum${i}`] ?? "").trim();
    const w = num(d[`stockWidth${i}`]);
    // A blank stock slot comes back as "" with width 0 — not a material.
    if (id && w > 0) stocks.push({ stockId: id, widthIn: w });
  }
  return {
    sizeAcrossIn: num(d["sizeAcross"]),
    sizeAroundIn: num(d["sizeAround"]),
    columnSpaceIn: num(d["columnSpace"]),
    rowSpaceIn: num(d["rowSpace"]),
    labelRepeatIn: num(d["labelRepeat"]) || null,
    noAcross: num(d["noAcross"]) || null,
    copyPosition: (typeof d["csa"] === "string" ? (d["csa"] as CopyPosition) : null) ?? null,
    // flexPackType is 0 on labels, >0 on pouches (verified against the
    // NetSuite item class on every pending line).
    isFlexpack: num(d["flexPackType"]) > 0 || num(d["flexPackHeight"]) > 0,
    stocks,
  };
}

/* ------------------------------------------------------------------ *
 * Fallback ticket linkage
 *
 * NetSuite's LT Ticket field is the intended handoff, but it's written back
 * after the order leaves Pending Approval, so a pending line effectively never
 * carries it. Matching on SKU + customer is what actually catches a job that's
 * already live in Label Traxx.
 * ------------------------------------------------------------------ */

/** LT priority for proofing jobs — ~100 ft flat, not a production run. */
const DIGITAL_PROOF = "Digital Proof";

/**
 * Company suffixes to ignore when comparing customer names: NetSuite carries
 * the legal entity ("Green Gold Group LLC") where LT carries the shop name
 * ("Green Gold Group"). Only stripped as a whole trailing token, so "Costco"
 * doesn't lose its "co".
 */
const LEGAL_SUFFIXES = new Set([
  "llc", "inc", "corp", "corporation", "ltd", "limited", "co", "company",
  "lp", "llp", "pllc", "plc", "holdings", "group",
]);

function normalizeCustomer(name: string | null): string {
  const toks = (name ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  while (toks.length > 1 && LEGAL_SUFFIXES.has(toks[toks.length - 1]!)) toks.pop();
  return toks.join("");
}

/**
 * Same customer? Exact after normalizing, or one a prefix of the other — real
 * pairs differ that way ("Carolinahighlifecbd" vs "Carolina High Life, LLC").
 * The 6-character floor keeps short names from colliding.
 */
function sameCustomer(a: string | null, b: string | null): boolean {
  const x = normalizeCustomer(a);
  const y = normalizeCustomer(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 6 && (x.startsWith(y) || y.startsWith(x));
}

export type InferredConfidence = "high" | "proof" | "low";

export interface InferredTicket {
  ticketNumber: string;
  confidence: InferredConfidence;
  shipByDate: string | null;
  priority: string | null;
}

interface OpenTicketLite {
  ticketNumber: string;
  description: string | null;
  customerName: string | null;
  shipByDate: string | null;
  priority: string | null;
}

/** Open LT tickets indexed by normalized description (= the NetSuite SKU). */
async function openTicketsBySku(): Promise<Map<string, OpenTicketLite[]>> {
  const rows = await db
    .select({
      ticketNumber: ltTicketTable.ticketNumber,
      description: ltTicketTable.description,
      customerName: ltTicketTable.customerName,
      shipByDate: ltTicketTable.shipByDate,
      priority: ltTicketTable.priority,
    })
    .from(ltTicketTable)
    .where(isNull(ltTicketTable.dateDone));
  const out = new Map<string, OpenTicketLite[]>();
  for (const t of rows) {
    const key = (t.description ?? "").trim().toUpperCase();
    if (!key) continue;
    const arr = out.get(key) ?? [];
    arr.push(t);
    out.set(key, arr);
  }
  return out;
}

/**
 * Find the open LT ticket that appears to be this line's job.
 *
 * A production ticket for the same SKU and customer means the demand is already
 * in the committed book — that's the case worth suppressing. A Digital Proof
 * match is not: proofs are excluded from committed footage (demand.ts), so the
 * forecast footage still stands and the proof only tells us the job is moving.
 */
function inferTicket(
  sku: string,
  customerName: string | null,
  expectedShipDate: string | null,
  bySku: Map<string, OpenTicketLite[]>,
): InferredTicket | null {
  const cands = bySku.get(sku.trim().toUpperCase());
  if (!cands?.length) return null;

  // Nearest ship date first, so a repeat SKU picks the contemporaneous ticket.
  const ranked = [...cands].sort((a, b) => {
    if (!expectedShipDate) return (a.shipByDate ?? "").localeCompare(b.shipByDate ?? "");
    const da = a.shipByDate ? Math.abs(Date.parse(a.shipByDate) - Date.parse(expectedShipDate)) : Infinity;
    const db_ = b.shipByDate ? Math.abs(Date.parse(b.shipByDate) - Date.parse(expectedShipDate)) : Infinity;
    return da - db_;
  });

  const sameCust = ranked.filter((t) => sameCustomer(customerName, t.customerName));
  // A production ticket for this customer outranks a proof for this customer,
  // which outranks a SKU-only hit.
  const production = sameCust.find((t) => (t.priority ?? "") !== DIGITAL_PROOF);
  if (production) {
    return { ticketNumber: production.ticketNumber, confidence: "high", shipByDate: production.shipByDate, priority: production.priority };
  }
  const proof = sameCust[0];
  if (proof) {
    return { ticketNumber: proof.ticketNumber, confidence: "proof", shipByDate: proof.shipByDate, priority: proof.priority };
  }
  const any = ranked[0]!;
  return { ticketNumber: any.ticketNumber, confidence: "low", shipByDate: any.shipByDate, priority: any.priority };
}

export interface ForecastSyncResult {
  linesSeen: number;
  forecast: number;
  unresolved: number;
  withTicket: number;
  productsFetched: number;
  /** Lines whose job is already an open PRODUCTION ticket in LT (suppressed). */
  inferredProduction: number;
  /** Lines with only a Digital Proof ticket open (still forecast). */
  inferredProof: number;
  /** SKU matched an open ticket but the customer didn't (flagged, still forecast). */
  inferredWeak: number;
  skipped?: string;
}

export async function performForecastSync(): Promise<ForecastSyncResult> {
  const zero: ForecastSyncResult = {
    linesSeen: 0,
    forecast: 0,
    unresolved: 0,
    withTicket: 0,
    productsFetched: 0,
    inferredProduction: 0,
    inferredProof: 0,
    inferredWeak: 0,
  };
  if (!netsuiteConfigured()) return { ...zero, skipped: "netsuite not configured" };
  if (!ltApiConfigured()) return { ...zero, skipped: "LT API not configured" };

  const lines = await fetchPendingLines();
  const spoilage = forecastSpoilagePct();
  const ticketsBySku = await openTicketsBySku();

  // One LT lookup per distinct SKU, not per line.
  const cache = new Map<string, { p: LtProductLite; c: LtConstruction } | null>();
  let productsFetched = 0;
  const result = { ...zero, linesSeen: lines.length };
  const keep: string[] = [];

  for (const line of lines) {
    const id = String(line.uniquekey);
    const sku = String(line.sku ?? "").trim();
    const ltTicket = line.lt_ticket ? String(line.lt_ticket).trim() : null;
    const qty = Number(line.qty) || 0;

    // Ticket exists in LT → this is live committed demand now, not a forecast.
    if (ltTicket) {
      result.withTicket += 1;
      continue;
    }

    let resolved = cache.get(sku);
    if (resolved === undefined) {
      const p = await resolveLtProduct(sku);
      if (!p) {
        resolved = null;
      } else {
        const d = await ltGet<Record<string, unknown>>("/product-details", { UniqueProdId: p.uniqueProdId }).catch(
          () => null,
        );
        productsFetched += 1;
        resolved = d ? { p, c: constructionFrom(d) } : null;
      }
      cache.set(sku, resolved);
    }

    const expectedShipDate = toIso(line.expectedshipdate);
    const inferred = inferTicket(sku, line.customer ?? null, expectedShipDate, ticketsBySku);
    if (inferred?.confidence === "high") result.inferredProduction += 1;
    else if (inferred?.confidence === "proof") result.inferredProof += 1;
    else if (inferred?.confidence === "low") result.inferredWeak += 1;

    const base = {
      id,
      soId: String(line.soid),
      tranId: String(line.tranid ?? ""),
      lineNo: line.lineno ?? null,
      customerName: line.customer ?? null,
      sku,
      itemClass: line.itemclass ?? null,
      quantity: qty,
      expectedShipDate,
      orderDate: toIso(line.trandate),
      ltTicketNum: null as string | null,
      inferredTicketNum: inferred?.ticketNumber ?? null,
      inferredTicketConfidence: inferred?.confidence ?? null,
      inferredTicketShipDate: inferred?.shipByDate ?? null,
      inferredTicketPriority: inferred?.priority ?? null,
      syncedAt: new Date(),
    };

    let row: typeof nsForecastLineTable.$inferInsert;
    if (!resolved) {
      result.unresolved += 1;
      row = {
        ...base,
        ltProductNumber: null,
        ltUniqueProdId: null,
        isFlexpack: false,
        unresolvedReason: "No Label Traxx product matches this SKU — construction unknown",
        stockDemand: null,
      };
    } else {
      const f = forecastLineFootage(qty, resolved.c, { spoilagePct: spoilage });
      if (f.unresolvedReason) result.unresolved += 1;
      else result.forecast += 1;
      row = {
        ...base,
        ltProductNumber: resolved.p.number,
        ltUniqueProdId: resolved.p.uniqueProdId,
        isFlexpack: resolved.c.isFlexpack,
        unresolvedReason: f.unresolvedReason,
        stockDemand: f.stockDemand.length
          ? { stocks: f.stockDemand, goodLengthFt: f.goodLengthFt, repeatIn: f.repeatIn, noAcross: f.noAcross, spoilagePct: spoilage, derived: f.derived }
          : null,
      };
    }

    keep.push(id);
    await db
      .insert(nsForecastLineTable)
      .values(row)
      .onConflictDoUpdate({
        target: nsForecastLineTable.id,
        set: {
          tranId: row.tranId,
          lineNo: row.lineNo ?? null,
          customerName: row.customerName ?? null,
          sku: row.sku,
          itemClass: row.itemClass ?? null,
          quantity: row.quantity,
          expectedShipDate: row.expectedShipDate ?? null,
          orderDate: row.orderDate ?? null,
          ltTicketNum: null,
          inferredTicketNum: row.inferredTicketNum ?? null,
          inferredTicketConfidence: row.inferredTicketConfidence ?? null,
          inferredTicketShipDate: row.inferredTicketShipDate ?? null,
          inferredTicketPriority: row.inferredTicketPriority ?? null,
          ltProductNumber: row.ltProductNumber ?? null,
          ltUniqueProdId: row.ltUniqueProdId ?? null,
          isFlexpack: row.isFlexpack ?? false,
          unresolvedReason: row.unresolvedReason ?? null,
          stockDemand: row.stockDemand ?? null,
          syncedAt: new Date(),
        },
      });
  }

  // Anything no longer pending-and-ticketless is gone from the forecast:
  // approved, cancelled, or a ticket was created. Deleting rather than
  // tombstoning keeps the forecast a pure "what isn't in LT yet" view.
  if (keep.length) {
    await db.delete(nsForecastLineTable).where(notInArray(nsForecastLineTable.id, keep));
  } else {
    await db.delete(nsForecastLineTable);
  }

  result.productsFetched = productsFetched;
  logger.info({ ...result }, "NetSuite material forecast synced");
  return result;
}

export interface ForecastStockRow {
  stockId: string;
  widthIn: number;
  footage: number;
  lines: number;
  earliestShipDate: string | null;
}

/**
 * A line's footage belongs in the forecast unless the job is already live in
 * Label Traxx as a production ticket — then it's committed demand and counting
 * it here too would double it. A Digital Proof match doesn't disqualify it:
 * proofs are excluded from committed footage, so the production run is still
 * entirely ahead of us.
 */
export function countsAsForecast(r: {
  ltTicketNum: string | null;
  inferredTicketConfidence: string | null;
}): boolean {
  return !r.ltTicketNum && r.inferredTicketConfidence !== "high";
}

/** Forecast footage per stock+width, for the dashboard. */
export async function fetchForecastByStock(): Promise<Map<string, ForecastStockRow[]>> {
  const rows = await db.select().from(nsForecastLineTable);
  const byStock = new Map<string, Map<string, ForecastStockRow>>();
  for (const r of rows) {
    if (!countsAsForecast(r)) continue;
    const sd = r.stockDemand as { stocks?: { stockId: string; widthIn: number; footage: number }[] } | null;
    for (const s of sd?.stocks ?? []) {
      const widthKey = String(Math.round(s.widthIn * 100) / 100);
      let perStock = byStock.get(s.stockId);
      if (!perStock) {
        perStock = new Map();
        byStock.set(s.stockId, perStock);
      }
      const cur = perStock.get(widthKey) ?? {
        stockId: s.stockId,
        widthIn: Math.round(s.widthIn * 100) / 100,
        footage: 0,
        lines: 0,
        earliestShipDate: null,
      };
      cur.footage += s.footage;
      cur.lines += 1;
      if (r.expectedShipDate && (!cur.earliestShipDate || r.expectedShipDate < cur.earliestShipDate)) {
        cur.earliestShipDate = r.expectedShipDate;
      }
      perStock.set(widthKey, cur);
    }
  }
  const out = new Map<string, ForecastStockRow[]>();
  for (const [stockId, widths] of byStock) {
    out.set(
      stockId,
      [...widths.values()].map((w) => ({ ...w, footage: Math.round(w.footage) })).sort((a, b) => a.widthIn - b.widthIn),
    );
  }
  return out;
}
