import { Router, type IRouter } from "express";
import healthRouter from "./health";
import cronRouter from "./cron";
import adjustmentsRouter from "./adjustments";
import inventoryRouter from "./inventory";
import goalsRouter from "./goals";
import snapshotsRouter from "./snapshots";
import monthlySnapshotsRouter from "./monthly-snapshots";
import demandRouter from "./demand";
import cycleCountsRouter from "./cycle-counts";
import vendorsRouter from "./vendors";

const router: IRouter = Router();

router.use(healthRouter);
router.use(cronRouter);
router.use(adjustmentsRouter);
router.use(inventoryRouter);
router.use(goalsRouter);
router.use(snapshotsRouter);
router.use(monthlySnapshotsRouter);
router.use(demandRouter);
router.use(cycleCountsRouter);
router.use(vendorsRouter);

export default router;
