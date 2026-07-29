import * as React from "react";
import { Link } from "wouter";
import {
  useGetDemandSummary,
  getGetDemandSummaryQueryKey,
  useGetDemandPurchasing,
  getGetDemandPurchasingQueryKey,
  useListMaterialPos,
  getListMaterialPosQueryKey,
  useGetPoAgentQueue,
  getGetPoAgentQueueQueryKey,
  useGetOnHandInventory,
  useGetAdjustmentsTotals,
  useGetCycleCountSchedule,
  useGetVendorScorecards,
  useGetAsl,
  useListWeeklySnapshots,
  type DemandStockMetrics,
  type MaterialPo,
} from "@workspace/api-client-react";
import { ResponsiveContainer, LineChart, Line } from "recharts";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Boxes,
  AlertTriangle,
  ShoppingCart,
  Truck,
  Ticket,
  Send,
  ArrowRight,
  PackageCheck,
  ListChecks,
  Award,
  ClipboardCheck,
  Camera,
} from "lucide-react";

/**
 * SCO Overview — the home page. One screen that gathers the operating KPIs
 * every other tab computes, each card deep-linking to the tab that owns it.
 * All numbers come from the same endpoints the tabs use, so they always match.
 */

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function footageToMsi(footage: number, width: number): number {
  return (footage * 12 * width) / 1000;
}

/** Local YYYY-MM-DD (toISOString would shift the date across midnight UTC). */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// --- small building blocks --------------------------------------------------

function StatTile({
  title,
  icon: Icon,
  value,
  sub,
  tone,
  href,
  loading,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "amber" | "red" | "emerald";
  href: string;
  loading?: boolean;
}) {
  return (
    <Link href={href}>
      <Card className="cursor-pointer transition-colors hover:border-primary/40 h-full">
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</CardTitle>
          <Icon
            className={cn(
              "h-4 w-4 shrink-0",
              tone === "amber" ? "text-amber-600" : tone === "red" ? "text-red-600" : tone === "emerald" ? "text-emerald-600" : "text-muted-foreground",
            )}
          />
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <div
              className={cn(
                "text-2xl font-bold font-mono leading-none",
                tone === "amber" && "text-amber-600",
                tone === "red" && "text-red-600",
              )}
            >
              {value}
            </div>
          )}
          {sub && <p className="text-xs text-muted-foreground mt-1.5">{sub}</p>}
        </CardContent>
      </Card>
    </Link>
  );
}

function SectionCard({
  title,
  icon: Icon,
  href,
  hrefLabel,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  hrefLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" /> {title}
        </CardTitle>
        <Link
          href={href}
          className="text-xs text-primary hover:underline inline-flex items-center gap-1 shrink-0"
        >
          {hrefLabel} <ArrowRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent className="text-xs">{children}</CardContent>
    </Card>
  );
}

/** Status pill — label + count, never color alone. */
function StatusPill({ label, count, className }: { label: string; count: number; className: string }) {
  return (
    <div className={cn("rounded-md border px-2.5 py-1.5 flex items-baseline gap-2", className)}>
      <span className="text-lg font-bold font-mono leading-none">{count}</span>
      <span className="text-[11px]">{label}</span>
    </div>
  );
}

// --- the page ----------------------------------------------------------------

