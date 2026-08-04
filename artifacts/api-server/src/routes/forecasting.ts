/**
 * Forward material demand from HubSpot pre-order support. READ ONLY.
 *
 * GET /forecasting/preorder — internal-only estimating pipeline, In Progress
 * onward, converted to feet of LT roll stock. Computed on demand; nothing is
 * persisted (no new Neon tables) and nothing is written back to HubSpot.
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { hubspotConfigured } from "@workspace/hubspot-preorder";
import { buildPreorderForecast } from "../lib/hubspot-preorder-forecast";
import { buildQuoteStageForecast } from "../lib/quote-stage-forecast";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

router.get(
  "/forecasting/preorder",
  asyncHandler(async (_req, res) => {
    if (!hubspotConfigured(process.env["HUBSPOT_TOKEN"] ?? "")) {
      return void res.status(503).json({
        error: "HubSpot is not configured",
        detail: "Set HUBSPOT_TOKEN to a private-app token with CRM read scopes.",
      });
    }
    const forecast = await buildPreorderForecast();
    logger.info(
      { forecastable: forecast.totals.forecastable, rawFt: Math.round(forecast.totals.rawFt) },
      "forecasting/preorder served",
    );
    res.json(forecast);
  }),
);

/**
 * The quote-stage forecast: HubSpot quotes + NetSuite firm orders + the LT mirror,
 * with derived stock policy and the full assumption registry. Read-only.
 */
router.get(
  "/forecasting/quote-stage",
  asyncHandler(async (_req, res) => {
    if (!hubspotConfigured(process.env["HUBSPOT_TOKEN"] ?? "")) {
      return void res.status(503).json({
        error: "HubSpot is not configured",
        detail: "Set HUBSPOT_TOKEN to a private-app token with CRM read scopes.",
      });
    }
    const forecast = await buildQuoteStageForecast();
    res.json(forecast);
  }),
);

export default router;
