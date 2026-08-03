/**
 * Forecasting tab — PROTOTYPE on invented data.
 *
 * Demonstrates the design for probability-weighted material demand:
 *   - three demand layers that CONSUME each other rather than stacking
 *   - a calibrated probability on every demand line, with its derivation shown
 *   - projected on hand as a P10–P90 distribution, not a single line
 *   - both failure modes priced side by side: stockout risk AND excess risk
 *   - purchasing policy split by computed pooling class
 *   - deals that cannot be material-forecast surfaced as a work queue
 *
 * No live connections. See forecasting-data.ts.
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
  ArrowRight,
  CircleDollarSign,
  FileWarning,
  Info,
  Layers,
  Link2Off,
  PackageSearch,
  ShieldCheck,
  TrendingDown,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { Layout } from "@/components/layout";
import {
  buildAllForecasts,
  doubleCountDelta,
  DEMAND_LINES,
  HORIZON_WEEKS,
  REP_CALIBRATION,
  unforecastableLines,
  type MaterialForecast,
  type PoolingClass,
} from "@/mocks/forecasting-data";

/* ------------------------------------------------------------------ format */

const ft = (n: number) =>
  n >= 10000 ? `${(n / 1000).toFixed(1)}k ft` : `${Math.round(n).toLocaleString()} ft`;
const usd = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const pct1 = (n: number) => `${(n * 100).toFixed(1)}%`;

const num = "font-mono tabular-nums";

/* ------------------------------------------------------------------ chips */

