/**
 * Forecasting v2 — quote specs → construction → material requirement.
 *
 * FIELD SHAPES AND FILL RATES are from a live read of Calyx HubSpot portal
 * 6712259, object `Pre Order Support Request` (2-52567425, 270 properties,
 * 1,722 records):
 *
 *   product_width / product_height ...... 98% filled
 *   quantity_needed ..................... 68%
 *   die_tool ............................ 55%
 *   flexible_packaging_substrate ........ 50%
 *   label_substrate / label_finish ...... 47%
 *   copy_position ....................... 47%
 *   column_spacing / row_spacing ......... 0%   ← never filled
 *   number_across / number_around ........ 0%   ← never filled
 *
 * THREE PRINCIPLES THIS FILE ENFORCES
 *
 * 1. Spoilage curves and make-ready are NOT tunable knobs. They are engineering
 *    assumptions already held on LabelTraxx equipment records. They arrive as
 *    data, with provenance, and the forecast reports them rather than guessing.
 *
 * 2. NOTHING IS COUNTED TWICE. A quote and the sales order it became are the
 *    same demand. Consumption is explicit, audited, and additionally defended
 *    by fuzzy matching for the dangerous case where the link has not been
 *    written back to HubSpot yet.
 *
 * 3. A single number is not a forecast. Every stock gets an interval — the
 *    floor if only firm orders land, the ceiling if every open quote lands —
 *    because that band is what tells you which direction the stock is heading.
 */

/* ===========================================================================
 * SECTION 1 — LabelTraxx equipment records (authoritative, not adjustable)
 * ========================================================================= */

export interface SpoilageBracket {
  lowFt: number;
  /** 0 = unbounded top bracket. */
  highFt: number;
  pct: number;
}

export interface EquipmentRecord {
  /** LabelTraxx equipment code. */
  ltCode: string;
  label: string;
  /** Order in the machine chain. */
  seq: number;
  isPrint: boolean;
  /** MINIMUMSTOCKSPOILAGE on the LT record. */
  minSpoilagePct: number | null;
  /** Base make-ready length, ft. */
  baseSetupFt: number;
  /** Added make-ready per colour change, ft. */
  colourChangeFt: number;
  /** Added make-ready per tool/plate change, ft. */
  plateChangeFt: number;
  /** Single-bracket lookup, per the validated LT rule — never a banded sum. */
  spoilageCurve: SpoilageBracket[];
  /** Where these numbers came from, shown in the UI. */
  provenance: string;
}

/**
 * Sourced from LabelTraxx equipment records. These are Calyx engineering
 * assumptions, already validated against real runs — the forecast consumes
 * them, it does not second-guess them.
 */
export const EQUIPMENT: EquipmentRecord[] = [
  {
    ltCode: "HP6900",
    label: "Press — HP 6900",
    seq: 1,
    isPrint: true,
    minSpoilagePct: null,
    baseSetupFt: 150,
    colourChangeFt: 25,
    plateChangeFt: 0,
    spoilageCurve: [
      { lowFt: 0, highFt: 1000, pct: 12 },
      { lowFt: 1000, highFt: 5000, pct: 6 },
      { lowFt: 5000, highFt: 0, pct: 3 },
    ],
    provenance: "LT equipment HP6900 · spoilage curve + make-ready",
  },
  {
    ltCode: "THERMO",
    label: "Laminate — Thermo",
    seq: 2,
    isPrint: false,
    minSpoilagePct: 2,
    baseSetupFt: 100,
    colourChangeFt: 0,
    plateChangeFt: 0,
    spoilageCurve: [
      { lowFt: 0, highFt: 2000, pct: 8 },
      { lowFt: 2000, highFt: 0, pct: 2.5 },
    ],
    provenance: "LT equipment THERMO · MINIMUMSTOCKSPOILAGE 2%",
  },
  {
    ltCode: "ABG_A",
    label: "Die / finish — ABG A",
    seq: 3,
    isPrint: false,
    minSpoilagePct: 2,
    baseSetupFt: 120,
    colourChangeFt: 0,
    plateChangeFt: 30,
    spoilageCurve: [
      { lowFt: 0, highFt: 1500, pct: 9 },
      { lowFt: 1500, highFt: 0, pct: 3 },
    ],
    provenance: "LT equipment ABG A · plate change 30 ft",
  },
];

/** Job-level allowances, also held in LT / the estimating standards. */
export const STANDARDS = {
  /** Gap between columns across the web. HubSpot never supplies it. */
  columnSpacingIn: 0.125,
  /** Gap between rows down the web. HubSpot never supplies it. */
  rowSpacingIn: 0.125,
  usableWebWidthIn: 12.5,
  maxRepeatIn: 24,
  /** Extra run length for stock flagged hard-to-run on its LT record. */
  hardToRunUpliftPct: 3,
  /** Extra die make-ready when a new tool has to be dialled in. */
  newDieSetupFt: 250,
  /** Colour count assumed when the quote is silent. */
  assumedColours: 4,
  provenance: "Estimating standards · LT stock flags",
} as const;

/* ===========================================================================
 * SECTION 2 — Copy position (HubSpot "Copy N" ↔ LabelTraxx)
 * ========================================================================= */

export const COPY_POSITION_BY_INDEX = [
  "OUT_TOP_1",
  "OUT_BTM_2",
  "OUT_RIGHT_3",
  "OUT_LEFT_4",
  "IN_TOP_5",
  "IN_BTM_6",
  "IN_RIGHT_7",
  "IN_LEFT_8",
] as const;

export type LtCopyPosition = (typeof COPY_POSITION_BY_INDEX)[number];
export const DEFAULT_COPY_POSITION: LtCopyPosition = "OUT_BTM_2";

export function ltCopyPosition(v: string | null): LtCopyPosition | null {
  if (!v) return null;
  const m = /^Copy\s*(\d)$/i.exec(v.trim());
  return m ? (COPY_POSITION_BY_INDEX[Number(m[1]) - 1] ?? null) : null;
}

/** LEFT/RIGHT rotate the label 90°, swapping which edge runs down-web. */
export function swapsDimensions(cp: LtCopyPosition): boolean {
  return cp === "OUT_LEFT_4" || cp === "OUT_RIGHT_3" || cp === "IN_LEFT_8" || cp === "IN_RIGHT_7";
}

/* ===========================================================================
 * SECTION 3 — Roll stock, and the substrate → stock map
 * ========================================================================= */

export interface Stock {
  stockId: string;
  description: string;
  supplierName: string;
  masterWidthIn: number;
  costMsi: number;
  /** Median measured order→receipt, days. */
  leadTimeDays: number;
  /** Spread on that lead time, days. */
  leadTimeSigmaDays: number;
  onHandFt: number;
  safetyStockFt: number;
  reorderPointFt: number;
  typicalRollFt: number;
  /** Flagged hard-to-run on the LT stock record. */
  hardToRun: boolean;
  isCustom: boolean;
}

