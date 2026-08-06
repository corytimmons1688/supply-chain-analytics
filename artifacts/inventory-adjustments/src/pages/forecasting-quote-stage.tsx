/**
 * Forecasting — quote stage. REAL DATA. READ ONLY.
 *
 * Every number on this page traces to a live source:
 *   HubSpot pre-order support (internal, In Progress onward) · ns_forecast_line
 *   (NetSuite firm orders) · lt_stock · lt_roll · lt_po · lt_roll usage history.
 *
 * Where a value could not be sourced it is either DERIVED and badged as such, or
 * omitted and listed in the CONTROL TOWER at the bottom. Nothing is invented.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Clock,
  Database,
  Gauge,
  Layers,
  Link2Off,
  Lock,
  Package,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

import { Layout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FootageFlowSankey,
  DISPOSITION_EXPECTED,
  DISPOSITION_NOT_EXPECTED,
  type SankeyStage,
  type StageOrder,
} from "@/components/footage-flow-sankey";
import { StageDistribution } from "@/components/stage-distribution";
import { FootageFunnel } from "@/components/footage-funnel";
import { BigHitters } from "@/components/big-hitters";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PositionBar,
  PositionLegend,
  PoInFlight,
  SpecToFeet,
  type PoRow,
} from "@/components/forecast-drilldowns";

/* -------------------------------------------------------------------- types */

type Provenance = "LT_RECORD" | "USER_CONFIRMED" | "DERIVED" | "REPO_RULE" | "NOT_SOURCED";

interface Assumption {
  id: string; group: string; label: string; value: string;
  provenance: Provenance; note: string; understatesWhenMissing?: boolean;
}
interface Pass {
  code: string; label: string; linearFt: number; spoilageFt: number; setupFt: number;
  totalFt: number; spoilagePct: number | null; spoilageBracketPct: number | null;
  spoilageFloored: boolean; spoilageOutOfRange: boolean; incomplete: boolean;
}
interface Footage {
  goodFt: number; requiredFt: number; drivingPass: string; passes: Pass[];
  noAcross: number; repeatIn: number; swapped: boolean; machineCode: string;
  makeReadyFt: number; upliftVsGood: number;
}
interface Line {
  id: string; source: "HUBSPOT_QUOTE" | "NETSUITE_SO"; ref: string; itemName: string;
  customer: string | null; kind: "LABEL" | "FLEXPACK";
  /** Present on the response; needed to attribute a line to a Sankey stage. */
  stageId: string | null;
  stageLabel: string; probability: number;
  qty: number | null; embellishment: string | null; pressRoute: string; pressCostable: boolean;
  projectedMonthlyDemand: number | null; releaseSpanMonths: number | null; qtyNeedsClarification: boolean;
  substrateStockId: number | null; laminateStockId: number | null; extraStockIds: number[];
  footage: Footage | null; weightedFt: number; counted: boolean; suppressedBy: string | null;
  flags: string[];
  // always present on the response; NetSuite lines carry null dims
  copyPosition: string | null;
  copyPositionAssumed: boolean;
  widthIn: number | null;
  heightIn: number | null;
}
interface Position {
  stockId: string; description: string; supplierName: string | null; masterWidthIn: number;
  costMsi: number; onHandFt: number; rollCount: number; dailyDemandFt: number;
  leadTimeDays: number; leadTimeSource: string; safetyStockFt: number; reorderPointFt: number;
  policyFromGoal: boolean; openPoFt: number; openPoCount: number; quoteFt: number;
  quoteWeightedFt: number; firmFt: number; projectedFt: number;
  direction: "COMFORTABLE" | "WATCH" | "DECIDE" | "ACT"; directionReason: string;
  onTrackedList: boolean;
  /** From the material register — what the stock is FOR. */
  kind: "LABEL" | "FLEXPACK" | null;
  role: "SUBSTRATE" | "LAMINATE" | "ZIPPER" | null;
  tier: "PRIMARY" | "SPECIALITY" | null;
  restricted: boolean;
  /** What is actually USING it right now. A laminate can serve both lines. */
  usedBy: ("LABEL" | "FLEXPACK")[];
  byStage: Record<string, { rawFt: number; weightedFt: number; lineCount: number }>;
  openPos: PoRow[];
}
interface Forecast {
  generatedAt: string;
  totals: {
    hubspotInternal: number; quotesCounted: number; quotesInReview: number;
    firmLines: number; suppressed: number; rawFt: number; weightedFt: number; firmFt: number;
  };
  stages: SankeyStage[];
  positions: Position[];
  lines: Line[];
  review: { id: string; itemName: string; stageLabel: string; blockers: string[] }[];
  suppressed: { quoteId: string; itemName: string; customer: string | null; suppressedBy: string; basis: string; footageAvoidedFt: number }[];
  assumptions: Assumption[];
  understating: Assumption[];
  dataHealth: {
    stocksWithGoalPolicy: number; stocksWithDerivedPolicy: number; stocksMissingLeadTime: number;
    linesPastCurve: number; linesFloored: number; linesUncostablePress: number; netsuiteRecomputed: number;
  };
}

