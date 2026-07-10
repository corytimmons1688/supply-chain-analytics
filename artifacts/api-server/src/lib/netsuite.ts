import crypto from "node:crypto";
import { logger } from "./logger";

/**
 * NetSuite Token-Based Authentication (TBA) client.
 *
 * Uses OAuth 1.0a (HMAC-SHA256) to call the SuiteQL REST endpoint. Credentials
 * are read from environment secrets. This module is READ-ONLY against NetSuite —
 * it only issues SELECT queries via SuiteQL and never writes.
 */

const ACCOUNT = process.env.NETSUITE_ACCOUNT ?? "";
const CONSUMER_KEY = process.env.CONSUMER_KEY ?? "";
const CONSUMER_SECRET = process.env.CONSUMER_SECRET ?? "";
const TOKEN_ID = process.env.TOKEN_ID ?? "";
const TOKEN_SECRET = process.env.TOKEN_SECRET ?? "";

export function netsuiteConfigured(): boolean {
  return Boolean(ACCOUNT && CONSUMER_KEY && CONSUMER_SECRET && TOKEN_ID && TOKEN_SECRET);
}

function restHost(): string {
  // e.g. "1234567_SB1" -> "1234567-sb1.suitetalk.api.netsuite.com"
  return `${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
}

function pctEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function authHeader(method: string, baseUrl: string, extraParams: Record<string, string>): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: TOKEN_ID,
    oauth_version: "1.0",
  };
  const all = { ...oauth, ...extraParams };
  const normalized = Object.keys(all)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(all[k]!)}`)
    .join("&");
  const base = [method.toUpperCase(), pctEncode(baseUrl), pctEncode(normalized)].join("&");
  const signingKey = `${pctEncode(CONSUMER_SECRET)}&${pctEncode(TOKEN_SECRET)}`;
  oauth.oauth_signature = crypto.createHmac("sha256", signingKey).update(base).digest("base64");
  const headerParams = Object.keys(oauth)
    .sort()
    .map((k) => `${pctEncode(k)}="${pctEncode(oauth[k]!)}"`)
    .join(", ");
  return `OAuth realm="${ACCOUNT.toUpperCase()}", ${headerParams}`;
}

export interface SuiteQLResult<T = Record<string, unknown>> {
  items: T[];
  hasMore: boolean;
  totalResults?: number;
}

export async function runSuiteQL<T = Record<string, unknown>>(
  q: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<SuiteQLResult<T>> {
  if (!netsuiteConfigured()) throw new Error("NetSuite credentials are not configured");
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const baseUrl = `https://${restHost()}/services/rest/query/v1/suiteql`;
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const url = `${baseUrl}?${query.toString()}`;
  const header = authHeader("POST", baseUrl, { limit: String(limit), offset: String(offset) });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: header,
      "Content-Type": "application/json",
      Prefer: "transient",
    },
    body: JSON.stringify({ q }),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 500);
    try {
      const j = JSON.parse(text);
      detail = j?.["o:errorDetails"]?.[0]?.detail ?? j?.title ?? detail;
    } catch {
      /* keep raw */
    }
    throw new Error(`NetSuite SuiteQL ${res.status}: ${detail}`);
  }
  const json = JSON.parse(text) as { items?: T[]; hasMore?: boolean; totalResults?: number };
  return { items: json.items ?? [], hasMore: Boolean(json.hasMore), totalResults: json.totalResults };
}

/** Lightweight connectivity check — returns vendor count or throws. */
export async function netsuitePing(): Promise<{ vendorCount: number }> {
  const r = await runSuiteQL<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM vendor", { limit: 1 });
  const cnt = Number(r.items?.[0]?.cnt ?? 0);
  return { vendorCount: Number.isFinite(cnt) ? cnt : 0 };
}

export interface NetsuiteShipmentRow {
  orderId: string;
  vendorName: string | null;
  customerDate: string | null; // expected / requested date (YYYY-MM-DD)
  actualShipDate: string | null; // actual ship date (YYYY-MM-DD)
  poDate: string | null; // PO transaction date ("date sent") (YYYY-MM-DD)
  qtyOrdered: number | null; // sum of PO line quantities
  qtyShipped: number | null; // sum of PO line quantity shipped/received
}

/**
 * Pull purchase-order shipment timing from NetSuite. On-time = the vendor's
 * actual ship date is on or before the "customer date" (the linked Sales
 * Order's ship date). Returns SO-linked POs (both drop-ship and special-order)
 * that have both dates.
 */
