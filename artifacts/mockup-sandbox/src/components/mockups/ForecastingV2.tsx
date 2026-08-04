/**
 * Forecasting v2 — material requirement from the quote stage onward.
 *
 * Design commitments, in priority order:
 *
 *  1. NOTHING IS COUNTED TWICE. The dedupe audit is the first thing on the page,
 *     because a double count silently doubles a purchase order. Two defences are
 *     shown separately: the explicit netsuite_so_ link, and the fuzzy
 *     customer+geometry+quantity match that catches the case where the link was
 *     never written back to HubSpot.
 *  2. LABELTRAXX ASSUMPTIONS ARE DATA, NOT SETTINGS. Spoilage curves and
 *     make-ready come off LT equipment records with provenance. There is nothing
 *     to toggle — the forecast reports Calyx engineering, it does not guess at it.
 *  3. A SINGLE NUMBER IS NOT A FORECAST. Every stock carries an interval: the
 *     floor if only firm orders land, the ceiling if every open quote lands. The
 *     position of that interval against safety stock is the direction.
 *
 * Invented values; real HubSpot field shapes and fill rates.
 */

import * as React from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  ArrowDown,
  CheckCircle2,
  CircleHelp,
  Clock,
  Database,
  Link2,
  Link2Off,
  Package,
  Ruler,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Truck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import {
  EQUIPMENT,
  EXCLUDED_FACTORS,
  HORIZON_WEEKS,
  IN_QUARTER_SHIP_RATE,
  OPEN_POS,
  STANDARDS,
  buildOutlooks,
  buildWeeks,
  poArrivalWeek,
  resolveAll,
  tierSummary,
  type Direction,
  type Resolved,
  type SpecTier,
  type StockOutlook,
} from "./forecasting-v2-data";

/* ------------------------------------------------------------- formatting */

const ftf = (n: number) =>
  Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(1)}k ft` : `${Math.round(n).toLocaleString()} ft`;
const usd = (n: number) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`);
const mono = "font-mono tabular-nums";

