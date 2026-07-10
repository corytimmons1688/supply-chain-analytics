import { gcsClient, getBucketAndPrefix } from "./gcs-client";
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

const SUBDIR = "monthly-snapshots";

function objectName(monthKey: string): string {
  const { prefix } = getBucketAndPrefix();
  return [prefix, SUBDIR, `${monthKey}.json`].filter(Boolean).join("/");
}

function listPrefix(): string {
  const { prefix } = getBucketAndPrefix();
  return [prefix, SUBDIR].filter(Boolean).join("/") + "/";
}

function bucket() {
  const { bucketName } = getBucketAndPrefix();
  return gcsClient.bucket(bucketName);
}

export async function saveMonthlySnapshot(snap: MonthlySnapshot): Promise<void> {
  const file = bucket().file(objectName(snap.monthKey));
  await file.save(JSON.stringify(snap, null, 2), {
    contentType: "application/json",
    resumable: false,
  });
}

export async function listMonthlySnapshots(): Promise<MonthlySnapshot[]> {
  const [files] = await bucket().getFiles({ prefix: listPrefix() });
  const out: MonthlySnapshot[] = [];
  for (const f of files) {
    if (!f.name.endsWith(".json")) continue;
    try {
      const [buf] = await f.download();
      out.push(JSON.parse(buf.toString("utf8")) as MonthlySnapshot);
    } catch {
      // skip malformed
    }
  }
  return out.sort((a, b) => b.monthKey.localeCompare(a.monthKey));
}

export async function getMonthlySnapshot(monthKey: string): Promise<MonthlySnapshot | null> {
  const file = bucket().file(objectName(monthKey));
  try {
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return JSON.parse(buf.toString("utf8")) as MonthlySnapshot;
  } catch {
    return null;
  }
}
