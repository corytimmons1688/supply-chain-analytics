import * as React from "react";
import { useGetMrp, getGetMrpQueryKey, type MrpRow, type MrpResult } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Settings2, CalendarClock } from "lucide-react";

/**
 * Time-phased purchase plan, one block per stock × width.
 *
 * Replaces the Stock-by-stock plan. That report carried one reorder point and
 * max per STOCK, computed from pooled consumption — but supply and demand are
 * width-aware everywhere else, so a stock could read healthy in aggregate while
 * one width was starving. The planning grain here is the width bucket.
 *
 * Read a block as arithmetic, top to bottom:
 *   previous projected + scheduled receipts + planned receipt − gross = projected
 * The RELEASE row is the only one that asks for a decision: it's the same order
 * as the planned receipt, moved back by the lead time to the week you must act.
 */

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

/** Compact footage for a dense grid: 12,400 → 12.4k. */
function kft(n: number): string {
  if (!n) return "";
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(abs < 10000 ? 1 : 0)}k`;
}

const BASIS_LABEL: Record<string, string> = {
  history: "measured at this width",
  apportioned: "apportioned — too little history at this width, split from the stock-level figure by this width's share of committed demand",
  none: "no usable demand signal at this width",
};

function DriverChips({ row }: { row: MrpRow }) {
  const d = row.drivers;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      <Badge
        variant="outline"
        className={cn(
          "text-[10px] px-1.5 py-0 font-normal",
          d.reorderBasis === "history"
            ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
            : d.reorderBasis === "apportioned"
              ? "border-amber-500/40 text-amber-700 dark:text-amber-400"
              : "border-border text-muted-foreground",
        )}
        title={BASIS_LABEL[d.reorderBasis]}
      >
        ROP {fmt(d.reorderPointFootage)} · {d.reorderBasis === "history" ? `${d.observations} rolls` : d.reorderBasis}
      </Badge>
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal text-muted-foreground" title="Order-up-to level for this width">
        Max {fmt(d.maxFootage)}
      </Badge>
      <Badge
        variant="outline"
        className="text-[10px] px-1.5 py-0 font-normal text-muted-foreground"
        title={`Lead time source: ${d.leadTimeSource}${d.leadTimeOverridden ? " (manual override)" : ""}`}
      >
        {d.leadTimeDays}d {d.leadTimeOverridden ? "(set)" : ""}
      </Badge>
      {d.alternates.length > 0 && (
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 font-normal border-sky-500/40 text-sky-700 dark:text-sky-400"
          title={d.alternates
            .map((a) => `#${a.stockId}: ${fmt(a.onHandFootage)} ft at this width`)
            .join("\n")}
        >
          {d.alternates.length} alt
        </Badge>
      )}
      {row.undatedReceiptFootage > 0 && (
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 font-normal border-amber-500/40 text-amber-700 dark:text-amber-400"
          title={`${fmt(row.undatedReceiptFootage)} ft on order has no date on the PO — scheduled from PO date + lead time. Counted, because excluding it would double-buy the material.`}
        >
          {fmt(row.undatedReceiptFootage)} ft undated
        </Badge>
      )}
      {row.orderQuantityIgnored != null && (
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 font-normal border-red-500/40 text-red-700 dark:text-red-400"
          title={`Configured order quantity is ${fmt(row.orderQuantityIgnored)} MASTER ROLLS, which is implausible — almost certainly footage typed into a rolls field. Ignored here; fix it in the configuration.`}
        >
          bad order qty
        </Badge>
      )}
      {row.drivers.discontinued && (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal text-muted-foreground">
          EOL
        </Badge>
      )}
    </div>
  );
}

