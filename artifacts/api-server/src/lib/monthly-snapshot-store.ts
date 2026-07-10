import { db, snapshotBlobTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import type { SnapshotRoll } from "./snapshot-store";

export interface MonthlySnapshot {
  id: string;
  monthKey: string;
  monthStart: string;
  monthEnd: string;
  capturedAt: string;
  onHandValue: number;
  rollCount: number;
  added: number;
  removed: number;
  netAdjustment: number;
  adjustmentPct: number;
  rolls: SnapshotRoll[];
}

const KIND = "monthly";

export async function saveMonthlySnapshot(snap: MonthlySnapshot): Promise<void> {
  await db
    .insert(snapshotBlobTable)
    .values({ kind: KIND, key: snap.monthKey, data: snap })
    .onConflictDoUpdate({
      target: [snapshotBlobTable.kind, snapshotBlobTable.key],
      set: { data: snap, updatedAt: new Date() },
    });
}

export async function listMonthlySnapshots(): Promise<MonthlySnapshot[]> {
  const rows = await db
    .select()
    .from(snapshotBlobTable)
    .where(eq(snapshotBlobTable.kind, KIND))
    .orderBy(desc(snapshotBlobTable.key));
  return rows.map((r) => r.data as MonthlySnapshot);
}

export async function getMonthlySnapshot(monthKey: string): Promise<MonthlySnapshot | null> {
  const rows = await db
    .select()
    .from(snapshotBlobTable)
    .where(and(eq(snapshotBlobTable.kind, KIND), eq(snapshotBlobTable.key, monthKey)))
    .limit(1);
  return rows.length > 0 ? (rows[0]!.data as MonthlySnapshot) : null;
}
