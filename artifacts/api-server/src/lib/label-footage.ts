/**
 * Feet of material for a label or flexpack job.
 *
 * Ported from Cory's PackOS estimating-kernel extract (label-footage-calculation.ts,
 * itself mirroring shared/copy-position.ts, shared/estimating/derive-layout-counts.ts,
 * server/estimating/kernel/formulas/footage.ts). The ORDER OF OPERATIONS and every
 * ceil/floor boundary is preserved verbatim — those are what move the number.
 *
 * We only need the GOOD-LENGTH path here (sellable web), because the forecast's
 * job is "how much stock will this order want?", and the per-pass spoilage/setup
 * curves live on LT equipment records we don't pull. Good length is therefore a
 * FLOOR; callers add a spoilage allowance on top and say so.
 *
 * In practice Label Traxx has already stored `labelRepeat` and `noAcross` on the
 * product, so the layout derivation below is a FALLBACK for products where those
 * are missing — using LT's own numbers keeps us in parity by construction.
 */

const TWELVE = 12;

/** Usable web width (in) when the product doesn't tell us. */
export const USABLE_WEB_WIDTH = 12.5;
/** Press max repeat (in) when no equipment row supplies one. */
export const DEFAULT_PRESS_MAX_REPEAT_IN = 24;

export const COPY_POSITION_VALUES = [
  "OUT_TOP_1",
  "OUT_BTM_2",
  "OUT_RIGHT_3",
  "OUT_LEFT_4",
  "OUT_BLANK",
  "IN_TOP_5",
  "IN_BTM_6",
  "IN_RIGHT_7",
  "IN_LEFT_8",
  "IN_BLANK",
  "NA",
] as const;
export type CopyPosition = (typeof COPY_POSITION_VALUES)[number];
export const DEFAULT_COPY_POSITION: CopyPosition = "OUT_BTM_2";

/**
 * LEFT/RIGHT positions rotate the label 90°, swapping which edge runs down-web.
 * Wind direction (IN vs OUT) never changes footage.
 */
export function swapsDimensions(cp: CopyPosition): boolean {
  return cp === "OUT_LEFT_4" || cp === "OUT_RIGHT_3" || cp === "IN_LEFT_8" || cp === "IN_RIGHT_7";
}

export function applyCopyPositionToLayout(opts: {
  sizeAcrossIn: number;
  sizeAroundIn: number;
  copyPosition?: CopyPosition | null;
}): { effectiveAcrossIn: number; effectiveAroundIn: number; swapped: boolean } {
  const cp = opts.copyPosition ?? DEFAULT_COPY_POSITION;
  const swap = swapsDimensions(cp);
  return {
    effectiveAcrossIn: swap ? opts.sizeAroundIn : opts.sizeAcrossIn,
    effectiveAroundIn: swap ? opts.sizeAcrossIn : opts.sizeAroundIn,
    swapped: swap,
  };
}

/**
 * How many labels fit across the web. The "+1" is the first label — gaps only
 * sit BETWEEN labels, so it is not simply floor(web / (across + gap)).
 */
export function deriveNoAcross(opts: {
  effectiveAcrossIn: number;
  columnSpaceIn: number;
  webWidthIn?: number;
}): number {
  const web = opts.webWidthIn && opts.webWidthIn > 0 ? opts.webWidthIn : USABLE_WEB_WIDTH;
  const across = opts.effectiveAcrossIn;
  if (!(across > 0) || across > web) return 0;
  const denom = across + Math.max(0, opts.columnSpaceIn || 0);
  if (!(denom > 0)) return 0;
  return Math.max(0, Math.floor((web - across) / denom) + 1);
}

/**
 * Down-web pitch. CYLINDER FLOOR: when the press supplies a repeat step that
 * EXCEEDS the additive pitch, the repeat is raised to the cylinder step — the
 * extra web between labels is real consumed material.
 */
export function computeLabelRepeatIn(input: {
  effectiveAroundIn: number;
  rowSpaceIn: number;
  cylinderRepeatStepIn?: number | null;
}): { repeatIn: number; cylinderFloorApplied: boolean; additiveIn: number } {
  const additive = input.effectiveAroundIn + (input.rowSpaceIn || 0);
  const step = input.cylinderRepeatStepIn;
  if (step == null || !Number.isFinite(Number(step)) || Number(step) <= additive) {
    return { repeatIn: additive, cylinderFloorApplied: false, additiveIn: additive };
  }
  return { repeatIn: Number(step), cylinderFloorApplied: true, additiveIn: additive };
}

