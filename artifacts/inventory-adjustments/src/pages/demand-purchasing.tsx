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
  useUpdateMaterialPo,
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
import { Mail, Send, ShoppingCart, Ticket, CheckCircle2, Settings2, Printer, ExternalLink, X, PackageCheck } from "lucide-react";
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

type PoDocLine = {
  stockId: string;
  description: string | null;
  rolls: number;
  footage: number | null;
  msiCost: number | null;
};

/**
 * Open a print-ready PO document styled after the Label Traxx stock PO form
 * (header, supplier/ship-to blocks, per-material spec + roll table, MSI /
 * weight / price totals). Print → Save as PDF.
 */
function openPoDocument(opts: {
  poNumber: string;
  vendorName: string;
  vendorEmails: string | null;
  orderedDate: string;
  requestedDeliveryDate: string | null;
  lines: PoDocLine[];
  purchByStock: Map<string, PurchasingItem>;
}) {
  const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  let grandTotal = 0;

  const sections = opts.lines
    .map((l) => {
      const it = opts.purchByStock.get(l.stockId);
      const width = it?.masterWidth ?? 0;
      const footagePerRoll = l.footage && l.rolls > 0 ? l.footage / l.rolls : 0;
      const totalFootage = l.footage ?? 0;
      const msi = width > 0 ? (totalFootage * 12 * width) / 1000 : 0;
      const cost = l.msiCost ?? it?.msiCost ?? 0;
      const price = msi * cost;
      grandTotal += price;
      const weight = it?.areaToWeightFactor ? msi / it.areaToWeightFactor : 0;
      const rollRows = Array.from({ length: Math.min(l.rolls, 60) })
        .map(
          (_, i) =>
            `<tr><td>${i + 1}</td><td>${num(footagePerRoll)}</td><td>${width || "—"}</td><td class="c">X</td></tr>`,
        )
        .join("");
      return `
      <div class="material">
        <table class="spec">
          <tr><th>Our Stock No.</th><td>${l.stockId}</td><th>MFG Spec. No.</th><td>${it?.mfgSpecNum ?? "—"}</td></tr>
          <tr><th>Face Stock</th><td>${it?.faceStock ?? l.description ?? "—"}</td><th>Color</th><td>${it?.faceColor ?? "—"}</td></tr>
          <tr><th>Adhesive</th><td>${it?.adhesive ?? "—"}</td><th>Top Coating</th><td>${it?.topCoat || "None"}</td></tr>
          <tr><th>Master Width</th><td>${width ? `${width}"` : "—"}</td><th>Cost Per MSI</th><td>${cost ? money(cost) : "—"}</td></tr>
          <tr><th>Ordered</th><td>${l.rolls} roll${l.rolls === 1 ? "" : "s"} · Exact Rolls</td><th>Req. Delivery</th><td>${opts.requestedDeliveryDate ?? "—"}</td></tr>
        </table>
        <table class="rolls">
          <thead><tr><th>No.</th><th>Ordered (ft)</th><th>Width (in)</th><th>Exact</th></tr></thead>
          <tbody>${rollRows}</tbody>
        </table>
        <p class="totals">
          Total: ${num(totalFootage)} ft · Area (MSI): ${num(msi)}${weight ? ` · Weight: ${num(weight)} lb.` : ""} ·
          <strong>Purchase Price: ${money(price)}</strong>
        </p>
      </div>`;
    })
    .join("");

  const html = `<!doctype html><html><head><title>PO ${opts.poNumber} — ${opts.vendorName}</title>
  <style>
    body { font-family: Helvetica, Arial, sans-serif; font-size: 11px; color: #111; margin: 32px; }
    h1 { font-size: 18px; margin: 0; letter-spacing: 1px; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 8px; }
    .head table td { padding: 1px 8px 1px 0; }
    .blocks { display: flex; gap: 32px; margin: 14px 0; }
    .block { flex: 1; }
    .block h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px; border-bottom: 1px solid #999; padding-bottom: 2px; }
    .material { margin-top: 14px; page-break-inside: avoid; }
    table.spec { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
    table.spec th { text-align: left; font-size: 9px; text-transform: uppercase; color: #555; padding: 2px 6px 2px 0; width: 12%; }
    table.spec td { padding: 2px 12px 2px 0; width: 38%; }
    table.rolls { border-collapse: collapse; width: 60%; }
    table.rolls th, table.rolls td { border: 1px solid #bbb; padding: 2px 8px; text-align: right; font-size: 10px; }
    table.rolls th { background: #f0f0f0; font-size: 9px; text-transform: uppercase; }
    table.rolls td.c { text-align: center; }
    .totals { margin: 6px 0 0; }
    .grand { margin-top: 16px; border-top: 2px solid #111; padding-top: 8px; text-align: right; font-size: 13px; }
    .foot { margin-top: 24px; font-size: 10px; color: #444; }
    @media print { body { margin: 12mm; } }
  </style></head><body>
  <div class="head">
    <div><h1>PURCHASE ORDER</h1><div style="font-size:12px;margin-top:2px;">Calyx Containers</div></div>
    <table>
      <tr><td><strong>Purchase Order</strong></td><td>${opts.poNumber}</td></tr>
      <tr><td><strong>Ordered</strong></td><td>${opts.orderedDate}</td></tr>
      <tr><td><strong>Req. Delivery</strong></td><td>${opts.requestedDeliveryDate ?? "—"}</td></tr>
      <tr><td><strong>Type</strong></td><td>New Order · Stock</td></tr>
    </table>
  </div>
  <div class="blocks">
    <div class="block"><h3>Supplier</h3>${opts.vendorName}${opts.vendorEmails ? `<br/>${opts.vendorEmails}` : ""}</div>
    <div class="block"><h3>Ship To</h3>Calyx Containers<br/>1991 Parkway Blvd<br/>West Valley City, UT 84119<br/>USA<br/>1 (888) 432-7766</div>
  </div>
  ${sections}
  <div class="grand"><strong>Total Purchase Price: ${money(grandTotal)}</strong></div>
  <div class="foot">Cuts are in inches · Area (MSI) · Questions: ctimmons@calyxcontainers.com</div>
  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
  </body></html>`;

  const w = window.open("", "_blank", "width=920,height=1100");
  if (!w) return;
  w.document.write(html);
  w.document.close();
}

// ---------------------------------------------------------------------
// Overview section: ticket-status donut + clickable on-hand vs open-ticket
// requirements comparison chart.
// ---------------------------------------------------------------------
export function TicketCompareSection({ rows }: { rows: DemandStockMetrics[] }) {
  const [, navigate] = useLocation();
  const [unit, setUnit] = React.useState<"ft" | "usd">("ft");
  const [selectedStock, setSelectedStock] = React.useState<string | null>(null);
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
        // footage → $ via MSI × (cost + freight); 0 when cost/width unknown
        const rate =
          it.msiCost != null && (it.masterWidth ?? 0) > 0
            ? ((it.msiCost + (it.freightMsi ?? 0)) * 12 * (it.masterWidth ?? 0)) / 1000
            : 0;
        const cv = (ft: number) => (unit === "usd" ? Math.round(ft * rate) : Math.round(ft));
        const shortFt = Math.max(0, (it.openTicketFootage ?? 0) - (m?.onHandFootage ?? 0) - (m?.openPoFootage ?? 0));
        return {
          stockId: it.stockId,
          name: `#${it.stockId}`,
          description: m?.description ?? it.classification ?? "",
          onHand: cv(m?.onHandFootage ?? 0),
          required: cv(it.openTicketFootage ?? 0),
          onOrder: cv(m?.openPoFootage ?? 0),
          short: Math.round(shortFt),
          shortUsd: Math.round(shortFt * rate),
        };
      })
      .sort((a, b) => b.required - a.required)
      .slice(0, 16);
    return entries;
  }, [data, rows, unit]);

  const uncoveredUsd = React.useMemo(() => chartData.reduce((s2, d) => s2 + d.shortUsd, 0), [chartData]);
  const selectedItem = selectedStock ? (data?.items ?? []).find((it) => it.stockId === selectedStock) : null;

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
                {unit === "usd" ? "Material value" : "Footage"} by stock — click a bar to see its tickets
                {shortCount > 0 && (
                  <span className="text-red-600 dark:text-red-400 font-medium">
                    {" "}· {shortCount} short{uncoveredUsd > 0 ? ` (~$${fmt(uncoveredUsd)} uncovered)` : ""}
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center rounded-md border overflow-hidden">
              {(["ft", "usd"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setUnit(u)}
                  className={cn(
                    "px-2.5 py-1 text-xs font-medium",
                    unit === u ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {u === "ft" ? "Feet" : "$"}
                </button>
              ))}
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
                    if (stockId) setSelectedStock((prev) => (prev === stockId ? null : stockId));
                  }}
                  className="cursor-pointer"
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="currentColor" opacity={0.1} />
                  <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${fmt(v / 1000)}k`} />
                  <YAxis type="category" dataKey="name" width={52} tick={{ fontSize: 11 }} />
                  <ReTooltip
                    formatter={(v: number, name: string) => [unit === "usd" ? `$${fmt(v)}` : `${fmt(v)} ft`, name]}
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
          {selectedItem && (
            <div className="mt-3 rounded-md border">
              <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/40">
                <span className="text-xs font-semibold">
                  Open tickets needing #{selectedItem.stockId} · {fmt(selectedItem.openTicketFootage)} ft across{" "}
                  {selectedItem.openTicketCount} ticket{selectedItem.openTicketCount === 1 ? "" : "s"}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                    onClick={() => navigate(`/demand/${selectedItem.stockId}`)}
                  >
                    <ExternalLink className="w-3 h-3" /> Stock detail
                  </button>
                  <button
                    type="button"
                    title="Close"
                    className="text-muted-foreground hover:text-foreground p-0.5"
                    onClick={() => setSelectedStock(null)}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="max-h-56 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left px-3 py-1 font-medium">Ticket</th>
                      <th className="text-left px-3 py-1 font-medium">Job</th>
                      <th className="text-right px-3 py-1 font-medium">Footage</th>
                      <th className="text-left px-3 py-1 font-medium">Stock status</th>
                      <th className="text-right px-3 py-1 font-medium">Ship by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedItem.tickets ?? []).map((t) => (
                      <tr key={t.ticketNumber} className="border-b last:border-b-0">
                        <td className="px-3 py-1 font-medium">#{t.ticketNumber}</td>
                        <td className="px-3 py-1 text-muted-foreground truncate max-w-[16rem]">{t.description ?? "—"}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{fmt(t.estFootage)} ft</td>
                        <td className="px-3 py-1">
                          <span
                            className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                            style={{ background: TICKET_STATUS_COLORS[t.stockIn] ?? "#94a3b8" }}
                          />
                          {t.stockIn}
                        </td>
                        <td className="px-3 py-1 text-right tabular-nums">{t.shipByDate ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
  const updatePo = useUpdateMaterialPo();

  const purchByStock = React.useMemo(
    () => new Map((purch?.items ?? []).map((it) => [it.stockId, it])),
    [purch],
  );

  const printPo = (po: MaterialPo) =>
    openPoDocument({
      poNumber: po.ltPoNumbers || `DRAFT-${po.id.slice(0, 6).toUpperCase()}`,
      vendorName: po.vendorName,
      vendorEmails: po.vendorEmails ?? null,
      orderedDate: new Date(po.createdAt).toLocaleDateString(),
      requestedDeliveryDate: po.requestedDeliveryDate ?? null,
      lines: po.lines.map((l) => ({
        stockId: l.stockId,
        description: l.description ?? null,
        rolls: l.rolls,
        footage: l.footage ?? null,
        msiCost: l.msiCost ?? null,
      })),
      purchByStock,
    });

  const attachLtNumber = async (po: MaterialPo, value: string | null) => {
    try {
      await updatePo.mutateAsync({ id: po.id, data: { ltPoNumbers: value } });
      await queryClient.invalidateQueries({ queryKey: getListMaterialPosQueryKey() });
      toast({ title: "LT PO linked", description: value ? `Tracking receipt of LT PO ${value}` : "Link cleared" });
    } catch (e) {
      toast({ title: "Failed", description: String(e), variant: "destructive" });
    }
  };
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
                    <span className="text-muted-foreground">·</span>
                    <button
                      type="button"
                      className="text-primary hover:underline inline-flex items-center gap-1"
                      onClick={() => {
                        const po = poList?.items.find((p) => p.id === email.poId);
                        if (po) printPo(po);
                      }}
                    >
                      <Printer className="w-3.5 h-3.5" /> Print PO PDF
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
              <div key={po.id} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-xs flex-wrap">
                <div className="min-w-0">
                  <span className="font-medium">{po.vendorName}</span>{" "}
                  <span className="text-muted-foreground">
                    · {po.lines.map((l) => `#${l.stockId}×${l.rolls}`).join(", ")} ·{" "}
                    {new Date(po.createdAt).toLocaleDateString()}
                    {po.requestedDeliveryDate && ` · due ${po.requestedDeliveryDate}`}
                  </span>
                  {po.status === "received" && (
                    <div className="mt-0.5 text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                      <PackageCheck className="w-3.5 h-3.5" /> Received {po.receivedOn}
                      {po.actualLeadDays != null && ` · ${po.actualLeadDays}d actual lead time`}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">LT PO #</span>
                    <Input
                      defaultValue={po.ltPoNumbers ?? ""}
                      placeholder="—"
                      className="h-6 w-20 text-xs"
                      onBlur={(e) => {
                        const v = e.target.value.trim() || null;
                        if (v !== (po.ltPoNumbers ?? null)) void attachLtNumber(po, v);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  </div>
                  <button
                    type="button"
                    title="Print PO document"
                    className="text-primary hover:text-primary/80 p-1"
                    onClick={() => printPo(po)}
                  >
                    <Printer className="w-3.5 h-3.5" />
                  </button>
                  <Badge
                    variant="outline"
                    className={cn(
                      po.status === "received" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/40",
                      po.status === "submitted_lt" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/40",
                      po.status === "submitted" && "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/40",
                    )}
                  >
                    {po.status === "submitted_lt" ? `In Label Traxx (${po.ltPoNumbers})` : po.status}
                  </Badge>
                </div>
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
