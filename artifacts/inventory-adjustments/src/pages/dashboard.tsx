import * as React from "react";
import { Layout } from "@/components/layout";
import { KPICards } from "@/components/kpi-cards";
import { CycleCountKpi } from "@/components/cycle-count-kpi";
import { DatePickerWithRange } from "@/components/date-range-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format } from "date-fns";

function defaultFrom(): Date {
  // Overview anchors at 5/1 of the current cycle. If we're before May 1 of
  // this year, fall back to last year's May 1 so the window is never empty.
  const now = new Date();
  const may1ThisYear = new Date(now.getFullYear(), 4, 1);
  return now >= may1ThisYear ? may1ThisYear : new Date(now.getFullYear() - 1, 4, 1);
}

function defaultTo(): Date {
  const now = new Date();
  const d = new Date(now);
  d.setDate(d.getDate() + 30);
  return d;
}

function currentMountainWeek(now: Date = new Date()): { weekStart: string; weekEnding: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const lookup: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) lookup[p.type] = p.value;
  const y = Number(lookup["year"]);
  const m = Number(lookup["month"]);
  const d = Number(lookup["day"]);
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[lookup["weekday"] ?? ""] ?? 0;
  const offsetToMonday = (dow + 6) % 7;
  const base = new Date(Date.UTC(y, m - 1, d));
  const start = new Date(base);
  start.setUTCDate(base.getUTCDate() - offsetToMonday);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const fmtIso = (dd: Date) =>
    `${dd.getUTCFullYear()}-${String(dd.getUTCMonth() + 1).padStart(2, "0")}-${String(dd.getUTCDate()).padStart(2, "0")}`;
  return { weekStart: fmtIso(start), weekEnding: fmtIso(end) };
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
import {
  useGetAdjustmentsTimeseries,
  getGetAdjustmentsTimeseriesQueryKey,
  useGetAdjustmentsTotals,
  getGetAdjustmentsTotalsQueryKey,
  useGetAdjustmentsByStock,
  getGetAdjustmentsByStockQueryKey,
  useGetGoals,
  getGetGoalsQueryKey,
  useGetOnHandInventory,
  getGetOnHandInventoryQueryKey,
} from "@workspace/api-client-react";
import {
  CartesianGrid,
  Bar,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency } from "@/lib/format";
