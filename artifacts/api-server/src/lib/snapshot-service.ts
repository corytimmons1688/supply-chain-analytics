import { runGatewaySql, pickNumber } from "./gateway";
import { fetchAdjustments } from "./adjustments";
import { saveSnapshot, type WeeklySnapshot, type SnapshotRoll } from "./snapshot-store";
import { logger } from "./logger";

/**
 * Returns the Monday->Sunday week (in Mountain Time) that contains the given UTC date.
 * Matches the dashboard's week bucketing in cc.bucketRange (Monday-start).
 *
 * Example: Tuesday 2026-04-21 → weekStart=Mon 2026-04-20, weekEnding=Sun 2026-04-26.
 */
export function mountainWeekContaining(now: Date): { weekStart: string; weekEnding: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  const y = Number(lookup["year"]);
  const m = Number(lookup["month"]);
  const d = Number(lookup["day"]);
  const wd = lookup["weekday"];
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[wd ?? ""] ?? 0;
  const offsetToMonday = (dow + 6) % 7; // 0 if Mon, 6 if Sun

  const baseUtc = new Date(Date.UTC(y, m - 1, d));
  const startUtc = new Date(baseUtc);
  startUtc.setUTCDate(baseUtc.getUTCDate() - offsetToMonday); // back to Monday
  const endUtc = new Date(startUtc);
  endUtc.setUTCDate(startUtc.getUTCDate() + 6); // forward to Sunday

  return { weekStart: fmtIso(startUtc), weekEnding: fmtIso(endUtc) };
}

function fmtIso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function fetchOnHand(): Promise<{ totalValue: number; rollCount: number }> {
  const sql =
    "SELECT IDNumber, CostOfRoll * 10 AS Tenths FROM rollstock WHERE DateRollUsed < {d '1900-01-01'}";
  const rows = await runGatewaySql(sql);
  let totalTenths = 0;
  for (const row of rows) totalTenths += pickNumber(row, "Tenths");
  return {
    totalValue: Math.round((totalTenths / 10) * 100) / 100,
    rollCount: rows.length,
  };
}

export async function captureSnapshot(now: Date = new Date()): Promise<WeeklySnapshot> {
  const { weekStart, weekEnding } = mountainWeekContaining(now);
  logger.info({ weekStart, weekEnding }, "Capturing weekly snapshot");

  const [onHand, adjustments] = await Promise.all([
    fetchOnHand(),
    fetchAdjustments({ from: weekStart, to: weekEnding }),
  ]);

  let added = 0;
  let removed = 0;
  const rolls: SnapshotRoll[] = [];
  for (const a of adjustments) {
    if (a.direction === "added") added += a.amount;
    else removed += a.amount;
    rolls.push({
      direction: a.direction,
      rollTag: a.rollTag,
      stockId: a.stockId,
      description: a.description,
      amount: Math.round(a.amount * 100) / 100,
      ccDate: a.ccDate,
      ccString: a.ccString,
    });
  }
  added = Math.round(added * 100) / 100;
  removed = Math.round(removed * 100) / 100;
  const netAdjustment = Math.round((added - removed) * 100) / 100;
  const adjustmentPct =
    onHand.totalValue > 0
      ? Math.round((netAdjustment / onHand.totalValue) * 10000) / 100
      : 0;

  const snap: WeeklySnapshot = {
    id: weekEnding,
    weekStart,
    weekEnding,
    capturedAt: new Date().toISOString(),
    onHandValue: onHand.totalValue,
    rollCount: onHand.rollCount,
    added,
    removed,
    netAdjustment,
    adjustmentPct,
    rolls: rolls.sort((a, b) => b.ccDate.localeCompare(a.ccDate)),
  };

  await saveSnapshot(snap);
  logger.info({ weekEnding, onHand: snap.onHandValue, net: snap.netAdjustment }, "Snapshot saved");
  return snap;
}
