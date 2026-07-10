// Cycle-count scheduling logic. Drives the calendar of which stocks need to
// be counted in which week of the active financial quarter, with cadence
// driven by ABC class:
//   A → every week
//   B → once per month within the quarter
//   C → once per quarter
//
// Q2 2026 is a one-time "consolidated" quarter that starts the week of
// 2026-05-04 (next-week from launch) and runs through end of June. After
// that the schedule rotates with standard calendar quarters.
//
// All assignments are deterministic from the stockId (djb2 hash) so the
// schedule is reproducible without persisted seeds, but we still snapshot
// the generated plan to globalGoalTable so it stays stable if a stock's
// ABC class shifts mid-quarter.

import type { CycleCountSchedule } from "@workspace/db";

// ---------- Date helpers (UTC-based to keep math deterministic) ----------

function pad(n: number): string { return String(n).padStart(2, "0"); }

function isoFromUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function utcFromIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function addDaysIso(iso: string, days: number): string {
  const d = utcFromIso(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return isoFromUtc(d);
}

/** Returns the Monday of the week that contains the given date (UTC). */
function mondayOf(iso: string): string {
  const d = utcFromIso(iso);
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon, …
  const offsetToMonday = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offsetToMonday);
  return isoFromUtc(d);
}

/** First Monday on or after the given date (UTC). */
function mondayOnOrAfter(iso: string): string {
  const d = utcFromIso(iso);
  const dow = d.getUTCDay();
  const add = dow === 1 ? 0 : (8 - dow) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + (dow === 1 ? 0 : add));
  return isoFromUtc(d);
}

// ---------- Quarter info ----------

export interface QuarterInfo {
  quarter: string;            // "2026Q2"
  year: number;
  q: 1 | 2 | 3 | 4;
  startDate: string;          // first Monday of the cycle-count window
  endDate: string;            // last calendar day of the quarter (clipped)
  consolidated: boolean;
  weekStarts: string[];       // ISO Monday for week 1..N
}

function quarterFor(year: number, q: 1 | 2 | 3 | 4): QuarterInfo {
  // Q2 2026 special override per launch plan: start the week of May 4 and
  // finish by end of June, giving an 8-week consolidated cycle. Last week
  // start is 2026-06-22 so all 8 weeks complete by 2026-06-28.
  if (year === 2026 && q === 2) {
    return buildQuarter("2026Q2", year, q, "2026-05-04", "2026-06-28", true);
  }
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const calStart = `${year}-${pad(startMonth)}-01`;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  const calEnd = `${year}-${pad(endMonth)}-${pad(lastDay)}`;
  const start = mondayOnOrAfter(calStart);
  return buildQuarter(`${year}Q${q}`, year, q, start, calEnd, false);
}

function buildQuarter(
  quarter: string,
  year: number,
  q: 1 | 2 | 3 | 4,
  startMonday: string,
  endDate: string,
  consolidated: boolean,
): QuarterInfo {
  const weekStarts: string[] = [];
  let cursor = startMonday;
  // Include any week whose Monday falls on or before endDate. We absorb the
  // tail days (Tue–Sun after the last Monday) into that final week.
  while (cursor <= endDate) {
    weekStarts.push(cursor);
    cursor = addDaysIso(cursor, 7);
  }
  return { quarter, year, q, startDate: startMonday, endDate, consolidated, weekStarts };
}

export function getCurrentQuarter(today: Date = new Date()): QuarterInfo {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const q = (Math.floor((m - 1) / 3) + 1) as 1 | 2 | 3 | 4;
  return quarterFor(y, q);
}

export function getQuarterByKey(key: string): QuarterInfo | null {
  const m = /^(\d{4})Q([1-4])$/.exec(key);
  if (!m) return null;
  return quarterFor(Number(m[1]!), Number(m[2]!) as 1 | 2 | 3 | 4);
}

// ---------- Hashing & assignment ----------

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

/** Group week indices (1-based) by calendar month within the quarter. */
function weeksByMonth(weekStarts: string[]): number[][] {
  const groups = new Map<string, number[]>();
  weekStarts.forEach((w, i) => {
    const key = w.slice(0, 7); // YYYY-MM
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(i + 1);
  });
  return Array.from(groups.values());
}

export interface AbcStock {
  stockId: string;
  abc: "A" | "B" | "C";
}

/** Generate a per-stock week assignment list for the given quarter. */
export function generateAssignments(
  stocks: AbcStock[],
  quarter: QuarterInfo,
): Record<string, { abc: "A" | "B" | "C"; weeks: number[] }> {
  const out: Record<string, { abc: "A" | "B" | "C"; weeks: number[] }> = {};
  const totalWeeks = quarter.weekStarts.length;
  const months = weeksByMonth(quarter.weekStarts);

  for (const s of stocks) {
    if (s.abc === "A") {
      // A items are counted every week of the quarter.
      out[s.stockId] = { abc: "A", weeks: Array.from({ length: totalWeeks }, (_, i) => i + 1) };
    } else if (s.abc === "B") {
      // B items: one week per calendar month inside the quarter, hashed
      // deterministically so the load is spread evenly across weeks.
      const h = djb2(s.stockId);
      const weeks: number[] = [];
      for (let i = 0; i < months.length; i++) {
        const monthWeeks = months[i]!;
        weeks.push(monthWeeks[(h + i) % monthWeeks.length]!);
      }
      out[s.stockId] = { abc: "B", weeks: weeks.sort((a, b) => a - b) };
    } else {
      // C items: one week in the entire quarter.
      const h = djb2(s.stockId);
      out[s.stockId] = { abc: "C", weeks: [(h % totalWeeks) + 1] };
    }
  }
  return out;
}

