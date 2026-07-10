import * as React from "react";
import { cn } from "@/lib/utils";
import { Layout } from "@/components/layout";
import { KPICards } from "@/components/kpi-cards";
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
  const now = new Date();
  const apr15ThisYear = new Date(now.getFullYear(), 3, 15);
  return now >= apr15ThisYear ? apr15ThisYear : new Date(now.getFullYear() - 1, 3, 15);
}

function defaultTo(): Date {
  const now = new Date();
  const d = new Date(now);
  d.setDate(d.getDate() + 30);
  return d;
}
import {
  useGetAdjustmentsTimeseries,
  getGetAdjustmentsTimeseriesQueryKey,
  useGetAdjustmentsTotals,
  getGetAdjustmentsTotalsQueryKey,
  useGetGoals,
  getGetGoalsQueryKey,
  useGetAdjustmentsDetails,
  getGetAdjustmentsDetailsQueryKey,
  useSetStockGoal,
  useDeleteStockGoal
} from "@workspace/api-client-react";
import {
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { formatCurrency } from "@/lib/format";
import { useParams, Link } from "wouter";
import { ArrowLeft, Save, Trash2, Edit2, X } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

type Bucket = "day" | "week" | "month" | "quarter" | "year";
const BUCKETS: readonly Bucket[] = ["day", "week", "month", "quarter", "year"];

interface ChartClickEvent {
  activePayload?: Array<{
    payload?: { periodStart: string; periodEnd: string; label: string };
  }>;
}

export default function StockDetails() {
  const { stockId } = useParams<{ stockId: string }>();
  const queryClient = useQueryClient();

  const [date, setDate] = React.useState<{ from: Date; to: Date | undefined }>({
    from: defaultFrom(),
    to: defaultTo(),
  });
  const [bucket, setBucket] = React.useState<Bucket>("week");

  const fromStr = format(date.from, "yyyy-MM-dd");
  const toStr = date.to ? format(date.to, "yyyy-MM-dd") : fromStr;

  const { data: totals, isLoading: totalsLoading } = useGetAdjustmentsTotals(
    { from: fromStr, to: toStr, stockId },
    { query: { queryKey: getGetAdjustmentsTotalsQueryKey({ from: fromStr, to: toStr, stockId }) } }
  );

  const { data: timeseries, isLoading: tsLoading } = useGetAdjustmentsTimeseries(
    { bucket, from: fromStr, to: toStr, stockId },
    { query: { queryKey: getGetAdjustmentsTimeseriesQueryKey({ bucket, from: fromStr, to: toStr, stockId }) } }
  );

  const { data: details, isLoading: detailsLoading } = useGetAdjustmentsDetails(
    { from: fromStr, to: toStr, stockId, limit: 100 },
    { query: { queryKey: getGetAdjustmentsDetailsQueryKey({ from: fromStr, to: toStr, stockId, limit: 100 }) } }
  );

  const { data: goals, isLoading: goalsLoading } = useGetGoals(
    { query: { queryKey: getGetGoalsQueryKey() } }
  );

  const stockGoal = goals?.perStock?.find(g => g.stockId === stockId);
  const rawActive = stockGoal || goals?.global;
  const activeGoal = {
    min: rawActive?.min ?? -6000,
    max: rawActive?.max ?? 6000,
  };
  const isDefaultGoal = !stockGoal && (goals?.global?.min == null && goals?.global?.max == null);

  const chartData = React.useMemo(() => {
    if (!timeseries) return [];
    return timeseries.points.map((p) => ({
      ...p,
      goalMin: activeGoal?.min ?? undefined,
      goalMax: activeGoal?.max ?? undefined,
    }));
  }, [timeseries, activeGoal]);

  const [isEditingGoal, setIsEditingGoal] = React.useState(false);
  const [minInput, setMinInput] = React.useState("");
  const [maxInput, setMaxInput] = React.useState("");

  const setGoalMutation = useSetStockGoal();
  const deleteGoalMutation = useDeleteStockGoal();

  const handleEditClick = () => {
    setMinInput(stockGoal?.min?.toString() || "");
    setMaxInput(stockGoal?.max?.toString() || "");
    setIsEditingGoal(true);
  };

  const handleSaveGoal = async () => {
    try {
      const min = minInput.trim() === "" ? null : Number(minInput);
      const max = maxInput.trim() === "" ? null : Number(maxInput);
      
      if ((min !== null && isNaN(min)) || (max !== null && isNaN(max))) {
        toast.error("Invalid numbers provided");
        return;
      }

      await setGoalMutation.mutateAsync({
        stockId: stockId!,
        data: { min, max }
      });
      
      queryClient.invalidateQueries({ queryKey: getGetGoalsQueryKey() });
      setIsEditingGoal(false);
      toast.success("Stock goal updated");
    } catch (e) {
      toast.error("Failed to update stock goal");
    }
  };

  const handleDeleteGoal = async () => {
    try {
      await deleteGoalMutation.mutateAsync({ stockId: stockId! });
      queryClient.invalidateQueries({ queryKey: getGetGoalsQueryKey() });
      setIsEditingGoal(false);
      toast.success("Stock goal removed");
    } catch (e) {
      toast.error("Failed to remove stock goal");
    }
  };

  const [selectedBucket, setSelectedBucket] = React.useState<{ from: string; to: string; label: string } | null>(null);

  const handleChartClick = (e: ChartClickEvent) => {
    const point = e?.activePayload?.[0]?.payload;
    if (!point) return;
    setSelectedBucket({ from: point.periodStart, to: point.periodEnd, label: point.label });
  };

  const filteredItems = React.useMemo(() => {
    if (!details?.items) return [];
    if (!selectedBucket) return details.items;
    return details.items.filter(
      (i) => i.ccDate >= selectedBucket.from && i.ccDate <= selectedBucket.to,
    );
  }, [details, selectedBucket]);

  return (
    <Layout>
      <div className="mb-4">
        <Link href="/">
          <Button variant="outline" size="sm" className="inline-flex items-center">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to Dashboard
          </Button>
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground font-mono">{stockId}</h1>
          <p className="text-muted-foreground text-sm">Stock details and history</p>
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

      <KPICards totals={totals} isLoading={totalsLoading} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Net Adjustment Trends</CardTitle>
            <div className="flex items-center gap-2 text-sm">
              {!isEditingGoal ? (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 text-muted-foreground bg-muted px-3 py-1 rounded-full text-xs font-mono">
                    <span className="w-2 h-2 rounded-full bg-primary/40 inline-block"></span>
                    Target range: {formatCurrency(activeGoal.min)} to {formatCurrency(activeGoal.max)}
                    {stockGoal ? ' (Override)' : isDefaultGoal ? ' (Default)' : ' (Global)'}
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleEditClick}>
                    <Edit2 className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 bg-muted/50 p-2 rounded border">
                  <div className="flex items-center gap-2">
                    <Label className="sr-only">Min</Label>
                    <Input 
                      className="h-7 w-24 text-xs font-mono" 
                      placeholder="Min $" 
                      value={minInput} 
                      onChange={e => setMinInput(e.target.value)} 
                    />
                  </div>
                  <span className="text-muted-foreground text-xs">to</span>
                  <div className="flex items-center gap-2">
                    <Label className="sr-only">Max</Label>
                    <Input 
                      className="h-7 w-24 text-xs font-mono" 
                      placeholder="Max $" 
                      value={maxInput} 
                      onChange={e => setMaxInput(e.target.value)} 
                    />
                  </div>
                  <Button size="icon" className="h-7 w-7" onClick={handleSaveGoal} disabled={setGoalMutation.isPending}>
                    <Save className="h-3 w-3" />
                  </Button>
                  <Button size="icon" variant="destructive" className="h-7 w-7" onClick={handleDeleteGoal} disabled={deleteGoalMutation.isPending || !stockGoal}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setIsEditingGoal(false)}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
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
                    />
                    <Tooltip
                      formatter={(value: number) => formatCurrency(value)}
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
                    />
                    <ReferenceArea
                      y1={activeGoal.min}
                      y2={activeGoal.max}
                      fill="hsl(var(--primary))"
                      fillOpacity={0.1}
                    />
                    <Line
                      type="monotone"
                      dataKey="net"
                      name="Net"
                      stroke="hsl(var(--chart-2))"
                      strokeWidth={2}
                      dot={{ r: 5, style: { cursor: 'pointer' } }}
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

        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Recent Adjustments</CardTitle>
            <p className="text-xs text-muted-foreground">
              {details?.items?.length ?? 0} roll{(details?.items?.length ?? 0) === 1 ? '' : 's'} in window
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {detailsLoading ? (
              <div className="p-6 space-y-4">
                {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : details?.items?.length ? (
              <div className="overflow-auto max-h-[400px]">
                <Table>
                  <TableHeader className="bg-muted/50 sticky top-0 z-10">
                    <TableRow>
                      <TableHead>Roll Tag</TableHead>
                      <TableHead>CC Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {details.items.map((item) => (
                      <TableRow key={item.id} className="text-xs">
                        <TableCell className="font-mono">{item.rollTag}</TableCell>
                        <TableCell className="font-mono">{item.ccDate}</TableCell>
                        <TableCell>
                           <span className={cn(
                             "px-2 py-0.5 rounded-full uppercase text-[10px] font-bold",
                             item.direction === "added" ? "bg-green-500/10 text-green-600 dark:text-green-500" : "bg-red-500/10 text-red-600 dark:text-red-500"
                           )}>
                             {item.direction}
                           </span>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(item.amount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="h-[300px] w-full flex items-center justify-center text-muted-foreground text-sm">
                No individual adjustments found.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle>
              {selectedBucket ? `Rolls in ${selectedBucket.label}` : "All Roll Adjustments"}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {selectedBucket
                ? `${selectedBucket.from} to ${selectedBucket.to} \u00B7 ${filteredItems.length} roll${filteredItems.length === 1 ? '' : 's'}`
                : `Per-roll detail for stock ${stockId} between ${fromStr} and ${toStr} \u00B7 ${filteredItems.length} roll${filteredItems.length === 1 ? '' : 's'}`}
            </p>
          </div>
          {selectedBucket && (
            <Button variant="ghost" size="sm" onClick={() => setSelectedBucket(null)}>
              <X className="h-4 w-4 mr-1" /> Show all
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {detailsLoading ? (
            <div className="p-6 space-y-4">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : filteredItems.length ? (
            <div className="overflow-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Roll Tag</TableHead>
                    <TableHead>CC Date</TableHead>
                    <TableHead>Row Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>CC String</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.map((item) => (
                    <TableRow key={item.id} className="text-xs">
                      <TableCell className="font-mono font-semibold">{item.rollTag}</TableCell>
                      <TableCell className="font-mono">{item.ccDate}</TableCell>
                      <TableCell className="font-mono text-muted-foreground">{item.rowDate ?? '\u2014'}</TableCell>
                      <TableCell>
                        <span className={cn(
                          "px-2 py-0.5 rounded-full uppercase text-[10px] font-bold",
                          item.direction === "added" ? "bg-green-500/10 text-green-600 dark:text-green-500" : "bg-red-500/10 text-red-600 dark:text-red-500"
                        )}>
                          {item.direction}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground">{item.ccString}</TableCell>
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
              No individual adjustments found.
            </div>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}