function PoolingChip({ c }: { c: PoolingClass }) {
  const map: Record<PoolingClass, { label: string; cls: string }> = {
    POOLED: {
      label: "Pooled",
      cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    },
    SEMI_POOLED: {
      label: "Semi-pooled",
      cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
    },
    UNPOOLED: {
      label: "Unpooled",
      cls: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30",
    },
  };
  const v = map[c];
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${v.cls}`}
    >
      {v.label}
    </span>
  );
}

function SourceChip({ s }: { s: string }) {
  const cls =
    s === "NETSUITE"
      ? "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30"
      : s === "HUBSPOT"
        ? "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/30"
        : "bg-muted text-muted-foreground border-border";
  const label = s === "NETSUITE" ? "NetSuite" : s === "HUBSPOT" ? "HubSpot" : "History";
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function RiskDot({ p }: { p: number }) {
  const c =
    p >= 0.4 ? "bg-rose-500" : p >= 0.15 ? "bg-amber-500" : "bg-emerald-500";
  return <span className={`inline-block h-2 w-2 rounded-full ${c}`} />;
}

/* ------------------------------------------------------------------ tiles */

function Tile({
  icon,
  label,
  value,
  sub,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "warn" | "bad" | "good";
}) {
  const toneCls =
    tone === "bad"
      ? "text-rose-600 dark:text-rose-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "good"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-foreground";
  return (
    <Card className="min-w-0">
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          {icon}
          <span className="text-[11px] font-medium uppercase tracking-wide">
            {label}
          </span>
        </div>
        <div className={`mt-1.5 text-2xl font-semibold ${num} ${toneCls}`}>
          {value}
        </div>
        {sub ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ chart */

function PositionChart({ f }: { f: MaterialForecast }) {
  const data = f.weeks.map((w) => ({
    ...w,
    name: `W${w.week}`,
    zero: 0,
  }));
  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
          <CartesianGrid
            strokeDasharray="2 4"
            stroke="currentColor"
            className="text-border"
            vertical={false}
          />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            className="text-muted-foreground"
          />
          <YAxis
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            className="text-muted-foreground"
            tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
            width={44}
          />
          {/* P10–P90 band, drawn as two stacked areas */}
          <Area
            type="monotone"
            dataKey="bandLo"
            stackId="band"
            stroke="none"
            fill="transparent"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="bandSpan"
            stackId="band"
            stroke="none"
            fill="var(--color-chart-1)"
            fillOpacity={0.18}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="p50"
            stroke="var(--color-chart-1)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="safetyStock"
            stroke="var(--color-chart-4)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
          <ReferenceLine y={0} stroke="hsl(var(--destructive))" strokeWidth={1.5} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-4 rounded-sm"
            style={{ background: "var(--color-chart-1)", opacity: 0.25 }}
          />
          P10–P90 range
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-[2px] w-4"
            style={{ background: "var(--color-chart-1)" }}
          />
          P50 (median path)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-[2px] w-4 border-t-2 border-dashed"
            style={{ borderColor: "var(--color-chart-4)" }}
          />
          Safety stock
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4 bg-destructive" />
          Zero — stockout
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ main */

export default function ForecastingPage() {
  const [serviceLevel, setServiceLevel] = React.useState(0.95);
  const [selectedId, setSelectedId] = React.useState("73");

  const forecasts = React.useMemo(
    () => buildAllForecasts({ scenarios: 3000, serviceLevel }),
    [serviceLevel],
  );

  const selected =
    forecasts.find((f) => f.material.stockId === selectedId) ?? forecasts[0]!;

  const dc = React.useMemo(() => doubleCountDelta(), []);
  const unforecastable = React.useMemo(
    () => unforecastableLines(DEMAND_LINES),
    [],
  );

  const atRisk = forecasts.filter((f) => f.pBreachSafety >= 0.15);
  const worstStockout = [...forecasts].sort((a, b) => b.pStockout - a.pStockout)[0]!;
  const totalExposure = forecasts.reduce((a, f) => a + f.exposureUsd, 0);
  const totalExcess = forecasts.reduce((a, f) => a + f.expectedExcessUsd, 0);
  // Gated buys are excluded — a total that included "do not buy" rows would be
  // an instruction to spend money the policy says to hold.
  const totalRecommend = forecasts
    .filter((f) => f.gate === "OK")
    .reduce((a, f) => a + f.recommendUsd, 0);
  const heldUsd = forecasts
    .filter((f) => f.gate === "HOLD_UNFIRM")
    .reduce((a, f) => a + f.recommendUsd, 0);
  const heldCount = forecasts.filter((f) => f.gate === "HOLD_UNFIRM").length;
  const unforecastableUsd = unforecastable.reduce((a, l) => a + l.amountUsd, 0);

  return (
    <Layout>
      <TooltipProvider delayDuration={150}>
        <div className="flex flex-col gap-5">
          {/* ---------------------------------------------------- header */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">
                  Forecasting
                </h1>
                <Badge variant="outline" className="font-mono text-[10px]">
                  PROTOTYPE · INVENTED DATA
                </Badge>
              </div>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Probability-weighted material demand over {HORIZON_WEEKS} weeks.
                Pipeline, orders and history reconciled so nothing is counted
                twice, then simulated to a distribution rather than a single
                number.
              </p>
            </div>
            <div className="flex min-w-[240px] flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <Label className="text-xs text-muted-foreground">
                  Service level
                </Label>
                <span className={`text-sm font-semibold ${num}`}>
                  {pct(serviceLevel)}
                </span>
              </div>
              <Slider
                value={[serviceLevel * 100]}
                min={80}
                max={99}
                step={1}
                onValueChange={(v) => setServiceLevel((v[0] ?? 95) / 100)}
              />
              <p className="text-[11px] leading-tight text-muted-foreground">
                Sets how much of the demand distribution a buy must cover. Higher
                = fewer stockouts, more capital tied up.
              </p>
            </div>
          </div>

          {/* ---------------------------------------------------- tiles */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <Tile
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
              label="Materials at risk"
              value={`${atRisk.length} / ${forecasts.length}`}
              sub="≥15% chance of breaching safety stock"
              tone={atRisk.length > 0 ? "warn" : "good"}
            />
            <Tile
              icon={<TrendingDown className="h-3.5 w-3.5" />}
              label="Worst stockout risk"
              value={pct1(worstStockout.pStockout)}
              sub={`Stock #${worstStockout.material.stockId}`}
              tone={worstStockout.pStockout >= 0.2 ? "bad" : "warn"}
            />
            <Tile
              icon={<CircleDollarSign className="h-3.5 w-3.5" />}
              label="Approved buys"
              value={usd(totalRecommend)}
              sub={
                heldCount > 0
                  ? `${usd(heldUsd)} more held by policy on ${heldCount} stock${heldCount > 1 ? "s" : ""}`
                  : `at ${pct(serviceLevel)} service level`
              }
            />
            <Tile
              icon={<PackageSearch className="h-3.5 w-3.5" />}
              label="Expected excess"
              value={usd(totalExcess)}
              sub="mean leftover above safety stock"
              tone={totalExcess > 20000 ? "warn" : "default"}
            />
            <Tile
              icon={<Link2Off className="h-3.5 w-3.5" />}
              label="Not forecastable"
              value={usd(unforecastableUsd)}
              sub={`${unforecastable.length} deals with no construction`}
              tone="bad"
            />
          </div>

          {/* ---------------------------------------------------- consumption banner */}
          <Card className="border-l-4 border-l-[var(--color-chart-1)]">
            <CardContent className="flex flex-wrap items-start gap-4 p-4">
              <Layers className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">
                  Layers consume each other — they are not summed
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  <span className="font-mono text-xs">{dc.dealRef}</span> became{" "}
                  <span className="font-mono text-xs">{dc.soRef}</span>, so the
                  HubSpot deal now contributes <strong>zero</strong>. Summing both
                  layers would forecast{" "}
                  <span className={num}>{ft(dc.stackedFt)}</span> of stock #
                  {dc.stockId} against a true requirement of{" "}
                  <span className={num}>{ft(dc.correctFt)}</span>.
                </p>
              </div>
              <div className="shrink-0 rounded-md bg-rose-500/10 px-3 py-2 text-right">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">
                  Double-count avoided
                </div>
                <div
                  className={`text-lg font-semibold text-rose-700 dark:text-rose-400 ${num}`}
                >
                  {ft(dc.wastedFt)} · {usd(dc.wastedUsd)}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ---------------------------------------------------- material table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Material position</CardTitle>
              <CardDescription>
                Policy follows the pooling class. Pooled materials are safe to buy
                against weighted demand; unpooled ones should wait for a firm
                order. Click a row for detail.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Stock</TableHead>
                      <TableHead>Class</TableHead>
                      <TableHead className="text-right">On hand</TableHead>
                      <TableHead className="text-right">Lead time</TableHead>
                      <TableHead className="text-right">P(stockout)</TableHead>
                      <TableHead className="text-right">Breach wk</TableHead>
                      <TableHead className="text-right">Exp. excess</TableHead>
                      <TableHead className="text-right">Buy</TableHead>
                      <TableHead className="text-right">Order by</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {forecasts.map((f) => {
                      const m = f.material;
                      const isSel = m.stockId === selectedId;
                      return (
                        <TableRow
                          key={m.stockId}
                          onClick={() => setSelectedId(m.stockId)}
                          className={`cursor-pointer ${isSel ? "bg-accent/50" : ""}`}
                        >
                          <TableCell className="max-w-[280px]">
                            <div className="flex items-center gap-2">
                              <RiskDot p={f.pStockout} />
                              <span className={`font-semibold ${num}`}>
                                #{m.stockId}
                              </span>
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {m.description}
                            </div>
                          </TableCell>
                          <TableCell>
                            <PoolingChip c={f.pooling} />
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              {f.distinctCustomers} cust · {f.distinctDeals} deals
                            </div>
                          </TableCell>
                          <TableCell className={`text-right ${num}`}>
                            {ft(m.onHandFt)}
                            <div className="text-[11px] text-muted-foreground">
                              SS {ft(m.safetyStockFt)}
                            </div>
                          </TableCell>
                          <TableCell className={`text-right ${num}`}>
                            {m.leadTimeDays}d
                            <div className="text-[11px] text-muted-foreground">
                              ±{m.leadTimeSigmaDays}d
                            </div>
                          </TableCell>
                          <TableCell
                            className={`text-right font-semibold ${num} ${
                              f.pStockout >= 0.2
                                ? "text-rose-600 dark:text-rose-400"
                                : f.pStockout >= 0.05
                                  ? "text-amber-600 dark:text-amber-400"
                                  : ""
                            }`}
                          >
                            {pct1(f.pStockout)}
                          </TableCell>
                          <TableCell className={`text-right ${num}`}>
                            {f.firstBreachWeek === null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              `W${f.firstBreachWeek}`
                            )}
                          </TableCell>
                          <TableCell className={`text-right ${num}`}>
                            {f.expectedExcessUsd > 500 ? (
                              usd(f.expectedExcessUsd)
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className={`text-right ${num}`}>
                            {f.gate === "HOLD_UNFIRM" ? (
                              <UiTooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-help font-semibold text-rose-600 underline decoration-dotted underline-offset-2 dark:text-rose-400">
                                    HOLD
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-[300px] text-xs">
                                  {f.gateReason}
                                </TooltipContent>
                              </UiTooltip>
                            ) : f.recommendRolls > 0 ? (
                              <>
                                <span className="font-semibold">
                                  {f.recommendRolls} roll
                                  {f.recommendRolls > 1 ? "s" : ""}
                                </span>
                                <div className="text-[11px] text-muted-foreground">
                                  {usd(f.recommendUsd)}
                                </div>
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className={`text-right ${num}`}>
                            {f.gate === "HOLD_UNFIRM" || f.orderByWeek === null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : f.lateByWeeks > 0 ? (
                              <span className="font-semibold text-rose-600 dark:text-rose-400">
                                {f.lateByWeeks}w late
                              </span>
                            ) : f.orderByWeek <= 0 ? (
                              <span className="font-semibold text-rose-600 dark:text-rose-400">
                                NOW
                              </span>
                            ) : (
                              `W${f.orderByWeek}`
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* ---------------------------------------------------- detail */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">
                      Stock #{selected.material.stockId} — projected position
                    </CardTitle>
                    <CardDescription className="mt-0.5">
                      {selected.material.description}
                    </CardDescription>
                  </div>
                  <PoolingChip c={selected.pooling} />
                </div>
              </CardHeader>
              <CardContent>
                <PositionChart f={selected} />
              </CardContent>
            </Card>

            {/* decision card */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Decision</CardTitle>
                <CardDescription>
                  Both failure modes, priced together.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                {selected.gate === "HOLD_UNFIRM" ? (
                  <div className="rounded-md border border-rose-500/40 bg-rose-500/5 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">
                      Do not buy — policy gate
                    </div>
                    <div className="mt-0.5 text-lg font-semibold">
                      Hold for a firm order
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {selected.gateReason}
                    </p>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      The model would size the buy at{" "}
                      <span className={num}>
                        {selected.recommendRolls} roll
                        {selected.recommendRolls > 1 ? "s" : ""} ·{" "}
                        {usd(selected.recommendUsd)}
                      </span>{" "}
                      — shown so the cost of waiting is visible, not as an
                      instruction.
                    </p>
                  </div>
                ) : selected.recommendRolls > 0 ? (
                  <div className="rounded-md border border-[var(--color-chart-1)]/40 bg-[var(--color-chart-1)]/5 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Recommended
                    </div>
                    <div className={`mt-0.5 text-lg font-semibold ${num}`}>
                      Buy {selected.recommendRolls} roll
                      {selected.recommendRolls > 1 ? "s" : ""} ·{" "}
                      {ft(selected.recommendFt)}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {usd(selected.recommendUsd)} from{" "}
                      {selected.material.supplierName}
                      {selected.orderByWeek !== null && (
                        <>
                          {" · order by "}
                          <strong className="text-foreground">
                            {selected.orderByWeek <= 0
                              ? "now"
                              : `week ${selected.orderByWeek}`}
                          </strong>
                        </>
                      )}
                    </div>
                    {selected.lateByWeeks > 0 && (
                      <p className="mt-1.5 flex items-start gap-1.5 text-sm text-rose-600 dark:text-rose-400">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          Lead time {selected.material.leadTimeDays}d cannot make
                          week {selected.firstBreachWeek} — already{" "}
                          {selected.lateByWeeks} week
                          {selected.lateByWeeks > 1 ? "s" : ""} past the order-by
                          date. Expedite, substitute, or re-promise the ship date.
                        </span>
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="rounded-md border bg-muted/40 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Recommended
                    </div>
                    <div className="mt-0.5 text-lg font-semibold">
                      Hold — no buy needed
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Position covers demand at {pct(serviceLevel)} service level.
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border p-2.5">
                    <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <TrendingDown className="h-3 w-3" /> If you wait
                    </div>
                    <div
                      className={`mt-0.5 text-base font-semibold ${num} text-rose-600 dark:text-rose-400`}
                    >
                      {pct1(selected.pStockout)}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      chance of stockout
                    </div>
                  </div>
                  <div className="rounded-md border p-2.5">
                    <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <PackageSearch className="h-3 w-3" /> If you commit
                    </div>
                    <div
                      className={`mt-0.5 text-base font-semibold ${num} text-amber-600 dark:text-amber-400`}
                    >
                      {usd(selected.exposureUsd)}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      exposure if drivers die
                    </div>
                  </div>
                </div>

                <Separator />

                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                  {selected.pooling === "UNPOOLED" ? (
                    <>
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
                      <span>
                        <strong className="text-foreground">
                          Unpooled — make to order.
                        </strong>{" "}
                        {selected.distinctCustomers <= 1
                          ? "Only one customer draws on this stock, so there is no pooling to absorb a dead deal."
                          : "Custom stock with no substitutes."}{" "}
                        Do not buy before a firm order or a deposit.
                      </span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                      <span>
                        <strong className="text-foreground">
                          {selected.pooling === "POOLED"
                            ? "Pooled — safe to buy ahead."
                            : "Semi-pooled — buy with care."}
                        </strong>{" "}
                        {selected.distinctCustomers} customers draw on this stock
                        {selected.material.alternateStockIds.length > 0 &&
                          `, and #${selected.material.alternateStockIds.join(", #")} can substitute`}
                        .
                        {selected.absorbWeeks !== null &&
                          selected.absorbWeeks > 0 &&
                          ` Baseline demand absorbs the expected excess in about ${selected.absorbWeeks} week${selected.absorbWeeks === 1 ? "" : "s"}.`}
                      </span>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ---------------------------------------------------- tabs */}
          <Tabs defaultValue="drivers">
            <TabsList>
              <TabsTrigger value="drivers">
                Demand attribution ({selected.drivers.length})
              </TabsTrigger>
              <TabsTrigger value="queue">
                Cannot forecast ({unforecastable.length})
              </TabsTrigger>
              <TabsTrigger value="calibration">Rep calibration</TabsTrigger>
            </TabsList>

            {/* --- drivers --- */}
            <TabsContent value="drivers">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    What is driving demand for #{selected.material.stockId}
                  </CardTitle>
                  <CardDescription>
                    Every line traces to a named record, its probability, and how
                    that probability was derived. Hover a probability to see the
                    chain.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Source</TableHead>
                          <TableHead>Reference</TableHead>
                          <TableHead>Customer / brand</TableHead>
                          <TableHead>Rep</TableHead>
                          <TableHead className="text-right">Week</TableHead>
                          <TableHead className="text-right">Footage</TableHead>
                          <TableHead className="text-right">P(win)</TableHead>
                          <TableHead className="text-right">Weighted</TableHead>
                          <TableHead>Construction</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[...selected.drivers]
                          .sort((a, b) => a.line.requiredWeek - b.line.requiredWeek)
                          .map((d) => (
                            <TableRow key={d.line.id}>
                              <TableCell>
                                <SourceChip s={d.line.source} />
                              </TableCell>
                              <TableCell className={`text-xs ${num}`}>
                                {d.line.ref}
                                <div className="text-[11px] text-muted-foreground">
                                  {d.line.stage.replace("|", " · ")}
                                </div>
                              </TableCell>
                              <TableCell className="text-sm">
                                {d.line.customer}
                                <div className="text-[11px] text-muted-foreground">
                                  {d.line.brand} · {usd(d.line.amountUsd)}
                                </div>
                              </TableCell>
                              <TableCell className="text-sm">
                                {d.line.rep}
                                <div className="text-[11px] text-muted-foreground">
                                  {d.line.ageDays}d since touch
                                </div>
                              </TableCell>
                              <TableCell className={`text-right ${num}`}>
                                W{d.line.requiredWeek}
                              </TableCell>
                              <TableCell className={`text-right ${num}`}>
                                {ft(d.footageFt)}
                              </TableCell>
                              <TableCell className="text-right">
                                <UiTooltip>
                                  <TooltipTrigger asChild>
                                    <span
                                      className={`cursor-help font-semibold underline decoration-dotted underline-offset-2 ${num}`}
                                    >
                                      {pct(d.line.p)}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-[320px]">
                                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide">
                                      How this was derived
                                    </div>
                                    <ol className="list-decimal space-y-0.5 pl-4 text-xs">
                                      {d.line.pBasis.map((b, i) => (
                                        <li key={i}>{b}</li>
                                      ))}
                                    </ol>
                                  </TooltipContent>
                                </UiTooltip>
                              </TableCell>
                              <TableCell
                                className={`text-right font-semibold ${num}`}
                              >
                                {ft(d.footageFt * d.line.p)}
                              </TableCell>
                              <TableCell className="text-xs">
                                {d.line.construction ? (
                                  <UiTooltip>
                                    <TooltipTrigger asChild>
                                      <span className="cursor-help underline decoration-dotted underline-offset-2">
                                        {d.line.construction.noAcross}-across ·{" "}
                                        {d.line.construction.repeatIn}″
                                        {d.line.construction.derived && (
                                          <Badge
                                            variant="outline"
                                            className="ml-1 px-1 py-0 text-[9px]"
                                          >
                                            derived
                                          </Badge>
                                        )}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-[300px] text-xs">
                                      <div className="font-semibold">
                                        {d.line.construction.sizeAcrossIn}″ ×{" "}
                                        {d.line.construction.sizeAroundIn}″ ·{" "}
                                        {d.line.construction.copyPosition}
                                      </div>
                                      <div className="mt-1 text-muted-foreground">
                                        good length{" "}
                                        {ft(d.line.construction.goodLengthFt)} ·{" "}
                                        {d.line.construction.derived
                                          ? "layout DERIVED — LabelTraxx had no stored repeat/noAcross"
                                          : "using LabelTraxx stored geometry"}
                                      </div>
                                    </TooltipContent>
                                  </UiTooltip>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="flex items-start gap-2 border-t p-3 text-xs text-muted-foreground">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Baseline (unnamed reorder) demand for this stock is{" "}
                      <span className={num}>
                        {ft(selected.material.baselineWeeklyFt)}/week
                      </span>{" "}
                      from roll-usage history. Named demand consumes it week by
                      week — the greater of the two is used, never the sum.
                    </span>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* --- work queue --- */}
            <TabsContent value="queue">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <FileWarning className="h-4 w-4 text-rose-500" />
                    Deals that cannot be material-forecast
                  </CardTitle>
                  <CardDescription>
                    {usd(unforecastableUsd)} of pipeline is invisible to this
                    forecast because no construction exists to explode it into
                    materials. This is a work queue for Estimating, not a bug.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Deal</TableHead>
                          <TableHead>Customer</TableHead>
                          <TableHead>Rep</TableHead>
                          <TableHead className="text-right">Value</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Needed</TableHead>
                          <TableHead>Why</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {unforecastable.map((l) => (
                          <TableRow key={l.id}>
                            <TableCell className={`text-xs ${num}`}>
                              {l.ref}
                              <div className="text-[11px] text-muted-foreground">
                                {l.stage.replace("|", " · ")}
                              </div>
                            </TableCell>
                            <TableCell className="text-sm">
                              {l.customer}
                            </TableCell>
                            <TableCell className="text-sm">{l.rep}</TableCell>
                            <TableCell
                              className={`text-right font-semibold ${num}`}
                            >
                              {usd(l.amountUsd)}
                            </TableCell>
                            <TableCell className={`text-right ${num}`}>
                              {l.qtyUnits.toLocaleString()}
                            </TableCell>
                            <TableCell className={`text-right ${num}`}>
                              W{l.requiredWeek}
                            </TableCell>
                            <TableCell className="max-w-[320px] text-xs text-muted-foreground">
                              {l.unresolvedReason}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* --- calibration --- */}
            <TabsContent value="calibration">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    Rep calibration — measured, not seniority
                  </CardTitle>
                  <CardDescription>
                    When this rep says 70%, what actually closed? A factor of 1.00
                    is perfectly calibrated. Derived from outcomes, so it is an
                    observed ratio rather than a judgement about anyone.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Rep</TableHead>
                        <TableHead className="text-right">Factor</TableHead>
                        <TableHead className="text-right">Sample</TableHead>
                        <TableHead>Reading</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Object.entries(REP_CALIBRATION)
                        .sort((a, b) => b[1].factor - a[1].factor)
                        .map(([rep, c]) => (
                          <TableRow key={rep}>
                            <TableCell className="text-sm font-medium">
                              {rep}
                            </TableCell>
                            <TableCell
                              className={`text-right font-semibold ${num} ${
                                c.factor >= 1.05
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : c.factor <= 0.8
                                    ? "text-rose-600 dark:text-rose-400"
                                    : ""
                              }`}
                            >
                              {c.factor.toFixed(2)}
                            </TableCell>
                            <TableCell className={`text-right ${num}`}>
                              n={c.n}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {c.n < 30
                                ? "Sample too small to act on — shown for transparency only."
                                : c.factor >= 1.05
                                  ? "Slightly conservative; their calls land more often than stated."
                                  : c.factor <= 0.8
                                    ? "Optimistic; forecasts are discounted accordingly."
                                    : "Well calibrated."}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                  <div className="flex items-start gap-2 border-t p-3 text-xs text-muted-foreground">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      The real engine also carries a manager override with a
                      mandatory written reason, scored nightly against outcomes.
                      An override counts at face value in the headline but is
                      priced at the overrider&rsquo;s learned hit rate in the
                      uncertainty band — so a poor track record widens its own
                      band.
                    </span>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          <div className="flex items-center justify-between gap-3 pb-6 text-xs text-muted-foreground">
            <span>
              3,000 simulated scenarios per material · seeded, so figures are
              reproducible run to run.
            </span>
            <Button variant="outline" size="sm" disabled>
              Export to purchasing <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
        </div>
      </TooltipProvider>
    </Layout>
  );
}
