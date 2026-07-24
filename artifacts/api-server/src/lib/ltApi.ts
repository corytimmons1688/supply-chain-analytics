import { logger } from "./logger";

/**
 * LabelTraxx Cloud API client (https://api.labeltraxx.com, docs at
 * https://docs-api.labeltraxx.com/). Replaces the self-hosted ODBC gateway
 * for everything except per-roll-cost reads (see gateway.ts).
 *
 * API characteristics (probed against production):
 *  - Auth: bare `Authorization: <key>` header (no Bearer prefix).
 *  - Pagination: Page (0-BASED, Page=0 is the first page) + PageSize (≤100);
 *    `*-count` endpoints return a plain number.
 *  - Dates are returned as MM/DD/YYYY; the blank-date sentinel is 01/01/1970.
 *  - Writes: fields not being changed must be OMITTED from the JSON body.
 */

const LT_API_URL = (process.env["LT_API_URL"] ?? "https://api.labeltraxx.com").replace(/\/$/, "");
const LT_API_KEY = process.env["LT_API_KEY"] ?? "";

export function ltApiConfigured(): boolean {
  return Boolean(LT_API_KEY);
}

const MAX_PAGE_SIZE = 100;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// Hard per-request timeout. Without this a single unresponsive LT endpoint
// blocks the fetch forever, which stalls the whole sync until the serverless
// function is killed — leaving the mirror silently stale. (Caused a 2-day
// ticket/PO/roll sync outage on 2026-07-22.)
const REQUEST_TIMEOUT_MS = 30_000;

async function ltRequest<T>(method: "GET" | "POST" | "PUT", path: string, opts: {
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
} = {}): Promise<T> {
  if (!LT_API_KEY) throw new Error("LT_API_KEY is not configured");
  const url = new URL(`${LT_API_URL}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    let res: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: LT_API_KEY,
          ...(opts.body != null ? { "content-type": "application/json" } : {}),
        },
        body: opts.body != null ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      // Timeout (abort) or network error — retry rather than hang/abort the sync.
      lastErr =
        err instanceof Error && err.name === "AbortError"
          ? new Error(`LT API timeout after ${REQUEST_TIMEOUT_MS}ms on ${method} ${path}`)
          : new Error(`LT API network error on ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (RETRYABLE.has(res.status)) {
      lastErr = new Error(`LT API ${res.status} on ${method} ${path}`);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`LT API ${res.status} on ${method} ${path}: ${text.slice(0, 400)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      // some endpoints (system-status, counts) return plain text
      return text as unknown as T;
    }
  }
  throw lastErr ?? new Error(`LT API request failed: ${method} ${path}`);
}

export function ltGet<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  return ltRequest<T>("GET", path, { params });
}

export function ltPost<T>(path: string, body: unknown): Promise<T> {
  return ltRequest<T>("POST", path, { body });
}

/** Count endpoints return a bare number (sometimes as text). */
export async function ltCount(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<number> {
  const raw = await ltGet<unknown>(path, params);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Page through a list endpoint until a short/empty page. Runs pages
 * sequentially (the LT API is a shared production system — be gentle).
 */
export async function ltGetAllPages<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  opts: { maxPages?: number; onPage?: (page: number, count: number) => void } = {},
): Promise<T[]> {
  const out: T[] = [];
  const maxPages = opts.maxPages ?? 1000;
  // Pagination is 0-BASED: Page=0 is the first page (verified empirically —
  // starting at 1 silently skips the first PageSize records).
  for (let page = 0; page < maxPages; page++) {
    const rows = await ltGet<T[]>(path, { ...params, Page: page, PageSize: MAX_PAGE_SIZE });
    if (!Array.isArray(rows)) break;
    out.push(...rows);
    opts.onPage?.(page, rows.length);
    if (rows.length < MAX_PAGE_SIZE) break;
  }
  return out;
}

/** Bounded-concurrency map for per-record detail fetches. */
export async function ltMapConcurrent<I, O>(
  items: I[],
  concurrency: number,
  fn: (item: I) => Promise<O>,
): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** MM/DD/YYYY (or ISO) → ISO YYYY-MM-DD; blank sentinel (≤1990) → null. */
export function ltDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!s) return null;
  let iso: string | null = null;
  const isoM = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (isoM) iso = `${isoM[1]}-${isoM[2]}-${isoM[3]}`;
  const usM = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (usM) iso = `${usM[3]}-${String(Number(usM[1])).padStart(2, "0")}-${String(Number(usM[2])).padStart(2, "0")}`;
  if (!iso) return null;
  return iso < "1990-01-01" ? null : iso;
}

/** LT API /system-status returns plain text like "app OK\ndb OK\nproxy OK". */
export async function checkLtApi(): Promise<{ reachable: boolean; healthy: boolean; latencyMs: number; error: string | null }> {
  const started = Date.now();
  try {
    const text = await ltGet<string>("/system-status");
    const latencyMs = Date.now() - started;
    const healthy = typeof text === "string" && /app ok/i.test(text) && /db ok/i.test(text);
    return { reachable: true, healthy, latencyMs, error: null };
  } catch (err) {
    logger.warn({ err }, "LT API health check failed");
    return {
      reachable: false,
      healthy: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
