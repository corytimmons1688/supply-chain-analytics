import { logger } from "./logger";

const GATEWAY_URL_RAW = process.env["ODBC_GATEWAY_URL"];
const GATEWAY_KEY_RAW = process.env["ODBC_GATEWAY_API_KEY"];

if (!GATEWAY_URL_RAW) {
  throw new Error("ODBC_GATEWAY_URL must be set");
}
if (!GATEWAY_KEY_RAW) {
  throw new Error("ODBC_GATEWAY_API_KEY must be set");
}

const GATEWAY_URL: string = GATEWAY_URL_RAW;
const GATEWAY_KEY: string = GATEWAY_KEY_RAW;

export type GatewayRow = Record<string, unknown>;

interface GatewayResponse {
  rows?: GatewayRow[];
  data?: GatewayRow[];
  result?: GatewayRow[];
  error?: string;
}

export async function runGatewaySql(sql: string): Promise<GatewayRow[]> {
  const url = `${GATEWAY_URL.replace(/\/$/, "")}/api/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": GATEWAY_KEY,
    },
    body: JSON.stringify({ sql }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gateway HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as GatewayResponse | GatewayRow[];
  if (Array.isArray(json)) return json;
  if (json.error) throw new Error(`Gateway error: ${json.error}`);
  return json.rows ?? json.data ?? json.result ?? [];
}

/**
 * Is the gateway actually able to answer a query?
 *
 * Its own /health endpoint can't be trusted: observed 2026-08-03, it returned
 * `odbc: {connected: true, latencyMs: 0, lastSuccessfulQuery: <now>}` while
 * EVERY statement — down to `SELECT 1` — failed with "[odbc] Error executing
 * the sql statement". A zero-latency success stamped at request time means it
 * reports its own liveness, not the ODBC link's. So we run a real query and
 * treat that as the answer; /health only tells us the service is listening.
 */
export async function checkGateway(): Promise<{
  reachable: boolean;
  odbcConnected: boolean;
  latencyMs: number;
  error: string | null;
}> {
  const started = Date.now();
  let reachable = false;
  try {
    const res = await fetch(`${GATEWAY_URL.replace(/\/$/, "")}/health`, {
      headers: { "x-api-key": GATEWAY_KEY },
    });
    reachable = res.ok;
    if (!res.ok) {
      return { reachable: false, odbcConnected: false, latencyMs: Date.now() - started, error: `HTTP ${res.status}` };
    }
  } catch (err) {
    logger.warn({ err }, "Gateway health check failed");
    return {
      reachable: false,
      odbcConnected: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  // The real test. Cheapest query that still proves the ODBC link works.
  try {
    await runGatewaySql("SELECT TOP 1 StockID FROM stock");
    return { reachable, odbcConnected: true, latencyMs: Date.now() - started, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ err: error }, "Gateway reachable but ODBC queries are failing");
    return { reachable, odbcConnected: false, latencyMs: Date.now() - started, error };
  }
}

/** Look up a value across mixed-case keys returned by the gateway. */
export function pick(row: GatewayRow, ...keys: string[]): unknown {
  for (const k of keys) {
    if (k in row) return row[k];
    const upper = k.toUpperCase();
    if (upper in row) return row[upper];
    const lower = k.toLowerCase();
    if (lower in row) return row[lower];
  }
  // Final pass: case-insensitive scan
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  for (const [rk, rv] of Object.entries(row)) {
    if (wanted.has(rk.toLowerCase())) return rv;
  }
  return undefined;
}

export function pickString(row: GatewayRow, ...keys: string[]): string | null {
  const v = pick(row, ...keys);
  if (v == null) return null;
  return String(v);
}

export function pickNumber(row: GatewayRow, ...keys: string[]): number {
  const v = pick(row, ...keys);
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}
