import { db, stockGoalTable, globalGoalTable, nsForecastLineTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  fetchUsage,
  fetchOnHandByWidth,
  fetchOnHandByStock,
  fetchOpenPos,
  fetchOpenTickets,
  fetchStockInfo,
  fetchPoLeadTimes,
  fetchPoRolls,
  usageByWidthGroup,
  widthGroupKey,
  bucketHistory,
  forecastWeekly,
  monthKey,
  zForServiceLevel,
  addDaysIso,
  mean,
  stdDev,
  percentile,
  leadTimeDemandSamples,
  type RollUsageRow,
} from "./demand";
import { isMakeAndHoldPo } from "./open-po-status";
import { planningShipDate } from "./forecast-sync";
import { bucketRange } from "./cc";
import { logger } from "./logger";

/**
 * Time-phased material requirements planning, per stock AND per width.
 *
 * The report this replaces computed one reorder point and max per STOCK, from
 * pooled consumption history. Everything downstream of it is width-aware —
 * availability, the suggestion break-out, the ≤14" pool versus 30" — so a stock
 * could sit comfortably above its aggregate reorder point while one width was
 * starving. Live example: #195 needs 76,085 ft at ≤13" against 3,886 ft on hand
 * while its 30" bucket is fine. One number cannot describe both.
 *
 * So the planning grain here is the width bucket, and each bucket gets its own
 * requirements, receipts, projected balance and reorder point.
 *
 * Layout is the classic MRP block, 13 weekly periods:
 *
 *   Gross requirement      what production needs in that week
 *   Scheduled receipts     material already on order, by the week it lands
 *   Projected on hand      balance carried forward; NEGATIVE is the stockout
 *   Planned order release  what to order, back-dated by the lead time
 *
 * A negative projected balance in week N with a 34-day lead time means the order
 * had to be placed weeks ago — which is the whole point of planning this way
 * rather than waiting for on-hand to cross a threshold.
 */

/** Weeks of horizon. A quarter, so a lead time plus safety always fits. */
export const MRP_WEEKS = 13;

/** Demand sources folded into gross requirements (Cory's call, 2026-08-02). */
export interface MrpCell {
  /** Monday of the week, ISO. */
  weekStart: string;
  weekEnd: string;
  label: string;
  /** Booked open-ticket footage due this week at this width. */
  bookedFootage: number;
  /** NetSuite pending-approval forecast footage landing this week. */
  pendingFootage: number;
  /** Statistical forecast for this week from width-bucketed history. */
  statisticalFootage: number;
  /**
   * What the plan drives off: named orders (booked + pending) summed, then the
   * GREATER of that and the statistical forecast.
   *
   * The two named sources are genuinely distinct — the pending-approval sync
   * excludes any line that already has a ticket — so summing them is right. The
   * statistical forecast is not additive with them: it's derived from usage
   * history that already contains orders of exactly that kind, so adding it on
   * top would inflate every period. Taking the greater keeps the earliest
   * warning without over-buying, which is standard forecast consumption.
   */
  grossRequirement: number;
  /** Open-PO footage arriving this week (excludes unreleased make-and-hold). */
  scheduledReceipts: number;
  /** Balance after this week's receipts and requirements. Negative = stockout. */
  projectedOnHand: number;
  /** Suggested order to release this week so it lands when needed. */
  plannedOrderRelease: number;
  plannedOrderRolls: number;
  /**
   * Planned order ARRIVING this week — the receipt side of a release placed
   * leadWeeks earlier. Kept separate from plannedOrderRelease so the projected
   * balance is explainable: receipts + planned receipts − gross = projected.
   * Without it a row shows 0 on hand and a healthy projected balance with
   * nothing visible bridging the two.
   */
  plannedOrderReceipt: number;
}

export interface MrpDrivers {
  leadTimeDays: number;
  leadTimeSource: string;
  leadTimeOverridden: boolean;
  typicalRollFootage: number;
  typicalRollFootageOverridden: boolean;
  orderQuantityRolls: number | null;
  serviceLevel: number;
  /** Per-width reorder point and order-up-to level, from this width's history. */
  reorderPointFootage: number;
  maxFootage: number;
  /**
   * "history" = computed from consumption at this width. "apportioned" = this
   * width had too little history, so the stock-level figure was split by the
   * width's share of current committed demand. Worth showing: an apportioned
   * number is a guess, and #307 is a live case — all of its consumption history
   * is 30" while its tickets ask for ≤13".
   */
  reorderBasis: "history" | "apportioned" | "none";
  observations: number;
  discontinued: boolean;
  /** Substitutes in preference order, with availability at THIS width. */
  alternates: { stockId: string; description: string | null; onHandFootage: number }[];
}

