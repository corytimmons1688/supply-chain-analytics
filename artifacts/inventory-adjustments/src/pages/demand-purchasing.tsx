import * as React from "react";
import { useLocation } from "wouter";
import {
  useGetDemandPurchasing,
  getGetDemandPurchasingQueryKey,
  useUpdateDemandConfig,
  useListMaterialPos,
  getListMaterialPosQueryKey,
  useCreateMaterialPo,
  useSubmitMaterialPo,
  type DemandStockMetrics,
  type PurchasingItem,
  type MaterialPo,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { Mail, Send, ShoppingCart, Ticket, CheckCircle2, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);
}

/** footage (ft) × width (in) → MSI (thousand square inches). */
function footageToMsi(footage: number, widthIn: number): number {
  return (footage * 12 * widthIn) / 1000;
}

const TICKET_STATUS_COLORS: Record<string, string> = {
  In: "#22c55e",
  Ordered: "#38bdf8",
  "Ordered Not Confirmed": "#a78bfa",
  Out: "#ef4444",
};

// ---------------------------------------------------------------------
// Overview section: ticket-status donut + clickable on-hand vs open-ticket
// requirements comparison chart.
// ---------------------------------------------------------------------
export function TicketCompareSection({ rows }: { rows: DemandStockMetrics[] }) {
  const [, navigate] = useLocation();
  const { data, isLoading } = useGetDemandPurchasing({ query: { queryKey: getGetDemandPurchasingQueryKey(), staleTime: 60_000 } });

  const byStock = React.useMemo(() => {
    const m = new Map<string, PurchasingItem>();
    for (const it of data?.items ?? []) m.set(it.stockId, it);
    return m;
  }, [data]);

  const chartData = React.useMemo(() => {
    const metricsByStock = new Map(rows.map((r) => [r.stockId, r]));
    const entries = (data?.items ?? [])
      .filter((it) => (it.openTicketFootage ?? 0) > 0)
      .map((it) => {
        const m = metricsByStock.get(it.stockId);
        return {
          stockId: it.stockId,
          name: `#${it.stockId}`,
          description: m?.description ?? it.classification ?? "",
          onHand: Math.round(m?.onHandFootage ?? 0),
          required: Math.round(it.openTicketFootage ?? 0),
          onOrder: Math.round(m?.openPoFootage ?? 0),
          short: Math.max(0, Math.round((it.openTicketFootage ?? 0) - (m?.onHandFootage ?? 0) - (m?.openPoFootage ?? 0))),
        };
      })
      .sort((a, b) => b.required - a.required)
      .slice(0, 16);
    return entries;
  }, [data, rows]);

  const donutData = React.useMemo(
    () =>
      Object.entries(data?.statusCounts ?? {})
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value),
    [data],
  );
  const totalTickets = donutData.reduce((s, d) => s + d.value, 0);
  const shortCount = chartData.filter((d) => d.short > 0).length;

  if (isLoading) return <Skeleton className="h-72 rounded-lg" />;
  if (!data) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Ticket className="w-4 h-4 text-muted-foreground" /> Open Ticket Stock Status
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Label Traxx material availability across {totalTickets} open tickets
          </p>
        </CardHeader>
        <CardContent>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={donutData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={2}
                  isAnimationActive={false}
                >
                  {donutData.map((d) => (
                    <Cell key={d.name} fill={TICKET_STATUS_COLORS[d.name] ?? "#94a3b8"} />
                  ))}
                </Pie>
                <ReTooltip formatter={(v: number, n: string) => [`${v} tickets`, n]} />
                <Legend verticalAlign="bottom" height={40} iconSize={9} wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base">On-Hand vs Open Ticket Requirements</CardTitle>
              <p className="text-xs text-muted-foreground">
                Footage by stock — click a bar to open the stock detail
                {shortCount > 0 && (
                  <span className="text-red-600 dark:text-red-400 font-medium"> · {shortCount} short</span>
                )}
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No open tickets with material requirements.
            </p>
          ) : (
            <div style={{ height: Math.max(240, chartData.length * 34) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  layout="vertical"
                  margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
                  onClick={(e) => {
                    const stockId = (e?.activePayload?.[0]?.payload as { stockId?: string } | undefined)?.stockId;
                    if (stockId) navigate(`/demand/${stockId}`);
                  }}
                  className="cursor-pointer"
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="currentColor" opacity={0.1} />
                  <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${fmt(v / 1000)}k`} />
                  <YAxis type="category" dataKey="name" width={52} tick={{ fontSize: 11 }} />
                  <ReTooltip
                    formatter={(v: number, name: string) => [`${fmt(v)} ft`, name]}
                    labelFormatter={(label: string) => {
                      const row = chartData.find((d) => d.name === label);
                      return row ? `${label} ${row.description}`.slice(0, 60) : label;
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} iconSize={9} />
                  <Bar isAnimationActive={false} dataKey="onHand" name="On hand" fill="#22c55e" radius={[0, 3, 3, 0]} barSize={10} />
                  <Bar isAnimationActive={false} dataKey="onOrder" name="On order (open PO)" fill="#38bdf8" radius={[0, 3, 3, 0]} barSize={10} />
                  <Bar isAnimationActive={false} dataKey="required" name="Open ticket requirement" fill="#6366f1" radius={[0, 3, 3, 0]} barSize={10} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------
// Suggested POs tab
// ---------------------------------------------------------------------
type SuggestionLine = {
  stockId: string;
  description: string | null;
  vendorName: string;
  vendorEmails: string | null;
  suggestedRolls: number;
  rolls: number;
  selected: boolean;
  footagePerRoll: number;
  msiCost: number | null;
  freightMsi: number;
  masterWidth: number;
  leadTimeDays: number;
  belowMin: boolean;
  daysOfCover: number;
  openTicketFootage: number;
};

function lineEstCost(l: SuggestionLine): number | null {
  if (l.msiCost == null || l.masterWidth <= 0 || l.footagePerRoll <= 0) return null;
  const msi = footageToMsi(l.rolls * l.footagePerRoll, l.masterWidth);
  return msi * (l.msiCost + l.freightMsi);
}

export function SuggestedPosTab({ rows }: { rows: DemandStockMetrics[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: purch, isLoading } = useGetDemandPurchasing({ query: { queryKey: getGetDemandPurchasingQueryKey(), staleTime: 60_000 } });
  const { data: poList } = useListMaterialPos({ query: { queryKey: getListMaterialPosQueryKey(), staleTime: 30_000 } });
  const createPo = useCreateMaterialPo();
  const submitPo = useSubmitMaterialPo();
  const [lines, setLines] = React.useState<SuggestionLine[]>([]);
  const [emails, setEmails] = React.useState<Record<string, { to: string; subject: string; body: string; poId: string }>>({});

  React.useEffect(() => {
    if (!purch) return;
    const purchByStock = new Map(purch.items.map((it) => [it.stockId, it]));
    const next: SuggestionLine[] = rows
      .filter((r) => r.suggestedOrderRolls > 0 && r.activityStatus !== "dormant" && r.activityStatus !== "never")
      .map((r) => {
        const p = purchByStock.get(r.stockId);
        return {
          stockId: r.stockId,
          description: r.description ?? null,
          vendorName: p?.vendorName ?? "Unassigned vendor",
          vendorEmails: p?.vendorEmails ?? null,
          suggestedRolls: r.suggestedOrderRolls,
          rolls: r.suggestedOrderRolls,
          selected: r.belowMin,
          footagePerRoll: r.typicalRollFootage,
          msiCost: p?.msiCost ?? null,
          freightMsi: p?.freightMsi ?? 0,
          masterWidth: p?.masterWidth ?? 0,
          leadTimeDays: Math.round(r.avgLeadTimeDays),
          belowMin: r.belowMin,
          daysOfCover: r.daysOfCover,
          openTicketFootage: p?.openTicketFootage ?? 0,
        };
      })
      .sort((a, b) => Number(b.belowMin) - Number(a.belowMin) || a.stockId.localeCompare(b.stockId, undefined, { numeric: true }));
    setLines(next);
  }, [purch, rows]);

  const byVendor = React.useMemo(() => {
    const m = new Map<string, SuggestionLine[]>();
    for (const l of lines) {
      const arr = m.get(l.vendorName) ?? [];
      arr.push(l);
      m.set(l.vendorName, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [lines]);

  const setLine = (stockId: string, patch: Partial<SuggestionLine>) =>
    setLines((prev) => prev.map((l) => (l.stockId === stockId ? { ...l, ...patch } : l)));

  const handleCreate = async (vendorName: string, vendorLines: SuggestionLine[]) => {
    const selected = vendorLines.filter((l) => l.selected && l.rolls > 0);
    if (selected.length === 0) {
      toast({ title: "Nothing selected", description: "Check at least one line first", variant: "destructive" });
      return;
    }
    const maxLead = Math.max(14, ...selected.map((l) => l.leadTimeDays || 0));
    const due = new Date();
    due.setDate(due.getDate() + maxLead);
    try {
      const r = await createPo.mutateAsync({
        data: {
          vendorName,
          vendorEmails: selected[0]!.vendorEmails,
          requestedDeliveryDate: due.toISOString().slice(0, 10),
          lines: selected.map((l) => ({
            stockId: l.stockId,
            description: l.description,
            rolls: l.rolls,
            footage: l.rolls * l.footagePerRoll || null,
            msiCost: l.msiCost,
            estCost: lineEstCost(l),
          })),
        },
      });
      setEmails((prev) => ({ ...prev, [vendorName]: { ...r.email, poId: r.id } }));
      await queryClient.invalidateQueries({ queryKey: getListMaterialPosQueryKey() });
      toast({ title: "PO draft created", description: `${selected.length} line(s) for ${vendorName}` });
    } catch (e) {
      toast({ title: "Failed", description: String(e), variant: "destructive" });
    }
  };

  const handleSubmit = async (poId: string, vendorName: string) => {
    try {
      const r = await submitPo.mutateAsync({ id: poId });
      await queryClient.invalidateQueries({ queryKey: getListMaterialPosQueryKey() });
      toast({
        title: r.status === "submitted_lt" ? "PO created in Label Traxx" : "PO submitted",
        description:
          r.status === "submitted_lt"
            ? `LT PO #${(r.ltPoNumbers ?? []).join(", ")}`
            : "Recorded here — Label Traxx entry pending (LT writes not yet enabled)",
      });
      setEmails((prev) => ({ ...prev, [vendorName]: { ...r.email, poId: r.id } }));
    } catch (e) {
      toast({ title: "Submit failed", description: String(e), variant: "destructive" });
    }
  };

  if (isLoading) return <Skeleton className="h-72 rounded-lg" />;

  return (
    <div className="space-y-4">
      {byVendor.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nothing to order — no active stocks are at or below their reorder point. 🎉
          </CardContent>
        </Card>
      ) : (
        byVendor.map(([vendorName, vendorLines]) => {
          const selected = vendorLines.filter((l) => l.selected && l.rolls > 0);
          const total = selected.reduce((s, l) => s + (lineEstCost(l) ?? 0), 0);
          const email = emails[vendorName];
          return (
            <Card key={vendorName}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <ShoppingCart className="w-4 h-4 text-muted-foreground" />
                    {vendorName}
                    <Badge variant="secondary">{vendorLines.length} suggestion{vendorLines.length === 1 ? "" : "s"}</Badge>
                    {vendorLines[0]?.vendorEmails ? (
                      <span className="text-xs font-normal text-muted-foreground">{vendorLines[0].vendorEmails}</span>
                    ) : (
                      <span className="text-xs font-normal text-amber-600 dark:text-amber-400">
                        no PO email — set it in Configuration
                      </span>
                    )}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    {total > 0 && (
                      <span className="text-xs text-muted-foreground">
                        est. <span className="font-semibold text-foreground">${fmt(total)}</span>
                      </span>
                    )}
                    <Button
                      size="sm"
                      disabled={createPo.isPending || selected.length === 0}
                      onClick={() => handleCreate(vendorName, vendorLines)}
                    >
                      <Send className="w-3.5 h-3.5 mr-1" /> Create PO ({selected.length})
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/40 text-muted-foreground">
                        <th className="w-8 px-2 py-1.5" />
                        <th className="text-left px-2 py-1.5 font-medium">Stock</th>
                        <th className="text-left px-2 py-1.5 font-medium">Why</th>
                        <th className="text-right px-2 py-1.5 font-medium">Rolls</th>
                        <th className="text-right px-2 py-1.5 font-medium">Footage</th>
                        <th className="text-right px-2 py-1.5 font-medium">Est. cost</th>
                        <th className="text-right px-2 py-1.5 font-medium">Lead time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vendorLines.map((l) => (
                        <tr key={l.stockId} className="border-b last:border-b-0">
                          <td className="px-2 py-1.5">
                            <Checkbox checked={l.selected} onCheckedChange={(c) => setLine(l.stockId, { selected: c === true })} />
                          </td>
                          <td className="px-2 py-1.5">
                            <span className="font-medium">#{l.stockId}</span>{" "}
                            <span className="text-muted-foreground">{(l.description ?? "").slice(0, 44)}</span>
                          </td>
                          <td className="px-2 py-1.5">
                            {l.belowMin ? (
                              <Badge variant="outline" className="text-[10px] bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/40">
                                below ROP · {l.daysOfCover >= 0 ? `${fmt(l.daysOfCover)}d cover` : "no demand"}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">{fmt(l.daysOfCover)}d cover</span>
                            )}
                            {l.openTicketFootage > 0 && (
                              <span className="text-muted-foreground"> · {fmt(l.openTicketFootage)} ft on open tickets</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <Input
                              type="number"
                              min={0}
                              className="h-6 w-16 text-xs text-right inline-block"
                              value={l.rolls}
                              onChange={(e) => setLine(l.stockId, { rolls: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
                            />
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(l.rolls * l.footagePerRoll)} ft</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {lineEstCost(l) != null ? `$${fmt(lineEstCost(l))}` : "—"}
                          </td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground">{l.leadTimeDays || "—"}d</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {email && (
                  <div className="mt-2 flex items-center gap-2 text-xs">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    <span>PO draft ready.</span>
                    <a
                      className="text-primary hover:underline inline-flex items-center gap-1"
                      href={`mailto:${encodeURIComponent(email.to)}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`}
                    >
                      <Mail className="w-3.5 h-3.5" /> Email PO to vendor
                    </a>
                    <span className="text-muted-foreground">·</span>
                    <button
                      type="button"
                      className="text-primary hover:underline inline-flex items-center gap-1"
                      disabled={submitPo.isPending}
                      onClick={() => handleSubmit(email.poId, vendorName)}
                    >
                      <Send className="w-3.5 h-3.5" /> Submit PO{purch?.ltWriteEnabled ? " to Label Traxx" : ""}
                    </button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}

      {(poList?.items.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">PO History</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {poList!.items.map((po: MaterialPo) => (
              <div key={po.id} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                <div className="min-w-0">
                  <span className="font-medium">{po.vendorName}</span>{" "}
                  <span className="text-muted-foreground">
                    · {po.lines.map((l) => `#${l.stockId}×${l.rolls}`).join(", ")} ·{" "}
                    {new Date(po.createdAt).toLocaleDateString()}
                    {po.requestedDeliveryDate && ` · due ${po.requestedDeliveryDate}`}
                  </span>
                </div>
                <Badge
                  variant="outline"
                  className={cn(
                    "shrink-0",
                    po.status === "submitted_lt" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/40",
                    po.status === "submitted" && "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/40",
                  )}
                >
                  {po.status === "submitted_lt" ? `In Label Traxx (${po.ltPoNumbers})` : po.status}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Configuration tab — click-to-edit purchasing settings per material.
// ---------------------------------------------------------------------
function EditableCell({
  value,
  placeholder,
  numeric,
  onSave,
}: {
  value: string;
  placeholder?: string;
  numeric?: boolean;
  onSave: (v: string | null) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [v, setV] = React.useState(value);
  React.useEffect(() => setV(value), [value]);
  if (!editing) {
    return (
      <button
        type="button"
        className="block w-full text-left rounded px-1 -mx-1 py-0.5 hover:bg-accent/60 cursor-text min-h-[1.4rem] text-xs"
        title="Click to edit"
        onClick={() => setEditing(true)}
      >
        {value || <span className="text-muted-foreground/50">{placeholder ?? "—"}</span>}
      </button>
    );
  }
  return (
    <Input
      autoFocus
      type={numeric ? "number" : "text"}
      className="h-7 text-xs"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = v.trim() === "" ? null : v.trim();
        if (next !== (value || null)) onSave(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setEditing(false);
          setV(value);
        }
      }}
    />
  );
}

export function DemandConfigTab({ rows }: { rows: DemandStockMetrics[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: purch, isLoading } = useGetDemandPurchasing({ query: { queryKey: getGetDemandPurchasingQueryKey(), staleTime: 60_000 } });
  const update = useUpdateDemandConfig();
  const [q, setQ] = React.useState("");

  const metricsByStock = React.useMemo(() => new Map(rows.map((r) => [r.stockId, r])), [rows]);

  const save = async (stockId: string, patch: Record<string, unknown>) => {
    try {
      const r = await update.mutateAsync({ stockId, data: patch as never });
      await queryClient.invalidateQueries({ queryKey: getGetDemandPurchasingQueryKey() });
      toast({
        title: "Saved",
        description: r.ltUpdated ? `#${stockId} — also updated in Label Traxx` : `#${stockId} — stored as dashboard override`,
      });
    } catch (e) {
      toast({ title: "Save failed", description: String(e), variant: "destructive" });
    }
  };

  const items = (purch?.items ?? []).filter((it) => {
    if (!q.trim()) return metricsByStock.has(it.stockId);
    const needle = q.trim().toLowerCase();
    const m = metricsByStock.get(it.stockId);
    return (
      it.stockId.toLowerCase().includes(needle) ||
      (m?.description ?? "").toLowerCase().includes(needle) ||
      (it.vendorName ?? "").toLowerCase().includes(needle)
    );
  });

  if (isLoading) return <Skeleton className="h-72 rounded-lg" />;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Settings2 className="w-4 h-4 text-muted-foreground" /> Purchasing Configuration
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Click any value to edit. Vendor, MSI cost, and lead time default to the Label Traxx stock record; edits
              are stored as dashboard overrides{purch?.ltWriteEnabled ? " and written back to Label Traxx" : " (Label Traxx write-back is currently disabled)"}.
            </p>
          </div>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search stock or vendor…" className="h-8 w-56 text-xs" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground">
                <th className="text-left px-2 py-1.5 font-medium">Stock</th>
                <th className="text-left px-2 py-1.5 font-medium min-w-[10rem]">Vendor</th>
                <th className="text-left px-2 py-1.5 font-medium min-w-[14rem]">Vendor PO email(s)</th>
                <th className="text-right px-2 py-1.5 font-medium">Lead time (days)</th>
                <th className="text-right px-2 py-1.5 font-medium">Footage / roll</th>
                <th className="text-right px-2 py-1.5 font-medium">MSI cost ($)</th>
                <th className="text-right px-2 py-1.5 font-medium">Width (in)</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const m = metricsByStock.get(it.stockId);
                return (
                  <tr key={it.stockId} className="border-b last:border-b-0 align-top">
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className="font-medium">#{it.stockId}</span>
                      <div className="text-muted-foreground max-w-[16rem] truncate">{m?.description ?? it.classification ?? ""}</div>
                    </td>
                    <td className="px-2 py-1.5">
                      <EditableCell
                        value={it.vendorName ?? ""}
                        placeholder="Set vendor"
                        onSave={(v) => save(it.stockId, { vendorName: v })}
                      />
                      {it.vendorNameSource === "labeltraxx" && (
                        <span className="text-[10px] text-muted-foreground">from Label Traxx</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <EditableCell
                        value={it.vendorEmails ?? ""}
                        placeholder="orders@vendor.com"
                        onSave={(v) => save(it.stockId, { vendorEmails: v })}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <EditableCell
                        numeric
                        value={it.leadTimeDaysOverride != null ? String(it.leadTimeDaysOverride) : ""}
                        placeholder={m ? `auto ${fmt(m.avgLeadTimeDays)}` : "—"}
                        onSave={(v) => save(it.stockId, { leadTimeDays: v == null ? null : Number(v) })}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <EditableCell
                        numeric
                        value={it.typicalRollFootageOverride != null ? String(it.typicalRollFootageOverride) : ""}
                        placeholder={m ? `auto ${fmt(m.typicalRollFootage)}` : "—"}
                        onSave={(v) => save(it.stockId, { typicalRollFootage: v == null ? null : Number(v) })}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <EditableCell
                        numeric
                        value={it.msiCost != null && it.msiCostSource === "override" ? String(it.msiCost) : ""}
                        placeholder={it.msiCostSource === "labeltraxx" ? `LT ${it.msiCost}` : "—"}
                        onSave={(v) => save(it.stockId, { msiCost: v == null ? null : Number(v) })}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">{it.masterWidth || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
