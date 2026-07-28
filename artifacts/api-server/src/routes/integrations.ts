import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  gmailConfigured,
  gmailConnection,
  disconnectGmail,
  consentUrl,
  completeConsent,
  verifyState,
  redirectUri,
  scopeSupportsRead,
} from "../lib/gmail";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

/** Where PO email is sent from, and whether it can be sent at all. */
router.get(
  "/integrations/gmail",
  asyncHandler(async (_req, res) => {
    const configured = gmailConfigured();
    const connection = configured ? await gmailConnection() : null;
    res.json({
      configured,
      connected: Boolean(connection),
      accountEmail: connection?.accountEmail ?? null,
      connectedAt: connection?.connectedAt.toISOString() ?? null,
      // The PO agent needs the readonly scope; grants made before it existed
      // must reconnect once to add it.
      needsReconnect: Boolean(connection && !scopeSupportsRead(connection.scope)),
      /** Surfaced so a misconfigured OAuth client is diagnosable from the UI. */
      redirectUri: redirectUri(),
    });
  }),
);

/** Start the consent flow — a browser redirect, not an API call. */
router.get(
  "/integrations/gmail/connect",
  asyncHandler(async (_req, res) => {
    if (!gmailConfigured()) {
      return void res
        .status(409)
        .send("Gmail is not set up on this deployment: GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are missing.");
    }
    res.redirect(consentUrl());
  }),
);

/**
 * Google redirects back here with the consent code. Ends by bouncing to the
 * Configuration tab with a result flag so the UI can show what happened.
 */
router.get(
  "/integrations/gmail/callback",
  asyncHandler(async (req, res) => {
    // Land back on Demand Planning → Configuration, where the connect card lives.
    const back = (params: Record<string, string>) =>
      res.redirect(`/demand?tab=config&${new URLSearchParams(params).toString()}`);

    const error = typeof req.query["error"] === "string" ? req.query["error"] : null;
    if (error) return void back({ gmail: "error", reason: error });

    const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
    const state = typeof req.query["state"] === "string" ? req.query["state"] : undefined;
    if (!code) return void back({ gmail: "error", reason: "no_code" });
    if (!verifyState(state)) return void back({ gmail: "error", reason: "bad_state" });

    try {
      const { accountEmail } = await completeConsent(code);
      logger.info({ accountEmail }, "Gmail connected for PO email");
      back({ gmail: "connected", ...(accountEmail ? { account: accountEmail } : {}) });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      logger.error({ err: reason }, "Gmail consent exchange failed");
      back({ gmail: "error", reason });
    }
  }),
);

router.post(
  "/integrations/gmail/disconnect",
  asyncHandler(async (_req, res) => {
    await disconnectGmail();
    res.json({ disconnected: true });
  }),
);

export default router;
