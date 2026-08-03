/**
 * MOCK DATA + FORECAST ENGINE for the Forecasting tab prototype.
 *
 * Every number here is INVENTED. Nothing connects to Neon, NetSuite, LabelTraxx
 * or HubSpot. The shapes deliberately mirror the real tables so wiring this to
 * live data is mechanical:
 *
 *   Material      <- lt_stock + stock_goal
 *   DemandLine    <- ns_forecast_line (NetSuite) + a parallel HubSpot deal table
 *   .stockDemand  <- ns_forecast_line.stock_demand jsonb [{stockId,widthIn,footage}]
 *
 * The probability constants are the ones measured in cx-process-explorer
 * (gap-to-goal.ts) against 944 decided deals — reproduced here so the prototype
 * demonstrates calibrated numbers rather than invented ones.
 */

/* ---------------------------------------------------------------------------
 * Calibration constants (real, from gap-to-goal.ts)
 * ------------------------------------------------------------------------- */

/** P(win AND ships in quarter), by HubSpot close-status × pipeline. n=944. */
export const EMPIRICAL_P: Record<string, { p: number; n: number }> = {
  "Expect|Acquisition": { p: 0.7846, n: 153 },
  "Expect|Retention": { p: 0.7509, n: 360 },
  "Expect|Growth": { p: 0.5484, n: 124 },
  "Best Case|Retention": { p: 0.5302, n: 38 },
  "Best Case|Growth": { p: 0.5016, n: 82 },
  "Best Case|Acquisition": { p: 0.1661, n: 96 },
  "Opportunity|Growth": { p: 0.2956, n: 71 },
  "Opportunity|Acquisition": { p: 0.0884, n: 76 },
};

/** NetSuite sales-order status weights. "Pending Approval" is the 75–90% band. */
export const NS_STATUS_P: Record<string, number> = {
  "Pending Fulfillment": 0.97,
  "Pending Approval": 0.85,
  "Pending Approval (>2wk)": 0.5,
};

/**
 * Staleness decay on an open deal. ILLUSTRATIVE shape — the real engine uses a
 * measured multiplier table. The one hard finding it encodes is real: deals
 * untouched >45 days closed $0 of $219,532.
 */
export function stalenessMultiplier(ageDays: number): number {
  if (ageDays <= 7) return 1.0;
  if (ageDays <= 21) return 0.82;
  if (ageDays <= 45) return 0.45;
  return 0.05;
}

/**
 * Per-rep calibration — measured, NOT seniority. "When this rep says 70%, what
 * actually closed?" A factor of 1.0 means perfectly calibrated.
 */
export const REP_CALIBRATION: Record<string, { factor: number; n: number }> = {
  "Jake Lynch": { factor: 1.04, n: 187 },
  "Dave Borkowski": { factor: 0.91, n: 143 },
  "Brad Sherman": { factor: 1.11, n: 96 },
  "Owen Labombard": { factor: 0.68, n: 74 },
  "Max Shaw": { factor: 0.83, n: 41 },
  "Alex Gonzalez": { factor: 1.0, n: 12 },
};

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

export type DemandSource = "NETSUITE" | "HUBSPOT" | "BASELINE";
export type PoolingClass = "POOLED" | "SEMI_POOLED" | "UNPOOLED";

export interface Material {
  stockId: string;
  description: string;
  supplierName: string;
  masterWidthIn: number;
  costMsi: number;
  /** Median measured order→receipt gap, and its spread. */
  leadTimeDays: number;
  leadTimeSigmaDays: number;
  onHandFt: number;
  safetyStockFt: number;
  typicalRollFt: number;
  /** Substitutable stock numbers (advisory) — real field: alternate_stock_ids. */
  alternateStockIds: string[];
  /** Unnamed reorder demand per week from roll-usage history, ft. */
  baselineWeeklyFt: number;
  baselineCv: number;
  /** Already-placed POs: week index → footage arriving. */
  onOrder: { week: number; footageFt: number; poNumber: string }[];
  isCustom: boolean;
}

export interface StockDemand {
  stockId: string;
  widthIn: number;
  footageFt: number;
}

