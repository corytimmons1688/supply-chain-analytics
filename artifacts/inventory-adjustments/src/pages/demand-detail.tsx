import * as React from "react";
import { Link, useParams } from "wouter";
import { Layout } from "@/components/layout";
import {
  useGetDemandStockDetail,
  getGetDemandStockDetailQueryKey,
  useGetGoals,
  getGetGoalsQueryKey,
  useSetStockGoal,
  type DemandPoint,
  type GetDemandStockDetailParams,
  type OpenPo,
  type StockGoal,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft, AlertTriangle, Loader2, PauseCircle } from "lucide-react";
import { cn } from "@/lib/utils";

function fmtFt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n) + " ft";
}
function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);
}
function fmtDays(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  return `${fmtNum(n)} d`;
}
function fmtLastUsed(daysSince: number | null | undefined): string {
  if (daysSince == null) return "never";
  if (daysSince <= 0) return "today";
  if (daysSince === 1) return "1 day ago";
  if (daysSince < 30) return `${daysSince} days ago`;
  if (daysSince < 60) return `~1 mo ago`;
  const months = Math.round(daysSince / 30);
  if (months < 12) return `${months} mos ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? "1 yr ago" : `${years} yrs ago`;
}

export default function DemandDetail() {
  const params = useParams<{ stockId: string }>();
  const stockId = decodeURIComponent(params.stockId ?? "");

  const [monthsBack, setMonthsBack] = React.useState<number>(6);
  const [serviceLevel, setServiceLevel] = React.useState<number>(0.95);
  const [bucket, setBucket] = React.useState<"week" | "month">("week");

  const queryParams: GetDemandStockDetailParams = {
    stockId,
    monthsBack,
    serviceLevel,
    forecastWeeks: 12,
    bucket,
  };
  const { data, isLoading, isFetching } = useGetDemandStockDetail(queryParams, {
    query: {
      queryKey: getGetDemandStockDetailQueryKey(queryParams),
      staleTime: 60_000,
      enabled: !!stockId,
    },
  });

  const m = data?.metrics;
  const history: DemandPoint[] = data?.history ?? [];
  const forecast: DemandPoint[] = data?.forecast ?? [];
  const openPos: OpenPo[] = data?.openPos ?? [];

  // ----- Per-stock override editor -----
  const queryClient = useQueryClient();
  const { data: goalsData } = useGetGoals({
    query: { queryKey: getGetGoalsQueryKey(), staleTime: 60_000 },
  });
  const setStockGoalMutation = useSetStockGoal();
  const existing: StockGoal | undefined = React.useMemo(
    () => goalsData?.perStock.find((g) => g.stockId === stockId),
    [goalsData, stockId],
  );

  // Local form state — strings so the user can clear a field. "" = use default.
  const [demandCvDraft, setDemandCvDraft] = React.useState<string>("");
  const [leadTimeCvDraft, setLeadTimeCvDraft] = React.useState<string>("");
  const [seasW1Draft, setSeasW1Draft] = React.useState<string>("");
  const [seasW2Draft, setSeasW2Draft] = React.useState<string>("");
  const [seasW3Draft, setSeasW3Draft] = React.useState<string>("");
  const [leadTimeDaysDraft, setLeadTimeDaysDraft] = React.useState<string>("");
  const [typicalRollFootageDraft, setTypicalRollFootageDraft] = React.useState<string>("");

  // Reset draft fields whenever the loaded override changes (e.g. switching stocks).
  React.useEffect(() => {
    setDemandCvDraft(existing?.demandCv != null ? String(existing.demandCv) : "");
    setLeadTimeCvDraft(existing?.leadTimeCv != null ? String(existing.leadTimeCv) : "");
    const w = existing?.seasonalityWeights;
    setSeasW1Draft(w && w[0] != null ? String(w[0]) : "");
    setSeasW2Draft(w && w[1] != null ? String(w[1]) : "");
    setSeasW3Draft(w && w[2] != null ? String(w[2]) : "");
    setLeadTimeDaysDraft(existing?.leadTimeDays != null ? String(existing.leadTimeDays) : "");
    setTypicalRollFootageDraft(
      existing?.typicalRollFootage != null ? String(existing.typicalRollFootage) : "",
    );
  }, [existing]);

  const handleSaveOverrides = async () => {
    const parseOpt = (s: string): number | null => {
      const t = s.trim();
      if (t === "") return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : NaN;
    };
    const demandCv = parseOpt(demandCvDraft);
    const leadTimeCv = parseOpt(leadTimeCvDraft);
    const leadTimeDays = parseOpt(leadTimeDaysDraft);
    const typicalRollFootage = parseOpt(typicalRollFootageDraft);
    if (Number.isNaN(demandCv) || Number.isNaN(leadTimeCv)) {
      toast.error("CV values must be numbers (e.g. 0.25)");
      return;
    }
    if (Number.isNaN(leadTimeDays) || Number.isNaN(typicalRollFootage)) {
      toast.error("Lead-time days and typical roll size must be numbers");
      return;
    }
    if (demandCv != null && demandCv < 0) {
      toast.error("Demand CV must be ≥ 0");
      return;
    }
    if (leadTimeCv != null && leadTimeCv < 0) {
      toast.error("Lead-time CV must be ≥ 0");
      return;
    }
    if (leadTimeDays != null && leadTimeDays <= 0) {
      toast.error("Lead time (days) must be > 0");
      return;
    }
    if (typicalRollFootage != null && typicalRollFootage <= 0) {
      toast.error("Typical roll size (ft) must be > 0");
      return;
    }
    const w1Raw = seasW1Draft.trim();
    const w2Raw = seasW2Draft.trim();
    const w3Raw = seasW3Draft.trim();
    const anyW = w1Raw !== "" || w2Raw !== "" || w3Raw !== "";
    const allW = w1Raw !== "" && w2Raw !== "" && w3Raw !== "";
    let seasonalityWeights: number[] | null = null;
    if (anyW) {
      if (!allW) {
        toast.error("Provide all three seasonality weights, or clear all to use the default");
        return;
      }
      const w1 = Number(w1Raw);
      const w2 = Number(w2Raw);
      const w3 = Number(w3Raw);
      if (![w1, w2, w3].every((v) => Number.isFinite(v) && v >= 0)) {
        toast.error("Seasonality weights must be non-negative numbers");
        return;
      }
      if (w1 + w2 + w3 <= 0) {
        toast.error("Seasonality weights must sum to a positive number");
        return;
      }
      seasonalityWeights = [w1, w2, w3];
    }

    const allCleared =
      demandCv == null &&
      leadTimeCv == null &&
      seasonalityWeights == null &&
      leadTimeDays == null &&
      typicalRollFootage == null;

    try {
      // Preserve existing min/max bands, only modify forecast assumptions.
      await setStockGoalMutation.mutateAsync({
        stockId,
        data: {
          min: existing?.min ?? null,
          max: existing?.max ?? null,
          demandCv,
          leadTimeCv,
          seasonalityWeights,
          leadTimeDays,
          typicalRollFootage,
        },
      });
      queryClient.invalidateQueries({ queryKey: getGetGoalsQueryKey() });
      // Force the demand detail to refetch with new overrides.
      queryClient.invalidateQueries({ queryKey: ["/api/demand/stock-detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/demand/summary"] });
      toast.success(allCleared ? "Overrides cleared" : "Forecast overrides saved");
    } catch {
      toast.error("Failed to save overrides");
    }
  };

  const handleResetOverrides = () => {
    setDemandCvDraft("");
    setLeadTimeCvDraft("");
    setSeasW1Draft("");
    setSeasW2Draft("");
    setSeasW3Draft("");
    setLeadTimeDaysDraft("");
    setTypicalRollFootageDraft("");
  };

  const sumDraftWeights = (() => {
    const vals = [seasW1Draft, seasW2Draft, seasW3Draft]
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map(Number)
      .filter((n) => Number.isFinite(n));
    if (vals.length === 0) return null;
    return vals.reduce((s, v) => s + v, 0);
  })();
  // Chart data: history + forecast as a single timeline
  const chartData = React.useMemo(() => {
    return [
      ...history.map((p) => ({
        label: p.label,
        periodStart: p.periodStart,
        history: p.footage,
        forecast: null as number | null,
      })),
      ...forecast.map((p) => ({
        label: p.label,
        periodStart: p.periodStart,
        history: null as number | null,
        forecast: p.footage,
      })),
    ];
  }, [history, forecast]);

  const ropLine = m?.reorderPointFootage ?? 0;

  return (
    <Layout>
      <div className="flex items-center gap-3">
        <Link
          href="/demand"
          className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors inline-flex items-center"
          aria-label="Back to demand planning"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Stock #{stockId}</h1>
            {m?.belowMin && (
              <Badge
                variant="outline"
                className="border-amber-500/40 text-amber-700 dark:text-amber-400"
              >
                <AlertTriangle className="w-3 h-3 mr-1" />
                Below reorder point
              </Badge>
            )}
            {m && (m.activityStatus === "dormant" || m.activityStatus === "never") && (
              <Badge
                variant="outline"
                className="border-red-500/40 text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30"
                title="No recent demand — consider inactivating in Label Traxx"
              >
                <PauseCircle className="w-3 h-3 mr-1" />
                Review for inactivation
              </Badge>
            )}
            {m?.activityStatus === "slowing" && (
              <Badge
                variant="outline"
                className="border-amber-500/40 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30"
                title="Demand has slowed — review usage"
              >
                <PauseCircle className="w-3 h-3 mr-1" />
                Slowing
              </Badge>
            )}
            {m?.customized && (
              <Badge
                variant="outline"
                className="border-violet-500/40 text-violet-700 dark:text-violet-400"
                title="This stock has per-stock forecast assumption overrides"
              >
                Customized
              </Badge>
            )}
            {isFetching && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5 line-clamp-1">
            {m?.description ?? (isLoading ? "Loading…" : "")}
          </p>
        </div>
      </div>

      {/* Controls */}
      <Card>
        <CardContent className="pt-6 pb-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 sm:gap-6 items-end">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                History window
              </label>
              <Select value={String(monthsBack)} onValueChange={(v) => setMonthsBack(Number(v))}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3">3 months</SelectItem>
                  <SelectItem value="6">6 months</SelectItem>
                  <SelectItem value="12">12 months</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                History bucket
              </label>
              <Select value={bucket} onValueChange={(v) => setBucket(v as "week" | "month")}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="week">Weekly</SelectItem>
                  <SelectItem value="month">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Service level: {(serviceLevel * 100).toFixed(1)}%
              </label>
              <Slider
                value={[serviceLevel * 100]}
                min={50}
                max={99.5}
                step={0.5}
                onValueChange={(v) => setServiceLevel((v[0] ?? 95) / 100)}
                className="mt-3"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Per-stock forecast assumption overrides */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Forecast assumption overrides</CardTitle>
          <p className="text-xs text-muted-foreground">
            Override the global forecast assumptions for just this stock. Leave a field blank to
            fall back to the global default. Defaults: demand &amp; lead-time CV are auto-derived
            from history; seasonality weights are 0.25 / 0.25 / 0.50 (for months 1, 2, 3 of each
            quarter).
          </p>
        </CardHeader>
        <CardContent className="pb-5">
          {m && (
            <div className="mb-4 rounded-md border bg-muted/30 px-3 py-2 text-xs grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
              <OverrideStatus
                label="Demand CV"
                effective={fmtNum(m.demandCv, 2)}
                auto={fmtNum(m.autoDemandCv, 2)}
                overridden={m.demandCvOverridden}
              />
              <OverrideStatus
                label="Lead-time CV"
                effective={fmtNum(m.leadTimeCv, 2)}
                auto={fmtNum(m.autoLeadTimeCv, 2)}
                overridden={m.leadTimeCvOverridden}
              />
              <OverrideStatus
                label="Lead time"
                effective={`${fmtNum(m.avgLeadTimeDays, 1)}d`}
                auto={`${fmtNum(m.autoLeadTimeDays, 1)}d`}
                overridden={m.leadTimeDaysOverridden}
              />
              <OverrideStatus
                label="Typical roll"
                effective={fmtFt(m.typicalRollFootage)}
                auto={fmtFt(m.autoTypicalRollFootage)}
                overridden={m.typicalRollFootageOverridden}
              />
              <OverrideStatus
                label="Seasonality"
                effective={m.seasonalityWeights
                  .map((w) => fmtNum(w, 2))
                  .join(" / ")}
                auto={m.defaultSeasonalityWeights
                  .map((w) => fmtNum(w, 2))
                  .join(" / ")}
                overridden={m.seasonalityWeightsOverridden}
              />
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 items-end mb-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Lead time (days)
              </label>
              <Input
                type="number"
                inputMode="decimal"
                step="1"
                min="0"
                placeholder={m ? fmtNum(m.autoLeadTimeDays, 1) : "auto"}
                value={leadTimeDaysDraft}
                onChange={(e) => setLeadTimeDaysDraft(e.target.value)}
                className="mt-1.5 font-mono"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Used for safety stock + reorder point math. Blank = auto from PO history.
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Typical roll size (ft)
              </label>
              <Input
                type="number"
                inputMode="decimal"
                step="100"
                min="0"
                placeholder={m ? String(m.autoTypicalRollFootage) : "auto"}
                value={typicalRollFootageDraft}
                onChange={(e) => setTypicalRollFootageDraft(e.target.value)}
                className="mt-1.5 font-mono"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Used to round suggested PO size to whole rolls. Blank = auto from PO history.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Demand CV
              </label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                placeholder="auto"
                value={demandCvDraft}
                onChange={(e) => setDemandCvDraft(e.target.value)}
                className="mt-1.5 font-mono"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Lead-time CV
              </label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                placeholder="auto"
                value={leadTimeCvDraft}
                onChange={(e) => setLeadTimeCvDraft(e.target.value)}
                className="mt-1.5 font-mono"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Season Wt M1
              </label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.05"
                min="0"
                placeholder="0.25"
                value={seasW1Draft}
                onChange={(e) => setSeasW1Draft(e.target.value)}
                className="mt-1.5 font-mono"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Season Wt M2
              </label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.05"
                min="0"
                placeholder="0.25"
                value={seasW2Draft}
                onChange={(e) => setSeasW2Draft(e.target.value)}
                className="mt-1.5 font-mono"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Season Wt M3
              </label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.05"
                min="0"
                placeholder="0.50"
                value={seasW3Draft}
                onChange={(e) => setSeasW3Draft(e.target.value)}
                className="mt-1.5 font-mono"
              />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <Button
              size="sm"
              onClick={handleSaveOverrides}
              disabled={setStockGoalMutation.isPending}
            >
              {setStockGoalMutation.isPending ? "Saving…" : "Save overrides"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleResetOverrides}
              disabled={setStockGoalMutation.isPending}
            >
              Clear all
            </Button>
            {sumDraftWeights != null && (
              <span
                className={cn(
                  "text-xs font-mono",
                  Math.abs(sumDraftWeights - 1) < 0.01
                    ? "text-muted-foreground"
                    : "text-amber-600",
                )}
              >
                weights sum: {sumDraftWeights.toFixed(2)}
                {Math.abs(sumDraftWeights - 1) >= 0.01 && " (will be normalized to 1.00)"}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Metric grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <MetricCard label="On hand" primary={fmtFt(m?.onHandFootage)} secondary={`${m?.onHandRollCount ?? 0} rolls`} />
        <MetricCard
          label="On order"
          primary={m && m.openPoCount > 0 ? fmtFt(m.openPoFootage) : "—"}
          secondary={
            m && m.openPoCount > 0
              ? `${m.openPoRolls} roll${m.openPoRolls === 1 ? "" : "s"} · ${m.openPoCount} open PO${m.openPoCount === 1 ? "" : "s"}`
              : "no open purchase orders"
          }
        />
        <MetricCard
          label="Days of cover"
          primary={m && m.daysOfCover < 0 ? "∞" : fmtDays(m?.daysOfCover)}
          tone={m && m.daysOfCover >= 0 && m.daysOfCover < 14 ? "danger" : m && m.daysOfCover < 30 ? "warn" : "neutral"}
        />
        <MetricCard
          label="Avg weekly demand"
          primary={fmtFt(m?.avgWeeklyDemand)}
          secondary={
            <>
              σ {fmtFt(m?.weeklyDemandStdDev)}
              {" · "}CV {fmtNum(m?.demandCv, 2)}
              {m?.demandCvOverridden && (
                <>
                  {" "}
                  <span className="text-muted-foreground/70">
                    (auto {fmtNum(m.autoDemandCv, 2)})
                  </span>
                </>
              )}
            </>
          }
          overridden={m?.demandCvOverridden}
          overrideLabel="Demand CV override"
        />
        <MetricCard
          label="Lead time"
          primary={fmtDays(m?.avgLeadTimeDays)}
          secondary={
            <>
              {m?.leadTimeDaysOverridden ? (
                <span className="text-muted-foreground/70">
                  manual override (auto {fmtNum(m.autoLeadTimeDays, 1)}d)
                </span>
              ) : m?.poObservations ? (
                `${m.poObservations} PO obs · σ ${fmtNum(m.leadTimeStdDev, 1)}d`
              ) : (
                "estimated (no PO history)"
              )}
              {" · "}CV {fmtNum(m?.leadTimeCv, 2)}
              {m?.leadTimeCvOverridden && (
                <>
                  {" "}
                  <span className="text-muted-foreground/70">
                    (auto {fmtNum(m.autoLeadTimeCv, 2)})
                  </span>
                </>
              )}
            </>
          }
          overridden={m?.leadTimeCvOverridden || m?.leadTimeDaysOverridden}
          overrideLabel={
            m?.leadTimeDaysOverridden && m?.leadTimeCvOverridden
              ? "Lead time + CV override"
              : m?.leadTimeDaysOverridden
              ? "Lead time override"
              : "Lead-time CV override"
          }
        />
        <MetricCard
          label="Reorder point"
          primary={fmtFt(m?.reorderPointFootage)}
          secondary={`safety stock ${fmtFt(m?.safetyStockFootage)}`}
          overridden={
            m?.demandCvOverridden ||
            m?.leadTimeCvOverridden ||
            m?.leadTimeDaysOverridden
          }
          overrideLabel="Affected by override"
        />
        <MetricCard
          label="Max"
          primary={fmtFt(m?.maxFootage)}
          secondary="cover lead time + 4 wk demand"
          overridden={m?.leadTimeDaysOverridden || m?.typicalRollFootageOverridden}
          overrideLabel="Affected by override"
        />
        <MetricCard
          label="Typical roll size"
          primary={fmtFt(m?.typicalRollFootage)}
          secondary={
            m?.typicalRollFootageOverridden ? (
              <span className="text-muted-foreground/70">
                manual override (auto {fmtFt(m.autoTypicalRollFootage)})
              </span>
            ) : (
              "from PO roll history"
            )
          }
          overridden={m?.typicalRollFootageOverridden}
          overrideLabel="Typical roll size override"
        />
        <MetricCard
          label="Suggested PO"
          primary={m && m.suggestedOrderRolls > 0 ? `${m.suggestedOrderRolls} roll${m.suggestedOrderRolls === 1 ? "" : "s"}` : "—"}
          secondary={m && m.suggestedOrderRolls > 0 ? fmtFt(m.suggestedOrderFootage) : "above reorder point"}
          tone={m?.belowMin ? "warn" : "neutral"}
        />
        <MetricCard
          label="Last used"
          primary={m ? fmtLastUsed(m.daysSinceLastUse ?? null) : "—"}
          secondary={
            m?.lastUsedDate
              ? `most recent ticket: ${m.lastUsedDate}`
              : "no demand observed in window"
          }
          tone={
            m?.activityStatus === "dormant" || m?.activityStatus === "never"
              ? "danger"
              : m?.activityStatus === "slowing"
                ? "warn"
                : "neutral"
          }
        />
      </div>

      {/* Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Footage demand history & 12-week forecast</CardTitle>
          <p className="text-xs text-muted-foreground">
            History excludes &ldquo;CC&rdquo; inventory adjustments. Forecast applies quarterly
            seasonality (month 3 = 50% of quarter, months 1+2 = 25% each).
          </p>
        </CardHeader>
        <CardContent className="px-2 sm:px-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading…
            </div>
          ) : chartData.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground text-sm">
              No demand history for this stock in the selected window.
            </div>
          ) : (
            <div className="h-[280px] sm:h-[360px] w-full">
              <ResponsiveContainer>
                <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                    minTickGap={20}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v: number) =>
                      v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`
                    }
                    width={56}
                  />
                  <Tooltip
                    formatter={(v) => (v == null ? "—" : fmtFt(Number(v)))}
                    labelClassName="font-medium"
                    contentStyle={{
                      background: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {ropLine > 0 && (
                    <ReferenceLine
                      y={ropLine}
                      stroke="#d97706"
                      strokeDasharray="4 4"
                      label={{ value: "ROP", position: "insideTopRight", fontSize: 11, fill: "#d97706" }}
                    />
                  )}
                  <Bar dataKey="history" name="Historical demand" fill="#2563eb" radius={[3, 3, 0, 0]} />
                  <Line
                    type="monotone"
                    dataKey="forecast"
                    name="Forecast"
                    stroke="#16a34a"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Open purchase orders */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Open purchase orders
            {openPos.length > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground font-mono">
                {openPos.length} · {fmtFt(m?.openPoFootage)} on order
              </span>
            )}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Stock-type POs that have not yet been received. Footage is estimated as
            quantity × typical roll size ({fmtFt(m?.typicalRollFootage)}).
          </p>
        </CardHeader>
        <CardContent className="px-2 sm:px-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading…
            </div>
          ) : openPos.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No open purchase orders for this stock.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">PO #</th>
                    <th className="px-3 py-2 text-left font-medium">Placed</th>
                    <th className="px-3 py-2 text-right font-medium">Days open</th>
                    <th className="px-3 py-2 text-right font-medium">Rolls</th>
                    <th className="px-3 py-2 text-right font-medium">Est. footage</th>
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {openPos.map((p) => {
                    const estFt =
                      m && m.typicalRollFootage > 0
                        ? p.quantityRolls * m.typicalRollFootage
                        : null;
                    return (
                      <tr key={p.poNumber} className="border-t border-border hover:bg-muted/30">
                        <td className="px-3 py-2 font-mono">{p.poNumber}</td>
                        <td className="px-3 py-2 font-mono text-muted-foreground">
                          {p.poDateIso ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {p.daysOpen != null ? `${p.daysOpen} d` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{p.quantityRolls}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {estFt != null ? fmtFt(estFt) : "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {p.description ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="border-t-2 border-border bg-muted/30">
                  <tr>
                    <td colSpan={3} className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground">
                      Total
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-medium">
                      {m?.openPoRolls ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-medium">
                      {fmtFt(m?.openPoFootage)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}

function OverrideStatus({
  label,
  effective,
  auto,
  overridden,
}: {
  label: string;
  effective: string;
  auto: string;
  overridden: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span
        className={cn(
          "font-mono",
          overridden && "text-violet-700 dark:text-violet-400 font-semibold",
        )}
      >
        {effective}
      </span>
      {overridden ? (
        <span className="text-muted-foreground/80 font-mono truncate">
          (auto {auto})
        </span>
      ) : (
        <span className="text-muted-foreground/60 truncate">auto</span>
      )}
    </div>
  );
}

function MetricCard({
  label,
  primary,
  secondary,
  tone = "neutral",
  overridden = false,
  overrideLabel = "Override",
}: {
  label: string;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  tone?: "neutral" | "warn" | "danger";
  overridden?: boolean;
  overrideLabel?: string;
}) {
  return (
    <Card
      className={cn(
        overridden &&
          "border-violet-500/40 ring-1 ring-violet-500/20 bg-violet-50/40 dark:bg-violet-950/20",
      )}
    >
      <CardContent className="pt-5 pb-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            {label}
          </div>
          {overridden && (
            <Badge
              variant="outline"
              className="border-violet-500/40 text-violet-700 dark:text-violet-400 text-[10px] px-1.5 py-0 leading-4 font-normal"
              title={overrideLabel}
            >
              override
            </Badge>
          )}
        </div>
        <div
          className={cn(
            "text-2xl font-semibold font-mono mt-1.5",
            tone === "warn" && "text-amber-600",
            tone === "danger" && "text-red-600",
          )}
        >
          {primary ?? "—"}
        </div>
        {secondary && (
          <div className="text-xs text-muted-foreground mt-1">{secondary}</div>
        )}
      </CardContent>
    </Card>
  );
}
