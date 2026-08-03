import * as React from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import {
  useGetDemandSummary,
  getGetDemandSummaryQueryKey,
  useGetGoals,
  getGetGoalsQueryKey,
  useSetGlobalGoal,
  type DemandStockMetrics,
  type GetDemandSummaryParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { MrpGrid } from "./demand-mrp";
import type { MrpRow } from "@workspace/api-client-react";
import { StockConfigPanel } from "./demand-stock-config";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertTriangle,
  TrendingUp,
  Package,
  Clock,
  ChevronRight,
  Loader2,
  PauseCircle,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TicketCompareSection, SuggestedPosTab, EmailTab, DemandConfigTab, VendorContactsTab, MakeAndHoldSection } from "@/pages/demand-purchasing";

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

type SortKey =
  | "name"
  | "onHand"
  | "forecast"
  | "daysOfCover"
  | "reorder"
  | "max"
  | "suggested"
  | "lastUsed"
  | "abc";

type AbcClass = "A" | "B" | "C" | null;

// Pareto / 80-15-5 ABC classification driven by annualized demand footage
// (avgWeeklyDemand × 52). Stocks with no observed demand are classified as
// "C" if they still hold on-hand inventory (slow-mover capital sitting on
// the floor) and stay unclassified only if they have neither demand nor stock.
function computeAbcClasses(rows: DemandStockMetrics[]): Map<string, AbcClass> {
  const out = new Map<string, AbcClass>();
  const ranked = rows
    .map((r) => ({
      stockId: r.stockId,
      annual: Math.max(0, r.avgWeeklyDemand) * 52,
    }))
    .filter((r) => r.annual > 0)
    .sort((a, b) => b.annual - a.annual);
  const total = ranked.reduce((s, r) => s + r.annual, 0);
  if (total > 0) {
    let cum = 0;
    for (const r of ranked) {
      cum += r.annual;
      const pct = cum / total;
      out.set(r.stockId, pct <= 0.8 ? "A" : pct <= 0.95 ? "B" : "C");
    }
  }
  for (const r of rows) {
    if (out.has(r.stockId)) continue;
    out.set(r.stockId, r.onHandFootage > 0 ? "C" : null);
  }
  return out;
}

const ABC_RANK: Record<"A" | "B" | "C", number> = { A: 0, B: 1, C: 2 };

function AbcBadge({ cls }: { cls: AbcClass }) {
  if (!cls) return <span className="text-muted-foreground font-mono text-xs">—</span>;
  const styles: Record<"A" | "B" | "C", string> = {
    A: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-500/5",
    B: "border-sky-500/40 text-sky-700 dark:text-sky-400 bg-sky-500/5",
    C: "border-zinc-400/40 text-zinc-600 dark:text-zinc-400 bg-zinc-500/5",
  };
  const labels: Record<"A" | "B" | "C", string> = {
    A: "Top 80% of demand volume",
    B: "Next 15% of demand volume",
    C: "Bottom 5% of demand volume",
  };
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] px-1.5 py-0 font-mono font-semibold", styles[cls])}
      title={labels[cls]}
    >
      {cls}
    </Badge>
  );
}

type ActivityStatus = "active" | "slowing" | "dormant" | "never";

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

function fmtWeights(w: number[] | null | undefined): string {
  if (!w || w.length < 3) return "—";
  return `${fmtNum(w[0], 2)} / ${fmtNum(w[1], 2)} / ${fmtNum(w[2], 2)}`;
}

function OverrideMarker({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; effective: string; auto: string }>;
}) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center justify-center align-middle ml-1 rounded-sm bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-1 ring-violet-500/40 w-4 h-4 cursor-help"
          aria-label={title}
        >
          <SlidersHorizontal className="w-2.5 h-2.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="bg-popover text-popover-foreground border border-border max-w-xs"
      >
        <div className="text-[11px] font-semibold mb-1">{title}</div>
        <div className="space-y-0.5">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline gap-2 font-mono text-[11px]">
              <span className="text-muted-foreground shrink-0">{r.label}:</span>
              <span className="text-violet-700 dark:text-violet-300 font-semibold">
                {r.effective}
              </span>
              <span className="text-muted-foreground/80">
                (auto {r.auto})
              </span>
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function DemandCvOverride({ r }: { r: DemandStockMetrics }) {
  if (!r.demandCvOverridden) return null;
  return (
    <OverrideMarker
      title="Demand CV override"
      rows={[
        {
          label: "Demand CV",
          effective: fmtNum(r.demandCv, 2),
          auto: fmtNum(r.autoDemandCv, 2),
        },
      ]}
    />
  );
}

