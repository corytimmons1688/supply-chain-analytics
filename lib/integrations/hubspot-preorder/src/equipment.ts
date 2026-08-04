/**
 * The machine chain, make-ready footage, and the ASSUMPTION REGISTRY.
 *
 * Every number that moves a purchase order lives here with a provenance tag, and
 * the UI renders the whole registry as a control tower. The point is that a
 * planner can audit the forecast instead of trusting it: anything tagged
 * NOT_SOURCED is visibly missing, not quietly defaulted to something plausible.
 *
 * Sourced so far (Mirhaan, 2026-08-04):
 *   HP press        make-ready 150 ft per job
 *   ABGA            label laminating spoilage curve (no embellishment)
 *   ABG3            label laminating spoilage curve (any embellishment)
 *   flexpack lam.   spoilage curve
 *
 * NOT sourced yet — these contribute ZERO feet and say so:
 *   make-ready on ABGA / ABG3 / flexpack laminator
 *   colour-change and plate/die-change footage on HP
 *   HP's own spoilage curve
 *   Flexographic and Rotogravure curves (9 internal flexpack jobs route there)
 */

import { ABG3, ABGA, THERMO, type SpoilageMachine } from "./spoilage";

export type Provenance = "LT_RECORD" | "USER_CONFIRMED" | "DERIVED" | "REPO_RULE" | "NOT_SOURCED";

export interface Assumption {
  id: string;
  group: "Press" | "Laminating" | "Layout" | "Pass rule" | "Scope" | "Probability";
  label: string;
  /** Human-readable current value. "—" when not sourced. */
  value: string;
  provenance: Provenance;
  /** Why it matters / what breaks while it is missing. */
  note: string;
  /** True when a missing value makes the forecast a floor rather than a number. */
  understatesWhenMissing?: boolean;
}

/* ------------------------------------------------------------------- presses */

export interface PressRecord {
  code: string;
  label: string;
  /** Make-ready feet per job. */
  setupFt: number;
  setupProvenance: Provenance;
  /** Extra make-ready per colour change, ft. */
  colourChangeFt: number | null;
  /** Extra make-ready per plate / die-tool change, ft. */
  plateChangeFt: number | null;
  /** The press's own spoilage curve, when we have one. */
  spoilage: SpoilageMachine | null;
}

export const HP: PressRecord = {
  code: "HP",
  label: "HP digital press",
  setupFt: 150,
  setupProvenance: "USER_CONFIRMED",
  colourChangeFt: null,
  plateChangeFt: null,
  spoilage: null,
};

/** Non-digital routes we can see in HubSpot but cannot cost yet. */
export const UNCOSTED_PRESSES = ["Domestic Flexographic", "International Rotogravure"] as const;

/**
 * HubSpot `requested_quote_location` → press.
 * Labels leave the field blank on 211/212 internal records, so HP is the
 * assumption there and it is registered as such below.
 */
export function pressFor(requestedQuoteLocation: string | null | undefined): {
  press: PressRecord;
  costable: boolean;
  routeLabel: string;
} {
  const v = (requestedQuoteLocation ?? "").trim();
  if (!v) return { press: HP, costable: true, routeLabel: "(blank → assumed HP digital)" };
  if (/digital/i.test(v)) return { press: HP, costable: true, routeLabel: v };
  if (/flexograph|rotogravure/i.test(v)) return { press: HP, costable: false, routeLabel: v };
  return { press: HP, costable: false, routeLabel: v };
}

/* --------------------------------------------------------------- laminating */

export interface LaminatorRecord {
  spoilage: SpoilageMachine;
  setupFt: number;
  setupProvenance: Provenance;
}

/** Make-ready on every laminating pass is unsourced ⇒ 0 ft, flagged. */
const NO_SETUP = { setupFt: 0, setupProvenance: "NOT_SOURCED" as Provenance };

