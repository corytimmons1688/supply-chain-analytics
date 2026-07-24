import { pgTable, text, doublePrecision, integer, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";

// Snapshot of the cycle-count plan for the active financial quarter. Stored
// once on the global row so all per-stock weekly assignments stay stable
// even if a stock's ABC class drifts mid-quarter. Regenerated each quarter.
export interface CycleCountSchedule {
  quarter: string;            // e.g. "2026Q2"
  startDate: string;          // ISO date (Monday)
  endDate: string;            // ISO date
  generatedAt: string;        // ISO timestamp
  consolidated: boolean;      // true if start was shifted (e.g. Q2 2026)
  weekStarts: string[];       // ISO Monday for each week 1..N
  assignments: Record<string, { abc: "A" | "B" | "C"; weeks: number[] }>;
}

export const globalGoalTable = pgTable("global_goal", {
  id: text("id").primaryKey(),
  min: doublePrecision("min"),
  max: doublePrecision("max"),
  // Shared Demand Planning defaults. NULL = use the app's hard-coded default
  // (serviceLevel=0.95, monthsBack=6, demandCv/leadTimeCv = no override).
  serviceLevel: doublePrecision("service_level"),
  monthsBack: integer("months_back"),
  demandCv: doublePrecision("demand_cv"),
  leadTimeCv: doublePrecision("lead_time_cv"),
  // EOQ economics for suggested order quantities. NULL = app default
  // (orderingCost $150/PO, carryingRatePct 0.20 = 20%/yr).
  orderingCost: doublePrecision("ordering_cost"),
  carryingRatePct: doublePrecision("carrying_rate_pct"),
  // Active cycle-count quarter snapshot (see CycleCountSchedule above).
  cycleCountSchedule: jsonb("cycle_count_schedule").$type<CycleCountSchedule>(),
  // Approved Supplier List onboarding target (vendors onboarded by EOY).
  // NULL = use the app default (50).
  aslVendorGoal: integer("asl_vendor_goal"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const stockGoalTable = pgTable("stock_goal", {
  stockId: text("stock_id").primaryKey(),
  min: doublePrecision("min"),
  max: doublePrecision("max"),
  // Per-stock forecast assumption overrides (all nullable; null = use global default).
  demandCv: doublePrecision("demand_cv"),
  leadTimeCv: doublePrecision("lead_time_cv"),
  // Quarterly seasonality weights for months 1, 2, 3 of each quarter.
  // Stored as three columns (instead of a JSON column) so the schema stays
  // SQL-native and queryable. They should sum to ~1.0; the math layer
  // normalizes defensively. NULL on any of them means "use the global default".
  seasonalityW1: doublePrecision("seasonality_w1"),
  seasonalityW2: doublePrecision("seasonality_w2"),
  seasonalityW3: doublePrecision("seasonality_w3"),
  // Manual override for the average lead time (days) used in safety-stock /
  // reorder-point math. NULL = use the auto value derived from observed PO
  // placed → received history (with global fallback).
  leadTimeDays: doublePrecision("lead_time_days"),
  // Manual override for the "typical roll size" (footage). NULL = use the auto
  // value derived from received-roll history grouped by Orig_RollID.
  typicalRollFootage: doublePrecision("typical_roll_footage"),
  // Manual order quantity (master rolls) to place per PO — a fixed batch that
  // overrides the computed EOQ. NULL = use EOQ / heuristic. Acts as a floor:
  // a large committed backlog can still push the suggested quantity higher.
  orderQuantityRolls: doublePrecision("order_quantity_rolls"),
  // End-of-life flag. When true the SKU stays visible with its on-hand
  // inventory (to sell through) but is excluded from all reorder suggestions.
  discontinued: boolean("discontinued").notNull().default(false),
  // Predecessor stock number whose usage history this (successor) SKU inherits
  // for forecasting / reorder. NULL = none. Full history is merged in.
  demandFromStockId: text("demand_from_stock_id"),
  // Purchasing config (Demand Planning → Configuration). NULL = fall back to
  // the Label Traxx stock record (SupplierName / CostMSI).
  vendorName: text("vendor_name"),
  // Comma-separated vendor PO email addresses.
  vendorEmails: text("vendor_emails"),
  msiCost: doublePrecision("msi_cost"),
  // Root-cause investigation tracking for stocks with CC variance.
  // Investigation flow: 'open' | 'root_cause_id' | 'closed'. NULL = not yet triaged.
  // Legacy values 'completed' / 'no_investigation' are normalized to 'closed' on read.
  varianceStatus: text("variance_status"),
  // Structured root-cause taxonomy (per WI-INV-025 framework). Values:
  // 'missing_from_system' | 'missing_from_floor' | 'data_error' |
  // 'consumed_without_po' | 'in_use' | 'damage' | 'other'.
  rootCauseCategory: text("root_cause_category"),
  // Free-text evidence / notes for the investigation.
  rootCause: text("root_cause"),
  // User who owns the investigation work.
  investigationOwner: text("investigation_owner"),
  // Free-text description of the corrective action required / taken.
  correctiveAction: text("corrective_action"),
  // Independent CA workflow status: 'not_started' | 'in_progress' | 'complete'.
  correctiveActionStatus: text("corrective_action_status"),
  // User who owns executing the corrective action (may differ from investigation owner).
  correctiveActionOwner: text("corrective_action_owner"),
  // Cycle-count completion log: array of { quarter, week, completedAt } records
  // marking when this stock was counted. Cleared by quarter regeneration if
  // entries are stale enough that they no longer apply (we keep history).
  cycleCountCompletions: jsonb("cycle_count_completions").$type<
    Array<{ quarter: string; week: number; completedAt: string }>
  >(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type GlobalGoalRow = typeof globalGoalTable.$inferSelect;
export type StockGoalRow = typeof stockGoalTable.$inferSelect;
