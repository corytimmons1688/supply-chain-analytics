import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { listSnapshots, getSnapshot } from "../lib/snapshot-store";
import { captureSnapshot } from "../lib/snapshot-service";

const router: IRouter = Router();

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.get(
  "/snapshots",
  asyncHandler(async (_req, res) => {
    const all = await listSnapshots();
    const items = all.map(({ rolls: _r, ...summary }) => summary);
    res.json({ items });
  }),
);

router.get(
  "/snapshots/:weekEnding",
  asyncHandler(async (req, res) => {
    const weekEndingRaw = req.params["weekEnding"];
    const weekEnding = Array.isArray(weekEndingRaw) ? weekEndingRaw[0] : weekEndingRaw;
    if (!weekEnding || !/^\d{4}-\d{2}-\d{2}$/.test(weekEnding)) {
      res.status(400).json({ error: "Invalid weekEnding (expected YYYY-MM-DD)" });
      return;
    }
    const snap = await getSnapshot(weekEnding);
    if (!snap) {
      res.status(404).json({ error: "Snapshot not found" });
      return;
    }
    res.json(snap);
  }),
);

router.post(
  "/snapshots",
  asyncHandler(async (req, res) => {
    // Optional ?asOf=YYYY-MM-DD lets you backfill the snapshot for any past
    // week. Without it, the current Mountain-Time week is captured.
    const asOfRaw = req.query["asOf"];
    let target: Date | undefined;
    if (typeof asOfRaw === "string" && asOfRaw.length > 0) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw)) {
        res.status(400).json({ error: "Invalid asOf (expected YYYY-MM-DD)" });
        return;
      }
      // Anchor mid-day UTC so the date lands on the same MT calendar day.
      target = new Date(`${asOfRaw}T18:00:00Z`);
    }
    const snap = await captureSnapshot(target);
    res.json(snap);
  }),
);

export default router;