export const LAMINATORS: Record<string, LaminatorRecord> = {
  ABGA: { spoilage: ABGA, ...NO_SETUP },
  ABG3: { spoilage: ABG3, ...NO_SETUP },
  Thermo: { spoilage: THERMO, ...NO_SETUP },
};

/* ------------------------------------------------------------ layout rules */

export const LAYOUT = {
  columnSpacingIn: 0.125,
  rowSpacingIn: 0.125,
  usableWebWidthIn: 12.5,
  maxRepeatIn: 24,
} as const;

/* --------------------------------------------------- the assumption registry */

export function assumptionRegistry(): Assumption[] {
  return [
    {
      id: "hp.setup",
      group: "Press",
      label: "HP make-ready per job",
      value: `${HP.setupFt} ft`,
      provenance: "USER_CONFIRMED",
      note: "Applied once per job on the press pass.",
    },
    {
      id: "hp.spoilage",
      group: "Press",
      label: "HP spoilage curve",
      value: "—",
      provenance: "NOT_SOURCED",
      note: "Press pass currently carries make-ready only. The laminating pass supplies the spoilage, and requirement is max(passes), so this rarely drives the number — but it is missing.",
      understatesWhenMissing: true,
    },
    {
      id: "hp.colour",
      group: "Press",
      label: "Colour-change footage",
      value: "—",
      provenance: "NOT_SOURCED",
      note: "No per-colour make-ready is added. Multi-colour jobs are understated.",
      understatesWhenMissing: true,
    },
    {
      id: "hp.plate",
      group: "Press",
      label: "Plate / die-tool change footage",
      value: "—",
      provenance: "NOT_SOURCED",
      note: "New-die jobs get no extra make-ready.",
      understatesWhenMissing: true,
    },
    {
      id: "press.route",
      group: "Press",
      label: "Label press routing",
      value: "assumed HP digital",
      provenance: "DERIVED",
      note: "requested_quote_location is blank on 211 of 212 internal label records, so HP is assumed. Flexpack carries the field (172/189 Domestic Digital).",
    },
    {
      id: "press.uncosted",
      group: "Press",
      label: "Flexographic / Rotogravure curves",
      value: "—",
      provenance: "NOT_SOURCED",
      note: "9 internal flexpack jobs route to non-digital presses. They are costed on the digital assumption and flagged on the line.",
      understatesWhenMissing: true,
    },
    {
      id: "abga.curve",
      group: "Laminating",
      label: "ABGA spoilage (plain labels)",
      value: "0–50:20% · 51–101:6% · 101–3k:5% · 3k–4k:4% · 4k–5k:3% · 5k–10k:3% · 10k–12.5k:2.5% · 12.5k–100k:2.25% · min 2%",
      provenance: "LT_RECORD",
      note: "Single-bracket first-match lookup, never a banded sum.",
    },
    {
      id: "abg3.curve",
      group: "Laminating",
      label: "ABG3 spoilage (embellished labels)",
      value: "0–100:100% · 101–200:50% · 201–1k:8% · 1k–2.5k:6% · 2.5k–5k:5% · 5k+:4% · min 2%",
      provenance: "LT_RECORD",
      note: "Replaces ABGA when embellishment is Flat/Tactile Spot UV, Cold Foil, Cast & Cure, or peel-and-reveal.",
    },
    {
      id: "thermo.curve",
      group: "Laminating",
      label: "Thermo spoilage (flexpack laminating)",
      value: "0–500:3% · 501–2.5k:1% · 2.5k–5k:1% · 5k+:1% · min 2%",
      provenance: "LT_RECORD",
      note: "The 2% minimum overrides the 1% brackets, so effective spoilage above 500 ft is 2%, never 1%. Lines where the floor won are marked.",
    },
    {
      id: "lam.setup",
      group: "Laminating",
      label: "Laminating make-ready (ABG A / ABG 3 / Thermo)",
      value: "—",
      provenance: "NOT_SOURCED",
      note: "Contributes 0 ft. Every job is understated by the real laminating make-ready until these are supplied.",
      understatesWhenMissing: true,
    },
    {
      id: "layout.spacing",
      group: "Layout",
      label: "Column / row spacing",
      value: `${LAYOUT.columnSpacingIn}" / ${LAYOUT.rowSpacingIn}"`,
      provenance: "REPO_RULE",
      note: "HubSpot never supplies gaps; these are the estimating standards.",
    },
    {
      id: "layout.web",
      group: "Layout",
      label: "Usable web width",
      value: `${LAYOUT.usableWebWidthIn}"`,
      provenance: "REPO_RULE",
      note: "Used when the stock record does not supply a width. Real master widths come from lt_stock.",
    },
    {
      id: "layout.copyposition",
      group: "Layout",
      label: "Copy position → orientation",
      value: "Copy 1–4 → OUT_TOP/BTM/RIGHT/LEFT",
      provenance: "REPO_RULE",
      note: "LEFT/RIGHT rotate the label 90°, worth up to 37% of the footage. Filled on 100% of internal label records, so nothing is assumed in practice.",
    },
    {
      id: "pass.labels",
      group: "Pass rule",
      label: "Label requirement",
      value: "max(press, laminate)",
      provenance: "REPO_RULE",
      note: "One web through every station, so you buy for the hungriest pass — not the sum.",
    },
    {
      id: "pass.flex",
      group: "Pass rule",
      label: "Flexpack requirement",
      value: "compounding Π(1 + sᵢ)",
      provenance: "REPO_RULE",
      note: "Converting steps compound because each spoils what the previous step already spoiled.",
    },
    {
      id: "scope.internal",
      group: "Scope",
      label: "Internal only",
      value: "location = Internal",
      provenance: "USER_CONFIRMED",
      note: "External jobs are vendor-made and consume no Calyx roll stock. 403 internal of 812 in the tracked stages.",
    },
    {
      id: "scope.stages",
      group: "Scope",
      label: "Forward window",
      value: "In Progress → Quote Completed → Quote Accepted → Quote Rejected",
      provenance: "USER_CONFIRMED",
      note: "Request Que and Pending Information are too speculative to buy against. Rejected is carried as the attrition arm at probability 0.",
    },
    {
      id: "scope.materials",
      group: "Scope",
      label: "Material scope",
      value: "all referenced stocks",
      provenance: "USER_CONFIRMED",
      note: "Demand landing on a stock outside the 19-item tracked list is counted and flagged, never dropped.",
    },
    {
      id: "scope.metpet",
      group: "Scope",
      label: "MetPet standardisation",
      value: "white → 288 · silver → 307",
      provenance: "USER_CONFIRMED",
      note: "All white met pet maps to 288 and all met pet to 307, both at 2.5 mil LLDPE.",
    },
    {
      id: "prob.stage",
      group: "Probability",
      label: "Stage → probability",
      value: "In Progress 0.30 · Quote Completed 0.50 · Quote Accepted 0.90 · Quote Rejected 0",
      provenance: "DERIVED",
      note: "The pre-order object carries no probability metadata, unlike deals. These are conservative placeholders — replace with measured win rates per stage when available.",
    },
    {
      id: "prob.netsuite",
      group: "Probability",
      label: "NetSuite sales orders",
      value: "probability 1.0 (firm)",
      provenance: "REPO_RULE",
      note: "A sales order is committed demand. Stored NetSuite footage used a flat 8% spoilage; it is recomputed here on the real curves so both sources share one model.",
    },
    {
      id: "goals.derived",
      group: "Scope",
      label: "Safety stock / reorder point",
      value: "derived from history",
      provenance: "DERIVED",
      note: "stock_goal.min and reorder_point_footage are empty for all tracked materials, so both are derived from usage and PO lead-time history and badged 'derived, not set' wherever shown.",
    },
  ];
}

/** Convenience for the UI: which assumptions currently understate the forecast. */
export function understatingAssumptions(): Assumption[] {
  return assumptionRegistry().filter((a) => a.provenance === "NOT_SOURCED" && a.understatesWhenMissing);
}