export const STOCKS: Record<string, Stock> = {
  "73": { stockId: "73", description: "Clear 1 mil BOPP / S692N / 40# SCK", supplierName: "Assem-Pak", masterWidthIn: 12.5, costMsi: 3.5, leadTimeDays: 28, leadTimeSigmaDays: 6, onHandFt: 24000, safetyStockFt: 14000, reorderPointFt: 22000, typicalRollFt: 4000, hardToRun: false, isCustom: false },
  "88": { stockId: "88", description: "White BOPP / Perm Acrylic / 40# SCK", supplierName: "Assem-Pak", masterWidthIn: 12.5, costMsi: 3.62, leadTimeDays: 28, leadTimeSigmaDays: 7, onHandFt: 38000, safetyStockFt: 15000, reorderPointFt: 24000, typicalRollFt: 4000, hardToRun: false, isCustom: false },
  "206": { stockId: "206", description: "Silver METPET 0.5 mil / 3.0 mil LLDPE", supplierName: "Compax Packaging", masterWidthIn: 13, costMsi: 4.18, leadTimeDays: 42, leadTimeSigmaDays: 11, onHandFt: 54000, safetyStockFt: 12000, reorderPointFt: 26000, typicalRollFt: 5000, hardToRun: true, isCustom: false },
  "195": { stockId: "195", description: "Direct Thermal Paper / S2045N / 44# Liner", supplierName: "Compax Packaging", masterWidthIn: 13, costMsi: 2.05, leadTimeDays: 21, leadTimeSigmaDays: 4, onHandFt: 19000, safetyStockFt: 9000, reorderPointFt: 14000, typicalRollFt: 6000, hardToRun: false, isCustom: false },
  "512": { stockId: "512", description: "Gloss Lamination 1.2 mil OPP", supplierName: "Assem-Pak", masterWidthIn: 13, costMsi: 1.64, leadTimeDays: 18, leadTimeSigmaDays: 3, onHandFt: 96000, safetyStockFt: 28000, reorderPointFt: 44000, typicalRollFt: 8000, hardToRun: false, isCustom: false },
  "514": { stockId: "514", description: "Matte Lamination 1.2 mil OPP", supplierName: "Assem-Pak", masterWidthIn: 13, costMsi: 1.71, leadTimeDays: 18, leadTimeSigmaDays: 3, onHandFt: 41000, safetyStockFt: 16000, reorderPointFt: 26000, typicalRollFt: 8000, hardToRun: false, isCustom: false },
  "887": { stockId: "887", description: "CUSTOM — Holographic BOPP 2 mil", supplierName: "Carter Distribution", masterWidthIn: 13, costMsi: 11.4, leadTimeDays: 63, leadTimeSigmaDays: 18, onHandFt: 0, safetyStockFt: 0, reorderPointFt: 0, typicalRollFt: 3000, hardToRun: true, isCustom: true },
  "902": { stockId: "902", description: "Clear PET High Barrier 3.0 mil", supplierName: "Compax Packaging", masterWidthIn: 13, costMsi: 5.2, leadTimeDays: 49, leadTimeSigmaDays: 14, onHandFt: 22000, safetyStockFt: 6000, reorderPointFt: 15000, typicalRollFt: 4000, hardToRun: false, isCustom: false },
};

export const SUBSTRATE_TO_STOCK: Record<string, string> = {
  "Clear BOPP": "73",
  "White BOPP": "88",
  "Silver / Metallic BOPP": "206",
  "Holographic BOPP": "887",
  "Direct Thermal Paper": "195",
  "Thermal Transfer Paper": "195",
  "Metalized PET (METPET)": "206",
  "Flooded White Metalized PET (WMETPET)": "206",
  "Standard Clear PET": "902",
  "High Barrier Clear PET": "902",
};

/** Varnish consumes no web, so it maps to null. */
export const FINISH_TO_STOCK: Record<string, string | null> = {
  "Gloss Laminate": "512",
  "Matte Laminate": "514",
  "Soft Touch Laminate": "514",
  "Matte Varnish": null,
  "Gloss Varnish": null,
};

/* ===========================================================================
 * SECTION 4 — Geometry, verbatim from the PackOS kernel
 * ========================================================================= */

const TWELVE = 12;

export interface Layout {
  copyPosition: LtCopyPosition;
  copyPositionAssumed: boolean;
  swapped: boolean;
  effectiveAcrossIn: number;
  effectiveAroundIn: number;
  noAcross: number;
  noAround: number;
  repeatIn: number;
  requiredRunWidthIn: number;
  gearTeeth: number;
}

export function deriveLayout(
  widthIn: number,
  heightIn: number,
  hubspotCopyPosition: string | null,
  webWidthIn: number,
): Layout {
  const resolved = ltCopyPosition(hubspotCopyPosition);
  const cp = resolved ?? DEFAULT_COPY_POSITION;
  const swap = swapsDimensions(cp);
  const across = swap ? heightIn : widthIn;
  const around = swap ? widthIn : heightIn;

  const web = webWidthIn > 0 ? webWidthIn : STANDARDS.usableWebWidthIn;
  const denom = across + STANDARDS.columnSpacingIn;
  // +1 is the first label; the gap applies only BETWEEN labels.
  const noAcross = across > 0 && across <= web ? Math.max(0, Math.floor((web - across) / denom) + 1) : 0;
  const repeatIn = around + STANDARDS.rowSpacingIn;
  const noAround = repeatIn > 0 ? Math.max(1, Math.floor(STANDARDS.maxRepeatIn / repeatIn)) : 0;

  return {
    copyPosition: cp,
    copyPositionAssumed: resolved === null,
    swapped: swap,
    effectiveAcrossIn: across,
    effectiveAroundIn: around,
    noAcross,
    noAround,
    repeatIn,
    requiredRunWidthIn: across * noAcross + STANDARDS.columnSpacingIn * Math.max(0, noAcross - 1),
    gearTeeth: Math.round((repeatIn * noAround) / 0.125),
  };
}

/** ceil() — a partial row still costs a whole repeat. */
export function goodLengthFt(qty: number, noAcross: number, repeatIn: number): number {
  if (!(noAcross > 0) || !(repeatIn > 0)) return 0;
  return (Math.ceil(qty / noAcross) * repeatIn) / TWELVE;
}

function bracketPct(curve: SpoilageBracket[], lengthFt: number): number {
  for (const b of curve) {
    if (lengthFt >= b.lowFt && (!b.highFt || lengthFt <= b.highFt)) return b.pct;
  }
  return 0;
}

export interface PassResult {
  ltCode: string;
  label: string;
  linearFt: number;
  spoilageFt: number;
  spoilagePct: number;
  spoilageFloored: boolean;
  setupFt: number;
  totalFt: number;
  provenance: string;
}

export interface FootageBuildUp {
  goodFt: number;
  passes: PassResult[];
  /** max(passFt) — the same web travels through every station. */
  requiredFt: number;
  drivingPass: string;
  upliftVsGood: number;
  makeReadyFt: number;
}