import { Link } from "wouter";
import { ArrowRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useGetAdjustmentsDetails,
  getGetAdjustmentsDetailsQueryKey,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type Bucket = "day" | "week" | "month" | "quarter" | "year";
const BUCKETS: readonly Bucket[] = ["day", "week", "month", "quarter", "year"];

interface ChartClickEvent {
  activePayload?: Array<{
    payload?: { periodStart: string; periodEnd: string; label: string };
  }>;
}

export default function Dashboard() {
  const [date, setDate] = React.useState<{ from: Date; to: Date | undefined }>({
    from: defaultFrom(),
    to: defaultTo(),
  });
  const [bucket, setBucket] = React.useState<Bucket>("week");

  const fromStr = format(date.from, "yyyy-MM-dd");
  const toStr = date.to ? format(date.to, "yyyy-MM-dd") : fromStr;

  const { data: totals, isLoading: totalsLoading } = useGetAdjustmentsTotals(
    { from: fromStr, to: toStr },
    { query: { queryKey: getGetAdjustmentsTotalsQueryKey({ from: fromStr, to: toStr }) } }
  );

  const { data: timeseries, isLoading: tsLoading } = useGetAdjustmentsTimeseries(
    { bucket, from: fromStr, to: toStr },
    { query: { queryKey: getGetAdjustmentsTimeseriesQueryKey({ bucket, from: fromStr, to: toStr }) } }
  );

  const { data: stockBreakdown, isLoading: breakdownLoading } = useGetAdjustmentsByStock(
    { from: fromStr, to: toStr },
    { query: { queryKey: getGetAdjustmentsByStockQueryKey({ from: fromStr, to: toStr }) } }
  );

  const { data: goals, isLoading: goalsLoading } = useGetGoals(
    { query: { queryKey: getGetGoalsQueryKey() } }
  );

  const { data: onHand, isLoading: onHandLoading } = useGetOnHandInventory(
    { query: { queryKey: getGetOnHandInventoryQueryKey() } }
  );

  const [drillDown, setDrillDown] = React.useState<{ from: string; to: string; label: string } | null>(null);

  const { data: drillDetails, isLoading: drillLoading } = useGetAdjustmentsDetails(
    drillDown ? { from: drillDown.from, to: drillDown.to, limit: 500 } : { from: fromStr, to: toStr, limit: 1 },
    {
      query: {
        queryKey: drillDown
          ? getGetAdjustmentsDetailsQueryKey({ from: drillDown.from, to: drillDown.to, limit: 500 })
          : getGetAdjustmentsDetailsQueryKey({ from: fromStr, to: toStr, limit: 1 }),
        enabled: !!drillDown,
      },
    },
  );

  const handleChartClick = (e: ChartClickEvent) => {
    const point = e?.activePayload?.[0]?.payload;
    if (!point) return;
    setDrillDown({ from: point.periodStart, to: point.periodEnd, label: point.label });
  };

  const chartData = React.useMemo(() => {
    if (!timeseries) return [];
    let points = timeseries.points.map((p) => ({ ...p }));

    if (bucket === "week") {
      const cur = currentMountainWeek();
      const prevEnding = addDaysIso(cur.weekEnding, -7);
      const prevStart = addDaysIso(cur.weekStart, -7);
      const curIdx = points.findIndex((p) => p.periodEnd === cur.weekEnding);
      const prevIdx = points.findIndex((p) => p.periodEnd === prevEnding);
      if (curIdx !== -1 && prevIdx !== -1) {
        const curP = points[curIdx]!;
        const prevP = points[prevIdx]!;
        const added = Math.round((curP.added + prevP.added) * 100) / 100;
        const removed = Math.round((curP.removed + prevP.removed) * 100) / 100;
        const merged = {
          ...curP,
          periodStart: prevStart,
          periodEnd: cur.weekEnding,
          label: `Wk of ${prevStart}`,
          added,
          removed,
          net: Math.round((added - removed) * 100) / 100,
          addedCount: curP.addedCount + prevP.addedCount,
          removedCount: curP.removedCount + prevP.removedCount,
        };
        const dropEndings = new Set([cur.weekEnding, prevEnding]);
        const insertAt = Math.min(curIdx, prevIdx);
        const filtered = points.filter((p) => !dropEndings.has(p.periodEnd));
        filtered.splice(insertAt, 0, merged);
        points = filtered;
      }
    }

    return points.map((p) => ({
      ...p,
      goalMin: goals?.global?.min ?? -6000,
      goalMax: goals?.global?.max ?? 6000,
    }));
  }, [timeseries, goals, bucket]);

  return (
    <Layout>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Overview</h1>
          <p className="text-muted-foreground text-sm">Monitor global cycle-count adjustments.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={bucket} onValueChange={(val) => {
            if (BUCKETS.includes(val as Bucket)) setBucket(val as Bucket);
          }}>
            <SelectTrigger className="w-[120px] bg-card">
              <SelectValue placeholder="Bucket" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Daily</SelectItem>
              <SelectItem value="week">Weekly</SelectItem>
              <SelectItem value="month">Monthly</SelectItem>
              <SelectItem value="quarter">Quarterly</SelectItem>
              <SelectItem value="year">Yearly</SelectItem>
            </SelectContent>
          </Select>
          <DatePickerWithRange
            date={{ from: date.from, to: date.to }}
            setDate={(d) => {
              if (d?.from) setDate({ from: d.from, to: d.to });
            }}
          />
        </div>
      </div>

      <KPICards totals={totals} onHand={onHand} isLoading={totalsLoading} onHandLoading={onHandLoading} />

      <div className="mt-4">
        <CycleCountKpi />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Net Adjustment Trends</CardTitle>
            <p className="text-xs text-muted-foreground">Click a point to see the rolls counted in that period.</p>
          </CardHeader>
          <CardContent>
            {tsLoading || goalsLoading ? (
              <div className="h-[300px] w-full flex items-center justify-center">
                <Skeleton className="h-full w-full" />
              </div>
            ) : chartData.length > 0 ? (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={chartData}
                    margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
                    onClick={handleChartClick}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tickFormatter={(val) => formatCurrency(val)}
                      tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                      tickLine={false}
                      axisLine={false}
                      domain={[
                        (dataMin: number) => Math.min(-6000, Math.floor(dataMin)),
                        (dataMax: number) => Math.max(6000, Math.ceil(dataMax)),
                      ]}
                    />
                    <Tooltip
                      formatter={(value: number) => formatCurrency(value)}
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
                    />
                    <ReferenceArea
                      y1={goals?.global?.min ?? -6000}
                      y2={goals?.global?.max ?? 6000}
                      fill="hsl(var(--primary))"
                      fillOpacity={0.1}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line
                      type="monotone"
                      dataKey="net"
                      name="Net"
                      stroke="hsl(var(--chart-2))"
                      strokeWidth={2}
                      dot={(props: { cx?: number; cy?: number; index?: number; payload?: { net: number; goalMin?: number; goalMax?: number } }) => {
                        const { cx, cy, payload, index } = props;
                        const key = `dot-${index ?? 0}`;
                        if (cx == null || cy == null || !payload) return <g key={key} />;
                        const outOfBand =
                          (payload.goalMin != null && payload.net < payload.goalMin) ||
                          (payload.goalMax != null && payload.net > payload.goalMax);
                        return (
                          <circle
                            key={key}
                            cx={cx}
                            cy={cy}
                            r={outOfBand ? 6 : 4}
                            fill={outOfBand ? "hsl(0 72% 51%)" : "hsl(var(--chart-2))"}
                            stroke={outOfBand ? "hsl(0 72% 51%)" : "hsl(var(--chart-2))"}
                            strokeWidth={outOfBand ? 2 : 1}
                            style={{ cursor: 'pointer' }}
                          />
                        );
                      }}
                      activeDot={{ r: 7, style: { cursor: 'pointer' } }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[300px] w-full flex items-center justify-center text-muted-foreground">
                No data for this window.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-1 flex flex-col">
          <CardHeader>
            <CardTitle>Top Variances by Stock</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 p-0 overflow-hidden">
            {breakdownLoading ? (
              <div className="p-6 space-y-4">
                {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : stockBreakdown?.items?.length ? (
              <div className="overflow-auto max-h-[300px]">
                <Table>
                  <TableHeader className="bg-muted/50 sticky top-0 z-10">
                    <TableRow>
                      <TableHead>Stock ID</TableHead>
                      <TableHead className="text-right">Net $</TableHead>
                      <TableHead className="text-right" title="Net adjustment as % of current on-hand value">% of On-Hand</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...stockBreakdown.items].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).map((item) => {
                      const pct = item.pctOfOnHand;
                      const pctColor =
                        pct == null ? "text-muted-foreground" :
                        pct < 0 ? "text-red-600 dark:text-red-500" :
                        pct > 0 ? "text-green-600 dark:text-green-500" : "";
                      return (
                        <TableRow key={item.stockId} className="group">
                          <TableCell className="font-mono text-sm">{item.stockId}</TableCell>
                          <TableCell className={`text-right font-mono text-sm ${item.net < 0 ? 'text-red-600 dark:text-red-500' : item.net > 0 ? 'text-green-600 dark:text-green-500' : ''}`}>
                            {formatCurrency(item.net)}
                          </TableCell>
                          <TableCell
                            className={`text-right font-mono text-sm tabular-nums ${pctColor}`}
                            title={item.onHandValue > 0 ? `On-hand value: ${formatCurrency(item.onHandValue)}` : "No on-hand inventory"}
                          >
                            {pct == null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`}
                          </TableCell>
                          <TableCell>
                            <Link href={`/stock/${item.stockId}`} className="text-muted-foreground hover:text-primary transition-colors inline-block p-1">
                              <ArrowRight className="h-4 w-4" />
                            </Link>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="h-full w-full flex items-center justify-center p-6 text-muted-foreground text-sm">
                No stock adjustments in window.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {drillDown && (
        <Card className="mt-6">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Rolls in {drillDown.label}</CardTitle>
              <p className="text-xs text-muted-foreground">
                {drillDown.from} to {drillDown.to} &middot; {drillDetails?.items?.length ?? 0} roll
                {(drillDetails?.items?.length ?? 0) === 1 ? '' : 's'}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setDrillDown(null)}>
              <X className="h-4 w-4 mr-1" /> Close
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {drillLoading ? (
              <div className="p-6 space-y-3">
                {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : drillDetails?.items?.length ? (
              <div className="overflow-auto max-h-[420px]">
                <Table>
                  <TableHeader className="bg-muted/50 sticky top-0 z-10">
                    <TableRow>
                      <TableHead>Roll Tag</TableHead>
                      <TableHead>Stock</TableHead>
                      <TableHead>CC Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {drillDetails.items.map((item) => (
                      <TableRow key={item.id} className="text-xs">
                        <TableCell className="font-mono font-semibold">{item.rollTag}</TableCell>
                        <TableCell>
                          <Link href={`/stock/${item.stockId}`} className="font-mono text-primary hover:underline">
                            {item.stockId}
                          </Link>
                        </TableCell>
                        <TableCell className="font-mono">{item.ccDate}</TableCell>
                        <TableCell>
                          <span className={cn(
                            "px-2 py-0.5 rounded-full uppercase text-[10px] font-bold",
                            item.direction === "added" ? "bg-green-500/10 text-green-600 dark:text-green-500" : "bg-red-500/10 text-red-600 dark:text-red-500"
                          )}>
                            {item.direction}
                          </span>
                        </TableCell>
                        <TableCell className="max-w-[260px] truncate" title={item.description ?? ''}>
                          {item.description ?? '\u2014'}
                        </TableCell>
                        <TableCell className={cn(
                          "text-right font-mono font-semibold",
                          item.direction === "added" ? "text-green-600 dark:text-green-500" : "text-red-600 dark:text-red-500"
                        )}>
                          {item.direction === "added" ? "+" : "\u2212"}{formatCurrency(item.amount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="h-[200px] w-full flex items-center justify-center text-muted-foreground text-sm">
                No rolls in this period.
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </Layout>
  );
}
