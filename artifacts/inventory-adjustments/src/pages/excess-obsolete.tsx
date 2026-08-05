import * as React from "react";
import {
  useGetEoReport,
  getGetEoReportQueryKey,
  useSetEoNotes,
  useGetStockRolls,
  getGetStockRollsQueryKey,
  type EoReportItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { openAuthorizedUrl } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Archive, ChevronDown, ChevronRight, Download } from "lucide-react";

/**
 * Excess & Obsolete review. Every stock holding inventory, worst first:
 * no-usage-in-12-months at the top (infinite months of supply), then by
 * months of supply descending. Disposition notes persist per stock, and each
 * row expands to the physical roll tag numbers on the floor.
 */

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

const MOS_FILTERS = [
  { key: "all", label: "All stocks", min: 0 },
  { key: "6", label: "≥ 6 months", min: 6 },
  { key: "12", label: "≥ 12 months", min: 12 },
  { key: "never", label: "No usage (12 mo)", min: Infinity },
] as const;

function mosValue(i: EoReportItem): number {
  return i.monthsOfSupply == null ? Infinity : i.monthsOfSupply;
}

/** Click-to-edit disposition note, saved on blur. */
function NotesCell({ item }: { item: EoReportItem }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const save = useSetEoNotes();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(item.notes ?? "");
  React.useEffect(() => setValue(item.notes ?? ""), [item.notes]);

  if (!editing) {
    return (
      <button
        type="button"
        className={cn(
          "w-full text-left rounded px-1.5 py-1 hover:bg-accent/60 min-h-[1.75rem] whitespace-pre-wrap",
          !item.notes && "text-muted-foreground/60 italic",
        )}
        onClick={() => setEditing(true)}
        title="Click to edit the disposition note"
      >
        {item.notes || "add disposition…"}
      </button>
    );
  }
  return (
    <Textarea
      autoFocus
      className="text-xs min-h-[3.5rem]"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={async () => {
        setEditing(false);
        if ((value.trim() || null) === (item.notes ?? null)) return;
        try {
          await save.mutateAsync({ data: { stockId: item.stockId, notes: value.trim() || null } });
          await queryClient.invalidateQueries({ queryKey: getGetEoReportQueryKey() });
          toast({ title: "Disposition saved", description: `#${item.stockId}` });
        } catch (e) {
          toast({ title: "Save failed", description: String(e), variant: "destructive" });
        }
      }}
      placeholder='e.g. "Scrap Q3", "Return to vendor", "Hold for GLOR rerun"'
    />
  );
}

