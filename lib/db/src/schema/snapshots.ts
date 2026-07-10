import { pgTable, text, jsonb, timestamp, primaryKey } from "drizzle-orm/pg-core";

// Point-in-time inventory snapshots, one JSON blob per period. Replaces the
// Replit object-storage bucket (unavailable off-platform) — the blob shape is
// unchanged (WeeklySnapshot / MonthlySnapshot from the api-server stores).
export const snapshotBlobTable = pgTable(
  "snapshot_blob",
  {
    kind: text("kind").notNull(), // "weekly" | "monthly"
    key: text("key").notNull(), // weekEnding YYYY-MM-DD | monthKey YYYY-MM
    data: jsonb("data").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.kind, t.key] }),
  }),
);

export type SnapshotBlobRow = typeof snapshotBlobTable.$inferSelect;
