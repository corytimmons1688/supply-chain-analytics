/**
 * The material catalogue we track, and the HubSpot → LabelTraxx stock mapping.
 *
 * Transcribed from Mirhaan's material list (2026-08-04), split Label / Flexpack.
 * `ltStockId` is the LT Stock Construction ID — the thing a PO is actually raised
 * against, so this map is the join between a HubSpot quote and real inventory.
 *
 * STANDARDISATIONS IN FORCE (Mirhaan, 2026-08-04):
 *   all White MetPet  → 288
 *   all Silver MetPet → 307
 *   both at 2.5 mil LLDPE.
 *
 * Anything HubSpot reports that does NOT appear in the maps below resolves to
 * `null`, which puts the job in the review queue. It is never guessed at — an
 * unmapped substrate that silently defaulted to a stock would raise a PO for the
 * wrong film.
 */

export type MaterialKind = "LABEL" | "FLEXPACK";
export type MaterialRole = "SUBSTRATE" | "LAMINATE" | "ZIPPER";
export type MaterialTier = "PRIMARY" | "SPECIALITY";

export interface MaterialRecord {
  ltStockId: number;
  kind: MaterialKind;
  role: MaterialRole;
  tier: MaterialTier;
  colour: string | null;
  description: string;
  /** Free-text construction detail where the list gave one. */
  construction?: string;
  /** Customer-locked or otherwise restricted (shown red on the source list). */
  restricted?: boolean;
  notes?: string;
}

/* ------------------------------------------------------------------ LABELS */

export const LABEL_MATERIALS: MaterialRecord[] = [
  // --- laminates
  { ltStockId: 71, kind: "LABEL", role: "LAMINATE", tier: "PRIMARY", colour: "Soft Touch", description: "Soft Touch Laminate Wet Laminate" },
  { ltStockId: 160, kind: "LABEL", role: "LAMINATE", tier: "PRIMARY", colour: "Matte", description: "Matte Laminate — Thermal Transfer Compatible" },
  { ltStockId: 200, kind: "LABEL", role: "LAMINATE", tier: "PRIMARY", colour: "Clear", description: "Direct Thermal Clear Lamination", restricted: true },
  { ltStockId: 161, kind: "LABEL", role: "LAMINATE", tier: "PRIMARY", colour: "Gloss", description: "Gloss Laminate — Thermal Transfer Compatible" },
  { ltStockId: 266, kind: "LABEL", role: "LAMINATE", tier: "SPECIALITY", colour: "Clear", description: "WANA ONLY Soft Touch", restricted: true, notes: "Customer-locked to WANA" },
  { ltStockId: 65, kind: "LABEL", role: "LAMINATE", tier: "SPECIALITY", colour: "Clear", description: "ScuffProof — not thermal-transfer printable", restricted: true },
  { ltStockId: 241, kind: "LABEL", role: "LAMINATE", tier: "SPECIALITY", colour: "Clear", description: "Scuff Proof Thermal Transfer Printable", restricted: true },
  // --- substrates
  { ltStockId: 249, kind: "LABEL", role: "SUBSTRATE", tier: "PRIMARY", colour: "Holographic", description: "Holographic BOPP" },
  { ltStockId: 141, kind: "LABEL", role: "SUBSTRATE", tier: "PRIMARY", colour: "Clear", description: "Clear BOPP" },
  { ltStockId: 177, kind: "LABEL", role: "SUBSTRATE", tier: "PRIMARY", colour: "White", description: "White BOPP" },
  { ltStockId: 6, kind: "LABEL", role: "SUBSTRATE", tier: "PRIMARY", colour: "Silver", description: "Silver / Metallic BOPP" },
  { ltStockId: 209, kind: "LABEL", role: "SUBSTRATE", tier: "PRIMARY", colour: "White", description: "White Sqz BOPP w/ Paper Liner", restricted: true },
  { ltStockId: 72, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "White", description: "Direct Thermal White — Paper Liner", notes: "Used for Curaleaf" },
  { ltStockId: 73, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "White", description: "Thermal Transfer — Paper Liner" },
  { ltStockId: 94, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "White", description: "Beverage Labels BOPP — White", restricted: true },
  { ltStockId: 123, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "Silver", description: "Beverage Labels BOPP — Silver", restricted: true },
  { ltStockId: 129, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "White", description: "Piggyback Thermal Transfer White (paper substrate / paper liner)", restricted: true },
  { ltStockId: 130, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "White", description: "Epson Inkjet Approved White", restricted: true, notes: "Used for Acreage" },
  { ltStockId: 172, kind: "LABEL", role: "SUBSTRATE", tier: "SPECIALITY", colour: "White", description: "Piggyback Direct Thermal White (paper substrate / paper liner)", restricted: true },
];

/* ---------------------------------------------------------------- FLEXPACK */