export interface MrpRow {
  stockId: string;
  description: string | null;
  widthKey: string;
  widthLabel: string;
  /** Representative width (inches) for the bucket. */
  width: number;
  pooled: boolean;
  vendorName: string | null;
  openingOnHand: number;
  cells: MrpCell[];
  drivers: MrpDrivers;
  /** Week index of the first negative projected balance, or null. */
  firstShortageWeek: number | null;
  firstShortageDate: string | null;
  /** Total planned order footage across the horizon. */
  plannedTotalFootage: number;
  /**
   * Footage whose release week fell before the horizon — the lead time means it
   * needed ordering already. Shown in week 1 and flagged, because "order this
   * now" and "you are already late" are different messages.
   */
  lateReleaseFootage: number;
  /**
   * The configured order quantity was implausible (footage in a rolls field) and
   * was ignored. Surfaced so the config gets fixed rather than silently
   * distorting the plan.
   */
  orderQuantityIgnored: number | null;
  /**
   * On-order footage with no date anywhere on the PO, scheduled from the PO date
   * plus the lead time. Counted (excluding it double-buys the material) but
   * flagged, because an estimate is not a vendor commitment.
   */
  undatedReceiptFootage: number;
  /**
   * How much of this row's incoming supply sits on a make-and-hold order. Real
   * supply, but it only moves once a release is requested — so a plan that
   * depends on it depends on someone calling it in.
   */
  makeAndHoldSupplyFootage: number;
}

export interface MrpResult {
  generatedAt: string;
  weeks: { weekStart: string; weekEnd: string; label: string }[];
  rows: MrpRow[];
  /** Rows whose projected balance goes negative inside the horizon. */
  shortageCount: number;
  /** Rows with an order that needed releasing before the horizon opened. */
  lateReleaseCount: number;
  /** Stocks whose configured order quantity was implausible and ignored. */
  configWarnings: { stockId: string; orderQuantityRolls: number }[];
}

const DEFAULT_SERVICE_LEVEL = 0.95;
/** Below this, a width's own history is too thin to size a reorder point from. */
const MIN_OBSERVATIONS = 4;
/**
 * Sanity ceiling on the configured order quantity, in MASTER ROLLS.
 *
 * Nobody orders hundreds of master rolls at once, so a larger number is
 * footage typed into a rolls field — #278 currently holds 50,000, which at a
 * 10,000 ft roll became a 500-million-foot order-up-to level and a planned buy
 * to match. An implausible config has to be ignored and reported, not
 * propagated into a purchase plan.
 */
const MAX_PLAUSIBLE_ORDER_ROLLS = 500;

function todayMountainIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** The 13 weekly buckets, starting with the week containing today. */
export function mrpWeeks(todayIso: string, weeks = MRP_WEEKS): { weekStart: string; weekEnd: string; label: string }[] {
  const out: { weekStart: string; weekEnd: string; label: string }[] = [];
  let cursor = bucketRange(todayIso, "week").start;
  for (let i = 0; i < weeks; i++) {
    const r = bucketRange(cursor, "week");
    out.push({ weekStart: r.start, weekEnd: r.end, label: r.label });
    cursor = bucketRange(addDaysIso(r.end, 1), "week").start;
  }
  return out;
}

/** Which bucket a date falls in; -1 before the horizon, weeks when after. */
function weekIndexOf(dateIso: string | null, weeks: { weekStart: string; weekEnd: string }[]): number {
  if (!dateIso) return -1;
  if (dateIso < weeks[0]!.weekStart) return 0; // overdue lands in week 1
  for (let i = 0; i < weeks.length; i++) {
    if (dateIso <= weeks[i]!.weekEnd) return i;
  }
  return -1; // beyond the horizon
}

