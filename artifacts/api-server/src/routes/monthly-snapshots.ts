import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  listMonthlySnapshots,
  getMonthlySnapshot,
} from "../lib/monthly-snapshot-store";
import { captureMonthlySnapshot } from "../lib/monthly-snapshot-service";

const router: IRouter = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.get(
  "/monthly-snapshots",
  asyncHandler(async (_req, res) => {
    const all = await listMonthlySnapshots();
    const items = all.map(({ rolls: _r, ...summary }) => summary);
    res.json({ items });
  }),
);

router.get(
  "/monthly-snapshots/:monthKey",
  asyncHandler(async (req, res) => {
    const monthKeyRaw = req.params["monthKey"];
    const monthKey = Array.isArray(monthKeyRaw) ? monthKeyRaw[0] : monthKeyRaw;
    if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
      res.status(400).json({ error: "Invalid monthKey (expected YYYY-MM)" });
      return;
    }
    const snap = await getMonthlySnapshot(monthKey);
    if (!snap) {
      res.status(404).json({ error: "Monthly snapshot not found" });
      return;
    }
    res.json(snap);
  }),
);

router.post(
  "/monthly-snapshots",
  asyncHandler(async (req, res) => {
    const asOfRaw = req.query["asOf"];
    let target: Date | undefined;
    if (typeof asOfRaw === "string" && asOfRaw.length > 0) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw)) {
        res.status(400).json({ error: "Invalid asOf (expected YYYY-MM-DD)" });
        return;
      }
      target = new Date(`${asOfRaw}T18:00:00Z`);
    }
    const snap = await captureMonthlySnapshot(target);
    res.json(snap);
  }),
);

export default router;
