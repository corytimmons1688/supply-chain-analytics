/**
 * HubSpot pre-order support → forward material footage. PHASE 1, READ ONLY.
 *
 * Composes two things that already exist rather than inventing a third:
 *   • @workspace/hubspot-preorder — the read-only client, the LT material map,
 *     and the ABGA / ABG3 / FLEXLAM spoilage curves.
 *   • ./label-footage — the PackOS geometry port (copy position → layout → good
 *     length). Its ceil/floor boundaries are parity-critical; nothing here
 *     re-implements them.
 *
 * No Neon tables are added (workspace hard rule). This computes on demand.
 */

import {
  loadForwardJobs,
  hubspotConfigured,
  machineFor,
  spoilageFor,
  MATERIAL_BY_ID,
  STAGE_LABEL,
  STAGE_OUTCOME,
  STAGE_PROBABILITY,
  FORWARD_STAGES,
  type NormalizedJob,
} from "@workspace/hubspot-preorder";

import {
  applyCopyPositionToLayout,
  computeGoodLengthFt,
  computeLabelRepeatIn,
  deriveNoAcross,
  USABLE_WEB_WIDTH,
  type CopyPosition,
} from "./label-footage";
import { logger } from "./logger";

/** Estimating standards HubSpot never supplies. */
const COLUMN_SPACING_IN = 0.125;
const ROW_SPACING_IN = 0.125;

export interface JobFootage {
  goodFt: number;
  /** Spoilage feet on the driving laminating pass. */
  spoilageFt: number;
  /** goodFt + spoilageFt — what to buy for this job. */
  requiredFt: number;
  spoilagePct: number;
  spoilageBracketPct: number;
  spoilageFloored: boolean;
  spoilageOutOfRange: boolean;
  machineCode: string;
  noAcross: number;
  repeatIn: number;
  swapped: boolean;
}

export interface ForecastLine extends NormalizedJob {
  footage: JobFootage | null;
  /** requiredFt × stage probability. */
  weightedFt: number;
}

/**
 * Feet for one job. Labels use the derived layout; flexpack carries its down-web
 * dimension in the pouch geometry, so noAcross is 1 and the repeat is the height.
 */
export function footageForJob(job: NormalizedJob): JobFootage | null {
  if (job.qty == null || job.qty <= 0) return null;
  if (job.widthIn == null || job.heightIn == null) return null;

  let noAcross: number;
  let repeatIn: number;
  let swapped = false;

  if (job.kind === "LABEL") {
    const cp = (job.copyPosition ?? "OUT_BTM_2") as CopyPosition;
    const eff = applyCopyPositionToLayout({
      sizeAcrossIn: job.widthIn,
      sizeAroundIn: job.heightIn,
      copyPosition: cp,
    });
    swapped = eff.swapped;
    noAcross = deriveNoAcross({
      effectiveAcrossIn: eff.effectiveAcrossIn,
      columnSpaceIn: COLUMN_SPACING_IN,
      webWidthIn: USABLE_WEB_WIDTH,
    });
    repeatIn = computeLabelRepeatIn({
      effectiveAroundIn: eff.effectiveAroundIn,
      rowSpaceIn: ROW_SPACING_IN,
      cylinderRepeatStepIn: null,
    }).repeatIn;
  } else {
    // Flexpack: one pouch across the web per lane; the pouch height is the pitch.
    noAcross = 1;
    // Real LT flexpack products carry rowSpace = 0.0 (verified on live LT data).
    repeatIn = job.heightIn;
  }

  if (!(noAcross > 0) || !(repeatIn > 0)) return null;

  const goodFt = computeGoodLengthFt(job.qty, noAcross, repeatIn);
  const machine = machineFor({
    kind: job.kind,
    embellishment: job.embellishment,
    notes: [job.notes, job.itemName],
  });
  const sp = spoilageFor(goodFt, machine);
  const spoilageFt = goodFt * (sp.appliedPct / 100);

  return {
    goodFt,
    spoilageFt,
    requiredFt: goodFt + spoilageFt,
    spoilagePct: sp.appliedPct,
    spoilageBracketPct: sp.bracketPct,
    spoilageFloored: sp.spoilageFloored,
    spoilageOutOfRange: sp.outOfRange,
    machineCode: machine.ltCode,
    noAcross,
    repeatIn,
    swapped,
  };
}

