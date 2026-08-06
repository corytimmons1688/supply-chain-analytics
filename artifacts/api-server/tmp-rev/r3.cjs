"use strict";

// ../../lib/integrations/hubspot-preorder/src/materials.ts
var LABEL_MATERIALS = [
  // --- laminates
  { ltStockId: 71, kind: "LABEL", role: "LAMINATE", tier: "PRIMARY", colour: "Soft Touch", description: "Soft Touch Laminate Wet Laminate" },
  { ltStockId: 160, kind: "LABEL", role: "LAMINATE", tier: "PRIMARY", colour: "Matte", description: "Matte Laminate \u2014 Thermal Transfer Compatible" },
  { ltStockId: 200, kind: "LABEL", role: "LAMINATE", tier: "PRIMARY", colour: "Clear", description: "Direct Thermal Clear Lamination", restricted: true },
  { ltStockId: 161, kind: "LABEL", role: "LAMINATE", tier: "PRIMARY", colour: "Gloss", description: "Gloss Laminate \u2014 Thermal Transfer Compatible" },
  { ltStockId: 266, kind: "LABEL", role: "LAMINATE", tier: "SPECIALITY", colour: "Clear", description: "WANA ONLY Soft Touch", restricted: true, notes: "Customer-locked to WANA" },
  { ltStockId: 65, kind: "LABEL", role: "LAMINATE", tier: "SPECIALITY", colour: "Clear", description: "ScuffProof \u2014 not thermal-transfer printable", restricted: true },
  { ltStockId: 241, kind: "LABEL", role: "LAMINATE", tier: "SPECIALITY", colour: "Clear", description: "Scuff Proof Thermal Transfer Printable", restricted: true },
  // --- substrates
  { ltStockId: 249, kind: "LABEL", role: "SUBSTRATE", tier: "PRIMARY", colour: "Holographic", description: "Holographic BOPP" },
  { ltStockId: 141, kind: "LABEL", role: "SUBSTRATE", tier: "PRIMARY", colour: "Clear", description: "Clear BOPP" },
  { ltStockId: 177, kind: "LABEL", role: "SUBSTRATE", tier: "PRIMARY", colour: "White", description: "White BOPP" },
  { ltStockId: 6, kind: "LABEL", role: "SUBSTRATE", tier: "PRIMARY", colour: "Silver", description: "Silver / Metallic BOPP" },
  { ltStockId: 209, kind: "LABEL", role: "SUBSTRATE", tier: "PRIMARY", colour: "White", description: "White Sqz BOPP w/ Paper Liner", restricted: true },
  { ltStockId: 72, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "White", description: "Direct Thermal White \u2014 Paper Liner", notes: "Used for Curaleaf" },
  { ltStockId: 73, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "White", description: "Thermal Transfer \u2014 Paper Liner" },
  { ltStockId: 94, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "White", description: "Beverage Labels BOPP \u2014 White", restricted: true },
  { ltStockId: 123, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "Silver", description: "Beverage Labels BOPP \u2014 Silver", restricted: true },
  { ltStockId: 129, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "White", description: "Piggyback Thermal Transfer White (paper substrate / paper liner)", restricted: true },
  { ltStockId: 130, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "White", description: "Epson Inkjet Approved White", restricted: true, notes: "Used for Acreage" },
  { ltStockId: 172, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "White", description: "Piggyback Direct Thermal White (paper substrate / paper liner)", restricted: true }
];
var FLEXPACK_MATERIALS = [
  { ltStockId: 199, kind: "FLEXPACK", role: "SUBSTRATE", tier: "PRIMARY", colour: "Clear", description: "Standard Clear PET", construction: "0.5 mil Clear PET / 3.0 mil LLDPE" },
  { ltStockId: 278, kind: "FLEXPACK", role: "SUBSTRATE", tier: "PRIMARY", colour: "Clear", description: "High-Barrier Clear PET", construction: "0.5 mil ALOX PET / 2.5 mil LLDPE" },
  { ltStockId: 288, kind: "FLEXPACK", role: "SUBSTRATE", tier: "PRIMARY", colour: "White", description: "White MetPet", construction: "White MetPet / 2.5 mil LLDPE", notes: "Standardised target for ALL white met pet" },
  { ltStockId: 307, kind: "FLEXPACK", role: "SUBSTRATE", tier: "PRIMARY", colour: "Silver", description: "Silver METPET", construction: "Silver MetPet / 2.5 mil LLDPE", notes: "Standardised target for ALL met pet" },
  { ltStockId: 193, kind: "FLEXPACK", role: "LAMINATE", tier: "PRIMARY", colour: "Gloss", description: "Gloss Thermal Laminate", construction: "1.2 mil PET Thermal Gloss Laminate" },
  { ltStockId: 286, kind: "FLEXPACK", role: "LAMINATE", tier: "PRIMARY", colour: "Matte", description: "Matte Thermal Lamination", construction: "0.8 mil PET Thermal Matte Lamination" },
  { ltStockId: 296, kind: "FLEXPACK", role: "LAMINATE", tier: "PRIMARY", colour: "Soft Touch", description: "Soft Touch" },
  { ltStockId: 174, kind: "FLEXPACK", role: "ZIPPER", tier: "PRIMARY", colour: "Clear", description: "CR Zipper (gen 1)" },
  { ltStockId: 176, kind: "FLEXPACK", role: "ZIPPER", tier: "PRIMARY", colour: "Clear", description: "Standard Non-CR Zipper" },
  { ltStockId: 303, kind: "FLEXPACK", role: "ZIPPER", tier: "PRIMARY", colour: "Clear", description: "Generation 2 CR Zipper" }
];
var ALL_MATERIALS = [...LABEL_MATERIALS, ...FLEXPACK_MATERIALS];
var MATERIAL_BY_ID = Object.fromEntries(
  // 278 appears twice on the source list (High-Barrier and "Calyx Cure Mate"); the
  // barrier construction is the one HubSpot's substrate enum can actually reach.
  ALL_MATERIALS.map((m) => [m.ltStockId, m])
);
var LABEL_SUBSTRATE_TO_STOCK = {
  "White BOPP": 177,
  "Silver / Metallic BOPP": 6,
  "Clear BOPP": 141,
  "Holographic BOPP": 249,
  "Thermal Transfer Paper": 73,
  "Direct Thermal Paper": 72
};
var LABEL_FINISH_TO_STOCK = {
  "Matte Laminate": 160,
  "Gloss Laminate": 161,
  "Soft Touch Laminate": 71,
  "Matte Varnish": null,
  "Gloss Varnish": null
};
var FLEX_SUBSTRATE_TO_STOCK = {
  "Flooded White Metalized PET (WMETPET)": 288,
  "Metalized PET (METPET)": 307,
  "High Barrier Clear PET": 278,
  "Standard Clear PET": 199
};
var FLEX_FINISH_TO_STOCK = {
  "Gloss Laminate": 193,
  "Matte Laminate": 286,
  "Soft Touch Laminate": 296
};
function isUnspecifiedOption(v) {
  return /^(other|custom)\b.*(specify|notes)/i.test((v ?? "").trim());
}
function resolveStocks(opts) {
  const unmapped = [];
  let substrateStockId = null;
  let laminateStockId = null;
  if (opts.kind === "LABEL") {
    const sub = opts.labelSubstrate?.trim();
    if (!sub) unmapped.push("label_substrate is blank");
    else if (LABEL_SUBSTRATE_TO_STOCK[sub] != null) substrateStockId = LABEL_SUBSTRATE_TO_STOCK[sub];
    else unmapped.push(`label_substrate "${sub}" has no LT stock`);
    const fin = opts.labelFinish?.trim();
    if (fin && fin in LABEL_FINISH_TO_STOCK) laminateStockId = LABEL_FINISH_TO_STOCK[fin] ?? null;
    else if (fin) unmapped.push(`label_finish "${fin}" has no LT stock`);
  } else {
    const sub = opts.flexSubstrate?.trim();
    if (!sub) unmapped.push("flexible_packaging_substrate is blank");
    else if (FLEX_SUBSTRATE_TO_STOCK[sub] != null) substrateStockId = FLEX_SUBSTRATE_TO_STOCK[sub];
    else unmapped.push(`flexible_packaging_substrate "${sub}" has no LT stock`);
    const fin = opts.flexFinish?.trim();
    if (fin && fin in FLEX_FINISH_TO_STOCK) laminateStockId = FLEX_FINISH_TO_STOCK[fin] ?? null;
    else if (fin) unmapped.push(`flexible_packaging_finish "${fin}" has no LT stock`);
  }
  return { substrateStockId, laminateStockId, unmapped };
}

