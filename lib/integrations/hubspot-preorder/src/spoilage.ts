/**
 * Spoilage curves, transcribed VERBATIM from the LabelTraxx "Press Speeds and
 * Spoilage" screens. These are Calyx engineering assumptions — this module
 * reports them, it does not tune them.
 *
 * Machine routing (confirmed by Mirhaan, 2026-08-04):
 *   LABELS,   embellishment = None  →  ABGA   (laminating only)
 *   LABELS,   any embellishment     →  ABG3   (replaces ABGA, not an extra pass)
 *   FLEXPACK, laminating            →  FLEXLAM
 *
 * "Any embellishment" = Flat Spot UV · Tactile Spot UV · Cold Foil · Cast & Cure
 * · an "Other" embellishment specified in notes · or a peel-and-reveal label.
 *
 * ⚠ THE MIN FLOOR BITES. Every one of these LT records carries
 * `Spoilage Percent Min = 2`. FLEXLAM's own brackets are 1%, so the floor
 * overrides them and effective flexpack spoilage is 2%, never 1%. That is not a
 * transcription error — it is what LT will compute. `spoilageFloored` is returned
 * true whenever the floor won, so the UI can show it rather than hide it.
 *
 * BRACKET LOOKUP IS FIRST-MATCH, SINGLE BRACKET — never a banded sum. LT's own
 * ranges overlap at the seams (ABGA has "51–101" immediately followed by
 * "101–3,000"), so at exactly 101 ft the FIRST matching bracket wins (6%). Do not
 * "tidy" the boundaries; parity with LT depends on them staying as entered.
 */

export interface SpoilageBracket {
  lowFt: number;
  /** 0 = unbounded top bracket ("To 0" in LT means "keeps going"). */
  highFt: number;
  pct: number;
}

export interface SpoilageMachine {
  ltCode: string;
  label: string;
  /** `Spoilage Percent Min` on the LT record. */
  minPct: number;
  /** `Spoilage Percent Max` on the LT record. */
  maxPct: number;
  brackets: SpoilageBracket[];
  provenance: string;
}

/** LABELS · laminating only · no embellishment. Top bracket ends at 100,000 ft. */
export const ABGA: SpoilageMachine = {
  ltCode: "ABGA",
  label: "ABGA — label laminating",
  minPct: 2,
  maxPct: 100,
  brackets: [
    { lowFt: 0, highFt: 50, pct: 20 },
    { lowFt: 51, highFt: 101, pct: 6 },
    { lowFt: 101, highFt: 3_000, pct: 5 },
    { lowFt: 3_001, highFt: 4_000, pct: 4 },
    { lowFt: 4_001, highFt: 5_000, pct: 3 },
    { lowFt: 5_001, highFt: 7_500, pct: 3 },
    { lowFt: 7_501, highFt: 10_000, pct: 3 },
    { lowFt: 10_001, highFt: 12_500, pct: 2.5 },
    { lowFt: 12_501, highFt: 15_000, pct: 2.25 },
    { lowFt: 15_001, highFt: 100_000, pct: 2.25 },
  ],
  provenance: "LT Press Speeds & Spoilage · ABGA · labels, laminating only",
};

/** LABELS · any embellishment. Replaces ABGA for that job. */
export const ABG3: SpoilageMachine = {
  ltCode: "ABG3",
  label: "ABG3 — label embellishment + laminating",
  minPct: 2,
  maxPct: 100,
  brackets: [
    { lowFt: 0, highFt: 100, pct: 100 },
    { lowFt: 101, highFt: 200, pct: 50 },
    { lowFt: 201, highFt: 1_000, pct: 8 },
    { lowFt: 1_001, highFt: 2_500, pct: 6 },
    { lowFt: 2_501, highFt: 5_000, pct: 5 },
    { lowFt: 5_001, highFt: 0, pct: 4 },
  ],
  provenance: "LT Press Speeds & Spoilage · ABG3 · embellished labels (spot UV, foil, peel-and-reveal)",
};

