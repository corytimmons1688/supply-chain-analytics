import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db, syncStateTable } from "@workspace/db";
import { checkGateway } from "../lib/gateway";
import { checkLtApi } from "../lib/ltApi";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** Friendly names for sync_state sources, in display order. */
const SYNC_SOURCE_LABELS: [string, string][] = [
  ["labeltraxx_rolls", "Label Traxx on-hand"],
  ["labeltraxx_api", "Label Traxx full sync"],
  ["netsuite", "NetSuite"],
  ["quality", "Quality"],
  ["labeltraxx", "Label Traxx purchases"],
];

/** Age of each data source's last successful sync — feeds the header indicator. */
async function syncAges(): Promise<{ source: string; label: string; syncedAt: string; minutesAgo: number }[]> {
  const rows = await db.select({ source: syncStateTable.source, syncedAt: syncStateTable.syncedAt }).from(syncStateTable);
  const bySource = new Map(rows.map((r) => [r.source, r.syncedAt]));
  const out: { source: string; label: string; syncedAt: string; minutesAgo: number }[] = [];
  for (const [source, label] of SYNC_SOURCE_LABELS) {
    const at = bySource.get(source);
    if (!at) continue;
    out.push({ source, label, syncedAt: at.toISOString(), minutesAgo: Math.max(0, Math.round((Date.now() - at.getTime()) / 60_000)) });
  }
  return out;
}

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/gateway/health", async (_req, res, next) => {
  try {
    // Primary connectivity = the LT Cloud API; the ODBC gateway remains in
    // use only for per-roll-cost reads (on-hand value, CC adjustments).
    const [api, odbc, ages] = await Promise.all([
      checkLtApi(),
      checkGateway(),
      syncAges().catch((e) => {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, "sync_state read failed");
        return [];
      }),
    ]);
    res.json({
      reachable: api.reachable,
      odbcConnected: api.healthy,
      latencyMs: api.latencyMs,
      error: api.error,
      ltApi: api,
      odbcGateway: odbc,
      syncAges: ages,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
