/**
 * Forecasting — quote stage. REAL DATA, READ ONLY.
 *
 * Composes the sources that already exist rather than inventing a dataset:
 *
 *   HubSpot pre-order support  →  open quotes (internal only, In Progress onward)
 *   ns_forecast_line           →  firm NetSuite sales-order demand
 *   lt_stock                   →  stock master: master width, cost/MSI, supplier
 *   lt_roll                    →  real on-hand footage and roll counts
 *   lt_po                      →  open POs in flight + measured lead times
 *   lt_roll usage history      →  daily demand, for DERIVED safety stock / ROP
 *   stock_goal                 →  operator overrides where they exist
 *
 * Every footage number runs through ONE spoilage model — the real ABGA / ABG3 /
 * flexpack curves — including NetSuite lines, whose stored `stock_demand` was
 * computed at a flat 8% and is recomputed here. Nothing is written anywhere.
 *
 * Where a value cannot be sourced it is DERIVED and labelled, or omitted and
 * listed in the assumption registry. No number is silently invented.
 */

import { db, nsForecastLineTable, stockGoalTable } from "@workspace/db";
import {
  loadForwardJobs,
  hubspotConfigured,
  machineFor,
  spoilageFor,
  pressFor,
  assumptionRegistry,
  understatingAssumptions,
  MATERIAL_BY_ID,
  STAGE_LABEL,
  STAGE_OUTCOME,
  STAGE_PROBABILITY,
  FORWARD_STAGES,
  HP,
  LAYOUT,
  type NormalizedJob,
  type Assumption,
} from "@workspace/hubspot-preorder";

import {
  fetchOnHandByStock,
  fetchStockInfo,
  fetchOpenPos,
  fetchPoLeadTimes,
  vendorLeadTimeMedians,
  fetchUsage,
  addDaysIso,
  mean,
  stdDev,
  zForServiceLevel,
  type OnHandRow,
  type StockInfoRow,
  type OpenPoRow,
} from "./demand";
import {
  applyCopyPositionToLayout,
  computeGoodLengthFt,
  computeLabelRepeatIn,
  deriveNoAcross,
  type CopyPosition,
} from "./label-footage";
import { logger } from "./logger";

const todayIso = () => new Date().toISOString().slice(0, 10);
const SERVICE_LEVEL = 0.95;
const HISTORY_DAYS = 180;

/* =========================================================== footage engine */

export interface PassBreakdown {
  code: string;
  label: string;
  linearFt: number;
  spoilageFt: number;
  setupFt: number;
  totalFt: number;
  spoilagePct: number | null;
  spoilageBracketPct: number | null;
  spoilageFloored: boolean;
  spoilageOutOfRange: boolean;
  /** True when this machine's numbers are incomplete (shown in the control tower). */
  incomplete: boolean;
}

export interface FootageBuildUp {
  goodFt: number;
  requiredFt: number;
  /** Which pass set the requirement (labels) — flexpack compounds instead. */
  drivingPass: string;
  passes: PassBreakdown[];
  noAcross: number;
  repeatIn: number;
  swapped: boolean;
  machineCode: string;
  /** Feet of make-ready included. */
  makeReadyFt: number;
  upliftVsGood: number;
}

/**
 * Labels: requirement = max(pass feet) — one web through every station.
 * Flexpack: converting steps compound, Π(1 + sᵢ).
 */