/**
 * NOTE: goodLengthFt uses ceil(qty/noAcross); linearFt uses PLAIN division.
 * Deliberate, and it matches LabelTraxx. Do not reconcile them.
 */
export function buildFootage(
  qty: number,
  layout: Layout,
  opts: { hardToRun: boolean; newDie: boolean; colours: number },
): FootageBuildUp {
  const good = goodLengthFt(qty, layout.noAcross, layout.repeatIn);

  const passes: PassResult[] = EQUIPMENT.map((eq) => {
    const base = ((qty / Math.max(1, layout.noAcross)) * layout.repeatIn) / TWELVE;
    const linearFt = base * (1 + (opts.hardToRun ? STANDARDS.hardToRunUpliftPct : 0) / 100);
    const raw = bracketPct(eq.spoilageCurve, linearFt);
    const floored = eq.minSpoilagePct != null && raw < eq.minSpoilagePct;
    const pct = floored ? eq.minSpoilagePct! : raw;
    const setupFt =
      eq.baseSetupFt +
      eq.colourChangeFt * (eq.isPrint ? opts.colours : 0) +
      eq.plateChangeFt * (eq.isPrint ? 0 : 1) +
      (opts.newDie && eq.ltCode === "ABG_A" ? STANDARDS.newDieSetupFt : 0);
    const spoilageFt = linearFt * (pct / 100);
    return {
      ltCode: eq.ltCode,
      label: eq.label,
      linearFt,
      spoilageFt,
      spoilagePct: pct,
      spoilageFloored: floored,
      setupFt,
      totalFt: linearFt + spoilageFt + setupFt,
      provenance: eq.provenance,
    };
  });

  const driving = passes.reduce((m, p) => (p.totalFt > m.totalFt ? p : m), passes[0]!);
  return {
    goodFt: good,
    passes,
    requiredFt: driving.totalFt,
    drivingPass: driving.label,
    upliftVsGood: good > 0 ? driving.totalFt / good - 1 : 0,
    makeReadyFt: passes.reduce((a, p) => a + p.setupFt, 0),
  };
}

/* ===========================================================================
 * SECTION 5 — Demand records. Quotes AND sales orders in one ledger, so
 * consumption can be enforced in one place.
 * ========================================================================= */

export type DemandSource = "QUOTE" | "SALES_ORDER";
export type SpecTier = "SPECCED" | "ORIENTATION_UNKNOWN" | "MATERIAL_ONLY" | "UNSPECCED";

export interface DemandRecord {
  id: string;
  source: DemandSource;
  /** HubSpot quote name, or the NetSuite SO number. */
  ref: string;
  itemName: string;
  customer: string;
  rep: string;
  dealStage: string;
  stageProbability: number;
  closeStatus: "Expect" | "Best Case" | "Opportunity";
  amountUsd: number;
  estimatingStage: string;
  requiredWeek: number;
  /** On a QUOTE: the SO it became, once HubSpot has been written back. */
  netsuiteSo: string | null;
  /** Specs (HubSpot Pre Order Support field names in comments). */
  widthIn: number | null;   // product_width
  heightIn: number | null;  // product_height
  copyPosition: string | null; // copy_position
  qty: number | null;       // quantity_needed
  labelSubstrate: string | null;
  labelFinish: string | null;
  flexSubstrate: string | null;
  flexFinish: string | null;
  dieTool: string | null;
  newDieNeeded: boolean;
  colours: number | null;
  /* --- signals borrowed from Gap-to-Goal --- */
  /** Which EMPIRICAL_P family this deal sits in. */
  pipelineFamily: "Acquisition" | "Retention" | "Growth";
  /** Days since last activity. Drives the decay curve. */
  activityDaysAgo: number | null;
  /** Ship signals — operational, and a better fit for material than revenue. */
  ltTicketExists: boolean;
  paymentHold: boolean;
  /** Days between promised and projected ship date. >3 is a soft warning. */
  promiseDriftDays: number;
  closeDateSlipped: boolean;
  /** True when the job ships next quarter. Material still needed — see notes. */
  shipsNextQuarter: boolean;
}

const Q = (o: Partial<DemandRecord> & Pick<DemandRecord, "id" | "ref" | "itemName" | "customer" | "rep" | "requiredWeek">): DemandRecord => ({
  source: "QUOTE",
  dealStage: "Negotiation",
  stageProbability: 0.7,
  closeStatus: "Expect",
  amountUsd: 0,
  estimatingStage: "Quote Completed",
  netsuiteSo: null,
  widthIn: null, heightIn: null, copyPosition: null, qty: null,
  labelSubstrate: null, labelFinish: null, flexSubstrate: null, flexFinish: null,
  dieTool: null, newDieNeeded: false, colours: null,
  pipelineFamily: "Retention",
  activityDaysAgo: 4,
  ltTicketExists: false,
  paymentHold: false,
  promiseDriftDays: 0,
  closeDateSlipped: false,
  shipsNextQuarter: false,
  ...o,
} as DemandRecord);