export interface DemandLine {
  id: string;
  source: DemandSource;
  ref: string;
  customer: string;
  brand: string;
  rep: string;
  /** HubSpot "status|pipeline" key, or NetSuite status label. */
  stage: string;
  qtyUnits: number;
  amountUsd: number;
  ageDays: number;
  /** Week index (0–12) the material is consumed. */
  requiredWeek: number;
  /** Final calibrated probability after all adjustments. */
  p: number;
  /** Human-readable trail of how p was derived. */
  pBasis: string[];
  stockDemand: StockDemand[];
  /** Set when a NetSuite SO supersedes this deal — it then contributes ZERO. */
  supersededBy: string | null;
  /** Label geometry that produced the footage. Null = not yet specced. */
  construction: {
    sizeAcrossIn: number;
    sizeAroundIn: number;
    copyPosition: string;
    repeatIn: number;
    noAcross: number;
    goodLengthFt: number;
    derived: boolean;
  } | null;
  unresolvedReason: string | null;
}

/* ---------------------------------------------------------------------------
 * Materials — 8 stocks: 6 pooled core substrates/laminates, 2 one-off customs
 * ------------------------------------------------------------------------- */

export const MATERIALS: Material[] = [
  {
    stockId: "206",
    description: "White 0.5 mil METPET / 3.0 mil LLDPE",
    supplierName: "Compax Packaging",
    masterWidthIn: 13,
    costMsi: 4.18,
    leadTimeDays: 42,
    leadTimeSigmaDays: 11,
    onHandFt: 18400,
    safetyStockFt: 9200,
    typicalRollFt: 5000,
    alternateStockIds: ["296"],
    baselineWeeklyFt: 1850,
    baselineCv: 0.31,
    onOrder: [{ week: 4, footageFt: 15000, poNumber: "PO 2365" }],
    isCustom: false,
  },
  {
    stockId: "73",
    description: "Clear 1 mil Direct Thermal BOPP / S692N / 40# SCK",
    supplierName: "Assem-Pak",
    masterWidthIn: 12.5,
    costMsi: 3.5,
    leadTimeDays: 28,
    leadTimeSigmaDays: 6,
    onHandFt: 6100,
    safetyStockFt: 9400,
    typicalRollFt: 4000,
    alternateStockIds: [],
    baselineWeeklyFt: 2400,
    baselineCv: 0.22,
    onOrder: [],
    isCustom: false,
  },
  {
    stockId: "195",
    description: "Semi-Gloss Paper / S2045N / 44# Liner",
    supplierName: "Compax Packaging",
    masterWidthIn: 13,
    costMsi: 2.05,
    leadTimeDays: 21,
    leadTimeSigmaDays: 4,
    onHandFt: 31200,
    safetyStockFt: 7800,
    typicalRollFt: 6000,
    alternateStockIds: ["296"],
    baselineWeeklyFt: 3100,
    baselineCv: 0.18,
    onOrder: [{ week: 2, footageFt: 12000, poNumber: "PO 2402" }],
    isCustom: false,
  },
  {
    stockId: "296",
    description: "Semi-Gloss Paper / S2045N / 40# SCK (alt for 195)",
    supplierName: "Logistics Plus",
    masterWidthIn: 13,
    costMsi: 2.18,
    leadTimeDays: 24,
    leadTimeSigmaDays: 5,
    onHandFt: 9800,
    safetyStockFt: 3900,
    typicalRollFt: 6000,
    alternateStockIds: ["195"],
    baselineWeeklyFt: 900,
    baselineCv: 0.44,
    onOrder: [],
    isCustom: false,
  },
  {
    stockId: "418",
    description: "Matte BOPP / Perm Acrylic / 40# SCK",
    supplierName: "Carter Distribution",
    masterWidthIn: 12.5,
    costMsi: 3.92,
    leadTimeDays: 35,
    leadTimeSigmaDays: 9,
    onHandFt: 4200,
    safetyStockFt: 5600,
    typicalRollFt: 4000,
    alternateStockIds: [],
    baselineWeeklyFt: 1150,
    baselineCv: 0.37,
    onOrder: [{ week: 6, footageFt: 8000, poNumber: "PO 2411" }],
    isCustom: false,
  },
  {
    stockId: "512",
    description: "Gloss Lamination 1.2 mil OPP (secondary web)",
    supplierName: "Assem-Pak",
    masterWidthIn: 13,
    costMsi: 1.64,
    leadTimeDays: 18,
    leadTimeSigmaDays: 3,
    onHandFt: 22800,
    safetyStockFt: 6400,
    typicalRollFt: 8000,
    alternateStockIds: [],
    baselineWeeklyFt: 2050,
    baselineCv: 0.26,
    onOrder: [],
    isCustom: false,
  },
  {
    stockId: "887",
    description: "CUSTOM — Holographic Cold-Foil PET 2 mil (Sun Theory only)",
    supplierName: "Carter Distribution",
    masterWidthIn: 13,
    costMsi: 11.4,
    leadTimeDays: 63,
    leadTimeSigmaDays: 18,
    onHandFt: 0,
    safetyStockFt: 0,
    typicalRollFt: 3000,
    alternateStockIds: [],
    baselineWeeklyFt: 0,
    baselineCv: 0,
    onOrder: [],
    isCustom: true,
  },
  {
    stockId: "903",
    description: "CUSTOM — Recycled Kraft 60# / Removable (Verdant pilot)",
    supplierName: "Logistics Plus",
    masterWidthIn: 12,
    costMsi: 6.85,
    leadTimeDays: 49,
    leadTimeSigmaDays: 14,
    onHandFt: 5400,
    safetyStockFt: 0,
    typicalRollFt: 3000,
    alternateStockIds: [],
    baselineWeeklyFt: 0,
    baselineCv: 0,
    onOrder: [],
    isCustom: true,
  },
];

