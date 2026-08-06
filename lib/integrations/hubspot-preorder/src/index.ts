/**
 * HubSpot Pre-Order Support → material forecasting. PHASE 1: READ ONLY.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS MODULE NEVER WRITES TO HUBSPOT.                                     │
 * │ Only GET and POST /search (HubSpot's read endpoint) are reachable —       │
 * │ `hsRequest` hard-rejects any other verb, so a write cannot be added by    │
 * │ accident. There is no create/update/delete path in this file by design.   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Scope rules (Mirhaan, 2026-08-04):
 *   • INTERNAL ONLY — `location = "Internal"`. External jobs are made by a
 *     vendor and consume none of our roll stock, so they are not material demand.
 *     Measured: 403 internal / 409 external across the tracked stages, and the
 *     internal half is the clean half (copy_position 100% filled vs 29% overall).
 *   • Forward window is the estimating pipeline from IN PROGRESS onward:
 *     In Progress → Quote Completed → Quote Accepted → Quote Rejected.
 *     Request Que / Pending Information are too speculative to buy against.
 *     Rejected is pulled deliberately: it is the attrition arm of the flow, and
 *     contributes zero committed demand.
 */

import {
  resolveStocks,
  isUnspecifiedOption,
  type MaterialKind,
} from "./materials";
import { machineFor, spoilageFor, type SpoilageResult } from "./spoilage";

export * from "./materials";
export * from "./spoilage";
export * from "./equipment";

/* ------------------------------------------------------------------ config */

const HUBSPOT_BASE = "https://api.hubapi.com";
/** Pre Order Support custom object. */
export const PREORDER_OBJECT_TYPE = "2-52567425";
/** Estimating pipeline. */
export const ESTIMATING_PIPELINE_ID = "820783656";

export const STAGE = {
  REQUEST_QUE: "1213197073",
  PENDING_INFORMATION: "1213197074",
  IN_PROGRESS: "1213427979",
  QUOTE_COMPLETED: "1213427980",
  QUOTE_ACCEPTED: "1213427981",
  QUOTE_REJECTED: "1213427982",
  NEW_PRODUCT_REQUEST: "1350989624",
  QUOTE_APPROVED_OLD: "1398242410",
} as const;

/**
 * The forward-look window, ordered farthest-out → closest-to-decided.
 * This ordering is also the Sankey's column order.
 */
export const FORWARD_STAGES = [
  STAGE.IN_PROGRESS,
  STAGE.QUOTE_COMPLETED,
  STAGE.QUOTE_ACCEPTED,
  STAGE.QUOTE_REJECTED,
] as const;

export const STAGE_LABEL: Record<string, string> = {
  [STAGE.IN_PROGRESS]: "In Progress",
  [STAGE.QUOTE_COMPLETED]: "Quote Completed",
  [STAGE.QUOTE_ACCEPTED]: "Quote Accepted",
  [STAGE.QUOTE_REJECTED]: "Quote Rejected",
};

/** Terminal outcome of a stage: does it still convert, win, or lose? */
export type StageOutcome = "OPEN" | "WON" | "LOST";
export const STAGE_OUTCOME: Record<string, StageOutcome> = {
  [STAGE.IN_PROGRESS]: "OPEN",
  [STAGE.QUOTE_COMPLETED]: "OPEN",
  [STAGE.QUOTE_ACCEPTED]: "WON",
  [STAGE.QUOTE_REJECTED]: "LOST",
};

/**
 * Probability that a stage's footage becomes real material.
 * Deliberately conservative and explicit — not a HubSpot field, because the
 * pre-order object's stages carry no probability metadata (unlike deals).
 */
export const STAGE_PROBABILITY: Record<string, number> = {
  [STAGE.IN_PROGRESS]: 0.3,
  [STAGE.QUOTE_COMPLETED]: 0.5,
  [STAGE.QUOTE_ACCEPTED]: 0.9,
  [STAGE.QUOTE_REJECTED]: 0,
};

/** Properties pulled. Kept explicit so the payload stays small and auditable. */
export const PREORDER_PROPERTIES = [
  "hs_object_id", "hs_createdate", "hs_lastmodifieddate", "hs_pipeline", "hs_pipeline_stage",
  "custom_item_name", "estimate_id", "estimate_number", "due_date", "hubspot_owner_id",
  "location", "primary_vendor", "requested_quote_location",
  "quantity_needed", "product_width", "product_height", "product_depth",
  "copy_position", "embellishment", "specialty_ink",
  "label_substrate", "label_finish", "label_application_method",
  "flexible_packaging_substrate", "flexible_packaging_finish", "flexible_packaging_style",
  "gusset_style", "zipper", "of_skus", "new_die_tool_needed", "die_tool",
  "additional_label_notes", "additional_flexpack_notes", "additional_estimating_notes",
] as const;