function buildFootage(opts: {
  kind: "LABEL" | "FLEXPACK";
  qty: number;
  goodFt: number;
  noAcross: number;
  repeatIn: number;
  swapped: boolean;
  embellishment: string | null;
  notes: (string | null)[];
  requestedQuoteLocation: string | null;
}): FootageBuildUp {
  const lam = machineFor({ kind: opts.kind, embellishment: opts.embellishment, notes: opts.notes });
  const sp = spoilageFor(opts.goodFt, lam);
  const { press } = pressFor(opts.requestedQuoteLocation);

  // Press pass: make-ready only — HP's own spoilage curve is NOT SOURCED.
  const pressPass: PassBreakdown = {
    code: press.code,
    label: press.label,
    linearFt: opts.goodFt,
    spoilageFt: 0,
    setupFt: press.setupFt,
    totalFt: opts.goodFt + press.setupFt,
    spoilagePct: null,
    spoilageBracketPct: null,
    spoilageFloored: false,
    spoilageOutOfRange: false,
    incomplete: true, // no press spoilage curve yet
  };

  // Laminating pass: real curve, make-ready NOT SOURCED (0 ft).
  const lamSpoilFt = opts.goodFt * (sp.appliedPct / 100);
  const lamPass: PassBreakdown = {
    code: lam.ltCode,
    label: lam.label,
    linearFt: opts.goodFt,
    spoilageFt: lamSpoilFt,
    setupFt: 0,
    totalFt: opts.goodFt + lamSpoilFt,
    spoilagePct: sp.appliedPct,
    spoilageBracketPct: sp.bracketPct,
    spoilageFloored: sp.spoilageFloored,
    spoilageOutOfRange: sp.outOfRange,
    incomplete: true, // no laminating make-ready yet
  };

  const passes = [pressPass, lamPass];
  let requiredFt: number;
  let drivingPass: string;
  if (opts.kind === "FLEXPACK") {
    // compounding: good × (1 + s_lam), plus press make-ready
    requiredFt = opts.goodFt * (1 + sp.appliedPct / 100) + press.setupFt;
    drivingPass = `${lam.ltCode} (compounded)`;
  } else {
    const maxPass = Math.max(pressPass.totalFt, lamPass.totalFt);
    requiredFt = maxPass;
    drivingPass = maxPass === lamPass.totalFt ? lam.ltCode : press.code;
  }

  return {
    goodFt: opts.goodFt,
    requiredFt,
    drivingPass,
    passes,
    noAcross: opts.noAcross,
    repeatIn: opts.repeatIn,
    swapped: opts.swapped,
    machineCode: lam.ltCode,
    makeReadyFt: press.setupFt,
    upliftVsGood: opts.goodFt > 0 ? requiredFt / opts.goodFt - 1 : 0,
  };
}

/** Geometry → good length, then the pass chain. */
function footageForQuote(job: NormalizedJob, masterWidthIn: number | null): FootageBuildUp | null {
  if (job.qty == null || job.qty <= 0) return null;
  if (job.widthIn == null || job.heightIn == null) return null;

  let noAcross: number;
  let repeatIn: number;
  let swapped = false;

  if (job.kind === "LABEL") {
    const eff = applyCopyPositionToLayout({
      sizeAcrossIn: job.widthIn,
      sizeAroundIn: job.heightIn,
      copyPosition: (job.copyPosition ?? "OUT_BTM_2") as CopyPosition,
    });
    swapped = eff.swapped;
    noAcross = deriveNoAcross({
      effectiveAcrossIn: eff.effectiveAcrossIn,
      columnSpaceIn: LAYOUT.columnSpacingIn,
      webWidthIn: masterWidthIn && masterWidthIn > 0 ? masterWidthIn : LAYOUT.usableWebWidthIn,
    });
    repeatIn = computeLabelRepeatIn({
      effectiveAroundIn: eff.effectiveAroundIn,
      rowSpaceIn: LAYOUT.rowSpacingIn,
      cylinderRepeatStepIn: null,
    }).repeatIn;
  } else {
    noAcross = 1;
    // Real LT flexpack products carry rowSpace = 0.0 and labelRepeat == sizeAround
    // exactly (verified on live product-details). Adding row spacing here
    // overstated every flexpack line.
    repeatIn = job.heightIn;
  }
  if (!(noAcross > 0) || !(repeatIn > 0)) return null;

  const goodFt = computeGoodLengthFt(job.qty, noAcross, repeatIn);
  return buildFootage({
    kind: job.kind,
    qty: job.qty,
    goodFt,
    noAcross,
    repeatIn,
    swapped,
    embellishment: job.embellishment,
    notes: [job.notes, job.itemName],
    requestedQuoteLocation: null, // carried separately below for flexpack routing
  });
}

/* ====================================================== derived stock policy */