const mono = "font-mono tabular-nums";
const ft = (n: number) =>
  Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`
    : Math.abs(n) >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));

/* -------------------------------------------------------------- product line */

type LineFilter = "ALL" | "LABEL" | "FLEXPACK";

const LINE_LABEL: Record<LineFilter, string> = {
  ALL: "Both",
  LABEL: "Labels",
  FLEXPACK: "Flexpack",
};

/**
 * A stock belongs to a product line two different ways, and conflating them
 * hides things:
 *
 *   `kind`   — what the material register says it is FOR
 *   `usedBy` — which lines' demand is landing on it right now
 *
 * A laminate can legitimately serve both lines, so filtering on either alone is
 * wrong. Match if the register says so OR demand says so, and surface the
 * disagreement rather than silently picking one.
 */
function matchesLine(p: Position, f: LineFilter): boolean {
  if (f === "ALL") return true;
  if (p.kind === f) return true;
  return p.usedBy.includes(f);
}

/**
 * Tracked = present on the curated material register in materials.ts.
 * Off-tracked stocks still carry real on-hand and real demand — they are simply
 * not on the standardised list, so they get no register metadata (role, tier,
 * restrictions) and are the ones most likely to have no policy either.
 */
type TrackFilter = "ANY" | "TRACKED" | "OFF";

const TRACK_LABEL: Record<TrackFilter, string> = {
  ANY: "All",
  TRACKED: "Tracked",
  OFF: "Off-tracked",
};

function matchesTrack(p: Position, f: TrackFilter): boolean {
  if (f === "ANY") return true;
  return f === "TRACKED" ? p.onTrackedList : !p.onTrackedList;
}

const ROLE_LABEL: Record<NonNullable<Position["role"]>, string> = {
  SUBSTRATE: "substrate",
  LAMINATE: "laminate",
  ZIPPER: "zipper",
};

/**
 * Face stock and second web fail differently: a substrate shortage stops the job
 * outright, a laminate shortage can sometimes be re-specced or run unlaminated.
 * Worth being able to look at one without the other.
 */
type RoleFilter = "ANY" | "SUBSTRATE" | "LAMINATE";

const ROLE_FILTER_LABEL: Record<RoleFilter, string> = {
  ANY: "All roles",
  SUBSTRATE: "Substrate",
  LAMINATE: "Laminate",
};

function matchesRole(p: Position, f: RoleFilter): boolean {
  if (f === "ANY") return true;
  return p.role === f;
}

/** Shown on the card so a shared or off-register stock is obvious. */
function lineBadge(p: Position): { text: string; cls: string } | null {
  const both = p.usedBy.length > 1;
  if (both) {
    return { text: "Labels + Flexpack", cls: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/30" };
  }
  const k = p.kind ?? p.usedBy[0] ?? null;
  if (k === "LABEL") return { text: "Labels", cls: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30" };
  if (k === "FLEXPACK") return { text: "Flexpack", cls: "bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/30" };
  return { text: "off register", cls: "bg-muted text-muted-foreground border-border" };
}

/* ------------------------------------------------------------ horizon lens */

type Horizon = "LEAD" | "D30" | "D60" | "D90";

const HORIZON_LABEL: Record<Horizon, string> = {
  LEAD: "Lead time",
  D30: "30 days",
  D60: "60 days",
  D90: "90 days",
};

function horizonDays(h: Horizon, p: Position): number {
  if (h === "LEAD") return Math.max(1, Math.round(p.leadTimeDays || 30));
  return h === "D30" ? 30 : h === "D60" ? 60 : 90;
}

/**
 * Two independent readings of the same position. They are deliberately NOT
 * combined: `dailyDemandFt` is measured historical consumption and the order
 * book is future demand for the same material, so subtracting both would count
 * one requirement twice — the exact error the double-count guard exists to stop.
 *
 * Instead each is reported on its own, and their disagreement is the signal: a
 * book far more negative than the burn rate means the book is front-loaded or
 * its quotes will not all land.
 */
function lensesFor(p: Position, h: Horizon) {
  const days = horizonDays(h, p);
  const cutoff = Date.now() + days * 86400000;
  const poWithin = p.openPos.reduce(
    (a, po) => (po.promisedIso && Date.parse(po.promisedIso) <= cutoff ? a + po.footageFt : a),
    0,
  );
  const poUndated = p.openPos.reduce((a, po) => (po.promisedIso ? a : a + po.footageFt), 0);
  const burnFt = (p.dailyDemandFt || 0) * days;
  return {
    days,
    poWithin,
    poUndated,
    /** Order book, no time bound — the existing headline number. */
    book: p.projectedFt,
    /** Measured burn rate over the horizon, ignoring the order book. */
    burn: p.onHandFt + poWithin - burnFt,
    burnFt,
    /** True when the two lenses disagree enough to matter. */
    diverges: Math.abs(p.projectedFt - (p.onHandFt + poWithin - burnFt)) > Math.max(2000, p.safetyStockFt * 0.5),
  };
}

/**
 * Orders in a stage, optionally scoped to one stock. `FIRM` is a synthetic stage
 * on the per-stock diagram (NetSuite sales orders), so it matches on source
 * rather than stageId.
 */
function ordersForStage(lines: Line[], stageId: string, stockId: string | null): StageOrder[] {
  const sid = stockId === null ? null : Number(stockId);
  const onStock = (l: Line) =>
    sid === null ||
    l.substrateStockId === sid ||
    l.laminateStockId === sid ||
    l.extraStockIds.includes(sid);

  // Disposition columns span every stage; the value shown is the contribution to
  // that column, not the raw requirement.
  //   expected      → requiredFt × p
  //   not expected  → requiredFt × (1 − p); a rejected order contributes all of it
  if (stageId === DISPOSITION_EXPECTED || stageId === DISPOSITION_NOT_EXPECTED) {
    const wantExpected = stageId === DISPOSITION_EXPECTED;
    // An order is classified, never scaled. It runs or it does not, so it lands
    // wholly in one column at its FULL footage and never appears in both. No
    // order's footage is ever multiplied by a probability — a half-won job is not
    // a thing that exists, and buying half a job's material is not a decision
    // anyone can act on.
    return lines
      .filter((l) => {
        if (!l.counted || !onStock(l)) return false;
        return wantExpected ? l.probability >= 0.5 : l.probability < 0.5;
      })
      .map((l) => ({
        id: l.id,
        itemName: l.itemName,
        customer: l.customer,
        requiredFt: l.footage?.requiredFt ?? 0,
        probability: l.probability,
      }))
      .filter((o) => o.requiredFt > 0);
  }

  return lines
    .filter((l) => {
      if (!l.counted) return false;
      const stageMatch = stageId === "FIRM" ? l.source === "NETSUITE_SO" : l.stageId === stageId;
      return stageMatch && onStock(l);
    })
    .map((l) => ({
      id: l.id,
      itemName: l.itemName,
      customer: l.customer,
      requiredFt: l.footage?.requiredFt ?? 0,
      weightedFt: l.weightedFt,
    }))
    .filter((o) => o.requiredFt > 0);
}

const DIR: Record<Position["direction"], { label: string; cls: string; bar: string }> = {
  ACT: { label: "Act now", cls: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30", bar: "bg-rose-500" },
  DECIDE: { label: "Decide", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30", bar: "bg-amber-500" },
  WATCH: { label: "Watch", cls: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30", bar: "bg-sky-500" },
  COMFORTABLE: { label: "Comfortable", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", bar: "bg-emerald-500" },
};

const PROV: Record<Provenance, { label: string; cls: string }> = {
  LT_RECORD: { label: "LabelTraxx record", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" },
  USER_CONFIRMED: { label: "Confirmed", cls: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30" },
  DERIVED: { label: "Derived", cls: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/30" },
  REPO_RULE: { label: "Standard", cls: "bg-muted text-muted-foreground border-border" },
  NOT_SOURCED: { label: "NOT SOURCED", cls: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30" },
};

function Chip({ text, cls }: { text: string; cls: string }) {
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>{text}</span>;
}

/* ------------------------------------------------------------------ ledger */

type SortKey = "requiredFt" | "weightedFt" | "qty" | "ftPerUnit" | "spoilage" | "itemName" | "stageLabel";
const NUMERIC: SortKey[] = ["requiredFt", "weightedFt", "qty", "ftPerUnit", "spoilage"];

function DemandLedger({ lines, onPick }: { lines: Line[]; onPick: (l: Line) => void }) {
  const [key, setKey] = React.useState<SortKey>("requiredFt");
  const [dir, setDir] = React.useState<"asc" | "desc">("desc");
  const [kind, setKind] = React.useState<"ALL" | "LABEL" | "FLEXPACK">("ALL");
  const [src, setSrc] = React.useState<"ALL" | "HUBSPOT_QUOTE" | "NETSUITE_SO">("ALL");

  const val = (l: Line): number | string => {
    const f = l.footage;
    switch (key) {
      case "requiredFt": return f?.requiredFt ?? 0;
      case "weightedFt": return l.weightedFt;
      case "qty": return l.qty ?? 0;
      case "ftPerUnit": return f && l.qty ? f.requiredFt / l.qty : 0;
      case "spoilage": return f?.passes.find((p) => p.spoilagePct != null)?.spoilagePct ?? 0;
      case "itemName": return l.itemName;
      case "stageLabel": return l.stageLabel;
    }
  };
  const rows = React.useMemo(() => {
    let r = lines;
    if (kind !== "ALL") r = r.filter((l) => l.kind === kind);
    if (src !== "ALL") r = r.filter((l) => l.source === src);
    return [...r].sort((a, b) => {
      const av = val(a), bv = val(b);
      const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return dir === "asc" ? c : -c;
    });
  }, [lines, key, dir, kind, src]);

  const toggle = (k: SortKey) => {
    if (k === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setKey(k); setDir(NUMERIC.includes(k) ? "desc" : "asc"); }
  };
  const Th = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => (
    <TableHead className={right ? "text-right" : undefined}>
      <button type="button" onClick={() => toggle(k)}
        className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${key === k ? "font-semibold text-foreground" : ""}`}>
        {children}{key === k && (dir === "desc" ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </TableHead>
  );
  const shown = rows.reduce((a, r) => a + (r.footage?.requiredFt ?? 0), 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Demand ledger</CardTitle>
            <CardDescription>
              Every quote and firm order, ranked. Click a column to re-rank — heaviest footage first by
              default. <strong className="text-foreground">Click any row</strong> for its spec → feet build-up. <strong className="text-foreground">ft / unit</strong> finds the wasteful jobs that a
              raw footage sort hides. Struck-through rows were suppressed by the double-count guard.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {([["ALL", "All"], ["LABEL", "Labels"], ["FLEXPACK", "Flexpack"]] as const).map(([v, t]) => (
              <button key={v} type="button" onClick={() => setKind(v)}
                className={`rounded border px-2 py-1 text-xs font-semibold transition-colors ${kind === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{t}</button>
            ))}
            <span className="mx-1 w-px bg-border" />
            {([["ALL", "Both"], ["HUBSPOT_QUOTE", "Quotes"], ["NETSUITE_SO", "Firm"]] as const).map(([v, t]) => (
              <button key={v} type="button" onClick={() => setSrc(v)}
                className={`rounded border px-2 py-1 text-xs font-semibold transition-colors ${src === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{t}</button>
            ))}
          </div>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {rows.length} lines · <span className={mono}>{ft(shown)} ft</span> required
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[600px] overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <Th k="itemName">Job</Th>
                <Th k="stageLabel">Stage</Th>
                <Th k="qty" right>Qty</Th>
                <Th k="requiredFt" right>Required ft</Th>
                <Th k="ftPerUnit" right>ft / unit</Th>
                <Th k="spoilage" right>Spoilage</Th>
                <Th k="weightedFt" right>Weighted ft</Th>
                <TableHead>Stock</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((l, i) => {
                const f = l.footage;
                const lam = f?.passes.find((p) => p.spoilagePct != null);
                const per = f && l.qty ? f.requiredFt / l.qty : null;
                return (
                  <TableRow
                    key={l.id}
                    onClick={() => onPick(l)}
                    className={`cursor-pointer transition-colors hover:bg-accent/40 ${!l.counted ? "opacity-50" : ""}`}
                  >
                    <TableCell className="max-w-[300px]">
                      <div className="flex items-center gap-1.5">
                        <span className={`${mono} text-[10px] text-muted-foreground`}>#{i + 1}</span>
                        <span className={`truncate text-xs font-medium ${!l.counted ? "line-through" : ""}`}>{l.itemName}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className={`rounded px-1 font-semibold ${l.source === "NETSUITE_SO" ? "bg-sky-500/10 text-sky-700 dark:text-sky-400" : "bg-violet-500/10 text-violet-700 dark:text-violet-400"}`}>
                          {l.source === "NETSUITE_SO" ? "NetSuite" : "HubSpot"}
                        </span>
                        <span>{l.kind}</span>
                        <span className={mono}>{f?.machineCode}</span>
                        {l.embellishment && l.embellishment !== "None" && (
                          <span className="text-amber-600 dark:text-amber-400">{l.embellishment}</span>
                        )}
                        {!l.counted && <span className="text-amber-600 dark:text-amber-400">→ {l.suppressedBy}</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-[11px]">{l.stageLabel}</div>
                      <div className={`text-[10px] text-muted-foreground ${mono}`}>p={l.probability}</div>
                    </TableCell>
                    <TableCell className={`text-right text-xs ${mono}`}>{l.qty?.toLocaleString() ?? "—"}</TableCell>
                    <TableCell className={`text-right font-semibold ${mono}`}>
                      {f ? ft(f.requiredFt) : "—"}
                      {f && <div className="text-[10px] font-normal text-muted-foreground">good {ft(f.goodFt)}</div>}
                    </TableCell>
                    <TableCell className={`text-right text-xs ${mono}`}>{per != null ? per.toFixed(3) : "—"}</TableCell>
                    <TableCell className={`text-right text-xs ${mono}`}>
                      {lam?.spoilagePct != null ? `${lam.spoilagePct}%` : "—"}
                      {lam?.spoilageFloored && <div className="text-[10px] text-amber-600 dark:text-amber-400">floor ({lam.spoilageBracketPct}%)</div>}
                      {lam?.spoilageOutOfRange && <div className="text-[10px] text-rose-600 dark:text-rose-400">past curve</div>}
                    </TableCell>
                    <TableCell className={`text-right text-xs ${mono} text-muted-foreground`}>{ft(l.weightedFt)}</TableCell>
                    <TableCell className="text-xs">
                      {l.substrateStockId ? (
                        <span className={mono}>#{l.substrateStockId}{l.laminateStockId ? ` + #${l.laminateStockId}` : ""}{l.extraStockIds.length ? ` +${l.extraStockIds.length}` : ""}</span>
                      ) : <span className="text-rose-600 dark:text-rose-400">none</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------- control tower */

function ControlTower({ assumptions, understating, health }: {
  assumptions: Assumption[];
  understating: Assumption[];
  health: Forecast["dataHealth"];
}) {
  const groups = React.useMemo(() => {
    const m = new Map<string, Assumption[]>();
    for (const a of assumptions) {
      const arr = m.get(a.group) ?? [];
      arr.push(a);
      m.set(a.group, arr);
    }
    return [...m.entries()];
  }, [assumptions]);

  return (
    <Card className="border-l-4 border-l-violet-500">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <SlidersHorizontal className="h-4 w-4" />Control tower — every rule and assumption in force
        </CardTitle>
        <CardDescription>
          Each row says where its number came from. Anything marked{" "}
          <Chip text="not sourced" cls={PROV.NOT_SOURCED.cls} /> contributes <strong className="text-foreground">zero feet</strong>,
          so the forecast is a <strong className="text-foreground">floor</strong>, not a final number. Change these in
          LabelTraxx and this page follows.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {understating.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/5 p-3 text-xs">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
            <span className="text-muted-foreground">
              <strong className="text-foreground">{understating.length} assumptions are missing and understate the requirement:</strong>{" "}
              {understating.map((a) => a.label).join(" · ")}. Supply these and every number on this page rises.
            </span>
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["Policy from goals", health.stocksWithGoalPolicy],
            ["Policy derived", health.stocksWithDerivedPolicy],
            ["No lead time", health.stocksMissingLeadTime],
            ["Spoilage floored", health.linesFloored],
            ["Past curve", health.linesPastCurve],
            ["NetSuite recomputed", health.netsuiteRecomputed],
          ].map(([label, n]) => (
            <div key={String(label)} className="rounded-md border p-2">
              <div className={`text-lg font-semibold ${mono}`}>{n as number}</div>
              <div className="text-[10px] text-muted-foreground">{label as string}</div>
            </div>
          ))}
        </div>

        {groups.map(([group, items]) => (
          <div key={group}>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</div>
            <div className="flex flex-col gap-1.5">
              {items.map((a) => (
                <div key={a.id} className={`rounded-md border p-2.5 text-xs ${a.provenance === "NOT_SOURCED" ? "border-rose-500/40 bg-rose-500/5" : "bg-muted/20"}`}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-semibold">{a.label}</span>
                    <Chip text={PROV[a.provenance].label} cls={PROV[a.provenance].cls} />
                    <span className={`ml-auto text-right ${mono} ${a.provenance === "NOT_SOURCED" ? "text-rose-600 dark:text-rose-400" : ""}`}>{a.value}</span>
                  </div>
                  <p className="mt-1 leading-snug text-muted-foreground">{a.note}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------- page */

export default function ForecastingQuoteStage() {
  const [pickedStock, setPickedStock] = React.useState<string | null>(null);
  const [pickedLine, setPickedLine] = React.useState<Line | null>(null);
  // Defaults to the stock's own lead time: the only question that matters is
  // whether a replenishment could arrive before the position runs down, and a
  // fixed 60d window is wrong for a 10d stock and a 63d stock alike.
  const [horizon, setHorizon] = React.useState<Horizon>("LEAD");
  const [lineFilter, setLineFilter] = React.useState<LineFilter>("ALL");
  const [trackFilter, setTrackFilter] = React.useState<TrackFilter>("ANY");
  const [roleFilter, setRoleFilter] = React.useState<RoleFilter>("ANY");
  const [flowView, setFlowView] = React.useState<"SANKEY" | "FUNNEL">("SANKEY");
  /** { stageId, stockId | null } — stockId scopes the breakdown to one material. */
  const [pickedStage, setPickedStage] = React.useState<{ stageId: string; stockId: string | null } | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery<Forecast>({
    queryKey: ["forecasting", "quote-stage"],
    queryFn: () => customFetch<Forecast>("/api/forecasting/quote-stage", { responseType: "json" }),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <Layout>
      <div className="flex flex-col gap-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">Forecasting — quote stage</h1>
              <Badge variant="outline" className="gap-1 font-mono text-[10px]"><Lock className="h-3 w-3" />READ ONLY</Badge>
              <Badge variant="outline" className="font-mono text-[10px]">LIVE DATA</Badge>
              <Badge variant="outline" className="font-mono text-[10px]">INTERNAL ONLY</Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Material requirement from live HubSpot quotes and NetSuite firm orders, through the PackOS
              geometry and the real LabelTraxx spoilage curves, against real on-hand from{" "}
              <span className={mono}>lt_roll</span>. Every assumption is listed in the control tower at the
              bottom — nothing here is invented.
            </p>
          </div>
          <button type="button" onClick={() => void refetch()} disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold hover:bg-accent disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />{isFetching ? "Pulling…" : "Refresh"}
          </button>
        </div>

        {isLoading && (
          <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
            Pulling HubSpot quotes, NetSuite orders and the LabelTraxx mirror…
          </CardContent></Card>
        )}
        {error && (
          <Card className="border-l-4 border-l-rose-500">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400" />Could not build the forecast
              </CardTitle>
              <CardDescription>{(error as Error).message}</CardDescription>
            </CardHeader>
          </Card>
        )}

        {data && (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card><CardContent className="p-4">
                <div className="text-[11px] font-semibold text-muted-foreground">Raw requirement</div>
                <div className={`mt-1 text-2xl font-semibold ${mono}`}>{ft(data.totals.rawFt)}<span className="ml-1 text-sm text-muted-foreground">ft</span></div>
                <div className="text-[11px] text-muted-foreground">{data.totals.quotesCounted} quotes + {data.totals.firmLines} firm</div>
              </CardContent></Card>
              <Card><CardContent className="p-4">
                <div className="text-[11px] font-semibold text-muted-foreground">Weighted quotes</div>
                <div className={`mt-1 text-2xl font-semibold ${mono}`} style={{ color: "#0ca30c" }}>{ft(data.totals.weightedFt)}<span className="ml-1 text-sm text-muted-foreground">ft</span></div>
                <div className="text-[11px] text-muted-foreground">risk-adjusted by stage</div>
              </CardContent></Card>
              <Card><CardContent className="p-4">
                <div className="text-[11px] font-semibold text-muted-foreground">Firm (NetSuite)</div>
                <div className={`mt-1 text-2xl font-semibold ${mono}`}>{ft(data.totals.firmFt)}<span className="ml-1 text-sm text-muted-foreground">ft</span></div>
                <div className="text-[11px] text-muted-foreground">{data.dataHealth.netsuiteRecomputed} lines recomputed on real curves</div>
              </CardContent></Card>
              <Card><CardContent className="p-4">
                <div className="text-[11px] font-semibold text-muted-foreground">Needs review</div>
                <div className={`mt-1 text-2xl font-semibold ${mono}`} style={{ color: "#b7791f" }}>{data.totals.quotesInReview}</div>
                <div className="text-[11px] text-muted-foreground">excluded until fixed in HubSpot</div>
              </CardContent></Card>
            </div>

            {/* double-count guard */}
            <Card className={data.totals.suppressed > 0 ? "border-l-4 border-l-amber-500" : "border-l-4 border-l-emerald-500"}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Double-count guard</CardTitle>
                <CardDescription>
                  A quote and the sales order it became are one demand.{" "}
                  <strong className="text-foreground">{data.totals.suppressed} suppressed</strong> — avoiding{" "}
                  <strong className="text-foreground">{ft(data.suppressed.reduce((a, s) => a + s.footageAvoidedFt, 0))} ft</strong> of phantom requirement.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {data.suppressed.map((s) => (
                  <div key={s.quoteId} className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip text="fuzzy match — no link" cls="bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30" />
                      <span className="truncate font-medium">{s.itemName}</span>
                      <span className="text-muted-foreground">suppressed in favour of</span>
                      <span className={`${mono} font-semibold`}>{s.suppressedBy}</span>
                      <span className={`ml-auto ${mono}`}>−{ft(s.footageAvoidedFt)} ft</span>
                    </div>
                    <p className="mt-1 text-muted-foreground">{s.basis}</p>
                  </div>
                ))}
                <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-xs">
                  <Link2Off className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    HubSpot&rsquo;s <span className={mono}>netsuite_so_</span> only populates once a deal reaches
                    &ldquo;Sales Order Created in NS&rdquo;, so the fuzzy match (customer name + exact quantity) is the
                    only defence before that. It is deliberately conservative: a shared customer alone never
                    suppresses demand.
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* positions */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base"><Package className="h-4 w-4" />Where we are right now</CardTitle>
                    <CardDescription>
                      Real on-hand from <span className={mono}>lt_roll</span>. Safety stock and reorder point are{" "}
                      <strong className="text-foreground">derived</strong> from usage and measured PO lead times —{" "}
                      <span className={mono}>stock_goal</span> has none set. Most urgent first.
                    </CardDescription>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <div className="flex rounded-md border p-0.5">
                    {(["ALL", "LABEL", "FLEXPACK"] as LineFilter[]).map((f) => {
                      const n = data.positions.filter(
                        (p) => matchesLine(p, f) && matchesRole(p, roleFilter) && matchesTrack(p, trackFilter),
                      ).length;
                      return (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setLineFilter(f)}
                          className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                            lineFilter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                          }`}
                        >
                          {LINE_LABEL[f]} <span className="opacity-70">{n}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex rounded-md border p-0.5">
                    {(["ANY", "SUBSTRATE", "LAMINATE"] as RoleFilter[]).map((f) => {
                      const n = data.positions.filter(
                        (p) => matchesLine(p, lineFilter) && matchesTrack(p, trackFilter) && matchesRole(p, f),
                      ).length;
                      return (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setRoleFilter(f)}
                          className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                            roleFilter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                          }`}
                        >
                          {ROLE_FILTER_LABEL[f]} <span className="opacity-70">{n}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex rounded-md border p-0.5">
                    {(["ANY", "TRACKED", "OFF"] as TrackFilter[]).map((f) => {
                      const n = data.positions.filter(
                        (p) => matchesLine(p, lineFilter) && matchesRole(p, roleFilter) && matchesTrack(p, f),
                      ).length;
                      return (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setTrackFilter(f)}
                          className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                            trackFilter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                          }`}
                        >
                          {TRACK_LABEL[f]} <span className="opacity-70">{n}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex rounded-md border p-0.5">
                    {(["LEAD", "D30", "D60", "D90"] as Horizon[]).map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => setHorizon(h)}
                        className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                          horizon === h ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                        }`}
                      >
                        {HORIZON_LABEL[h]}
                      </button>
                    ))}
                  </div>
                  </div>
                </div>
                <div className="mt-2 rounded-md bg-muted/40 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  <strong className="text-foreground">Two readings, deliberately not combined.</strong>{" "}
                  <span className="text-foreground">Order book</span> = on hand + open PO − firm − weighted quotes, with{" "}
                  <em>no time bound</em> (HubSpot&rsquo;s <span className={mono}>due_date</span> is unusable here — 192 of
                  200 open quotes are already past it).{" "}
                  <span className="text-foreground">Burn rate</span> = on hand + PO landing inside the window − measured
                  usage over the window. Subtracting both would count the same demand twice, so where they disagree the
                  card says so rather than averaging them.
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <PositionLegend />
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {data.positions
                  .filter(
                    (p) => matchesLine(p, lineFilter) && matchesRole(p, roleFilter) && matchesTrack(p, trackFilter),
                  )
                  .map((p) => {
                  const m = DIR[p.direction];
                  const L = lensesFor(p, horizon);
                  const lb = lineBadge(p);
                  return (
                    <button
                      key={p.stockId}
                      type="button"
                      onClick={() => setPickedStock(p.stockId)}
                      className="rounded-md border p-3 text-left transition-colors hover:bg-accent/40"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`font-semibold ${mono}`}>#{p.stockId}</span>
                        <Chip text={m.label} cls={m.cls} />
                        {lb && <Chip text={lb.text} cls={lb.cls} />}
                        {/* Face stock vs second web vs zipper — shown for every material,
                            because a laminate shortage and a substrate shortage are not
                            the same problem even at identical footage. */}
                        {p.role ? (
                          <Chip
                            text={ROLE_LABEL[p.role]}
                            cls={
                              p.role === "SUBSTRATE"
                                ? "bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30"
                                : "bg-muted text-muted-foreground border-border"
                            }
                          />
                        ) : (
                          <Chip text="role unknown" cls="bg-muted text-muted-foreground border-border" />
                        )}
                        {p.tier === "SPECIALITY" && <Chip text="speciality" cls="bg-muted text-muted-foreground border-border" />}
                        {p.restricted && <Chip text="restricted" cls="bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30" />}
                        {!p.policyFromGoal && <Chip text="derived policy" cls={PROV.DERIVED.cls} />}
                        {!p.onTrackedList && <Chip text="off tracked list" cls="bg-muted text-muted-foreground border-border" />}
                        <span className={`ml-auto text-xs ${mono} ${p.projectedFt < 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}>
                          book {ft(p.projectedFt)} ft
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">{p.description}</div>
                      <PositionBar
                        onHandFt={p.onHandFt}
                        openPoFt={p.openPoFt}
                        safetyStockFt={p.safetyStockFt}
                        reorderPointFt={p.reorderPointFt}
                        projectedFt={p.projectedFt}
                        tone={m.bar}
                      />
                      <div className={`mt-1 flex flex-wrap justify-between gap-x-3 text-[10px] ${mono} text-muted-foreground`}>
                        <span>on hand {ft(p.onHandFt)} ({p.rollCount} rolls)</span>
                        <span>+PO {ft(p.openPoFt)}</span>
                        <span>firm {ft(p.firmFt)}</span>
                        <span>quotes {ft(p.quoteWeightedFt)}</span>
                      </div>
                      <div className={`mt-0.5 flex flex-wrap justify-between gap-x-3 text-[10px] ${mono} text-muted-foreground`}>
                        <span>SS {ft(p.safetyStockFt)} · ROP {ft(p.reorderPointFt)}</span>
                        <span>lead {p.leadTimeDays ? `${Math.round(p.leadTimeDays)}d` : "—"} ({p.leadTimeSource.replace("_", " ")})</span>
                      </div>
                      {/* horizon lens — burn rate over the selected window */}
                      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 rounded border-l-2 border-l-sky-500/50 bg-sky-500/5 px-2 py-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-400">
                          {HORIZON_LABEL[horizon]} · {L.days}d
                        </span>
                        <span className={`text-[11px] ${mono} ${L.burn < p.safetyStockFt ? "text-rose-600 dark:text-rose-400" : "text-foreground"}`}>
                          burn-rate {ft(L.burn)} ft
                        </span>
                        <span className={`text-[10px] ${mono} text-muted-foreground`}>
                          (usage {ft(L.burnFt)} · PO in {ft(L.poWithin)}
                          {L.poUndated > 0 ? ` · ${ft(L.poUndated)} undated PO excluded` : ""})
                        </span>
                        {p.dailyDemandFt <= 0 && (
                          <span className="text-[10px] text-amber-600 dark:text-amber-400">no measured usage — burn lens unavailable</span>
                        )}
                      </div>
                      {L.diverges && p.dailyDemandFt > 0 && (
                        <p className="mt-1 text-[10px] leading-snug text-amber-600 dark:text-amber-400">
                          The two lenses disagree by {ft(Math.abs(L.book - L.burn))} ft — the order book is
                          {L.book < L.burn ? " heavier" : " lighter"} than measured consumption implies. Worth checking
                          whether the quotes are real before acting on the book alone.
                        </p>
                      )}
                      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{p.directionReason}</p>
                    </button>
                  );
                })}
                </div>
              </CardContent>
            </Card>

            {/* flow */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base"><Layers className="h-4 w-4" />Footage flow by deal stage</CardTitle>
                <CardDescription>How heavy the requirement is at each stage, and how much is expected to convert.</CardDescription>
              </CardHeader>
              <CardContent>
                <FootageFlowSankey
                  stages={data.stages.map((s) => ({ ...s, orders: ordersForStage(data.lines, s.stageId, null) }))}
                  onStageClick={(stageId) => setPickedStage({ stageId, stockId: null })}
                />
              </CardContent>
            </Card>

            <DemandLedger lines={data.lines} onPick={setPickedLine} />

            {/* review */}
            {data.review.length > 0 && (
              <Card className="border-l-4 border-l-amber-500">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base"><Gauge className="h-4 w-4" />Needs review · {data.review.length}</CardTitle>
                  <CardDescription>Excluded from the forecast until fixed in HubSpot — never silently dropped.</CardDescription>
                </CardHeader>
                <CardContent className="flex max-h-[300px] flex-col gap-1.5 overflow-auto">
                  {data.review.map((r) => (
                    <div key={r.id} className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
                      <div className="truncate font-medium">{r.itemName}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{r.stageLabel} · {r.blockers.join(" · ")}</div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* ------------------------------------------------ big hitters */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4" />Big hitters &amp; unclear quantities
                </CardTitle>
                <CardDescription>
                  Orders a human should look at before any material is committed: accepted quotes large enough
                  to move a stock on their own, and quotes whose quantity spans several monthly releases so the
                  booked footage overstates what is needed now.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <BigHitters
                  lines={data.lines
                    .filter((l) => l.counted && l.source === "HUBSPOT_QUOTE")
                    .map((l) => ({
                      id: l.id,
                      itemName: l.itemName,
                      customer: l.customer,
                      stageLabel: l.stageLabel,
                      probability: l.probability,
                      qty: l.qty,
                      projectedMonthlyDemand: l.projectedMonthlyDemand,
                      releaseSpanMonths: l.releaseSpanMonths,
                      qtyNeedsClarification: l.qtyNeedsClarification,
                      requiredFt: l.footage?.requiredFt ?? 0,
                      substrateStockId: l.substrateStockId,
                      laminateStockId: l.laminateStockId,
                    }))}
                  onPickLine={(id) => {
                    const line = data.lines.find((x) => x.id === id);
                    if (line) setPickedLine(line);
                  }}
                />
              </CardContent>
            </Card>

            <ControlTower assumptions={data.assumptions} understating={data.understating} health={data.dataHealth} />

            {/* ---------------- per-stock drill-down: flow + POs in flight ---------------- */}
            <Dialog open={pickedStock !== null} onOpenChange={(o) => !o && setPickedStock(null)}>
              <DialogContent className="max-h-[88vh] max-w-[1000px] overflow-y-auto">
                {(() => {
                  const p = data.positions.find((x) => x.stockId === pickedStock);
                  if (!p) return null;
                  // Build this stock's own stage flow from its byStage breakdown.
                  const stockStages: SankeyStage[] = data.stages
                    .map((st) => {
                      const b = p.byStage[st.stageId];
                      return { ...st, rawFt: b?.rawFt ?? 0, weightedFt: b?.weightedFt ?? 0, lineCount: b?.lineCount ?? 0 };
                    })
                    .filter((st) => st.rawFt > 0);
                  const firm = p.byStage["FIRM"];
                  if (firm && firm.rawFt > 0) {
                    stockStages.push({
                      stageId: "FIRM", label: "Sales order (firm)", outcome: "WON", probability: 1,
                      rawFt: firm.rawFt, weightedFt: firm.weightedFt, lineCount: firm.lineCount,
                    });
                  }
                  // Rejected quotes are excluded here on purpose: they carry p=0,
                  // add nothing to the position, and only pad the list. They stay
                  // in the flow diagram above, which is where the rejected volume
                  // is the point (it is the conversion denominator).
                  const onThisStock = (l: Line) =>
                    l.substrateStockId === Number(p.stockId) ||
                    l.laminateStockId === Number(p.stockId) ||
                    l.extraStockIds.includes(Number(p.stockId));
                  const allOnStock = data.lines.filter((l) => l.counted && onThisStock(l));
                  const lines = allOnStock.filter((l) => l.probability > 0);
                  const rejectedCount = allOnStock.length - lines.length;
                  return (
                    <>
                      <DialogHeader>
                        <DialogTitle className="flex flex-wrap items-center gap-2">
                          <span className={mono}>#{p.stockId}</span>
                          <span>{p.description}</span>
                          <Chip text={DIR[p.direction].label} cls={DIR[p.direction].cls} />
                        </DialogTitle>
                      </DialogHeader>

                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {[
                          ["On hand", `${ft(p.onHandFt)} ft`, `${p.rollCount} rolls`],
                          ["Open PO", `${ft(p.openPoFt)} ft`, `${p.openPoCount} POs`],
                          ["Demand", `${ft(p.firmFt + p.quoteWeightedFt)} ft`, `firm ${ft(p.firmFt)} + wtd ${ft(p.quoteWeightedFt)}`],
                          ["Projected", `${ft(p.projectedFt)} ft`, p.projectedFt < 0 ? "shortfall" : "surplus"],
                        ].map(([l, v, sub]) => (
                          <div key={l} className="rounded-md border p-2.5">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{l}</div>
                            <div className={`text-lg font-semibold ${mono} ${l === "Projected" && p.projectedFt < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>{v}</div>
                            <div className="text-[10px] text-muted-foreground">{sub}</div>
                          </div>
                        ))}
                      </div>

                      <div className="mt-1">
                        <div className="mb-1 text-sm font-semibold">Footage flow — this stock only</div>
                        {/* Two readings of the same data: where footage SITS and how it
                            splits (Sankey), or the pipeline in stage order with the
                            concentration at each step (funnel). Neither replaces the
                            other, so it is a toggle rather than a choice made for you. */}
                        {stockStages.length > 0 ? (
                          <>
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="text-[11px] text-muted-foreground">
                              {flowView === "SANKEY"
                                ? "Flow: where footage sits by stage, and how it splits into expected vs not."
                                : "Funnel: current occupancy in pipeline order, with concentration per step."}
                            </span>
                            <div className="flex shrink-0 rounded-md border p-0.5">
                              {(["SANKEY", "FUNNEL"] as const).map((v) => (
                                <button
                                  key={v}
                                  type="button"
                                  onClick={() => setFlowView(v)}
                                  className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                                    flowView === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                                  }`}
                                >
                                  {v === "SANKEY" ? "Flow" : "Funnel"}
                                </button>
                              ))}
                            </div>
                          </div>
                          {flowView === "SANKEY" ? (
                            <FootageFlowSankey
                              stages={stockStages.map((s) => ({
                                ...s,
                                orders: ordersForStage(data.lines, s.stageId, p.stockId),
                              }))}
                              onStageClick={(stageId) => setPickedStage({ stageId, stockId: p.stockId })}
                            />
                          ) : (
                            <FootageFunnel
                              stages={stockStages.map((s) => ({
                                ...s,
                                orders: ordersForStage(data.lines, s.stageId, p.stockId),
                              }))}
                              onStageClick={(stageId) => setPickedStage({ stageId, stockId: p.stockId })}
                            />
                          )}
                          </>
                        ) : (
                          <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                            No open quote demand lands on this stock — its position is driven by firm orders and POs only.
                          </div>
                        )}
                      </div>

                      <div className="mt-3">
                        <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                          <Clock className="h-4 w-4" />Lead time against POs in flight
                        </div>
                        <p className="mb-2 text-xs text-muted-foreground">
                          Each bar is an open PO from order date to promised arrival. The dashed bar is where an
                          order placed <strong className="text-foreground">today</strong> would land on the measured
                          lead time — if that ends after you need the material, ordering now is already too late.
                        </p>
                        <PoInFlight pos={p.openPos} leadTimeDays={p.leadTimeDays} leadTimeSource={p.leadTimeSource} />
                      </div>

                      <div className="mt-3">
                        <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
                          <span className="text-sm font-semibold">Demand lines on this stock ({lines.length})</span>
                          {rejectedCount > 0 && (
                            <span className="text-[11px] text-muted-foreground">
                              · {rejectedCount} rejected quote{rejectedCount === 1 ? "" : "s"} hidden (p=0, no effect on position)
                            </span>
                          )}
                        </div>
                        <div className="max-h-56 overflow-auto rounded-md border">
                          <table className="w-full text-xs">
                            <tbody>
                              {lines
                                .sort((a, b) => (b.footage?.requiredFt ?? 0) - (a.footage?.requiredFt ?? 0))
                                .map((l) => (
                                  <tr key={l.id} className="cursor-pointer border-b last:border-0 hover:bg-accent/40"
                                    onClick={() => { setPickedStock(null); setPickedLine(l); }}>
                                    <td className="max-w-[420px] truncate px-3 py-1.5">{l.itemName}</td>
                                    <td className="px-3 py-1.5 text-[11px] text-muted-foreground">{l.stageLabel}</td>
                                    <td className={`px-3 py-1.5 text-right font-semibold ${mono}`}>{ft(l.footage?.requiredFt ?? 0)} ft</td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="mt-1 text-[10px] text-muted-foreground">Click a line for its spec → feet build-up.</p>
                      </div>
                    </>
                  );
                })()}
              </DialogContent>
            </Dialog>

            {/* ---------------- per-stage drill-down: material distribution ---------------- */}
            <Dialog open={pickedStage !== null} onOpenChange={(o) => !o && setPickedStage(null)}>
              <DialogContent className="max-h-[88vh] max-w-[900px] overflow-y-auto">
                {pickedStage && (() => {
                  const isDisp =
                    pickedStage.stageId === DISPOSITION_EXPECTED ||
                    pickedStage.stageId === DISPOSITION_NOT_EXPECTED;
                  const st = data.stages.find((s) => s.stageId === pickedStage.stageId);
                  const label =
                    pickedStage.stageId === DISPOSITION_EXPECTED
                      ? "Expected to convert"
                      : pickedStage.stageId === DISPOSITION_NOT_EXPECTED
                        ? "Not expected"
                        : (st?.label ?? (pickedStage.stageId === "FIRM" ? "Sales order (firm)" : pickedStage.stageId));
                  const prob = st?.probability ?? (pickedStage.stageId === "FIRM" ? 1 : 0);
                  const orders = ordersForStage(data.lines, pickedStage.stageId, pickedStage.stockId);
                  const stock = pickedStage.stockId
                    ? data.positions.find((x) => x.stockId === pickedStage.stockId)
                    : null;
                  return (
                    <>
                      <DialogHeader>
                        <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
                          <span>{label}</span>
                          <span className="text-xs font-normal text-muted-foreground">
                            material distribution
                            {stock ? ` · stock #${stock.stockId}` : " · all stocks"}
                          </span>
                        </DialogTitle>
                        <p className="text-xs text-muted-foreground">
                          {pickedStage.stageId === DISPOSITION_EXPECTED
                            ? "Each order contributes its requirement × its stage probability — this is the footage to actually buy against. "
                            : pickedStage.stageId === DISPOSITION_NOT_EXPECTED
                              ? "Each order contributes its requirement × (1 − probability). A rejected quote contributes all of its footage, which is why this column is usually the larger one. "
                              : ""}
                          {stock
                            ? `Only footage of #${stock.stockId} is counted here, so an order using several materials appears at its requirement for this one.`
                            : "Every material each order consumes is counted, so an order using a face stock and a laminate contributes to both."}
                        </p>
                      </DialogHeader>
                      <StageDistribution
                        stageLabel={label}
                        probability={prob}
                        valueNoun={isDisp ? "contribution" : "requirement"}
                        orders={orders}
                        onPickOrder={(id) => {
                          const line = data.lines.find((l) => l.id === id);
                          if (line) { setPickedStage(null); setPickedLine(line); }
                        }}
                      />
                    </>
                  );
                })()}
              </DialogContent>
            </Dialog>

            {/* ---------------- per-line drill-down: spec → feet of stock ---------------- */}
            <Dialog open={pickedLine !== null} onOpenChange={(o) => !o && setPickedLine(null)}>
              <DialogContent className="max-h-[88vh] max-w-[760px] overflow-y-auto">
                {pickedLine && (
                  <>
                    <DialogHeader>
                      <DialogTitle className="text-base">Spec → feet of stock</DialogTitle>
                      <p className="text-xs text-muted-foreground">{pickedLine.itemName}</p>
                    </DialogHeader>
                    {!pickedLine.counted && (
                      <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
                        <strong className="text-foreground">Not counted.</strong> Suppressed by the double-count
                        guard in favour of <span className={mono}>{pickedLine.suppressedBy}</span>.
                      </div>
                    )}
                    {pickedLine.flags.length > 0 && (
                      <ul className="mb-2 flex flex-col gap-1 text-[11px] text-muted-foreground">
                        {pickedLine.flags.map((f) => <li key={f}>· {f}</li>)}
                      </ul>
                    )}
                    <SpecToFeet line={pickedLine} />
                  </>
                )}
              </DialogContent>
            </Dialog>

            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-6 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                {data.totals.hubspotInternal} internal HubSpot records</span>
              <span className="inline-flex items-center gap-1"><Database className="h-3 w-3" />lt_stock · lt_roll · lt_po · ns_forecast_line</span>
              <span>generated {new Date(data.generatedAt).toLocaleString()}</span>
              <strong className="text-foreground">Read-only — nothing is ever written to HubSpot, LabelTraxx or NetSuite.</strong>
            </p>
          </>
        )}
      </div>
    </Layout>
  );
}