function LeadTimeCvOverride({ r }: { r: DemandStockMetrics }) {
  if (!r.leadTimeCvOverridden) return null;
  return (
    <OverrideMarker
      title="Lead-time CV override"
      rows={[
        {
          label: "Lead-time CV",
          effective: fmtNum(r.leadTimeCv, 2),
          auto: fmtNum(r.autoLeadTimeCv, 2),
        },
      ]}
    />
  );
}

function LeadTimeDaysOverride({ r }: { r: DemandStockMetrics }) {
  if (!r.leadTimeDaysOverridden) return null;
  return (
    <OverrideMarker
      title="Lead time override"
      rows={[
        {
          label: "Avg lead time",
          effective: `${fmtNum(r.avgLeadTimeDays, 1)}d`,
          auto: `${fmtNum(r.autoLeadTimeDays, 1)}d`,
        },
      ]}
    />
  );
}

function TypicalRollOverride({ r }: { r: DemandStockMetrics }) {
  if (!r.typicalRollFootageOverridden) return null;
  return (
    <OverrideMarker
      title="Typical roll size override"
      rows={[
        {
          label: "Typical roll",
          effective: `${r.typicalRollFootage.toLocaleString()} ft`,
          auto: `${r.autoTypicalRollFootage.toLocaleString()} ft`,
        },
      ]}
    />
  );
}

function ReorderCvOverride({ r }: { r: DemandStockMetrics }) {
  if (!r.demandCvOverridden && !r.leadTimeCvOverridden && !r.leadTimeDaysOverridden) {
    return null;
  }
  const rows: Array<{ label: string; effective: string; auto: string }> = [];
  if (r.demandCvOverridden) {
    rows.push({
      label: "Demand CV",
      effective: fmtNum(r.demandCv, 2),
      auto: fmtNum(r.autoDemandCv, 2),
    });
  }
  if (r.leadTimeCvOverridden) {
    rows.push({
      label: "Lead-time CV",
      effective: fmtNum(r.leadTimeCv, 2),
      auto: fmtNum(r.autoLeadTimeCv, 2),
    });
  }
  if (r.leadTimeDaysOverridden) {
    rows.push({
      label: "Lead time",
      effective: `${fmtNum(r.avgLeadTimeDays, 1)}d`,
      auto: `${fmtNum(r.autoLeadTimeDays, 1)}d`,
    });
  }
  return <OverrideMarker title="Reorder point uses an override" rows={rows} />;
}

function SeasonalityOverride({ r }: { r: DemandStockMetrics }) {
  if (!r.seasonalityWeightsOverridden) return null;
  return (
    <OverrideMarker
      title="Seasonality override"
      rows={[
        {
          label: "Weights (mo 1/2/3)",
          effective: fmtWeights(r.seasonalityWeights),
          auto: fmtWeights(r.defaultSeasonalityWeights),
        },
      ]}
    />
  );
}

function ActivityBadge({ status, daysSince }: { status: ActivityStatus; daysSince: number | null }) {
  if (status === "active") return null;
  const cfg = {
    slowing: {
      label: "Slowing",
      className:
        "border-amber-500/40 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30",
      title: `Last used ${fmtLastUsed(daysSince)} — review`,
    },
    dormant: {
      label: "Review for inactivation",
      className:
        "border-red-500/40 text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30",
      title: `Last used ${fmtLastUsed(daysSince)} — consider inactivating in Label Traxx`,
    },
    never: {
      label: "No demand in window",
      className:
        "border-red-500/40 text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30",
      title: "No usage observed in the selected history window",
    },
  }[status];
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] px-1.5 py-0", cfg.className)}
      title={cfg.title}
    >
      {cfg.label}
    </Badge>
  );
}

