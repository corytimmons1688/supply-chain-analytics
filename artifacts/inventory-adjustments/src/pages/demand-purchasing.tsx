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
import { Mail, Send, ShoppingCart, Ticket, Settings2, Printer, ExternalLink, X, PackageCheck, BarChart3, LayoutGrid } from "lucide-react";
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
  Out: "#4338ca",
  "Not Evaluated": "#94a3b8",
  "Without Tickets": "#9ca3af",
};

// Donut/legend order — availability statuses, best → worst.
const STATUS_ORDER = ["In", "Ordered", "Ordered Not Confirmed", "Out"] as const;

// Corner-flag markers (drawn as small triangles on each bar), matching the
// Batched Material Availability layout.
const MARKER_COLORS = {
  withoutTickets: "#fb7185", // coral
  belowMin: "#3b82f6", // blue
  aboveMax: "#a855f7", // purple
} as const;

type PoDocData = {
  poNumber: string;
  isDraft: boolean;
  orderedDate: string;
  requestedDeliveryDate: string | null;
  type: string;
  supplier: {
    company: string;
    customerId: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
    phone: string | null;
    fax: string | null;
    terms: string | null;
  };
  shipTo: { name: string; address1: string; city: string; state: string; zip: string; country: string; phone: string };
  material: {
    stockId: string;
    vendorPartNum: string | null;
    description: string | null;
    mfgSpecNum: string | null;
    masterWidth: number;
    costMsi: number;
    color: string | null;
    adhesive: string | null;
    topCoat: string | null;
  };
  rolls: { no: number; footage: number; width: number }[];
  totals: { rolls: number; areaMsi: number; purchasePrice: number; weight: number };
};

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Fetch a PO's assembled document data and render it into `win` in the
 * Label Traxx stock-PO layout (one material per PO — see PO 2590): header
 * fields, supplier + ship-to blocks, material spec, numbered slitting table,
 * and MSI / weight / price totals. The window is opened by the caller (sync,
 * to dodge popup blockers); this fills it once the data lands.
 */
