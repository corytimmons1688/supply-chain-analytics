/**
 * Product category → primary capability taxonomy for the vendor network.
 * Mirrors the Calyx Supply Web taxonomy (calyx-supply-web.vercel.app).
 *
 * Vendor capabilities are stored on vendor.capabilities as a comma-separated
 * list of qualified tags, e.g. "Flexible Packaging: Domestic Rotogravure".
 * Qualification matters because some capability names repeat across
 * categories (e.g. "Domestic Digital" exists under both Flexible Packaging
 * and Labels).
 */

export interface CapabilityCategory {
  category: string;
  capabilities: string[];
}

export const CAPABILITY_TAXONOMY: CapabilityCategory[] = [
  {
    category: "Plastic Containers",
    capabilities: ["Injection", "Blow Molding", "Injection Blow Molding", "Thermoform", "Tubes"],
  },
  {
    category: "Flexible Packaging",
    capabilities: [
      "Domestic Digital",
      "Domestic Flexographic",
      "Domestic Rotogravure",
      "International Rotogravure",
      "International Digital",
      "Flexible Components",
    ],
  },
  { category: "Boxes", capabilities: ["SBS / Display Shippers", "Rigid / CR", "Corrugate"] },
  { category: "Tins", capabilities: ["Mint Tins", "CR Pre-Roll Tins", "Gummy / Edible Tins"] },
  { category: "Glass", capabilities: ["Jars", "Vials & Droppers"] },
  {
    category: "Labels",
    capabilities: ["Domestic Digital", "Domestic Flexographic", "International Labels"],
  },
  { category: "Shrinks", capabilities: ["Preform Shrink Bands", "Custom Shrink Sleeves"] },
  { category: "Hardware", capabilities: ["Scanners", "Printers"] },
  { category: "Insert / Value Add", capabilities: ["Foam Inserts", "Assembly"] },
  {
    category: "Label Material Suppliers",
    capabilities: ["Substrate", "Lamination", "Embellishments"],
  },
  { category: "Flexible Packaging Materials", capabilities: ["Pre-laminations", "Laminations"] },
  { category: "Flow Wrap / Stickpack", capabilities: ["Substrates", "Finish Options"] },
  { category: "Print Chemicals", capabilities: ["Inks", "Varnishes"] },
  { category: "General Packaging", capabilities: ["Corrugate Boxes", "Tape", "Trash Bags"] },
  { category: "Cones", capabilities: ["Pre-Rolled Cones", "Paper Pre-Roll Tubes"] },
  {
    category: "Dispensing & Applicators",
    capabilities: ["Pumps & Sprayers", "Droppers", "Syringes / Applicators"],
  },
];

/** Qualified tag stored on the vendor record, e.g. "Tins: Mint Tins". */
export function capabilityTag(category: string, capability: string): string {
  return `${category}: ${capability}`;
}

/** Parse a vendor.capabilities value into individual trimmed tags. */
export function parseCapabilities(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Serialize tags back to the stored comma-separated form (null when empty). */
export function serializeCapabilities(tags: string[]): string | null {
  return tags.length ? tags.join(", ") : null;
}
