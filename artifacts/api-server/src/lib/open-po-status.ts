/**
 * Where an open order stands, for someone asking "when do I get this material?"
 *
 * This lived in the dashboard's OpenPosTable, which was fine while the report
 * had one reader. The weekday digest email is a second reader, and two copies of
 * these rules would drift — a buyer acting on the email and a buyer looking at
 * the screen have to see the same status. So the classification lives here and
 * both render from it.
 */

import { parseNoteTracking, CARRIERS, type NoteSegment } from "@workspace/carrier-tracking";

export type PoStatus =
  | "pending_confirmation"
  | "confirmed"
  | "extended"
  | "in_transit"
  | "past_due"
  | "release_draft"
  | "release_requested"
  | "release_confirmed";

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  pending_confirmation: "Pending vendor confirmation",
  confirmed: "Confirmed",
  extended: "Confirmed · extended lead time",
  in_transit: "In transit",
  past_due: "Past due",
  release_draft: "Release drafted · not sent",
  release_requested: "Release requested",
  release_confirmed: "Release confirmed",
};

/** Worst news first, for tie-breaking rows that share a date. */
export const PO_STATUS_RANK: Record<PoStatus, number> = {
  past_due: 0,
  release_draft: 1,
  pending_confirmation: 2,
  release_requested: 3,
  in_transit: 4,
  extended: 5,
  release_confirmed: 6,
  confirmed: 7,
};

/**
 * Is this a make-and-hold order rather than inbound freight?
 *
 * Judged from the Label Traxx supplier, NOT the vendor's own feed — Dazpak's
 * report omits some of their own POs (stocks 308/318), so a feed-only check
 * shows those as ordinary inbound orders. Make-and-hold material sits in the
 * vendor's warehouse, so it's supply; only a release we've asked for is coming.
 */
export function isMakeAndHoldPo(supplierName: string | null | undefined): boolean {
  return /dazpak/i.test(supplierName ?? "");
}

/**
 * Tracking references a buyer (or the agent) recorded in the PO notes.
 *
 * Uses the dashboard's own parser rather than a fresh regex: it encodes the real
 * note formats Calyx writes ("Shipped Tforce Pro: 441610912 ETA 7/27/26.", PRO
 * before or after the carrier name) and rejects dates that look like numbers. A
 * looser pattern would read "no tracking yet" as in-transit.
 */
export function trackingRefs(notes: string | null | undefined): { carrier: string; number: string; url: string }[] {
  return parseNoteTracking(notes)
    .filter((s): s is Extract<NoteSegment, { kind: "track" }> => s.kind === "track")
    .map((s) => ({ carrier: s.carrier, number: s.number, url: s.url }));
}

export function hasTrackingNote(notes: string | null | undefined): boolean {
  return trackingRefs(notes).length > 0;
}

export interface TrackingRef {
  carrier: string;
  number: string;
  /** Deep link when the carrier is recognised; null when it isn't. */
  url: string | null;
}

/**
 * Resolve a carrier name to a tracking URL, or null when we don't know it.
 *
 * The classifier records whatever the vendor said. LTL vendors often give a PRO
 * with no carrier at all — Reynolds sent "The PRO # is 99972953555" — and the
 * classifier stored the carrier as the generic "PRO/Freight". There is no link
 * for that, but the NUMBER is still the useful thing, so it must survive.
 */
export function resolveTrackingUrl(carrier: string, number: string): string | null {
  const c = CARRIERS.find((x) => x.re.test(carrier));
  return c ? c.trackUrl(number.replace(/-/g, "")) : null;
}

/**
 * Every tracking reference known for a PO, structured extractions first.
 *
 * The report used to re-parse the free-text note the agent had written, which
 * threw away better information: the classifier already produced {carrier,
 * number} and we stored it on the timeline. Worse, note-parsing requires a
 * RECOGNISED carrier, so a PRO from an unnamed LTL carrier vanished from the
 * screen even though it was captured — PO 2595 shipped and read as untracked.
 *
 * Notes are still parsed, for numbers a buyer typed in by hand. Deduped on the
 * number, since the same reference usually appears in both.
 */