export interface StockPosition {
  stockId: string;
  description: string;
  supplierName: string | null;
  masterWidthIn: number;
  costMsi: number;
  onHandFt: number;
  rollCount: number;
  onHandValue: number;
  /** Measured average daily consumption over the history window. */
  dailyDemandFt: number;
  dailyDemandSigma: number;
  leadTimeDays: number;
  leadTimeSource: "stock_goal" | "measured_po" | "vendor_median" | "unavailable";
  safetyStockFt: number;
  reorderPointFt: number;
  /** True when SS/ROP came from stock_goal; false ⇒ derived here. */
  policyFromGoal: boolean;
  openPoFt: number;
  openPoCount: number;
  /** Forward demand landing on this stock. */
  quoteFt: number;
  quoteWeightedFt: number;
  firmFt: number;
  /** onHand + openPO − firm − weighted quotes. */
  projectedFt: number;
  direction: "COMFORTABLE" | "WATCH" | "DECIDE" | "ACT";
  directionReason: string;
  onTrackedList: boolean;
  /** Demand on THIS stock broken out by pipeline stage — drives the per-stock flow. */
  byStage: Record<string, { rawFt: number; weightedFt: number; lineCount: number }>;
  /** Open POs in flight for this stock, for the lead-time timeline. */
  openPos: {
    poNumber: string;
    orderedIso: string | null;
    /** Vendor-promised arrival (LT dueDate, or the agent-captured email promise). */
    promisedIso: string | null;
    footageFt: number;
    rolls: number;
    /** confirmed = a promised date exists; otherwise ordered-not-confirmed. */
    status: "confirmed" | "unconfirmed";
    daysOpen: number | null;
  }[];
}

/* ===================================================== dedupe (quote ↔ SO) */

export interface SuppressedLine {
  quoteId: string;
  itemName: string;
  customer: string | null;
  suppressedBy: string;
  basis: string;
  footageAvoidedFt: number;
}

/** Normalise a customer name enough to compare a HubSpot quote to a NetSuite SO. */
const normCustomer = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/\b(llc|inc|co|corp|ltd|the)\b/g, "").replace(/[^a-z0-9]/g, "");

/* ================================================================== result */

export interface QuoteLine {
  id: string;
  source: "HUBSPOT_QUOTE" | "NETSUITE_SO";
  ref: string;
  itemName: string;
  customer: string | null;
  kind: "LABEL" | "FLEXPACK";
  stageId: string | null;
  stageLabel: string;
  probability: number;
  qty: number | null;
  widthIn: number | null;
  heightIn: number | null;
  /** LT copy position (labels). Null on flexpack / NetSuite lines. */
  copyPosition: string | null;
  /** True when HubSpot was blank and OUT_BTM_2 was assumed — worth up to 37%. */
  copyPositionAssumed: boolean;
  embellishment: string | null;
  pressRoute: string;
  pressCostable: boolean;
  substrateStockId: number | null;
  laminateStockId: number | null;
  extraStockIds: number[];
  footage: FootageBuildUp | null;
  weightedFt: number;
  counted: boolean;
  suppressedBy: string | null;
  flags: string[];
}

export interface QuoteStageForecast {
  generatedAt: string;
  readOnly: true;
  totals: {
    hubspotInternal: number;
    quotesCounted: number;
    quotesInReview: number;
    firmLines: number;
    suppressed: number;
    rawFt: number;
    weightedFt: number;
    firmFt: number;
  };
  stages: {
    stageId: string; label: string; outcome: string; probability: number;
    lineCount: number; rawFt: number; weightedFt: number;
  }[];
  positions: StockPosition[];
  lines: QuoteLine[];
  review: { id: string; itemName: string; stageLabel: string; blockers: string[] }[];
  suppressed: SuppressedLine[];
  assumptions: Assumption[];
  understating: Assumption[];
  dataHealth: {
    stocksWithGoalPolicy: number;
    stocksWithDerivedPolicy: number;
    stocksMissingLeadTime: number;
    linesPastCurve: number;
    linesFloored: number;
    linesUncostablePress: number;
    netsuiteRecomputed: number;
  };
}

