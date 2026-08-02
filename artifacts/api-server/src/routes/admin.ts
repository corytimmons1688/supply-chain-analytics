import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, appUserTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { AuthedUser } from "../lib/better-auth";

const router: IRouter = Router();

const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

function authed(req: Request): AuthedUser | undefined {
  return (req as Request & { user?: AuthedUser }).user;
}

/** Who am I, as far as THIS app is concerned — drives the Admin nav link. */
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const u = authed(req);
    res.json({ email: u?.email ?? "", name: u?.name ?? "", appRole: u?.appRole ?? "member" });
  }),
);

function requireAdmin(req: Request, res: Response): AuthedUser | null {
  const u = authed(req);
  if (!u || u.appRole !== "admin") {
    res.status(403).json({ error: "Administrator access required" });
    return null;
  }
  return u;
}

/** Everyone who has ever signed in to this app, with role and status. */
router.get(
  "/admin/users",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = await db.select().from(appUserTable);
    res.json({
      users: users
        .sort((a, b) => a.email.localeCompare(b.email))
        .map((u) => ({
          email: u.email,
          name: u.name,
          role: u.role,
          status: u.status,
          firstSeenAt: u.firstSeenAt.toISOString(),
          lastSeenAt: u.lastSeenAt.toISOString(),
        })),
    });
  }),
);

/**
 * Change a user's role or status. Self-demotion and self-blocking are
 * rejected so the last admin can't lock everyone out of this screen.
 */
router.put(
  "/admin/users",
  asyncHandler(async (req, res) => {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const b = (req.body ?? {}) as { email?: string; role?: string; status?: string };
    const email = (b.email ?? "").trim().toLowerCase();
    if (!email) return void res.status(400).json({ error: "email required" });
    const role = b.role !== undefined ? b.role : undefined;
    const status = b.status !== undefined ? b.status : undefined;
    if (role !== undefined && role !== "member" && role !== "admin")
      return void res.status(400).json({ error: "role must be member or admin" });
    if (status !== undefined && status !== "active" && status !== "blocked")
      return void res.status(400).json({ error: "status must be active or blocked" });
    if (email === admin.email.toLowerCase() && (role === "member" || status === "blocked"))
      return void res.status(400).json({ error: "You can't demote or block your own account." });
    const [existing] = await db.select().from(appUserTable).where(eq(appUserTable.email, email)).limit(1);
    if (!existing) return void res.status(404).json({ error: "User not found — they appear here after their first sign-in." });
    await db
      .update(appUserTable)
      .set({ ...(role !== undefined ? { role } : {}), ...(status !== undefined ? { status } : {}) })
      .where(eq(appUserTable.email, email));
    res.json({ email, saved: true });
  }),
);

export default router;