export const DEMAND: DemandRecord[] = [
  // ---- Quotes still purely in HubSpot -----------------------------------
  Q({ pipelineFamily: "Retention", activityDaysAgo: 5, promiseDriftDays: 0, id: "Q1", ref: "CQ-59729800492", itemName: "CQ-Pure Buds-Labels-4.6 x 1.45", customer: "Pure Buds", rep: "Jake Lynch",
      dealStage: "Negotiation", stageProbability: 0.7, closeStatus: "Expect", amountUsd: 18400, estimatingStage: "Quote Completed",
      requiredWeek: 4, widthIn: 4.6, heightIn: 1.45, copyPosition: "Copy 4", qty: 5000,
      labelSubstrate: "Silver / Metallic BOPP", labelFinish: "Matte Laminate", newDieNeeded: true, colours: 4 }),

  Q({ pipelineFamily: "Retention", activityDaysAgo: 3, ltTicketExists: true, id: "Q3", ref: "BURN-FL-1926-PRLB", itemName: "BURN-FL-1926-PRLB", customer: "Burn Florida", rep: "Brad Sherman",
      dealStage: "Standard Reorder - Confirmed by Customer", stageProbability: 0.9, closeStatus: "Expect", amountUsd: 41000,
      estimatingStage: "Quote Accepted", requiredWeek: 3, widthIn: 3.375, heightIn: 2.25, copyPosition: "Copy 3", qty: 120000,
      labelSubstrate: "White BOPP", labelFinish: "Matte Laminate", dieTool: "1926", colours: 6 }),

  // copy_position blank — the 53% case → interval, not a point
  Q({ pipelineFamily: "Growth", activityDaysAgo: 26, id: "Q4", ref: "CQ-59730112004", itemName: "CQ-Choice Labs-Labels-4.25 x 6.5", customer: "Choice Labs", rep: "Dave Borkowski",
      dealStage: "Confirm Solution", stageProbability: 0.6, closeStatus: "Best Case", amountUsd: 31200, estimatingStage: "In Progress",
      requiredWeek: 6, widthIn: 4.25, heightIn: 6.5, copyPosition: null, qty: 40000,
      labelSubstrate: "Clear BOPP", labelFinish: "Gloss Laminate", newDieNeeded: true }),

  Q({ pipelineFamily: "Acquisition", activityDaysAgo: 6, shipsNextQuarter: true, id: "Q5", ref: "CQ-59730880311", itemName: "CQ-Sun Theory-Flex-8.375 x 12", customer: "Sun Theory", rep: "Jake Lynch",
      dealStage: "Design Request Sent", stageProbability: 0.8, closeStatus: "Expect", amountUsd: 118500, estimatingStage: "Quote Completed",
      requiredWeek: 8, widthIn: 8.375, heightIn: 12, copyPosition: "Copy 2", qty: 55000,
      flexSubstrate: "Metalized PET (METPET)", flexFinish: "Gloss Laminate", colours: 8 }),

  // quantity blank — material named, no footage
  Q({ pipelineFamily: "Acquisition", activityDaysAgo: 52, id: "Q6", ref: "CQ-59730440190", itemName: "CQ-Northside-Labels-3.0 x 2.0", customer: "Northside Cultivation", rep: "Brad Sherman",
      dealStage: "Qualification - Sample Kit Sent", stageProbability: 0.4, closeStatus: "Opportunity", amountUsd: 24000,
      estimatingStage: "Pending Information", requiredWeek: 9, widthIn: 3.0, heightIn: 2.0, copyPosition: null, qty: null,
      labelSubstrate: "White BOPP", labelFinish: "Gloss Laminate", newDieNeeded: true }),

  Q({ pipelineFamily: "Retention", activityDaysAgo: 9, id: "Q7", ref: "CQ-59730551827", itemName: "CQ-Ember-Labels-2.5 x 2.0", customer: "Ember Cannabis", rep: "Max Shaw",
      dealStage: "Standard Reorder - Pending Customer Confirmation", stageProbability: 0.6, closeStatus: "Expect", amountUsd: 22600,
      estimatingStage: "Quote Completed", requiredWeek: 5, widthIn: 2.5, heightIn: 2.0, copyPosition: "Copy 2", qty: 48000,
      labelSubstrate: "Clear BOPP", labelFinish: "Gloss Laminate", dieTool: "1804", colours: 4 }),

  Q({ pipelineFamily: "Acquisition", activityDaysAgo: 11, promiseDriftDays: 6, id: "Q8", ref: "CQ-59730990002", itemName: "CQ-Verdant-Labels-Holographic", customer: "Verdant Wellness", rep: "Owen Labombard",
      dealStage: "Negotiation", stageProbability: 0.7, closeStatus: "Best Case", amountUsd: 210000, estimatingStage: "Quote Completed",
      requiredWeek: 7, widthIn: 3.75, heightIn: 2.25, copyPosition: "Copy 1", qty: 150000,
      labelSubstrate: "Holographic BOPP", labelFinish: "Soft Touch Laminate", newDieNeeded: true, colours: 6 }),

  // no substrate — cannot name a material at all
  Q({ pipelineFamily: "Growth", activityDaysAgo: 18, id: "Q9", ref: "CQ-59730220447", itemName: "CQ-Harbor Extracts-Boxes", customer: "Harbor Extracts", rep: "Dave Borkowski",
      dealStage: "New Product/Price Request", stageProbability: 0.4, closeStatus: "Best Case", amountUsd: 143000,
      estimatingStage: "Request Que", requiredWeek: 10, widthIn: 5.0, heightIn: 3.5, qty: 120000 }),

  // ---- Quote that HAS become a sales order (link written back) ----------
  Q({ pipelineFamily: "Retention", activityDaysAgo: 2, ltTicketExists: true, id: "Q2", ref: "CQ-59730542688", itemName: "CQ-Curaleaf (IL)-Labels-2.6 x 1.05", customer: "Curaleaf (IL)", rep: "Jake Lynch",
      dealStage: "Sales Order Created in NS", stageProbability: 0.95, closeStatus: "Expect", amountUsd: 9200,
      estimatingStage: "Quote Accepted", requiredWeek: 2, netsuiteSo: "SO118742",
      widthIn: 2.6, heightIn: 1.05, copyPosition: "Copy 4", qty: 2500,
      labelSubstrate: "Direct Thermal Paper", labelFinish: "Matte Varnish", dieTool: "2250", colours: 2 }),

  // ---- Quote that became an SO but HubSpot was NEVER written back -------
  // The dangerous case: no netsuiteSo here, yet SO118955 below is the same
  // job. Only fuzzy matching catches this.
  Q({ pipelineFamily: "Retention", activityDaysAgo: 4, ltTicketExists: true, id: "Q10", ref: "CQ-59730771190", itemName: "CQ-Coastal-Flex-6.0 x 9.0", customer: "Coastal Botanics", rep: "Brad Sherman",
      dealStage: "Standard Reorder - Confirmed by Customer", stageProbability: 0.9, closeStatus: "Expect", amountUsd: 42800,
      estimatingStage: "Quote Accepted", requiredWeek: 4, netsuiteSo: null,
      widthIn: 6.0, heightIn: 9.0, copyPosition: "Copy 2", qty: 110000,
      flexSubstrate: "High Barrier Clear PET", flexFinish: "Matte Laminate", dieTool: "2101", colours: 8 }),

  // ---- NetSuite sales orders -------------------------------------------
  Q({ ltTicketExists: true, activityDaysAgo: 2, id: "S1", source: "SALES_ORDER", ref: "SO118742", itemName: "CQ-Curaleaf (IL)-Labels-2.6 x 1.05", customer: "Curaleaf (IL)", rep: "Jake Lynch",
      dealStage: "Pending Fulfillment", stageProbability: 0.97, closeStatus: "Expect", amountUsd: 9200,
      estimatingStage: "—", requiredWeek: 2, widthIn: 2.6, heightIn: 1.05, copyPosition: "Copy 4", qty: 2500,
      labelSubstrate: "Direct Thermal Paper", labelFinish: "Matte Varnish", dieTool: "2250", colours: 2 }),

  Q({ activityDaysAgo: 7, paymentHold: true, id: "S2", source: "SALES_ORDER", ref: "SO118955", itemName: "CQ-Coastal-Flex-6.0 x 9.0", customer: "Coastal Botanics", rep: "Brad Sherman",
      dealStage: "Pending Approval", stageProbability: 0.85, closeStatus: "Expect", amountUsd: 42800,
      estimatingStage: "—", requiredWeek: 4, widthIn: 6.0, heightIn: 9.0, copyPosition: "Copy 2", qty: 110000,
      flexSubstrate: "High Barrier Clear PET", flexFinish: "Matte Laminate", dieTool: "2101", colours: 8 }),

  Q({ ltTicketExists: true, activityDaysAgo: 5, id: "S3", source: "SALES_ORDER", ref: "SO119004", itemName: "CQ-Grove-Labels-3.0 x 2.7", customer: "Grove Collective", rep: "Dave Borkowski",
      dealStage: "Pending Fulfillment", stageProbability: 0.97, closeStatus: "Expect", amountUsd: 16800,
      estimatingStage: "—", requiredWeek: 3, widthIn: 3.0, heightIn: 2.7, copyPosition: "Copy 2", qty: 34000,
      labelSubstrate: "Direct Thermal Paper", labelFinish: "Gloss Laminate", dieTool: "1990", colours: 4 }),
];

