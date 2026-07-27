/**
 * Turn carrier + PRO/tracking references inside free-text PO notes into
 * deep links to the carrier's tracking page.
 *
 * Real Calyx note formats this handles:
 *   "Confirmed. ETA 7/29/26. TT 7/22/26 XPO PRO 111884161"
 *   "Shipped Tforce Pro: 441610912 ETA 7/27/26."
 *
 * URL formats were verified live (XPO/TForce/FedEx return 200 with the number
 * in the query string). UPS blocks scripted requests but its `tracknum` deep
 * link is the long-standing canonical format. The extra LTL carriers come from
 * a public carrier-URL list — worst case a link lands on the carrier's tracking
 * page rather than the specific shipment.
 */

export interface CarrierDef {
  key: string;
  label: string;
  /** Matches the carrier name as written in notes. */
  re: RegExp;
  trackUrl: (num: string) => string;
}

export const CARRIERS: CarrierDef[] = [
  {
    key: "xpo",
    label: "XPO",
    re: /\bXPO\b/i,
    trackUrl: (n) => `https://ext-web.ltl-xpo.com/public-app/shipments?referenceNumber=${encodeURIComponent(n)}`,
  },
  {
    key: "tforce",
    label: "TForce",
    re: /\bT[\s.-]?FORCE\b/i,
    trackUrl: (n) => `https://www.tforcefreight.com/ltl/apps/Tracking?proNumbers=${encodeURIComponent(n)}`,
  },
  {
    key: "fedex",
    label: "FedEx",
    re: /\bFED[\s.-]?EX\b/i,
    trackUrl: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  },
  {
    key: "ups",
    label: "UPS",
    re: /\bUPS\b/i,
    trackUrl: (n) => `https://www.ups.com/track?loc=en_US&tracknum=${encodeURIComponent(n)}`,
  },
  {
    key: "odfl",
    label: "Old Dominion",
    re: /\b(ODFL|OLD\s+DOMINION)\b/i,
    trackUrl: (n) => `https://www.odfl.com/Trace/standardResult.faces?pro=${encodeURIComponent(n)}`,
  },
  {
    key: "estes",
    label: "Estes",
    re: /\bESTES\b/i,
    trackUrl: (n) => `https://www.estes-express.com/cgi-dta/edn419.mbr/output?search_criteria=${encodeURIComponent(n)}`,
  },
  {
    key: "saia",
    label: "SAIA",
    re: /\bSAIA\b/i,
    trackUrl: (n) => `https://www.saiasecure.com/tracing/n_manifest.asp?link=y&pro=${encodeURIComponent(n)}`,
  },
  {
    key: "rl",
    label: "R+L Carriers",
    // Written as "R&L Carriers", "R+L", "RL Carriers" — accept & or + or neither.
    re: /\bR\s*[&+]?\s*L(?:\s+CARRIERS)?\b/i,
    trackUrl: (n) => `https://www2.rlcarriers.com/freight/shipping/shipment-tracing?pro=${encodeURIComponent(n)}&docType=PRO`,
  },
];

export type NoteSegment =
  | { kind: "text"; text: string }
  | { kind: "track"; text: string; carrier: string; number: string; url: string };

/** A UPS 1Z barcode is unambiguous, so it links even without the carrier word. */
const UPS_1Z = /\b1Z[0-9A-Z]{16}\b/i;
/**
 * Tracking number following a carrier name. Between the two we tolerate only
 * punctuation and known filler words — carrier suffixes ("Carriers", "Freight",
 * "Logistics") and reference labels ("PRO", "PRO#", "Tracking", "BOL"). Keeping
 * the gap to a known vocabulary avoids grabbing an unrelated number later in the
 * note (e.g. a date or quantity). LTL PROs run 8-12 digits; parcel can be longer.
 */
const NUM_AFTER_CARRIER = new RegExp(
  "^(?:[\\s:#,.\\-]|" +
    "CARRIERS?\\b|FREIGHT\\b|LOGISTICS\\b|EXPRESS\\b|LINES?\\b|" +
    "PRO\\b|TRACKING\\b|TRACK\\b|BOL\\b|NO\\.?\\b|NUMBERS?\\b|NUM\\b" +
    ")*((?:1Z[0-9A-Z]{16})|\\d{8,22})\\b",
  "i",
);

/**
 * Split a note into plain text and linkable carrier-tracking segments.
 * Non-destructive: anything not recognized stays as text.
 */
export function parseNoteTracking(note: string | null | undefined): NoteSegment[] {
  const text = (note ?? "").replace(/\r/g, "\n");
  if (!text.trim()) return [];
  const hits: { start: number; end: number; carrier: string; number: string; url: string }[] = [];

  for (const c of CARRIERS) {
    // Scan every occurrence of this carrier name.
    const global = new RegExp(c.re.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = global.exec(text)) !== null) {
      const after = text.slice(m.index + m[0].length);
      const numMatch = NUM_AFTER_CARRIER.exec(after);
      if (!numMatch || !numMatch[1]) continue;
      const number = numMatch[1];
      const start = m.index;
      const end = m.index + m[0].length + numMatch[0].length;
      hits.push({ start, end, carrier: c.label, number, url: c.trackUrl(number) });
    }
  }
  // Bare UPS 1Z numbers not already covered by a carrier match.
  const upsGlobal = new RegExp(UPS_1Z.source, "gi");
  let u: RegExpExecArray | null;
  while ((u = upsGlobal.exec(text)) !== null) {
    const start = u.index;
    const end = start + u[0].length;
    if (hits.some((h) => start >= h.start && end <= h.end)) continue;
    const ups = CARRIERS.find((c) => c.key === "ups")!;
    hits.push({ start, end, carrier: ups.label, number: u[0], url: ups.trackUrl(u[0]) });
  }

  if (hits.length === 0) return [{ kind: "text", text }];
  // Earliest first; drop overlaps (a later carrier match inside an earlier hit).
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const segments: NoteSegment[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.start < cursor) continue;
    if (h.start > cursor) segments.push({ kind: "text", text: text.slice(cursor, h.start) });
    segments.push({
      kind: "track",
      text: text.slice(h.start, h.end),
      carrier: h.carrier,
      number: h.number,
      url: h.url,
    });
    cursor = h.end;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}
