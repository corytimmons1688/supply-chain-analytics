import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq, sql } from "drizzle-orm";
import { db, globalGoalTable, stockGoalTable, type CycleCountSchedule } from "@workspace/db";
import {
  fetchUsage,
  fetchOnHandByStock,
  fetchActiveStockIds,
  defaultDemandWindow,
} from "../lib/demand";
import {
  buildSchedule,
  classifyAbc,
  computeKpi,
  getCurrentQuarter,
  type AbcStock,
} from "../lib/cycle-counts";

const router: IRouter = Router();
const GLOBAL_KEY = "global";

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// --- Build a fresh ABC stock list from current Label Traxx state ---
async function loadAbcStocks(): Promise<{ stockId: string; abc: "A" | "B" | "C"; description: string | null; onHandFootage: number }[]> {
  const { from, to } = defaultDemandWindow(6);
  const [usage, onHand, activeStockIds] = await Promise.all([
    fetchUsage({ from, to }),
    fetchOnHandByStock(),
    fetchActiveStockIds(),
  ]);

  // Aggregate footage per stock and average across the window in weeks.
  const ftByStock = new Map<string, number>();
  const descByStock = new Map<string, string | null>();
  for (const u of usage) {
    ftByStock.set(u.stockId, (ftByStock.get(u.stockId) ?? 0) + (u.footage || 0));
    if (u.description && !descByStock.get(u.stockId)) descByStock.set(u.stockId, u.description);
  }
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const fromMs = Date.UTC(fy!, fm! - 1, fd!);
  const toMs = Date.UTC(ty!, tm! - 1, td!);
  const weeks = Math.max(1, (toMs - fromMs) / (86400000 * 7));

  const allStockIds = new Set<string>();
  for (const k of ftByStock.keys()) if (activeStockIds.has(k)) allStockIds.add(k);
  for (const k of onHand.keys()) if (activeStockIds.has(k)) allStockIds.add(k);

  const rows = Array.from(allStockIds).map((stockId) => ({
    stockId,
    avgWeeklyDemand: (ftByStock.get(stockId) ?? 0) / weeks,
    onHandFootage: onHand.get(stockId)?.footage ?? 0,
    description: descByStock.get(stockId) ?? onHand.get(stockId)?.description ?? null,
  }));
  const abc = classifyAbc(rows);
  return rows
    .map((r) => {
      const cls = abc.get(r.stockId);
      return cls ? { stockId: r.stockId, abc: cls, description: r.description, onHandFootage: r.onHandFootage } : null;
    })
    .filter((r): r is { stockId: string; abc: "A" | "B" | "C"; description: string | null; onHandFootage: number } => r != null);
}

// --- Get / generate the active schedule snapshot ---
async function getOrCreateActiveSchedule(force = false): Promise<{ schedule: CycleCountSchedule; freshlyGenerated: boolean }> {
  const quarter = getCurrentQuarter();
  const [g] = await db.select().from(globalGoalTable).where(eq(globalGoalTable.id, GLOBAL_KEY));
  const existing = g?.cycleCountSchedule ?? null;
  if (!force && existing && existing.quarter === quarter.quarter) {
    return { schedule: existing, freshlyGenerated: false };
  }

  // Need to (re)generate: classify all current active stocks and snapshot.
  const stocks = await loadAbcStocks();
  const abcStocks: AbcStock[] = stocks.map((s) => ({ stockId: s.stockId, abc: s.abc }));
  const fresh = buildSchedule(quarter, abcStocks);

  await db
    .insert(globalGoalTable)
    .values({ id: GLOBAL_KEY, cycleCountSchedule: fresh })
    .onConflictDoUpdate({
      target: globalGoalTable.id,
      set: { cycleCountSchedule: fresh, updatedAt: new Date() },
    });
  return { schedule: fresh, freshlyGenerated: true };
}

// --- Aggregate completion records across all stocks ---
async function loadAllCompletions(quarterKey: string): Promise<Map<string, Array<{ quarter: string; week: number; completedAt: string }>>> {
  const rows = await db.select().from(stockGoalTable);
  const out = new Map<string, Array<{ quarter: string; week: number; completedAt: string }>>();
  for (const r of rows) {
    const all = r.cycleCountCompletions ?? [];
    const filtered = all.filter((c) => c.quarter === quarterKey);
    if (filtered.length > 0) out.set(r.stockId, filtered);
  }
  return out;
}

