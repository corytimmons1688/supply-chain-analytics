import { Router, type IRouter, type Request, type Response } from "express";
import { captureSnapshot } from "../lib/snapshot-service";
import { captureMonthlySnapshot } from "../lib/monthly-snapshot-service";
import { logger } from "../lib/logger";
import { performNetsuiteSync, performQualitySync, performLabeltraxxSync } from "./vendors";

const router: IRouter = Router();

/** Bearer CRON_SECRET guard; responds 401 and returns false when rejected. */
function cronAuthorized(req: Request, res: Response): boolean {
  const secret = process.env["CRON_SECRET"];
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * Scheduled data refresh (hourly via GitHub Actions, daily via Vercel Cron
 * as backup): NetSuite shipments/purchases, quality cases, and LabelTraxx
 * lead times. Each source fails independently.
 */
router.get("/cron/netsuite-sync", async (req, res, next) => {
  try {
    if (!cronAuthorized(req, res)) return;
    const out: Record<string, unknown> = {};
    for (const [name, run] of [
      ["netsuite", performNetsuiteSync],
      ["quality", performQualitySync],
      ["labeltraxx", () => performLabeltraxxSync()],
    ] as const) {
      try {
        out[name] = await run();
      } catch (err) {
        out[name] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    logger.info({ out }, "Scheduled data sync ran");
    res.json(out);
  } catch (err) {
    next(err);
  }
});

function mtParts(d: Date): { month: string; weekday: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    month: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(d);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  return { month: lookup["month"] ?? "", weekday: lookup["weekday"] ?? "" };
}

/**
 * Daily scheduler entry, invoked by Vercel Cron (GET-only) late in the
 * Mountain-Time day. Replaces the node-cron schedules from index.ts:
 *  - weekly snapshot when today is Sunday (MT)
 *  - monthly snapshot when tomorrow is a new month (MT)
 * Idempotent: captures upsert by weekEnding/monthKey, so a rerun on the same
 * day just refreshes the same snapshot.
 */
router.get("/cron/snapshots", async (req, res, next) => {
  try {
    if (!cronAuthorized(req, res)) return;

    const now = new Date();
    const today = mtParts(now);
    const tomorrow = mtParts(new Date(now.getTime() + 24 * 60 * 60 * 1000));

    const ran: Record<string, string> = {};
    if (today.weekday === "Sun") {
      const snap = await captureSnapshot(now);
      ran["weekly"] = snap.weekEnding;
    }
    if (today.month !== tomorrow.month) {
      const snap = await captureMonthlySnapshot(now);
      ran["monthly"] = snap.monthKey;
    }

    logger.info({ ran }, "Snapshot cron endpoint ran");
    res.json({ ran });
  } catch (err) {
    next(err);
  }
});

export default router;