export async function fetchPurchaseShipments(): Promise<{ rows: NetsuiteShipmentRow[]; truncated: boolean }> {
  // The PO entity is the vendor and `actualshipdate` is the vendor's actual ship
  // date. The "Customer Date" lives on the linked Sales Order's `shipdate`. A PO
  // links back to its SO via previousTransactionLineLink. We include BOTH link
  // types:
  //   - DropShip: vendor ships directly to the customer, so the SO ship date is
  //     the vendor's commitment.
  //   - SpecOrd (special order): vendor ships the goods to Calyx, which then
  //     fulfills the customer; the vendor still must deliver by the SO ship date
  //     for Calyx to make the customer commitment, so the same benchmark applies.
  // Vendors like Compax/Ross do most recent business as special orders, so
  // restricting to drop-ship alone made them appear to have no shipments.
  const q = `
    SELECT DISTINCT
      po.id AS orderid,
      po.tranid AS orderno,
      v.companyname AS vendorname,
      v.entityid AS vendorentity,
      so.shipdate AS customerdate,
      po.actualshipdate AS actualshipdate,
      po.trandate AS podate
    FROM transaction po
    JOIN vendor v ON v.id = po.entity
    JOIN previousTransactionLineLink pll ON pll.nextdoc = po.id AND pll.linktype IN ('DropShip', 'SpecOrd')
    JOIN transaction so ON so.id = pll.previousdoc AND so.type = 'SalesOrd'
    WHERE po.type = 'PurchOrd'
      AND po.actualshipdate IS NOT NULL
      AND so.shipdate IS NOT NULL
    ORDER BY po.id
  `;
  const out: NetsuiteShipmentRow[] = [];
  let offset = 0;
  let truncated = false;
  // Cap pagination to avoid runaway loops; surface truncation to the caller.
  const MAX_PAGES = 50;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await runSuiteQL<Record<string, unknown>>(q, { limit: 1000, offset });
    for (const it of r.items) {
      const orderId = String(it.orderno ?? it.orderid ?? "");
      if (!orderId) continue;
      out.push({
        orderId,
        vendorName: (it.vendorname as string) ?? (it.vendorentity as string) ?? null,
        customerDate: normDate(it.customerdate),
        actualShipDate: normDate(it.actualshipdate),
        poDate: normDate(it.podate),
        qtyOrdered: null,
        qtyShipped: null,
      });
    }
    if (!r.hasMore) break;
    offset += 1000;
    if (page === MAX_PAGES - 1 && r.hasMore) truncated = true;
  }

  // Merge in per-PO quantities (ordered vs shipped/received) for fill rate. Done
  // as a separate aggregation so the timing query above stays at PO grain and
  // the line join below doesn't multiply rows. Keyed by PO tranid (orderNo).
  try {
    const qty = await fetchPurchaseQuantities();
    for (const row of out) {
      const q2 = qty.get(row.orderId);
      if (q2) {
        row.qtyOrdered = q2.qtyOrdered;
        row.qtyShipped = q2.qtyShipped;
      }
    }
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "NetSuite quantity fetch failed; fill rate will be unavailable");
  }

  logger.info({ count: out.length, truncated }, "Fetched NetSuite purchase shipments");
  return { rows: out, truncated };
}

/**
 * Sum ordered vs shipped/received quantities per SO-linked PO, keyed by PO
 * tranid. `quantity` is the ordered amount and `quantityshiprecv` is the amount
 * actually shipped/received; their ratio is the fill rate. Only item lines
 * (mainline='F', non-shipping, with a quantity) are counted.
 */
async function fetchPurchaseQuantities(): Promise<Map<string, { qtyOrdered: number; qtyShipped: number }>> {
  const q = `
    SELECT
      po.tranid AS orderno,
      SUM(tl.quantity) AS qtyordered,
      SUM(tl.quantityshiprecv) AS qtyshipped
    FROM transaction po
    JOIN transactionLine tl ON tl.transaction = po.id
    WHERE po.type = 'PurchOrd'
      AND po.actualshipdate IS NOT NULL
      AND tl.mainline = 'F'
      AND tl.quantity IS NOT NULL
      AND tl.itemtype <> 'ShipItem'
      AND EXISTS (
        SELECT 1 FROM previousTransactionLineLink pll
        JOIN transaction so ON so.id = pll.previousdoc AND so.type = 'SalesOrd'
        WHERE pll.nextdoc = po.id AND pll.linktype IN ('DropShip', 'SpecOrd')
      )
    GROUP BY po.tranid
  `;
  const map = new Map<string, { qtyOrdered: number; qtyShipped: number }>();
  let offset = 0;
  const MAX_PAGES = 50;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await runSuiteQL<Record<string, unknown>>(q, { limit: 1000, offset });
    for (const it of r.items) {
      const orderNo = String(it.orderno ?? "");
      if (!orderNo) continue;
      const ordered = Number(it.qtyordered);
      const shipped = Number(it.qtyshipped);
      map.set(orderNo, {
        qtyOrdered: Number.isFinite(ordered) ? ordered : 0,
        qtyShipped: Number.isFinite(shipped) ? shipped : 0,
      });
    }
    if (!r.hasMore) break;
    offset += 1000;
  }
  return map;
}