const DIRECTION_META: Record<Direction, { label: string; cls: string; bar: string }> = {
  ACT: { label: "Act now", cls: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30", bar: "bg-rose-500" },
  DECIDE: { label: "Decide", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30", bar: "bg-amber-500" },
  WATCH: { label: "Watch", cls: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30", bar: "bg-sky-500" },
  COMFORTABLE: { label: "Comfortable", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", bar: "bg-emerald-500" },
};

const TIER_META: Record<SpecTier, { label: string; dot: string }> = {
  SPECCED: { label: "Specced", dot: "bg-emerald-500" },
  ORIENTATION_UNKNOWN: { label: "Orientation unknown", dot: "bg-amber-500" },
  MATERIAL_ONLY: { label: "Material only", dot: "bg-orange-500" },
  UNSPECCED: { label: "Unspecced", dot: "bg-rose-500" },
};

function Chip({ text, cls }: { text: string; cls: string }) {
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>
      {text}
    </span>
  );
}

/* ============================================================ build-up ==== */

function Step({ icon, title, value, children, emphasis }: {
  icon?: React.ReactNode; title: string; value?: string;
  children?: React.ReactNode; emphasis?: boolean;
}) {
  return (
    <div className={`rounded-md border p-2.5 ${emphasis ? "border-[var(--color-chart-1)]/50 bg-[var(--color-chart-1)]/5" : "bg-card"}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {icon}{title}
        </div>
        {value && <span className={`text-sm font-semibold ${mono}`}>{value}</span>}
      </div>
      {children && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</div>}
    </div>
  );
}

const Arrow = () => (
  <div className="flex justify-center py-0.5 text-muted-foreground"><ArrowDown className="h-3.5 w-3.5" /></div>
);

function BuildUp({ r }: { r: Resolved }) {
  const q = r.rec, L = r.layout, F = r.footage;
  if (!L || !F) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
          <CircleHelp className="h-4 w-4" />No requirement can be derived
        </div>
        {r.tierReason} Missing: <span className={mono}>{r.missing.join(", ")}</span>.
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <Step icon={<Ruler className="h-3 w-3" />} title="1 · HubSpot spec" value={`${q.widthIn}" × ${q.heightIn}"`}>
        <span className={mono}>product_width</span> × <span className={mono}>product_height</span>, qty{" "}
        <span className={mono}>{q.qty?.toLocaleString()}</span>,{" "}
        {q.copyPosition
          ? <span className={mono}>copy_position = {q.copyPosition}</span>
          : <span className="text-amber-600 dark:text-amber-400">copy_position blank</span>}
      </Step>
      <Arrow />
      <Step icon={<RotateCcw className="h-3 w-3" />} title={`2 · Copy position → ${L.copyPosition}`} value={`${L.effectiveAcrossIn}" × ${L.effectiveAroundIn}"`}>
        {L.swapped
          ? <span className="text-amber-600 dark:text-amber-400">LEFT/RIGHT — dimensions <strong>swapped</strong> 90°, so the {L.effectiveAroundIn}" edge runs down-web.</span>
          : <>TOP/BTM — dimensions used as-is.</>}
        {L.copyPositionAssumed && <> <strong className="text-amber-600 dark:text-amber-400">Assumed {L.copyPosition}; HubSpot was blank.</strong></>}
      </Step>
      <Arrow />
      <Step title="3 · Layout (always derived — HubSpot supplies it on 0% of records)" value={`${L.noAcross}-across · ${L.repeatIn.toFixed(3)}" repeat`}>
        <span className={mono}>floor((web − {L.effectiveAcrossIn}) / ({L.effectiveAcrossIn} + {STANDARDS.columnSpacingIn})) + 1 = {L.noAcross}</span>
        <br />repeat = {L.effectiveAroundIn} + {STANDARDS.rowSpacingIn} = {L.repeatIn.toFixed(3)}" · {L.noAround}-around · {L.gearTeeth} gear teeth
      </Step>
      <Arrow />
      <Step title="4 · Good length (sellable web)" value={ftf(F.goodFt)}>
        <span className={mono}>ceil({q.qty?.toLocaleString()} / {L.noAcross}) × {L.repeatIn.toFixed(3)} / 12</span> — the floor.
      </Step>
      <Arrow />
      <div className="rounded-md border border-sky-500/40 bg-sky-500/5 p-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-400">
          <Database className="h-3 w-3" />5 · LabelTraxx equipment assumptions
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="pb-1 font-medium">Pass</th>
                <th className="pb-1 text-right font-medium">Linear</th>
                <th className="pb-1 text-right font-medium">Spoilage</th>
                <th className="pb-1 text-right font-medium">Make-ready</th>
                <th className="pb-1 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {F.passes.map((p) => (
                <tr key={p.ltCode} className={p.label === F.drivingPass ? "font-semibold" : undefined}>
                  <td className="py-0.5">
                    <UiTooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help underline decoration-dotted underline-offset-2">{p.label}</span>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">{p.provenance}</TooltipContent>
                    </UiTooltip>
                  </td>
                  <td className={`py-0.5 text-right ${mono}`}>{Math.round(p.linearFt)}</td>
                  <td className={`py-0.5 text-right ${mono}`}>
                    {Math.round(p.spoilageFt)} <span className="text-muted-foreground">({p.spoilagePct}%{p.spoilageFloored ? " floor" : ""})</span>
                  </td>
                  <td className={`py-0.5 text-right ${mono}`}>{Math.round(p.setupFt)}</td>
                  <td className={`py-0.5 text-right ${mono}`}>{Math.round(p.totalFt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Sourced from LT equipment records — not adjustable here.{" "}
          {q.newDieNeeded && <>New die: +{STANDARDS.newDieSetupFt} ft. </>}
          <strong className="text-foreground">Make-ready alone is {ftf(F.makeReadyFt)}.</strong>
        </p>
      </div>
      <Arrow />
      <Step title="6 · Requirement = max(passes), not the sum" value={ftf(F.requiredFt)} emphasis>
        One web through every station, so you buy for the hungriest pass —{" "}
        <strong className="text-foreground">{F.drivingPass}</strong>.
        <div className="mt-1 text-sm font-semibold text-amber-700 dark:text-amber-400">
          {(F.upliftVsGood * 100).toFixed(0)}% above good length
        </div>
      </Step>
      {r.orientationRange && (
        <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />Orientation unknown — a range, not a number
          </div>
          <p className="mt-1 text-muted-foreground">
            <span className={`${mono} text-foreground`}>{ftf(r.orientationRange.lowFt)}</span> to{" "}
            <span className={`${mono} text-foreground`}>{ftf(r.orientationRange.highFt)}</span> —{" "}
            <strong className="text-foreground">{r.orientationRange.swingPct.toFixed(0)}% swing</strong>. Get
            Estimating to set <span className={mono}>copy_position</span> before committing.
          </p>
        </div>
      )}
    </div>
  );
}

/* ==================================================== lead time timeline == */

function LeadTimeTimeline({ outlooks, weeks }: { outlooks: StockOutlook[]; weeks: ReturnType<typeof buildWeeks> }) {
  // Lane spans 4 weeks of history + the 13-week horizon.
  const PAST = 5;
  const total = PAST + HORIZON_WEEKS;
  const pos = (weekIdx: number) => ((weekIdx + PAST) / total) * 100;

  return (
    <div className="flex flex-col gap-1">
      {/* header ruler */}
      <div className="relative h-5 text-[10px] text-muted-foreground">
        {weeks.filter((_, i) => i % 2 === 0).map((w) => (
          <span key={w.index} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${pos(w.index)}%` }}>
            {w.short}
          </span>
        ))}
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${pos(-PAST + 1)}%` }}>
          ← placed
        </span>
      </div>

      {outlooks.map((o) => {
        const stockPos = OPEN_POS.filter((p) => p.stockId === o.stock.stockId);
        const breach = o.firstBreach.expected ?? o.firstBreach.all;
        return (
          <div key={o.stock.stockId} className="grid grid-cols-[7.5rem_1fr] items-center gap-2">
            <div className="min-w-0 text-xs">
              <span className={`font-semibold ${mono}`}>#{o.stock.stockId}</span>
              <span className="ml-1 text-muted-foreground">{o.stock.leadTimeDays}d ±{o.stock.leadTimeSigmaDays}</span>
            </div>
            <div className="relative h-9 rounded bg-muted/40">
              {/* now marker */}
              <div className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${pos(0)}%` }} />
              {/* safety-stock breach marker */}
              {breach != null && (
                <UiTooltip>
                  <TooltipTrigger asChild>
                    <div
                      className="absolute inset-y-0 w-0.5 cursor-help bg-rose-500"
                      style={{ left: `${pos(breach)}%` }}
                    />
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">
                    Breaches safety stock {weeks[breach]?.long}
                  </TooltipContent>
                </UiTooltip>
              )}
              {/* in-flight POs: ordered → promised arrival */}
              {stockPos.map((po, i) => {
                const a = poArrivalWeek(po);
                const left = pos(po.orderedWeek);
                const right = pos(a);
                return (
                  <UiTooltip key={po.poNumber}>
                    <TooltipTrigger asChild>
                      <div
                        className={`absolute flex cursor-help items-center rounded-sm border text-[9px] ${
                          po.status === "unconfirmed"
                            ? "border-amber-500/60 bg-amber-500/25"
                            : "border-[var(--color-chart-2)]/60 bg-[var(--color-chart-2)]/25"
                        }`}
                        style={{ left: `${left}%`, width: `${Math.max(2, right - left)}%`, top: i % 2 === 0 ? 3 : 20, height: 14 }}
                      >
                        <span className="truncate px-1 font-mono">{po.poNumber}</span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[280px] text-xs">
                      <div className="font-semibold">{po.poNumber} · {ftf(po.footageFt)}</div>
                      <div>Ordered {Math.abs(po.orderedWeek)}w ago · promised {po.promisedLeadDays}d</div>
                      <div>Lands {weeks[a]?.long ?? "beyond horizon"} · {po.status}</div>
                    </TooltipContent>
                  </UiTooltip>
                );
              })}
              {/* if we ordered today */}
              <UiTooltip>
                <TooltipTrigger asChild>
                  <div
                    className="absolute cursor-help rounded-sm border border-dashed border-foreground/40 bg-foreground/5"
                    style={{ left: `${pos(0)}%`, width: `${pos(o.orderTodayArrival) - pos(0)}%`, top: 3, height: 31 }}
                  />
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px] text-xs">
                  <div className="font-semibold">If ordered today</div>
                  <div>Lands {weeks[Math.min(o.orderTodayArrival, weeks.length - 1)]?.long}
                    {o.orderTodayArrival >= HORIZON_WEEKS && " (beyond horizon)"}</div>
                  {o.orderTodayInTime === false && (
                    <div className="mt-1 text-rose-400">Too late — arrives after the breach.</div>
                  )}
                  {o.orderTodayInTime === true && (
                    <div className="mt-1 text-emerald-400">Still lands before the breach.</div>
                  )}
                </TooltipContent>
              </UiTooltip>
            </div>
          </div>
        );
      })}

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm border border-[var(--color-chart-2)]/60 bg-[var(--color-chart-2)]/25" />PO ordered → promised arrival</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm border border-amber-500/60 bg-amber-500/25" />unconfirmed PO</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm border border-dashed border-foreground/40" />lead time if ordered today</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-0.5 bg-rose-500" />safety-stock breach</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-px bg-foreground/40" />now</span>
      </div>
    </div>
  );
}

/* ==================================================================== main */

export default function ForecastingV2() {
  const today = React.useMemo(() => new Date(2026, 7, 3), []);
  const weeks = React.useMemo(() => buildWeeks(today), [today]);
  const { resolved, audit } = React.useMemo(() => resolveAll(), []);
  const outlooks = React.useMemo(() => buildOutlooks(resolved, weeks), [resolved, weeks]);
  const tiers = React.useMemo(() => tierSummary(resolved), [resolved]);

  const [stockId, setStockId] = React.useState(outlooks[0]?.stock.stockId ?? "73");
  const [selId, setSelId] = React.useState("Q1");

  const o = outlooks.find((x) => x.stock.stockId === stockId) ?? outlooks[0]!;
  const sel = resolved.find((r) => r.rec.id === selId) ?? resolved[0]!;

  const chart = o.weeks.map((w) => ({
    ...w,
    name: weeks[w.week]!.short,
    firm: Math.round(w.ohFirm),
    exp: Math.round(w.ohExpected),
    all: Math.round(w.ohAll),
  }));
  const stockPos = OPEN_POS.filter((p) => p.stockId === o.stock.stockId);

  const counted = resolved.filter((r) => r.counted);
  const fuzzyCatches = audit.suppressed.filter((s) => s.linkType === "fuzzy");

  return (
    <TooltipProvider delayDuration={150}>
      <div className="min-h-screen bg-background p-6 text-foreground">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-5">

          {/* -------------------------------------------------------- header */}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">Forecasting — quote stage</h1>
              <Badge variant="outline" className="font-mono text-[10px]">V2 · INVENTED VALUES · REAL HUBSPOT SHAPE</Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Material requirement built from HubSpot quote specs through the PackOS
              geometry and LabelTraxx equipment assumptions. Every stock carries an
              interval, because what matters is not a number but which direction the
              position is heading.
            </p>
          </div>

          {/* ------------------------------------------ double-count guard */}
          <Card className={fuzzyCatches.length > 0 ? "border-l-4 border-l-amber-500" : "border-l-4 border-l-emerald-500"}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4" />Double-count guard
              </CardTitle>
              <CardDescription>
                A quote and the sales order it became are one demand. {resolved.length} records
                in, <strong className="text-foreground">{counted.length} counted</strong>,{" "}
                {audit.suppressed.length} suppressed — avoiding{" "}
                <strong className="text-foreground">{ftf(audit.totalFootageAvoidedFt)}</strong> of
                phantom requirement ({usd(audit.totalUsdAvoided)}).
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {audit.suppressed.map((s) => (
                <div key={s.ref} className={`rounded-md border p-2.5 text-xs ${s.linkType === "fuzzy" ? "border-amber-500/40 bg-amber-500/5" : "bg-muted/30"}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    {s.linkType === "explicit"
                      ? <Chip text="explicit link" cls="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" />
                      : <Chip text="fuzzy match — no link" cls="bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30" />}
                    <span className="font-medium">{s.itemName}</span>
                    <span className="text-muted-foreground">suppressed in favour of</span>
                    <span className={`${mono} font-semibold`}>{s.by}</span>
                    <span className={`ml-auto ${mono}`}>−{ftf(s.footageAvoidedFt)}</span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{s.reason}</p>
                </div>
              ))}
              {fuzzyCatches.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                  <Link2Off className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span className="text-muted-foreground">
                    <strong className="text-foreground">
                      {fuzzyCatches.length} of these had no <span className={mono}>netsuite_so_</span> on the quote.
                    </strong>{" "}
                    The explicit link would have missed them entirely and the requirement
                    would have been counted twice. This matters in practice: on a live
                    sample of open deals, <span className={mono}>netsuite_so_</span> was
                    empty on <strong className="text-foreground">25 of 25</strong> — it only
                    populates once the deal reaches "Sales Order Created in NS". Until then
                    the fuzzy match is the only thing standing between you and a doubled PO.
                  </span>
                </div>
              )}
              {audit.orphanSalesOrders.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  <Link2 className="mr-1 inline h-3 w-3" />
                  {audit.orphanSalesOrders.join(", ")} had no matching quote — counted once,
                  nothing to suppress.
                </p>
              )}
            </CardContent>
          </Card>

          {/* ----------------------------------------- where we are right now */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Package className="h-4 w-4" />Where we are right now
              </CardTitle>
              <CardDescription>
                Current position against safety stock and reorder point, with the
                direction the interval is pointing. Sorted most urgent first.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {outlooks.map((x) => {
                const m = DIRECTION_META[x.direction];
                const max = Math.max(x.stock.onHandFt, x.stock.reorderPointFt, x.stock.safetyStockFt, 1);
                const onHandPct = (x.stock.onHandFt / max) * 100;
                const ssPct = (x.stock.safetyStockFt / max) * 100;
                const ropPct = (x.stock.reorderPointFt / max) * 100;
                const active = x.stock.stockId === stockId;
                return (
                  <button
                    key={x.stock.stockId}
                    type="button"
                    onClick={() => setStockId(x.stock.stockId)}
                    className={`rounded-md border p-3 text-left transition-colors ${active ? "border-[var(--color-chart-1)] bg-accent/40" : "hover:bg-accent/30"}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`font-semibold ${mono}`}>#{x.stock.stockId}</span>
                      <Chip text={m.label} cls={m.cls} />
                      <span className={`ml-auto text-xs ${mono} ${x.coveredThroughWeek === null ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}>
                        {x.coveredThroughWeek === null
                          ? "below SS now"
                          : x.coveredThroughWeek >= HORIZON_WEEKS - 1
                            ? "covered all 13w"
                            : `covered to ${weeks[x.coveredThroughWeek]!.long}`}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">{x.stock.description}</div>
                    {/* position bar */}
                    <div className="relative mt-2 h-2.5 rounded-full bg-muted">
                      <div className={`absolute inset-y-0 left-0 rounded-full ${m.bar}`} style={{ width: `${onHandPct}%` }} />
                      <div className="absolute inset-y-[-3px] w-0.5 bg-rose-500/70" style={{ left: `${ssPct}%` }} title="safety stock" />
                      <div className="absolute inset-y-[-3px] w-0.5 bg-amber-500/70" style={{ left: `${ropPct}%` }} title="reorder point" />
                    </div>
                    <div className={`mt-1 flex justify-between text-[10px] ${mono} text-muted-foreground`}>
                      <span>on hand {ftf(x.stock.onHandFt)}</span>
                      <span>SS {ftf(x.stock.safetyStockFt)} · ROP {ftf(x.stock.reorderPointFt)}</span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{x.directionReason}</p>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          {/* --------------------------------------------- the interval chart */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    Interval — stock #{o.stock.stockId} · {DIRECTION_META[o.direction].label}
                  </CardTitle>
                  <CardDescription>
                    {o.stock.description} · the band is the range of outcomes across every
                    potential order. Upper edge = only firm orders land; lower edge = every
                    open quote lands.
                  </CardDescription>
                </div>
                <div className="rounded-md border px-3 py-1.5 text-right">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Spread at horizon
                  </div>
                  <div className={`text-base font-semibold ${mono}`}>{ftf(o.intervalFt)}</div>
                  <div className="text-[11px] text-muted-foreground">{usd(o.intervalUsd)} of uncertainty</div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chart} margin={{ top: 24, right: 12, bottom: 4, left: 4 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke="currentColor" className="text-border" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="currentColor" className="text-muted-foreground" interval={0} />
                    <YAxis tick={{ fontSize: 11 }} stroke="currentColor" className="text-muted-foreground" tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} width={46} />
                    {/* band: lower edge = everything lands */}
                    <Area type="monotone" dataKey="bandLo" stackId="b" stroke="none" fill="transparent" isAnimationActive={false} />
                    <Area type="monotone" dataKey="bandSpan" stackId="b" stroke="none" fill="var(--color-chart-1)" fillOpacity={0.16} isAnimationActive={false} />
                    <Line type="monotone" dataKey="firm" stroke="var(--color-chart-1)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="all" stroke="var(--color-chart-3)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="exp" stroke="var(--color-chart-1)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="safetyStock" stroke="var(--color-chart-4)" strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
                    <ReferenceLine y={0} stroke="hsl(var(--destructive))" strokeWidth={1.5} />
                    {stockPos.map((po) => {
                      const wk = poArrivalWeek(po);
                      if (wk < 0 || wk >= chart.length) return null;
                      return (
                        <ReferenceLine
                          key={po.poNumber}
                          x={chart[wk]!.name}
                          stroke="var(--color-chart-2)"
                          strokeDasharray="3 3"
                          label={{ value: `${po.poNumber} +${Math.round(po.footageFt / 1000)}k`, position: "top", fontSize: 10, fill: "var(--color-chart-2)" }}
                        />
                      );
                    })}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-4 rounded-sm" style={{ background: "var(--color-chart-1)", opacity: 0.3 }} />Range of outcomes</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-[3px] w-4" style={{ background: "var(--color-chart-1)" }} />Weighted path</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-[2px] w-4" style={{ background: "var(--color-chart-3)" }} />If everything lands</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: "var(--color-chart-4)" }} />Safety stock</span>
                <span className="flex items-center gap-1.5"><Truck className="h-3 w-3" style={{ color: "var(--color-chart-2)" }} />Promised PO delivery</span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {(["firm", "expected", "all"] as const).map((k) => {
                  const wk = o.firstBreach[k];
                  const labels = {
                    firm: "Firm demand only",
                    expected: "Weighted — all demand",
                    all: "Every quote lands in full",
                  };
                  return (
                    <div key={k} className="rounded-md border p-2.5 text-xs">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{labels[k]}</div>
                      <div className={`mt-0.5 font-semibold ${wk === null ? "" : "text-amber-600 dark:text-amber-400"}`}>
                        {wk === null ? "Never breaches" : `Breaches ${weeks[wk]!.long}`}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* --------------------------------------------- lead time timeline */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="h-4 w-4" />Lead time against POs in flight
              </CardTitle>
              <CardDescription>
                Each lane is one roll stock. Solid bars are open POs from order date to
                promised arrival; the dashed bar is where an order placed today would land.
                If the dashed bar ends past the red breach marker, ordering now is already
                too late.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LeadTimeTimeline outlooks={outlooks} weeks={weeks} />
              {outlooks.some((x) => x.orderTodayInTime === false) && (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/5 p-3 text-xs">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                  <span className="text-muted-foreground">
                    <strong className="text-foreground">
                      {outlooks.filter((x) => x.orderTodayInTime === false).map((x) => `#${x.stock.stockId}`).join(", ")}
                    </strong>{" "}
                    cannot be covered by ordering today — the lead time runs past the breach.
                    Those need expediting, substitution, or a re-promised ship date; more
                    material is not the lever.
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ---------------------------------------------- ledger + build-up */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            <Card className="xl:col-span-3">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Demand ledger</CardTitle>
                <CardDescription>
                  Quotes and sales orders in one place. Struck-through rows were suppressed
                  by the guard. Click any row for its build-up.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Record</TableHead>
                        <TableHead>Spec</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">P</TableHead>
                        <TableHead className="text-right">Good</TableHead>
                        <TableHead className="text-right">Required</TableHead>
                        <TableHead>Stock</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {resolved.map((r) => {
                        const on = r.rec.id === selId;
                        return (
                          <TableRow
                            key={r.rec.id}
                            onClick={() => setSelId(r.rec.id)}
                            className={`cursor-pointer ${on ? "bg-accent/50" : ""} ${!r.counted ? "opacity-55" : ""}`}
                          >
                            <TableCell className="max-w-[230px]">
                              <div className={`truncate text-xs font-medium ${!r.counted ? "line-through" : ""}`}>
                                {r.rec.itemName}
                              </div>
                              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                <Chip
                                  text={r.rec.source === "SALES_ORDER" ? "NetSuite" : "HubSpot"}
                                  cls={r.rec.source === "SALES_ORDER"
                                    ? "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30"
                                    : "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/30"}
                                />
                                <span className="truncate">{r.rec.customer}</span>
                              </div>
                              {!r.counted && (
                                <div className="mt-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                  suppressed → {r.suppressedBy}
                                </div>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                <span className={`h-2 w-2 rounded-full ${TIER_META[r.tier].dot}`} />
                                <span className="text-[11px]">{TIER_META[r.tier].label}</span>
                              </div>
                              <div className="text-[11px] text-muted-foreground">{r.rec.estimatingStage}</div>
                            </TableCell>
                            <TableCell className={`text-right ${mono}`}>
                              {r.rec.qty?.toLocaleString() ?? <span className="text-muted-foreground">—</span>}
                            </TableCell>
                            <TableCell className="text-right">
                              <UiTooltip>
                                <TooltipTrigger asChild>
                                  <span className={`cursor-help font-semibold underline decoration-dotted underline-offset-2 ${mono}`}>
                                    {(r.p * 100).toFixed(0)}%
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-[300px]">
                                  <ol className="list-decimal space-y-0.5 pl-4 text-xs">
                                    {r.pBasis.map((b, i) => <li key={i}>{b}</li>)}
                                  </ol>
                                </TooltipContent>
                              </UiTooltip>
                            </TableCell>
                            <TableCell className={`text-right ${mono} text-muted-foreground`}>
                              {r.footage ? ftf(r.footage.goodFt) : "—"}
                            </TableCell>
                            <TableCell className={`text-right font-semibold ${mono}`}>
                              {r.footage ? (
                                <>
                                  {ftf(r.footage.requiredFt)}
                                  <div className="text-[11px] font-normal text-amber-600 dark:text-amber-400">
                                    +{(r.footage.upliftVsGood * 100).toFixed(0)}%
                                  </div>
                                </>
                              ) : "—"}
                            </TableCell>
                            <TableCell className="text-xs">
                              {r.faceStockId ? (
                                <>
                                  <span className={mono}>#{r.faceStockId}</span>
                                  {r.laminateStockId && <> + <span className={mono}>#{r.laminateStockId}</span></>}
                                </>
                              ) : <span className="text-rose-600 dark:text-rose-400">none</span>}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                <div className="border-t p-3 text-xs text-muted-foreground">
                  Counted requirement by spec completeness —{" "}
                  {(["SPECCED", "ORIENTATION_UNKNOWN", "MATERIAL_ONLY", "UNSPECCED"] as SpecTier[]).map((t, i) => (
                    <span key={t}>
                      {i > 0 && " · "}
                      <span className={`inline-block h-2 w-2 rounded-full ${TIER_META[t].dot} align-middle`} />{" "}
                      {TIER_META[t].label} {usd(tiers[t].usd)}
                      {tiers[t].ft > 0 && ` (${ftf(tiers[t].ft)})`}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="xl:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Spec → feet of stock</CardTitle>
                <CardDescription className="truncate">{sel.rec.itemName}</CardDescription>
              </CardHeader>
              <CardContent>
                {!sel.counted && (
                  <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
                    <strong className="text-foreground">Not counted.</strong> {sel.suppressReason} Its
                    requirement is carried by {sel.suppressedBy} instead.
                  </div>
                )}

                {/* probability signal chain */}
                <div className="mb-3 rounded-md border border-violet-500/40 bg-violet-500/5 p-2.5">
                  <div className="flex items-baseline justify-between">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-400">
                      Probability chain
                    </div>
                    <span className={`text-sm font-semibold ${mono}`}>{(sel.p * 100).toFixed(0)}%</span>
                  </div>
                  <div className="mt-1.5 flex flex-col gap-1">
                    {sel.factors.map((f, i) => (
                      <div key={i} className="flex items-start justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate">{f.name}</span>
                            <span
                              className={`shrink-0 rounded px-1 text-[9px] font-semibold uppercase ${
                                f.source === "link"
                                  ? "bg-violet-500/15 text-violet-700 dark:text-violet-400"
                                  : f.source === "netsuite"
                                    ? "bg-sky-500/15 text-sky-700 dark:text-sky-400"
                                    : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                              }`}
                            >
                              {f.source === "link" ? "gap-to-goal" : f.source === "netsuite" ? "netsuite" : "material rule"}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{f.note}</div>
                        </div>
                        <span className={`shrink-0 font-semibold ${mono} ${f.mult < 1 ? "text-rose-600 dark:text-rose-400" : f.mult > 1 ? "text-emerald-600 dark:text-emerald-400" : ""}`}>
                          ×{f.mult.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <BuildUp r={sel} />
              </CardContent>
            </Card>
          </div>

          {/* ------------------------------------------ assumption provenance */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Database className="h-4 w-4" />Assumptions in force
              </CardTitle>
              <CardDescription>
                These are Calyx engineering assumptions held on LabelTraxx equipment
                records, not dashboard settings. Shown for auditability — change them in
                LabelTraxx and the forecast follows.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Equipment</TableHead>
                      <TableHead>Spoilage curve</TableHead>
                      <TableHead className="text-right">Min</TableHead>
                      <TableHead className="text-right">Base MR</TableHead>
                      <TableHead className="text-right">Per colour</TableHead>
                      <TableHead className="text-right">Per plate</TableHead>
                      <TableHead>Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {EQUIPMENT.map((e) => (
                      <TableRow key={e.ltCode}>
                        <TableCell className="text-xs font-medium">
                          {e.label}
                          <div className={`text-[11px] ${mono} text-muted-foreground`}>{e.ltCode}</div>
                        </TableCell>
                        <TableCell className={`text-xs ${mono}`}>
                          {e.spoilageCurve.map((b) => `${b.lowFt}–${b.highFt || "∞"}: ${b.pct}%`).join("  ·  ")}
                        </TableCell>
                        <TableCell className={`text-right text-xs ${mono}`}>{e.minSpoilagePct != null ? `${e.minSpoilagePct}%` : "—"}</TableCell>
                        <TableCell className={`text-right text-xs ${mono}`}>{e.baseSetupFt} ft</TableCell>
                        <TableCell className={`text-right text-xs ${mono}`}>{e.colourChangeFt || "—"}</TableCell>
                        <TableCell className={`text-right text-xs ${mono}`}>{e.plateChangeFt || "—"}</TableCell>
                        <TableCell className="text-[11px] text-muted-foreground">{e.provenance}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="border-t p-3 text-xs text-muted-foreground">
                Job standards: column spacing {STANDARDS.columnSpacingIn}" · row spacing{" "}
                {STANDARDS.rowSpacingIn}" · hard-to-run uplift {STANDARDS.hardToRunUpliftPct}% ·
                new-die make-ready {STANDARDS.newDieSetupFt} ft · assumed colours{" "}
                {STANDARDS.assumedColours} when the quote is silent.{" "}
                <span className="italic">{STANDARDS.provenance}.</span>
              </div>
            </CardContent>
          </Card>

          {/* ------------------------------- borrowed from Gap-to-Goal */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4" />Borrowed from Gap-to-Goal — and what was left behind
              </CardTitle>
              <CardDescription>
                Link&rsquo;s quarterly revenue model is a calibrated signal chain: base
                win rate × activity decay × ship signals. That architecture transfers
                directly. Some of its individual terms do not, because they measure
                revenue timing rather than material consumption.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />Taken across
                </div>
                <ul className="mt-2 flex flex-col gap-2 text-xs text-muted-foreground">
                  <li>
                    <strong className="text-foreground">Activity decay, verbatim.</strong> Link&rsquo;s
                    measured curve — 1.0 inside 7 days, collapsing to 0.13 by 21 and 0.05
                    past 90. It measures whether a deal is alive, which matters identically
                    to material.
                  </li>
                  <li>
                    <strong className="text-foreground">Ship signals.</strong> LabelTraxx ticket
                    exists → floor 0.95; payment hold ×0.45; promise-vs-projected drift
                    ×0.92. These predict whether the job actually runs, so they fit material
                    better than they fit revenue.
                  </li>
                  <li>
                    <strong className="text-foreground">H1 win rates by status × pipeline.</strong>{" "}
                    944 decided deals, adversarially verified. Used as the base rate — after
                    the correction opposite.
                  </li>
                  <li>
                    <strong className="text-foreground">Multiplicative chain with reasons.</strong>{" "}
                    Every factor named and auditable, exactly as Link&rsquo;s{" "}
                    <span className={mono}>calReasons</span> does.
                  </li>
                  <li>
                    <strong className="text-foreground">Deal↔order de-duplication.</strong> Link
                    zeroes a deal once its order exists. Same principle drives the guard at
                    the top of this page.
                  </li>
                </ul>
              </div>
              <div className="rounded-md border border-rose-500/40 bg-rose-500/5 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">
                  <AlertTriangle className="h-3.5 w-3.5" />Left behind — revenue-only
                </div>
                <ul className="mt-2 flex flex-col gap-2 text-xs text-muted-foreground">
                  {EXCLUDED_FACTORS.map((f) => (
                    <li key={f.name}>
                      <strong className="text-foreground">{f.name}.</strong> {f.reason}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="lg:col-span-2 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
                <strong className="text-foreground">The one correction that matters.</strong>{" "}
                Link&rsquo;s <span className={mono}>EMPIRICAL_P</span> is documented in its own
                source as <em>P(win AND ships in forecast quarter)</em> — a joint probability —
                and at <span className={mono}>gap-to-goal.ts:912</span> it sets{" "}
                <span className={mono}>p = 0</span> for anything shipping next quarter. Correct
                for revenue. Lifted onto material unchanged, every next-quarter job would
                contribute <strong className="text-foreground">zero</strong> material demand —
                and with a 42-day lead time on stock #206, those are precisely the jobs whose
                material must be ordered now. Dividing by Link&rsquo;s own measured in-quarter
                factor ({IN_QUARTER_SHIP_RATE}) recovers P(win) alone, which is the quantity
                material planning actually needs.
              </div>
            </CardContent>
          </Card>

          <p className="pb-6 text-xs text-muted-foreground">
            Field names and fill rates read live from HubSpot portal 6712259, object
            2-52567425 (1,722 records). Quote values, stock numbers and the equipment
            constants above are stand-ins — wire the real LabelTraxx equipment records
            before any purchasing decision rests on these figures.
          </p>
        </div>
      </div>
    </TooltipProvider>
  );
}
