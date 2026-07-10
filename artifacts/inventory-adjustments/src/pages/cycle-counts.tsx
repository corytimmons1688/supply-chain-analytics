import * as React from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ChevronRight, RefreshCw, Calendar, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  useGetCycleCountSchedule,
  getGetCycleCountScheduleQueryKey,
  getGetCycleCountKpiQueryKey,
  useMarkCycleCountComplete,
  useUnmarkCycleCountComplete,
  useRegenerateCycleCountSchedule,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import type { CycleCountScheduleResponse } from "@workspace/api-client-react";

type AbcClass = "A" | "B" | "C";

function fmtDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso + "T00:00:00") : iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const ABC_STYLES: Record<AbcClass, string> = {
  A: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-500/5",
  B: "border-sky-500/40 text-sky-700 dark:text-sky-400 bg-sky-500/5",
  C: "border-zinc-400/40 text-zinc-600 dark:text-zinc-400 bg-zinc-500/5",
};

function AbcBadge({ cls }: { cls: AbcClass }) {
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] px-1.5 py-0 font-mono font-semibold", ABC_STYLES[cls])}
    >
      {cls}
    </Badge>
  );
}

export default function CycleCounts() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const queryKey = getGetCycleCountScheduleQueryKey();
  const kpiQueryKey = getGetCycleCountKpiQueryKey();
  const { data, isLoading } = useGetCycleCountSchedule({ query: { queryKey, staleTime: 30_000 } });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: kpiQueryKey });
  };

  const markMutation = useMarkCycleCountComplete({
    mutation: { onSuccess: invalidate },
  });
  const unmarkMutation = useUnmarkCycleCountComplete({
    mutation: { onSuccess: invalidate },
  });
  const regenMutation = useRegenerateCycleCountSchedule({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Schedule regenerated", description: "ABC classes re-evaluated for the active quarter." });
      },
    },
  });

  const handleToggle = (stockId: string, week: number, currentlyComplete: boolean) => {
    if (!data) return;
    const body = { stockId, quarter: data.quarter, week };
    if (currentlyComplete) unmarkMutation.mutate({ data: body });
    else markMutation.mutate({ data: body });
  };

  // Default-expand the current in-progress week (if any).
  const defaultOpen = data ? `week-${Math.max(1, data.kpi.currentWeek)}` : undefined;

  return (
    <Layout>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Cycle Count Schedule</h1>
          <p className="text-sm text-muted-foreground mt-1">
            ABC-driven counts &middot; A weekly &middot; B monthly &middot; C quarterly &middot; rotates each financial quarter
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => regenMutation.mutate()}
          disabled={regenMutation.isPending}
        >
          <RefreshCw className={cn("w-4 h-4 mr-2", regenMutation.isPending && "animate-spin")} />
          Regenerate
        </Button>
      </div>

      {isLoading || !data ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <>
          <KpiBanner data={data} />
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                {data.quarter} &middot; {fmtDate(data.startDate)} &ndash; {fmtDate(data.endDate)}
                {data.consolidated && (
                  <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-400">
                    Consolidated
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion type="multiple" defaultValue={defaultOpen ? [defaultOpen] : []}>
                {data.weeks.map((wk) => {
                  const isCurrent = wk.week === data.kpi.currentWeek;
                  const isPast = wk.week < data.kpi.currentWeek;
                  const fullyDone = wk.completed >= wk.expected && wk.expected > 0;
                  return (
                    <AccordionItem key={wk.week} value={`week-${wk.week}`}>
                      <AccordionTrigger className="hover:no-underline">
                        <div className="flex items-center gap-3 flex-1">
                          <div className="flex items-center gap-2 w-44">
                            <span className="font-semibold">Week {wk.week}</span>
                            {isCurrent && (
                              <Badge variant="outline" className="text-[10px] border-blue-500/40 text-blue-700 dark:text-blue-400">
                                Current
                              </Badge>
                            )}
                            {isPast && fullyDone && (
                              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                            )}
                            {isPast && !fullyDone && wk.expected > 0 && (
                              <AlertCircle className="w-4 h-4 text-amber-600" />
                            )}
                          </div>
                          <span className="text-sm text-muted-foreground font-mono w-40 text-left">
                            {fmtDate(wk.weekStart)} &ndash; {fmtDate(wk.weekEnd)}
                          </span>
                          <span className="text-sm text-muted-foreground ml-auto pr-2">
                            {wk.completed} / {wk.expected} counted
                          </span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        {wk.tasks.length === 0 ? (
                          <p className="text-sm text-muted-foreground py-2">No counts scheduled this week.</p>
                        ) : (
                          <div className="space-y-1">
                            {wk.tasks.map((t) => {
                              const done = t.completedAt != null;
                              return (
                                <label
                                  key={t.stockId}
                                  className={cn(
                                    "flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer transition-colors",
                                    done ? "bg-emerald-500/5" : "hover:bg-muted/40",
                                  )}
                                >
                                  <Checkbox
                                    checked={done}
                                    onCheckedChange={() => handleToggle(t.stockId, wk.week, done)}
                                  />
                                  <AbcBadge cls={t.abcClass} />
                                  <span className={cn("font-medium", done && "line-through text-muted-foreground")}>
                                    #{t.stockId}
                                  </span>
                                  <span className={cn("text-sm text-muted-foreground line-clamp-1 flex-1", done && "line-through")}>
                                    {t.description ?? "—"}
                                  </span>
                                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                                    {t.onHandFootage.toLocaleString()} ft on-hand
                                  </span>
                                  {done && (
                                    <span className="text-[11px] text-muted-foreground font-mono">
                                      {new Date(t.completedAt as unknown as string).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                                    </span>
                                  )}
                                  <a
                                    href={`/stock/${t.stockId}`}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setLocation(`/stock/${t.stockId}`);
                                    }}
                                    className="p-1 rounded hover:bg-muted text-muted-foreground/60 hover:text-foreground"
                                    aria-label={`View stock ${t.stockId} details`}
                                    data-testid={`view-stock-${t.stockId}`}
                                  >
                                    <ChevronRight className="w-3.5 h-3.5" />
                                  </a>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </CardContent>
          </Card>
        </>
      )}
    </Layout>
  );
}

function KpiBanner({ data }: { data: CycleCountScheduleResponse }) {
  const { kpi } = data;
  const pct = kpi.totalExpectedThisQuarter > 0
    ? Math.round((kpi.totalCompletedThisQuarter / kpi.totalExpectedThisQuarter) * 100)
    : 0;

  const statusConfig = {
    on_track: {
      label: "On track",
      icon: CheckCircle2,
      cls: "border-l-emerald-500 text-emerald-700 dark:text-emerald-400",
      iconCls: "text-emerald-600",
    },
    behind: {
      label: "Behind schedule",
      icon: AlertCircle,
      cls: "border-l-amber-500 text-amber-700 dark:text-amber-400",
      iconCls: "text-amber-600",
    },
    not_started: {
      label: "Not started",
      icon: Clock,
      cls: "border-l-muted text-muted-foreground",
      iconCls: "text-muted-foreground",
    },
  } as const;
  const cfg = statusConfig[kpi.status];
  const Icon = cfg.icon;

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
      <Card className={cn("border-l-4", cfg.cls)}>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Status
          </CardTitle>
          <Icon className={cn("h-4 w-4", cfg.iconCls)} />
        </CardHeader>
        <CardContent>
          <div className={cn("text-2xl font-bold", cfg.cls)}>{cfg.label}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {kpi.status === "behind"
              ? `${kpi.deficit} count${kpi.deficit === 1 ? "" : "s"} behind through week ${Math.max(0, kpi.currentWeek - 1)}`
              : kpi.status === "on_track"
              ? `Cumulative completion keeps pace with the plan`
              : `Quarter starts soon`}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Current week</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold font-mono">
            {kpi.currentWeek === 0 ? "—" : `${kpi.currentWeek}/${kpi.totalWeeks}`}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {kpi.totalWeeks - Math.max(0, kpi.currentWeek)} weeks remaining
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Quarter progress</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold font-mono">
            {kpi.totalCompletedThisQuarter}
            <span className="text-base text-muted-foreground"> / {kpi.totalExpectedThisQuarter}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {pct}% of planned counts completed
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Through last week</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold font-mono">
            {kpi.completedThroughLastCompletedWeek}
            <span className="text-base text-muted-foreground"> / {kpi.expectedThroughLastCompletedWeek}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Cumulative target vs. actual through prior week
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
