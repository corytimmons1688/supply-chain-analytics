import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, globalGoalTable, stockGoalTable, type StockGoalRow } from "@workspace/db";
import { SetGlobalGoalBody, SetStockGoalParams, SetStockGoalBody, DeleteStockGoalParams } from "@workspace/api-zod";

const router: IRouter = Router();
const GLOBAL_KEY = "global";

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function rowToStockGoal(r: StockGoalRow) {
  const weights =
    r.seasonalityW1 != null && r.seasonalityW2 != null && r.seasonalityW3 != null
      ? [r.seasonalityW1, r.seasonalityW2, r.seasonalityW3]
      : null;
  return {
    stockId: r.stockId,
    min: r.min,
    max: r.max,
    demandCv: r.demandCv,
    leadTimeCv: r.leadTimeCv,
    seasonalityWeights: weights,
    leadTimeDays: r.leadTimeDays,
    typicalRollFootage: r.typicalRollFootage,
    orderQuantityRolls: r.orderQuantityRolls,
    discontinued: r.discontinued,
    demandFromStockId: r.demandFromStockId,
  };
}

router.get(
  "/goals",
  asyncHandler(async (_req, res) => {
    const [globalRows, perStockRows] = await Promise.all([
      db.select().from(globalGoalTable).where(eq(globalGoalTable.id, GLOBAL_KEY)),
      db.select().from(stockGoalTable),
    ]);
    const g = globalRows[0];
    res.json({
      global: {
        min: g?.min ?? null,
        max: g?.max ?? null,
        serviceLevel: g?.serviceLevel ?? null,
        monthsBack: g?.monthsBack ?? null,
        demandCv: g?.demandCv ?? null,
        leadTimeCv: g?.leadTimeCv ?? null,
        orderingCost: g?.orderingCost ?? null,
        carryingRatePct: g?.carryingRatePct ?? null,
      },
      perStock: perStockRows.map(rowToStockGoal),
    });
  }),
);

router.put(
  "/goals/global",
  asyncHandler(async (req, res) => {
    const body = SetGlobalGoalBody.parse(req.body);
    const min = body.min ?? null;
    const max = body.max ?? null;
    // Demand Planning shared defaults. Only persist when the client sent the
    // key (undefined = "leave existing value alone"); explicit null clears it.
    const hasServiceLevel = Object.prototype.hasOwnProperty.call(body, "serviceLevel");
    const hasMonthsBack = Object.prototype.hasOwnProperty.call(body, "monthsBack");
    const hasDemandCv = Object.prototype.hasOwnProperty.call(body, "demandCv");
    const hasLeadTimeCv = Object.prototype.hasOwnProperty.call(body, "leadTimeCv");
    const hasOrderingCost = Object.prototype.hasOwnProperty.call(body, "orderingCost");
    const hasCarryingRatePct = Object.prototype.hasOwnProperty.call(body, "carryingRatePct");
    const serviceLevel = hasServiceLevel ? (body.serviceLevel ?? null) : undefined;
    const monthsBack = hasMonthsBack ? (body.monthsBack ?? null) : undefined;
    const demandCv = hasDemandCv ? (body.demandCv ?? null) : undefined;
    const leadTimeCv = hasLeadTimeCv ? (body.leadTimeCv ?? null) : undefined;
    const orderingCost = hasOrderingCost ? (body.orderingCost ?? null) : undefined;
    const carryingRatePct = hasCarryingRatePct ? (body.carryingRatePct ?? null) : undefined;

    const insertValues: typeof globalGoalTable.$inferInsert = {
      id: GLOBAL_KEY,
      min,
      max,
      ...(serviceLevel !== undefined ? { serviceLevel } : {}),
      ...(monthsBack !== undefined ? { monthsBack } : {}),
      ...(demandCv !== undefined ? { demandCv } : {}),
      ...(leadTimeCv !== undefined ? { leadTimeCv } : {}),
      ...(orderingCost !== undefined ? { orderingCost } : {}),
      ...(carryingRatePct !== undefined ? { carryingRatePct } : {}),
    };
    const updateSet: Record<string, unknown> = { min, max, updatedAt: new Date() };
    if (serviceLevel !== undefined) updateSet.serviceLevel = serviceLevel;
    if (monthsBack !== undefined) updateSet.monthsBack = monthsBack;
    if (demandCv !== undefined) updateSet.demandCv = demandCv;
    if (leadTimeCv !== undefined) updateSet.leadTimeCv = leadTimeCv;
    if (orderingCost !== undefined) updateSet.orderingCost = orderingCost;
    if (carryingRatePct !== undefined) updateSet.carryingRatePct = carryingRatePct;

    await db
      .insert(globalGoalTable)
      .values(insertValues)
      .onConflictDoUpdate({ target: globalGoalTable.id, set: updateSet });

    const [row] = await db
      .select()
      .from(globalGoalTable)
      .where(eq(globalGoalTable.id, GLOBAL_KEY));
    res.json({
      min: row?.min ?? null,
      max: row?.max ?? null,
      serviceLevel: row?.serviceLevel ?? null,
      monthsBack: row?.monthsBack ?? null,
      demandCv: row?.demandCv ?? null,
      leadTimeCv: row?.leadTimeCv ?? null,
      orderingCost: row?.orderingCost ?? null,
      carryingRatePct: row?.carryingRatePct ?? null,
    });
  }),
);

router.put(
  "/goals/stock/:stockId",
  asyncHandler(async (req, res) => {
    const params = SetStockGoalParams.parse(req.params);
    const body = SetStockGoalBody.parse(req.body);
    const min = body.min ?? null;
    const max = body.max ?? null;
    const demandCv = body.demandCv ?? null;
    const leadTimeCv = body.leadTimeCv ?? null;
    const w = body.seasonalityWeights;
    const seasonalityW1 = w && w.length === 3 ? w[0]! : null;
    const seasonalityW2 = w && w.length === 3 ? w[1]! : null;
    const seasonalityW3 = w && w.length === 3 ? w[2]! : null;
    // Normalize non-positive overrides to null — these fields are only meaningful
    // when > 0, and demand-compute already ignores 0/negative. Persisting 0 would
    // break round-trip semantics (stored as override but ignored downstream).
    const leadTimeDays =
      body.leadTimeDays != null && body.leadTimeDays > 0 ? body.leadTimeDays : null;
    const typicalRollFootage =
      body.typicalRollFootage != null && body.typicalRollFootage > 0
        ? body.typicalRollFootage
        : null;
    await db
      .insert(stockGoalTable)
      .values({
        stockId: params.stockId,
        min,
        max,
        demandCv,
        leadTimeCv,
        seasonalityW1,
        seasonalityW2,
        seasonalityW3,
        leadTimeDays,
        typicalRollFootage,
      })
      .onConflictDoUpdate({
        target: stockGoalTable.stockId,
        set: {
          min,
          max,
          demandCv,
          leadTimeCv,
          seasonalityW1,
          seasonalityW2,
          seasonalityW3,
          leadTimeDays,
          typicalRollFootage,
          updatedAt: new Date(),
        },
      });
    res.json({
      stockId: params.stockId,
      min,
      max,
      demandCv,
      leadTimeCv,
      seasonalityWeights: w ?? null,
      leadTimeDays,
      typicalRollFootage,
    });
  }),
);

router.delete(
  "/goals/stock/:stockId",
  asyncHandler(async (req, res) => {
    const params = DeleteStockGoalParams.parse(req.params);
    await db.delete(stockGoalTable).where(eq(stockGoalTable.stockId, params.stockId));
    res.status(204).end();
  }),
);

export default router;
