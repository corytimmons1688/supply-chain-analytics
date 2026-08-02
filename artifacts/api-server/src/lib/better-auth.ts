import express, { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, appUserTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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
  /** Role from the shared auth server (global, cross-app) — informational. */
  role: string | null;
  /** THIS app's role, from the app_user registry: member | admin. */
  appRole: string;
  /** THIS app's access status: active | pending | blocked. */
  appStatus: string;
}

// Throttle lastSeenAt writes — the dashboard fires many parallel requests and
// one row-touch per minute per user is plenty.
const lastSeenWrites = new Map<string, number>();

/** Email domains whose accounts become active members on first sign-in. */
function autoApproveDomains(): string[] {
  return (process.env["AUTO_APPROVE_EMAIL_DOMAINS"]?.trim() || "calyxcontainers.com")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

/**
 * App-level access record for a verified identity. First sight of an email
 * auto-provisions a row: company domains (AUTO_APPROVE_EMAIL_DOMAINS, default
 * calyxcontainers.com) start as active members; any other domain starts
 * 'pending' and stays locked out until an admin approves it from /admin.
 */
async function ensureAppUser(email: string, name: string): Promise<{ role: string; status: string }> {
  const key = email.toLowerCase();
  const [existing] = await db.select().from(appUserTable).where(eq(appUserTable.email, key)).limit(1);
  if (existing) {
    if (existing.status === "active") {
      const last = lastSeenWrites.get(key) ?? 0;
      if (Date.now() - last > 60_000) {
        lastSeenWrites.set(key, Date.now());
        await db
          .update(appUserTable)
          .set({ lastSeenAt: new Date(), ...(name && !existing.name ? { name } : {}) })
          .where(eq(appUserTable.email, key));
      }
    }
    return { role: existing.role, status: existing.status };
  }
  const domain = key.split("@")[1] ?? "";
  const status = autoApproveDomains().includes(domain) ? "active" : "pending";
  await db
    .insert(appUserTable)
    .values({ email: key, name: name || null, status })
    .onConflictDoNothing();
  return { role: "member", status };
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
    const email = String(user["email"] ?? "");
    const app = email
      ? await ensureAppUser(email, String(user["name"] ?? ""))
      : { role: "member", status: "pending" };
    // Non-active accounts may still call /me — the frontend uses it to show
    // the "awaiting approval" / "access disabled" screen. Everything else 403s.
    if (app.status !== "active" && req.path !== "/me") {
      res.status(403).json({
        error:
          app.status === "blocked"
            ? "Your access to this dashboard has been disabled by an administrator."
            : "Your account is awaiting administrator approval for this dashboard.",
      });
      return;
    }
    (req as Request & { user?: AuthedUser }).user = {
      id: String(user["id"]),
      email,
      name: String(user["name"] ?? ""),
      role: typeof user["role"] === "string" ? user["role"] : null,
      appRole: app.role,
      appStatus: app.status,
    };
    next();
  } catch (e) {
    // Auth server unreachable — fail closed for API access.
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "Session validation failed");
    res.status(401).json({ error: "Authentication required" });
  }
}