/* ---------------------------------------------------------------------------
 * Probability derivation — mirrors the real calibration chain
 * ------------------------------------------------------------------------- */

function calibrate(opts: {
  source: DemandSource;
  stage: string;
  rep: string;
  ageDays: number;
  ltBacked?: boolean;
  paymentHold?: boolean;
}): { p: number; basis: string[] } {
  const basis: string[] = [];
  let p: number;

  if (opts.source === "NETSUITE") {
    p = NS_STATUS_P[opts.stage] ?? 0.85;
    basis.push(`NetSuite "${opts.stage}" base ${(p * 100).toFixed(0)}%`);
    if (opts.ltBacked) {
      p = Math.max(p, 0.95);
      basis.push("LabelTraxx ticket exists → floor 95%");
    }
    if (opts.paymentHold) {
      p *= 0.45;
      basis.push("payment hold in notes → ×0.45");
    }
  } else {
    const hit = EMPIRICAL_P[opts.stage];
    p = hit?.p ?? 0.3;
    basis.push(
      `EMPIRICAL_P "${opts.stage}" = ${(p * 100).toFixed(1)}% (n=${hit?.n ?? "?"})`,
    );
    const stale = stalenessMultiplier(opts.ageDays);
    if (stale < 1) {
      p *= stale;
      basis.push(`${opts.ageDays}d since touch → ×${stale.toFixed(2)}`);
    }
    const cal = REP_CALIBRATION[opts.rep];
    if (cal && cal.factor !== 1) {
      p *= cal.factor;
      basis.push(
        `${opts.rep} calibration ×${cal.factor.toFixed(2)} (n=${cal.n})`,
      );
    }
  }

  p = Math.min(1, Math.max(0.02, p));
  return { p, basis };
}

/* ---------------------------------------------------------------------------
 * Demand lines
 * ------------------------------------------------------------------------- */

