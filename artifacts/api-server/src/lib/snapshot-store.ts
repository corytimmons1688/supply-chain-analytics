import { gcsClient, getBucketAndPrefix } from "./gcs-client";

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

const SUBDIR = "snapshots";

function objectName(weekEnding: string): string {
  const { prefix } = getBucketAndPrefix();
  const parts = [prefix, SUBDIR, `${weekEnding}.json`].filter(Boolean);
  return parts.join("/");
}

function listPrefix(): string {
  const { prefix } = getBucketAndPrefix();
  return [prefix, SUBDIR].filter(Boolean).join("/") + "/";
}

function bucket() {
  const { bucketName } = getBucketAndPrefix();
  return gcsClient.bucket(bucketName);
}

export async function saveSnapshot(snap: WeeklySnapshot): Promise<void> {
  const file = bucket().file(objectName(snap.weekEnding));
  await file.save(JSON.stringify(snap, null, 2), {
    contentType: "application/json",
    resumable: false,
  });
}

export async function listSnapshots(): Promise<WeeklySnapshot[]> {
  const [files] = await bucket().getFiles({ prefix: listPrefix() });
  const out: WeeklySnapshot[] = [];
  for (const f of files) {
    if (!f.name.endsWith(".json")) continue;
    try {
      const [buf] = await f.download();
      out.push(JSON.parse(buf.toString("utf8")) as WeeklySnapshot);
    } catch {
      // skip malformed
    }
  }
  return out.sort((a, b) => b.weekEnding.localeCompare(a.weekEnding));
}

export async function getSnapshot(weekEnding: string): Promise<WeeklySnapshot | null> {
  const file = bucket().file(objectName(weekEnding));
  try {
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return JSON.parse(buf.toString("utf8")) as WeeklySnapshot;
  } catch {
    return null;
  }
}