/* ===========================================================================
 * SECTION 6 — Resolution + the double-count guard
 * ========================================================================= */

export interface Resolved {
  rec: DemandRecord;
  tier: SpecTier;
  tierReason: string;
  faceStockId: string | null;
  laminateStockId: string | null;
  layout: Layout | null;
  footage: FootageBuildUp | null;
  /** When orientation is unknown: requirement across both orientations. */
  orientationRange: { lowFt: number; highFt: number; swingPct: number } | null;
  p: number;
  pBasis: string[];
  factors: ProbFactor[];
  missing: string[];
  /* --- double-count guard --- */
  counted: boolean;
  suppressedBy: string | null;
  suppressReason: string | null;
  /** Set when a same-job match was found WITHOUT an explicit link. */
  unlinkedDuplicate: { matchRef: string; basis: string } | null;
}

/* ---------------------------------------------------------------------------
 * Borrowed from Calyx Link's Gap-to-Goal model (src/lib/gap-to-goal.ts), with
 * one correction that matters more than anything else here.
 *
 * Link's EMPIRICAL_P is documented in its own source as:
 *
 *     P(win AND ships in forecast quarter | close status, pipeline)
 *
 * That is a JOINT probability. It is right for revenue — a deal that wins but
 * ships next quarter earns no revenue this quarter. It is WRONG for material:
 * the material still gets consumed, and with a 42-day lead time you may have to
 * buy it this quarter precisely because the job ships early next.
 *
 * Link makes that explicit at gap-to-goal.ts:912 —
 *     if (d.isNextQ && !d.slipped) { p = 0; reasons.push("ships next quarter") }
 *
 * Lift that onto materials unchanged and every next-quarter deal contributes
 * ZERO material demand. Those are exactly the deals whose stock you need to
 * order now. So we divide the in-quarter ship term back out, using Link's own
 * measured baseline.
 * ------------------------------------------------------------------------- */

/** Link's measured baseline in-quarter ship factor (CLIFF_ADJ comment). */
export const IN_QUARTER_SHIP_RATE = 0.8395;

/** Link's EMPIRICAL_P, verbatim — joint P(win AND ships in quarter). n=944. */
export const EMPIRICAL_P_JOINT: Record<string, { p: number; n: number }> = {
  "Expect|Acquisition": { p: 0.7846, n: 153 },
  "Expect|Retention": { p: 0.7509, n: 360 },
  "Expect|Growth": { p: 0.5484, n: 124 },
  "Best Case|Retention": { p: 0.5302, n: 38 },
  "Best Case|Growth": { p: 0.5016, n: 82 },
  "Best Case|Acquisition": { p: 0.1661, n: 96 },
  "Opportunity|Growth": { p: 0.2956, n: 71 },
  "Opportunity|Acquisition": { p: 0.0884, n: 76 },
};

/** Decouple: P(win) ≈ P(win AND ships in Q) ÷ P(ships in Q | win). */
export function winRateForMaterial(key: string): { p: number; joint: number; n: number } | null {
  const hit = EMPIRICAL_P_JOINT[key];
  if (!hit) return null;
  return { p: Math.min(0.98, hit.p / IN_QUARTER_SHIP_RATE), joint: hit.p, n: hit.n };
}

/**
 * Activity decay, verbatim from Link (gap-to-goal.ts:177). This one transfers
 * wholesale — it measures whether a deal is alive, which is exactly as relevant
 * to material as to revenue. Their comment: "win rate collapses past 7d", from
 * 938 closed deals where anything untouched >45 days won $0 of $219,532.
 */
export function stalenessMultiplier(days: number | null): number {
  if (days === null) return 1.0;
  if (days <= 7) return 1.0;
  if (days <= 21) return 0.13;
  if (days <= 45) return 0.15;
  if (days <= 90) return 0.08;
  return 0.05;
}

export interface ProbFactor {
  name: string;
  mult: number;
  /** Where the factor comes from. */
  source: "link" | "material-specific" | "netsuite";
  note: string;
}

/** Factors deliberately NOT borrowed, and why. Rendered in the UI. */
export const EXCLUDED_FACTORS: { name: string; reason: string }[] = [
  {
    name: "Next-quarter zeroing (isNextQ → p = 0)",
    reason:
      "Revenue-only. A job shipping next quarter still consumes material — and with a 42-day lead time its stock is bought this quarter. Zeroing it would hide the demand that most needs ordering.",
  },
  {
    name: "Quarter-end cliff (CLIFF_ADJ 0.375)",
    reason:
      "Measures how sales date deals at quarter end, not whether material is consumed. A cliff-dated deal that wins uses exactly as much stock as any other.",
  },
  {
    name: "Quarter phase tiers (early / mid / final)",
    reason:
      "Weights a dollar by position in the quarter clock. Material has no quarter clock — it has a lead time.",
  },
  {
    name: "In-quarter ship term inside EMPIRICAL_P",
    reason:
      "Divided back out (÷0.8395) to recover P(win) alone. Left in, it understates material demand on every deal near a quarter boundary.",
  },
];

const CLOSE_STATUS_FALLBACK: Record<DemandRecord["closeStatus"], number> = {
  Expect: 0.78,
  "Best Case": 0.42,
  Opportunity: 0.13,
};

/** Fuzzy identity for a job: same customer, same geometry, same quantity. */
function jobKey(r: DemandRecord): string {
  return [
    r.customer.trim().toLowerCase(),
    r.widthIn ?? "?",
    r.heightIn ?? "?",
    r.qty ?? "?",
  ].join("|");
}

