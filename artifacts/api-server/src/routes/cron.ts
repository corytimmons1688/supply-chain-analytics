import { Router, type IRouter } from "express";
import { captureSnapshot } from "../lib/snapshot-service";
import { captureMonthlySnapshot } from "../lib/monthly-snapshot-service";
import { logger } from "../lib/logger";

const router: IRouter = Router();

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
    const secret = process.env["CRON_SECRET"];
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      return void res.status(401).json({ error: "Unauthorized" });
    }

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