function line(o: {
  id: string;
  source: DemandSource;
  ref: string;
  customer: string;
  brand: string;
  rep: string;
  stage: string;
  qtyUnits: number;
  amountUsd: number;
  ageDays: number;
  requiredWeek: number;
  stockDemand: StockDemand[];
  supersededBy?: string | null;
  construction?: DemandLine["construction"];
  unresolvedReason?: string | null;
  ltBacked?: boolean;
  paymentHold?: boolean;
}): DemandLine {
  const { p, basis } = calibrate(o);
  return {
    id: o.id,
    source: o.source,
    ref: o.ref,
    customer: o.customer,
    brand: o.brand,
    rep: o.rep,
    stage: o.stage,
    qtyUnits: o.qtyUnits,
    amountUsd: o.amountUsd,
    ageDays: o.ageDays,
    requiredWeek: o.requiredWeek,
    p,
    pBasis: basis,
    stockDemand: o.stockDemand,
    supersededBy: o.supersededBy ?? null,
    construction: o.construction ?? null,
    unresolvedReason: o.unresolvedReason ?? null,
  };
}

export const DEMAND_LINES: DemandLine[] = [
  // --- NetSuite: firm-ish orders -------------------------------------------
  line({
    id: "L01",
    source: "NETSUITE",
    ref: "SO118742",
    customer: "Curaleaf",
    brand: "Curaleaf",
    rep: "Jake Lynch",
    stage: "Pending Fulfillment",
    qtyUnits: 240000,
    amountUsd: 96400,
    ageDays: 4,
    requiredWeek: 2,
    ltBacked: true,
    stockDemand: [
      { stockId: "73", widthIn: 7.5, footageFt: 26500 },
      { stockId: "512", widthIn: 7.5, footageFt: 26500 },
    ],
    construction: {
      sizeAcrossIn: 7.42,
      sizeAroundIn: 1.2,
      copyPosition: "OUT_BTM_2",
      repeatIn: 1.325,
      noAcross: 1,
      goodLengthFt: 26500,
      derived: false,
    },
  }),
  line({
    id: "L02",
    source: "NETSUITE",
    ref: "SO118801",
    customer: "Choice Labs",
    brand: "Choice Labs",
    rep: "Dave Borkowski",
    stage: "Pending Approval",
    qtyUnits: 40000,
    amountUsd: 31200,
    ageDays: 9,
    requiredWeek: 3,
    stockDemand: [
      { stockId: "206", widthIn: 9.0, footageFt: 12400 },
      { stockId: "512", widthIn: 9.0, footageFt: 12400 },
    ],
    construction: {
      sizeAcrossIn: 4.25,
      sizeAroundIn: 6.5,
      copyPosition: "OUT_BTM_2",
      repeatIn: 6.625,
      noAcross: 2,
      goodLengthFt: 11060,
      derived: false,
    },
  }),
  line({
    id: "L03",
    source: "NETSUITE",
    ref: "SO118655",
    customer: "Planet 13",
    brand: "Planet 13",
    rep: "Brad Sherman",
    stage: "Pending Approval (>2wk)",
    qtyUnits: 88000,
    amountUsd: 44100,
    ageDays: 19,
    requiredWeek: 5,
    paymentHold: true,
    stockDemand: [{ stockId: "195", widthIn: 6.25, footageFt: 19800 }],
    construction: {
      sizeAcrossIn: 3.0,
      sizeAroundIn: 2.7,
      copyPosition: "OUT_BTM_2",
      repeatIn: 2.825,
      noAcross: 4,
      goodLengthFt: 17600,
      derived: true,
    },
  }),
  line({
    id: "L04",
    source: "NETSUITE",
    ref: "SO118903",
    customer: "Sun Theory",
    brand: "Sun Theory",
    rep: "Jake Lynch",
    stage: "Pending Approval",
    qtyUnits: 55000,
    amountUsd: 118500,
    ageDays: 2,
    requiredWeek: 8,
    stockDemand: [
      { stockId: "887", widthIn: 8.5, footageFt: 14200 },
      { stockId: "512", widthIn: 8.5, footageFt: 14200 },
    ],
    construction: {
      sizeAcrossIn: 4.0,
      sizeAroundIn: 3.0,
      copyPosition: "OUT_BTM_2",
      repeatIn: 3.125,
      noAcross: 3,
      goodLengthFt: 14200,
      derived: false,
    },
  }),

  // --- HubSpot: pipeline ---------------------------------------------------
  // L05 is SUPERSEDED by SO118801 (L02) — the consumption case.
  line({
    id: "L05",
    source: "HUBSPOT",
    ref: "deal-8891",
    customer: "Choice Labs",
    brand: "Choice Labs",
    rep: "Dave Borkowski",
    stage: "Expect|Retention",
    qtyUnits: 40000,
    amountUsd: 31200,
    ageDays: 24,
    requiredWeek: 3,
    supersededBy: "SO118801",
    stockDemand: [
      { stockId: "206", widthIn: 9.0, footageFt: 12400 },
      { stockId: "512", widthIn: 9.0, footageFt: 12400 },
    ],
    construction: {
      sizeAcrossIn: 4.25,
      sizeAroundIn: 6.5,
      copyPosition: "OUT_BTM_2",
      repeatIn: 6.625,
      noAcross: 2,
      goodLengthFt: 11060,
      derived: false,
    },
  }),
  line({
    id: "L06",
    source: "HUBSPOT",
    ref: "deal-9104",
    customer: "Curaleaf",
    brand: "Curaleaf",
    rep: "Jake Lynch",
    stage: "Expect|Retention",
    qtyUnits: 320000,
    amountUsd: 128000,
    ageDays: 5,
    requiredWeek: 7,
    stockDemand: [
      { stockId: "73", widthIn: 7.5, footageFt: 35300 },
      { stockId: "512", widthIn: 7.5, footageFt: 35300 },
    ],
    construction: {
      sizeAcrossIn: 7.42,
      sizeAroundIn: 1.2,
      copyPosition: "OUT_BTM_2",
      repeatIn: 1.325,
      noAcross: 1,
      goodLengthFt: 35300,
      derived: false,
    },
  }),
  line({
    id: "L07",
    source: "HUBSPOT",
    ref: "deal-9022",
    customer: "Verdant Wellness",
    brand: "Verdant",
    rep: "Owen Labombard",
    stage: "Best Case|Acquisition",
    qtyUnits: 150000,
    amountUsd: 210000,
    ageDays: 11,
    requiredWeek: 6,
    stockDemand: [
      { stockId: "903", widthIn: 8.0, footageFt: 28900 },
      { stockId: "418", widthIn: 8.0, footageFt: 28900 },
    ],
    construction: {
      sizeAcrossIn: 3.75,
      sizeAroundIn: 2.25,
      copyPosition: "OUT_BTM_2",
      repeatIn: 2.375,
      noAcross: 3,
      goodLengthFt: 28900,
      derived: true,
    },
  }),
  line({
    id: "L08",
    source: "HUBSPOT",
    ref: "deal-8740",
    customer: "Grove Collective",
    brand: "Grove",
    rep: "Max Shaw",
    stage: "Opportunity|Growth",
    qtyUnits: 95000,
    amountUsd: 47500,
    ageDays: 58,
    requiredWeek: 9,
    stockDemand: [
      { stockId: "195", widthIn: 6.25, footageFt: 21400 },
      { stockId: "512", widthIn: 6.25, footageFt: 21400 },
    ],
    construction: {
      sizeAcrossIn: 3.0,
      sizeAroundIn: 2.7,
      copyPosition: "OUT_BTM_2",
      repeatIn: 2.825,
      noAcross: 4,
      goodLengthFt: 21400,
      derived: true,
    },
  }),
  line({
    id: "L09",
    source: "HUBSPOT",
    ref: "deal-9188",
    customer: "Choice Labs",
    brand: "Choice Labs",
    rep: "Brad Sherman",
    stage: "Expect|Growth",
    qtyUnits: 180000,
    amountUsd: 88000,
    ageDays: 3,
    requiredWeek: 10,
    stockDemand: [
      { stockId: "206", widthIn: 9.0, footageFt: 41800 },
      { stockId: "512", widthIn: 9.0, footageFt: 41800 },
    ],
    construction: {
      sizeAcrossIn: 4.25,
      sizeAroundIn: 6.5,
      copyPosition: "OUT_BTM_2",
      repeatIn: 6.625,
      noAcross: 2,
      goodLengthFt: 41800,
      derived: false,
    },
  }),
  line({
    id: "L10",
    source: "HUBSPOT",
    ref: "deal-9201",
    customer: "Curaleaf",
    brand: "Curaleaf",
    rep: "Alex Gonzalez",
    stage: "Best Case|Retention",
    qtyUnits: 60000,
    amountUsd: 24000,
    ageDays: 8,
    requiredWeek: 11,
    stockDemand: [{ stockId: "418", widthIn: 5.5, footageFt: 13600 }],
    construction: {
      sizeAcrossIn: 2.5,
      sizeAroundIn: 2.0,
      copyPosition: "OUT_LEFT_4",
      repeatIn: 2.625,
      noAcross: 5,
      goodLengthFt: 13600,
      derived: true,
    },
  }),

  // --- Unforecastable: no construction from Estimating yet -----------------
  line({
    id: "L11",
    source: "HUBSPOT",
    ref: "deal-9233",
    customer: "Northside Cultivation",
    brand: "Northside",
    rep: "Jake Lynch",
    stage: "Expect|Acquisition",
    qtyUnits: 200000,
    amountUsd: 174000,
    ageDays: 6,
    requiredWeek: 8,
    stockDemand: [],
    unresolvedReason: "New product — Estimating has not produced a construction",
  }),
  line({
    id: "L12",
    source: "HUBSPOT",
    ref: "deal-9210",
    customer: "Harbor Extracts",
    brand: "Harbor",
    rep: "Dave Borkowski",
    stage: "Best Case|Growth",
    qtyUnits: 120000,
    amountUsd: 143000,
    ageDays: 14,
    requiredWeek: 9,
    stockDemand: [],
    unresolvedReason: "SKU not found in LabelTraxx — no product record to explode",
  }),
  line({
    id: "L13",
    source: "HUBSPOT",
    ref: "deal-9247",
    customer: "Sun Theory",
    brand: "Sun Theory",
    rep: "Brad Sherman",
    stage: "Expect|Growth",
    qtyUnits: 75000,
    amountUsd: 95000,
    ageDays: 2,
    requiredWeek: 12,
    stockDemand: [],
    unresolvedReason: "Quote in Estimating pipeline, stage 'In Progress'",
  }),
];

