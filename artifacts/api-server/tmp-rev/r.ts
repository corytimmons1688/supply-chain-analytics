import { loadForwardJobs, hubspotConfigured } from "@workspace/hubspot-preorder";
async function main() {
  const token = process.env["HUBSPOT_TOKEN"] ?? "";
  if (!hubspotConfigured(token)) { console.error("no token"); process.exit(1); }
  const res = await loadForwardJobs({ token } as never);
  console.log(`forecastable: ${res.jobs.length}   REVIEW: ${res.review.length}   skipped out of scope: ${res.skippedOutOfScope}`);
  const counts = new Map<string, number>();
  for (const j of res.review) for (const b of j.blockers) {
    const key = b.replace(/"[^"]*"/g, '"…"').replace(/\d+/g, "N");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log("\n=== why each record is in review (a record can have several) ===");
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
  const byCount = new Map<number, number>();
  for (const j of res.review) byCount.set(j.blockers.length, (byCount.get(j.blockers.length) ?? 0) + 1);
  console.log("\n=== blockers per record ===");
  for (const [k, n] of [...byCount].sort()) console.log(`  ${n} record(s) with ${k} blocker(s)`);
  console.log("\n=== sample: 8 records ===");
  for (const j of res.review.slice(0, 8)) {
    console.log(`  [${j.stageLabel}] ${j.itemName.slice(0, 46)}`);
    console.log(`     qty=${j.qty ?? "—"} ${j.widthIn ?? "?"}x${j.heightIn ?? "?"} sub=${(j.substrateRaw ?? "—").slice(0,26)}`);
    console.log(`     → ${j.blockers.join(" | ")}`);
  }
  process.exit(0);
}
void main();