/** On-hand roll tag numbers, fetched when the row expands. */
function RollList({ stockId }: { stockId: string }) {
  const { data, isLoading } = useGetStockRolls(stockId, {
    query: { queryKey: getGetStockRollsQueryKey(stockId), staleTime: 60_000 },
  });
  if (isLoading) return <Skeleton className="h-10 rounded-md" />;
  const rolls = data?.rolls ?? [];
  if (rolls.length === 0) return <p className="text-muted-foreground">No on-hand rolls in the mirror.</p>;
  return (
    <div className="rounded-md border overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="bg-muted/40 text-muted-foreground">
            <th className="text-left px-2 py-1 font-medium">Roll tag #</th>
            <th className="text-right px-2 py-1 font-medium">Footage</th>
            <th className="text-right px-2 py-1 font-medium">Width</th>
            <th className="text-left px-2 py-1 font-medium">PO</th>
            <th className="text-left px-2 py-1 font-medium">Received</th>
            <th className="text-left px-2 py-1 font-medium">Location</th>
          </tr>
        </thead>
        <tbody>
          {rolls.map((r) => (
            <tr key={r.rollId} className="border-t">
              <td className="px-2 py-1 font-mono font-medium">{r.rollId}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmt(r.footage)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{r.width ? `${r.width}"` : "—"}</td>
              <td className="px-2 py-1">{r.poNumber ?? "—"}</td>
              <td className="px-2 py-1 tabular-nums">{r.receivedIso ?? "—"}</td>
              <td className="px-2 py-1">{r.location ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ExcessObsolete() {
  const { data, isLoading } = useGetEoReport({
    query: { queryKey: getGetEoReportQueryKey(), staleTime: 120_000 },
  });
  const [filter, setFilter] = React.useState<(typeof MOS_FILTERS)[number]["key"]>("6");
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const items = data?.items ?? [];
  const min = MOS_FILTERS.find((f) => f.key === filter)!.min;
  const visible = items.filter((i) => (min === Infinity ? i.monthsOfSupply == null : mosValue(i) >= min));
  const totalValue = visible.reduce((s, i) => s + (i.valueUsd ?? 0), 0);
  const totalFootage = visible.reduce((s, i) => s + i.onHandFootage, 0);
  const anyEstimated = visible.some((i) => i.valueIsEstimate && (i.valueUsd ?? 0) > 0);

  return (
    <Layout>
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Archive className="w-5 h-5 text-muted-foreground" /> Excess &amp; Obsolete
          </h1>
          <p className="text-sm text-muted-foreground">
            Every stock on hand, worst months-of-supply first (12-month usage window
            {data?.windowFrom ? ` since ${data.windowFrom}` : ""}). Click a row for its roll tag numbers; click the
            disposition cell to record the decision.
          </p>
        </div>
        <div className="flex items-center rounded-md border overflow-hidden">
          {MOS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "px-2.5 py-1.5 text-xs font-medium whitespace-nowrap",
                filter === f.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {visible.length} stock{visible.length === 1 ? "" : "s"} · {fmt(totalFootage)} ft ·{" "}
              <span className="text-foreground font-semibold">{money(totalValue)}</span>
              {anyEstimated && (
                <span title="Some values estimated from footage × CostMSI rather than a purchase-order amount">
                  {" "}
                  (≈)
                </span>
              )}
            </CardTitle>
            {/* Disposition happens roll by roll against physical tags, so the
                export is one line per ROLL — not the stock-level rows shown
                here — with every column from this table alongside. */}
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              title="One row per roll: tag, footage, width, PO, received date and location, plus every column in this table"
              onClick={() => void openAuthorizedUrl("/api/demand/eo-report/export")}
            >
              <Download className="w-3.5 h-3.5 mr-1" /> Export rolls
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-72 rounded-lg" />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/40 text-muted-foreground">
                    <th className="w-6 px-2 py-1.5" />
                    <th className="text-left px-2 py-1.5 font-medium min-w-[16rem]">Stock</th>
                    <th
                      className="text-right px-2 py-1.5 font-medium"
                      title="On hand ÷ average monthly use over the past 12 months"
                    >
                      Months of supply
                    </th>
                    <th className="text-right px-2 py-1.5 font-medium">On hand (ft)</th>
                    <th className="text-right px-2 py-1.5 font-medium">Rolls</th>
                    <th className="text-right px-2 py-1.5 font-medium">Value</th>
                    <th className="text-right px-2 py-1.5 font-medium" title="Average monthly consumption, trailing 12 months">
                      Avg use/mo (ft)
                    </th>
                    <th className="text-left px-2 py-1.5 font-medium">Last used</th>
                    <th className="text-left px-2 py-1.5 font-medium min-w-[16rem]">Disposition</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((i) => (
                    <React.Fragment key={i.stockId}>
                      <tr
                        className={cn("border-b cursor-pointer hover:bg-accent/40", expanded === i.stockId && "bg-accent/40")}
                        onClick={() => setExpanded((p) => (p === i.stockId ? null : i.stockId))}
                      >
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {expanded === i.stockId ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="font-medium">#{i.stockId}</span>{" "}
                          <span className="text-muted-foreground">{i.description}</span>
                          {i.inactive && (
                            <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[9px]">
                              Inactive
                            </Badge>
                          )}
                          {i.discontinued && (
                            <Badge variant="outline" className="ml-1 px-1 py-0 text-[9px] text-amber-700 dark:text-amber-400 border-amber-500/40">
                              EOL
                            </Badge>
                          )}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-1.5 text-right tabular-nums font-semibold",
                            i.monthsOfSupply == null
                              ? "text-red-600 dark:text-red-400"
                              : i.monthsOfSupply >= 12
                                ? "text-amber-700 dark:text-amber-400"
                                : undefined,
                          )}
                          title={i.monthsOfSupply == null ? "No recorded usage in the past 12 months" : undefined}
                        >
                          {i.monthsOfSupply == null ? "∞ (no usage)" : i.monthsOfSupply.toFixed(1)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmt(i.onHandFootage)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{i.rollCount}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums" title={i.valueIsEstimate ? "Estimated: footage × CostMSI" : "Per-roll cost from Label Traxx"}>
                          {i.valueUsd != null ? `${i.valueIsEstimate ? "≈" : ""}${money(i.valueUsd)}` : "—"}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {i.avgMonthlyFootage > 0 ? fmt(i.avgMonthlyFootage) : "0"}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground tabular-nums">{i.lastUsedIso ?? "> 12 mo"}</td>
                        <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                          <NotesCell item={i} />
                        </td>
                      </tr>
                      {expanded === i.stockId && (
                        <tr className="border-b bg-muted/20">
                          <td />
                          <td colSpan={8} className="px-2 py-2">
                            <RollList stockId={i.stockId} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                        Nothing matches this filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}
