import { pgTable, text, doublePrecision, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";

// =====================================================================
// LABEL TRAXX MIRROR
// Local copies of Label Traxx records, refreshed on a schedule through the
// LT Cloud API (see api-server lib/lt-sync.ts). The API caps pages at 100
// rows and has no date filters on roll inventory, so hot read paths query
// these mirrors instead of hitting LT live. Dates are ISO YYYY-MM-DD;
// LT's 01/01/1970 blank-date sentinel is stored as NULL.
// =====================================================================

export const ltRollTable = pgTable(
  "lt_roll",
  {
    rollId: text("roll_id").primaryKey(), // rollstock IDNumber
    stockId: text("stock_id").notNull(),
    poNumber: text("po_number"),
    width: doublePrecision("width"),
    length: doublePrecision("length"), // footage
    usedTikNum: text("used_tik_num"),
    allocTikNum: text("alloc_tik_num"),
    used: boolean("used").notNull().default(false),
    dateRollUsed: text("date_roll_used"), // ISO; null = on hand
    stockDate: text("stock_date"), // ISO received date
    location: text("location"),
    description: text("description"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    usedDateIx: index("lt_roll_used_date_ix").on(t.used, t.dateRollUsed),
    stockIx: index("lt_roll_stock_ix").on(t.stockId),
    poIx: index("lt_roll_po_ix").on(t.poNumber),
  }),
);

export const ltStockTable = pgTable("lt_stock", {
  stockId: text("stock_id").primaryKey(),
  classification: text("classification"),
  supplierNumber: text("supplier_number"),
  supplierName: text("supplier_name"),
  mfgSpecNum: text("mfg_spec_num"),
  masterWidth: doublePrecision("master_width"),
  costMsi: doublePrecision("cost_msi"),
  freightMsi: doublePrecision("freight_msi"),
  faceStock: text("face_stock"),
  faceColor: text("face_color"),
  adhesive: text("adhesive"),
  topCoat: text("top_coat"),
  estimatedDeliveryTime: text("estimated_delivery_time"),
  invMsiMinimum: doublePrecision("inv_msi_minimum"),
  invMsiMaximum: doublePrecision("inv_msi_maximum"),
  areaToWeightFactor: doublePrecision("area_to_weight_factor"),
  inventoryCost: doublePrecision("inventory_cost"),
  totalInventoryMsi: doublePrecision("total_inventory_msi"),
  inactive: boolean("inactive").notNull().default(false),
  syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ltTicketTable = pgTable(
  "lt_ticket",
  {
    ticketNumber: text("ticket_number").primaryKey(),
    status: text("status"),
    stockIn: text("stock_in"),
    shipByDate: text("ship_by_date"), // ISO
    dateDone: text("date_done"), // ISO; null = open
    orderDate: text("order_date"),
    description: text("description"),
    customerName: text("customer_name"),
    totalNeeded: doublePrecision("total_needed"), // required footage (ODBC EstFootage)
    // [{stockNumber, width, description, routingNo}]
    stockAllocs: jsonb("stock_allocs"),
    modifiedDate: text("modified_date"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    doneShipIx: index("lt_ticket_done_ship_ix").on(t.dateDone, t.shipByDate),
  }),
);

export const ltPoTable = pgTable(
  "lt_po",
  {
    poNumber: text("po_number").primaryKey(),
    poType: text("po_type"),
    poDate: text("po_date"), // ISO
    dueDate: text("due_date"),
    receivedDate: text("received_date"), // ISO; null = not received
    closed: boolean("closed").notNull().default(false),
    supplierNumber: text("supplier_number"),
    supplierName: text("supplier_name"),
    stockNum: text("stock_num"),
    quantity: doublePrecision("quantity"),
    subTotal: doublePrecision("sub_total"),
    description: text("description"),
    items: jsonb("items"),
    modDate: text("mod_date"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    typeReceivedIx: index("lt_po_type_received_ix").on(t.poType, t.receivedDate),
    stockIx: index("lt_po_stock_ix").on(t.stockNum),
  }),
);

export type LtRollRow = typeof ltRollTable.$inferSelect;
export type LtStockRow = typeof ltStockTable.$inferSelect;
export type LtTicketRow = typeof ltTicketTable.$inferSelect;
export type LtPoRow = typeof ltPoTable.$inferSelect;
