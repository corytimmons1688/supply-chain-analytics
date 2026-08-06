import { loadForwardJobs, hubspotConfigured } from "@workspace/hubspot-preorder";
async function main() {
  const token = process.env["HUBSPOT_TOKEN"] ?? "";
  const res = await loadForwardJobs({ token } as never);
  const rev = res.review;
  const byStage = new Map<string, { n: number; qty: number }>();
  for (const j of rev) {
    const e = byStage.get(j.stageLabel) ?? { n: 0, qty: 0 };
    e.n++; e.qty += j.qty ?? 0;
    byStage.set(j.stageLabel, e);
  }
  console.log("=== review queue by stage ===");
  for (const [k, v] of [...byStage].sort((a, b) => b[1].qty - a[1].qty))
    console.log(`  ${k.padEnd(18)} ${String(v.n).padStart(3)} records   ${v.qty.toLocaleString().padStart(12)} units`);
  const live = rev.filter((j) => j.stageLabel !== "Quote Rejected");
  console.log(`\n  LIVE (not rejected): ${live.length} records, ${live.reduce((a, j) => a + (j.qty ?? 0), 0).toLocaleString()} units`);

  console.log("\n=== do the notes actually contain the answer? ===");
  const other = rev.filter((j) => (j.substrateRaw ?? "").toLowerCase().includes("other") || (j.substrateRaw ?? "").toLowerCase().includes("custom"));
  const withNotes = other.filter((j) => (j.notes ?? "").trim().length > 0);
  console.log(`  records blocked on "Other/Custom": ${other.length}`);
  console.log(`  of those, notes are non-empty:     ${withNotes.length}`);
  for (const j of withNotes.slice(0, 6)) {
    console.log(`    ${j.itemName.slice(0, 40)}`);
    console.log(`       notes: ${(j.notes ?? "").slice(0, 130)}`);
  }
  const noNotes = other.filter((j) => !(j.notes ?? "").trim());
  console.log(`\n  blocked on "Other" with NO notes at all: ${noNotes.length}`);
  for (const j of noNotes.slice(0, 4)) console.log(`    ${j.itemName.slice(0, 56)}`);
  process.exit(0);
}
void main();