export async function buildMrp(opts: { monthsBack?: number; weeks?: number } = {}): Promise<MrpResult> {
  const todayIso = todayMountainIso();
  const weeks = mrpWeeks(todayIso, opts.weeks ?? MRP_WEEKS);
  const monthsBack = opts.monthsBack ?? 6;
  const windowEnd = todayIso;
  const windowStart = addDaysIso(todayIso, -Math.round(monthsBack * 30.44));

  const [usage, onHandByWidth, onHandByStock, openPos, tickets, stockInfo, goals, globals, poLeadTimes, poRolls, forecastLines] =
    await Promise.all([
      fetchUsage({ from: windowStart, to: windowEnd }),
      fetchOnHandByWidth(),
      fetchOnHandByStock(),
      fetchOpenPos(),
      fetchOpenTickets(),
      fetchStockInfo(),
      db.select().from(stockGoalTable),
      db.select().from(globalGoalTable).where(eq(globalGoalTable.id, "global")),
      fetchPoLeadTimes(),
      fetchPoRolls(),
      db.select().from(nsForecastLineTable),
    ]);

  const goalByStock = new Map(goals.map((g) => [g.stockId, g]));
  const serviceLevelGlobal = globals[0]?.serviceLevel ?? DEFAULT_SERVICE_LEVEL;

  const usageByStock = new Map<string, RollUsageRow[]>();
  for (const u of usage) {
    const a = usageByStock.get(u.stockId) ?? [];
    a.push(u);
    usageByStock.set(u.stockId, a);
  }
  const posByStock = new Map<string, typeof openPos>();
  for (const p of openPos) {
    const a = posByStock.get(p.stockId) ?? [];
    a.push(p);
    posByStock.set(p.stockId, a);
  }
  const ticketsByStock = new Map<string, typeof tickets>();
  for (const t of tickets) {
    const a = ticketsByStock.get(t.stockId) ?? [];
    a.push(t);
    ticketsByStock.set(t.stockId, a);
  }

  /**
   * Pending-approval demand per stock+width+week. The forecast row already
   * carries its per-material footage and a planning date (past-due pending
   * lines plan into the current week), so this only needs bucketing.
   */
  const pendingByStockWidth = new Map<string, Map<string, number[]>>();
  for (const line of forecastLines) {
    if (line.ltTicketNum || line.inferredTicketConfidence === "high") continue;
    const sd = line.stockDemand as { stocks?: { stockId: string; widthIn: number; footage: number }[] } | null;
    const plan = planningShipDate(line.expectedShipDate, todayIso);
    const wi = weekIndexOf(plan.date, weeks);
    if (wi < 0) continue;
    for (const s of sd?.stocks ?? []) {
      const key = widthGroupKey(s.widthIn);
      let byWidth = pendingByStockWidth.get(s.stockId);
      if (!byWidth) {
        byWidth = new Map();
        pendingByStockWidth.set(s.stockId, byWidth);
      }
      const arr = byWidth.get(key) ?? new Array<number>(weeks.length).fill(0);
      arr[wi] = (arr[wi] ?? 0) + s.footage;
      byWidth.set(key, arr);
    }
  }

  /** Observed lead time for a stock, mirroring the stock-level engine's rule. */
  const leadTimeFor = (stockId: string): { days: number; source: string; overridden: boolean } => {
    const goal = goalByStock.get(stockId);
    if (goal?.leadTimeDays != null && goal.leadTimeDays > 0) {
      return { days: goal.leadTimeDays, source: "override", overridden: true };
    }
    const poNumbers = new Set(poRolls.filter((r) => r.stockId === stockId).map((r) => r.poNumber));
    const days: number[] = [];
    for (const po of poNumbers) {
      const lt = poLeadTimes.get(po)?.leadTimeDays;
      if (lt != null && lt > 0) days.push(lt);
    }
    if (days.length > 0) return { days: mean(days), source: "stock history", overridden: false };
    const est = Number(stockInfo.get(stockId)?.estimatedDeliveryTime ?? 0);
    if (Number.isFinite(est) && est > 0) return { days: est, source: "Label Traxx", overridden: false };
    return { days: 30, source: "default", overridden: false };
  };

  const rows: MrpRow[] = [];

  // Plan every stock that has demand or supply — a stock with neither has
  // nothing to say, and listing it would bury the ones that do.
  const stockIds = new Set<string>([
    ...ticketsByStock.keys(),
    ...posByStock.keys(),
    ...[...pendingByStockWidth.keys()],
    ...[...onHandByWidth.keys()].filter((id) => (usageByStock.get(id) ?? []).length > 0),
  ]);

  for (const stockId of stockIds) {
    const info = stockInfo.get(stockId);
    const goal = goalByStock.get(stockId);
    if (goal?.discontinued && !(onHandByStock.get(stockId)?.footage ?? 0)) continue;
    const masterWidth = info?.masterWidth ?? 0;
    const stockUsage = usageByStock.get(stockId) ?? [];
    const usageGroups = usageByWidthGroup(stockUsage, masterWidth);
    const description = onHandByStock.get(stockId)?.description ?? null;

    // The union of every width this stock touches: what's on hand, what's on
    // order, what tickets require, and what it has historically consumed.
    const widthKeys = new Map<string, number>(); // key -> representative width
    const note = (w: number) => {
      const k = widthGroupKey(w);
      const cur = widthKeys.get(k) ?? 0;
      if (w > cur) widthKeys.set(k, w);
      else if (!widthKeys.has(k)) widthKeys.set(k, w);
    };
    for (const w of onHandByWidth.get(stockId) ?? []) note(w.width);
    for (const p of posByStock.get(stockId) ?? []) note(p.masterWidth && p.masterWidth > 0 ? p.masterWidth : masterWidth);
    for (const t of ticketsByStock.get(stockId) ?? []) note(t.requiredWidth > 0 ? t.requiredWidth : masterWidth);
    for (const u of stockUsage) note(u.widthIn && u.widthIn > 0 ? u.widthIn : masterWidth);
    for (const k of pendingByStockWidth.get(stockId)?.keys() ?? []) {
      if (!widthKeys.has(k)) widthKeys.set(k, k === "le13" ? Math.min(masterWidth || 13, 13) : Number(k));
    }
    if (widthKeys.size === 0) continue;

    const serviceLevel = serviceLevelGlobal;
    const z = zForServiceLevel(serviceLevel);
    const lead = leadTimeFor(stockId);
    const typicalRoll =
      goal?.typicalRollFootage && goal.typicalRollFootage > 0
        ? goal.typicalRollFootage
        : (() => {
            const ws = onHandByWidth.get(stockId) ?? [];
            const ft = ws.reduce((s, w) => s + w.footage, 0);
            const rolls = ws.reduce((s, w) => s + w.rolls, 0);
            return rolls > 0 ? ft / rolls : 5000;
          })();

    // Committed demand per width, used to apportion a stock-level reorder point
    // to widths whose own history is too thin to size one.
    const committedByWidth = new Map<string, number>();
    let committedTotal = 0;
    for (const t of ticketsByStock.get(stockId) ?? []) {
      const k = widthGroupKey(t.requiredWidth > 0 ? t.requiredWidth : masterWidth);
      committedByWidth.set(k, (committedByWidth.get(k) ?? 0) + t.estFootage);
      committedTotal += t.estFootage;
    }
    // Stock-level reorder point, as the fallback numerator.
    const stockDaily = bucketHistory(stockUsage, windowStart, windowEnd, "day").map((d) => d.footage);
    const stockLtd = leadTimeDemandSamples(stockDaily, lead.days);
    const stockRop = stockLtd && stockLtd.length > 0 ? percentile(stockLtd, serviceLevel) : 0;

    for (const [widthKey, repWidth] of widthKeys) {
      const wUsage = usageGroups.get(widthKey) ?? [];
      const onHandRows = (onHandByWidth.get(stockId) ?? []).filter((w) => widthGroupKey(w.width) === widthKey);
      const openingOnHand = onHandRows.reduce((s, w) => s + w.footage, 0);

      // ---- Per-width reorder point / max ----
      const daily = bucketHistory(wUsage, windowStart, windowEnd, "day").map((d) => d.footage);
      const ltd = leadTimeDemandSamples(daily, lead.days);
      const weekly = bucketHistory(wUsage, windowStart, windowEnd, "week").map((w) => w.footage);
      const avgWeekly = mean(weekly);
      let reorderPointFootage: number;
      let reorderBasis: MrpDrivers["reorderBasis"];
      if (wUsage.length >= MIN_OBSERVATIONS && ltd && ltd.length > 0) {
        reorderPointFootage = percentile(ltd, serviceLevel);
        reorderBasis = "history";
      } else if (committedTotal > 0 && stockRop > 0) {
        // Too little history at this width. Split the stock-level figure by the
        // width's share of what tickets currently ask for — better than zero,
        // which would say "never reorder", and better than the stock-level
        // number, which would over-stock every width.
        const share = (committedByWidth.get(widthKey) ?? 0) / committedTotal;
        reorderPointFootage = stockRop * share;
        reorderBasis = share > 0 ? "apportioned" : "none";
      } else {
        reorderPointFootage = 0;
        reorderBasis = "none";
      }
      // Order-up-to = reorder point + one order quantity, same shape as the
      // stock-level engine's max.
      const rawOrderQty = goal?.orderQuantityRolls ?? 0;
      const orderQtyImplausible = rawOrderQty > MAX_PLAUSIBLE_ORDER_ROLLS;
      if (orderQtyImplausible) {
        logger.warn(
          { stockId, orderQuantityRolls: rawOrderQty },
          "Ignoring implausible order quantity — looks like footage in a rolls field",
        );
      }
      const orderQtyRolls = rawOrderQty > 0 && !orderQtyImplausible ? rawOrderQty : null;
      const orderCycleFootage = orderQtyRolls ? orderQtyRolls * typicalRoll : Math.max(avgWeekly * 4, typicalRoll);
      const maxFootage = reorderPointFootage + orderCycleFootage;

      // ---- Statistical forecast for this width ----
      const monthly = new Map<string, number>();
      for (const u of wUsage) monthly.set(monthKey(u.dateUsed), (monthly.get(monthKey(u.dateUsed)) ?? 0) + u.footage);
      const statPoints = forecastWeekly(
        monthly,
        weeks.length,
        weeks[0]!.weekStart,
        goal?.seasonalityW1 != null && goal.seasonalityW2 != null && goal.seasonalityW3 != null
          ? [goal.seasonalityW1, goal.seasonalityW2, goal.seasonalityW3]
          : null,
      );

      // ---- Booked ticket demand per week ----
      const booked = new Array<number>(weeks.length).fill(0);
      for (const t of ticketsByStock.get(stockId) ?? []) {
        if (widthGroupKey(t.requiredWidth > 0 ? t.requiredWidth : masterWidth) !== widthKey) continue;
        const wi = weekIndexOf(t.shipByDate, weeks);
        if (wi >= 0) booked[wi] = (booked[wi] ?? 0) + t.estFootage;
      }
      const pending = pendingByStockWidth.get(stockId)?.get(widthKey) ?? new Array<number>(weeks.length).fill(0);

      // ---- Scheduled receipts per week ----
      const receipts = new Array<number>(weeks.length).fill(0);
      /** On-order footage whose arrival week had to be estimated. */
      let undatedReceiptFootage = 0;
      /**
       * Footage on a make-and-hold order. Counted as supply, but it needs a
       * release request before it ships — so a row leaning on it is not the same
       * as one with freight already booked.
       */
      let makeAndHoldSupplyFootage = 0;
      for (const p of posByStock.get(stockId) ?? []) {
        const w = p.masterWidth && p.masterWidth > 0 ? p.masterWidth : masterWidth;
        if (widthGroupKey(w) !== widthKey) continue;
        /**
         * Make-and-hold material DOES count as a scheduled receipt.
         *
         * It was excluded on the reasoning that nothing arrives until a release
         * is requested — true of the final leg, but it made the plan believe no
         * supply existed and plan orders for material we already own. Caught when
         * the auto-drafter proposed ordinary POs to Dazpak for #288, #307 and
         * #278 while 470,000 / 480,000 / 160,000 ft sat on their make-and-hold
         * orders. Same failure as dropping undated POs: discarded supply becomes
         * a double-buy.
         *
         * The difference from an ordinary PO is only who initiates the last leg,
         * so the footage counts and the row is flagged instead — a release is
         * still needed to move it, which the Make & Hold panel drives.
         */
        const ft = p.orderedFootage > 0 ? p.orderedFootage : p.quantityRolls * typicalRoll;
        if (isMakeAndHoldPo(p.supplierName)) makeAndHoldSupplyFootage += ft;
        let date = p.dueDateIso ?? p.agentPromisedIso ?? p.requestedDeliveryIso;
        if (!date) {
          // A PO with no date on it at all is still real supply — #195 has
          // 300,000 ft sitting on PO 2602 like this. Dropping it made the plan
          // recommend buying that footage a second time, which is the worst
          // possible error here. Estimate the landing week from the PO date plus
          // the lead time and count it, flagged so nobody mistakes an estimate
          // for a commitment.
          date = p.poDateIso ? addDaysIso(p.poDateIso, Math.round(lead.days)) : todayIso;
          undatedReceiptFootage += ft;
        }
        // Overdue supply lands in week 1 rather than vanishing: it is coming,
        // and pretending otherwise double-buys it.
        const wi = weekIndexOf(date < weeks[0]!.weekStart ? weeks[0]!.weekStart : date, weeks);
        if (wi < 0) {
          // Beyond the horizon — genuinely no help inside 13 weeks.
          continue;
        }
        receipts[wi] = (receipts[wi] ?? 0) + ft;
      }

      // ---- Roll the balance forward ----
      //
      // One pass. A planned order is RECEIVED in the week that needs it and
      // RELEASED leadWeeks earlier, both recorded as we go — so the balance and
      // the two planned rows can't disagree, and the grid can be read as
      // arithmetic: receipts + planned receipts − gross = projected.
      const leadWeeks = Math.max(1, Math.ceil(lead.days / 7));
      const plannedRelease = new Array<number>(weeks.length).fill(0);
      const plannedReleaseRolls = new Array<number>(weeks.length).fill(0);
      const plannedReceipt = new Array<number>(weeks.length).fill(0);
      /** Releases the lead time pushed before week 1 — already late. */
      let lateReleaseFootage = 0;
      const cells: MrpCell[] = [];
      let balance = openingOnHand;
      let plannedTotalFootage = 0;
      let firstShortageWeek: number | null = null;

      for (let i = 0; i < weeks.length; i++) {
        const named = (booked[i] ?? 0) + (pending[i] ?? 0);
        const stat = statPoints[i]?.footage ?? 0;
        const gross = Math.max(named, stat);
        balance = balance + (receipts[i] ?? 0) + (plannedReceipt[i] ?? 0) - gross;

        // Two triggers. Dropping below the reorder point is the planned,
        // healthy one. Going NEGATIVE has to plan an order even when there's no
        // usable reorder point — a row that reports a shortage and recommends
        // nothing is the least useful output the report can produce, and thin
        // history is exactly when that happens.
        const belowRop = reorderPointFootage > 0 && balance < reorderPointFootage;
        if (belowRop || balance < 0) {
          const target = Math.max(maxFootage, 0);
          const need = Math.max(target - balance, -balance);
          const rolls = orderQtyRolls
            ? Math.max(orderQtyRolls, Math.ceil(need / typicalRoll))
            : Math.max(1, Math.ceil(need / typicalRoll));
          const footage = rolls * typicalRoll;
          // Received now (that's what fixes this week), released leadWeeks back.
          plannedReceipt[i] = (plannedReceipt[i] ?? 0) + footage;
          balance += footage;
          plannedTotalFootage += footage;
          const releaseWeek = i - leadWeeks;
          if (releaseWeek < 0) {
            // The order needed placing before the horizon opened.
            lateReleaseFootage += footage;
            plannedRelease[0] = (plannedRelease[0] ?? 0) + footage;
            plannedReleaseRolls[0] = (plannedReleaseRolls[0] ?? 0) + rolls;
          } else {
            plannedRelease[releaseWeek] = (plannedRelease[releaseWeek] ?? 0) + footage;
            plannedReleaseRolls[releaseWeek] = (plannedReleaseRolls[releaseWeek] ?? 0) + rolls;
          }
        }
        if (balance < 0 && firstShortageWeek == null) firstShortageWeek = i;

        cells.push({
          weekStart: weeks[i]!.weekStart,
          weekEnd: weeks[i]!.weekEnd,
          label: weeks[i]!.label,
          bookedFootage: Math.round(booked[i] ?? 0),
          pendingFootage: Math.round(pending[i] ?? 0),
          statisticalFootage: Math.round(stat),
          grossRequirement: Math.round(gross),
          scheduledReceipts: Math.round(receipts[i] ?? 0),
          projectedOnHand: Math.round(balance),
          plannedOrderRelease: 0, // filled below, once every release week is known
          plannedOrderRolls: 0,
          plannedOrderReceipt: Math.round(plannedReceipt[i] ?? 0),
        });
      }
      for (let i = 0; i < cells.length; i++) {
        cells[i]!.plannedOrderRelease = Math.round(plannedRelease[i] ?? 0);
        cells[i]!.plannedOrderRolls = plannedReleaseRolls[i] ?? 0;
      }
      const shifted = cells;

      const anyBooked = booked.some((v) => v > 0);
      const anyPending = pending.some((v) => v > 0);
      const anyReceipt = receipts.some((v) => v > 0);
      if (
        openingOnHand <= 0 &&
        !anyBooked &&
        !anyPending &&
        !anyReceipt &&
        wUsage.length < MIN_OBSERVATIONS
      ) {
        // No inventory, nothing inbound, nothing booked, and not enough history
        // to forecast from — a row here is noise, and it reads as a permanent
        // shortage because the forecast extrapolates from a single roll.
        continue;
      }

      const alternates = (goal?.alternateStockIds ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((altId) => ({
          stockId: altId,
          description: onHandByStock.get(altId)?.description ?? null,
          onHandFootage: Math.round(
            (onHandByWidth.get(altId) ?? [])
              .filter((w) => widthGroupKey(w.width) === widthKey)
              .reduce((s, w) => s + w.footage, 0),
          ),
        }));

      rows.push({
        stockId,
        description,
        widthKey,
        widthLabel: widthKey === "le13" ? `≤13"` : `${Math.round(repWidth * 100) / 100}"`,
        width: Math.round(repWidth * 100) / 100,
        pooled: widthKey === "le13",
        vendorName: goal?.vendorName ?? info?.supplierName ?? null,
        openingOnHand: Math.round(openingOnHand),
        cells: shifted,
        drivers: {
          leadTimeDays: Math.round(lead.days),
          leadTimeSource: lead.source,
          leadTimeOverridden: lead.overridden,
          typicalRollFootage: Math.round(typicalRoll),
          typicalRollFootageOverridden: Boolean(goal?.typicalRollFootage && goal.typicalRollFootage > 0),
          orderQuantityRolls: orderQtyRolls,
          serviceLevel,
          reorderPointFootage: Math.round(reorderPointFootage),
          maxFootage: Math.round(maxFootage),
          reorderBasis,
          observations: wUsage.length,
          discontinued: goal?.discontinued ?? false,
          alternates,
        },
        firstShortageWeek,
        firstShortageDate: firstShortageWeek != null ? weeks[firstShortageWeek]!.weekStart : null,
        plannedTotalFootage: Math.round(plannedTotalFootage),
        lateReleaseFootage: Math.round(lateReleaseFootage),
        orderQuantityIgnored: orderQtyImplausible ? rawOrderQty : null,
        undatedReceiptFootage: Math.round(undatedReceiptFootage),
        makeAndHoldSupplyFootage: Math.round(makeAndHoldSupplyFootage),
      });
    }
  }

  // Shortages first, soonest shortage first, then the biggest planned buy.
  rows.sort((a, b) => {
    const as = a.firstShortageWeek ?? 99;
    const bs = b.firstShortageWeek ?? 99;
    if (as !== bs) return as - bs;
    if (b.plannedTotalFootage !== a.plannedTotalFootage) return b.plannedTotalFootage - a.plannedTotalFootage;
    return a.stockId.localeCompare(b.stockId) || a.width - b.width;
  });

  const result: MrpResult = {
    generatedAt: new Date().toISOString(),
    weeks,
    rows,
    shortageCount: rows.filter((r) => r.firstShortageWeek != null).length,
    lateReleaseCount: rows.filter((r) => r.lateReleaseFootage > 0).length,
    configWarnings: [
      ...new Map(
        rows
          .filter((r) => r.orderQuantityIgnored != null)
          .map((r) => [r.stockId, { stockId: r.stockId, orderQuantityRolls: r.orderQuantityIgnored! }]),
      ).values(),
    ],
  };
  logger.info(
    { rows: rows.length, shortages: result.shortageCount, weeks: weeks.length },
    "MRP plan built",
  );
  return result;
}