export interface NetsuiteVendorPurchaseRow {
  orderId: string; // PO tranid (e.g. "PO1527")
  vendorName: string | null;
  poDate: string | null; // PO transaction date (YYYY-MM-DD)
  amount: number; // merchandise total (sum of item-line net amounts, USD)
}

/**
 * Pull total vendor spend from NetSuite VENDOR BILLS (not POs) for ALL vendors
 * — USER CONFIRMED. Using bills (rather than POs) means bill-only vendors such
 * as Mactac, whose materials are purchased through Label Traxx rather than a
 * NetSuite PO, still show their spend. amount = sum of bill line net amounts
 * (mainline='F', non-shipping); magnitude is taken to stay sign-agnostic.
 * orderId = the bill's tranid. READ-ONLY: SELECT only.
 *
 * NOTE: many bill item lines have a NULL itemtype, and SQL `NULL <> 'ShipItem'`
 * is NOT true — so the shipping filter must explicitly keep NULL itemtype rows
 * (`itemtype IS NULL OR itemtype <> 'ShipItem'`) or whole bills silently vanish.
 */
export async function fetchVendorPurchases(): Promise<{ rows: NetsuiteVendorPurchaseRow[]; truncated: boolean }> {
  const q = `
    SELECT
      b.tranid AS orderno,
      v.companyname AS vendorname,
      v.entityid AS vendorentity,
      MIN(b.trandate) AS podate,
      SUM(tl.netamount) AS netsum
    FROM transaction b
    JOIN vendor v ON v.id = b.entity
    JOIN transactionLine tl ON tl.transaction = b.id
    WHERE b.type = 'VendBill'
      AND tl.mainline = 'F'
      AND (tl.itemtype IS NULL OR tl.itemtype <> 'ShipItem')
      AND tl.netamount IS NOT NULL
    GROUP BY b.tranid, v.companyname, v.entityid
    ORDER BY b.tranid
  `;
  const out: NetsuiteVendorPurchaseRow[] = [];
  let offset = 0;
  let truncated = false;
  const MAX_PAGES = 50;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await runSuiteQL<Record<string, unknown>>(q, { limit: 1000, offset });
    for (const it of r.items) {
      const orderId = String(it.orderno ?? "");
      if (!orderId) continue;
      const amount = Math.abs(Number(it.netsum));
      out.push({
        orderId,
        vendorName: (it.vendorname as string) ?? (it.vendorentity as string) ?? null,
        poDate: normDate(it.podate),
        amount: Number.isFinite(amount) ? amount : 0,
      });
    }
    if (!r.hasMore) break;
    offset += 1000;
    if (page === MAX_PAGES - 1 && r.hasMore) truncated = true;
  }
  logger.info({ count: out.length, truncated }, "Fetched NetSuite vendor purchases");
  return { rows: out, truncated };
}

/** App (UI) host for deep links, e.g. "1234567-sb1.app.netsuite.com". */
function appHost(): string {
  return `${ACCOUNT.toLowerCase().replace(/_/g, "-")}.app.netsuite.com`;
}

export interface NetsuiteQualityCaseRow {
  caseId: string;
  caseNumber: string;
  subject: string | null;
  statusName: string | null;
  openCase: boolean;
  soTranid: string | null;
  poNumber: string | null;
  vendorName: string;
  caseUrl: string;
  startDate: string | null;
}

/**
 * Pull NetSuite support cases and attribute each to the responsible vendor(s).
 *
 * NetSuite has no clean case->transaction link here, so the SO reference lives in
 * the free-text custom field `custeventcust_1st_lttn` (e.g. "TN25692\nSO15101").
 * We parse out `SO#####` tokens, then follow each Sales Order's special-order /
 * drop-ship PO (the same previousTransactionLineLink join used for shipments) to
 * the PO's vendor. A case can resolve to multiple vendors -> one row per vendor.
 * Cases whose SO has no linked PO (fulfilled from stock) resolve to no vendor and
 * are dropped. READ-ONLY: only SELECT queries are issued.
 */
