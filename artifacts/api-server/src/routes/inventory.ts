import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { runGatewaySql, pickNumber } from "../lib/gateway";

const router: IRouter = Router();

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.get(
  "/inventory/on-hand",
  asyncHandler(async (_req, res) => {
    const sql =
      "SELECT IDNumber, CostOfRoll * 10 AS Tenths FROM rollstock WHERE DateRollUsed < {d '1900-01-01'}";
    const rows = await runGatewaySql(sql);
    let totalTenths = 0;
    for (const row of rows) {
      totalTenths += pickNumber(row, "Tenths");
    }
    const totalValue = totalTenths / 10;
    res.json({
      totalValue: Math.round(totalValue * 100) / 100,
      rollCount: rows.length,
    });
  }),
);

export default router;
