import { db, materialPoTable, materialPoLineTable, ltStockTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Assembles a purchase order into the Label Traxx stock-PO shape (one material
 * per PO — see LT PO 2590). Shared by the print view and the PDF attached to
 * the vendor email so both always show the same document.
 */

export interface PoDocument {
  poNumber: string;
  isDraft: boolean;
  orderedDate: string;
  requestedDeliveryDate: string | null;
  type: string;
  vendorName: string;
  supplier: {
    company: string;
    customerId: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
    phone: string | null;
    fax: string | null;
    terms: string | null;
  };
  shipTo: {
    name: string;
    address1: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    phone: string;
  };
  material: {
    stockId: string;
    vendorPartNum: string | null;
    description: string | null;
    mfgSpecNum: string | null;
    masterWidth: number;
    costMsi: number;
    color: string | null;
    adhesive: string | null;
    topCoat: string | null;
  };
  rolls: { no: number; footage: number; width: number }[];
  totals: { rolls: number; areaMsi: number; purchasePrice: number; weight: number };
}

/** Thrown with a 404/400-worthy reason when the PO can't produce a document. */
export class PoDocumentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

export async function assemblePoDocument(id: string): Promise<PoDocument> {
  const [po] = await db.select().from(materialPoTable).where(eq(materialPoTable.id, id)).limit(1);
  if (!po) throw new PoDocumentError("PO not found", 404);
  const lines = await db.select().from(materialPoLineTable).where(eq(materialPoLineTable.poId, id));
  const line = lines[0];
  if (!line) throw new PoDocumentError("PO has no line", 400);

  const [stock] = await db.select().from(ltStockTable).where(eq(ltStockTable.stockId, line.stockId)).limit(1);

  // Supplier address + customer id, live from the LT API.
  let supplier: Record<string, unknown> = {};
  let vendorPartNum: string | null = null;
  const { ltGet } = await import("./ltApi");
  if (stock?.supplierNumber) {
    supplier = (await ltGet<Record<string, unknown>>("/supplier-details", {
      SupplierNumber: stock.supplierNumber,
    }).catch(() => ({}))) as Record<string, unknown>;
  }
  // If already in Label Traxx, pull the real vendor part number off the PO.
  const firstLtPo = (po.ltPoNumbers ?? "").split(",").map((n) => n.trim()).filter(Boolean)[0];
  if (firstLtPo) {
    const ltPo = await ltGet<Record<string, unknown>>("/purchase-order-details", { PONumber: firstLtPo }).catch(
      () => null,
    );
    const items = ltPo && Array.isArray(ltPo["poItems"]) ? (ltPo["poItems"] as Record<string, unknown>[]) : [];
    vendorPartNum = items[0]?.["vendorPartNum"] != null ? String(items[0]!["vendorPartNum"]) : null;
  }

  const company = String(supplier["company"] ?? po.vendorName);
  const custIdMatch = /customer\s*id[:#\s]*([0-9]+)/i.exec(company);
  // The width being ORDERED: the line's width (suggestions carry the exact
  // ticket width) with the stock's master width as the fallback. Drives the
  // slitting table, area and cost — a 30" order must not price as 13".
  const masterWidth = line.width && line.width > 0 ? line.width : (stock?.masterWidth ?? 0);
  const rolls = Math.max(1, line.rolls);
  const totalFootage = line.footage ?? 0;
  const footagePerRoll = totalFootage > 0 ? Math.round(totalFootage / rolls) : 0;
  const costMsi = line.msiCost ?? stock?.costMsi ?? 0;
  const areaMsi = masterWidth > 0 ? (totalFootage * 12 * masterWidth) / 1000 : 0;
  const purchasePrice = areaMsi * costMsi;
  const weight = stock?.areaToWeightFactor ? areaMsi / stock.areaToWeightFactor : 0;

  return {
    poNumber: firstLtPo ?? `DRAFT-${po.id.slice(0, 6).toUpperCase()}`,
    isDraft: !firstLtPo,
    orderedDate: po.createdAt.toISOString().slice(0, 10),
    requestedDeliveryDate: po.requestedDeliveryDate,
    type: "New Order",
    vendorName: po.vendorName,
    supplier: {
      company: company.replace(/\s*customer\s*id[:#\s]*[0-9]+/i, "").trim(),
      customerId: custIdMatch ? custIdMatch[1]! : str(supplier["accountNumber"]),
      address1: str(supplier["address1"]),
      address2: str(supplier["address2"]),
      city: str(supplier["city"]),
      state: str(supplier["state"]),
      zip: str(supplier["zip"]),
      country: str(supplier["country"]),
      phone: str(supplier["phone"]),
      fax: str(supplier["fax"]),
      terms: str(supplier["terms"]),
    },
    shipTo: {
      name: "Calyx Containers",
      address1: "1991 Parkway Blvd",
      city: "West Valley City",
      state: "UT",
      zip: "84119",
      country: "USA",
      phone: "1 (888) 432-7766",
    },
    material: {
      stockId: line.stockId,
      vendorPartNum,
      description: stock?.faceStock ?? line.description ?? null,
      mfgSpecNum: stock?.mfgSpecNum ?? null,
      masterWidth,
      costMsi,
      color: stock?.faceColor ?? null,
      adhesive: stock?.adhesive ?? null,
      topCoat: stock?.topCoat || "None",
    },
    rolls: Array.from({ length: rolls }, (_, i) => ({ no: i + 1, footage: footagePerRoll, width: masterWidth })),
    totals: {
      rolls,
      areaMsi: Math.round(areaMsi),
      purchasePrice: Math.round(purchasePrice * 100) / 100,
      weight: Math.round(weight),
    },
  };
}