/**
 * FLEXPACK · laminating — the LT equipment record is **Thermo** (confirmed by
 * Mirhaan 2026-08-04, and corroborated by every real flexpack product on the LT
 * API, which routes HP 6900 → Thermo → (ABG 3) → Suncentre1).
 *
 * Brackets are 1% but the 2% min floor overrides them.
 */
export const THERMO: SpoilageMachine = {
  ltCode: "Thermo",
  label: "Thermo — flexpack laminating",
  minPct: 2,
  maxPct: 100,
  brackets: [
    { lowFt: 0, highFt: 500, pct: 3 },
    { lowFt: 501, highFt: 2_500, pct: 1 },
    { lowFt: 2_501, highFt: 5_000, pct: 1 },
    { lowFt: 5_001, highFt: 0, pct: 1 },
  ],
  provenance: "LT Press Speeds & Spoilage · Thermo (flexpack laminating)",
};

export const MACHINES: SpoilageMachine[] = [ABGA, ABG3, THERMO];

/** Embellishment values (HubSpot `embellishment`) that route a label to ABG3. */
const NON_EMBELLISHED = new Set(["", "none"]);

export function hasEmbellishment(embellishment: string | null | undefined): boolean {
  const v = (embellishment ?? "").trim().toLowerCase();
  return !NON_EMBELLISHED.has(v);
}

/** True when the notes mention peel-and-reveal, which also routes to ABG3. */
export function mentionsPeelAndReveal(...notes: (string | null | undefined)[]): boolean {
  const hay = notes.filter(Boolean).join(" ").toLowerCase();
  return /peel[\s-]*(and|&|n)?[\s-]*reveal|peel[\s-]*back/.test(hay);
}

/**
 * Which laminating machine a job runs on.
 * Labels: ABG3 when embellished or peel-and-reveal, else ABGA. Flexpack: FLEXLAM.
 */
export function machineFor(opts: {
  kind: "LABEL" | "FLEXPACK";
  embellishment?: string | null;
  notes?: (string | null | undefined)[];
}): SpoilageMachine {
  if (opts.kind === "FLEXPACK") return THERMO;
  const embellished =
    hasEmbellishment(opts.embellishment) || mentionsPeelAndReveal(...(opts.notes ?? []));
  return embellished ? ABG3 : ABGA;
}

export interface SpoilageResult {
  /** The bracket percentage that matched, before the floor. */
  bracketPct: number;
  /** What actually gets applied, after min floor and max cap. */
  appliedPct: number;
  /** True when the min floor raised the bracket value. */
  spoilageFloored: boolean;
  /** True when nothing matched (length beyond the top bracket's ceiling). */
  outOfRange: boolean;
  machine: SpoilageMachine;
}

/**
 * Single-bracket, first-match lookup, then floor/cap.
 *
 * A length past a bounded top bracket (ABGA stops at 100,000 ft) is flagged
 * `outOfRange` and falls back to the last bracket rather than silently
 * returning 0 — a 0% spoilage on a 120,000 ft run would understate a PO.
 */
export function spoilageFor(lengthFt: number, machine: SpoilageMachine): SpoilageResult {
  const ft = Math.max(0, lengthFt);
  let bracketPct: number | null = null;
  for (const b of machine.brackets) {
    if (ft >= b.lowFt && (b.highFt === 0 || ft <= b.highFt)) {
      bracketPct = b.pct;
      break;
    }
  }
  const outOfRange = bracketPct === null;
  if (bracketPct === null) {
    bracketPct = machine.brackets[machine.brackets.length - 1]?.pct ?? machine.minPct;
  }
  const floored = bracketPct < machine.minPct;
  const applied = Math.min(machine.maxPct, Math.max(machine.minPct, bracketPct));
  return { bracketPct, appliedPct: applied, spoilageFloored: floored, outOfRange, machine };
}

/** @deprecated real LT record is `Thermo`. Kept so older imports still resolve. */
export const FLEXLAM = THERMO;
