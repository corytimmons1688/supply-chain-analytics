import { fetchAdjustments, fetchOnHandValue } from "./adjustments";
import {
  saveMonthlySnapshot,
  type MonthlySnapshot,
} from "./monthly-snapshot-store";
import type { SnapshotRoll } from "./snapshot-store";
import { logger } from "./logger";

/**
 * Returns the calendar month (in Mountain Time) that contains the given UTC date.
 * Example: 2026-04-15 → monthKey "2026-04", monthStart "2026-04-01", monthEnd "2026-04-30".
 */
export function mountainMonthContaining(now: Date): {
  monthKey: string;
  monthStart: string;
  monthEnd: string;
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  const y = Number(lookup["year"]);
  const m = Number(lookup["month"]);
  const startUtc = new Date(Date.UTC(y, m - 1, 1));
  const endUtc = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this month
  return {
    monthKey: `${y}-${String(m).padStart(2, "0")}`,
    monthStart: fmtIso(startUtc),
    monthEnd: fmtIso(endUtc),
  };
}

function fmtIso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}



export async function captureMonthlySnapshot(
  now: Date = new Date(),
): Promise<MonthlySnapshot> {
  const { monthKey, monthStart, monthEnd } = mountainMonthContaining(now);
  logger.info({ monthKey, monthStart, monthEnd }, "Capturing monthly snapshot");

  const [onHand, adjustments] = await Promise.all([
    fetchOnHandValue(),
    fetchAdjustments({ from: monthStart, to: monthEnd }),
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

  const snap: MonthlySnapshot = {
    id: monthKey,
    monthKey,
    monthStart,
    monthEnd,
    capturedAt: new Date().toISOString(),
    onHandValue: onHand.totalValue,
    rollCount: onHand.rollCount,
    added,
    removed,
    netAdjustment,
    adjustmentPct,
    rolls: rolls.sort((a, b) => b.ccDate.localeCompare(a.ccDate)),
  };

  await saveMonthlySnapshot(snap);
  logger.info(
    { monthKey, onHand: snap.onHandValue, net: snap.netAdjustment },
    "Monthly snapshot saved",
  );
  return snap;
}
