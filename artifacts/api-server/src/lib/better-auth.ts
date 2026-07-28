import express, { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { logger } from "./logger";

/**
 * Integration with the shared self-hosted Better Auth server (identity only —
 * registration, sign-in, verification, password reset, sessions).
 *
 * Two pieces:
 *
 * 1. `authProxyRouter` — a reverse proxy mounted at /api/auth/* BEFORE the
 *    body parsers. Browsers can't call the auth server directly (it 403s any
 *    Origin not on its trust list, and 403s missing Origins too), so the
 *    frontend talks to its own origin and this forwards server-to-server with
 *    Origin/Referer rewritten to the auth server's own origin. The
 *    `set-auth-token` response header and real status codes/bodies pass
 *    through unmodified — the client SDK depends on them.
 *
 * 2. `requireAuth` — middleware for the app's own APIs: validates the bearer
 *    token by calling /get-session server-to-server and attaches the user.
 *
 * No per-app secrets: the app holds no auth server credentials.
 */

function authBaseUrl(): string {
  return (process.env["BETTER_AUTH_URL"]?.trim() || "https://auth.packos.ai/api/auth").replace(/\/+$/, "");
}

function authOrigin(): string {
  return new URL(authBaseUrl()).origin;
}

/** Headers forwarded upstream from the incoming request. */
const FORWARD_REQUEST_HEADERS = ["content-type", "authorization", "cookie", "accept", "user-agent"] as const;

export const authProxyRouter: IRouter = Router();

// Raw body: this router mounts before express.json(), so the upstream gets
// the exact bytes the browser sent.
authProxyRouter.use(express.raw({ type: () => true, limit: "2mb" }));

authProxyRouter.use(async (req: Request, res: Response) => {
  try {
    // req.url is the path after the mount point (query string included).
    const upstreamUrl = `${authBaseUrl()}${req.url}`;
    const headers: Record<string, string> = {};
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    // The auth server always trusts its own origin. Rewrite — never strip.
    headers["origin"] = authOrigin();
    headers["referer"] = `${authOrigin()}/`;

    const hasBody = !["GET", "HEAD"].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      ...(hasBody ? { body: req.body as unknown as RequestInit["body"] } : {}),
      redirect: "manual",
    });

    // Status, body and the headers the SDK needs pass through unmodified.
    res.status(upstream.status);
    for (const h of ["content-type", "set-auth-token", "location", "retry-after"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    for (const c of upstream.headers.getSetCookie?.() ?? []) res.append("set-cookie", c);
    res.setHeader("cache-control", "no-store");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e), path: req.url }, "Auth proxy failed");
    res.status(502).json({ error: "Authentication service unreachable" });
  }
});

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
}

/**
 * Validate the caller's session against the auth server. No valid session →
 * 401. On success the user rides on req for handlers that want it.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.setHeader("cache-control", "no-store");
  const authorization = req.headers.authorization;
  const cookie = req.headers.cookie;
  if (!authorization && !cookie) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const headers: Record<string, string> = { origin: authOrigin(), referer: `${authOrigin()}/` };
    if (typeof authorization === "string") headers["authorization"] = authorization;
    if (typeof cookie === "string") headers["cookie"] = cookie;
    const r = await fetch(`${authBaseUrl()}/get-session`, { headers });
    const session = r.ok ? ((await r.json().catch(() => null)) as { user?: Record<string, unknown> } | null) : null;
    const user = session?.user;
    if (!user || typeof user["id"] !== "string") {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    (req as Request & { user?: AuthedUser }).user = {
      id: String(user["id"]),
      email: String(user["email"] ?? ""),
      name: String(user["name"] ?? ""),
      role: typeof user["role"] === "string" ? user["role"] : null,
    };
    next();
  } catch (e) {
    // Auth server unreachable — fail closed for API access.
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "Session validation failed");
    res.status(401).json({ error: "Authentication required" });
  }
}
