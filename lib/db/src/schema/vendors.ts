import { pgTable, text, doublePrecision, integer, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";

// =====================================================================
// VENDOR / SUPPLIER DOMAIN
// New domain (vendor scorecards + Approved Supplier List). These are NOT
// part of Label Traxx (read-only) nor the inventory goals tables. Dedicated
// Neon tables, keyed by an app-generated UUID.
// =====================================================================

function uuid() {
  return crypto.randomUUID();
}

// Master vendor record. One row per supplier. A vendor can participate in
// both ASL segments (raw materials + finished goods) via asl_entry rows.
export const vendorTable = pgTable("vendor", {
  id: text("id").primaryKey().$defaultFn(uuid),
  name: text("name").notNull(),
  country: text("country"),
  // Free-text capability / category, e.g. "Domestic Flexographic".
  category: text("category"),
  // 'domestic' | 'international' (mirrors the tracker's Track column N/Y).
  track: text("track"),
  // 'T1' | 'T2' | 'T3' (primary / backup / pipeline) for tracker vendors, or
  // 'Tier 1'..'Tier 5' (criticality) for current ASL suppliers.
  tier: text("tier"),
  // Pipeline stage, e.g. Identify / Screen / Qualify / Contracted / Active.
  stage: text("stage"),
  owner: text("owner"),
  // Detailed ASL attributes (from the current Approved Supplier List).
  subCategory: text("sub_category"),
  capabilities: text("capabilities"),
  // Comma-separated product categories from the supply-web taxonomy; drives
  // category-level membership in the Vendor Network view.
  productCategories: text("product_categories"),
  locations: text("locations"),
  documents: text("documents"),
  // Internal Calyx point of contact for this supplier.
  calyxPoc: text("calyx_poc"),
  // Supplier-side contact name / phone / email.
  vendorPoc: text("vendor_poc"),
  vendorPocPhone: text("vendor_poc_phone"),
  vendorPocEmail: text("vendor_poc_email"),
  // ---------------------------------------------------------------
  // Flex Sourcing pipeline-tracker attributes (one column per tracker
  // field so the full tracker can be displayed and filled in over time).
  externalId: text("external_id"), // Vendor_ID, e.g. FLEX-D-001
  printMethod: text("print_method"), // Digital / Flexo / Roto
  pipelineStatus: text("pipeline_status"), // Active / In Process / Not Contacted ...
  website: text("website"),
  cluster: text("cluster"), // geographic cluster, e.g. US-CA / Guangdong
  subCapability: text("sub_capability"),
  primarySecondary: text("primary_secondary"),
  waveSprint: text("wave_sprint"),
  // 45-day sourcing SLA steps (spec in → PO-ready). Dates are ISO YYYY-MM-DD;
  // each step also carries an evidence/document link. Factory audit reuses
  // factory_tour_date and the MSA step reuses msa_date for their dates.
  specInDate: text("spec_in_date"), // SLA Day 0
  specInLink: text("spec_in_link"),
  shortlistDate: text("shortlist_date"), // identify & shortlist, target day 8
  shortlistLink: text("shortlist_link"),
  creditCheckDate: text("credit_check_date"), // international vendors only, target day 8
  creditCheckLink: text("credit_check_link"),
  ndaLink: text("nda_link"), // NDA execution, target day 11
  assessmentDate: text("assessment_date"), // assessment + initial samples, target day 25
  assessmentLink: text("assessment_link"),
  qualityAgreementDate: text("quality_agreement_date"), // target day 28
  qualityAgreementLink: text("quality_agreement_link"),
  supplierSelectedDate: text("supplier_selected_date"), // review samples & select, target day 28
  supplierSelectedLink: text("supplier_selected_link"),
  factoryAuditLink: text("factory_audit_link"), // audit date lives in factory_tour_date
  netsuiteSetupDate: text("netsuite_setup_date"), // target day 35
  netsuiteSetupLink: text("netsuite_setup_link"),
  poReadyDate: text("po_ready_date"), // target day 35; freezes the SLA clock
  poReadyLink: text("po_ready_link"),
  msaLink: text("msa_link"), // full MSA / commercial; date lives in msa_date
  ndaDate: text("nda_date"),
  msaDate: text("msa_date"),
  capabilityVerified: text("capability_verified"),
  factoryTourDate: text("factory_tour_date"),
  rfqSent: text("rfq_sent"),
  quoteReceived: text("quote_received"),
  quotedPrice: text("quoted_price"),
  targetPrice: text("target_price"),
  priceVsTargetPct: text("price_vs_target_pct"),
  moq: text("moq"),
  depositPct: text("deposit_pct"),
  leadTimeDays: text("lead_time_days"),
  aqlStandard: text("aql_standard"),
  psiStatus: text("psi_status"),
  trialOrderNo: text("trial_order_no"),
  trialResult: text("trial_result"),
  commandIntegrated: text("command_integrated"),
  packosHandoff: text("packos_handoff"),
  ipClause: text("ip_clause"),
  nonCompete24mo: text("non_compete_24mo"),
  statusRag: text("status_rag"),
  nextAction: text("next_action"),
  nextActionDue: text("next_action_due"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Per-vendor, per-month manual scorecard metrics. Period is "YYYY-MM".
// On-time % is normally sourced from NetSuite (vendor_shipment) but may be
// manually overridden here when onTimePct is non-null.
export const vendorMetricTable = pgTable(
  "vendor_metric",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    vendorId: text("vendor_id").notNull(),
    period: text("period").notNull(), // YYYY-MM
    // Manual override for on-time % (0..100). NULL = derive from vendor_shipment.
    onTimePct: doublePrecision("on_time_pct"),
    // Cost savings / purchase price variance, in dollars (signed; negative = unfavorable).
    ppvSavings: doublePrecision("ppv_savings"),
    // Fill rate / order accuracy (0..100).
    fillRatePct: doublePrecision("fill_rate_pct"),
    // Responsiveness & communication rating (1..5).
    responsivenessRating: doublePrecision("responsiveness_rating"),
    // Count of formal NCR / CAPA records for the period.
    ncrCapaCount: integer("ncr_capa_count"),
    // Lead-time adherence (0..100).
    leadTimeAdherencePct: doublePrecision("lead_time_adherence_pct"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    vendorPeriodUx: uniqueIndex("vendor_metric_vendor_period_ux").on(t.vendorId, t.period),
  }),
);

// Manually-logged quality issues. Dated so they roll up by month/quarter/QTD/YTD.
export const vendorQualityIssueTable = pgTable("vendor_quality_issue", {
  id: text("id").primaryKey().$defaultFn(uuid),
  vendorId: text("vendor_id").notNull(),
  occurredOn: text("occurred_on").notNull(), // ISO date YYYY-MM-DD
  title: text("title").notNull(),
  description: text("description"),
  // 'low' | 'medium' | 'high' | 'critical'
  severity: text("severity").notNull().default("medium"),
  // 'open' | 'in_progress' | 'closed'
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Manually-logged pricing reviews / negotiations.
export const vendorPricingReviewTable = pgTable("vendor_pricing_review", {
  id: text("id").primaryKey().$defaultFn(uuid),
  vendorId: text("vendor_id").notNull(),
  reviewedOn: text("reviewed_on").notNull(), // ISO date
  title: text("title").notNull(),
  // Outcome summary, e.g. "3% reduction", "held flat", "increase accepted".
  outcome: text("outcome"),
  // Optional realized $ impact (signed; positive = savings).
  impactUsd: doublePrecision("impact_usd"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Manually-tracked continuous-improvement projects.
export const vendorImprovementProjectTable = pgTable("vendor_improvement_project", {
  id: text("id").primaryKey().$defaultFn(uuid),
  vendorId: text("vendor_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  // 'not_started' | 'in_progress' | 'complete' | 'on_hold'
  status: text("status").notNull().default("not_started"),
  startedOn: text("started_on"), // ISO date
  targetOn: text("target_on"), // ISO date
  owner: text("owner"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Shipment-level on-time data synced from NetSuite. on_time = actualShipDate <= customerDate.
export const vendorShipmentTable = pgTable(
  "vendor_shipment",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    vendorId: text("vendor_id").notNull(),
    orderNo: text("order_no").notNull(),
    customerDate: text("customer_date"), // ISO date (requested / promised)
    actualShipDate: text("actual_ship_date"), // ISO date (actual)
    onTime: boolean("on_time"),
    // PO date ("date sent") — used for NetSuite lead time (poDate -> actualShipDate).
    poDate: text("po_date"), // ISO date
    // Quantity ordered / shipped (received) summed across the PO's lines — used
    // for fill rate (qtyShipped / qtyOrdered).
    qtyOrdered: doublePrecision("qty_ordered"),
    qtyShipped: doublePrecision("qty_shipped"),
    source: text("source").notNull().default("netsuite"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    vendorOrderUx: uniqueIndex("vendor_shipment_vendor_order_ux").on(t.vendorId, t.orderNo),
  }),
);

// All NetSuite purchase orders per vendor (NOT just SO-linked) — used for total
// vendor spend, matching NetSuite's native "Purchase by Vendor Summary" report.
// amount = sum of the PO's item-line net amounts (merchandise total). Windowed
// by po_date on the dashboard.
export const vendorPurchaseTable = pgTable(
  "vendor_purchase",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    vendorId: text("vendor_id").notNull(),
    orderNo: text("order_no").notNull(),
    poDate: text("po_date"), // ISO date (PO transaction date)
    amount: doublePrecision("amount"), // merchandise total (USD)
    source: text("source").notNull().default("netsuite"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    vendorOrderUx: uniqueIndex("vendor_purchase_vendor_order_ux").on(t.vendorId, t.orderNo),
  }),
);

// Per-PO lead-time data derived from Label Traxx purchase orders (READ-ONLY
// source). lead_days = receivedDate - placedDate. Attributed to a vendor by
// matching the Label Traxx PO `Supplier` text to a vendor name. Label Traxx has
// no promised/due date, so this is lead time only (NOT true on-time), shown as
// an extra metric alongside the NetSuite on-time figure.
export const vendorLeadTimeTable = pgTable(
  "vendor_lead_time",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    vendorId: text("vendor_id").notNull(),
    poNumber: text("po_number").notNull(),
    // Raw supplier string from Label Traxx (kept for traceability).
    supplierName: text("supplier_name"),
    placedDate: text("placed_date"), // ISO date (PODate)
    receivedDate: text("received_date"), // ISO date (Received)
    leadDays: integer("lead_days").notNull(),
    // Materials fill rate (USER CONFIRMED roll-based, NOT MSI): orderedRolls is
    // the PO `Quantity` (master rolls ordered); receivedRolls is the count of
    // distinct master rolls (rollstock rows deduped by Orig_RollID) booked
    // against this PO. fill rate = receivedRolls / orderedRolls.
    orderedRolls: integer("ordered_rolls"),
    receivedRolls: integer("received_rolls"),
    source: text("source").notNull().default("labeltraxx"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // A PO is globally unique per source; if supplier->vendor matching changes
    // between syncs, the existing row is re-attributed (vendorId updated) rather
    // than duplicated across vendors.
    sourcePoUx: uniqueIndex("vendor_lead_time_source_po_ux").on(t.source, t.poNumber),
  }),
);

// Approved Supplier List membership. A vendor can have up to two rows
// (raw_materials and finished_goods).
export const aslEntryTable = pgTable(
  "asl_entry",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    vendorId: text("vendor_id").notNull(),
    // 'raw_materials' | 'finished_goods'
    segment: text("segment").notNull(),
    // 'identified' | 'in_progress' | 'onboarded'
    status: text("status").notNull().default("identified"),
    onboardedOn: text("onboarded_on"), // ISO date when fully onboarded
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    vendorSegmentUx: uniqueIndex("asl_entry_vendor_segment_ux").on(t.vendorId, t.segment),
  }),
);

// Quality cases sourced from NetSuite support cases (READ-ONLY source). A case
// is attributed to a vendor by parsing its "1st_lttn" free-text field for Sales
// Order references, then following each SO's special-order / drop-ship PO to its
// vendor. A single case can resolve to more than one vendor (one row each).
export const vendorQualityCaseTable = pgTable(
  "vendor_quality_case",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    vendorId: text("vendor_id").notNull(),
    caseId: text("case_id").notNull(), // NetSuite internal id
    caseNumber: text("case_number").notNull(), // e.g. "NC220"
    subject: text("subject"), // case title
    statusName: text("status_name"), // e.g. "Closed", "Investigation Needed"
    openCase: boolean("open_case").notNull().default(true), // stage !== CLOSED
    soTranid: text("so_tranid"), // the SO that linked this case to the vendor
    poNumber: text("po_number"), // the PO that linked the SO to the vendor
    caseUrl: text("case_url"), // deep link to the NetSuite case record
    startDate: text("start_date"), // ISO date the case was opened
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    vendorCaseUx: uniqueIndex("vendor_quality_case_vendor_case_ux").on(t.vendorId, t.caseId),
  }),
);

// User-defined name aliases that map a raw NetSuite / Label Traxx vendor or
// supplier string to a vendor record. Created from the unmatched-names panel so
// a name that failed automatic matching is resolved on every subsequent sync.
export const vendorAliasTable = pgTable(
  "vendor_alias",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    vendorId: text("vendor_id").notNull(),
    // Raw source string (kept for display / traceability).
    alias: text("alias").notNull(),
    // Lowercased / punctuation-collapsed form used for matching lookups. Both
    // the NetSuite and Label Traxx matchers compare against this.
    normAlias: text("norm_alias").notNull(),
    // Usage tracking so users can see which mappings still do useful work.
    // lastUsedAt = timestamp of the most recent sync where this alias resolved a
    // name; lastHitCount = number of source rows it matched on that sync. NULL /
    // 0 = never used since tracking began (candidate for pruning).
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastHitCount: integer("last_hit_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    normAliasUx: uniqueIndex("vendor_alias_norm_ux").on(t.normAlias),
  }),
);

export type VendorRow = typeof vendorTable.$inferSelect;
export type VendorAliasRow = typeof vendorAliasTable.$inferSelect;
export type VendorMetricRow = typeof vendorMetricTable.$inferSelect;
export type VendorQualityIssueRow = typeof vendorQualityIssueTable.$inferSelect;
export type VendorPricingReviewRow = typeof vendorPricingReviewTable.$inferSelect;
export type VendorImprovementProjectRow = typeof vendorImprovementProjectTable.$inferSelect;
export type VendorShipmentRow = typeof vendorShipmentTable.$inferSelect;
export type VendorLeadTimeRow = typeof vendorLeadTimeTable.$inferSelect;
export type AslEntryRow = typeof aslEntryTable.$inferSelect;
export type VendorQualityCaseRow = typeof vendorQualityCaseTable.$inferSelect;
