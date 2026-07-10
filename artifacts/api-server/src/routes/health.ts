import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { checkGateway } from "../lib/gateway";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/gateway/health", async (_req, res, next) => {
  try {
    const status = await checkGateway();
    res.json(status);
  } catch (err) {
    next(err);
  }
});

export default router;
