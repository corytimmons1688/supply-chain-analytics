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
  msiCost: doublePrecision("msi_cost"),
  estCost: doublePrecision("est_cost"),
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