// ../../lib/integrations/hubspot-preorder/src/spoilage.ts
var ABGA = {
  ltCode: "ABGA",
  label: "ABGA \u2014 label laminating",
  minPct: 2,
  maxPct: 100,
  brackets: [
    { lowFt: 0, highFt: 50, pct: 20 },
    { lowFt: 51, highFt: 101, pct: 6 },
    { lowFt: 101, highFt: 3e3, pct: 5 },
    { lowFt: 3001, highFt: 4e3, pct: 4 },
    { lowFt: 4001, highFt: 5e3, pct: 3 },
    { lowFt: 5001, highFt: 7500, pct: 3 },
    { lowFt: 7501, highFt: 1e4, pct: 3 },
    { lowFt: 10001, highFt: 12500, pct: 2.5 },
    { lowFt: 12501, highFt: 15e3, pct: 2.25 },
    { lowFt: 15001, highFt: 1e5, pct: 2.25 }
  ],
  provenance: "LT Press Speeds & Spoilage \xB7 ABGA \xB7 labels, laminating only"
};
var ABG3 = {
  ltCode: "ABG3",
  label: "ABG3 \u2014 label embellishment + laminating",
  minPct: 2,
  maxPct: 100,
  brackets: [
    { lowFt: 0, highFt: 100, pct: 100 },
    { lowFt: 101, highFt: 200, pct: 50 },
    { lowFt: 201, highFt: 1e3, pct: 8 },
    { lowFt: 1001, highFt: 2500, pct: 6 },
    { lowFt: 2501, highFt: 5e3, pct: 5 },
    { lowFt: 5001, highFt: 0, pct: 4 }
  ],
  provenance: "LT Press Speeds & Spoilage \xB7 ABG3 \xB7 embellished labels (spot UV, foil, peel-and-reveal)"
};
var THERMO = {
  ltCode: "Thermo",
  label: "Thermo \u2014 flexpack laminating",
  minPct: 2,
  maxPct: 100,
  brackets: [
    { lowFt: 0, highFt: 500, pct: 3 },
    { lowFt: 501, highFt: 2500, pct: 1 },
    { lowFt: 2501, highFt: 5e3, pct: 1 },
    { lowFt: 5001, highFt: 0, pct: 1 }
  ],
  provenance: "LT Press Speeds & Spoilage \xB7 Thermo (flexpack laminating)"
};
var NON_EMBELLISHED = /* @__PURE__ */ new Set(["", "none"]);
function hasEmbellishment(embellishment) {
  const v = (embellishment ?? "").trim().toLowerCase();
  return !NON_EMBELLISHED.has(v);
}
function mentionsPeelAndReveal(...notes) {
  const hay = notes.filter(Boolean).join(" ").toLowerCase();
  return /peel[\s-]*(and|&|n)?[\s-]*reveal|peel[\s-]*back/.test(hay);
}
function machineFor(opts) {
  if (opts.kind === "FLEXPACK") return THERMO;
  const embellished = hasEmbellishment(opts.embellishment) || mentionsPeelAndReveal(...opts.notes ?? []);
  return embellished ? ABG3 : ABGA;
}