/** One five-row MRP block for a stock × width. */
function MrpBlock({
  row,
  weeks,
  onConfigure,
}: {
  row: MrpRow;
  weeks: MrpResult["weeks"];
  onConfigure: (row: MrpRow) => void;
}) {
  const TD = "px-2 py-1 text-right tabular-nums whitespace-nowrap";
  const LABEL = "px-2 py-1 text-muted-foreground whitespace-nowrap";
  return (
    <tbody className="border-t-2 border-border">
      {/* Identity row spans the width of the grid so the block reads as a unit. */}
      <tr className="bg-muted/40">
        <td className="px-2 py-1.5 align-top" rowSpan={6}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium">
                #{row.stockId} <span className="text-muted-foreground">{row.widthLabel}</span>
              </div>
              <div className="text-[11px] text-muted-foreground max-w-[16rem]">{row.description ?? "—"}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {fmt(row.openingOnHand)} ft on hand
                {row.vendorName ? ` · ${row.vendorName}` : ""}
              </div>
              <DriverChips row={row} />
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 shrink-0"
              title="Edit the settings driving this plan"
              onClick={() => onConfigure(row)}
            >
              <Settings2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </td>
        {weeks.map((w) => (
          <td key={w.weekStart} className="px-2 py-1 text-right text-[10px] text-muted-foreground whitespace-nowrap">
            {w.weekStart.slice(5)}
          </td>
        ))}
      </tr>
      <tr>
        <td className={LABEL} title="Booked tickets + pending-approval orders, or the statistical forecast — whichever is larger">
          Gross requirement
        </td>
        {row.cells.map((c) => (
          <td
            key={c.weekStart}
            className={TD}
            title={`booked ${fmt(c.bookedFootage)} · pending ${fmt(c.pendingFootage)} · statistical ${fmt(c.statisticalFootage)}`}
          >
            {kft(c.grossRequirement)}
          </td>
        ))}
      </tr>
      <tr>
        <td className={LABEL} title="Open POs arriving this week. Make-and-hold stock isn't counted until a release is requested.">
          Scheduled receipts
        </td>
        {row.cells.map((c) => (
          <td key={c.weekStart} className={cn(TD, c.scheduledReceipts > 0 && "text-blue-700 dark:text-blue-300")}>
            {kft(c.scheduledReceipts)}
          </td>
        ))}
      </tr>
      <tr>
        <td className={LABEL} title="A planned order landing this week — the receipt side of a release below">
          Planned receipt
        </td>
        {row.cells.map((c) => (
          <td key={c.weekStart} className={cn(TD, c.plannedOrderReceipt > 0 && "text-muted-foreground")}>
            {kft(c.plannedOrderReceipt)}
          </td>
        ))}
      </tr>
      <tr>
        <td className={LABEL} title="Balance carried forward. Negative is the stockout.">
          Projected on hand
        </td>
        {row.cells.map((c) => (
          <td
            key={c.weekStart}
            className={cn(
              TD,
              "font-medium",
              c.projectedOnHand < 0
                ? "bg-red-500/10 text-red-700 dark:text-red-400"
                : c.projectedOnHand < row.drivers.reorderPointFootage && row.drivers.reorderPointFootage > 0
                  ? "text-amber-700 dark:text-amber-400"
                  : "",
            )}
            title={
              c.projectedOnHand < 0
                ? `Short ${fmt(-c.projectedOnHand)} ft this week`
                : c.projectedOnHand < row.drivers.reorderPointFootage
                  ? `Below the ${fmt(row.drivers.reorderPointFootage)} ft reorder point`
                  : undefined
            }
          >
            {kft(c.projectedOnHand)}
          </td>
        ))}
      </tr>
      <tr>
        <td className={LABEL} title="Place this order this week so it lands when it's needed. This is the only row that asks for a decision.">
          <span className="font-medium text-foreground">Release order</span>
        </td>
        {row.cells.map((c, i) => (
          <td
            key={c.weekStart}
            className={cn(
              TD,
              c.plannedOrderRelease > 0 && "bg-violet-500/10 text-violet-700 dark:text-violet-300 font-semibold",
            )}
            title={
              c.plannedOrderRelease > 0
                ? `${c.plannedOrderRolls} roll${c.plannedOrderRolls === 1 ? "" : "s"} · ${fmt(c.plannedOrderRelease)} ft` +
                  (i === 0 && row.lateReleaseFootage > 0
                    ? ` — ${fmt(row.lateReleaseFootage)} ft of this needed placing before the horizon opened, so it's already behind`
                    : "")
                : undefined
            }
          >
            {c.plannedOrderRelease > 0 ? `${kft(c.plannedOrderRelease)}` : ""}
            {i === 0 && row.lateReleaseFootage > 0 && <span className="ml-0.5 text-[9px]">late</span>}
          </td>
        ))}
      </tr>
    </tbody>
  );
}

export function MrpGrid({ onConfigure }: { onConfigure: (row: MrpRow) => void }) {
  const { data, isLoading } = useGetMrp(undefined, {
    query: { queryKey: getGetMrpQueryKey(), staleTime: 60_000 },
  });
  const [q, setQ] = React.useState("");
  const [actionOnly, setActionOnly] = React.useState(true);

  const rows = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) => {
      if (actionOnly && r.plannedTotalFootage <= 0 && r.firstShortageWeek == null) return false;
      if (!needle) return true;
      return (
        r.stockId.toLowerCase().includes(needle) ||
        (r.description ?? "").toLowerCase().includes(needle) ||
        (r.vendorName ?? "").toLowerCase().includes(needle)
      );
    });
  }, [data, q, actionOnly]);

  if (isLoading) return <Skeleton className="h-64 rounded-lg" />;
  if (!data) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-muted-foreground" /> Purchase plan — {data.weeks.length} weeks
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1 max-w-3xl">
              Planned per stock <strong>and width</strong>, because a stock can sit above its overall reorder point while
              one width is starving. Read a block downward: previous projected + receipts + planned receipt − gross
              requirement = projected on hand. Only <strong>Release order</strong> asks for a decision.
              {data.lateReleaseCount > 0 && (
                <>
                  {" "}
                  <span className="text-amber-700 dark:text-amber-400 font-medium">
                    {data.lateReleaseCount} row{data.lateReleaseCount === 1 ? "" : "s"} need an order that, given the lead
                    time, should already have gone out.
                  </span>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search stock, description, vendor…"
              className="h-8 w-56 text-xs"
            />
            <Button size="sm" variant={actionOnly ? "default" : "outline"} onClick={() => setActionOnly((v) => !v)}>
              {actionOnly ? "Needs action" : "All rows"}
            </Button>
          </div>
        </div>

        {data.configWarnings.length > 0 && (
          <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-800 dark:text-red-300">
            <span className="font-medium">Configuration needs fixing.</span>{" "}
            {data.configWarnings
              .map((w) => `#${w.stockId} has an order quantity of ${fmt(w.orderQuantityRolls)} master rolls`)
              .join("; ")}
            . That's almost certainly footage typed into a rolls field — it's ignored here so it can't distort the plan,
            but the plan can't size those orders properly until it's corrected.
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {actionOnly
              ? "No stock × width needs an order inside the horizon."
              : "Nothing matches this search."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-background z-10">
                <tr className="border-b text-muted-foreground">
                  <th className="text-left px-2 py-1.5 font-medium min-w-[17rem]">Stock · width</th>
                  {data.weeks.map((w) => (
                    <th key={w.weekStart} className="text-right px-2 py-1.5 font-medium whitespace-nowrap">
                      {w.label.replace("Wk of ", "")}
                    </th>
                  ))}
                </tr>
              </thead>
              {rows.map((r) => (
                <MrpBlock key={`${r.stockId}|${r.widthKey}`} row={r} weeks={data.weeks} onConfigure={onConfigure} />
              ))}
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
