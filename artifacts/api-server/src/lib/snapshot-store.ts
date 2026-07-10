import { db, snapshotBlobTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

export interface SnapshotRoll {
  direction: "added" | "removed";
  rollTag: string;
  stockId: string;
  description: string | null;
  amount: number;
  ccDate: string;
  ccString: string;
}

export interface WeeklySnapshot {
  id: string;
  weekStart: string;
  weekEnding: string;
  capturedAt: string;
  onHandValue: number;
  rollCount: number;
  added: number;
  removed: number;
  netAdjustment: number;
  adjustmentPct: number;
  rolls: SnapshotRoll[];
}

const KIND = "weekly";

export async function saveSnapshot(snap: WeeklySnapshot): Promise<void> {
  await db
    .insert(snapshotBlobTable)
    .values({ kind: KIND, key: snap.weekEnding, data: snap })
    .onConflictDoUpdate({
      target: [snapshotBlobTable.kind, snapshotBlobTable.key],
      set: { data: snap, updatedAt: new Date() },
    });
}

export async function listSnapshots(): Promise<WeeklySnapshot[]> {
  const rows = await db
    .select()
    .from(snapshotBlobTable)
    .where(eq(snapshotBlobTable.kind, KIND))
    .orderBy(desc(snapshotBlobTable.key));
  return rows.map((r) => r.data as WeeklySnapshot);
}

export async function getSnapshot(weekEnding: string): Promise<WeeklySnapshot | null> {
  const rows = await db
    .select()
    .from(snapshotBlobTable)
    .where(and(eq(snapshotBlobTable.kind, KIND), eq(snapshotBlobTable.key, weekEnding)))
    .limit(1);
  return rows.length > 0 ? (rows[0]!.data as WeeklySnapshot) : null;
}