// ---------- ABC classification (mirror of the frontend logic) ----------

export interface DemandRow {
  stockId: string;
  avgWeeklyDemand: number;
  onHandFootage: number;
}

export function classifyAbc(rows: DemandRow[]): Map<string, "A" | "B" | "C" | null> {
  const out = new Map<string, "A" | "B" | "C" | null>();
  const ranked = rows
    .map((r) => ({ stockId: r.stockId, annual: Math.max(0, r.avgWeeklyDemand) * 52 }))
    .filter((r) => r.annual > 0)
    .sort((a, b) => b.annual - a.annual);
  const total = ranked.reduce((s, r) => s + r.annual, 0);
  if (total > 0) {
    let cum = 0;
    for (const r of ranked) {
      cum += r.annual;
      const pct = cum / total;
      out.set(r.stockId, pct <= 0.8 ? "A" : pct <= 0.95 ? "B" : "C");
    }
  }
  for (const r of rows) {
    if (out.has(r.stockId)) continue;
    out.set(r.stockId, r.onHandFootage > 0 ? "C" : null);
  }
  return out;
}

// ---------- Schedule build / KPI ----------

export function buildSchedule(quarter: QuarterInfo, stocks: AbcStock[]): CycleCountSchedule {
  return {
    quarter: quarter.quarter,
    startDate: quarter.startDate,
    endDate: quarter.endDate,
    generatedAt: new Date().toISOString(),
    consolidated: quarter.consolidated,
    weekStarts: quarter.weekStarts,
    assignments: generateAssignments(stocks, quarter),
  };
}

export interface KpiStatus {
  status: "on_track" | "behind" | "not_started";
  expectedThroughLastCompletedWeek: number;
  completedThroughLastCompletedWeek: number;
  deficit: number;                  // expected - completed (clamped ≥ 0)
  totalExpectedThisQuarter: number;
  totalCompletedThisQuarter: number;
  currentWeek: number;              // 1-based; 0 if quarter not yet started
  totalWeeks: number;
}

/**
 * Compute on-track status for the given schedule + completion log.
 *
 * Rule: cumulative completed counts (across ALL prior weeks) must keep up
 * with cumulative expected counts. Missing one week pushes us behind, but
 * doing two weeks worth in the next week catches us back up — exactly the
 * "if they do 2 weeks in 1 then it's brought back to on track" semantics.
 *
 * The current (in-progress) week is excluded from the expected total so we
 * don't show "behind" while the team is mid-week.
 */
export function computeKpi(
  schedule: CycleCountSchedule,
  completions: Array<{ quarter: string; week: number }>,
  today: Date = new Date(),
): KpiStatus {
  const todayIso = isoFromUtc(today);
  const totalWeeks = schedule.weekStarts.length;

  // Find current week index (1-based). 0 = before quarter starts.
  let currentWeek = 0;
  for (let i = 0; i < totalWeeks; i++) {
    if (todayIso >= schedule.weekStarts[i]!) currentWeek = i + 1;
    else break;
  }
  const lastCompletedWeek = Math.max(0, currentWeek - 1);

  // Expected counts per week — number of stocks scheduled that week.
  const expectedByWeek = new Map<number, number>();
  for (const a of Object.values(schedule.assignments)) {
    for (const w of a.weeks) {
      expectedByWeek.set(w, (expectedByWeek.get(w) ?? 0) + 1);
    }
  }

  let expectedThrough = 0;
  let totalExpected = 0;
  for (let w = 1; w <= totalWeeks; w++) {
    const n = expectedByWeek.get(w) ?? 0;
    totalExpected += n;
    if (w <= lastCompletedWeek) expectedThrough += n;
  }

  const inQuarter = completions.filter((c) => c.quarter === schedule.quarter);
  const completedThrough = inQuarter.filter((c) => c.week <= lastCompletedWeek).length;
  const totalCompleted = inQuarter.length;

  let status: KpiStatus["status"];
  if (currentWeek === 0) status = "not_started";
  else if (completedThrough >= expectedThrough) status = "on_track";
  else status = "behind";

  return {
    status,
    expectedThroughLastCompletedWeek: expectedThrough,
    completedThroughLastCompletedWeek: completedThrough,
    deficit: Math.max(0, expectedThrough - completedThrough),
    totalExpectedThisQuarter: totalExpected,
    totalCompletedThisQuarter: totalCompleted,
    currentWeek,
    totalWeeks,
  };
}