export default function DemandPlanning() {
  const queryClient = useQueryClient();
  const { data: goals } = useGetGoals({
    query: { queryKey: getGetGoalsQueryKey() },
  });
  const savedDefaults = goals?.global;

  const [monthsBack, setMonthsBack] = React.useState<number>(6);
  const [serviceLevel, setServiceLevel] = React.useState<number>(0.95);
  const [demandCv, setDemandCv] = React.useState<string>("");
  const [leadTimeCv, setLeadTimeCv] = React.useState<string>("");
  const [forecastWeeks] = React.useState<number>(12);
  // EOQ economics (fixed ordering cost $/PO, annual carrying rate %). Defaults
  // mirror the server ($150 / 20%). Empty string = use the server default.
  const [orderingCost, setOrderingCost] = React.useState<string>("");
  const [carryingRatePct, setCarryingRatePct] = React.useState<string>("");

  // Hydrate local state from server-saved defaults exactly once when goals
  // first arrive. After that the user owns the values for this session.
  const hydratedRef = React.useRef(false);
  React.useEffect(() => {
    if (hydratedRef.current || !savedDefaults) return;
    if (savedDefaults.monthsBack != null) setMonthsBack(savedDefaults.monthsBack);
    if (savedDefaults.serviceLevel != null) setServiceLevel(savedDefaults.serviceLevel);
    if (savedDefaults.demandCv != null) setDemandCv(String(savedDefaults.demandCv));
    if (savedDefaults.leadTimeCv != null) setLeadTimeCv(String(savedDefaults.leadTimeCv));
    if (savedDefaults.orderingCost != null) setOrderingCost(String(savedDefaults.orderingCost));
    if (savedDefaults.carryingRatePct != null) setCarryingRatePct(String(savedDefaults.carryingRatePct));
    hydratedRef.current = true;
  }, [savedDefaults]);

  const setGlobalGoal = useSetGlobalGoal();
  const persistDefaults = React.useCallback(
    (patch: {
      monthsBack?: number | null;
      serviceLevel?: number | null;
      demandCv?: number | null;
      leadTimeCv?: number | null;
      orderingCost?: number | null;
      carryingRatePct?: number | null;
    }) => {
      setGlobalGoal.mutate(
        {
          // Preserve the existing budget band — we only edit demand defaults here.
          data: {
            min: savedDefaults?.min ?? null,
            max: savedDefaults?.max ?? null,
            ...patch,
          },
        },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetGoalsQueryKey() });
          },
        },
      );
    },
    [setGlobalGoal, savedDefaults, queryClient],
  );

  const parseCv = (s: string): number | null => {
    if (s.trim() === "") return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const [filter, setFilter] = React.useState<string>("");
  // The stock x width row whose driving configuration is open for editing.
  const [configRow, setConfigRow] = React.useState<MrpRow | null>(null);
  const [sortKey, setSortKey] = React.useState<SortKey>("forecast");
  const [showOnly, setShowOnly] = React.useState<
    "all" | "belowMin" | "review" | "dormant" | "activeOnHand" | "anyOnHand"
  >("all");
  // `?tab=` lets an external redirect land on the right place — the Gmail OAuth
  // callback comes back to ?tab=email, which now resolves to Setup › Email.
  const requestedTab = new URLSearchParams(window.location.search).get("tab");
  const SETUP_TABS = ["email", "vendors", "config"] as const;
  const [tab, setTab] = React.useState<"demand" | "pos" | "setup">(() =>
    requestedTab === "pos"
      ? "pos"
      : requestedTab === "setup" || (SETUP_TABS as readonly string[]).includes(requestedTab ?? "")
      ? "setup"
      : "demand",
  );
  const [setupTab, setSetupTab] = React.useState<(typeof SETUP_TABS)[number]>(() =>
    (SETUP_TABS as readonly string[]).includes(requestedTab ?? "")
      ? (requestedTab as (typeof SETUP_TABS)[number])
      : "config",
  );

  const params: GetDemandSummaryParams = {
    monthsBack,
    serviceLevel,
    forecastWeeks,
  };
  if (demandCv && Number.isFinite(Number(demandCv))) params.demandCv = Number(demandCv);
  if (leadTimeCv && Number.isFinite(Number(leadTimeCv))) params.leadTimeCv = Number(leadTimeCv);
  if (orderingCost && Number.isFinite(Number(orderingCost))) params.orderingCost = Number(orderingCost);
  if (carryingRatePct && Number.isFinite(Number(carryingRatePct))) params.carryingRatePct = Number(carryingRatePct);

  const { data, isLoading, isFetching } = useGetDemandSummary(params, {
    query: { queryKey: getGetDemandSummaryQueryKey(params), staleTime: 60_000 },
  });

  const rows: DemandStockMetrics[] = data?.items ?? [];

  // ABC class is computed once over the full unfiltered set so the labels
  // stay stable when the user changes the Show filter.
  const abcByStock = React.useMemo(() => computeAbcClasses(rows), [rows]);

  const filtered = React.useMemo(() => {
    let out = rows;
    if (showOnly === "belowMin") out = out.filter((r) => r.belowMin);
    else if (showOnly === "review")
      out = out.filter((r) => r.activityStatus === "slowing" || r.activityStatus === "dormant" || r.activityStatus === "never");
    else if (showOnly === "dormant")
      out = out.filter((r) => r.activityStatus === "dormant" || r.activityStatus === "never");
    else if (showOnly === "activeOnHand")
      out = out.filter((r) => r.activityStatus === "active" && r.onHandFootage > 0);
    else if (showOnly === "anyOnHand")
      out = out.filter((r) => r.onHandFootage > 0);
    const q = filter.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (r) =>
          r.stockId.toLowerCase().includes(q) ||
          (r.description ?? "").toLowerCase().includes(q),
      );
    }
    const sorted = [...out].sort((a, b) => {
      // Always pin items below their reorder point to the top of the list
      // (regardless of the user-selected sort key) so action items lead.
      if (a.belowMin !== b.belowMin) return a.belowMin ? -1 : 1;
      switch (sortKey) {
        case "name":
          return a.stockId.localeCompare(b.stockId, undefined, { numeric: true });
        case "onHand":
          return b.onHandFootage - a.onHandFootage;
        case "daysOfCover": {
          const av = a.daysOfCover < 0 ? Infinity : a.daysOfCover;
          const bv = b.daysOfCover < 0 ? Infinity : b.daysOfCover;
          return av - bv;
        }
        case "reorder":
          return b.reorderPointFootage - a.reorderPointFootage;
        case "max":
          return b.maxFootage - a.maxFootage;
        case "suggested":
          return b.suggestedOrderFootage - a.suggestedOrderFootage;
        case "lastUsed": {
          const av = a.daysSinceLastUse ?? Number.MAX_SAFE_INTEGER;
          const bv = b.daysSinceLastUse ?? Number.MAX_SAFE_INTEGER;
          return bv - av;
        }
        case "abc": {
          // A → B → C → unclassified, then by annual demand desc within each
          const ac = abcByStock.get(a.stockId);
          const bc = abcByStock.get(b.stockId);
          const ar = ac ? ABC_RANK[ac] : 3;
          const br = bc ? ABC_RANK[bc] : 3;
          if (ar !== br) return ar - br;
          return b.avgWeeklyDemand - a.avgWeeklyDemand;
        }
        case "forecast":
        default:
          return b.forecast12wkFootage - a.forecast12wkFootage;
      }
    });
    return sorted;
  }, [rows, filter, sortKey, showOnly, abcByStock]);

  const belowCount = rows.filter((r) => r.belowMin).length;
  const reviewCount = rows.filter(
    (r) => r.activityStatus === "slowing" || r.activityStatus === "dormant" || r.activityStatus === "never",
  ).length;
  const dormantCount = rows.filter(
    (r) => r.activityStatus === "dormant" || r.activityStatus === "never",
  ).length;
  const totalForecast = rows.reduce((s, r) => s + r.forecast12wkFootage, 0);
  const totalOnHand = rows.reduce((s, r) => s + r.onHandFootage, 0);

  return (
    <Layout>
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2 sm:gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Demand Planning</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Active stocks · {rows.length} items · {monthsBack}-month history → {forecastWeeks}-week forecast
          </p>
        </div>
        {data && (
          <div className="text-xs text-muted-foreground font-mono">
            Window: {data.windowFrom} → {data.windowTo}
            {isFetching && (
              <Loader2 className="w-3.5 h-3.5 animate-spin ml-2 inline-block align-text-bottom" />
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-b -mb-2">
        {(
          [
            ["demand", "Demand"],
            ["pos", "Material Control Tower"],
            ["setup", "Setup"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              // focus-visible ring instead of the browser's default focus
              // rectangle, which lingered around the tab after every click.
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring rounded-t-sm",
              tab === key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "pos" && <SuggestedPosTab rows={rows} />}

      {tab === "setup" && (
        <div className="space-y-4">
          {/* Sub-tabs, styled as a segmented control so they read as a level
              below the page tabs rather than competing with them. */}
          <div className="inline-flex rounded-md border p-0.5 bg-muted/40">
            {(
              [
                ["email", "Email"],
                ["vendors", "Vendor PO Contacts"],
                ["config", "Configuration"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSetupTab(key)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-[5px] transition-colors outline-none",
                  "focus-visible:ring-2 focus-visible:ring-ring",
                  setupTab === key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {setupTab === "email" && <EmailTab />}
          {setupTab === "vendors" && <VendorContactsTab />}
          {setupTab === "config" && <DemandConfigTab rows={rows} />}
        </div>
      )}

      {tab === "demand" && (
        <>
          <TicketCompareSection rows={rows} />

          <MakeAndHoldSection rows={rows} />

      {/* KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Items Below ROP
            </CardTitle>
            <AlertTriangle className="h-4 w-4 text-amber-600" />
          </CardHeader>
          <CardContent>
            <div className={cn("text-3xl font-bold font-mono", belowCount > 0 && "text-amber-600")}>
              {belowCount}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              of {rows.length} active stock numbers
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Needs Review
            </CardTitle>
            <PauseCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div
              className={cn(
                "text-3xl font-bold font-mono",
                dormantCount > 0 ? "text-red-600" : reviewCount > 0 ? "text-amber-600" : undefined,
              )}
            >
              {reviewCount}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {dormantCount > 0
                ? `${dormantCount} dormant · ${reviewCount - dormantCount} slowing`
                : "no recent demand · review or inactivate"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              On-Hand Footage
            </CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">{fmtFt(totalOnHand)}</div>
            <p className="text-xs text-muted-foreground mt-1">across all active stocks</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              12-wk Forecast Demand
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">{fmtFt(totalForecast)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              quarterly seasonality (50/25/25)
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Service Level
            </CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">
              {(serviceLevel * 100).toFixed(0)}%
            </div>
            <Slider
              value={[serviceLevel * 100]}
              min={50}
              max={99.5}
              step={0.5}
              onValueChange={(v) => setServiceLevel((v[0] ?? 95) / 100)}
              onValueCommit={(v) =>
                persistDefaults({ serviceLevel: (v[0] ?? 95) / 100 })
              }
              className="mt-3"
            />
          </CardContent>
        </Card>
      </div>

      {/* Filter strip */}
      <Card>
        <CardContent className="pt-6 pb-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 sm:gap-4 items-end">
            <div className="sm:col-span-2 lg:col-span-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Search
              </label>
              <Input
                placeholder="Stock # or description"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                History
              </label>
              <Select
                value={String(monthsBack)}
                onValueChange={(v) => {
                  const n = Number(v);
                  setMonthsBack(n);
                  persistDefaults({ monthsBack: n });
                }}
              >
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
                Demand CV (override)
              </label>
              <Input
                placeholder="auto"
                value={demandCv}
                onChange={(e) => setDemandCv(e.target.value)}
                onBlur={() => persistDefaults({ demandCv: parseCv(demandCv) })}
                className="mt-1.5"
                inputMode="decimal"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Lead Time CV (override)
              </label>
              <Input
                placeholder="auto"
                value={leadTimeCv}
                onChange={(e) => setLeadTimeCv(e.target.value)}
                onBlur={() => persistDefaults({ leadTimeCv: parseCv(leadTimeCv) })}
                className="mt-1.5"
                inputMode="decimal"
              />
            </div>
            <div>
              <label
                className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
                title="Fixed cost to place one PO (admin + freight setup). Drives the economic order quantity."
              >
                Ordering Cost ($/PO)
              </label>
              <Input
                placeholder="150"
                value={orderingCost}
                onChange={(e) => setOrderingCost(e.target.value)}
                onBlur={() => persistDefaults({ orderingCost: parseCv(orderingCost) })}
                className="mt-1.5"
                inputMode="decimal"
              />
            </div>
            <div>
              <label
                className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
                title="Annual inventory carrying rate as a fraction (0.20 = 20%/yr). Drives the economic order quantity."
              >
                Carrying Rate (/yr)
              </label>
              <Input
                placeholder="0.20"
                value={carryingRatePct}
                onChange={(e) => setCarryingRatePct(e.target.value)}
                onBlur={() => persistDefaults({ carryingRatePct: parseCv(carryingRatePct) })}
                className="mt-1.5"
                inputMode="decimal"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Show
              </label>
              <Select
                value={showOnly}
                onValueChange={(v) => setShowOnly(v as typeof showOnly)}
              >
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All active stocks</SelectItem>
                  <SelectItem value="activeOnHand">Active with on-hand inventory</SelectItem>
                  <SelectItem value="anyOnHand">All with on-hand inventory</SelectItem>
                  <SelectItem value="belowMin">Below reorder point</SelectItem>
                  <SelectItem value="review">Needs review (slowing or dormant)</SelectItem>
                  <SelectItem value="dormant">Dormant only (consider inactivating)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Time-phased plan, per stock AND width. Replaces the old
          Stock-by-stock table, whose reorder point and max came from pooled
          consumption and so could not describe a stock whose widths differ. */}
      <MrpGrid onConfigure={setConfigRow} />
      {configRow && <StockConfigPanel row={configRow} onClose={() => setConfigRow(null)} />}
        </>
      )}
    </Layout>
  );
}

function Th({
  children,
  onClick,
  active,
  align = "right",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  align?: "left" | "right";
}) {
  return (
    <th
      onClick={onClick}
      className={cn(
        "px-3 py-2 font-medium",
        align === "right" ? "text-right" : "text-left",
        onClick && "cursor-pointer hover:text-foreground select-none",
        active && "text-primary",
      )}
    >
      {children}
    </th>
  );
}
