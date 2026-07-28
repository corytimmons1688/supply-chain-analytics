import { pgTable, text, doublePrecision, integer, timestamp } from "drizzle-orm/pg-core";

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