export const FLEXPACK_MATERIALS: MaterialRecord[] = [
  { ltStockId: 199, kind: "FLEXPACK", role: "SUBSTRATE", tier: "PRIMARY", colour: "Clear", description: "Standard Clear PET", construction: "0.5 mil Clear PET / 3.0 mil LLDPE" },
  { ltStockId: 278, kind: "FLEXPACK", role: "SUBSTRATE", tier: "PRIMARY", colour: "Clear", description: "High-Barrier Clear PET", construction: "0.5 mil ALOX PET / 2.5 mil LLDPE" },
  { ltStockId: 288, kind: "FLEXPACK", role: "SUBSTRATE", tier: "PRIMARY", colour: "White", description: "White MetPet", construction: "White MetPet / 2.5 mil LLDPE", notes: "Standardised target for ALL white met pet" },
  { ltStockId: 307, kind: "FLEXPACK", role: "SUBSTRATE", tier: "PRIMARY", colour: "Silver", description: "Silver METPET", construction: "Silver MetPet / 2.5 mil LLDPE", notes: "Standardised target for ALL met pet" },
  { ltStockId: 193, kind: "FLEXPACK", role: "LAMINATE", tier: "PRIMARY", colour: "Gloss", description: "Gloss Thermal Laminate", construction: "1.2 mil PET Thermal Gloss Laminate" },
  { ltStockId: 286, kind: "FLEXPACK", role: "LAMINATE", tier: "PRIMARY", colour: "Matte", description: "Matte Thermal Lamination", construction: "0.8 mil PET Thermal Matte Lamination" },
  { ltStockId: 296, kind: "FLEXPACK", role: "LAMINATE", tier: "PRIMARY", colour: "Soft Touch", description: "Soft Touch" },
  { ltStockId: 174, kind: "FLEXPACK", role: "ZIPPER", tier: "PRIMARY", colour: "Clear", description: "CR Zipper (gen 1)" },
  { ltStockId: 176, kind: "FLEXPACK", role: "ZIPPER", tier: "PRIMARY", colour: "Clear", description: "Standard Non-CR Zipper" },
  { ltStockId: 303, kind: "FLEXPACK", role: "ZIPPER", tier: "PRIMARY", colour: "Clear", description: "Generation 2 CR Zipper" },
];

export const ALL_MATERIALS: MaterialRecord[] = [...LABEL_MATERIALS, ...FLEXPACK_MATERIALS];

export const MATERIAL_BY_ID: Record<number, MaterialRecord> = Object.fromEntries(
  // 278 appears twice on the source list (High-Barrier and "Calyx Cure Mate"); the
  // barrier construction is the one HubSpot's substrate enum can actually reach.
  ALL_MATERIALS.map((m) => [m.ltStockId, m]),
);

/* --------------------------------------------------- HubSpot → LT stock map */

/** HubSpot `label_substrate` → LT stock id. */
export const LABEL_SUBSTRATE_TO_STOCK: Record<string, number> = {
  "White BOPP": 177,
  "Silver / Metallic BOPP": 6,
  "Clear BOPP": 141,
  "Holographic BOPP": 249,
  "Thermal Transfer Paper": 73,
  "Direct Thermal Paper": 72,
};

/**
 * HubSpot `label_finish` → LT laminate stock id.
 * Varnishes are coatings, not roll stock — they consume no film, so they map to
 * `null` deliberately rather than being treated as a missing mapping.
 */
export const LABEL_FINISH_TO_STOCK: Record<string, number | null> = {
  "Matte Laminate": 160,
  "Gloss Laminate": 161,
  "Soft Touch Laminate": 71,
  "Matte Varnish": null,
  "Gloss Varnish": null,
};

/** HubSpot `flexible_packaging_substrate` → LT stock id (standardised). */
export const FLEX_SUBSTRATE_TO_STOCK: Record<string, number> = {
  "Flooded White Metalized PET (WMETPET)": 288,
  "Metalized PET (METPET)": 307,
  "High Barrier Clear PET": 278,
  "Standard Clear PET": 199,
};

/** HubSpot `flexible_packaging_finish` → LT laminate stock id. */
export const FLEX_FINISH_TO_STOCK: Record<string, number | null> = {
  "Gloss Laminate": 193,
  "Matte Laminate": 286,
  "Soft Touch Laminate": 296,
};

/** Values that explicitly mean "a human has to look at this". */
export function isUnspecifiedOption(v: string | null | undefined): boolean {
  return /^(other|custom)\b.*(specify|notes)/i.test((v ?? "").trim());
}

export interface StockResolution {
  substrateStockId: number | null;
  laminateStockId: number | null;
  /** Set when something could not be mapped; the job goes to review. */
  unmapped: string[];
}

export function resolveStocks(opts: {
  kind: MaterialKind;
  labelSubstrate?: string | null;
  labelFinish?: string | null;
  flexSubstrate?: string | null;
  flexFinish?: string | null;
}): StockResolution {
  const unmapped: string[] = [];
  let substrateStockId: number | null = null;
  let laminateStockId: number | null = null;

  if (opts.kind === "LABEL") {
    const sub = opts.labelSubstrate?.trim();
    if (!sub) unmapped.push("label_substrate is blank");
    else if (LABEL_SUBSTRATE_TO_STOCK[sub] != null) substrateStockId = LABEL_SUBSTRATE_TO_STOCK[sub]!;
    else unmapped.push(`label_substrate "${sub}" has no LT stock`);

    const fin = opts.labelFinish?.trim();
    if (fin && fin in LABEL_FINISH_TO_STOCK) laminateStockId = LABEL_FINISH_TO_STOCK[fin] ?? null;
    else if (fin) unmapped.push(`label_finish "${fin}" has no LT stock`);
  } else {
    const sub = opts.flexSubstrate?.trim();
    if (!sub) unmapped.push("flexible_packaging_substrate is blank");
    else if (FLEX_SUBSTRATE_TO_STOCK[sub] != null) substrateStockId = FLEX_SUBSTRATE_TO_STOCK[sub]!;
    else unmapped.push(`flexible_packaging_substrate "${sub}" has no LT stock`);

    const fin = opts.flexFinish?.trim();
    if (fin && fin in FLEX_FINISH_TO_STOCK) laminateStockId = FLEX_FINISH_TO_STOCK[fin] ?? null;
    else if (fin) unmapped.push(`flexible_packaging_finish "${fin}" has no LT stock`);
  }

  return { substrateStockId, laminateStockId, unmapped };
}
