import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { checkGateway } from "../lib/gateway";
import { checkLtApi } from "../lib/ltApi";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/gateway/health", async (_req, res, next) => {
  try {
    // Primary connectivity = the LT Cloud API; the ODBC gateway remains in
    // use only for per-roll-cost reads (on-hand value, CC adjustments).
    const [api, odbc] = await Promise.all([checkLtApi(), checkGateway()]);
    res.json({
      reachable: api.reachable,
      odbcConnected: api.healthy,
      latencyMs: api.latencyMs,
      error: api.error,
      ltApi: api,
      odbcGateway: odbc,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