async function openPoDocument(win: Window, poId: string): Promise<void> {
  win.document.write("<!doctype html><title>Purchase Order</title><body style='font:13px Helvetica,Arial;padding:40px'>Generating purchase order…</body>");
  win.document.close();
  let d: PoDocData;
  try {
    const res = await fetch(`/api/demand/pos/${poId}/document`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    d = (await res.json()) as PoDocData;
  } catch (e) {
    win.document.body.innerHTML = `Could not load PO document: ${esc(e instanceof Error ? e.message : String(e))}`;
    return;
  }

  const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const m = d.material;
  const supAddr = [
    d.supplier.address1,
    d.supplier.address2,
    [d.supplier.city, d.supplier.state, d.supplier.zip].filter(Boolean).join(", "),
    d.supplier.country,
  ]
    .filter(Boolean)
    .map((l) => esc(l))
    .join("<br/>");

  const rollRows = d.rolls
    .map(
      (r) =>
        `<tr><td class="c">${r.no}</td><td>${num(r.footage)}</td><td class="c">0</td>` +
        `<td class="c">1</td><td>${r.width || "—"}</td>` +
        `<td class="c">0</td><td></td><td class="c">0</td><td></td><td class="c">0</td><td></td><td class="c">0</td></tr>`,
    )
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>PO ${esc(d.poNumber)} — ${esc(d.supplier.company)}</title>
  <style>
    body { font-family: Helvetica, Arial, sans-serif; font-size: 11px; color: #111; margin: 28px; }
    .title { font-size: 20px; font-weight: bold; letter-spacing: 1px; }
    .draft { color: #b45309; font-size: 11px; font-weight: normal; }
    table.hdr { border-collapse: collapse; margin-top: 6px; }
    table.hdr td { border: 1px solid #333; padding: 3px 10px; font-size: 10px; }
    table.hdr td.l { background: #f0f0f0; font-weight: bold; text-transform: uppercase; font-size: 9px; }
    .blocks { display: flex; gap: 24px; margin: 14px 0 6px; }
    .block { flex: 1; border: 1px solid #999; padding: 8px 10px; }
    .block h3 { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 5px; color: #555; }
    .spec { width: 100%; border-collapse: collapse; margin: 10px 0 4px; }
    .spec th { text-align: left; font-size: 8.5px; text-transform: uppercase; color: #555; padding: 2px 6px 2px 0; white-space: nowrap; width: 1%; }
    .spec td { padding: 2px 18px 2px 0; font-weight: 600; }
    table.rolls { border-collapse: collapse; width: 100%; margin-top: 6px; }
    table.rolls th, table.rolls td { border: 1px solid #bbb; padding: 2px 6px; text-align: right; font-size: 9.5px; }
    table.rolls td.c, table.rolls th.c { text-align: center; }
    table.rolls th { background: #f0f0f0; font-size: 8px; text-transform: uppercase; }
    .totals { display: flex; justify-content: flex-end; gap: 28px; margin-top: 10px; border-top: 2px solid #111; padding-top: 8px; font-size: 12px; }
    .foot { margin-top: 20px; font-size: 9px; color: #666; }
    @media print { body { margin: 12mm; } }
  </style></head><body>
  <div style="display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <div class="title">Purchase Order${d.isDraft ? ' <span class="draft">(DRAFT — not yet in Label Traxx)</span>' : ""}</div>
      <div style="font-size:12px;margin-top:2px">Calyx Containers</div>
    </div>
    <table class="hdr"><tbody>
      <tr><td class="l">Order Date</td><td>${esc(d.orderedDate)}</td><td class="l">P.O. Number</td><td>${esc(d.poNumber)}</td></tr>
      <tr><td class="l">Req. Delivery</td><td>${esc(d.requestedDeliveryDate ?? "—")}</td><td class="l">Type</td><td>${esc(d.type)} · Stock</td></tr>
      <tr><td class="l">Promised</td><td>00/00/00</td><td class="l">Terms</td><td>${esc(d.supplier.terms ?? "—")}</td></tr>
    </tbody></table>
  </div>

  <div class="blocks">
    <div class="block">
      <h3>Supplier</h3>
      <strong>${esc(d.supplier.company)}</strong>${d.supplier.customerId ? `<br/>ID: ${esc(d.supplier.customerId)}` : ""}
      ${supAddr ? `<br/>${supAddr}` : ""}
      ${d.supplier.phone ? `<br/>Ph. ${esc(d.supplier.phone)}` : ""}${d.supplier.fax ? ` · Fax ${esc(d.supplier.fax)}` : ""}
    </div>
    <div class="block">
      <h3>Ship To</h3>
      <strong>${esc(d.shipTo.name)}</strong><br/>${esc(d.shipTo.address1)}<br/>
      ${esc(d.shipTo.city)}, ${esc(d.shipTo.state)} ${esc(d.shipTo.zip)}<br/>${esc(d.shipTo.country)}<br/>${esc(d.shipTo.phone)}
    </div>
  </div>

  <table class="spec"><tbody>
    <tr><th>Our Stock No.</th><td>${esc(m.stockId)}</td><th>MFG Spec. No.</th><td>${esc(m.mfgSpecNum ?? "—")}</td><th>Vendor Part No.</th><td>${esc(m.vendorPartNum ?? "—")}</td></tr>
    <tr><th>Face Stock</th><td colspan="3">${esc(m.description ?? "—")}</td><th>Master Width</th><td>${m.masterWidth ? esc(m.masterWidth) + '"' : "—"}</td></tr>
    <tr><th>Color</th><td>${esc(m.color ?? "—")}</td><th>Adhesive</th><td>${esc(m.adhesive ?? "—")}</td><th>Top Coating</th><td>${esc(m.topCoat ?? "None")}</td></tr>
    <tr><th>Ordered</th><td>${d.totals.rolls} roll${d.totals.rolls === 1 ? "" : "s"} · Exact Rolls</td><th>Cost Per MSI</th><td>${d.material.costMsi ? "$" + d.material.costMsi.toFixed(5) : "—"}</td><th>&nbsp;</th><td>&nbsp;</td></tr>
  </tbody></table>

  <table class="rolls">
    <thead><tr>
      <th class="c">Roll</th><th>Ordered (ft)</th><th class="c">Received</th>
      <th class="c">No.</th><th>1st Cut</th><th class="c">No.</th><th>2nd Cut</th>
      <th class="c">No.</th><th>3rd Cut</th><th class="c">No.</th><th>4th Cut</th><th class="c">O'Cut</th>
    </tr></thead>
    <tbody>${rollRows}</tbody>
  </table>

  <div class="totals">
    <span>Master Rolls: <strong>${d.totals.rolls}</strong></span>
    <span>Area (MSI): <strong>${num(d.totals.areaMsi)}</strong></span>
    ${d.totals.weight ? `<span>Weight: <strong>${num(d.totals.weight)} lb.</strong></span>` : ""}
    <span>Purchase Price: <strong>${money(d.totals.purchasePrice)}</strong></span>
  </div>
  <div class="foot">Cuts are in inches · Area (MSI) · Generated by Calyx Supply Chain Dashboard · ctimmons@calyxcontainers.com</div>
  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 350));</script>
  </body></html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

// ---------------------------------------------------------------------
// Overview section: ticket-status donut + clickable on-hand vs open-ticket
// requirements comparison chart.
// ---------------------------------------------------------------------
type CompareDatum = {
  stockId: string;
  name: string;
  description: string;
  width: number;
  vendorName: string | null;
  onHand: number;
  required: number;
  onOrder: number;
  available: number;
  min: number;
  max: number;
  short: number;
  shortUsd: number;
};

/** Rich hover card for the comparison chart — mirrors the LT dashboard tooltip. */
function CompareTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: { payload: CompareDatum }[];
  unit: "ft" | "usd";
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0]!.payload;
  const u = (n: number) => (unit === "usd" ? `$${fmt(n)}` : `${fmt(n)} ft`);
  const cell = (label: string, value: React.ReactNode) => (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
  return (
    <div className="rounded-md border bg-background shadow-lg p-3 text-xs max-w-[20rem]">
      <div className="font-semibold">
        #{d.stockId} · {d.width ? `${d.width}"` : "width —"}
      </div>
      <div className="text-muted-foreground truncate mb-2">{d.description}</div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2">
        {cell("Quantity in Inventory", u(d.onHand))}
        {cell("Quantity Ordered", u(d.onOrder))}
        {cell("Quantity Required", u(d.required))}
        {cell(
          "Quantity Available",
          <span className={cn(d.available < 0 && "text-red-600 dark:text-red-400")}>{u(d.available)}</span>,
        )}
        {cell("Min (reorder point)", d.min > 0 ? u(d.min) : "—")}
        {cell("Max", d.max > 0 ? u(d.max) : "—")}
      </div>
      {d.vendorName && <div className="mt-2 text-muted-foreground">Vendor: {d.vendorName}</div>}
      <div className="mt-1 text-[10px] text-muted-foreground">Click to see the tickets driving this demand</div>
    </div>
  );
}

export function TicketCompareSection({ rows }: { rows: DemandStockMetrics[] }) {
  const [, navigate] = useLocation();
  const [unit, setUnit] = React.useState<"ft" | "usd">("ft");
  const [widthFilter, setWidthFilter] = React.useState<string>("all");
  const [statusFilters, setStatusFilters] = React.useState<string[]>([]);
  const toggleStatus = React.useCallback(
    (name: string) =>
      setStatusFilters((prev) => (prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name])),
    [],
  );
  const [selectedStock, setSelectedStock] = React.useState<string | null>(null);
  const [summaryView, setSummaryView] = React.useState<"bars" | "grid">("bars");
  const { data, isLoading } = useGetDemandPurchasing({ query: { queryKey: getGetDemandPurchasingQueryKey(), staleTime: 60_000 } });

  const widthOptions = React.useMemo(() => {
    const widths = new Set<number>();
    for (const it of data?.items ?? []) {
      if ((it.openTicketFootage ?? 0) > 0 && (it.masterWidth ?? 0) > 0) widths.add(it.masterWidth!);
    }
    return [...widths].sort((a, b) => a - b);
  }, [data]);

  const chartData = React.useMemo<CompareDatum[]>(() => {
    const metricsByStock = new Map(rows.map((r) => [r.stockId, r]));
    const entries = (data?.items ?? [])
      .filter((it) => (it.openTicketFootage ?? 0) > 0)
      .filter((it) => widthFilter === "all" || String(it.masterWidth ?? 0) === widthFilter)
      .map((it) => {
        const m = metricsByStock.get(it.stockId);
        // footage → $ via MSI × (cost + freight); 0 when cost/width unknown
        const rate =
          it.msiCost != null && (it.masterWidth ?? 0) > 0
            ? ((it.msiCost + (it.freightMsi ?? 0)) * 12 * (it.masterWidth ?? 0)) / 1000
            : 0;
        const cv = (ft: number) => (unit === "usd" ? Math.round(ft * rate) : Math.round(ft));
        const width = it.masterWidth ?? 0;
        const shortFt = Math.max(0, (it.openTicketFootage ?? 0) - (m?.onHandFootage ?? 0) - (m?.openPoFootage ?? 0));
        const availableFt = (m?.onHandFootage ?? 0) + (m?.openPoFootage ?? 0) - (it.openTicketFootage ?? 0);
        return {
          stockId: it.stockId,
          name: width ? `#${it.stockId} · ${width}"` : `#${it.stockId}`,
          description: m?.description ?? it.classification ?? "",
          width,
          vendorName: it.vendorName ?? null,
          onHand: cv(m?.onHandFootage ?? 0),
          required: cv(it.openTicketFootage ?? 0),
          onOrder: cv(m?.openPoFootage ?? 0),
          available: cv(availableFt),
          min: cv(m?.reorderPointFootage ?? 0),
          max: cv(m?.maxFootage ?? 0),
          short: Math.round(shortFt),
          shortUsd: Math.round(shortFt * rate),
        };
      })
      .sort((a, b) => b.required - a.required)
      .slice(0, 16);
    return entries;
  }, [data, rows, unit, widthFilter]);

  const uncoveredUsd = React.useMemo(() => chartData.reduce((s2, d) => s2 + d.shortUsd, 0), [chartData]);
  const selectedItem = selectedStock ? (data?.items ?? []).find((it) => it.stockId === selectedStock) : null;

  // Per-stock totals for hover cards and the drill-down strip (unit-aware).
  const totalsById = React.useMemo(() => {
    const metricsByStock = new Map(rows.map((r) => [r.stockId, r]));
    const m2 = new Map<
      string,
      { onHand: number; onOrder: number; required: number; available: number; min: number; max: number }
    >();
    for (const it of data?.items ?? []) {
      const m = metricsByStock.get(it.stockId);
      const rate =
        it.msiCost != null && (it.masterWidth ?? 0) > 0
          ? ((it.msiCost + (it.freightMsi ?? 0)) * 12 * (it.masterWidth ?? 0)) / 1000
          : 0;
      const cv = (ft: number) => (unit === "usd" ? Math.round(ft * rate) : Math.round(ft));
      const availableFt = (m?.onHandFootage ?? 0) + (m?.openPoFootage ?? 0) - (it.openTicketFootage ?? 0);
      m2.set(it.stockId, {
        onHand: cv(m?.onHandFootage ?? 0),
        onOrder: cv(m?.openPoFootage ?? 0),
        required: cv(it.openTicketFootage ?? 0),
        available: cv(availableFt),
        min: cv(m?.reorderPointFootage ?? 0),
        max: cv(m?.maxFootage ?? 0),
      });
    }
    return m2;
  }, [data, rows, unit]);

  // One row per material; one bar per roll WIDTH on hand (production view).
  // Status is now computed server-side (inventory → POs → shortfall) so it no
  // longer depends on Label Traxx's un-run StockIn field.
  const summaryRows = React.useMemo(() => {
    const metricsByStock = new Map(rows.map((r) => [r.stockId, r]));
    return (data?.items ?? [])
      .map((it) => {
        const hasTix = (it.openTicketCount ?? 0) > 0;
        const status = it.withoutTickets ? "Without Tickets" : it.computedStatus ?? "In";
        let segs = (it.widthsOnHand ?? []).filter(
          (w) => widthFilter === "all" || String(w.width) === widthFilter,
        );
        // Out-of-stock materials with open tickets still get a zero bar so
        // production sees the gap.
        if (segs.length === 0 && hasTix && (it.widthsOnHand ?? []).length === 0) {
          const mw = it.masterWidth ?? 0;
          if (widthFilter === "all" || String(mw) === widthFilter) {
            segs = [{ width: mw, footage: 0, rolls: 0 }];
          }
        }
        // Below Min / Above Max flags now share the reorder engine's computed
        // Min (reorder point) and Max, in footage — one source of truth instead
        // of Label Traxx's separately-maintained MSI thresholds.
        const m = metricsByStock.get(it.stockId);
        const onHandFt = m?.onHandFootage ?? 0;
        const rop = m?.reorderPointFootage ?? 0;
        const max = m?.maxFootage ?? 0;
        return {
          stockId: it.stockId,
          description: m?.description ?? it.classification ?? "",
          status,
          noTickets: !hasTix,
          belowMin: rop > 0 && onHandFt < rop,
          aboveMax: max > 0 && onHandFt > max,
          segs,
        };
      })
      .filter((r) => r.segs.length > 0)
      .filter((r) => statusFilters.length === 0 || statusFilters.includes(r.status))
      .sort((a, b) => a.stockId.localeCompare(b.stockId, undefined, { numeric: true }));
  }, [data, rows, widthFilter, statusFilters]);


  const donutData = React.useMemo(() => {
    const counts = data?.statusCounts ?? {};
    // Fixed best→worst order so colours/legend stay stable run to run.
    const ordered = STATUS_ORDER.filter((n) => (counts[n] ?? 0) > 0).map((name) => ({
      name: name as string,
      value: counts[name]!,
    }));
    // Any status the server emits that isn't in STATUS_ORDER (defensive).
    for (const [name, value] of Object.entries(counts)) {
      if (!STATUS_ORDER.includes(name as (typeof STATUS_ORDER)[number]) && value > 0) {
        ordered.push({ name, value });
      }
    }
    return ordered;
  }, [data]);
  const totalTickets = donutData.reduce((s, d) => s + d.value, 0);
  const shortCount = chartData.filter((d) => d.short > 0).length;

  if (isLoading) return <Skeleton className="h-72 rounded-lg" />;
  if (!data) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Ticket className="w-4 h-4 text-muted-foreground" /> Ticket Stock Availability Status
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Availability computed across {totalTickets} open ticket{totalTickets === 1 ? "" : "s"} —
            inventory, then POs, then shortfall · click a status to filter
          </p>
        </CardHeader>
        <CardContent>
          <div className="relative h-56 [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none [&_svg]:focus:outline-none">
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
                  className="cursor-pointer focus:outline-none"
                  onClick={(d: { name?: string }) => d?.name && toggleStatus(d.name)}
                >
                  {donutData.map((d) => (
                    <Cell
                      key={d.name}
                      fill={TICKET_STATUS_COLORS[d.name] ?? "#94a3b8"}
                      opacity={statusFilters.length > 0 && !statusFilters.includes(d.name) ? 0.3 : 1}
                      style={{ outline: "none" }}
                    />
                  ))}
                </Pie>
                <ReTooltip formatter={(v: number, n: string) => [`${v} tickets`, n]} />
                <Legend verticalAlign="bottom" height={40} iconSize={9} wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
            {/* Center total, matching Batched's donut. Offset up to clear the legend. */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center -translate-y-3">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</span>
              <span className="text-2xl font-semibold tabular-nums leading-none">{totalTickets}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base">Stock Inventory Summary</CardTitle>
              <p className="text-xs text-muted-foreground">
                On-hand roll widths per material, colored by computed availability — click a material for
                its tickets
                {shortCount > 0 && (
                  <span className="text-red-600 dark:text-red-400 font-medium">
                    {" "}· {shortCount} short{uncoveredUsd > 0 ? ` (~$${fmt(uncoveredUsd)} uncovered)` : ""}
                  </span>
                )}
                {statusFilters.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="ml-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] hover:bg-accent"
                    onClick={() => toggleStatus(s)}
                  >
                    {s} <X className="w-2.5 h-2.5" />
                  </button>
                ))}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={widthFilter}
                onChange={(e) => setWidthFilter(e.target.value)}
                className="h-7 rounded-md border bg-background px-2 text-xs text-foreground"
                title="Filter by master width"
              >
                <option value="all">All widths</option>
                {widthOptions.map((w) => (
                  <option key={w} value={String(w)}>
                    {w}&quot;
                  </option>
                ))}
              </select>
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
              <div className="flex items-center rounded-md border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setSummaryView("bars")}
                  title="Bar view"
                  className={cn(
                    "px-2 py-1",
                    summaryView === "bars" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  <BarChart3 className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setSummaryView("grid")}
                  title="Grid view"
                  className={cn(
                    "px-2 py-1",
                    summaryView === "grid" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
          {/* Legend: availability statuses + corner-flag markers (Batched parity). */}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
            {STATUS_ORDER.map((s) => (
              <span key={s} className="inline-flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: TICKET_STATUS_COLORS[s] }} />
                {s}
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block w-0 h-0"
                style={{ borderTop: `9px solid ${MARKER_COLORS.withoutTickets}`, borderLeft: "9px solid transparent" }}
              />
              Without Tickets
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block w-0 h-0"
                style={{ borderBottom: `9px solid ${MARKER_COLORS.belowMin}`, borderRight: "9px solid transparent" }}
              />
              Below Min
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block w-0 h-0"
                style={{ borderTop: `9px solid ${MARKER_COLORS.aboveMax}`, borderRight: "9px solid transparent" }}
              />
              Above Max
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {summaryRows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No materials match the current filters.
            </p>
          ) : summaryView === "bars" ? (
            <div className="max-h-[26rem] overflow-y-auto rounded-md border divide-y">
              {summaryRows.map((r) => {
                const totals = totalsById.get(r.stockId);
                return (
                  <div
                    key={r.stockId}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedStock((prev) => (prev === r.stockId ? null : r.stockId))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setSelectedStock((prev) => (prev === r.stockId ? null : r.stockId));
                    }}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-1.5 cursor-pointer hover:bg-accent/40",
                      selectedStock === r.stockId && "bg-accent/50",
                    )}
                  >
                    <div className="w-28 shrink-0">
                      <div className="text-xs font-semibold">#{r.stockId}</div>
                      <div className="text-[10px] text-muted-foreground truncate" title={r.description}>
                        {r.description}
                      </div>
                    </div>
                    <div className="flex-1 flex items-center gap-1.5 flex-wrap py-0.5">
                      {r.segs.map((sg) => (
                        <div key={`${r.stockId}-${sg.width}`} className="relative group">
                          <div
                            className="relative h-6 w-24 rounded-sm flex items-center justify-center text-[11px] font-semibold text-white overflow-hidden"
                            style={{
                              background: TICKET_STATUS_COLORS[r.status] ?? "#94a3b8",
                            }}
                          >
                            {sg.width > 0 ? `${sg.width}"` : "0 ft"}
                            {/* Corner-flag markers, matching Batched. */}
                            {r.noTickets && (
                              <span
                                className="absolute top-0 right-0 w-0 h-0"
                                style={{
                                  borderTop: `9px solid ${MARKER_COLORS.withoutTickets}`,
                                  borderLeft: "9px solid transparent",
                                }}
                              />
                            )}
                            {r.aboveMax && (
                              <span
                                className="absolute top-0 left-0 w-0 h-0"
                                style={{
                                  borderTop: `9px solid ${MARKER_COLORS.aboveMax}`,
                                  borderRight: "9px solid transparent",
                                }}
                              />
                            )}
                            {r.belowMin && (
                              <span
                                className="absolute bottom-0 left-0 w-0 h-0"
                                style={{
                                  borderBottom: `9px solid ${MARKER_COLORS.belowMin}`,
                                  borderRight: "9px solid transparent",
                                }}
                              />
                            )}
                          </div>
                          <div className="pointer-events-none absolute z-30 hidden group-hover:block top-7 left-0 w-64 rounded-md border bg-background shadow-lg p-2.5 text-[11px]">
                            <div className="font-semibold">
                              #{r.stockId} · {sg.width > 0 ? `${sg.width}" wide` : "no stock"} · {r.status}
                              {r.noTickets && " (no open tickets)"}
                            </div>
                            <div className="text-muted-foreground mb-1.5">
                              {fmt(sg.footage)} ft on hand at this width · {fmt(sg.rolls)} roll{sg.rolls === 1 ? "" : "s"}
                              {r.belowMin && <span className="text-blue-600 dark:text-blue-400"> · below min</span>}
                              {r.aboveMax && <span className="text-purple-600 dark:text-purple-400"> · above max</span>}
                            </div>
                            {totals && (
                              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                <div>
                                  <span className="text-muted-foreground">In Inventory</span>
                                  <div className="font-semibold tabular-nums">
                                    {unit === "usd" ? `$${fmt(totals.onHand)}` : `${fmt(totals.onHand)} ft`}
                                  </div>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Ordered</span>
                                  <div className="font-semibold tabular-nums">
                                    {unit === "usd" ? `$${fmt(totals.onOrder)}` : `${fmt(totals.onOrder)} ft`}
                                  </div>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Required</span>
                                  <div className="font-semibold tabular-nums">
                                    {unit === "usd" ? `$${fmt(totals.required)}` : `${fmt(totals.required)} ft`}
                                  </div>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Available</span>
                                  <div
                                    className={cn(
                                      "font-semibold tabular-nums",
                                      totals.available < 0 && "text-red-600 dark:text-red-400",
                                    )}
                                  >
                                    {unit === "usd" ? `$${fmt(totals.available)}` : `${fmt(totals.available)} ft`}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="max-h-[26rem] overflow-y-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 backdrop-blur">
                  <tr className="text-muted-foreground">
                    <th className="text-left px-3 py-1.5 font-medium">Stock</th>
                    <th className="text-left px-3 py-1.5 font-medium">Status</th>
                    <th className="text-right px-3 py-1.5 font-medium">In Inv.</th>
                    <th className="text-right px-3 py-1.5 font-medium">Ordered</th>
                    <th className="text-right px-3 py-1.5 font-medium">Required</th>
                    <th className="text-right px-3 py-1.5 font-medium">Available</th>
                    <th className="text-left px-3 py-1.5 font-medium">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {summaryRows.map((r) => {
                    const totals = totalsById.get(r.stockId);
                    const u = (n: number | undefined) =>
                      n == null ? "—" : unit === "usd" ? `$${fmt(n)}` : `${fmt(n)} ft`;
                    return (
                      <tr
                        key={r.stockId}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedStock((prev) => (prev === r.stockId ? null : r.stockId))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") setSelectedStock((prev) => (prev === r.stockId ? null : r.stockId));
                        }}
                        className={cn(
                          "border-t cursor-pointer hover:bg-accent/40",
                          selectedStock === r.stockId && "bg-accent/50",
                        )}
                      >
                        <td className="px-3 py-1.5">
                          <div className="font-semibold">#{r.stockId}</div>
                          <div className="text-[10px] text-muted-foreground truncate max-w-[12rem]" title={r.description}>
                            {r.description}
                          </div>
                        </td>
                        <td className="px-3 py-1.5">
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className="inline-block w-2 h-2 rounded-full"
                              style={{ background: TICKET_STATUS_COLORS[r.status] ?? "#94a3b8" }}
                            />
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{u(totals?.onHand)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{u(totals?.onOrder)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{u(totals?.required)}</td>
                        <td
                          className={cn(
                            "px-3 py-1.5 text-right tabular-nums",
                            (totals?.available ?? 0) < 0 && "text-red-600 dark:text-red-400 font-medium",
                          )}
                        >
                          {u(totals?.available)}
                        </td>
                        <td className="px-3 py-1.5">
                          <span className="inline-flex items-center gap-1">
                            {r.belowMin && (
                              <span
                                className="rounded px-1 text-[9px] font-medium text-white"
                                style={{ background: MARKER_COLORS.belowMin }}
                              >
                                Below Min
                              </span>
                            )}
                            {r.aboveMax && (
                              <span
                                className="rounded px-1 text-[9px] font-medium text-white"
                                style={{ background: MARKER_COLORS.aboveMax }}
                              >
                                Above Max
                              </span>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {selectedItem && (
            <div className="mt-3 rounded-md border">
              <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/40">
                <span className="text-xs font-semibold">
                  #{selectedItem.stockId}
                  {(selectedItem.masterWidth ?? 0) > 0 && ` · ${selectedItem.masterWidth}" master width`}
                  {selectedItem.vendorName && ` · ${selectedItem.vendorName}`} · {selectedItem.openTicketCount} open
                  ticket{selectedItem.openTicketCount === 1 ? "" : "s"}
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
              {(() => {
                const d = totalsById.get(selectedItem.stockId);
                if (!d) return null;
                const u = (n: number) => (unit === "usd" ? `$${fmt(n)}` : `${fmt(n)} ft`);
                const stat = (label: string, value: React.ReactNode) => (
                  <div className="min-w-[7rem]">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
                    <div className="text-sm font-semibold tabular-nums">{value}</div>
                  </div>
                );
                return (
                  <div className="flex flex-wrap gap-x-8 gap-y-2 px-3 py-2 border-b bg-muted/20">
                    {stat("In Inventory", u(d.onHand))}
                    {stat("Ordered", u(d.onOrder))}
                    {stat("Required", u(d.required))}
                    {stat(
                      "Available",
                      <span className={cn(d.available < 0 && "text-red-600 dark:text-red-400")}>{u(d.available)}</span>,
                    )}
                    {stat("Min (ROP)", d.min > 0 ? u(d.min) : "—")}
                    {stat("Max", d.max > 0 ? u(d.max) : "—")}
                  </div>
                );
              })()}
              <div className="max-h-56 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left px-3 py-1 font-medium">Ticket</th>
                      <th className="text-left px-3 py-1 font-medium">Job</th>
                      <th className="text-right px-3 py-1 font-medium">Remaining</th>
                      <th className="text-left px-3 py-1 font-medium">Stock status</th>
                      <th className="text-right px-3 py-1 font-medium">Ship by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedItem.tickets ?? []).map((t) => (
                      <tr key={t.ticketNumber} className="border-b last:border-b-0">
                        <td className="px-3 py-1 font-medium">#{t.ticketNumber}</td>
                        <td className="px-3 py-1 text-muted-foreground truncate max-w-[16rem]">{t.description ?? "—"}</td>
                        <td className="px-3 py-1 text-right tabular-nums">
                          {fmt(t.estFootage)} ft
                          {(t.consumedFootage ?? 0) > 0 && (
                            <div className="text-[10px] text-muted-foreground">
                              {fmt(t.consumedFootage)} of {fmt(t.grossFootage)} ft run
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-1">
                          <span
                            className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                            style={{ background: TICKET_STATUS_COLORS[t.computedStatus ?? "In"] ?? "#94a3b8" }}
                          />
                          {t.computedStatus ?? "In"}
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
  leadTimeSource: DemandStockMetrics["leadTimeSource"];
  leadTimeObservations: number;
  eoqRolls: number;
  orderQtySource: DemandStockMetrics["orderQtySource"];
  belowMin: boolean;
  daysOfCover: number;
  openTicketFootage: number;
  reorderReason: DemandStockMetrics["reorderReason"];
  committedShortageFootage: number;
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

  const printPo = (po: MaterialPo) => {
    // Open the window synchronously (popup-blocker safe), then fill it from
    // the assembled document endpoint.
    const win = window.open("", "_blank", "width=920,height=1100");
    if (!win) {
      toast({ title: "Pop-up blocked", description: "Allow pop-ups for this site to print POs", variant: "destructive" });
      return;
    }
    void openPoDocument(win, po.id);
  };

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

  React.useEffect(() => {
    if (!purch) return;
    const purchByStock = new Map(purch.items.map((it) => [it.stockId, it]));
    const committedDriven = (r: DemandStockMetrics) => r.reorderReason === "committed" || r.reorderReason === "both";
    const next: SuggestionLine[] = rows
      // Committed-demand suggestions always show; forecast-only ones are
      // hidden for dormant/never materials (no recent usage = no forecast need).
      .filter(
        (r) =>
          r.suggestedOrderRolls > 0 &&
          (committedDriven(r) || (r.activityStatus !== "dormant" && r.activityStatus !== "never")),
      )
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
          leadTimeSource: r.leadTimeSource,
          leadTimeObservations: r.leadTimeObservations,
          eoqRolls: r.eoqRolls,
          orderQtySource: r.orderQtySource,
          belowMin: r.belowMin,
          daysOfCover: r.daysOfCover,
          openTicketFootage: p?.openTicketFootage ?? 0,
          reorderReason: r.reorderReason,
          committedShortageFootage: r.committedShortageFootage,
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
    try {
      // One PO per material — POs are strictly 1-to-1 with a stock; materials
      // are never combined on a single PO.
      for (const l of selected) {
        const due = new Date();
        due.setDate(due.getDate() + Math.max(14, l.leadTimeDays || 0));
        await createPo.mutateAsync({
          data: {
            vendorName,
            vendorEmails: l.vendorEmails,
            requestedDeliveryDate: due.toISOString().slice(0, 10),
            lines: [
              {
                stockId: l.stockId,
                description: l.description,
                rolls: l.rolls,
                footage: l.rolls * l.footagePerRoll || null,
                msiCost: l.msiCost,
                estCost: lineEstCost(l),
              },
            ],
          },
        });
      }
      await queryClient.invalidateQueries({ queryKey: getListMaterialPosQueryKey() });
      toast({
        title: `${selected.length} PO${selected.length === 1 ? "" : "s"} created`,
        description: `One per material for ${vendorName} — review & submit in PO History below`,
      });
    } catch (e) {
      toast({ title: "Failed", description: String(e), variant: "destructive" });
    }
  };

  const handleSubmit = async (po: MaterialPo) => {
    try {
      const r = await submitPo.mutateAsync({ id: po.id });
      await queryClient.invalidateQueries({ queryKey: getListMaterialPosQueryKey() });
      toast({
        title: r.status === "submitted_lt" ? "PO created in Label Traxx" : "PO submitted",
        description:
          r.status === "submitted_lt"
            ? `LT PO #${(r.ltPoNumbers ?? []).join(", ")}`
            : (r.ltError ?? "Recorded here — enter it in Label Traxx and link the PO # for receipt tracking"),
        variant: r.status === "submitted_lt" ? undefined : "destructive",
      });
    } catch (e) {
      toast({ title: "Submit failed", description: String(e), variant: "destructive" });
    }
  };

  // Vendor PO email built client-side from the PO's single material line.
  const poMailto = (po: MaterialPo): string => {
    const l = po.lines[0];
    const line = l
      ? `  • Stock #${l.stockId}${l.description ? ` — ${l.description}` : ""}: ${l.rolls} roll${l.rolls === 1 ? "" : "s"}` +
        (l.footage ? ` (~${Math.round(l.footage).toLocaleString()} ft)` : "")
      : "";
    const body =
      `Hi ${po.vendorName} team,\n\nPlease find our purchase order below:\n\n${line}\n\n` +
      (po.requestedDeliveryDate ? `Requested delivery: ${po.requestedDeliveryDate}\n` : "") +
      `\nShip to:\nCalyx Containers\n1991 Parkway Blvd\nWest Valley City, UT 84119\n\n` +
      `Please confirm receipt and expected ship date.\n\nThank you,\nCalyx Containers Supply Chain`;
    const subject = `Calyx Containers PO — ${po.vendorName} — Stock #${l?.stockId ?? ""}`;
    return `mailto:${encodeURIComponent(po.vendorEmails ?? "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
                      title="Creates one separate PO per selected material"
                    >
                      <Send className="w-3.5 h-3.5 mr-1" /> Create {selected.length} PO{selected.length === 1 ? "" : "s"}
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
                            {(l.reorderReason === "committed" || l.reorderReason === "both") && (
                              <Badge
                                variant="outline"
                                className="text-[10px] bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/40"
                                title="Open tickets require more than on-hand + on-order"
                              >
                                short for orders · {fmt(l.committedShortageFootage)} ft
                              </Badge>
                            )}
                            {l.reorderReason === "below_rop" && (
                              <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40">
                                below ROP · {l.daysOfCover >= 0 ? `${fmt(l.daysOfCover)}d cover` : "no demand"}
                              </Badge>
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
                            {l.eoqRolls > 0 && (
                              <div
                                className="text-[9px] text-muted-foreground mt-0.5"
                                title={
                                  l.orderQtySource === "manual"
                                    ? `Manual order quantity: ${l.eoqRolls} roll${l.eoqRolls === 1 ? "" : "s"}`
                                    : `Economic order quantity: ${l.eoqRolls} roll${l.eoqRolls === 1 ? "" : "s"} (balances ordering vs holding cost)`
                                }
                              >
                                {l.orderQtySource === "manual" ? "Set" : "EOQ"} {l.eoqRolls}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(l.rolls * l.footagePerRoll)} ft</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {lineEstCost(l) != null ? `$${fmt(lineEstCost(l))}` : "—"}
                          </td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground whitespace-nowrap">
                            {l.leadTimeDays || "—"}d
                            {l.leadTimeSource === "stock" && (
                              <span className="ml-1 text-[9px]" title={`From this stock's own ${l.leadTimeObservations} received PO${l.leadTimeObservations === 1 ? "" : "s"}`}>·{l.leadTimeObservations}PO</span>
                            )}
                            {l.leadTimeSource === "vendor" && (
                              <span className="ml-1 text-[9px] uppercase text-amber-600 dark:text-amber-400" title="Vendor median — too few POs for this stock alone">vend</span>
                            )}
                            {l.leadTimeSource === "global" && (
                              <span className="ml-1 text-[9px] uppercase text-muted-foreground" title="Global median — no PO history for this stock or its vendor">glob</span>
                            )}
                            {l.leadTimeSource === "override" && (
                              <span className="ml-1 text-[9px] uppercase text-primary" title="Manual lead-time override (Configuration tab)">set</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
                  {po.vendorEmails && (
                    <a
                      href={poMailto(po)}
                      title="Email this PO to the vendor"
                      className="text-primary hover:text-primary/80 p-1"
                    >
                      <Mail className="w-3.5 h-3.5" />
                    </a>
                  )}
                  <button
                    type="button"
                    title="Print PO document (Label Traxx format)"
                    className="text-primary hover:text-primary/80 p-1"
                    onClick={() => printPo(po)}
                  >
                    <Printer className="w-3.5 h-3.5" />
                  </button>
                  {(po.status === "draft" || po.status === "submitted") && (
                    <button
                      type="button"
                      disabled={submitPo.isPending}
                      title={purch?.ltWriteEnabled ? "Create this PO in Label Traxx" : "Mark submitted"}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline p-1 disabled:opacity-50"
                      onClick={() => handleSubmit(po)}
                    >
                      <Send className="w-3.5 h-3.5" /> {purch?.ltWriteEnabled ? "Submit to LT" : "Submit"}
                    </button>
                  )}
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
                <th className="text-right px-2 py-1.5 font-medium">Order qty (rolls)</th>
                <th className="text-right px-2 py-1.5 font-medium">MSI cost ($)</th>
                <th className="text-right px-2 py-1.5 font-medium">Width (in)</th>
                <th className="text-left px-2 py-1.5 font-medium">Demand from #</th>
                <th className="text-center px-2 py-1.5 font-medium" title="End of life — keep on-hand visible but stop reordering">EOL</th>
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
                        value={it.orderQuantityRolls != null ? String(it.orderQuantityRolls) : ""}
                        placeholder={m && m.eoqRolls > 0 ? `EOQ ${m.eoqRolls}` : "auto"}
                        onSave={(v) => save(it.stockId, { orderQuantityRolls: v == null ? null : Number(v) })}
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
                    <td className="px-2 py-1.5">
                      <EditableCell
                        value={it.demandFromStockId ?? ""}
                        placeholder="—"
                        onSave={(v) => save(it.stockId, { demandFromStockId: v })}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <Checkbox
                        checked={it.discontinued}
                        onCheckedChange={(c) => save(it.stockId, { discontinued: c === true })}
                        title="End of life — keep on-hand visible but stop reordering"
                      />
                    </td>
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
