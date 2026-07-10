import * as React from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, AlertCircle, Clock, ListChecks, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGetCycleCountKpi, getGetCycleCountKpiQueryKey } from "@workspace/api-client-react";

const STATUS_COPY = {
  on_track: { label: "On track", icon: CheckCircle2, cls: "text-emerald-700 dark:text-emerald-400", border: "border-l-emerald-500", iconCls: "text-emerald-600" },
  behind: { label: "Behind schedule", icon: AlertCircle, cls: "text-amber-700 dark:text-amber-400", border: "border-l-amber-500", iconCls: "text-amber-600" },
  not_started: { label: "Not started", icon: Clock, cls: "text-muted-foreground", border: "border-l-muted", iconCls: "text-muted-foreground" },
} as const;

export function CycleCountKpi() {
  const { data, isLoading } = useGetCycleCountKpi({
    query: { queryKey: getGetCycleCountKpiQueryKey(), staleTime: 60_000 },
  });

  if (isLoading || !data) {
    return <Skeleton className="h-[120px]" />;
  }

  const cfg = STATUS_COPY[data.status];
  const Icon = cfg.icon;
  const subtitle =
    data.status === "behind"
      ? `${data.deficit} count${data.deficit === 1 ? "" : "s"} behind through week ${Math.max(0, data.currentWeek - 1)}`
      : data.status === "on_track"
      ? `${data.totalCompletedThisQuarter} of ${data.totalExpectedThisQuarter} planned counts completed`
      : `Quarter starts soon`;

  return (
    <Link href="/cycle-counts">
      <Card className={cn("border-l-4 cursor-pointer hover:bg-muted/30 transition-colors", cfg.border)}>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <ListChecks className="h-4 w-4" />
            Cycle Count Schedule
          </CardTitle>
          <Icon className={cn("h-4 w-4", cfg.iconCls)} />
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline justify-between gap-2">
            <div className={cn("text-2xl font-bold", cfg.cls)}>{cfg.label}</div>
            <div className="text-xs font-mono text-muted-foreground">
              {data.quarter} &middot; wk {data.currentWeek}/{data.totalWeeks}
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
            <span>{subtitle}</span>
            <ArrowRight className="h-3 w-3 ml-auto" />
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