/* ------------------------------------------------------------------- client */

export interface HubspotConfig {
  /** Private app token. Read scopes are all this integration needs. */
  token: string;
  fetchImpl?: typeof fetch;
}

export function hubspotConfigured(token = process.env["HUBSPOT_TOKEN"] ?? ""): boolean {
  return Boolean(token);
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The ONLY network primitive in this package. `method` is constrained to the two
 * read verbs HubSpot needs; anything else throws before a request is made.
 */
async function hsRequest<T>(
  cfg: HubspotConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  if (method === "POST" && !path.includes("/search")) {
    throw new Error(
      `Refusing non-search POST to ${path}. @workspace/hubspot-preorder is read-only.`,
    );
  }
  if (!cfg.token) throw new Error("HUBSPOT_TOKEN is not configured");
  const doFetch = cfg.fetchImpl ?? fetch;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(`${HUBSPOT_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (RETRYABLE.has(res.status) && attempt < 3) {
          const wait = res.status === 429 ? 2000 * (attempt + 1) : 500 * 2 ** attempt;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw new Error(`HubSpot ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt === 3) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error("HubSpot request failed");
}

export interface RawPreorder {
  id: string;
  properties: Record<string, string | null>;
}

interface SearchResponse {
  total: number;
  results: RawPreorder[];
  paging?: { next?: { after?: string } };
}

/**
 * Fetch every pre-order support record in the forward window.
 * Read-only: POST /search is HubSpot's query endpoint, not a mutation.
 */
export async function fetchForwardPreorders(
  cfg: HubspotConfig,
  opts: { internalOnly?: boolean; stages?: readonly string[] } = {},
): Promise<{ total: number; records: RawPreorder[] }> {
  const stages = opts.stages ?? FORWARD_STAGES;
  const filters: Record<string, unknown>[] = [
    { propertyName: "hs_pipeline", operator: "EQ", value: ESTIMATING_PIPELINE_ID },
    { propertyName: "hs_pipeline_stage", operator: "IN", values: [...stages] },
  ];
  if (opts.internalOnly !== false) {
    filters.push({ propertyName: "location", operator: "EQ", value: "Internal" });
  }

  const records: RawPreorder[] = [];
  let after: string | undefined;
  let total = 0;
  for (let page = 0; page < 40; page++) {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters }],
      properties: [...PREORDER_PROPERTIES],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      limit: 200,
    };
    if (after) body["after"] = after;
    const res = await hsRequest<SearchResponse>(
      cfg, "POST", `/crm/v3/objects/${PREORDER_OBJECT_TYPE}/search`, body,
    );
    total = res.total;
    records.push(...(res.results ?? []));
    after = res.paging?.next?.after;
    if (!after) break;
  }
  return { total, records };
}

/* ---------------------------------------------------------------- normalize */

const num = (v: string | null | undefined): number | null => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** HubSpot stores "Copy 1".."Copy 4"; LT wants its own enum. */
export const COPY_POSITION_BY_INDEX = [
  "OUT_TOP_1", "OUT_BTM_2", "OUT_RIGHT_3", "OUT_LEFT_4",
  "IN_TOP_5", "IN_BTM_6", "IN_RIGHT_7", "IN_LEFT_8",
] as const;
export type LtCopyPosition = (typeof COPY_POSITION_BY_INDEX)[number];
export const DEFAULT_COPY_POSITION: LtCopyPosition = "OUT_BTM_2";

export function ltCopyPosition(v: string | null | undefined): LtCopyPosition | null {
  if (!v) return null;
  const m = /^Copy\s*(\d)$/i.exec(v.trim());
  if (!m) return null;
  return COPY_POSITION_BY_INDEX[Number(m[1]) - 1] ?? null;
}

/** LEFT/RIGHT rotate the label 90°, swapping which edge runs down-web. */
export function swapsDimensions(cp: LtCopyPosition): boolean {
  return cp === "OUT_LEFT_4" || cp === "OUT_RIGHT_3" || cp === "IN_LEFT_8" || cp === "IN_RIGHT_7";
}

