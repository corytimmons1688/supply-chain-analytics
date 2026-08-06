import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * An idle Neon connection dropping emits `error` on the pool, and an unhandled
 * `error` event takes the whole process down. Serverless hides this — each
 * request is a fresh invocation — but a long-lived server dies on the first
 * network blip. Observed twice on 2026-08-06: `read EADDRNOTAVAIL` and
 * `read ETIMEDOUT`, both after successfully serving requests seconds earlier.
 *
 * Logging and continuing is correct here: `pg` discards the broken client and
 * the next checkout opens a new one, so the pool self-heals. Swallowing it is
 * safe because a query in flight still rejects on its own promise — this only
 * catches errors on connections nobody is waiting on.
 */
pool.on("error", (err) => {
  console.error(
    `[db] idle client error (pool recovers, process stays up): ${err.message}`,
  );
});

export const db = drizzle(pool, { schema });

export * from "./schema";