export async function fetchVendorQualityCases(): Promise<NetsuiteQualityCaseRow[]> {
  // 1. Pull cases with an SO reference and their status stage/name.
  const caseQ = `
    SELECT
      c.id AS caseid,
      c.casenumber AS casenumber,
      c.title AS subject,
      c.startdate AS startdate,
      c.custeventcust_1st_lttn AS solttn,
      st.name AS statusname,
      st.stage AS statusstage
    FROM supportcase c
    LEFT JOIN supportcasestatus st ON st.id = c.status
    WHERE c.custeventcust_1st_lttn IS NOT NULL
    ORDER BY c.id
  `;
  interface RawCase {
    caseid: unknown;
    casenumber: unknown;
    subject: unknown;
    startdate: unknown;
    solttn: unknown;
    statusname: unknown;
    statusstage: unknown;
  }
  const cases: RawCase[] = [];
  let offset = 0;
  const MAX_PAGES = 50;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await runSuiteQL<RawCase>(caseQ, { limit: 1000, offset });
    cases.push(...r.items);
    if (!r.hasMore) break;
    offset += 1000;
  }

  // 2. Parse SO tranids out of the free-text field.
  const soForCase = new Map<string, string[]>(); // caseId -> [SO tranid]
  const allSos = new Set<string>();
  for (const c of cases) {
    const caseId = String(c.caseid ?? "");
    if (!caseId) continue;
    const matches = String(c.solttn ?? "").toUpperCase().match(/SO\d+/g) ?? [];
    const uniq = [...new Set(matches)];
    if (uniq.length) {
      soForCase.set(caseId, uniq);
      uniq.forEach((s) => allSos.add(s));
    }
  }
  if (allSos.size === 0) return [];

  // 3. Resolve SO tranid -> [{ vendorName, poNumber }] via the SO's special-order
  //    / drop-ship PO. Chunk the IN list to stay within query limits.
  const vendorsForSo = new Map<string, { vendorName: string; poNumber: string }[]>();
  const soList = [...allSos];
  const CHUNK = 200;
  for (let i = 0; i < soList.length; i += CHUNK) {
    const chunk = soList.slice(i, i + CHUNK);
    const inList = chunk.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
    const linkQ = `
      SELECT DISTINCT
        so.tranid AS so,
        po.tranid AS po,
        v.companyname AS vendor
      FROM transaction so
      JOIN previousTransactionLineLink pll ON pll.previousdoc = so.id AND pll.linktype IN ('DropShip', 'SpecOrd')
      JOIN transaction po ON po.id = pll.nextdoc AND po.type = 'PurchOrd'
      JOIN vendor v ON v.id = po.entity
      WHERE so.type = 'SalesOrd' AND so.tranid IN (${inList})
    `;
    let loff = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await runSuiteQL<{ so: unknown; po: unknown; vendor: unknown }>(linkQ, { limit: 1000, offset: loff });
      for (const it of r.items) {
        const so = String(it.so ?? "").toUpperCase();
        const vendor = (it.vendor as string) ?? null;
        const po = (it.po as string) ?? null;
        if (!so || !vendor) continue;
        const arr = vendorsForSo.get(so) ?? [];
        arr.push({ vendorName: vendor, poNumber: po ?? "" });
        vendorsForSo.set(so, arr);
      }
      if (!r.hasMore) break;
      loff += 1000;
    }
  }

  // 4. Emit one row per (case, vendor), de-duplicated on vendor within a case.
  const out: NetsuiteQualityCaseRow[] = [];
  for (const c of cases) {
    const caseId = String(c.caseid ?? "");
    const sos = soForCase.get(caseId);
    if (!sos) continue;
    const stage = String(c.statusstage ?? "").toUpperCase();
    const openCase = stage !== "CLOSED";
    const seen = new Set<string>();
    for (const so of sos) {
      const vendors = vendorsForSo.get(so);
      if (!vendors) continue;
      for (const { vendorName, poNumber } of vendors) {
        if (seen.has(vendorName)) continue;
        seen.add(vendorName);
        out.push({
          caseId,
          caseNumber: String(c.casenumber ?? ""),
          subject: (c.subject as string) ?? null,
          statusName: (c.statusname as string) ?? null,
          openCase,
          soTranid: so,
          poNumber: poNumber || null,
          vendorName,
          caseUrl: `https://${appHost()}/app/crm/support/supportcase.nl?id=${caseId}`,
          startDate: normDate(c.startdate),
        });
      }
    }
  }
  logger.info({ cases: cases.length, rows: out.length }, "Fetched NetSuite vendor quality cases");
  return out;
}

function normDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v);
  // NetSuite returns dates like "2024-06-30" or "30/6/2024" depending on config.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  return null;
}