export interface StockRollup {
  ltStockId: number;
  description: string;
  kind: string;
  role: string;
  /** requiredFt by stage id. */
  byStage: Record<string, number>;
  rawFt: number;
  weightedFt: number;
  lineCount: number;
}

export interface StageRollup {
  stageId: string;
  label: string;
  outcome: string;
  probability: number;
  lineCount: number;
  rawFt: number;
  weightedFt: number;
}

export interface ForecastResult {
  generatedAt: string;
  source: {
    object: string;
    pipeline: string;
    stages: { id: string; label: string }[];
    internalOnly: true;
    readOnly: true;
  };
  totals: {
    hubspotTotal: number;
    forecastable: number;
    inReview: number;
    outOfScope: number;
    rawFt: number;
    weightedFt: number;
  };
  stages: StageRollup[];
  stocks: StockRollup[];
  lines: ForecastLine[];
  review: { job: NormalizedJob; blockers: string[] }[];
}

/** Pull HubSpot (read-only) and compute the forward footage forecast. */
export async function buildPreorderForecast(): Promise<ForecastResult> {
  const token = process.env["HUBSPOT_TOKEN"] ?? "";
  if (!hubspotConfigured(token)) {
    throw new Error("HUBSPOT_TOKEN is not configured");
  }

  const { total, jobs, review, skippedOutOfScope } = await loadForwardJobs({ token });
  logger.info(
    { total, forecastable: jobs.length, review: review.length },
    "hubspot preorder forecast: pulled",
  );

  const lines: ForecastLine[] = jobs.map((job) => {
    const footage = footageForJob(job);
    const requiredFt = footage?.requiredFt ?? 0;
    return { ...job, footage, weightedFt: requiredFt * job.probability };
  });

  // stage rollup, in the pipeline's own forward order
  const stages: StageRollup[] = FORWARD_STAGES.map((id) => {
    const inStage = lines.filter((l) => l.stageId === id);
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

  // stock rollup — substrate AND laminate both consume web length
  const stockAcc = new Map<number, StockRollup>();
  const bump = (id: number | null, l: ForecastLine) => {
    if (id == null || !l.footage) return;
    const mat = MATERIAL_BY_ID[id];
    let row = stockAcc.get(id);
    if (!row) {
      row = {
        ltStockId: id,
        description: mat?.description ?? `Stock ${id}`,
        kind: mat?.kind ?? l.kind,
        role: mat?.role ?? "SUBSTRATE",
        byStage: {},
        rawFt: 0,
        weightedFt: 0,
        lineCount: 0,
      };
      stockAcc.set(id, row);
    }
    row.byStage[l.stageId] = (row.byStage[l.stageId] ?? 0) + l.footage.requiredFt;
    row.rawFt += l.footage.requiredFt;
    row.weightedFt += l.weightedFt;
    row.lineCount += 1;
  };
  for (const l of lines) {
    bump(l.substrateStockId, l);
    bump(l.laminateStockId, l);
  }
  const stocks = [...stockAcc.values()].sort((a, b) => b.rawFt - a.rawFt);

  return {
    generatedAt: new Date().toISOString(),
    source: {
      object: "2-52567425",
      pipeline: "820783656",
      stages: FORWARD_STAGES.map((id) => ({ id, label: STAGE_LABEL[id] ?? id })),
      internalOnly: true,
      readOnly: true,
    },
    totals: {
      hubspotTotal: total,
      forecastable: jobs.length,
      inReview: review.length,
      outOfScope: skippedOutOfScope,
      rawFt: lines.reduce((a, l) => a + (l.footage?.requiredFt ?? 0), 0),
      weightedFt: lines.reduce((a, l) => a + l.weightedFt, 0),
    },
    stages,
    stocks,
    lines,
    review: review.map((job) => ({ job, blockers: job.blockers })),
  };
}