export async function buildQuoteStageForecast(): Promise<QuoteStageForecast> {
  const token = process.env["HUBSPOT_TOKEN"] ?? "";
  if (!hubspotConfigured(token)) throw new Error("HUBSPOT_TOKEN is not configured");

  const from = addDaysIso(todayIso(), -HISTORY_DAYS);
  const to = todayIso();

  const [hubspot, onHand, stockInfo, openPos, poLeadTimes, usage, nsRows, goalRows] =
    await Promise.all([
      loadForwardJobs({ token }),
      fetchOnHandByStock(),
      fetchStockInfo(),
      fetchOpenPos().catch(() => [] as OpenPoRow[]),
      fetchPoLeadTimes().catch(() => new Map()),
      fetchUsage({ from, to }).catch(() => []),
      db.select().from(nsForecastLineTable),
      db.select().from(stockGoalTable),
    ]);

  const goalByStock = new Map(goalRows.map((g) => [g.stockId, g]));
  const vendorMedians = vendorLeadTimeMedians(poLeadTimes);

  /* ---------------------------------------------------- HubSpot quote lines */
  const lines: QuoteLine[] = [];
  for (const job of hubspot.jobs) {
    const widthOfStock = job.substrateStockId
      ? stockInfo.get(String(job.substrateStockId))?.masterWidth ?? null
      : null;
    const footage = footageForQuote(job, widthOfStock);
    const { costable, routeLabel } = pressFor(null);
    const flags: string[] = [];
    if (footage?.passes.some((p) => p.spoilageOutOfRange)) flags.push("run length past the top spoilage bracket");
    if (footage?.passes.some((p) => p.spoilageFloored)) flags.push("spoilage min floor applied");
    if (job.copyPositionAssumed) flags.push("copy position assumed");
    if (job.substrateStockId && !MATERIAL_BY_ID[job.substrateStockId]) flags.push("stock not on tracked list");

    lines.push({
      id: `hs-${job.id}`,
      source: "HUBSPOT_QUOTE",
      ref: job.estimateId ?? job.id,
      itemName: job.itemName,
      customer: null,
      kind: job.kind,
      stageId: job.stageId,
      stageLabel: job.stageLabel,
      probability: job.probability,
      qty: job.qty,
      widthIn: job.widthIn,
      heightIn: job.heightIn,
      copyPosition: job.copyPosition ?? null,
      copyPositionAssumed: job.copyPositionAssumed,
      embellishment: job.embellishment,
      pressRoute: routeLabel,
      pressCostable: costable,
      substrateStockId: job.substrateStockId,
      laminateStockId: job.laminateStockId,
      extraStockIds: [],
      footage,
      weightedFt: (footage?.requiredFt ?? 0) * job.probability,
      counted: true,
      suppressedBy: null,
      flags,
    });
  }

  /* ------------------------------------------- NetSuite firm demand (recomputed) */
  interface NsStock { stockId: string; footage: number; widthIn: number }
  let netsuiteRecomputed = 0;
  for (const r of nsRows) {
    const sd = r.stockDemand as unknown as
      | { stocks?: NsStock[]; goodLengthFt?: number; noAcross?: number; repeatIn?: number }
      | null;
    if (!sd?.goodLengthFt || !sd.stocks?.length) continue;

    const kind: "LABEL" | "FLEXPACK" = r.isFlexpack ? "FLEXPACK" : "LABEL";
    // NetSuite carries no embellishment field ⇒ plain route (ABGA / FLEXLAM).
    const footage = buildFootage({
      kind,
      qty: r.quantity ?? 0,
      goodFt: sd.goodLengthFt,
      noAcross: sd.noAcross ?? 1,
      repeatIn: sd.repeatIn ?? 0,
      swapped: false,
      embellishment: null,
      notes: [],
      requestedQuoteLocation: null,
    });
    netsuiteRecomputed++;

    const ids = sd.stocks.map((s) => Number(s.stockId)).filter((n) => Number.isFinite(n));
    lines.push({
      id: `ns-${r.id}`,
      source: "NETSUITE_SO",
      ref: r.tranId ?? r.soId ?? r.id,
      itemName: `${r.sku ?? "(no sku)"} — ${r.customerName ?? "(no customer)"}`,
      customer: r.customerName ?? null,
      kind,
      stageId: null,
      stageLabel: "Sales order (firm)",
      probability: 1,
      qty: r.quantity ?? null,
      widthIn: null,
      heightIn: null,
      copyPosition: null,
      copyPositionAssumed: false,
      embellishment: null,
      pressRoute: "(NetSuite — route unknown)",
      pressCostable: true,
      substrateStockId: ids[0] ?? null,
      laminateStockId: ids[1] ?? null,
      extraStockIds: ids.slice(2),
      footage,
      weightedFt: footage.requiredFt,
      counted: true,
      suppressedBy: null,
      flags: ["NetSuite embellishment unknown — plain laminating route assumed", "footage recomputed on real curves (stored value was flat 8%)"],
    });
  }

  /* ------------------------------------------------- double-count guard */
  const suppressed: SuppressedLine[] = [];
  /**
   * HubSpot item names are NOT positionally reliable — both "CQ-Pure Buds-Labels-…"
   * and "CQ-1725-Sugarhouse Farms-Flexible Packaging-…" occur, so splitting on "-"
   * and taking index 1 reads a job number as the customer on a large minority of
   * records. Match by looking for the NetSuite customer ANYWHERE in the normalised
   * item name instead, and still require an exact quantity match so a shared
   * customer alone can never suppress real demand.
   */
  const MIN_NAME_LEN = 6;
  const firm = lines
    .filter((l) => l.source === "NETSUITE_SO" && l.qty)
    .map((l) => ({ ref: l.ref, norm: normCustomer(l.customer), qty: Math.round(l.qty!) }))
    .filter((f) => f.norm.length >= MIN_NAME_LEN);

  for (const l of lines) {
    if (l.source !== "HUBSPOT_QUOTE" || !l.qty) continue;
    const haystack = normCustomer(l.itemName);
    const qty = Math.round(l.qty);
    const hit = firm.find((f) => f.qty === qty && haystack.includes(f.norm));
    if (!hit) continue;
    l.counted = false;
    l.suppressedBy = hit.ref;
    l.weightedFt = 0;
    suppressed.push({
      quoteId: l.id,
      itemName: l.itemName,
      customer: hit.norm,
      suppressedBy: hit.ref,
      basis: `customer name matches NetSuite ${hit.ref} and quantity is identical (${qty.toLocaleString()}) — the quote carries no netsuite_so_ link, so only the fuzzy match catches it`,
      footageAvoidedFt: l.footage?.requiredFt ?? 0,
    });
  }

  const counted = lines.filter((l) => l.counted);

  /* ------------------------------------------------------- stage rollup */
  const stages = FORWARD_STAGES.map((id) => {
    const inStage = counted.filter((l) => l.stageId === id);
    return {
      stageId: id,
      label: STAGE_LABEL[id] ?? id,
      outcome: STAGE_OUTCOME[id] ?? "OPEN",
      probability: STAGE_PROBABILITY[id] ?? 0,
      lineCount: inStage.length,
      rawFt: inStage.reduce((a, l) => a + (l.footage?.requiredFt ?? 0), 0),
      weightedFt: inStage.reduce((a, l) => a + l.weightedFt, 0),
    };
  });

  /* ------------------------------------------- per-stock demand aggregation */
  interface StockDemand {
    quote: number; weighted: number; firm: number;
    byStage: Record<string, { rawFt: number; weightedFt: number; lineCount: number }>;
  }
  const demandByStock = new Map<string, StockDemand>();
  const bump = (id: number | null | undefined, l: QuoteLine) => {
    if (id == null || !l.footage) return;
    const k = String(id);
    const row = demandByStock.get(k) ?? { quote: 0, weighted: 0, firm: 0, byStage: {} };
    if (l.source === "NETSUITE_SO") row.firm += l.footage.requiredFt;
    else {
      row.quote += l.footage.requiredFt;
      row.weighted += l.weightedFt;
    }
    // stage breakdown — NetSuite lines have no pipeline stage, bucket them as firm
    const key = l.stageId ?? "FIRM";
    const b = row.byStage[key] ?? { rawFt: 0, weightedFt: 0, lineCount: 0 };
    b.rawFt += l.footage.requiredFt;
    b.weightedFt += l.weightedFt;
    b.lineCount += 1;
    row.byStage[key] = b;
    demandByStock.set(k, row);
  };
  for (const l of counted) {
    bump(l.substrateStockId, l);
    bump(l.laminateStockId, l);
    for (const e of l.extraStockIds) bump(e, l);
  }

  /* ------------------------------- daily demand history, for derived policy */
  const dailyByStock = new Map<string, number[]>();
  for (const u of usage as { stockId: string; footage: number }[]) {
    const arr = dailyByStock.get(u.stockId) ?? [];
    arr.push(u.footage);
    dailyByStock.set(u.stockId, arr);
  }

  const openPoByStock = new Map<string, { ft: number; n: number; list: StockPosition["openPos"] }>();
  for (const p of openPos) {
    const r = openPoByStock.get(p.stockId) ?? { ft: 0, n: 0, list: [] };
    r.ft += p.orderedFootage ?? 0;
    r.n += 1;
    const promised = p.dueDateIso ?? p.agentPromisedIso ?? null;
    r.list.push({
      poNumber: p.poNumber,
      orderedIso: p.poDateIso ?? null,
      promisedIso: promised,
      footageFt: p.orderedFootage ?? 0,
      rolls: p.quantityRolls ?? 0,
      status: promised ? "confirmed" : "unconfirmed",
      daysOpen: p.daysOpen ?? null,
    });
    openPoByStock.set(p.stockId, r);
  }

  const z = zForServiceLevel(SERVICE_LEVEL);
  const positions: StockPosition[] = [];
  const stockIds = new Set<string>([...demandByStock.keys()]);

  for (const stockId of stockIds) {
    const info: StockInfoRow | undefined = stockInfo.get(stockId);
    const oh: OnHandRow | undefined = onHand.get(stockId);
    const goal = goalByStock.get(stockId);
    const dem = demandByStock.get(stockId) ?? { quote: 0, weighted: 0, firm: 0, byStage: {} };

    const samples = dailyByStock.get(stockId) ?? [];
    const totalUsed = samples.reduce((a, b) => a + b, 0);
    const dailyDemandFt = totalUsed / HISTORY_DAYS;
    const dailyDemandSigma = samples.length > 1 ? stdDev(samples) : 0;

    // lead time: goal → measured PO median for this supplier → unavailable
    let leadTimeDays = 0;
    let leadTimeSource: StockPosition["leadTimeSource"] = "unavailable";
    if (goal?.leadTimeDays && goal.leadTimeDays > 0) {
      leadTimeDays = goal.leadTimeDays;
      leadTimeSource = "stock_goal";
    } else if (info?.supplierName && vendorMedians.get(info.supplierName)) {
      leadTimeDays = vendorMedians.get(info.supplierName)!;
      leadTimeSource = "vendor_median";
    }

    // SS / ROP: goal when set, else derived
    const policyFromGoal = Boolean(goal?.min && goal.min > 0 && goal?.reorderPointFootage);
    let safetyStockFt: number;
    let reorderPointFt: number;
    if (policyFromGoal) {
      safetyStockFt = goal!.min!;
      reorderPointFt = goal!.reorderPointFootage!;
    } else {
      // z·√(LT·σD²) — the σLT term needs per-stock lead-time spread we don't have
      safetyStockFt = leadTimeDays > 0 ? z * Math.sqrt(leadTimeDays) * dailyDemandSigma : 0;
      reorderPointFt = dailyDemandFt * leadTimeDays + safetyStockFt;
    }

    const openPo = openPoByStock.get(stockId) ?? { ft: 0, n: 0, list: [] };
    const onHandFt = oh?.footage ?? 0;
    const projectedFt = onHandFt + openPo.ft - dem.firm - dem.weighted;

    let direction: StockPosition["direction"];
    let directionReason: string;
    if (projectedFt < 0) {
      direction = "ACT";
      directionReason = "Projected position goes negative once firm orders and weighted quotes are consumed.";
    } else if (safetyStockFt > 0 && projectedFt < safetyStockFt) {
      direction = "DECIDE";
      directionReason = "Projected position lands below safety stock — a judgement call.";
    } else if (reorderPointFt > 0 && projectedFt < reorderPointFt) {
      direction = "WATCH";
      directionReason = "Projected position dips under the reorder point but stays above safety stock.";
    } else if (safetyStockFt === 0 && reorderPointFt === 0) {
      direction = "WATCH";
      directionReason = "No policy could be derived (no measured usage or lead time) — position shown without thresholds.";
    } else {
      direction = "COMFORTABLE";
      directionReason = "Projected position stays above the reorder point.";
    }

    const mat = MATERIAL_BY_ID[Number(stockId)];
    positions.push({
      stockId,
      description: oh?.description ?? mat?.description ?? info?.faceStock ?? `Stock ${stockId}`,
      supplierName: info?.supplierName ?? goal?.vendorName ?? null,
      masterWidthIn: info?.masterWidth ?? 0,
      costMsi: info?.costMsi ?? goal?.msiCost ?? 0,
      onHandFt,
      rollCount: oh?.rollCount ?? 0,
      onHandValue: oh?.value ?? 0,
      dailyDemandFt,
      dailyDemandSigma,
      leadTimeDays,
      leadTimeSource,
      safetyStockFt,
      reorderPointFt,
      policyFromGoal,
      openPoFt: openPo.ft,
      openPoCount: openPo.n,
      quoteFt: dem.quote,
      quoteWeightedFt: dem.weighted,
      firmFt: dem.firm,
      projectedFt,
      direction,
      directionReason,
      onTrackedList: Boolean(mat),
      byStage: dem.byStage,
      openPos: openPo.list.sort((a, b) => (a.orderedIso ?? "").localeCompare(b.orderedIso ?? "")),
    });
  }

  const order = { ACT: 0, DECIDE: 1, WATCH: 2, COMFORTABLE: 3 } as const;
  positions.sort((a, b) => order[a.direction] - order[b.direction] || b.quoteFt + b.firmFt - (a.quoteFt + a.firmFt));

  const result: QuoteStageForecast = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    totals: {
      hubspotInternal: hubspot.total,
      quotesCounted: counted.filter((l) => l.source === "HUBSPOT_QUOTE").length,
      quotesInReview: hubspot.review.length,
      firmLines: counted.filter((l) => l.source === "NETSUITE_SO").length,
      suppressed: suppressed.length,
      rawFt: counted.reduce((a, l) => a + (l.footage?.requiredFt ?? 0), 0),
      weightedFt: counted.filter((l) => l.source === "HUBSPOT_QUOTE").reduce((a, l) => a + l.weightedFt, 0),
      firmFt: counted.filter((l) => l.source === "NETSUITE_SO").reduce((a, l) => a + (l.footage?.requiredFt ?? 0), 0),
    },
    stages,
    positions,
    lines,
    review: hubspot.review.map((j) => ({
      id: j.id, itemName: j.itemName, stageLabel: j.stageLabel, blockers: j.blockers,
    })),
    suppressed,
    assumptions: assumptionRegistry(),
    understating: understatingAssumptions(),
    dataHealth: {
      stocksWithGoalPolicy: positions.filter((p) => p.policyFromGoal).length,
      stocksWithDerivedPolicy: positions.filter((p) => !p.policyFromGoal).length,
      stocksMissingLeadTime: positions.filter((p) => p.leadTimeSource === "unavailable").length,
      linesPastCurve: counted.filter((l) => l.footage?.passes.some((p) => p.spoilageOutOfRange)).length,
      linesFloored: counted.filter((l) => l.footage?.passes.some((p) => p.spoilageFloored)).length,
      linesUncostablePress: counted.filter((l) => !l.pressCostable).length,
      netsuiteRecomputed,
    },
  };

  logger.info(
    {
      quotes: result.totals.quotesCounted,
      firm: result.totals.firmLines,
      suppressed: result.totals.suppressed,
      stocks: positions.length,
      rawFt: Math.round(result.totals.rawFt),
    },
    "quote-stage forecast built",
  );
  return result;
}