router.get(
  "/cycle-counts/schedule",
  asyncHandler(async (_req, res) => {
    const { schedule } = await getOrCreateActiveSchedule(false);
    const completionsByStock = await loadAllCompletions(schedule.quarter);

    // Build per-week task list with descriptions and completion flags.
    const stockMeta = await loadAbcStocks(); // descriptions + on-hand for display
    const metaByStock = new Map(stockMeta.map((s) => [s.stockId, s]));

    const completionLookup = new Map<string, string>(); // `${stockId}|${week}` -> completedAt
    for (const [stockId, list] of completionsByStock.entries()) {
      for (const c of list) completionLookup.set(`${stockId}|${c.week}`, c.completedAt);
    }

    const weeks = schedule.weekStarts.map((weekStart, i) => {
      const w = i + 1;
      const tasks = Object.entries(schedule.assignments)
        .filter(([, a]) => a.weeks.includes(w))
        .map(([stockId, a]) => {
          const meta = metaByStock.get(stockId);
          const completedAt = completionLookup.get(`${stockId}|${w}`) ?? null;
          return {
            stockId,
            description: meta?.description ?? null,
            abcClass: a.abc,
            onHandFootage: meta?.onHandFootage ?? 0,
            completedAt,
          };
        })
        .sort((a, b) => {
          const order = { A: 0, B: 1, C: 2 } as const;
          if (order[a.abcClass] !== order[b.abcClass]) return order[a.abcClass] - order[b.abcClass];
          return a.stockId.localeCompare(b.stockId, undefined, { numeric: true });
        });
      const expected = tasks.length;
      const completed = tasks.filter((t) => t.completedAt != null).length;
      return {
        week: w,
        weekStart,
        weekEnd: addDays(weekStart, 6),
        expected,
        completed,
        tasks,
      };
    });

    const allCompletions = Array.from(completionsByStock.values()).flat();
    const kpi = { quarter: schedule.quarter, ...computeKpi(schedule, allCompletions) };

    res.json({
      quarter: schedule.quarter,
      startDate: schedule.startDate,
      endDate: schedule.endDate,
      consolidated: schedule.consolidated,
      generatedAt: schedule.generatedAt,
      kpi,
      weeks,
    });
  }),
);

router.get(
  "/cycle-counts/kpi",
  asyncHandler(async (_req, res) => {
    const { schedule } = await getOrCreateActiveSchedule(false);
    const completionsByStock = await loadAllCompletions(schedule.quarter);
    const allCompletions = Array.from(completionsByStock.values()).flat();
    const kpi = computeKpi(schedule, allCompletions);
    res.json({ quarter: schedule.quarter, ...kpi });
  }),
);

router.post(
  "/cycle-counts/regenerate",
  asyncHandler(async (_req, res) => {
    const { schedule } = await getOrCreateActiveSchedule(true);
    res.json({ quarter: schedule.quarter, generatedAt: schedule.generatedAt });
  }),
);

router.post(
  "/cycle-counts/complete",
  asyncHandler(async (req, res) => {
    const { stockId, quarter, week, completedAt } = req.body ?? {};
    if (typeof stockId !== "string" || typeof quarter !== "string" || typeof week !== "number") {
      return res.status(400).json({ error: "stockId, quarter, week required" });
    }
    const ts = typeof completedAt === "string" ? completedAt : new Date().toISOString();
    // Atomic upsert: dedupe by (quarter, week) inside SQL to avoid lost-update races.
    await db.execute(sql`
      INSERT INTO stock_goal (stock_id, cycle_count_completions)
      VALUES (
        ${stockId},
        jsonb_build_array(jsonb_build_object('quarter', ${quarter}::text, 'week', ${week}::int, 'completedAt', ${ts}::text))
      )
      ON CONFLICT (stock_id) DO UPDATE
      SET
        cycle_count_completions = (
          SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
          FROM jsonb_array_elements(COALESCE(stock_goal.cycle_count_completions, '[]'::jsonb)) AS elem
          WHERE NOT (elem->>'quarter' = ${quarter}::text AND (elem->>'week')::int = ${week}::int)
        ) || jsonb_build_array(jsonb_build_object('quarter', ${quarter}::text, 'week', ${week}::int, 'completedAt', ${ts}::text)),
        updated_at = NOW()
    `);
    return res.json({ stockId, quarter, week, completedAt: ts });
  }),
);

router.delete(
  "/cycle-counts/complete",
  asyncHandler(async (req, res) => {
    const { stockId, quarter, week } = req.body ?? {};
    if (typeof stockId !== "string" || typeof quarter !== "string" || typeof week !== "number") {
      return res.status(400).json({ error: "stockId, quarter, week required" });
    }
    // Atomic remove via jsonb_array_elements filter; no-op if row doesn't exist.
    await db.execute(sql`
      UPDATE stock_goal
      SET
        cycle_count_completions = (
          SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
          FROM jsonb_array_elements(COALESCE(cycle_count_completions, '[]'::jsonb)) AS elem
          WHERE NOT (elem->>'quarter' = ${quarter}::text AND (elem->>'week')::int = ${week}::int)
        ),
        updated_at = NOW()
      WHERE stock_id = ${stockId}
    `);
    return res.status(204).end();
  }),
);

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export default router;