/**
 * GOOD LENGTH — feet of web carrying sellable product.
 *
 *   repeatsNeeded = ceil(quantity / noAcross)   ← a partial row still costs a
 *                                                 whole repeat
 *   goodLengthFt  = repeatsNeeded * repeatIn / 12
 *
 * Same shape for flexpack: LT stores the pouch's down-web dimension in
 * sizeAround / labelRepeat already (axes pre-inverted on the product record),
 * so one formula serves both once the repeat comes from LT.
 */
export function computeGoodLengthFt(quantity: number, noAcross: number, repeatIn: number): number {
  const across = noAcross > 0 ? noAcross : 1;
  const repeatsNeeded = Math.ceil(quantity / across);
  return (repeatsNeeded * repeatIn) / TWELVE;
}

/** feet × 12in × width / 1000 → MSI (for costing a forecast). */
export function feetToMsi(lengthFt: number, widthIn: number): number {
  return (lengthFt * TWELVE * widthIn) / 1000;
}

/** The construction we need off an LT product record to forecast material. */
export interface LtConstruction {
  sizeAcrossIn: number;
  sizeAroundIn: number;
  columnSpaceIn: number;
  rowSpaceIn: number;
  /** LT's own stored values — preferred over deriving. */
  labelRepeatIn: number | null;
  noAcross: number | null;
  copyPosition?: CopyPosition | null;
  /** flexPackType > 0 on the LT product. */
  isFlexpack: boolean;
  /** stockNum1..3 with their widths; blanks already filtered out. */
  stocks: { stockId: string; widthIn: number }[];
}

export interface ForecastLineResult {
  /** Per-material footage for this order line. */
  stockDemand: { stockId: string; widthIn: number; footage: number }[];
  goodLengthFt: number;
  repeatIn: number;
  noAcross: number;
  /** Set when we couldn't compute — the line is reported, never silently 0. */
  unresolvedReason: string | null;
  /** True when noAcross/repeat came from our fallback rather than LT. */
  derived: boolean;
}

/**
 * Footage this order line will need, per material.
 *
 * Every stock on the construction consumes the same web length: the film, the
 * laminate and (on a pouch) the zipper all run the length of the job. They
 * differ only in WIDTH, which is why each carries its own width for the
 * dashboard's width-aware netting.
 */
export function forecastLineFootage(
  quantity: number,
  c: LtConstruction,
  opts?: { spoilagePct?: number },
): ForecastLineResult {
  const empty = { stockDemand: [], goodLengthFt: 0, repeatIn: 0, noAcross: 0, derived: false };
  if (!(quantity > 0)) return { ...empty, unresolvedReason: "order quantity is zero" };
  if (c.stocks.length === 0) return { ...empty, unresolvedReason: "LT product lists no stock numbers" };

  // Prefer LT's stored geometry; fall back to deriving it from the dimensions.
  let repeatIn = c.labelRepeatIn && c.labelRepeatIn > 0 ? c.labelRepeatIn : 0;
  let noAcross = c.noAcross && c.noAcross > 0 ? c.noAcross : 0;
  let derived = false;

  if (!repeatIn || !noAcross) {
    derived = true;
    const layout = applyCopyPositionToLayout({
      sizeAcrossIn: c.sizeAcrossIn,
      sizeAroundIn: c.sizeAroundIn,
      copyPosition: c.copyPosition ?? null,
    });
    if (!repeatIn) {
      repeatIn = computeLabelRepeatIn({
        effectiveAroundIn: layout.effectiveAroundIn,
        rowSpaceIn: c.rowSpaceIn,
      }).repeatIn;
    }
    if (!noAcross) {
      // A pouch runs one-across on its own web unless LT says otherwise.
      noAcross = c.isFlexpack
        ? 1
        : deriveNoAcross({
            effectiveAcrossIn: layout.effectiveAcrossIn,
            columnSpaceIn: c.columnSpaceIn,
            webWidthIn: Math.max(...c.stocks.map((s) => s.widthIn), 0) || undefined,
          });
    }
  }

  if (!(repeatIn > 0)) return { ...empty, derived, unresolvedReason: "no usable repeat on the LT product" };
  if (!(noAcross > 0)) return { ...empty, derived, unresolvedReason: "label is wider than the web (no-across = 0)" };

  const goodLengthFt = computeGoodLengthFt(quantity, noAcross, repeatIn);
  // Good length excludes spoilage and make-ready; the allowance keeps the
  // forecast from being systematically short of what gets consumed.
  const uplift = 1 + Math.max(0, opts?.spoilagePct ?? 0) / 100;
  const footage = goodLengthFt * uplift;

  return {
    stockDemand: c.stocks.map((s) => ({ stockId: s.stockId, widthIn: s.widthIn, footage })),
    goodLengthFt,
    repeatIn,
    noAcross,
    unresolvedReason: null,
    derived,
  };
}
