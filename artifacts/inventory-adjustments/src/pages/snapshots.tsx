import * as React from "react";
import {
  useListWeeklySnapshots,
  useGetWeeklySnapshot,
  useListMonthlySnapshots,
  useGetMonthlySnapshot,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtMonth(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return monthKey;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtCapturedAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { timeZone: "America/Denver" }) + " MT";
}

function RollList({
  title,
  rolls,
  accent,
}: {
  title: string;
  rolls: Array<{
    rollTag: string;
    stockId: string;
    description?: string | null;
    amount: number;
    ccDate: string;
  }>;
  accent: string;
}) {
  return (
    <div className="bg-card rounded-md border">
      <div className={cn("px-4 py-2 text-sm font-semibold border-b", accent)}>{title}</div>
      {rolls.length === 0 ? (
        <div className="px-4 py-3 text-sm text-muted-foreground">None</div>
      ) : (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2">Roll</th>
                <th className="text-left px-3 py-2">Stock</th>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-right px-3 py-2">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rolls.map((r) => (
                <tr key={`${r.rollTag}-${r.ccDate}`} className="border-t">
                  <td className="px-3 py-1.5 font-mono text-xs">{r.rollTag}</td>
                  <td className="px-3 py-1.5">
                    <div>{r.stockId}</div>
                    {r.description && (
                      <div className="text-xs text-muted-foreground">{r.description}</div>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-xs">{fmtDate(r.ccDate)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{fmtCurrency(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Weekly ----------

function WeeklySnapshotDetail({ weekEndings }: { weekEndings: string[] }) {
  const primary = useGetWeeklySnapshot(weekEndings[0] ?? "__none__", {
    query: { enabled: !!weekEndings[0] } as never,
  });
  const secondary = useGetWeeklySnapshot(weekEndings[1] ?? "__none__", {
    query: { enabled: !!weekEndings[1] } as never,
  });
  const queries = [primary, ...(weekEndings[1] ? [secondary] : [])];
  const isLoading = queries.some((q) => q.isLoading);
  const error = queries.find((q) => q.error);
  const allRolls = queries.flatMap((q) => q.data?.rolls ?? []);

  if (isLoading) {
    return (
      <div className="p-6 flex items-center text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading roll details...
      </div>
    );
  }
  if (error) {
    return <div className="p-6 text-sm text-destructive">Could not load snapshot detail.</div>;
  }
  if (allRolls.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No CC adjustments captured for this week.</div>;
  }

  const added = allRolls.filter((r) => r.direction === "added");
  const removed = allRolls.filter((r) => r.direction === "removed");

  return (
    <div className="p-4 bg-muted/30 grid md:grid-cols-2 gap-4">
      <RollList title={`Added (${added.length})`} accent="text-green-600" rolls={added} />
      <RollList title={`Removed (${removed.length})`} accent="text-red-600" rolls={removed} />
    </div>
  );
}

interface WeeklyItem {
  id: string;
  weekStart: string;
  weekEnding: string;
  capturedAt: string;
  onHandValue: number;
  rollCount: number;
  added: number;
  removed: number;
  netAdjustment: number;
  adjustmentPct: number;
  componentWeekEndings: string[];
  isCombined: boolean;
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

function mergeForCurrentWeek(rawItems: WeeklyItem[]): WeeklyItem[] {
  const cur = currentMountainWeek();
  const prevEnding = addDaysIso(cur.weekEnding, -7);
  const prevStart = addDaysIso(cur.weekStart, -7);

  const curSnap = rawItems.find((s) => s.weekEnding === cur.weekEnding);
  const prevSnap = rawItems.find((s) => s.weekEnding === prevEnding);

  if (!curSnap || !prevSnap) return rawItems;

  const onHandValue = curSnap.onHandValue;
  const added = Math.round((curSnap.added + prevSnap.added) * 100) / 100;
  const removed = Math.round((curSnap.removed + prevSnap.removed) * 100) / 100;
  const netAdjustment = Math.round((added - removed) * 100) / 100;
  const adjustmentPct =
    onHandValue > 0 ? Math.round((netAdjustment / onHandValue) * 10000) / 100 : 0;

  const merged: WeeklyItem = {
    id: cur.weekEnding,
    weekStart: prevStart,
    weekEnding: cur.weekEnding,
    capturedAt: curSnap.capturedAt > prevSnap.capturedAt ? curSnap.capturedAt : prevSnap.capturedAt,
    onHandValue,
    rollCount: curSnap.rollCount,
    added,
    removed,
    netAdjustment,
    adjustmentPct,
    componentWeekEndings: [cur.weekEnding, prevEnding],
    isCombined: true,
  };

  const rest = rawItems.filter(
    (s) => s.weekEnding !== cur.weekEnding && s.weekEnding !== prevEnding,
  );
  return [merged, ...rest];
}

function WeeklyTab() {
  const { data, isLoading, error } = useListWeeklySnapshots();
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const items = React.useMemo<WeeklyItem[]>(() => {
    const raw: WeeklyItem[] = (data?.items ?? []).map((s) => ({
      ...s,
      componentWeekEndings: [s.weekEnding],
      isCombined: false,
    }));
    return mergeForCurrentWeek(raw);
  }, [data]);

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 mr-2 animate-spin inline" /> Loading snapshots...
      </div>
    );
  }
  if (error) {
    return <div className="py-8 text-center text-sm text-destructive">Failed to load snapshots.</div>;
  }
  if (items.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No weekly snapshots yet. The first one is captured automatically Sunday at 11:59 PM Mountain Time.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase text-muted-foreground border-b">
          <tr>
            <th className="text-left px-3 py-2 w-8"></th>
            <th className="text-left px-3 py-2">Week Ending</th>
            <th className="text-right px-3 py-2">On-Hand</th>
            <th className="text-right px-3 py-2">Net Adjustment</th>
            <th className="text-right px-3 py-2">% of On-Hand</th>
            <th className="text-right px-3 py-2">Rolls Added / Removed</th>
            <th className="text-left px-3 py-2">Captured</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => {
            const isOpen = expanded === s.weekEnding;
            const netClass = s.netAdjustment > 0 ? "text-green-600" : s.netAdjustment < 0 ? "text-red-600" : "text-muted-foreground";
            return (
              <React.Fragment key={s.weekEnding}>
                <tr
                  className="border-b hover-elevate cursor-pointer"
                  onClick={() => setExpanded(isOpen ? null : s.weekEnding)}
                  data-testid={`row-weekly-${s.weekEnding}`}
                >
                  <td className="px-3 py-3">
                    {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </td>
                  <td className="px-3 py-3 font-medium">
                    <div className="flex items-center gap-2">
                      {fmtDate(s.weekEnding)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {s.isCombined
                        ? `Combined ${fmtDate(s.weekStart)} – ${fmtDate(s.weekEnding)}`
                        : `Week of ${fmtDate(s.weekStart)}`}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{fmtCurrency(s.onHandValue)}</td>
                  <td className={cn("px-3 py-3 text-right font-mono font-semibold", netClass)}>
                    {s.netAdjustment >= 0 ? "+" : ""}
                    {fmtCurrency(s.netAdjustment)}
                  </td>
                  <td className={cn("px-3 py-3 text-right font-mono", netClass)}>
                    {s.adjustmentPct >= 0 ? "+" : ""}
                    {s.adjustmentPct.toFixed(2)}%
                  </td>
                  <td className="px-3 py-3 text-right text-xs">
                    <Badge variant="outline" className="text-green-600 border-green-200 mr-1">
                      +{fmtCurrency(s.added)}
                    </Badge>
                    <Badge variant="outline" className="text-red-600 border-red-200">
                      -{fmtCurrency(s.removed)}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{fmtCapturedAt(s.capturedAt)}</td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={7} className="p-0">
                      <WeeklySnapshotDetail weekEndings={s.componentWeekEndings} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Monthly ----------

function MonthlySnapshotDetail({ monthKey }: { monthKey: string }) {
  const { data, isLoading, error } = useGetMonthlySnapshot(monthKey);

  if (isLoading) {
    return (
      <div className="p-6 flex items-center text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading roll details...
      </div>
    );
  }
  if (error || !data) {
    return <div className="p-6 text-sm text-destructive">Could not load snapshot detail.</div>;
  }
  if (data.rolls.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No CC adjustments captured for this month.</div>;
  }
  const added = data.rolls.filter((r) => r.direction === "added");
  const removed = data.rolls.filter((r) => r.direction === "removed");
  return (
    <div className="p-4 bg-muted/30 grid md:grid-cols-2 gap-4">
      <RollList title={`Added (${added.length})`} accent="text-green-600" rolls={added} />
      <RollList title={`Removed (${removed.length})`} accent="text-red-600" rolls={removed} />
    </div>
  );
}

function MonthlyTab() {
  const { data, isLoading, error } = useListMonthlySnapshots();
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const items = data?.items ?? [];

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 mr-2 animate-spin inline" /> Loading snapshots...
      </div>
    );
  }
  if (error) {
    return <div className="py-8 text-center text-sm text-destructive">Failed to load snapshots.</div>;
  }
  if (items.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No monthly snapshots yet. The first one is captured automatically at 11:59 PM Mountain Time on the last day of each month.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase text-muted-foreground border-b">
          <tr>
            <th className="text-left px-3 py-2 w-8"></th>
            <th className="text-left px-3 py-2">Month</th>
            <th className="text-right px-3 py-2">On-Hand</th>
            <th className="text-right px-3 py-2">Net Adjustment</th>
            <th className="text-right px-3 py-2">% of On-Hand</th>
            <th className="text-right px-3 py-2">Rolls Added / Removed</th>
            <th className="text-left px-3 py-2">Captured</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => {
            const isOpen = expanded === s.monthKey;
            const netClass = s.netAdjustment > 0 ? "text-green-600" : s.netAdjustment < 0 ? "text-red-600" : "text-muted-foreground";
            return (
              <React.Fragment key={s.monthKey}>
                <tr
                  className="border-b hover-elevate cursor-pointer"
                  onClick={() => setExpanded(isOpen ? null : s.monthKey)}
                  data-testid={`row-monthly-${s.monthKey}`}
                >
                  <td className="px-3 py-3">
                    {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </td>
                  <td className="px-3 py-3 font-medium">
                    <div>{fmtMonth(s.monthKey)}</div>
                    <div className="text-xs text-muted-foreground">
                      {fmtDate(s.monthStart)} – {fmtDate(s.monthEnd)}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{fmtCurrency(s.onHandValue)}</td>
                  <td className={cn("px-3 py-3 text-right font-mono font-semibold", netClass)}>
                    {s.netAdjustment >= 0 ? "+" : ""}
                    {fmtCurrency(s.netAdjustment)}
                  </td>
                  <td className={cn("px-3 py-3 text-right font-mono", netClass)}>
                    {s.adjustmentPct >= 0 ? "+" : ""}
                    {s.adjustmentPct.toFixed(2)}%
                  </td>
                  <td className="px-3 py-3 text-right text-xs">
                    <Badge variant="outline" className="text-green-600 border-green-200 mr-1">
                      +{fmtCurrency(s.added)}
                    </Badge>
                    <Badge variant="outline" className="text-red-600 border-red-200">
                      -{fmtCurrency(s.removed)}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{fmtCapturedAt(s.capturedAt)}</td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={7} className="p-0">
                      <MonthlySnapshotDetail monthKey={s.monthKey} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Page ----------

export default function Snapshots() {
  return (
    <Layout>
      <div>
        <h1 className="text-3xl font-bold">Weekly/ Monthly Tracking</h1>
        <p className="text-sm text-muted-foreground mt-1">Frozen captures of on-hand value and CC adjustments for Label Traxx Inventory. Weekly snapshots run Monday–Sunday and auto-capture every Sunday at 11:59 PM Mountain Time. Monthly snapshots auto-capture at 11:59 PM Mountain Time on the last day of each month.</p>
      </div>
      <Tabs defaultValue="weekly" className="space-y-4">
        <TabsList>
          <TabsTrigger value="weekly" data-testid="tab-weekly">Weekly</TabsTrigger>
          <TabsTrigger value="monthly" data-testid="tab-monthly">Monthly</TabsTrigger>
        </TabsList>

        <TabsContent value="weekly">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Weekly History</CardTitle>
            </CardHeader>
            <CardContent>
              <WeeklyTab />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="monthly">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Monthly History</CardTitle>
            </CardHeader>
            <CardContent>
              <MonthlyTab />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </Layout>
  );
}
