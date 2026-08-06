import { loadForwardJobs } from "@workspace/hubspot-preorder";

async function portalId(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.hubapi.com/account-info/v3/details", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { portalId?: number };
    return j.portalId != null ? String(j.portalId) : null;
  } catch {
    return null;
  }
}

async function main() {
  const token = process.env["HUBSPOT_TOKEN"] ?? "";
  const pid = await portalId(token);
  const link = (id: string) =>
    pid ? `https://app.hubspot.com/contacts/${pid}/record/2-52567425/${id}` : `(no portal id) record ${id}`;

  const res = await loadForwardJobs({ token } as never);
  const rev = res.review.filter((j) => j.stageLabel !== "Quote Rejected");

  console.log(`portalId: ${pid ?? "UNRESOLVED — links will not work"}`);
  console.log(`live review records: ${rev.length}\n`);

  // ---- group 1: substrate is Other/Custom -------------------------------
  const other = rev.filter((j) => (j.substrateRaw ?? "").toLowerCase().includes("other") || (j.substrateRaw ?? "").toLowerCase().includes("custom"));
  console.log(`\n================ 1. substrate = "Other/Custom" (${other.length} records) ================`);
  for (const j of other) {
    console.log(`\n[${j.id}] ${j.itemName}`);
    console.log(`  customer:        ${j.customer ?? "(not parsed)"}`);
    console.log(`  stage:           ${j.stageLabel}`);
    console.log(`  substrateRaw:    ${j.substrateRaw}`);
    console.log(`  qty:             ${j.qty ?? "(blank)"}`);
    console.log(`  monthlyDemand:   ${j.projectedMonthlyDemand ?? "(blank)"}`);
    console.log(`  notes:           ${j.notes ?? "(EMPTY)"}`);
    console.log(`  link:            ${link(j.id)}`);
  }

  // ---- group 2: quantity_needed blank/zero -------------------------------
  const blankQty = rev.filter((j) => j.qty == null || j.qty <= 0);
  console.log(`\n\n================ 2. quantity_needed blank or zero (${blankQty.length} records) ================`);
  for (const j of blankQty) {
    console.log(`\n[${j.id}] ${j.itemName}`);
    console.log(`  customer:        ${j.customer ?? "(not parsed)"}`);
    console.log(`  stage:           ${j.stageLabel}`);
    console.log(`  monthlyDemand:   ${j.projectedMonthlyDemand ?? "(blank)"}`);
    console.log(`  notes:           ${j.notes ?? "(EMPTY)"}`);
    console.log(`  link:            ${link(j.id)}`);
  }

  // ---- group 3: no LT stock mapping (substrate/finish string is real, just unmapped) ----
  const unmapped = rev.filter((j) => j.blockers.some((b) => b.includes("has no LT stock")));
  const byValue = new Map<string, { blocker: string; examples: typeof rev }>();
  for (const j of unmapped) {
    for (const b of j.blockers.filter((x) => x.includes("has no LT stock"))) {
      const e = byValue.get(b) ?? { blocker: b, examples: [] };
      e.examples.push(j);
      byValue.set(b, e);
    }
  }
  console.log(`\n\n================ 3. real substrate/finish string, but no LT stock mapping (${unmapped.length} records, ${byValue.size} distinct values) ================`);
  for (const [b, e] of [...byValue].sort((a, z) => z[1].examples.length - a[1].examples.length)) {
    console.log(`\n${b}  —  ${e.examples.length} record(s)`);
    for (const j of e.examples.slice(0, 3)) {
      console.log(`    [${j.id}] ${j.itemName}  (${j.customer ?? "no customer parsed"})`);
      console.log(`       notes: ${j.notes ?? "(EMPTY)"}`);
      console.log(`       link:  ${link(j.id)}`);
    }
    if (e.examples.length > 3) console.log(`    ...and ${e.examples.length - 3} more with this exact value`);
  }

  // ---- group 4: blank vendor ---------------------------------------------
  const blankVendor = rev.filter((j) => j.blockers.some((b) => b.includes("primary_vendor is blank")));
  console.log(`\n\n================ 4. primary_vendor blank (${blankVendor.length} records) ================`);
  for (const j of blankVendor) {
    console.log(`\n[${j.id}] ${j.itemName}`);
    console.log(`  customer:        ${j.customer ?? "(not parsed)"}`);
    console.log(`  stage:           ${j.stageLabel}`);
    console.log(`  notes:           ${j.notes ?? "(EMPTY)"}`);
    console.log(`  link:            ${link(j.id)}`);
  }

  // ---- group 5: substrate blank entirely ---------------------------------
  const blankSubstrate = rev.filter((j) => j.blockers.some((b) => b.includes("substrate is blank")));
  console.log(`\n\n================ 5. substrate field blank entirely (${blankSubstrate.length} records) ================`);
  for (const j of blankSubstrate) {
    console.log(`\n[${j.id}] ${j.itemName}`);
    console.log(`  customer:        ${j.customer ?? "(not parsed)"}`);
    console.log(`  stage:           ${j.stageLabel}`);
    console.log(`  notes:           ${j.notes ?? "(EMPTY)"}`);
    console.log(`  link:            ${link(j.id)}`);
  }

  process.exit(0);
}
void main();