// ../../lib/integrations/hubspot-preorder/src/equipment.ts
var NO_SETUP = { setupFt: 0, setupProvenance: "NOT_SOURCED" };
var LAMINATORS = {
  ABGA: { spoilage: ABGA, ...NO_SETUP },
  ABG3: { spoilage: ABG3, ...NO_SETUP },
  Thermo: { spoilage: THERMO, ...NO_SETUP }
};

// ../../lib/integrations/hubspot-preorder/src/index.ts
var HUBSPOT_BASE = "https://api.hubapi.com";
var PREORDER_OBJECT_TYPE = "2-52567425";
var ESTIMATING_PIPELINE_ID = "820783656";
var STAGE = {
  REQUEST_QUE: "1213197073",
  PENDING_INFORMATION: "1213197074",
  IN_PROGRESS: "1213427979",
  QUOTE_COMPLETED: "1213427980",
  QUOTE_ACCEPTED: "1213427981",
  QUOTE_REJECTED: "1213427982",
  NEW_PRODUCT_REQUEST: "1350989624",
  QUOTE_APPROVED_OLD: "1398242410"
};
var FORWARD_STAGES = [
  STAGE.IN_PROGRESS,
  STAGE.QUOTE_COMPLETED,
  STAGE.QUOTE_ACCEPTED,
  STAGE.QUOTE_REJECTED
];
var STAGE_LABEL = {
  [STAGE.IN_PROGRESS]: "In Progress",
  [STAGE.QUOTE_COMPLETED]: "Quote Completed",
  [STAGE.QUOTE_ACCEPTED]: "Quote Accepted",
  [STAGE.QUOTE_REJECTED]: "Quote Rejected"
};
var STAGE_OUTCOME = {
  [STAGE.IN_PROGRESS]: "OPEN",
  [STAGE.QUOTE_COMPLETED]: "OPEN",
  [STAGE.QUOTE_ACCEPTED]: "WON",
  [STAGE.QUOTE_REJECTED]: "LOST"
};
var STAGE_PROBABILITY = {
  [STAGE.IN_PROGRESS]: 0.3,
  [STAGE.QUOTE_COMPLETED]: 0.5,
  [STAGE.QUOTE_ACCEPTED]: 0.9,
  [STAGE.QUOTE_REJECTED]: 0
};
var PREORDER_PROPERTIES = [
  "hs_object_id",
  "hs_createdate",
  "hs_lastmodifieddate",
  "hs_pipeline",
  "hs_pipeline_stage",
  "custom_item_name",
  "estimate_id",
  "estimate_number",
  "due_date",
  "hubspot_owner_id",
  "location",
  "primary_vendor",
  "requested_quote_location",
  "quantity_needed",
  "projected_monthly_demand",
  "quantity_tiers_to_quote",
  "product_width",
  "product_height",
  "product_depth",
  "copy_position",
  "embellishment",
  "specialty_ink",
  "label_substrate",
  "label_finish",
  "label_application_method",
  "flexible_packaging_substrate",
  "flexible_packaging_finish",
  "flexible_packaging_style",
  "gusset_style",
  "zipper",
  "of_skus",
  "new_die_tool_needed",
  "die_tool",
  "additional_label_notes",
  "additional_flexpack_notes",
  "additional_estimating_notes"
];
var RETRYABLE = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var REQUEST_TIMEOUT_MS = 3e4;
async function hsRequest(cfg, method, path, body) {
  if (method === "POST" && !path.includes("/search")) {
    throw new Error(
      `Refusing non-search POST to ${path}. @workspace/hubspot-preorder is read-only.`
    );
  }
  if (!cfg.token) throw new Error("HUBSPOT_TOKEN is not configured");
  const doFetch = cfg.fetchImpl ?? fetch;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(`${HUBSPOT_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json"
        },
        body: body === void 0 ? void 0 : JSON.stringify(body),
        signal: ac.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (RETRYABLE.has(res.status) && attempt < 3) {
          const wait = res.status === 429 ? 2e3 * (attempt + 1) : 500 * 2 ** attempt;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw new Error(`HubSpot ${method} ${path} \u2192 ${res.status} ${text.slice(0, 300)}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt === 3) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error("HubSpot request failed");
}
async function fetchForwardPreorders(cfg, opts = {}) {
  const stages = opts.stages ?? FORWARD_STAGES;
  const filters = [
    { propertyName: "hs_pipeline", operator: "EQ", value: ESTIMATING_PIPELINE_ID },
    { propertyName: "hs_pipeline_stage", operator: "IN", values: [...stages] }
  ];
  if (opts.internalOnly !== false) {
    filters.push({ propertyName: "location", operator: "EQ", value: "Internal" });
  }
  const records = [];
  let after;
  let total = 0;
  for (let page = 0; page < 40; page++) {
    const body = {
      filterGroups: [{ filters }],
      properties: [...PREORDER_PROPERTIES],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      limit: 200
    };
    if (after) body["after"] = after;
    const res = await hsRequest(
      cfg,
      "POST",
      `/crm/v3/objects/${PREORDER_OBJECT_TYPE}/search`,
      body
    );
    total = res.total;
    records.push(...res.results ?? []);
    after = res.paging?.next?.after;
    if (!after) break;
  }
  return { total, records };
}
var num = (v) => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
var COPY_POSITION_BY_INDEX = [
  "OUT_TOP_1",
  "OUT_BTM_2",
  "OUT_RIGHT_3",
  "OUT_LEFT_4",
  "IN_TOP_5",
  "IN_BTM_6",
  "IN_RIGHT_7",
  "IN_LEFT_8"
];
var DEFAULT_COPY_POSITION = "OUT_BTM_2";
function ltCopyPosition(v) {
  if (!v) return null;
  const m = /^Copy\s*(\d)$/i.exec(v.trim());
  if (!m) return null;
  return COPY_POSITION_BY_INDEX[Number(m[1]) - 1] ?? null;
}
var CALYX_VENDOR = "Calyx Containers";
var RELEASE_SPAN_UNCLEAR = 1.5;
function vendorScope(primaryVendor) {
  const v = (primaryVendor ?? "").trim();
  if (v === "") {
    return { inScope: true, blocker: "primary_vendor is blank \u2014 cannot confirm Calyx makes this job" };
  }
  if (v.toLowerCase() !== CALYX_VENDOR.toLowerCase()) {
    return { inScope: false, blocker: null };
  }
  return { inScope: true, blocker: null };
}
var CLASS_TOKENS = "Labels?|Flexible Pack(?:ag)?ing|Flex Pack|Roll Stock|Boxe?s?|Rigid|Wavepack";
var CUSTOMER_RE = new RegExp(
  `^CQ-\\s*(?:\\d+\\s*-\\s*)?(.+?)\\s*-\\s*(?:${CLASS_TOKENS})\\b`,
  "i"
);
function customerFromItemName(itemName) {
  if (!itemName) return null;
  const m = CUSTOMER_RE.exec(itemName.trim());
  if (!m) return null;
  const name = (m[1] ?? "").replace(/[-\s]+$/, "").trim();
  if (!name || /^\d+$/.test(name)) return null;
  return name;
}
function kindOf(p) {
  if (p["flexible_packaging_substrate"]) return "FLEXPACK";
  if (p["label_substrate"]) return "LABEL";
  const n = (p["custom_item_name"] ?? "").toLowerCase();
  if (n.includes("flexible packaging")) return "FLEXPACK";
  if (n.includes("label")) return "LABEL";
  return null;
}
function normalizePreorder(raw) {
  const p = raw.properties ?? {};
  const kind = kindOf(p);
  if (!kind) return null;
  const vendor = vendorScope(p["primary_vendor"] ?? null);
  if (!vendor.inScope) return null;
  const blockers = [];
  if (vendor.blocker) blockers.push(vendor.blocker);
  const monthly = num(p["projected_monthly_demand"]);
  const qtyRaw = num(p["quantity_needed"]);
  const span = monthly != null && monthly > 0 && qtyRaw != null && qtyRaw > 0 ? qtyRaw / monthly : null;
  const qty = num(p["quantity_needed"]);
  if (qty == null || qty <= 0) blockers.push("quantity_needed is blank or zero");
  const widthIn = num(p["product_width"]);
  const heightIn = num(p["product_height"]);
  if (widthIn == null || heightIn == null) blockers.push("product_width / product_height missing");
  const substrateRaw = kind === "LABEL" ? p["label_substrate"] : p["flexible_packaging_substrate"];
  const finishRaw = kind === "LABEL" ? p["label_finish"] : p["flexible_packaging_finish"];
  if (isUnspecifiedOption(substrateRaw)) {
    blockers.push(`substrate is "${substrateRaw}" \u2014 needs a real material`);
  }
  const stocks = resolveStocks({
    kind,
    labelSubstrate: p["label_substrate"],
    labelFinish: p["label_finish"],
    flexSubstrate: p["flexible_packaging_substrate"],
    flexFinish: p["flexible_packaging_finish"]
  });
  blockers.push(...stocks.unmapped);
  const notes = [p["additional_label_notes"], p["additional_flexpack_notes"], p["additional_estimating_notes"]].filter(Boolean).join(" \xB7 ") || null;
  const cpRaw = p["copy_position"];
  const cp = ltCopyPosition(cpRaw);
  const copyPositionAssumed = kind === "LABEL" && cp == null;
  const machine = machineFor({
    kind,
    embellishment: p["embellishment"],
    notes: [notes, p["custom_item_name"]]
  });
  const stageId = p["hs_pipeline_stage"] ?? "";
  return {
    id: raw.id,
    itemName: p["custom_item_name"] ?? `(unnamed ${raw.id})`,
    estimateId: p["estimate_id"] ?? null,
    kind,
    stageId,
    stageLabel: STAGE_LABEL[stageId] ?? stageId,
    outcome: STAGE_OUTCOME[stageId] ?? "OPEN",
    probability: STAGE_PROBABILITY[stageId] ?? 0,
    location: p["location"] ?? null,
    primaryVendor: p["primary_vendor"] ?? null,
    customer: customerFromItemName(p["custom_item_name"]),
    projectedMonthlyDemand: monthly,
    releaseSpanMonths: span,
    qtyNeedsClarification: span != null && span >= RELEASE_SPAN_UNCLEAR,
    createdAt: p["hs_createdate"] ?? null,
    dueDate: p["due_date"] ?? null,
    qty,
    widthIn,
    heightIn,
    depthIn: num(p["product_depth"]),
    copyPositionRaw: cpRaw ?? null,
    copyPosition: cp ?? (kind === "LABEL" ? DEFAULT_COPY_POSITION : null),
    copyPositionAssumed,
    embellishment: p["embellishment"] ?? null,
    machineCode: machine.ltCode,
    substrateRaw: substrateRaw ?? null,
    finishRaw: finishRaw ?? null,
    substrateStockId: stocks.substrateStockId,
    laminateStockId: stocks.laminateStockId,
    blockers,
    notes
  };
}
async function loadForwardJobs(cfg) {
  const { total, records } = await fetchForwardPreorders(cfg, { internalOnly: true });
  const jobs = [];
  const review = [];
  let skipped = 0;
  for (const r of records) {
    const n = normalizePreorder(r);
    if (!n) {
      skipped++;
      continue;
    }
    (n.blockers.length === 0 ? jobs : review).push(n);
  }
  return { total, jobs, review, skippedOutOfScope: skipped };
}

