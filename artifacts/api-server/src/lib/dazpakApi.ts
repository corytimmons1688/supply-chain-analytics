import { logger } from "./logger";

/**
 * Dazpak make-and-hold API (https://api.dazpak.com/customers). Auth is a simple
 * `x-api-key` header. Returns Calyx's Dazpak job lines (make-and-hold roll stock
 * in FEET), each carrying a CustPO that matches a Label Traxx PO number (supplier
 * "Dazpak"), an Order Status (Authorised = in production, Held = made & waiting
 * to release, Complete = delivered), quantities, and a Plan Avail Date (ETA).
 */

const DAZPAK_API_URL = (process.env["DAZPAK_API_URL"] ?? "https://api.dazpak.com").replace(/\/$/, "");
const DAZPAK_API_KEY = process.env["DAZPAK_API_KEY"] ?? "";
const REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function dazpakConfigured(): boolean {
  return Boolean(DAZPAK_API_KEY);
}

/** Comma-formatted numeric strings ("330,000") → number; blank → 0. */
function num(v: unknown): number {
  if (v == null) return 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
/** Dazpak dates are ISO-ish ("2026-09-24"); blank → null. */
function dazDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

export interface DazpakRow {
  rowId: string;
  custPo: string | null;
  custItemRef: string | null;
  itemDesc: string | null;
  itemCode: string | null;
  orderStatus: string | null;
  unit: string | null;
  jobOrdQty: number;
  jobOutstQty: number;
  jobRecdQty: number;
  planAvailDate: string | null;
  salesOrderNum: string | null;
  plant: string | null;
}

async function dazGet(path: string, params: Record<string, string | number>): Promise<unknown> {
  if (!DAZPAK_API_KEY) throw new Error("DAZPAK_API_KEY is not configured");
  const url = new URL(`${DAZPAK_API_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { headers: { "x-api-key": DAZPAK_API_KEY }, signal: controller.signal });
    } catch (err) {
      lastErr = new Error(`Dazpak network/timeout on ${path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (RETRYABLE.has(res.status)) {
      lastErr = new Error(`Dazpak ${res.status} on ${path}`);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Dazpak ${res.status} on ${path}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
  throw lastErr ?? new Error(`Dazpak request failed: ${path}`);
}

/** Fetch all Calyx Dazpak job rows (paginated), normalized. */
export async function fetchDazpakRows(): Promise<DazpakRow[]> {
  const out: DazpakRow[] = [];
  for (let page = 1; page <= 100; page++) {
    const body = (await dazGet("/customers", { page, pageSize: 100 })) as {
      data?: Record<string, unknown>[];
      pagination?: { hasMore?: boolean };
    };
    const data = Array.isArray(body?.data) ? body.data : [];
    for (const d of data) {
      const rowId = str(d["rowId"]) ?? str(d["id"]);
      if (!rowId) continue;
      out.push({
        rowId,
        custPo: str(d["CustPO"]),
        custItemRef: str(d["Cust Item Ref"]),
        itemDesc: str(d["Item Desc"]),
        itemCode: str(d["Item Code"]),
        orderStatus: str(d["Order Status"]),
        unit: str(d["Unit"]),
        jobOrdQty: num(d["Job Ord Qty"]),
        jobOutstQty: num(d["Job Outst Qty"]),
        jobRecdQty: num(d["Job Recd Qty"]),
        planAvailDate: dazDate(d["Plan Avail Date"]),
        salesOrderNum: str(d["Sales Order Num"]),
        plant: str(d["Plant"]),
      });
    }
    if (!body?.pagination?.hasMore) break;
  }
  logger.info({ rows: out.length }, "Fetched Dazpak rows");
  return out;
}

/** Health probe for the header status pill. */
export async function checkDazpak(): Promise<{ reachable: boolean; error: string | null }> {
  if (!DAZPAK_API_KEY) return { reachable: false, error: "DAZPAK_API_KEY not set" };
  try {
    await dazGet("/customers", { page: 1, pageSize: 1 });
    return { reachable: true, error: null };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}