export default function Overview() {
  // The same endpoints the tabs use — the overview can never disagree with them.
  const { data: summary, isLoading: summaryLoading } = useGetDemandSummary(
    {},
    { query: { queryKey: getGetDemandSummaryQueryKey({}), staleTime: 120_000 } },
  );
  const { data: purch } = useGetDemandPurchasing({
    query: { queryKey: getGetDemandPurchasingQueryKey(), staleTime: 120_000 },
  });
  const { data: poList, isLoading: posLoading } = useListMaterialPos({
    query: { queryKey: getListMaterialPosQueryKey(), staleTime: 60_000 },
  });
  const { data: agentQueue } = useGetPoAgentQueue({
    query: { queryKey: getGetPoAgentQueueQueryKey(), staleTime: 60_000 },
  });
  const { data: onHandInv, isLoading: invLoading } = useGetOnHandInventory();
  const now = new Date();
  const monthStart = isoDay(new Date(now.getFullYear(), now.getMonth(), 1));
  const today = isoDay(now);
  const { data: adjTotals } = useGetAdjustmentsTotals({ from: monthStart, to: today });
  const { data: cycles } = useGetCycleCountSchedule();
  const { data: scorecards } = useGetVendorScorecards();
  const { data: asl } = useGetAsl();
  const { data: weekly } = useListWeeklySnapshots();

  const rows: DemandStockMetrics[] = React.useMemo(() => summary?.items ?? [], [summary]);
  const purchByStock = React.useMemo(() => new Map((purch?.items ?? []).map((i) => [i.stockId, i])), [purch]);

  // Demand / reorder KPIs (same math as the Suggested POs tab).
  const demandKpis = React.useMemo(() => {
    const active = rows.filter((r) => !r.inactive);
    const below = rows.filter((r) => r.belowMin);
    const suggested = rows.filter((r) => r.suggestedOrderRolls > 0);
    let suggestedCost = 0;
    for (const r of suggested) {
      const p = purchByStock.get(r.stockId);
      if (!p || p.msiCost == null) continue;
      const widths = r.suggestedWidths?.length
        ? r.suggestedWidths
        : [{ width: p.masterWidth ?? 0, footage: r.suggestedOrderFootage, rolls: r.suggestedOrderRolls, reason: "forecast" as const }];
      for (const w of widths) {
        if (!w.width) continue;
        suggestedCost += footageToMsi(w.footage, w.width) * (p.msiCost + (p.freightMsi ?? 0));
      }
    }
    const onHandFt = rows.reduce((s, r) => s + r.onHandFootage, 0);
    const onOrderFt = rows.reduce((s, r) => s + r.openPoFootage, 0);
    const committedShort = rows.reduce((s, r) => s + r.committedShortageFootage, 0);
    return { activeCount: active.length, below, suggested, suggestedCost, onHandFt, onOrderFt, committedShort };
  }, [rows, purchByStock]);

  // Ticket availability — each ticket once, by its worst material status
  // (identical to the Demand tab donut).
  const ticketStatus = React.useMemo(() => {
    const rank: Record<string, number> = { In: 0, Ordered: 1, "Ordered Not Confirmed": 2, Out: 3 };
    const worst = new Map<string, string>();
    for (const item of purch?.items ?? []) {
      for (const t of item.tickets ?? []) {
        const s = t.computedStatus;
        if (!s || !(s in rank)) continue;
        const cur = worst.get(t.ticketNumber);
        if (cur == null || rank[s]! > rank[cur]!) worst.set(t.ticketNumber, s);
      }
    }
    const counts = { In: 0, Ordered: 0, "Ordered Not Confirmed": 0, Out: 0 } as Record<string, number>;
    for (const s of worst.values()) counts[s] = (counts[s] ?? 0) + 1;
    return { counts, total: worst.size };
  }, [purch]);

  // Dazpak make-and-hold (from the same summary metrics the Demand tab uses).
  const dazpak = React.useMemo(() => {
    const prog = rows.filter((r) => r.dazpak);
    return {
      stocks: prog.length,
      heldFt: prog.reduce((s, r) => s + (r.dazpak?.heldFootage ?? 0), 0),
      inProdFt: prog.reduce((s, r) => s + (r.dazpak?.inProductionFootage ?? 0), 0),
      releases: prog.filter((r) => (r.dazpak?.releaseFootage ?? 0) > 0),
      makes: prog.filter((r) => (r.dazpak?.makeFootage ?? 0) > 0),
    };
  }, [rows]);

  // Purchase pipeline (PO history + agent states).
  const pipeline = React.useMemo(() => {
    const items: MaterialPo[] = poList?.items ?? [];
    const open = items.filter((p) => p.status !== "draft" && !p.receivedOn);
    const drafts = items.filter((p) => p.status === "draft");
    const awaitingAck = open.filter((p) => p.agentState === "awaiting_ack");
    const arrivals = open
      .map((p) => ({ po: p, date: p.promisedDate ?? p.requestedDeliveryDate }))
      .filter((x): x is { po: MaterialPo; date: string } => Boolean(x.date))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 5);
    return { open, drafts, awaitingAck, arrivals };
  }, [poList]);

  // Vendor scorecards — best and worst with data.
  const vendorPerf = React.useMemo(() => {
    const scored = (scorecards?.items ?? []).filter((s) => s.hasData && s.score != null);
    const sorted = [...scored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return { top: sorted.slice(0, 3), bottom: sorted.length > 3 ? sorted.slice(-3).reverse() : [] };
  }, [scorecards]);

  // ASL sourcing pipeline — same 45-day SLA clock as the ASL page.
  const sourcing = React.useMemo(() => {
    const inFlight = asl?.pipeline ?? [];
    const dayNum = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
    const elapsed = (spec: string | null | undefined): number | null => {
      if (!spec) return null;
      const t = Date.parse(spec.length === 10 ? `${spec}T00:00:00` : spec);
      if (Number.isNaN(t)) return null;
      const days = dayNum(new Date()) - dayNum(new Date(t));
      return days < 0 ? null : days;
    };
    const clocked = inFlight
      .map((r) => ({ r, days: elapsed(r.vendor.specInDate) }))
      .filter((x): x is { r: (typeof inFlight)[number]; days: number } => x.days != null && !x.r.vendor.poReadyDate);
    return {
      onboarded: asl?.onboardedCount ?? 0,
      inFlight: inFlight.length,
      overdue: clocked.filter((x) => x.days > 45).length,
      warning: clocked.filter((x) => x.days > 35 && x.days <= 45).length,
    };
  }, [asl]);

  // On-hand value trend from weekly snapshots (last 12 weeks).
  const trend = React.useMemo(() => {
    const items = [...(weekly?.items ?? [])]
      .sort((a, b) => a.weekEnding.localeCompare(b.weekEnding))
      .slice(-12);
    const latest = items[items.length - 1];
    return { points: items.map((w) => ({ v: w.onHandValue })), latest };
  }, [weekly]);

  const kpi = cycles?.kpi;
  const attention = agentQueue?.needsAttention?.length ?? 0;
  const draftsPending = agentQueue?.drafts?.length ?? 0;
  const atRisk = ticketStatus.counts["Out"] + ticketStatus.counts["Ordered Not Confirmed"];

  return (
    <Layout>
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Supply Chain Overview</h1>
          <p className="text-sm text-muted-foreground">
            The day's position across inventory, demand, purchasing, and vendors — every card opens its tab.
          </p>
        </div>
        <p className="text-xs text-muted-foreground font-mono">as of {new Date().toLocaleString()}</p>
      </div>

      {/* Headline tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatTile
          title="On-hand inventory"
          icon={Boxes}
          loading={invLoading}
          value={onHandInv ? money(onHandInv.totalValue) : "—"}
          sub={onHandInv ? `${fmt(onHandInv.rollCount)} rolls · ${fmt(demandKpis.onHandFt)} ft` : undefined}
          href="/adjustments"
        />
        <StatTile
          title="Below reorder point"
          icon={AlertTriangle}
          loading={summaryLoading}
          value={demandKpis.below.length}
          tone={demandKpis.below.length > 0 ? "amber" : undefined}
          sub={`of ${demandKpis.activeCount} active stocks`}
          href="/demand"
        />
        <StatTile
          title="Suggested orders"
          icon={ShoppingCart}
          loading={summaryLoading}
          value={demandKpis.suggested.length ? money(demandKpis.suggestedCost) : "0"}
          sub={
            demandKpis.suggested.length
              ? `${demandKpis.suggested.length} material${demandKpis.suggested.length === 1 ? "" : "s"} to order`
              : "nothing to order"
          }
          href="/demand?tab=pos"
        />
        <StatTile
          title="Open POs"
          icon={Truck}
          loading={posLoading}
          value={pipeline.open.length}
          sub={`${fmt(demandKpis.onOrderFt)} ft inbound${pipeline.drafts.length ? ` · ${pipeline.drafts.length} draft${pipeline.drafts.length === 1 ? "" : "s"}` : ""}`}
          href="/demand?tab=pos"
        />
        <StatTile
          title="Tickets at risk"
          icon={Ticket}
          value={atRisk}
          tone={ticketStatus.counts["Out"] > 0 ? "red" : atRisk > 0 ? "amber" : undefined}
          sub={`${ticketStatus.counts["Out"]} out · ${ticketStatus.counts["Ordered Not Confirmed"]} unconfirmed`}
          href="/demand"
        />
        <StatTile
          title="Agent needs you"
          icon={Send}
          value={attention + draftsPending}
          tone={attention > 0 ? "amber" : undefined}
          sub={`${draftsPending} draft${draftsPending === 1 ? "" : "s"} · ${attention} flag${attention === 1 ? "" : "s"}`}
          href="/demand?tab=email"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
        {/* Ticket availability */}
        <SectionCard title="Material availability" icon={Ticket} href="/demand" hrefLabel="Demand">
          <div className="grid grid-cols-2 gap-2">
            <StatusPill label="In stock" count={ticketStatus.counts["In"]} className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/40" />
            <StatusPill label="Ordered" count={ticketStatus.counts["Ordered"]} className="bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/40" />
            <StatusPill label="Not confirmed" count={ticketStatus.counts["Ordered Not Confirmed"]} className="bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40" />
            <StatusPill label="Out" count={ticketStatus.counts["Out"]} className="bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/40" />
          </div>
          <p className="text-muted-foreground mt-2">
            {ticketStatus.total} open production tickets, each counted by its worst material.
          </p>
          {demandKpis.committedShort > 0 && (
            <p className="text-red-600 dark:text-red-400 mt-1">
              {fmt(demandKpis.committedShort)} ft of committed demand not covered by stock or POs.
            </p>
          )}
        </SectionCard>

        {/* Purchase pipeline */}
        <SectionCard title="Purchase pipeline" icon={Truck} href="/demand?tab=pos" hrefLabel="POs">
          {pipeline.open.length === 0 ? (
            <p className="text-muted-foreground">No open purchase orders.</p>
          ) : (
            <div className="space-y-1">
              {pipeline.arrivals.map(({ po, date }) => (
                <div key={po.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    <span className="font-medium">{po.vendorName}</span>
                    <span className="text-muted-foreground"> · #{po.lines[0]?.stockId}{po.ltPoNumbers ? ` · LT ${po.ltPoNumbers}` : ""}</span>
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {po.needsAttention && <AlertTriangle className="w-3 h-3 text-amber-600" />}
                    {po.agentState === "awaiting_ack" && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0">awaiting ack</Badge>
                    )}
                    <span className="font-mono text-muted-foreground">{date}</span>
                  </span>
                </div>
              ))}
              <p className="text-muted-foreground pt-1">
                {pipeline.open.length} open · {pipeline.awaitingAck.length} awaiting acknowledgement
                {attention > 0 && <span className="text-amber-700 dark:text-amber-400"> · {attention} flagged</span>}
              </p>
            </div>
          )}
        </SectionCard>

        {/* On-hand trend */}
        <SectionCard title="Inventory value trend" icon={Camera} href="/snapshots" hrefLabel="Snapshots">
          {trend.points.length < 2 ? (
            <p className="text-muted-foreground">Not enough weekly snapshots yet.</p>
          ) : (
            <>
              <div className="h-14">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend.points} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
                    <Line type="monotone" dataKey="v" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {trend.latest && (
                <p className="text-muted-foreground mt-1">
                  Week ending {trend.latest.weekEnding}: <span className="font-mono text-foreground">{money(trend.latest.onHandValue)}</span>
                  {" · "}net adj {trend.latest.netAdjustment >= 0 ? "+" : ""}
                  {money(trend.latest.netAdjustment)} ({trend.latest.adjustmentPct.toFixed(2)}%)
                </p>
              )}
              {adjTotals && (
                <p className="text-muted-foreground">
                  Month to date: net {adjTotals.net >= 0 ? "+" : ""}
                  {money(adjTotals.net)} ({adjTotals.addedCount + adjTotals.removedCount} adjustments)
                </p>
              )}
            </>
          )}
        </SectionCard>

        {/* Make & hold */}
        <SectionCard title="Dazpak make & hold" icon={PackageCheck} href="/demand" hrefLabel="Demand">
          {dazpak.stocks === 0 ? (
            <p className="text-muted-foreground">No program stocks in the Dazpak feed.</p>
          ) : (
            <div className="space-y-1">
              <div className="flex gap-4">
                <span>
                  <span className="font-mono font-semibold">{fmt(dazpak.heldFt)}</span>{" "}
                  <span className="text-muted-foreground">ft held</span>
                </span>
                <span>
                  <span className="font-mono font-semibold">{fmt(dazpak.inProdFt)}</span>{" "}
                  <span className="text-muted-foreground">ft in production</span>
                </span>
              </div>
              {dazpak.releases.length > 0 ? (
                <p className="text-amber-700 dark:text-amber-400">
                  Release now: {dazpak.releases.map((r) => `#${r.stockId} (${fmt(r.dazpak!.releaseFootage)} ft)`).join(", ")}
                </p>
              ) : (
                <p className="text-muted-foreground">No releases needed right now.</p>
              )}
              {dazpak.makes.length > 0 && (
                <p className="text-amber-700 dark:text-amber-400">
                  Make &amp; hold: {dazpak.makes.map((r) => `#${r.stockId} (${fmt(r.dazpak!.makeFootage)} ft)`).join(", ")}
                </p>
              )}
            </div>
          )}
        </SectionCard>

        {/* Cycle counts */}
        <SectionCard title="Cycle counts" icon={ListChecks} href="/cycle-counts" hrefLabel="Schedule">
          {!kpi ? (
            <p className="text-muted-foreground">No schedule yet.</p>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    kpi.status === "on_track" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/40",
                    kpi.status === "behind" && "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40",
                  )}
                >
                  {kpi.status === "on_track" ? "On track" : kpi.status === "behind" ? `Behind by ${kpi.deficit}` : "Not started"}
                </Badge>
                <span className="text-muted-foreground">
                  {kpi.quarter} · week {kpi.currentWeek}/{kpi.totalWeeks}
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary"
                  style={{
                    width: `${kpi.totalExpectedThisQuarter > 0 ? Math.min(100, (kpi.totalCompletedThisQuarter / kpi.totalExpectedThisQuarter) * 100) : 0}%`,
                  }}
                />
              </div>
              <p className="text-muted-foreground">
                {kpi.totalCompletedThisQuarter} of {kpi.totalExpectedThisQuarter} planned counts completed
              </p>
            </div>
          )}
        </SectionCard>

        {/* Vendor performance */}
        <SectionCard title="Vendor performance" icon={Award} href="/scorecards" hrefLabel="Scorecards">
          {vendorPerf.top.length === 0 ? (
            <p className="text-muted-foreground">No scored vendors in this period.</p>
          ) : (
            <div className="space-y-1">
              {vendorPerf.top.map((s) => (
                <div key={s.vendor.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{s.vendor.name}</span>
                  <span className="flex items-center gap-2 font-mono shrink-0">
                    {s.onTimePct != null && <span className="text-muted-foreground">{Math.round(s.onTimePct)}% OT</span>}
                    <Badge variant="outline" className="px-1.5 py-0">{s.grade} · {Math.round(s.score!)}</Badge>
                  </span>
                </div>
              ))}
              {vendorPerf.bottom.length > 0 && (
                <>
                  <div className="text-muted-foreground pt-1 uppercase tracking-wide text-[10px]">Needs attention</div>
                  {vendorPerf.bottom.map((s) => (
                    <div key={s.vendor.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{s.vendor.name}</span>
                      <span className="flex items-center gap-2 font-mono shrink-0">
                        {s.onTimePct != null && <span className="text-muted-foreground">{Math.round(s.onTimePct)}% OT</span>}
                        <Badge variant="outline" className="px-1.5 py-0 text-amber-700 dark:text-amber-400 border-amber-500/40">
                          {s.grade} · {Math.round(s.score!)}
                        </Badge>
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </SectionCard>

        {/* Sourcing pipeline */}
        <SectionCard title="Sourcing pipeline" icon={ClipboardCheck} href="/asl" hrefLabel="ASL">
          <div className="flex gap-4">
            <span>
              <span className="font-mono font-semibold">{sourcing.inFlight}</span>{" "}
              <span className="text-muted-foreground">vendors in flight</span>
            </span>
            <span>
              <span className="font-mono font-semibold">{sourcing.onboarded}</span>{" "}
              <span className="text-muted-foreground">onboarded</span>
            </span>
          </div>
          {sourcing.overdue > 0 && (
            <p className="text-red-600 dark:text-red-400 mt-1">
              {sourcing.overdue} past the 45-day sourcing SLA
            </p>
          )}
          {sourcing.warning > 0 && (
            <p className="text-amber-700 dark:text-amber-400 mt-1">{sourcing.warning} approaching the SLA (day 35+)</p>
          )}
          {sourcing.overdue === 0 && sourcing.warning === 0 && (
            <p className="text-muted-foreground mt-1">All in-flight vendors inside the 45-day SLA.</p>
          )}
        </SectionCard>
      </div>
    </Layout>
  );
}