// tmp-rev/r3.ts
async function portalId(token) {
  try {
    const res = await fetch("https://api.hubapi.com/account-info/v3/details", {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.portalId != null ? String(j.portalId) : null;
  } catch {
    return null;
  }
}
async function main() {
  const token = process.env["HUBSPOT_TOKEN"] ?? "";
  const pid = await portalId(token);
  const link = (id) => pid ? `https://app.hubspot.com/contacts/${pid}/record/2-52567425/${id}` : `(no portal id) record ${id}`;
  const res = await loadForwardJobs({ token });
  const rev = res.review.filter((j) => j.stageLabel !== "Quote Rejected");
  console.log(`portalId: ${pid ?? "UNRESOLVED \u2014 links will not work"}`);
  console.log(`live review records: ${rev.length}
`);
  const other = rev.filter((j) => (j.substrateRaw ?? "").toLowerCase().includes("other") || (j.substrateRaw ?? "").toLowerCase().includes("custom"));
  console.log(`
================ 1. substrate = "Other/Custom" (${other.length} records) ================`);
  for (const j of other) {
    console.log(`
[${j.id}] ${j.itemName}`);
    console.log(`  customer:        ${j.customer ?? "(not parsed)"}`);
    console.log(`  stage:           ${j.stageLabel}`);
    console.log(`  substrateRaw:    ${j.substrateRaw}`);
    console.log(`  qty:             ${j.qty ?? "(blank)"}`);
    console.log(`  monthlyDemand:   ${j.projectedMonthlyDemand ?? "(blank)"}`);
    console.log(`  notes:           ${j.notes ?? "(EMPTY)"}`);
    console.log(`  link:            ${link(j.id)}`);
  }
  const blankQty = rev.filter((j) => j.qty == null || j.qty <= 0);
  console.log(`

================ 2. quantity_needed blank or zero (${blankQty.length} records) ================`);
  for (const j of blankQty) {
    console.log(`
[${j.id}] ${j.itemName}`);
    console.log(`  customer:        ${j.customer ?? "(not parsed)"}`);
    console.log(`  stage:           ${j.stageLabel}`);
    console.log(`  monthlyDemand:   ${j.projectedMonthlyDemand ?? "(blank)"}`);
    console.log(`  notes:           ${j.notes ?? "(EMPTY)"}`);
    console.log(`  link:            ${link(j.id)}`);
  }
  const unmapped = rev.filter((j) => j.blockers.some((b) => b.includes("has no LT stock")));
  const byValue = /* @__PURE__ */ new Map();
  for (const j of unmapped) {
    for (const b of j.blockers.filter((x) => x.includes("has no LT stock"))) {
      const e = byValue.get(b) ?? { blocker: b, examples: [] };
      e.examples.push(j);
      byValue.set(b, e);
    }
  }
  console.log(`

================ 3. real substrate/finish string, but no LT stock mapping (${unmapped.length} records, ${byValue.size} distinct values) ================`);
  for (const [b, e] of [...byValue].sort((a, z) => z[1].examples.length - a[1].examples.length)) {
    console.log(`
${b}  \u2014  ${e.examples.length} record(s)`);
    for (const j of e.examples.slice(0, 3)) {
      console.log(`    [${j.id}] ${j.itemName}  (${j.customer ?? "no customer parsed"})`);
      console.log(`       notes: ${j.notes ?? "(EMPTY)"}`);
      console.log(`       link:  ${link(j.id)}`);
    }
    if (e.examples.length > 3) console.log(`    ...and ${e.examples.length - 3} more with this exact value`);
  }
  const blankVendor = rev.filter((j) => j.blockers.some((b) => b.includes("primary_vendor is blank")));
  console.log(`

================ 4. primary_vendor blank (${blankVendor.length} records) ================`);
  for (const j of blankVendor) {
    console.log(`
[${j.id}] ${j.itemName}`);
    console.log(`  customer:        ${j.customer ?? "(not parsed)"}`);
    console.log(`  stage:           ${j.stageLabel}`);
    console.log(`  notes:           ${j.notes ?? "(EMPTY)"}`);
    console.log(`  link:            ${link(j.id)}`);
  }
  const blankSubstrate = rev.filter((j) => j.blockers.some((b) => b.includes("substrate is blank")));
  console.log(`

================ 5. substrate field blank entirely (${blankSubstrate.length} records) ================`);
  for (const j of blankSubstrate) {
    console.log(`
[${j.id}] ${j.itemName}`);
    console.log(`  customer:        ${j.customer ?? "(not parsed)"}`);
    console.log(`  stage:           ${j.stageLabel}`);
    console.log(`  notes:           ${j.notes ?? "(EMPTY)"}`);
    console.log(`  link:            ${link(j.id)}`);
  }
  process.exit(0);
}
void main();