function resolveOne(rec: DemandRecord): Resolved {
  const missing: string[] = [];
  if (rec.widthIn == null || rec.heightIn == null) missing.push("dimensions");
  if (!rec.copyPosition) missing.push("copy_position");
  if (rec.qty == null) missing.push("quantity_needed");
  if (!rec.labelSubstrate && !rec.flexSubstrate) missing.push("substrate");

  const faceStockId =
    (rec.labelSubstrate && SUBSTRATE_TO_STOCK[rec.labelSubstrate]) ||
    (rec.flexSubstrate && SUBSTRATE_TO_STOCK[rec.flexSubstrate]) ||
    null;
  const finish = rec.labelFinish ?? rec.flexFinish ?? null;
  const laminateStockId = finish ? (FINISH_TO_STOCK[finish] ?? null) : null;

  // ---- probability: multiplicative signal chain, modelled on Gap-to-Goal's
  // tier-4 architecture (base rate × decay × ship signals), with the
  // revenue-only terms removed and the in-quarter term divided out.
  const factors: ProbFactor[] = [];
  let p: number;

  if (rec.source === "SALES_ORDER") {
    p = rec.stageProbability;
    factors.push({
      name: `NetSuite "${rec.dealStage}"`,
      mult: p,
      source: "netsuite",
      note: "Base rate from the sales-order status weighting.",
    });
  } else {
    const key = `${rec.closeStatus}|${rec.pipelineFamily}`;
    const wr = winRateForMaterial(key);
    if (wr) {
      p = wr.p;
      factors.push({
        name: `H1 win rate — ${key}`,
        mult: wr.p,
        source: "link",
        note: `Link's EMPIRICAL_P is ${(wr.joint * 100).toFixed(1)}% joint (n=${wr.n}); ÷${IN_QUARTER_SHIP_RATE} removes the in-quarter ship term to recover P(win) alone.`,
      });
    } else {
      p = CLOSE_STATUS_FALLBACK[rec.closeStatus];
      factors.push({
        name: `Fallback — ${rec.closeStatus}`,
        mult: p,
        source: "link",
        note: "No measured cell for this status × pipeline; using the status fallback.",
      });
    }
  }

  // Activity decay — borrowed wholesale.
  const decay = stalenessMultiplier(rec.activityDaysAgo);
  if (decay < 1) {
    p *= decay;
    factors.push({
      name: `${rec.activityDaysAgo}d since activity`,
      mult: decay,
      source: "link",
      note: "Link's measured decay: win rate collapses past 7 days. Applies to material because it measures whether the deal is alive at all.",
    });
  }

  // Ship signals — operationally closer to "will this job run", so arguably
  // more relevant to material than to revenue.
  if (rec.ltTicketExists) {
    const before = p;
    p = Math.max(p, 0.95);
    if (p !== before) {
      factors.push({
        name: "LabelTraxx ticket exists",
        mult: p / before,
        source: "link",
        note: "A ticket on the floor means the job is real and scheduled. Link floors this at 95%.",
      });
    }
  }
  if (rec.paymentHold) {
    p *= 0.45;
    factors.push({
      name: "Payment hold",
      mult: 0.45,
      source: "link",
      note: "Held orders convert far worse. Link applies ×0.45.",
    });
  }
  if (rec.promiseDriftDays > 3) {
    p *= 0.92;
    factors.push({
      name: `Promise vs projected drift ${rec.promiseDriftDays}d`,
      mult: 0.92,
      source: "link",
      note: "Dates disagreeing by more than 3 days signals a shaky commitment.",
    });
  }
  if (rec.closeDateSlipped) {
    p *= 0.5;
    factors.push({
      name: "Close date already passed",
      mult: 0.5,
      source: "link",
      note: "Link's PAST_DUE_ADJ. Kept because a slipped date genuinely predicts non-consumption.",
    });
  }
  if (rec.shipsNextQuarter) {
    factors.push({
      name: "Ships next quarter",
      mult: 1,
      source: "material-specific",
      note: "NOT zeroed. Link sets p = 0 here for revenue; for material the stock is still consumed, and a 42-day lead time means it is bought this quarter.",
    });
  }

  p = Math.min(1, Math.max(0.02, p));
  const pBasis = factors.map(
    (f) => `${f.name} — ×${f.mult.toFixed(2)}${f.source === "link" ? " (from Gap-to-Goal)" : f.source === "material-specific" ? " (material rule)" : ""}`,
  );
  pBasis.push(`final → ${(p * 100).toFixed(0)}%`);

  // ---- tier
  let tier: SpecTier;
  let tierReason: string;
  if (!faceStockId) {
    tier = "UNSPECCED";
    tierReason = "No substrate on the record — only a category, not a material.";
  } else if (rec.widthIn == null || rec.heightIn == null || rec.qty == null) {
    tier = "MATERIAL_ONLY";
    tierReason = `Material known, but ${missing.filter((m) => m !== "copy_position").join(" and ")} missing.`;
  } else if (!rec.copyPosition) {
    tier = "ORIENTATION_UNKNOWN";
    tierReason = "copy_position blank — requirement spans both orientations.";
  } else {
    tier = "SPECCED";
    tierReason = "Dimensions, orientation, quantity and substrate all present.";
  }

  const stock = faceStockId ? STOCKS[faceStockId] : undefined;
  let layout: Layout | null = null;
  let footage: FootageBuildUp | null = null;
  let orientationRange: Resolved["orientationRange"] = null;

  if (rec.widthIn != null && rec.heightIn != null && rec.qty != null && stock) {
    const colours = rec.colours ?? STANDARDS.assumedColours;
    layout = deriveLayout(rec.widthIn, rec.heightIn, rec.copyPosition, stock.masterWidthIn);
    footage = buildFootage(rec.qty, layout, { hardToRun: stock.hardToRun, newDie: rec.newDieNeeded, colours });

    if (!rec.copyPosition) {
      const a = deriveLayout(rec.widthIn, rec.heightIn, "Copy 2", stock.masterWidthIn);
      const b = deriveLayout(rec.widthIn, rec.heightIn, "Copy 4", stock.masterWidthIn);
      const fa = buildFootage(rec.qty, a, { hardToRun: stock.hardToRun, newDie: rec.newDieNeeded, colours }).requiredFt;
      const fb = buildFootage(rec.qty, b, { hardToRun: stock.hardToRun, newDie: rec.newDieNeeded, colours }).requiredFt;
      const lowFt = Math.min(fa, fb);
      const highFt = Math.max(fa, fb);
      orientationRange = { lowFt, highFt, swingPct: lowFt > 0 ? (highFt / lowFt - 1) * 100 : 0 };
    }
  }

  return {
    rec, tier, tierReason, faceStockId, laminateStockId, layout, footage, orientationRange,
    p, pBasis, factors, missing,
    counted: true, suppressedBy: null, suppressReason: null, unlinkedDuplicate: null,
  };
}

export interface DedupeAudit {
  suppressed: {
    ref: string;
    itemName: string;
    by: string;
    reason: string;
    footageAvoidedFt: number;
    usdAvoided: number;
    linkType: "explicit" | "fuzzy";
  }[];
  totalFootageAvoidedFt: number;
  totalUsdAvoided: number;
  /** Sales orders with no matching quote — counted once, nothing to suppress. */
  orphanSalesOrders: string[];
}

/**
 * Resolve every record, then enforce single-counting.
 *
 * A quote and the sales order it became are ONE demand. Two defences:
 *
 *   1. EXPLICIT — the quote carries netsuite_so_. Reliable, but only after
 *      someone writes it back to HubSpot.
 *   2. FUZZY — same customer, same geometry, same quantity. This is the one
 *      that catches the dangerous case, because on live open deals
 *      netsuite_so_ was empty on 25 of 25 sampled records.
 *
 * The sales order always wins: it is firmer and closer to the floor.
 */
