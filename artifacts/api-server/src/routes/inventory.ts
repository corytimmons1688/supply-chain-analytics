import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { fetchOnHandValue } from "../lib/adjustments";

const router: IRouter = Router();

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.get(
  "/inventory/on-hand",
  asyncHandler(async (_req, res) => {
    const { totalValue, rollCount } = await fetchOnHandValue();
    res.json({ totalValue, rollCount });
  }),
);

export default router;
