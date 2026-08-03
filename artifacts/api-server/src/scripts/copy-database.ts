import { Pool } from "pg";

/**
 * Copy every table from one Postgres database into another.
 *
 * Written for moving this app's database into its own Neon project, and kept
 * because the same operation creates a development branch — a dev database that
 * isn't production is the single biggest thing standing between a new engineer
 * and an accident.
 *
 * Deliberately schema-agnostic: tables and columns are discovered from the
 * SOURCE at runtime rather than from the Drizzle definitions, so it copies what
 * is actually there. If the database ever drifts from the code, this still moves
 * the drift instead of silently dropping it.
 *
 * Usage (target schema must already exist — create it with `pnpm run push-force`
 * in lib/db against the target, so the new database matches the code):
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… node copy-database.js --dry-run
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… node copy-database.js
 *
 * Flags:
 *   --dry-run   report row counts on both sides and exit, changing nothing
 *   --truncate  empty each target table first; required to re-run after a
 *               partial copy, because otherwise rows would be duplicated
 */

const BATCH = 500;

/** Neon's pooler is pgbouncer in transaction mode; bulk work wants the direct endpoint. */
function directEndpoint(url: string): string {
  return url.replace("-pooler.", ".");
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}

async function tableNames(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  return r.rows.map((x) => x.tablename);
}

async function columnNames(pool: Pool, table: string): Promise<string[]> {
  const r = await pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1
        and is_generated = 'NEVER'
      order by ordinal_position`,
    [table],
  );
  return r.rows.map((x) => x.column_name);
}

async function count(pool: Pool, table: string): Promise<number> {
  const r = await pool.query<{ c: string }>(`select count(*)::text as c from public."${table}"`);
  return Number(r.rows[0]?.c ?? 0);
}

async function main() {
  const sourceUrl = process.env["SOURCE_DATABASE_URL"];
  const targetUrl = process.env["TARGET_DATABASE_URL"];
  const dryRun = process.argv.includes("--dry-run");
  const truncate = process.argv.includes("--truncate");

  if (!sourceUrl || !targetUrl) throw new Error("SOURCE_DATABASE_URL and TARGET_DATABASE_URL are both required");
  if (directEndpoint(sourceUrl) === directEndpoint(targetUrl)) {
    // Copying a database onto itself with --truncate would delete everything.
    throw new Error("Source and target are the same database — refusing to run");
  }

  const source = new Pool({ connectionString: directEndpoint(sourceUrl), max: 4 });
  const target = new Pool({ connectionString: directEndpoint(targetUrl), max: 4 });
  console.log(`source: ${redact(sourceUrl)}`);
  console.log(`target: ${redact(targetUrl)}`);

  const tables = await tableNames(source);
  const targetTables = new Set(await tableNames(target));
  console.log(`\n${tables.length} tables in source, ${targetTables.size} in target\n`);

  const missing = tables.filter((t) => !targetTables.has(t));
  if (missing.length > 0) {
    throw new Error(
      `Target is missing ${missing.length} table(s): ${missing.join(", ")}. ` +
        `Create the schema first (lib/db: DATABASE_URL=<target> pnpm run push-force).`,
    );
  }

  // Report first. A migration you can't verify isn't one you should run.
  const before: { table: string; src: number; tgt: number }[] = [];
  for (const t of tables) before.push({ table: t, src: await count(source, t), tgt: await count(target, t) });
  for (const b of before) {
    console.log(`  ${b.table.padEnd(30)} source ${String(b.src).padStart(7)}  target ${String(b.tgt).padStart(7)}`);
  }
  const srcTotal = before.reduce((s, b) => s + b.src, 0);
  console.log(`\nsource total rows: ${srcTotal}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    await Promise.all([source.end(), target.end()]);
    return;
  }

  const nonEmpty = before.filter((b) => b.tgt > 0);
  if (nonEmpty.length > 0 && !truncate) {
    throw new Error(
      `Target already holds rows in ${nonEmpty.length} table(s) (${nonEmpty
        .map((b) => b.table)
        .slice(0, 5)
        .join(", ")}…). Re-run with --truncate to replace them, or point at an empty database. ` +
        `Refusing to insert on top, which would duplicate rows.`,
    );
  }

  let copied = 0;
  for (const t of tables) {
    const cols = await columnNames(source, t);
    if (cols.length === 0) continue;
    if (truncate) await target.query(`truncate table public."${t}"`);

    const quoted = cols.map((c) => `"${c}"`).join(", ");
    const res = await source.query(`select ${quoted} from public."${t}"`);
    if (res.rows.length === 0) {
      console.log(`  ${t.padEnd(30)} 0`);
      continue;
    }
    for (let i = 0; i < res.rows.length; i += BATCH) {
      const chunk = res.rows.slice(i, i + BATCH);
      const params: unknown[] = [];
      const tuples = chunk.map((row) => {
        const ph = cols.map((c) => {
          params.push((row as Record<string, unknown>)[c]);
          return `$${params.length}`;
        });
        return `(${ph.join(", ")})`;
      });
      await target.query(`insert into public."${t}" (${quoted}) values ${tuples.join(", ")}`, params);
    }
    copied += res.rows.length;
    console.log(`  ${t.padEnd(30)} ${String(res.rows.length).padStart(7)} copied`);
  }

  // Verify. Every table has to match, not just the total.
  console.log("\nverifying…");
  const mismatches: string[] = [];
  let tgtTotal = 0;
  for (const t of tables) {
    const [s, g] = [await count(source, t), await count(target, t)];
    tgtTotal += g;
    if (s !== g) mismatches.push(`${t}: source ${s} vs target ${g}`);
  }
  console.log(`copied ${copied} rows · source total ${srcTotal} · target total ${tgtTotal}`);
  if (mismatches.length > 0) {
    throw new Error(`ROW COUNT MISMATCH — do not cut over:\n  ${mismatches.join("\n  ")}`);
  }
  console.log("every table matches. Safe to point DATABASE_URL at the target.");
  await Promise.all([source.end(), target.end()]);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