export function resolveAll(): { resolved: Resolved[]; audit: DedupeAudit } {
  const resolved = DEMAND.map(resolveOne);

  const sos = resolved.filter((r) => r.rec.source === "SALES_ORDER");
  const soByRef = new Map(sos.map((r) => [r.rec.ref, r]));
  const soByJob = new Map(sos.map((r) => [jobKey(r.rec), r]));
  const quoteJobKeys = new Set(resolved.filter((r) => r.rec.source === "QUOTE").map((r) => jobKey(r.rec)));

  const audit: DedupeAudit = {
    suppressed: [],
    totalFootageAvoidedFt: 0,
    totalUsdAvoided: 0,
    orphanSalesOrders: sos.filter((s) => !quoteJobKeys.has(jobKey(s.rec))).map((s) => s.rec.ref),
  };

  for (const r of resolved) {
    if (r.rec.source !== "QUOTE") continue;

    let match: Resolved | undefined;
    let linkType: "explicit" | "fuzzy" | null = null;
    let reason = "";

    if (r.rec.netsuiteSo && soByRef.has(r.rec.netsuiteSo)) {
      match = soByRef.get(r.rec.netsuiteSo);
      linkType = "explicit";
      reason = `netsuite_so_ on the quote points at ${r.rec.netsuiteSo}.`;
    } else {
      const m = soByJob.get(jobKey(r.rec));
      if (m) {
        match = m;
        linkType = "fuzzy";
        reason = `Same customer, same ${r.rec.widthIn}"×${r.rec.heightIn}", same qty ${r.rec.qty?.toLocaleString()} as ${m.rec.ref} — but netsuite_so_ is blank on the quote.`;
      }
    }

    if (match && linkType) {
      r.counted = false;
      r.suppressedBy = match.rec.ref;
      r.suppressReason = reason;
      if (linkType === "fuzzy") {
        r.unlinkedDuplicate = { matchRef: match.rec.ref, basis: "customer + geometry + quantity" };
      }
      const ft = r.footage?.requiredFt ?? 0;
      audit.suppressed.push({
        ref: r.rec.ref,
        itemName: r.rec.itemName,
        by: match.rec.ref,
        reason,
        footageAvoidedFt: ft,
        usdAvoided: ft * ((12 * (r.faceStockId ? STOCKS[r.faceStockId]!.masterWidthIn : 13)) / 1000) * (r.faceStockId ? STOCKS[r.faceStockId]!.costMsi : 3),
        linkType,
      });
      audit.totalFootageAvoidedFt += ft;
    }
  }
  audit.totalUsdAvoided = audit.suppressed.reduce((a, s) => a + s.usdAvoided, 0);

  return { resolved, audit };
}

/* ===========================================================================
 * SECTION 7 — Weeks, purchase orders, promised delivery
 * ========================================================================= */

export const HORIZON_WEEKS = 13;

export interface WeekLabel {
  index: number;
  start: Date;
  short: string;
  long: string;
  isoWeek: number;
  isCurrent: boolean;
}