export interface NormalizedJob {
  id: string;
  itemName: string;
  estimateId: string | null;
  kind: MaterialKind;
  stageId: string;
  stageLabel: string;
  outcome: StageOutcome;
  probability: number;
  location: string | null;
  primaryVendor: string | null;
  /** Parsed out of `custom_item_name`; HubSpot has no customer property here. */
  customer: string | null;
  createdAt: string | null;
  dueDate: string | null;
  qty: number | null;
  widthIn: number | null;
  heightIn: number | null;
  depthIn: number | null;
  copyPositionRaw: string | null;
  copyPosition: LtCopyPosition | null;
  copyPositionAssumed: boolean;
  embellishment: string | null;
  /** ABGA / ABG3 / FLEXLAM, per the routing rules. */
  machineCode: string;
  substrateRaw: string | null;
  finishRaw: string | null;
  substrateStockId: number | null;
  laminateStockId: number | null;
  /** Empty ⇒ forecastable. Non-empty ⇒ review queue. */
  blockers: string[];
  notes: string | null;
}

/**
 * Only jobs Calyx makes itself consume Calyx roll stock. `location = Internal`
 * is filtered at the query, but that alone leaks jobs outsourced to another
 * converter: measured 2026-08-06, 7 of 407 internal forward-stage records carry
 * a different `primary_vendor` (Ross Print / Packaging, Ted Pack, Virtual
 * Packaging) — 165,000 units of it sitting in Quote Completed, i.e. live
 * phantom demand.
 */
export const CALYX_VENDOR = "Calyx Containers";

/**
 * A blank `primary_vendor` is ambiguous, not safe. Dropping blanks silently
 * would be the worse failure mode, so they are kept and blocked into the review
 * queue instead. (3 of the 7 above are blank, all Quote Rejected today, so this
 * costs nothing now and stays correct if that changes.)
 */
function vendorScope(
  primaryVendor: string | null,
): { inScope: boolean; blocker: string | null } {
  const v = (primaryVendor ?? "").trim();
  if (v === "") {
    return { inScope: true, blocker: "primary_vendor is blank — cannot confirm Calyx makes this job" };
  }
  if (v.toLowerCase() !== CALYX_VENDOR.toLowerCase()) {
    return { inScope: false, blocker: null };
  }
  return { inScope: true, blocker: null };
}

/**
 * Recover the customer from `custom_item_name`. HubSpot's pre-order object has
 * no customer property, but the auto-generated name embeds it:
 *
 *   CQ-Trulieve-Flexible Packaging-3.5 x 6.5 x -59457295113   → Trulieve
 *   CQ-doTERRA Manufacturing, LLC-Labels-.9375 x 4…           → doTERRA Manufacturing, LLC
 *   CQ-Acreage Holdings -Flexible Packaging-6.5 x 8…          → Acreage Holdings
 *
 * Only the `CQ-<customer>-<class>` shape is parsed. Internal shop codes
 * (`GLOR-MI-2174-GRPE`, `BURN-FL-1926-PRLB`) carry no customer and return null
 * rather than a guess — a wrong customer is worse than an absent one, because
 * concentration and per-brand analysis silently attribute to the wrong account.
 */
/**
 * Class tokens as they actually appear, typos included: "Flexible Packing" is a
 * common misspelling in the live data and `Label` shows up singular. Matching
 * only the correct spellings loses real customers.
 */
const CLASS_TOKENS = "Labels?|Flexible Pack(?:ag)?ing|Flex Pack|Roll Stock|Boxe?s?|Rigid|Wavepack";
/**
 * An optional leading estimate id is common — `CQ-1725-Sugarhouse Farms-…` —
 * so a numeric segment straight after `CQ-` is skipped rather than mistaken for
 * the customer.
 */
const CUSTOMER_RE = new RegExp(
  `^CQ-\\s*(?:\\d+\\s*-\\s*)?(.+?)\\s*-\\s*(?:${CLASS_TOKENS})\\b`,
  "i",
);

export function customerFromItemName(itemName: string | null | undefined): string | null {
  if (!itemName) return null;
  const m = CUSTOMER_RE.exec(itemName.trim());
  if (!m) return null;
  const name = (m[1] ?? "").replace(/[-\s]+$/, "").trim();
  // A bare id (the `CQ-49878299719 Dark Horse …` shape) is not a customer name.
  if (!name || /^\d+$/.test(name)) return null;
  return name;
}