/* ---------------------------------------------------------------------------
 * Engine
 * ------------------------------------------------------------------------- */

export const HORIZON_WEEKS = 13;

/** Seeded PRNG so the simulation is reproducible run to run. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Active lines only: a superseded deal contributes ZERO (consumption, not stacking). */
export function activeLines(lines: DemandLine[]): DemandLine[] {
  return lines.filter((l) => !l.supersededBy && l.stockDemand.length > 0);
}

export function unforecastableLines(lines: DemandLine[]): DemandLine[] {
  return lines.filter((l) => !l.supersededBy && l.stockDemand.length === 0);
}

export interface WeekStat {
  week: number;
  p10: number;
  p50: number;
  p90: number;
  /** Stacked helpers for the recharts band. */
  bandLo: number;
  bandSpan: number;
  expectedDemand: number;
  namedDemand: number;
  baselineNet: number;
  receipts: number;
  safetyStock: number;
}

export interface MaterialForecast {
  material: Material;
  weeks: WeekStat[];
  /** Probability projected-on-hand goes below zero at any point in horizon. */
  pStockout: number;
  /** Probability it breaches safety stock at any point. */
  pBreachSafety: number;
  /** First week where the P50 path breaches safety stock, or null. */
  firstBreachWeek: number | null;
  /** Mean leftover above safety stock at horizon, ft. */
  expectedExcessFt: number;
  expectedExcessUsd: number;
  /** Recommended buy, rounded to whole rolls. */
  recommendFt: number;
  recommendRolls: number;
  recommendUsd: number;
  orderByWeek: number | null;
  pooling: PoolingClass;
  distinctCustomers: number;
  distinctDeals: number;
  demandCv: number;
  drivers: { line: DemandLine; footageFt: number }[];
  /** Exposure if every non-firm driver evaporates. */
  exposureUsd: number;
  absorbWeeks: number | null;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

export function buildForecast(
  material: Material,
  lines: DemandLine[],
  opts: { scenarios?: number; seed?: number; serviceLevel?: number } = {},
): MaterialForecast {
  const scenarios = opts.scenarios ?? 4000;
  const serviceLevel = opts.serviceLevel ?? 0.95;
  const rand = mulberry32(opts.seed ?? 20260803);

  const active = activeLines(lines);
  const drivers: { line: DemandLine; footageFt: number }[] = [];
  for (const l of active) {
    const sd = l.stockDemand.find((s) => s.stockId === material.stockId);
    if (sd) drivers.push({ line: l, footageFt: sd.footageFt });
  }

  // ---- named demand per week (expected), and baseline netting
  const namedByWeek = new Array(HORIZON_WEEKS).fill(0);
  for (const d of drivers) {
    namedByWeek[d.line.requiredWeek] += d.footageFt * d.line.p;
  }
  // Named demand CONSUMES the historical baseline: take the greater, not the sum.
  const baselineNetByWeek = namedByWeek.map((named) =>
    Math.max(0, material.baselineWeeklyFt - named),
  );

  const receiptsByWeek = new Array(HORIZON_WEEKS).fill(0);
  for (const po of material.onOrder) {
    if (po.week < HORIZON_WEEKS) receiptsByWeek[po.week] += po.footageFt;
  }

  // ---- Monte Carlo: Bernoulli draw per driver, lognormal-ish baseline noise
  const pathsByWeek: number[][] = Array.from(
    { length: HORIZON_WEEKS },
    () => [] as number[],
  );
  let stockoutCount = 0;
  let breachCount = 0;
  const endingBalances: number[] = [];

  for (let s = 0; s < scenarios; s++) {
    let onHand = material.onHandFt;
    let hitZero = false;
    let hitSafety = false;

    for (let w = 0; w < HORIZON_WEEKS; w++) {
      let demand = 0;
      for (const d of drivers) {
        if (d.line.requiredWeek === w && rand() < d.line.p) {
          demand += d.footageFt;
        }
      }
      // baseline noise
      const base = baselineNetByWeek[w]!;
      if (base > 0) {
        const noise = 1 + (rand() - 0.5) * 2 * material.baselineCv;
        demand += Math.max(0, base * noise);
      }
      onHand += receiptsByWeek[w]! - demand;
      if (onHand < 0) hitZero = true;
      if (onHand < material.safetyStockFt) hitSafety = true;
      pathsByWeek[w]!.push(onHand);
    }
    if (hitZero) stockoutCount++;
    if (hitSafety) breachCount++;
    endingBalances.push(onHand);
  }

  const weeks: WeekStat[] = [];
  for (let w = 0; w < HORIZON_WEEKS; w++) {
    const sorted = [...pathsByWeek[w]!].sort((a, b) => a - b);
    const p10 = quantile(sorted, 0.1);
    const p50 = quantile(sorted, 0.5);
    const p90 = quantile(sorted, 0.9);
    weeks.push({
      week: w,
      p10,
      p50,
      p90,
      bandLo: p10,
      bandSpan: Math.max(0, p90 - p10),
      expectedDemand: namedByWeek[w]! + baselineNetByWeek[w]!,
      namedDemand: namedByWeek[w]!,
      baselineNet: baselineNetByWeek[w]!,
      receipts: receiptsByWeek[w]!,
      safetyStock: material.safetyStockFt,
    });
  }

  const firstBreachWeek =
    weeks.find((x) => x.p50 < material.safetyStockFt)?.week ?? null;

  // ---- excess: mean positive leftover above safety stock at horizon
  const excessSamples = endingBalances.map((b) =>
    Math.max(0, b - material.safetyStockFt),
  );
  const expectedExcessFt =
    excessSamples.reduce((a, b) => a + b, 0) / excessSamples.length;
  const msiPerFt = (12 * material.masterWidthIn) / 1000;
  const expectedExcessUsd = expectedExcessFt * msiPerFt * material.costMsi;

  // ---- recommendation: cover the service-level quantile shortfall
  const sortedEnd = [...endingBalances].sort((a, b) => a - b);
  const slBalance = quantile(sortedEnd, 1 - serviceLevel);
  const shortfall = Math.max(0, material.safetyStockFt - slBalance);
  const recommendRolls =
    shortfall > 0 ? Math.ceil(shortfall / material.typicalRollFt) : 0;
  const recommendFt = recommendRolls * material.typicalRollFt;
  const recommendUsd = recommendFt * msiPerFt * material.costMsi;

  const leadWeeks = Math.ceil(material.leadTimeDays / 7);
  const orderByWeek =
    firstBreachWeek === null ? null : Math.max(0, firstBreachWeek - leadWeeks);

  // ---- pooling classification, computed not tagged
  const distinctCustomers = new Set(drivers.map((d) => d.line.customer)).size;
  const distinctDeals = drivers.length;
  const weeklyTotals = weeks.map((x) => x.expectedDemand);
  const mean =
    weeklyTotals.reduce((a, b) => a + b, 0) / Math.max(1, weeklyTotals.length);
  const variance =
    weeklyTotals.reduce((a, b) => a + (b - mean) ** 2, 0) /
    Math.max(1, weeklyTotals.length);
  const demandCv = mean > 0 ? Math.sqrt(variance) / mean : 0;

  let pooling: PoolingClass;
  if (material.isCustom || distinctCustomers <= 1) pooling = "UNPOOLED";
  else if (
    distinctCustomers >= 3 ||
    (distinctCustomers >= 2 && material.alternateStockIds.length > 0)
  )
    pooling = "POOLED";
  else pooling = "SEMI_POOLED";

  // ---- exposure if non-firm drivers die
  const exposureUsd = drivers
    .filter((d) => d.line.p < 0.9)
    .reduce(
      (a, d) => a + d.footageFt * (1 - d.line.p) * msiPerFt * material.costMsi,
      0,
    );
  const absorbWeeks =
    material.baselineWeeklyFt > 0
      ? Math.round(expectedExcessFt / material.baselineWeeklyFt)
      : null;

  return {
    material,
    weeks,
    pStockout: stockoutCount / scenarios,
    pBreachSafety: breachCount / scenarios,
    firstBreachWeek,
    expectedExcessFt,
    expectedExcessUsd,
    recommendFt,
    recommendRolls,
    recommendUsd,
    orderByWeek,
    pooling,
    distinctCustomers,
    distinctDeals,
    demandCv,
    drivers,
    exposureUsd,
    absorbWeeks,
  };
}

export function buildAllForecasts(
  opts: { scenarios?: number; serviceLevel?: number } = {},
): MaterialForecast[] {
  return MATERIALS.map((m, i) =>
    buildForecast(m, DEMAND_LINES, { ...opts, seed: 20260803 + i * 7919 }),
  );
}

/* ---------------------------------------------------------------------------
 * Double-count demonstration
 * ------------------------------------------------------------------------- */

export function doubleCountDelta(): {
  stockId: string;
  correctFt: number;
  stackedFt: number;
  wastedFt: number;
  wastedUsd: number;
  dealRef: string;
  soRef: string;
} {
  const deal = DEMAND_LINES.find((l) => l.id === "L05")!;
  const so = DEMAND_LINES.find((l) => l.id === "L02")!;
  const stockId = "206";
  const dealFt = deal.stockDemand.find((s) => s.stockId === stockId)!.footageFt;
  const soFt = so.stockDemand.find((s) => s.stockId === stockId)!.footageFt;
  const material = MATERIALS.find((m) => m.stockId === stockId)!;
  const msiPerFt = (12 * material.masterWidthIn) / 1000;

  const correctFt = soFt * so.p;
  const stackedFt = soFt * so.p + dealFt * deal.p;
  const wastedFt = stackedFt - correctFt;
  return {
    stockId,
    correctFt,
    stackedFt,
    wastedFt,
    wastedUsd: wastedFt * msiPerFt * material.costMsi,
    dealRef: deal.ref,
    soRef: so.ref,
  };
}