export function buildWeeks(today: Date): WeekLabel[] {
  const a = new Date(today);
  a.setDate(a.getDate() - ((a.getDay() + 6) % 7));
  a.setHours(0, 0, 0, 0);
  return Array.from({ length: HORIZON_WEEKS }, (_, i) => {
    const start = new Date(a);
    start.setDate(a.getDate() + i * 7);
    const jan1 = new Date(start.getFullYear(), 0, 1);
    const isoWeek = Math.ceil(((start.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
    return {
      index: i,
      start,
      short: start.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      long: `w/c ${start.toLocaleDateString("en-US", { day: "numeric", month: "short" })}`,
      isoWeek,
      isCurrent: i === 0,
    };
  });
}

export interface PurchaseOrder {
  poNumber: string;
  stockId: string;
  footageFt: number;
  /** Weeks relative to the current week. Negative = already placed. */
  orderedWeek: number;
  /** Supplier's promised lead time, days. */
  promisedLeadDays: number;
  /** Where it is now. */
  status: "in transit" | "confirmed" | "unconfirmed";
}

export const OPEN_POS: PurchaseOrder[] = [
  { poNumber: "PO 2365", stockId: "206", footageFt: 15000, orderedWeek: -3, promisedLeadDays: 42, status: "in transit" },
  { poNumber: "PO 2388", stockId: "73", footageFt: 16000, orderedWeek: -1, promisedLeadDays: 28, status: "confirmed" },
  { poNumber: "PO 2402", stockId: "195", footageFt: 12000, orderedWeek: -2, promisedLeadDays: 21, status: "in transit" },
  { poNumber: "PO 2377", stockId: "512", footageFt: 48000, orderedWeek: -1, promisedLeadDays: 18, status: "confirmed" },
  { poNumber: "PO 2410", stockId: "902", footageFt: 8000, orderedWeek: -4, promisedLeadDays: 49, status: "unconfirmed" },
];

/** Promised arrival week = ordered week + ceil(promised lead time / 7). */
export function poArrivalWeek(po: PurchaseOrder): number {
  return po.orderedWeek + Math.ceil(po.promisedLeadDays / 7);
}

/** If we placed an order this week, when would it land? */
export function orderTodayArrivalWeek(stock: Stock): number {
  return Math.ceil(stock.leadTimeDays / 7);
}

/* ===========================================================================
 * SECTION 8 — The interval. Floor if only firm demand lands, ceiling if every
 * open quote lands, and the weighted path between them.
 * ========================================================================= */

export type Scenario = "FIRM" | "EXPECTED" | "ALL";

export interface StockWeek {
  week: number;
  /**
   * Lower bound on demand: firm records only (sales orders + accepted quotes),
   * each still weighted by its own probability — a payment-held order genuinely
   * may not consume. Weighting matters for correctness, not just realism: if
   * firm demand were summed at face value it could exceed the probability-
   * weighted total, putting the "floor" above the "expected" path and breaking
   * the ordering the whole band depends on.
   */
  firmFt: number;
  /** Probability-weighted demand across everything counted. */
  expectedFt: number;
  /** Upper bound: every counted record lands in full. */
  allFt: number;
  receiptFt: number;
  receipts: { poNumber: string; footageFt: number }[];
  /** Projected on hand under each scenario. Best case = least demand. */
  ohFirm: number;
  ohExpected: number;
  ohAll: number;
  /** Recharts band helpers (ohAll is the lower edge). */
  bandLo: number;
  bandSpan: number;
  safetyStock: number;
  reorderPoint: number;
}

export type Direction = "COMFORTABLE" | "WATCH" | "DECIDE" | "ACT";

export interface StockOutlook {
  stock: Stock;
  weeks: StockWeek[];
  contributors: { r: Resolved; footageFt: number; role: "face" | "laminate" }[];
  firstBreach: { firm: number | null; expected: number | null; all: number | null };
  /** Where the interval sits relative to safety stock at the horizon. */
  direction: Direction;
  directionReason: string;
  /** Spread at horizon — the cost of the uncertainty, in feet and dollars. */
  intervalFt: number;
  intervalUsd: number;
  orderTodayArrival: number;
  /** True when ordering now still lands before the expected breach. */
  orderTodayInTime: boolean | null;
  /**
   * Last week the weighted path still holds safety stock, or null if it is
   * already below. Deliberately NOT "days of cover": dividing on-hand by an
   * average weekly demand smooths away the single large order that actually
   * causes the shortfall, and would read "comfortable" on a stock about to be
   * wiped out by one job.
   */
  coveredThroughWeek: number | null;
}

/** Accepted quotes and sales orders are treated as firm. */
function isFirm(r: Resolved): boolean {
  return r.rec.source === "SALES_ORDER" || r.rec.estimatingStage === "Quote Accepted";
}

export function buildOutlooks(resolved: Resolved[], weeks: WeekLabel[], pos = OPEN_POS): StockOutlook[] {
  const map = new Map<string, StockOutlook>();

  const ensure = (stockId: string): StockOutlook => {
    let o = map.get(stockId);
    if (!o) {
      const stock = STOCKS[stockId]!;
      o = {
        stock,
        weeks: weeks.map((w) => ({
          week: w.index, firmFt: 0, expectedFt: 0, allFt: 0, receiptFt: 0, receipts: [],
          ohFirm: 0, ohExpected: 0, ohAll: 0, bandLo: 0, bandSpan: 0,
          safetyStock: stock.safetyStockFt, reorderPoint: stock.reorderPointFt,
        })),
        contributors: [],
        firstBreach: { firm: null, expected: null, all: null },
        direction: "COMFORTABLE",
        directionReason: "",
        intervalFt: 0,
        intervalUsd: 0,
        orderTodayArrival: orderTodayArrivalWeek(stock),
        orderTodayInTime: null,
        coveredThroughWeek: null,
      };
      map.set(stockId, o);
    }
    return o;
  };

  // Only records that survived the dedupe guard contribute.
  for (const r of resolved) {
    if (!r.counted || !r.footage || !r.faceStockId) continue;
    const wk = Math.min(HORIZON_WEEKS - 1, Math.max(0, r.rec.requiredWeek));
    for (const [stockId, role] of [
      [r.faceStockId, "face"] as const,
      [r.laminateStockId, "laminate"] as const,
    ]) {
      if (!stockId || !STOCKS[stockId]) continue;
      const o = ensure(stockId);
      const ft = r.footage.requiredFt;
      o.weeks[wk]!.allFt += ft;
      o.weeks[wk]!.expectedFt += ft * r.p;
      // Weighted, so firmFt ≤ expectedFt ≤ allFt holds by construction.
      if (isFirm(r)) o.weeks[wk]!.firmFt += ft * r.p;
      o.contributors.push({ r, footageFt: ft, role });
    }
  }

  for (const po of pos) {
    if (!STOCKS[po.stockId]) continue;
    const o = ensure(po.stockId);
    const wk = poArrivalWeek(po);
    if (wk >= 0 && wk < HORIZON_WEEKS) {
      o.weeks[wk]!.receipts.push({ poNumber: po.poNumber, footageFt: po.footageFt });
      o.weeks[wk]!.receiptFt += po.footageFt;
    }
  }

  for (const o of map.values()) {
    let f = o.stock.onHandFt;
    let e = o.stock.onHandFt;
    let a = o.stock.onHandFt;
    for (const w of o.weeks) {
      f += w.receiptFt - w.firmFt;
      e += w.receiptFt - w.expectedFt;
      a += w.receiptFt - w.allFt;
      w.ohFirm = f;
      w.ohExpected = e;
      w.ohAll = a;
      w.bandLo = a;
      w.bandSpan = Math.max(0, f - a);
      if (o.firstBreach.firm === null && f < o.stock.safetyStockFt) o.firstBreach.firm = w.week;
      if (o.firstBreach.expected === null && e < o.stock.safetyStockFt) o.firstBreach.expected = w.week;
      if (o.firstBreach.all === null && a < o.stock.safetyStockFt) o.firstBreach.all = w.week;

      // Invariant the entire band depends on. Violating it means the scenarios
      // are no longer ordered, which makes the interval — and every direction
      // verdict derived from it — meaningless. Fail loudly rather than render a
      // confident, wrong picture.
      if (!(w.firmFt <= w.expectedFt + 1e-6 && w.expectedFt <= w.allFt + 1e-6)) {
        throw new Error(
          `Scenario ordering violated on stock #${o.stock.stockId} week ${w.week}: ` +
            `firm=${w.firmFt.toFixed(1)} expected=${w.expectedFt.toFixed(1)} all=${w.allFt.toFixed(1)}`,
        );
      }
    }

    const last = o.weeks[o.weeks.length - 1]!;
    const msiPerFt = (12 * o.stock.masterWidthIn) / 1000;
    o.intervalFt = Math.max(0, last.ohFirm - last.ohAll);
    o.intervalUsd = o.intervalFt * msiPerFt * o.stock.costMsi;

    // Direction: where does the whole interval sit versus safety stock?
    const ss = o.stock.safetyStockFt;
    if (last.ohAll >= ss) {
      o.direction = "COMFORTABLE";
      o.directionReason = "Even if every open quote lands, the position stays above safety stock.";
    } else if (last.ohFirm < ss) {
      o.direction = "ACT";
      o.directionReason = "Already short on firm demand alone — no combination of outcomes saves this.";
    } else if (o.firstBreach.expected !== null) {
      o.direction = "DECIDE";
      o.directionReason = "The interval straddles safety stock and the weighted path breaches — this is a judgement call.";
    } else {
      o.direction = "WATCH";
      o.directionReason = "Only the pessimistic end breaches. Worth watching, not yet worth committing.";
    }

    // Walk forward and stop at the first week the weighted path drops below
    // safety stock. No averaging, so one big job cannot hide.
    o.coveredThroughWeek = null;
    for (const w of o.weeks) {
      if (w.ohExpected < o.stock.safetyStockFt) break;
      o.coveredThroughWeek = w.week;
    }

    const breach = o.firstBreach.expected ?? o.firstBreach.all;
    o.orderTodayInTime = breach === null ? null : o.orderTodayArrival <= breach;
  }

  return [...map.values()].sort((x, y) => {
    const rank: Record<Direction, number> = { ACT: 0, DECIDE: 1, WATCH: 2, COMFORTABLE: 3 };
    return rank[x.direction] - rank[y.direction] ||
      x.stock.stockId.localeCompare(y.stock.stockId, undefined, { numeric: true });
  });
}

export function tierSummary(resolved: Resolved[]) {
  const t: Record<SpecTier, { count: number; usd: number; ft: number }> = {
    SPECCED: { count: 0, usd: 0, ft: 0 },
    ORIENTATION_UNKNOWN: { count: 0, usd: 0, ft: 0 },
    MATERIAL_ONLY: { count: 0, usd: 0, ft: 0 },
    UNSPECCED: { count: 0, usd: 0, ft: 0 },
  };
  for (const r of resolved) {
    if (!r.counted) continue;
    t[r.tier].count++;
    t[r.tier].usd += r.rec.amountUsd;
    if (r.footage) t[r.tier].ft += r.footage.requiredFt * r.p;
  }
  return t;
}