export function mergeTracking(
  structured: { carrier?: string | null; number?: string | null }[],
  notes: string | null | undefined,
): TrackingRef[] {
  const out: TrackingRef[] = [];
  const seen = new Set<string>();
  const add = (carrier: string, number: string) => {
    const key = number.replace(/[\s-]/g, "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ carrier: carrier || "Tracking", number, url: resolveTrackingUrl(carrier, number) });
  };
  for (const t of structured) {
    const num = String(t?.number ?? "").trim();
    if (num) add(String(t?.carrier ?? "").trim(), num);
  }
  for (const t of trackingRefs(notes)) add(t.carrier, t.number);
  return out;
}

export interface OpenPoClassifyInput {
  /** Vendor's commitment where we have one. */
  promisedDeliveryDate: string | null;
  /** What we asked for — shown when the vendor hasn't confirmed. */
  requestedDeliveryDate: string | null;
  notes: string | null;
  /** Tracking already known for this PO, structured or parsed. */
  trackingCount?: number;
  extendedLeadTime: boolean;
  extendedLeadTimeDays: number | null;
  /** Today, ISO. Passed in so callers agree on the boundary. */
  todayIso: string;
}

export interface OpenPoClassification {
  status: PoStatus;
  /** The date the row is planned against — promised if we have it, else requested. */
  date: string | null;
  dateIsPromised: boolean;
  note: string;
}

export function classifyOpenPo(input: OpenPoClassifyInput): OpenPoClassification {
  const date = input.promisedDeliveryDate ?? input.requestedDeliveryDate ?? null;
  const dateIsPromised = Boolean(input.promisedDeliveryDate);
  let status: PoStatus;
  let note: string;
  if ((input.trackingCount ?? 0) > 0 || hasTrackingNote(input.notes)) {
    status = "in_transit";
    note = "Tracking received";
  } else if (date && date < input.todayIso) {
    status = "past_due";
    note = dateIsPromised
      ? `Vendor committed ${date} and it hasn't arrived`
      : `Requested ${date}, still no vendor confirmation`;
  } else if (!dateIsPromised) {
    status = "pending_confirmation";
    note = date ? `We asked for ${date}; vendor hasn't confirmed a date` : "No dates on this PO at all";
  } else if (input.extendedLeadTime) {
    status = "extended";
    note = `Vendor committed ${date}${
      input.extendedLeadTimeDays ? `, ${input.extendedLeadTimeDays} days past our request` : ""
    }`;
  } else {
    status = "confirmed";
    note = `Vendor committed ${date}`;
  }
  return { status, date, dateIsPromised, note };
}

export interface ReleaseClassifyInput {
  promisedDate: string | null;
  requestedDeliveryDate: string | null;
  notes: string | null;
  /** Null = drafted but never sent to the vendor. */
  emailedAt: string | null;
  needsAttention: boolean;
  attentionReason: string | null;
  todayIso: string;
}

/** A make-and-hold release: material we've asked the vendor to ship from hold. */
export function classifyRelease(input: ReleaseClassifyInput): OpenPoClassification {
  const date = input.promisedDate ?? input.requestedDeliveryDate ?? null;
  const dateIsPromised = Boolean(input.promisedDate);
  let status: PoStatus;
  let note: string;
  if (!input.emailedAt) {
    status = "release_draft";
    note = "Drafted but not sent — the vendor hasn't been asked yet";
  } else if (hasTrackingNote(input.notes)) {
    status = "in_transit";
    note = "Tracking received";
  } else if (date && date < input.todayIso) {
    status = "past_due";
    note = dateIsPromised
      ? `Vendor committed ${date} and it hasn't arrived`
      : `Release requested for ${date}, still no confirmation`;
  } else if (dateIsPromised) {
    status = "release_confirmed";
    note = `Vendor confirmed release for ${date}`;
  } else {
    status = "release_requested";
    note = `Requested ${input.emailedAt.slice(0, 10)}; awaiting confirmation`;
  }
  if (input.needsAttention && input.attentionReason) note = `${note} · ${input.attentionReason}`;
  return { status, date, dateIsPromised, note };
}
