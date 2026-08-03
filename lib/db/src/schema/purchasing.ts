import { pgTable, text, doublePrecision, integer, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";

function uuid() {
  return crypto.randomUUID();
}

/**
 * PO contacts per VENDOR, not per material — the same vendor supplies many
 * stocks, so addresses used to have to be re-entered on every one. To and CC are
 * separate, each a comma/semicolon-separated list.
 */
export const vendorContactTable = pgTable("vendor_contact", {
  // Matches the effective vendor name (stock_goal.vendorName override, else the
  // Label Traxx supplier name).
  vendorName: text("vendor_name").primaryKey(),
  toEmails: text("to_emails"),
  ccEmails: text("cc_emails"),
  // Per-vendor opt-in for the PO follow-up agent. Off by default so the agent
  // never watches or nudges a vendor Cory hasn't explicitly enabled.
  agentEnabled: boolean("agent_enabled").default(false).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type VendorContactRow = typeof vendorContactTable.$inferSelect;

// Material purchase orders raised from Demand Planning → Suggested POs.
// Status flow: draft → submitted (recorded here + emailed to vendor) →
// submitted_lt (also created in Label Traxx once LT writes are enabled).
export const materialPoTable = pgTable("material_po", {
  id: text("id").primaryKey().$defaultFn(uuid),
  vendorName: text("vendor_name").notNull(),
  vendorEmails: text("vendor_emails"),
  status: text("status").notNull().default("draft"), // draft | submitted | submitted_lt
  // Label Traxx PO numbers created for this order (comma-separated), once
  // LT submission is enabled.
  ltPoNumbers: text("lt_po_numbers"),
  notes: text("notes"),
  requestedDeliveryDate: text("requested_delivery_date"), // ISO date
  // Set when the PO has actually been emailed to the vendor from the dashboard
  // (Gmail), so the UI can show it and a second send is a deliberate re-send.
  emailedAt: timestamp("emailed_at", { withTimezone: true }),
  emailedTo: text("emailed_to"),
  // --- PO follow-up agent -------------------------------------------------
  // Gmail thread of the original send; the watcher polls it for replies.
  gmailThreadId: text("gmail_thread_id"),
  // null = agent not tracking. awaiting_ack → acknowledged → shipped → closed.
  agentState: text("agent_state"),
  // Vendor-confirmed delivery date extracted from their acknowledgement —
  // distinct from requestedDeliveryDate (ours) and lt_po.dueDate (LT's).
  promisedDate: text("promised_date"),
  ackAt: timestamp("ack_at", { withTimezone: true }),
  // Set (with a reason) when the agent stops and wants a human: vendor asked a
  // question, announced a delay, or ignored the nudges.
  needsAttention: boolean("needs_attention").default(false).notNull(),
  attentionReason: text("attention_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const materialPoLineTable = pgTable("material_po_line", {
  id: text("id").primaryKey().$defaultFn(uuid),
  poId: text("po_id").notNull(),
  stockId: text("stock_id").notNull(),
  description: text("description"),
  rolls: integer("rolls").notNull(),
  footage: doublePrecision("footage"),
  // Master width to order, in inches. Suggestions break out by the exact width
  // the demand requires (12.5/12.75/13/30…); null = the stock's master width.
  width: doublePrecision("width"),
  msiCost: doublePrecision("msi_cost"),
  estCost: doublePrecision("est_cost"),
  // Set when the vendor's confirmed date lands after the delivery we requested
  // (which is itself today + the configured lead time). An accepted fact, not a
  // problem — the line carries an "extended lead time" tag instead of a flag.
  extendedLeadTime: boolean("extended_lead_time").default(false).notNull(),
  /** Days the vendor's promise runs past our requested date. */
  extendedLeadTimeDays: integer("extended_lead_time_days"),
});

export type MaterialPoRow = typeof materialPoTable.$inferSelect;
export type MaterialPoLineRow = typeof materialPoLineTable.$inferSelect;

/**
 * Timeline of everything that happened around a PO's email conversation —
 * sends, detected vendor replies (classified), agent nudges, state changes.
 * This is the "notes section" the agent fills in, and the drill-down renders it.
 */
export const poEmailEventTable = pgTable(
  "po_email_event",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    poId: text("po_id").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    direction: text("direction").notNull(), // inbound | outbound | system
    // sent | follow_up | ack | ship_notice | delay | question | ooo_or_auto |
    // other | state_change | note
    kind: text("kind").notNull(),
    gmailMessageId: text("gmail_message_id"),
    gmailThreadId: text("gmail_thread_id"),
    // RFC 822 Message-ID header, needed so replies thread correctly for the vendor.
    rfc822MessageId: text("rfc822_message_id"),
    fromAddr: text("from_addr"),
    subject: text("subject"),
    summary: text("summary"),
    // Classifier extractions: promisedDate, tracking, confirmedQty, confidence.
    extracted: jsonb("extracted"),
  },
  (t) => [index("po_email_event_po_idx").on(t.poId), index("po_email_event_msg_idx").on(t.gmailMessageId)],
);

/**
 * Outbound follow-ups the agent WANTS to send. In draft mode nothing goes out
 * until Cory approves a row; the cron only ever inserts here.
 */
export const poAgentDraftTable = pgTable(
  "po_agent_draft",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    poId: text("po_id").notNull(),
    kind: text("kind").notNull(), // ack_nudge | checkin | tracking_request
    toEmails: text("to_emails").notNull(),
    ccEmails: text("cc_emails"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("pending"), // pending | sent | dismissed
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    gmailMessageId: text("gmail_message_id"),
  },
  (t) => [index("po_agent_draft_po_idx").on(t.poId)],
);

/**
 * Vendor documents captured off PO emails (order acknowledgements, BOLs).
 * Label Traxx's API has no attachment upload, so these live here and download
 * from the PO drill-down. Content is base64 — ACK PDFs are small.
 */
export const poAttachmentTable = pgTable(
  "po_attachment",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    poId: text("po_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    contentBase64: text("content_base64").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    gmailMessageId: text("gmail_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("po_attachment_po_idx").on(t.poId)],
);

export type PoEmailEventRow = typeof poEmailEventTable.$inferSelect;
export type PoAgentDraftRow = typeof poAgentDraftTable.$inferSelect;
export type PoAttachmentRow = typeof poAttachmentTable.$inferSelect;

/**
 * Buyer-approved conventions the agent learns from resolved flags — e.g.
 * "Derprosa's confirmations round width to one decimal". Injected into every
 * classification for the matching vendor so known system quirks stop being
 * flagged as discrepancies. This is the agent's whole "training" mechanism:
 * plain-language lessons, visible and deletable in the dashboard.
 */
export const agentLessonTable = pgTable("agent_lesson", {
  id: text("id").primaryKey().$defaultFn(uuid),
  /** Vendor the lesson applies to; null = every vendor. */
  vendorName: text("vendor_name"),
  lesson: text("lesson").notNull(),
  /** PO whose resolved flag produced the lesson, for traceability. */
  poId: text("po_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AgentLessonRow = typeof agentLessonTable.$inferSelect;

/**
 * Excess & Obsolete review notes — the buyer's disposition decision per stock
 * ("scrap Q3", "hold for GLOR rerun", "return to vendor"). Kept out of
 * stock_goal deliberately: PUT /goals/stock is a full replace and a review
 * note must never be able to clobber purchasing config (or vice versa).
 */
export const eoDispositionTable = pgTable("eo_disposition", {
  stockId: text("stock_id").primaryKey(),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type EoDispositionRow = typeof eoDispositionTable.$inferSelect;

/**
 * Material forecast from NetSuite sales orders that are still Pending Approval
 * — demand that exists commercially but hasn't reached Label Traxx yet.
 *
 * One row per SO line carrying a label or flexpack item. The line's SKU
 * resolves to a Label Traxx product (LT product.description === the NS item
 * id), whose construction (repeat, no-across, stock numbers + widths) drives
 * the footage calculation. `stockDemand` holds the per-material result.
 *
 * A line leaves the forecast the moment NetSuite's "LT Ticket" field
 * (custcollt_ticket_num) is populated: at that point a real ticket exists in
 * LT and the demand is already counted as committed open-ticket footage, so
 * keeping it here would double-count.
 */
export const nsForecastLineTable = pgTable(
  "ns_forecast_line",
  {
    /** NetSuite transactionline.uniquekey — stable per line. */
    id: text("id").primaryKey(),
    soId: text("so_id").notNull(),
    tranId: text("tran_id").notNull(), // e.g. SO15577
    lineNo: integer("line_no"),
    customerName: text("customer_name"),
    /** NetSuite item id — also the Label Traxx product description. */
    sku: text("sku").notNull(),
    /** NetSuite item class: Labels | Flex Pack. */
    itemClass: text("item_class"),
    quantity: doublePrecision("quantity").notNull(),
    expectedShipDate: text("expected_ship_date"), // ISO
    orderDate: text("order_date"), // ISO
    /** NetSuite's LT Ticket field. Non-null ⇒ excluded from the forecast. */
    ltTicketNum: text("lt_ticket_num"),
    /** LT product this SKU resolved to (null = unresolved, no construction). */
    ltProductNumber: text("lt_product_number"),
    ltUniqueProdId: integer("lt_unique_prod_id"),
    /** True when the LT construction says flexpack rather than label. */
    isFlexpack: boolean("is_flexpack").default(false).notNull(),
    /** Why a line couldn't be forecast (no LT product, no repeat, etc.). */
    unresolvedReason: text("unresolved_reason"),
    /** [{ stockId, widthIn, footage }] — the forecast material requirement. */
    stockDemand: jsonb("stock_demand"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("ns_forecast_sku_idx").on(t.sku), index("ns_forecast_ticket_idx").on(t.ltTicketNum)],
);

export type NsForecastLineRow = typeof nsForecastLineTable.$inferSelect;

/**
 * Conversation with the PO agent — the buyer asks questions ("what's late?")
 * and gives directions ("set 2595 to 8/12", "stop nudging Mactac"). Persisted
 * so the thread survives reloads and the model keeps context between turns.
 * toolLog records what the agent actually did, so every write is auditable.
 */
export const agentChatMessageTable = pgTable(
  "agent_chat_message",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    /** Who is talking to the agent (lowercased email) — threads are per user. */
    userEmail: text("user_email").notNull(),
    role: text("role").notNull(), // user | assistant
    content: text("content").notNull(),
    /** [{ tool, input, result }] for the actions this turn took. */
    toolLog: jsonb("tool_log"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("agent_chat_user_idx").on(t.userEmail, t.createdAt)],
);

export type AgentChatMessageRow = typeof agentChatMessageTable.$inferSelect;

/**
 * App-level user registry. Identity (who you are) comes from the shared
 * Better Auth server; authorization (what you may do HERE) lives in this
 * table, per the auth spec ("identity only — NOT used for tenancy or
 * authorization data"). Rows are auto-provisioned on a user's first
 * authenticated request — company-domain emails as active members, external
 * domains as 'pending' — and admins approve/promote/demote/block from /admin.
 */
export const appUserTable = pgTable("app_user", {
  /** Lowercased email — the identity key the auth server verifies. */
  email: text("email").primaryKey(),
  name: text("name"),
  role: text("role").notNull().default("member"), // member | admin
  status: text("status").notNull().default("active"), // active | pending | blocked
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AppUserRow = typeof appUserTable.$inferSelect;