function kindOf(p: Record<string, string | null>): MaterialKind | null {
  if (p["flexible_packaging_substrate"]) return "FLEXPACK";
  if (p["label_substrate"]) return "LABEL";
  const n = (p["custom_item_name"] ?? "").toLowerCase();
  if (n.includes("flexible packaging")) return "FLEXPACK";
  if (n.includes("label")) return "LABEL";
  return null;
}

export function normalizePreorder(raw: RawPreorder): NormalizedJob | null {
  const p = raw.properties ?? {};
  const kind = kindOf(p);
  if (!kind) return null; // boxes / rigid / unknown — out of Phase 1 scope

  // Outsourced to another converter ⇒ consumes no Calyx roll stock.
  const vendor = vendorScope(p["primary_vendor"] ?? null);
  if (!vendor.inScope) return null;

  const blockers: string[] = [];
  if (vendor.blocker) blockers.push(vendor.blocker);
  const qty = num(p["quantity_needed"]);
  if (qty == null || qty <= 0) blockers.push("quantity_needed is blank or zero");

  const widthIn = num(p["product_width"]);
  const heightIn = num(p["product_height"]);
  if (widthIn == null || heightIn == null) blockers.push("product_width / product_height missing");

  const substrateRaw = kind === "LABEL" ? p["label_substrate"] : p["flexible_packaging_substrate"];
  const finishRaw = kind === "LABEL" ? p["label_finish"] : p["flexible_packaging_finish"];
  if (isUnspecifiedOption(substrateRaw)) {
    blockers.push(`substrate is "${substrateRaw}" — needs a real material`);
  }

  const stocks = resolveStocks({
    kind,
    labelSubstrate: p["label_substrate"],
    labelFinish: p["label_finish"],
    flexSubstrate: p["flexible_packaging_substrate"],
    flexFinish: p["flexible_packaging_finish"],
  });
  blockers.push(...stocks.unmapped);

  const notes = [p["additional_label_notes"], p["additional_flexpack_notes"], p["additional_estimating_notes"]]
    .filter(Boolean).join(" · ") || null;

  const cpRaw = p["copy_position"];
  const cp = ltCopyPosition(cpRaw);
  // Labels only: orientation moves footage by up to 37%, so an assumed value is
  // recorded as assumed rather than silently trusted.
  const copyPositionAssumed = kind === "LABEL" && cp == null;

  const machine = machineFor({
    kind,
    embellishment: p["embellishment"],
    notes: [notes, p["custom_item_name"]],
  });

  const stageId = p["hs_pipeline_stage"] ?? "";

  return {
    id: raw.id,
    itemName: p["custom_item_name"] ?? `(unnamed ${raw.id})`,
    estimateId: p["estimate_id"] ?? null,
    kind,
    stageId,
    stageLabel: STAGE_LABEL[stageId] ?? stageId,
    outcome: STAGE_OUTCOME[stageId] ?? "OPEN",
    probability: STAGE_PROBABILITY[stageId] ?? 0,
    location: p["location"] ?? null,
    primaryVendor: p["primary_vendor"] ?? null,
    customer: customerFromItemName(p["custom_item_name"]),
    createdAt: p["hs_createdate"] ?? null,
    dueDate: p["due_date"] ?? null,
    qty,
    widthIn,
    heightIn,
    depthIn: num(p["product_depth"]),
    copyPositionRaw: cpRaw ?? null,
    copyPosition: cp ?? (kind === "LABEL" ? DEFAULT_COPY_POSITION : null),
    copyPositionAssumed,
    embellishment: p["embellishment"] ?? null,
    machineCode: machine.ltCode,
    substrateRaw: substrateRaw ?? null,
    finishRaw: finishRaw ?? null,
    substrateStockId: stocks.substrateStockId,
    laminateStockId: stocks.laminateStockId,
    blockers,
    notes,
  };
}

/** Convenience: fetch + normalize, split into forecastable jobs and review queue. */
export async function loadForwardJobs(cfg: HubspotConfig): Promise<{
  total: number;
  jobs: NormalizedJob[];
  review: NormalizedJob[];
  skippedOutOfScope: number;
}> {
  const { total, records } = await fetchForwardPreorders(cfg, { internalOnly: true });
  const jobs: NormalizedJob[] = [];
  const review: NormalizedJob[] = [];
  let skipped = 0;
  for (const r of records) {
    const n = normalizePreorder(r);
    if (!n) { skipped++; continue; }
    (n.blockers.length === 0 ? jobs : review).push(n);
  }
  return { total, jobs, review, skippedOutOfScope: skipped };
}

export type { SpoilageResult };
export { spoilageFor, machineFor };
