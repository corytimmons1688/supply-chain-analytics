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
  useDeleteMaterialPo,
  useGetVendorContacts,
  getGetVendorContactsQueryKey,
  useSetVendorContact,
  useGetGmailStatus,
  getGetGmailStatusQueryKey,
  useDisconnectGmail,
  useSendMaterialPo,
  useSendMaterialPoTest,
  useGetPoAgentQueue,
  getGetPoAgentQueueQueryKey,
  useApprovePoAgentDraft,
  useDismissPoAgentDraft,
  useResolvePoAttention,
  useDeleteAgentLesson,
  useGetPoTimeline,
  getGetPoTimelineQueryKey,
  type DemandStockMetrics,
  type PurchasingItem,
  type MaterialPo,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { authorizedFetch, openAuthorizedUrl } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Mail, Send, ShoppingCart, Ticket, Settings2, Printer, ExternalLink, X, PackageCheck, BarChart3, LayoutGrid, Trash2, UnfoldHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseNoteTracking } from "@/lib/carrier-tracking";

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
    const res = await authorizedFetch(`/api/demand/pos/${poId}/document`);
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

/**
 * PO notes with carrier PRO / tracking references turned into deep links to the
 * carrier's tracking page. stopPropagation so clicking a link inside a clickable
 * row doesn't also toggle the row.
 */
function NoteWithTracking({ text }: { text: string | null | undefined }) {
  const segments = React.useMemo(() => parseNoteTracking(text), [text]);
  if (segments.length === 0) return <>—</>;
  return (
    <>
      {segments.map((s, i) =>
        s.kind === "track" ? (
          <a
            key={i}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-primary underline decoration-dotted hover:decoration-solid"
            title={`Track ${s.number} on ${s.carrier}`}
          >
            {s.text}
          </a>
        ) : (
          <React.Fragment key={i}>{s.text}</React.Fragment>
        ),
      )}
    </>
  );
}

/** Hover-card payload for a width bar, positioned in viewport coordinates. */
type WidthTip = {
  stockId: string;
  status: string;
  pooled: boolean;
  width: number;
  footage: number;
  rolls: number;
  onOrder: number;
  required: number;
  short: number;
  belowMin: boolean;
  aboveMax: boolean;
  left: number;
  top: number;
};

/**
 * Dazpak make-and-hold panel. Two signals per program material:
 *  - Release from Held (made & waiting, ~5 business days to deliver)
 *  - Trigger a new make-and-hold (6-week make; keep 10 weeks of coverage)
 */
export function MakeAndHoldSection({ rows }: { rows: DemandStockMetrics[] }) {
  const [, navigate] = useLocation();
  const program = React.useMemo(() => rows.filter((r) => r.dazpak), [rows]);
  if (program.length === 0) return null;

  const toRelease = program.filter((r) => (r.dazpak?.releaseFootage ?? 0) > 0);
  const toMake = program.filter((r) => (r.dazpak?.makeFootage ?? 0) > 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <PackageCheck className="w-4 h-4 text-muted-foreground" /> Dazpak Make &amp; Hold
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Held stock delivers in ~5 business days; a new make-and-hold takes ~6 weeks. Release when
          on-hand won&apos;t cover the next 15 business days; make when total coverage drops under 10 weeks.
          {toRelease.length > 0 && (
            <span className="text-amber-700 dark:text-amber-400 font-medium">
              {" "}· {toRelease.length} to release
            </span>
          )}
          {toMake.length > 0 && (
            <span className="text-red-600 dark:text-red-400 font-medium"> · {toMake.length} to make</span>
          )}
        </p>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground">
                <th className="text-left px-2 py-1.5 font-medium">Stock</th>
                <th className="text-right px-2 py-1.5 font-medium">On hand</th>
                <th className="text-right px-2 py-1.5 font-medium">Held at Dazpak</th>
                <th className="text-right px-2 py-1.5 font-medium">In production</th>
                <th className="text-left px-2 py-1.5 font-medium">Next ETA</th>
                <th className="text-right px-2 py-1.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {program.map((r) => {
                const d = r.dazpak!;
                return (
                  <tr key={r.stockId} className="border-b last:border-b-0 align-top">
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        className="font-medium text-primary hover:underline"
                        onClick={() => navigate(`/demand/${encodeURIComponent(r.stockId)}`)}
                      >
                        #{r.stockId}
                      </button>
                      <div className="text-muted-foreground max-w-[18rem] truncate" title={r.description ?? ""}>
                        {r.description ?? ""}
                      </div>
                      {(d.lines ?? []).length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {(d.lines ?? []).map((l, i) => (
                            <div key={`${l.poNumber}-${i}`} className="text-[10px] text-muted-foreground">
                              PO {l.poNumber} · {l.status} · {fmt(l.outstandingFootage)} ft
                              {l.planAvailDate ? ` · ETA ${l.planAvailDate}` : ""}
                              {l.custItemRef ? ` · ${l.custItemRef}` : ""}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.onHandFootage)} ft</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {d.heldFootage > 0 ? (
                        <span className="font-medium text-green-700 dark:text-green-400">{fmt(d.heldFootage)} ft</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(d.inProductionFootage)} ft</td>
                    <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{d.etaDate ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right">
                      {d.releaseFootage > 0 && (
                        <Badge
                          variant="outline"
                          className="text-[10px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40"
                          title={`On-hand won't cover ${fmt(d.demandReleaseHorizon)} ft due in the next 15 business days`}
                        >
                          Release {fmt(d.releaseFootage)} ft
                        </Badge>
                      )}
                      {d.makeFootage > 0 && (
                        <Badge
                          variant="outline"
                          className="ml-1 text-[10px] bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/40"
                          title={`Coverage (on-hand + held + in-production) is short of ${fmt(d.demandMakeHorizon)} ft over the 10-week make window`}
                        >
                          Make {fmt(d.makeFootage)} ft
                        </Badge>
                      )}
                      {d.releaseFootage === 0 && d.makeFootage === 0 && (
                        <span className="text-muted-foreground">covered</span>
                      )}
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
  // Full product descriptions: widen the label column and let text wrap.
  // Default ON — only an explicit collapse ("0") turns it off, so the full
  // name is visible without having to discover the toggle first.
  const [wideLabels, setWideLabels] = React.useState(() => localStorage.getItem("sca-wide-labels") !== "0");
  const toggleWideLabels = () => {
    setWideLabels((v) => {
      localStorage.setItem("sca-wide-labels", v ? "0" : "1");
      return !v;
    });
  };
  /**
   * Width-bar hover card. Rendered as ONE position:fixed node outside the
   * scrolling list — an absolutely-positioned tooltip inside the
   * `overflow-y-auto` container gets clipped on the last rows (you can't scroll
   * far enough to see it) and its show/hide repaints inside the scroll area make
   * the bars flicker while scrolling.
   */
  const [tip, setTip] = React.useState<WidthTip | null>(null);
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
              <button
                type="button"
                onClick={toggleWideLabels}
                title={wideLabels ? "Collapse descriptions" : "Expand descriptions — show the full product name"}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] whitespace-nowrap",
                  wideLabels ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                <UnfoldHorizontal className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Full descriptions</span>
              </button>
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
            <div
              className="max-h-[26rem] overflow-y-auto rounded-md border divide-y"
              onScroll={() => tip && setTip(null)}
            >
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
                    <div className={cn("shrink-0", wideLabels ? "w-72 sm:w-96" : "w-28")}>
                      <div className="text-xs font-semibold">#{r.stockId}</div>
                      <div
                        className={cn(
                          "text-[10px] text-muted-foreground",
                          wideLabels ? "whitespace-normal break-words" : "truncate",
                        )}
                        title={r.description}
                      >
                        {r.description}
                      </div>
                    </div>
                    <div className="flex-1 flex items-center gap-1.5 flex-wrap py-0.5">
                      {r.segs.map((sg) => (
                        <div
                          key={`${r.stockId}-${sg.width}`}
                          className="relative"
                          onMouseEnter={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const TIP_W = 256;
                            const TIP_H = 168;
                            // Flip above the bar when there isn't room below, so
                            // the last rows aren't cut off by the viewport.
                            const below = rect.bottom + TIP_H + 10 <= window.innerHeight;
                            setTip({
                              stockId: r.stockId,
                              status: sg.status ?? r.status,
                              pooled: !!sg.pooled,
                              width: sg.width,
                              footage: sg.footage,
                              rolls: sg.rolls,
                              onOrder: sg.onOrderFootage ?? 0,
                              required: sg.requiredFootage ?? 0,
                              short: sg.shortFootage ?? 0,
                              belowMin: r.belowMin,
                              aboveMax: r.aboveMax,
                              // Clamp inside the viewport; max() last so a narrow
                              // window can never push the card off-screen left.
                              left: Math.max(8, Math.min(rect.left, window.innerWidth - TIP_W - 8)),
                              top: below ? rect.bottom + 6 : Math.max(8, rect.top - TIP_H - 6),
                            });
                          }}
                          onMouseLeave={() => setTip(null)}
                        >
                          <div
                            className="relative h-6 w-24 rounded-sm flex items-center justify-center text-[11px] font-semibold text-white overflow-hidden"
                            style={{
                              background: TICKET_STATUS_COLORS[sg.status ?? r.status] ?? "#94a3b8",
                            }}
                          >
                            {sg.pooled ? `≤13"` : sg.width > 0 ? `${sg.width}"` : "0 ft"}
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
                          <div
                            className={cn(
                              "text-[10px] text-muted-foreground",
                              wideLabels ? "whitespace-normal break-words max-w-[28rem]" : "truncate max-w-[12rem]",
                            )}
                            title={r.description}
                          >
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
              {/* Inbound: open POs for this material (requested vs promised
                  delivery, buyer notes, ordered footage). */}
              {(selectedItem.openPos ?? []).length > 0 && (
                <div className="border-b">
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/20">
                    Open POs ({(selectedItem.openPos ?? []).length}) ·{" "}
                    {fmt((selectedItem.openPos ?? []).reduce((s, p) => s + (p.totalFootage ?? 0), 0))} ft inbound
                  </div>
                  <div className="max-h-44 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-muted-foreground">
                          <th className="text-left px-3 py-1 font-medium">PO</th>
                          <th className="text-right px-3 py-1 font-medium">Width</th>
                          <th className="text-right px-3 py-1 font-medium">Rolls</th>
                          <th className="text-right px-3 py-1 font-medium">Total footage</th>
                          <th className="text-right px-3 py-1 font-medium">Requested</th>
                          <th className="text-right px-3 py-1 font-medium">Promised</th>
                          <th className="text-left px-3 py-1 font-medium">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(selectedItem.openPos ?? []).map((p) => {
                          // Promised later than requested = the vendor pushed the date out.
                          const late =
                            !!p.requestedDeliveryDate &&
                            !!p.promisedDeliveryDate &&
                            p.promisedDeliveryDate > p.requestedDeliveryDate;
                          return (
                            <tr key={p.poNumber} className="border-b last:border-b-0 align-top">
                              <td className="px-3 py-1 font-medium whitespace-nowrap">
                                PO {p.poNumber}
                                {p.daysOpen != null && (
                                  <span className="ml-1 text-[10px] text-muted-foreground">{p.daysOpen}d open</span>
                                )}
                              </td>
                              <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">
                                {p.masterWidth ? `${p.masterWidth}"` : "—"}
                              </td>
                              <td className="px-3 py-1 text-right tabular-nums">{fmt(p.rolls)}</td>
                              <td className="px-3 py-1 text-right tabular-nums">
                                {p.totalFootage > 0 ? `${fmt(p.totalFootage)} ft` : "—"}
                              </td>
                              <td className="px-3 py-1 text-right tabular-nums whitespace-nowrap">
                                {p.requestedDeliveryDate ?? "—"}
                              </td>
                              <td
                                className={cn(
                                  "px-3 py-1 text-right tabular-nums whitespace-nowrap",
                                  late && "text-amber-700 dark:text-amber-400 font-medium",
                                )}
                                title={late ? "Vendor promised later than requested" : undefined}
                              >
                                {p.promisedDeliveryDate ?? "—"}
                              </td>
                              <td className="px-3 py-1 text-muted-foreground max-w-[18rem] whitespace-pre-line">
                                <NoteWithTracking text={p.notes} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
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

      {/* Width-bar hover card — fixed so it escapes the list's overflow clipping
          (bottom rows were unreachable) and doesn't repaint the scrolling area. */}
      {tip && (
        <div
          className="pointer-events-none fixed z-50 w-64 rounded-md border bg-background shadow-lg p-2.5 text-[11px]"
          style={{ left: tip.left, top: tip.top }}
        >
          <div className="font-semibold">
            #{tip.stockId} ·{" "}
            {tip.pooled ? `≤13" (interchangeable)` : tip.width > 0 ? `${tip.width}" wide` : "no stock"} ·{" "}
            {tip.status}
          </div>
          <div className="text-muted-foreground mb-1.5">
            {fmt(tip.footage)} ft on hand · {fmt(tip.rolls)} roll{tip.rolls === 1 ? "" : "s"} at this width
            {tip.belowMin && <span className="text-blue-600 dark:text-blue-400"> · below min</span>}
            {tip.aboveMax && <span className="text-purple-600 dark:text-purple-400"> · above max</span>}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div>
              <span className="text-muted-foreground">On hand{tip.pooled ? " (≤13\")" : ""}</span>
              <div className="font-semibold tabular-nums">{fmt(tip.footage)} ft</div>
            </div>
            <div>
              <span className="text-muted-foreground">On order</span>
              <div className="font-semibold tabular-nums">{fmt(tip.onOrder)} ft</div>
            </div>
            <div>
              <span className="text-muted-foreground">Required</span>
              <div className="font-semibold tabular-nums">{fmt(tip.required)} ft</div>
            </div>
            <div>
              <span className="text-muted-foreground">Short</span>
              <div
                className={cn("font-semibold tabular-nums", tip.short > 0 && "text-red-600 dark:text-red-400")}
              >
                {fmt(tip.short)} ft
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Suggested POs tab
// ---------------------------------------------------------------------
type SuggestionLine = {
  /** Row identity: one suggestion row per stock × ordered width. */
  key: string;
  stockId: string;
  /** Master width to order (inches); 0 = unknown → stock master width. */
  width: number;
  widthReason: "committed" | "forecast" | "both" | null;
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
  /** Current position + band, so the buyer can judge the suggestion in place. */
  onHandFootage: number;
  onOrderFootage: number;
  /** on hand + on order − open-ticket book — what Min compares against. */
  availableFootage: number;
  openPoCount: number;
  minFootage: number;
  maxFootage: number;
};

function lineEstCost(l: SuggestionLine): number | null {
  // Cost at the width being ORDERED — a 30" roll is not priced like a 13" one.
  const w = l.width > 0 ? l.width : l.masterWidth;
  if (l.msiCost == null || w <= 0 || l.footagePerRoll <= 0) return null;
  const msi = footageToMsi(l.rolls * l.footagePerRoll, w);
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
  const deletePo = useDeleteMaterialPo();
  const { data: gmail } = useGetGmailStatus({
    query: { queryKey: getGetGmailStatusQueryKey(), staleTime: 60_000 },
  });
  const [sendingPo, setSendingPo] = React.useState<MaterialPo | null>(null);
  const [activityPo, setActivityPo] = React.useState<MaterialPo | null>(null);

  // PO addresses live at the vendor level now, so the per-vendor "no PO email"
  // warning has to read vendor_contact — not the legacy per-stock field, which
  // is empty for every vendor entered since the move.
  const { data: contacts } = useGetVendorContacts({
    query: { queryKey: getGetVendorContactsQueryKey(), staleTime: 60_000 },
  });
  const vendorToEmails = React.useMemo(
    () =>
      new Map(
        (contacts?.items ?? [])
          .filter((v) => v.toEmails?.trim())
          .map((v) => [v.vendorName, v.toEmails!.trim()] as const),
      ),
    [contacts],
  );

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

  /** Delete an unsent draft. Confirmed first — removes the PO and its lines. */
  const handleDelete = async (po: MaterialPo) => {
    const lineCount = po.lines?.length ?? 0;
    const ok = window.confirm(
      `Delete this draft PO for ${po.vendorName}?\n\n` +
        `${lineCount} line${lineCount === 1 ? "" : "s"} will be removed. This can't be undone.\n` +
        `Nothing has been sent to the vendor or Label Traxx.`,
    );
    if (!ok) return;
    try {
      await deletePo.mutateAsync({ id: po.id });
      await queryClient.invalidateQueries({ queryKey: getListMaterialPosQueryKey() });
      toast({ title: "Draft deleted", description: `${po.vendorName} draft removed` });
    } catch (e) {
      toast({ title: "Could not delete", description: String(e), variant: "destructive" });
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
      .flatMap((r) => {
        const p = purchByStock.get(r.stockId);
        // One suggestion row per width to order (committed shortfalls at the
        // exact ticket widths, forecast remainder at master width); stocks
        // with no width detail fall back to a single master-width row.
        const widths =
          r.suggestedWidths && r.suggestedWidths.length > 0
            ? r.suggestedWidths
            : [{ width: p?.masterWidth ?? 0, footage: r.suggestedOrderFootage, rolls: r.suggestedOrderRolls, reason: null as never }];
        return widths.map((w) => ({
          key: `${r.stockId}|${w.width}`,
          width: w.width,
          widthReason: (w.reason ?? null) as SuggestionLine["widthReason"],
          stockId: r.stockId,
          description: r.description ?? null,
          vendorName: p?.vendorName ?? "Unassigned vendor",
          vendorEmails: p?.vendorEmails ?? null,
          suggestedRolls: w.rolls,
          rolls: w.rolls,
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
          onHandFootage: r.onHandFootage,
          onOrderFootage: r.openPoFootage,
          availableFootage: r.availableFootage,
          openPoCount: r.openPoCount,
          minFootage: r.reorderPointFootage,
          maxFootage: r.maxFootage,
        }));
      })
      .sort(
        (a, b) =>
          Number(b.belowMin) - Number(a.belowMin) ||
          a.stockId.localeCompare(b.stockId, undefined, { numeric: true }) ||
          a.width - b.width,
      );
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

  const setLine = (key: string, patch: Partial<SuggestionLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

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
                width: l.width > 0 ? l.width : null,
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
        description: `One per material & width for ${vendorName} — review & submit in PO History below`,
      });
    } catch (e) {
      toast({ title: "Failed", description: String(e), variant: "destructive" });
    }
  };

  const handleSubmit = async (po: MaterialPo) => {
    try {
      const r = await submitPo.mutateAsync({ id: po.id });
      await queryClient.invalidateQueries({ queryKey: getListMaterialPosQueryKey() });
      // A submitted PO counts as on-order immediately (the summary route folds
      // in dashboard POs the LT mirror hasn't caught up to) — refetch so the
      // suggestion it satisfies disappears right away.
      await queryClient.invalidateQueries({
        predicate: (q) => String(q.queryKey[0] ?? "").includes("/demand/summary"),
      });
      toast({
        title:
          r.status === "submitted_lt"
            ? "PO created in Label Traxx"
            : r.ltError
              ? "Label Traxx rejected this PO — still a draft"
              : "PO submitted",
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

  const specByStock = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const i of purch?.items ?? []) {
      const spec = i.mfgSpecNum?.trim();
      if (spec) m.set(i.stockId, spec);
    }
    return m;
  }, [purch]);

  // Vendor PO email built client-side from the PO's single material line.
  const poMailto = (po: MaterialPo): string => {
    const l = po.lines[0];
    const line = l
      ? `  • Stock #${l.stockId}${l.description ? ` — ${l.description}` : ""}: ${l.rolls} roll${l.rolls === 1 ? "" : "s"}` +
        (l.width ? ` @ ${l.width}" wide` : "") +
        (l.footage ? ` (~${Math.round(l.footage).toLocaleString()} ft)` : "")
      : "";
    // Reference the Label Traxx PO number once assigned, so the vendor can quote it.
    const poRef = po.ltPoNumbers?.trim() ? ` ${po.ltPoNumbers.trim()}` : "";
    const body =
      `Hi All,\n\nPlease find our purchase order${poRef} below:\n\n${line}\n\n` +
      (po.requestedDeliveryDate ? `Requested delivery: ${po.requestedDeliveryDate}\n` : "") +
      `\nShip to:\nCalyx Containers\n1991 Parkway Blvd\nWest Valley City, UT 84119\n\n` +
      `Please confirm receipt and expected ship date.\n\nThank you,\nCalyx Containers Supply Chain`;
    // The MFG spec number is how the vendor identifies the material on their
    // end, so put it in the subject when Label Traxx has one.
    const spec = l ? (specByStock.get(l.stockId) ?? "") : "";
    const subject =
      `Calyx Containers PO${poRef} — ${po.vendorName} — Stock #${l?.stockId ?? ""}` +
      (spec ? ` (MFG Spec ${spec})` : "");
    const cc = po.vendorCcEmails ? `&cc=${encodeURIComponent(po.vendorCcEmails)}` : "";
    return `mailto:${encodeURIComponent(po.vendorEmails ?? "")}?subject=${encodeURIComponent(subject)}${cc}&body=${encodeURIComponent(body)}`;
  };

  if (isLoading) return <Skeleton className="h-72 rounded-lg" />;

  return (
    <div className="space-y-4">
      {sendingPo && (
        <SendPoDialog
          po={sendingPo}
          onClose={() => setSendingPo(null)}
          onSent={() => void queryClient.invalidateQueries({ queryKey: getListMaterialPosQueryKey() })}
        />
      )}
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
                    {vendorToEmails.get(vendorName) ? (
                      <span className="text-xs font-normal text-muted-foreground">
                        {vendorToEmails.get(vendorName)}
                      </span>
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
                        <th className="text-right px-2 py-1.5 font-medium" title="Master width to order — committed shortfalls order the exact ticket width">Width</th>
                        <th className="text-left px-2 py-1.5 font-medium">Why</th>
                        <th className="text-right px-2 py-1.5 font-medium" title="On-hand footage in inventory now">
                          On hand (ft)
                        </th>
                        <th
                          className="text-right px-2 py-1.5 font-medium"
                          title="Footage already on order across open POs (not yet received)"
                        >
                          On order (ft)
                        </th>
                        <th
                          className="text-right px-2 py-1.5 font-medium"
                          title="On hand + on order − open-ticket requirements — the uncommitted stock Min compares against"
                        >
                          Available (ft)
                        </th>
                        <th className="text-right px-2 py-1.5 font-medium" title="Reorder point — demand over the lead time + safety stock">
                          Min (ft)
                        </th>
                        <th className="text-right px-2 py-1.5 font-medium" title="Order-up-to level (reorder point + order quantity)">
                          Max (ft)
                        </th>
                        <th className="text-right px-2 py-1.5 font-medium">Rolls</th>
                        <th className="text-right px-2 py-1.5 font-medium">Footage</th>
                        <th className="text-right px-2 py-1.5 font-medium">Est. cost</th>
                        <th className="text-right px-2 py-1.5 font-medium">Lead time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vendorLines.map((l) => (
                        <tr key={l.key} className="border-b last:border-b-0">
                          <td className="px-2 py-1.5">
                            <Checkbox checked={l.selected} onCheckedChange={(c) => setLine(l.key, { selected: c === true })} />
                          </td>
                          <td className="px-2 py-1.5">
                            <span className="font-medium">#{l.stockId}</span>{" "}
                            <span className="text-muted-foreground">{(l.description ?? "").slice(0, 44)}</span>
                          </td>
                          <td
                            className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap"
                            title={
                              l.widthReason === "committed"
                                ? "Open tickets require this exact width"
                                : l.widthReason === "forecast"
                                  ? "Forecast/EOQ top-up at the stock's master width"
                                  : l.widthReason === "both"
                                    ? "Ticket requirement plus forecast top-up at this width"
                                    : undefined
                            }
                          >
                            {l.width > 0 ? (
                              <span className={cn("font-medium", l.widthReason === "committed" && "text-red-700 dark:text-red-400")}>
                                {l.width}″
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {(l.reorderReason === "committed" || l.reorderReason === "both") && (
                              <Badge
                                variant="outline"
                                className="text-[10px] bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/40"
                                title={
                                  "Open tickets need more than on-hand + on-order AT THE REQUIRED WIDTH. " +
                                  "The On hand / On order columns are stock totals across all widths, so they can " +
                                  "look sufficient while one width is short (widths ≤13\" pool together; wider widths net separately). " +
                                  "Click the stock in Stock Inventory Summary for the per-width breakdown."
                                }
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
                          {/* Position vs band, so the suggestion can be judged in place. */}
                          <td
                            className={cn(
                              "px-2 py-1.5 text-right tabular-nums",
                              l.minFootage > 0 &&
                                l.onHandFootage < l.minFootage &&
                                "text-amber-700 dark:text-amber-400 font-medium",
                            )}
                            title={
                              l.minFootage > 0 && l.onHandFootage < l.minFootage
                                ? "On hand is below the reorder point"
                                : undefined
                            }
                          >
                            {fmt(l.onHandFootage)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {l.onOrderFootage > 0 ? (
                              <>
                                {fmt(l.onOrderFootage)}
                                <div className="text-[9px] text-muted-foreground">
                                  {l.openPoCount} PO{l.openPoCount === 1 ? "" : "s"}
                                </div>
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td
                            className={cn(
                              "px-2 py-1.5 text-right tabular-nums",
                              l.minFootage > 0 && l.availableFootage < l.minFootage && "text-amber-700 dark:text-amber-400 font-medium",
                            )}
                            title="On hand + on order − open-ticket requirements"
                          >
                            {fmt(l.availableFootage)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                            {l.minFootage > 0 ? fmt(l.minFootage) : "—"}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                            {l.maxFootage > 0 ? fmt(l.maxFootage) : "—"}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <Input
                              type="number"
                              min={0}
                              className="h-6 w-16 text-xs text-right inline-block"
                              value={l.rolls}
                              onChange={(e) => setLine(l.key, { rolls: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
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

      <CoveredByInboundCard rows={rows} purch={purch} />

      <PoAgentQueueCard />
      {activityPo && <PoActivityDialog po={activityPo} onClose={() => setActivityPo(null)} />}

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
                    · {po.lines.map((l) => `#${l.stockId}×${l.rolls}${l.width ? ` @ ${l.width}\u2033` : ""}`).join(", ")} ·{" "}
                    {new Date(po.createdAt).toLocaleDateString()}
                    {po.requestedDeliveryDate && ` · due ${po.requestedDeliveryDate}`}
                  </span>
                  {po.status === "received" && (
                    <div className="mt-0.5 text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                      <PackageCheck className="w-3.5 h-3.5" /> Received {po.receivedOn}
                      {po.actualLeadDays != null && ` · ${po.actualLeadDays}d actual lead time`}
                    </div>
                  )}
                  {po.emailedAt && (
                    <div className="mt-0.5 text-muted-foreground inline-flex items-center gap-1">
                      <Mail className="w-3.5 h-3.5" /> Emailed {new Date(po.emailedAt).toLocaleDateString()} to{" "}
                      {po.emailedTo}
                    </div>
                  )}
                  {po.needsAttention && po.attentionReason && (
                    <div className="mt-0.5 text-amber-700 dark:text-amber-400 inline-flex items-center gap-1">
                      ⚠ {po.attentionReason}
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
                  {/* Send through Gmail (PDF attached) when it's connected;
                      otherwise fall back to opening a draft in the mail client. */}
                  {gmail?.connected ? (
                    <button
                      type="button"
                      title={
                        po.emailedAt
                          ? `Emailed ${new Date(po.emailedAt).toLocaleString()} — send again`
                          : "Email this PO to the vendor with the PDF attached"
                      }
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline p-1"
                      onClick={() => setSendingPo(po)}
                    >
                      <Mail className="w-3.5 h-3.5" /> {po.emailedAt ? "Re-send" : "Email"}
                    </button>
                  ) : (
                    po.vendorEmails && (
                      <a
                        href={poMailto(po)}
                        title="Open a PO draft in your mail client (connect Gmail to send with the PDF attached)"
                        className="text-primary hover:text-primary/80 p-1"
                      >
                        <Mail className="w-3.5 h-3.5" />
                      </a>
                    )
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
                  {/* Drafts only — a submitted PO exists upstream in Label Traxx
                      and must be voided there, not erased from our history. */}
                  {po.status === "draft" && (
                    <button
                      type="button"
                      disabled={deletePo.isPending}
                      title="Delete this unsent draft"
                      className="inline-flex items-center gap-1 text-xs text-destructive hover:underline p-1 disabled:opacity-50"
                      onClick={() => handleDelete(po)}
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </button>
                  )}
                  {po.agentState && (
                    <button
                      type="button"
                      title="View email activity timeline"
                      onClick={() => setActivityPo(po)}
                      className="focus:outline-none"
                    >
                      <Badge
                        variant="outline"
                        className={cn(
                          "cursor-pointer",
                          po.needsAttention
                            ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40"
                            : po.agentState === "acknowledged" || po.agentState === "shipped"
                              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/40"
                              : "text-muted-foreground",
                        )}
                      >
                        {po.needsAttention
                          ? "needs attention"
                          : po.agentState === "awaiting_ack"
                            ? "awaiting ack"
                            : po.agentState === "acknowledged"
                              ? `ack'd${po.promisedDate ? ` · promised ${po.promisedDate}` : ""}`
                              : po.agentState === "shipped"
                                ? "shipped"
                                : po.agentState}
                      </Badge>
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

/**
 * Email tab — everything about PO email in one place: the Gmail connection the
 * mail goes out through, the follow-up agent's approval queue, and the
 * per-vendor To/CC addresses + agent opt-in.
 */
export function EmailTab() {
  return (
    <div className="space-y-4">
      <GmailCard />
      <PoAgentQueueCard />
      <AgentLessonsCard />
      <VendorContactsCard />
    </div>
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
    // Never show stocks Label Traxx marks inactive — there's nothing to configure.
    if (it.inactive) return false;
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
    <div className="space-y-4">
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Settings2 className="w-4 h-4 text-muted-foreground" /> Per-material Configuration
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
    </div>
  );
}

/**
 * PO addresses per VENDOR (not per material — one vendor supplies many stocks).
 * To and CC each accept several addresses, comma or semicolon separated.
 */
type EmailPreview = {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  attachmentName: string;
  isDraft: boolean;
  emailedAt: string | null;
  emailedTo: string | null;
  gmailConfigured: boolean;
  gmailAccount: string | null;
};

/**
 * Confirmation step before a PO leaves the building: shows the resolved
 * recipients, the exact subject and body, and the PDF that will be attached.
 * Nothing is sent until Send is clicked here.
 */
function SendPoDialog({
  po,
  onClose,
  onSent,
}: {
  po: MaterialPo;
  onClose: () => void;
  onSent: () => void;
}) {
  const { toast } = useToast();
  const send = useSendMaterialPo();
  const sendTest = useSendMaterialPoTest();
  const [preview, setPreview] = React.useState<EmailPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await authorizedFetch(`/api/demand/pos/${po.id}/email-preview`);
        const json = (await res.json()) as EmailPreview & { error?: string };
        if (!live) return;
        if (!res.ok) setError(json.error ?? `HTTP ${res.status}`);
        else setPreview(json);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [po.id]);

  const doSend = async () => {
    try {
      const r = await send.mutateAsync({ id: po.id });
      toast({
        title: "PO emailed",
        description: `Sent to ${(r.to ?? []).join(", ")}${r.cc?.length ? ` (cc ${r.cc.join(", ")})` : ""}`,
      });
      onSent();
      onClose();
    } catch (e) {
      // The server returns a readable reason (no recipient, Gmail not connected,
      // Gmail rejected the message) — show it rather than a generic failure.
      toast({ title: "Send failed", description: String(e), variant: "destructive" });
    }
  };

  const blocked = !preview || !preview.gmailAccount || preview.to.length === 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">Email this PO to {po.vendorName}</DialogTitle>
          <DialogDescription className="text-xs">
            {preview?.gmailAccount ? (
              <>
                Sends from <span className="font-medium">{preview.gmailAccount}</span> with the PO PDF attached.
              </>
            ) : (
              "Gmail must be connected before a PO can be sent."
            )}
          </DialogDescription>
        </DialogHeader>

        {error && <div className="text-xs text-destructive">{error}</div>}
        {!preview && !error && <Skeleton className="h-48 rounded-md" />}

        {preview && (
          <div className="space-y-3 text-xs">
            {preview.emailedAt && (
              <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-amber-800 dark:text-amber-300">
                Already emailed {new Date(preview.emailedAt).toLocaleString()} to {preview.emailedTo}. Sending again
                will deliver a second copy.
              </div>
            )}
            {preview.isDraft && (
              <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-amber-800 dark:text-amber-300">
                This PO isn't in Label Traxx yet, so the attached PDF is marked <strong>DRAFT</strong> and has no PO
                number. Submit it to Label Traxx first if the vendor needs a real PO number.
              </div>
            )}
            {preview.to.length === 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive">
                No To address for {po.vendorName}. Add one under Configuration → Vendor PO Contacts.
              </div>
            )}
            <div className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-1.5">
              <span className="text-muted-foreground">To</span>
              <span className="font-medium break-all">{preview.to.join(", ") || "—"}</span>
              <span className="text-muted-foreground">Cc</span>
              <span className="break-all">{preview.cc.join(", ") || "—"}</span>
              <span className="text-muted-foreground">Subject</span>
              <span className="font-medium">{preview.subject}</span>
              <span className="text-muted-foreground">Attached</span>
              <span className="inline-flex items-center gap-1">
                <Printer className="w-3 h-3 text-muted-foreground" />
                {preview.attachmentName}
                <button
                  type="button"
                  onClick={() => void openAuthorizedUrl(`/api/demand/pos/${po.id}/pdf`)}
                  className="text-primary hover:underline ml-1"
                >
                  preview
                </button>
              </span>
            </div>
            <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 max-h-56 overflow-auto font-sans leading-relaxed">
              {preview.body}
            </pre>
          </div>
        )}

        <DialogFooter className="sm:justify-between gap-2">
          {/* Dry run to your own inbox — never reaches the vendor. */}
          <Button
            variant="outline"
            size="sm"
            disabled={!preview?.gmailAccount || sendTest.isPending}
            title={
              preview?.gmailAccount
                ? `Send a copy to ${preview.gmailAccount} only — the vendor gets nothing`
                : "Connect Gmail first"
            }
            onClick={async () => {
              try {
                const r = await sendTest.mutateAsync({ id: po.id });
                toast({ title: "Test sent to you", description: `${(r.to ?? []).join(", ")} — vendor not contacted` });
              } catch (e) {
                toast({ title: "Test send failed", description: String(e), variant: "destructive" });
              }
            }}
          >
            {sendTest.isPending ? "Sending test…" : "Send test to myself"}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={blocked || send.isPending} onClick={doSend}>
              <Send className="w-3.5 h-3.5 mr-1" />
              {send.isPending ? "Sending…" : preview?.emailedAt ? "Send again" : `Send to ${po.vendorName}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Gmail connection for sending vendor POs. PO email goes out as the connected
 * mailbox, so it lands in that account's Sent folder and vendor replies come
 * straight back — the scope granted is send-only.
 */
function GmailCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetGmailStatus({
    query: { queryKey: getGetGmailStatusQueryKey(), staleTime: 30_000 },
  });
  const disconnect = useDisconnectGmail();

  // The OAuth callback bounces back here with the result — surface it once and
  // clean the query string so a refresh doesn't repeat the toast.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("gmail");
    if (!result) return;
    if (result === "connected") {
      const account = params.get("account");
      toast({ title: "Gmail connected", description: account ? `Sending PO email as ${account}` : undefined });
      void queryClient.invalidateQueries({ queryKey: getGetGmailStatusQueryKey() });
    } else {
      toast({
        title: "Could not connect Gmail",
        description: params.get("reason") ?? "Consent was not completed",
        variant: "destructive",
      });
    }
    params.delete("gmail");
    params.delete("account");
    params.delete("reason");
    const qs = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [queryClient, toast]);

  if (isLoading) return <Skeleton className="h-24 rounded-lg" />;

  const connected = data?.connected ?? false;
  const configured = data?.configured ?? false;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Send className="w-4 h-4 text-muted-foreground" /> Send PO Email
              {connected ? (
                data?.needsReconnect ? (
                  <Badge variant="outline" className="text-amber-700 border-amber-300 dark:text-amber-400">
                    Reconnect needed
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-emerald-700 border-emerald-300 dark:text-emerald-400">
                    Connected
                  </Badge>
                )
              ) : (
                <Badge variant="outline" className="text-amber-700 border-amber-300 dark:text-amber-400">
                  Not connected
                </Badge>
              )}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
              {connected ? (
                data?.needsReconnect ? (
                  <>
                    Sending works, but the PO follow-up agent needs permission to read vendor replies. Click
                    Reconnect and approve the added "read" permission — the agent only ever reads PO threads and
                    PO-number searches.
                  </>
                ) : (
                  <>
                    POs are sent from <span className="font-medium text-foreground">{data?.accountEmail}</span> with
                    the PO PDF attached, so they land in that account's Sent folder and vendor replies come back to
                    it. The follow-up agent watches those replies for the vendors you enable below.
                  </>
                )
              ) : configured ? (
                <>
                  Connect a Google account to send POs straight from the dashboard, PDF attached. You'll be asked only
                  for permission to send mail.
                </>
              ) : (
                <>
                  Google OAuth isn't set up on this deployment yet — <code>GOOGLE_OAUTH_CLIENT_ID</code> and{" "}
                  <code>GOOGLE_OAUTH_CLIENT_SECRET</code> need to be added in Vercel. Until then, the ✉ button opens a
                  draft in your mail client instead.
                </>
              )}
            </p>
            {configured && !connected && data?.redirectUri && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Authorized redirect URI to register: <code>{data.redirectUri}</code>
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {connected ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => (window.location.href = "/api/integrations/gmail/connect")}
                >
                  Reconnect
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-destructive"
                  disabled={disconnect.isPending}
                  onClick={async () => {
                    try {
                      await disconnect.mutateAsync();
                      await queryClient.invalidateQueries({ queryKey: getGetGmailStatusQueryKey() });
                      toast({ title: "Gmail disconnected" });
                    } catch (e) {
                      toast({ title: "Failed to disconnect", description: String(e), variant: "destructive" });
                    }
                  }}
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={!configured}
                onClick={() => (window.location.href = "/api/integrations/gmail/connect")}
              >
                Connect Google account
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

function VendorContactsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetVendorContacts({
    query: { queryKey: getGetVendorContactsQueryKey(), staleTime: 60_000 },
  });
  const setContact = useSetVendorContact();
  const [q, setQ] = React.useState("");

  const save = async (
    vendorName: string,
    patch: { toEmails?: string | null; ccEmails?: string | null; agentEnabled?: boolean },
  ) => {
    const current = (data?.items ?? []).find((v) => v.vendorName === vendorName);
    try {
      // Vendor name rides in the body — names like "Derprosa/Taghleef" contain
      // a slash and cannot be a URL path segment.
      await setContact.mutateAsync({
        data: {
          vendorName,
          toEmails: patch.toEmails !== undefined ? patch.toEmails : (current?.toEmails ?? null),
          ccEmails: patch.ccEmails !== undefined ? patch.ccEmails : (current?.ccEmails ?? null),
          agentEnabled: patch.agentEnabled !== undefined ? patch.agentEnabled : (current?.agentEnabled ?? false),
        },
      });
      await queryClient.invalidateQueries({ queryKey: getGetVendorContactsQueryKey() });
      toast({ title: "Saved", description: `${vendorName} PO contacts updated` });
    } catch (e) {
      toast({ title: "Failed to save", description: String(e), variant: "destructive" });
    }
  };

  if (isLoading) return <Skeleton className="h-56 rounded-lg" />;
  const rows = (data?.items ?? []).filter((v) =>
    !q.trim() ? true : v.vendorName.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const missing = (data?.items ?? []).filter((v) => !v.toEmails).length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Mail className="w-4 h-4 text-muted-foreground" /> Vendor PO Contacts
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Where POs are emailed, set once per vendor. Separate multiple addresses with commas.
              {missing > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                  {" "}· {missing} vendor{missing === 1 ? "" : "s"} still without a To address
                </span>
              )}
            </p>
          </div>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search vendor…"
            className="h-8 w-56 text-xs"
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground">
                <th className="text-left px-2 py-1.5 font-medium min-w-[12rem]">Vendor</th>
                <th className="text-left px-2 py-1.5 font-medium min-w-[18rem]">To</th>
                <th className="text-left px-2 py-1.5 font-medium min-w-[18rem]">CC</th>
                <th className="text-center px-2 py-1.5 font-medium" title="Follow-up agent: watch for acknowledgements and queue nudges for this vendor's POs">Agent</th>
                <th className="text-right px-2 py-1.5 font-medium">Materials</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.vendorName} className="border-b last:border-b-0 align-top">
                  <td className="px-2 py-1.5">
                    <div className="font-medium">{v.vendorName}</div>
                    {!v.toEmails && (
                      <div className="text-[10px] text-amber-700 dark:text-amber-400">no To address</div>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <EditableCell
                      value={v.toEmails ?? ""}
                      placeholder={v.legacyStockEmails ?? "orders@vendor.com, rep@vendor.com"}
                      onSave={(val) => save(v.vendorName, { toEmails: val })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <EditableCell
                      value={v.ccEmails ?? ""}
                      placeholder="purchasing@calyxcontainers.com"
                      onSave={(val) => save(v.vendorName, { ccEmails: val })}
                    />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <Checkbox
                      checked={v.agentEnabled ?? false}
                      onCheckedChange={(c) => save(v.vendorName, { agentEnabled: c === true })}
                      title="Watch this vendor's PO email for acknowledgements and queue follow-up drafts"
                    />
                  </td>
                  <td
                    className="px-2 py-1.5 text-right text-muted-foreground tabular-nums"
                    title={(v.stockIds ?? []).map((s) => `#${s}`).join(", ")}
                  >
                    {v.stockCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------
// PO follow-up agent: approval queue + per-PO activity timeline.
// ---------------------------------------------------------------------

/**
 * The agent's work queue. Drafts are follow-ups the agent WANTS to send —
 * nothing goes out until approved here. Needs-attention rows are where the
 * agent stopped and wants a human decision.
 */
function PoAgentQueueCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useGetPoAgentQueue({
    query: { queryKey: getGetPoAgentQueueQueryKey(), staleTime: 30_000 },
  });
  const approve = useApprovePoAgentDraft();
  const dismiss = useDismissPoAgentDraft();
  const resolve = useResolvePoAttention();
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [resolving, setResolving] = React.useState<{ poId: string; vendorName: string; reason?: string | null } | null>(null);
  const [explanation, setExplanation] = React.useState("");
  // Local edits per draft — what Approve actually sends. Untouched drafts send
  // the agent's wording unchanged.
  const [edits, setEdits] = React.useState<Record<string, { subject: string; body: string }>>({});

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetPoAgentQueueQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListMaterialPosQueryKey() }),
    ]);

  const drafts = data?.drafts ?? [];
  const attention = data?.needsAttention ?? [];
  if (drafts.length === 0 && attention.length === 0) return null;

  return (
    <Card className="border-amber-300/60 dark:border-amber-700/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Send className="w-4 h-4 text-muted-foreground" /> PO Agent — waiting on you
          <Badge variant="secondary">{drafts.length + attention.length}</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Follow-ups the agent drafted (nothing sends without your approval) and POs it flagged for review.
        </p>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {drafts.map((d) => (
          <div key={d.id} className="rounded-md border px-3 py-2 space-y-1">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <span className="font-medium">{d.vendorName}</span>
                {d.stockId && <span className="text-muted-foreground"> · Stock #{d.stockId}</span>}
                <span className="text-muted-foreground"> · {d.kind === "ack_nudge" ? "acknowledgement nudge" : d.kind}</span>
                <div className="text-muted-foreground truncate">To: {d.toEmails}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                >
                  {expanded === d.id ? "Hide" : "Review / edit"}
                </button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={approve.isPending}
                  onClick={async () => {
                    try {
                      const edit = edits[d.id];
                      await approve.mutateAsync({
                        id: d.id,
                        data: edit ? { subject: edit.subject, body: edit.body } : {},
                      });
                      toast({
                        title: edit ? "Edited follow-up sent" : "Follow-up sent",
                        description: `${d.vendorName} — ${edit?.subject ?? d.subject}`,
                      });
                      await refresh();
                    } catch (e) {
                      toast({ title: "Send failed", description: String(e), variant: "destructive" });
                    }
                  }}
                >
                  Approve & send
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground"
                  disabled={dismiss.isPending}
                  onClick={async () => {
                    await dismiss.mutateAsync({ id: d.id }).catch(() => {});
                    await refresh();
                  }}
                >
                  Dismiss
                </Button>
              </div>
            </div>
            {expanded === d.id && (
              <div className="space-y-1.5 rounded bg-muted/40 p-2">
                <Input
                  className="h-7 text-xs"
                  value={edits[d.id]?.subject ?? d.subject}
                  onChange={(e) =>
                    setEdits((prev) => ({
                      ...prev,
                      [d.id]: { subject: e.target.value, body: prev[d.id]?.body ?? d.body },
                    }))
                  }
                />
                <Textarea
                  className="text-xs min-h-[7rem] font-sans leading-relaxed"
                  value={edits[d.id]?.body ?? d.body}
                  onChange={(e) =>
                    setEdits((prev) => ({
                      ...prev,
                      [d.id]: { subject: prev[d.id]?.subject ?? d.subject, body: e.target.value },
                    }))
                  }
                />
                {edits[d.id] && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:underline"
                    onClick={() => setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== d.id)))}
                  >
                    Reset to the agent's wording
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {attention.map((a) => (
          <div key={a.poId} className="rounded-md border border-amber-300/60 px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
            <div className="min-w-0">
              <span className="font-medium">{a.vendorName}</span>
              {a.stockId && <span className="text-muted-foreground"> · Stock #{a.stockId}</span>}
              {a.ltPoNumbers && <span className="text-muted-foreground"> · LT PO {a.ltPoNumbers}</span>}
              <div className="text-amber-700 dark:text-amber-400">⚠ {a.reason ?? "Needs review"}</div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs shrink-0"
              onClick={() => {
                setResolving(a);
                setExplanation("");
              }}
            >
              Mark handled
            </Button>
          </div>
        ))}
      </CardContent>

      {/* Resolve with an optional lesson — this is how the agent learns. */}
      <Dialog open={resolving != null} onOpenChange={(o) => !o && setResolving(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Mark handled — {resolving?.vendorName}</DialogTitle>
            <DialogDescription className="text-xs">{resolving?.reason}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Textarea
              className="text-xs min-h-[5rem]"
              placeholder={`Optional: explain why this is fine — the agent will remember it for ${resolving?.vendorName ?? "this vendor"} and stop flagging it. e.g. "Their system rounds width to one decimal, so 12.8 on the confirmation means our 12.75."`}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">
              Leave blank to just clear the flag. Saved lessons appear on the Email tab and can be removed any time.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setResolving(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={resolve.isPending}
              onClick={async () => {
                if (!resolving) return;
                try {
                  await resolve.mutateAsync({
                    id: resolving.poId,
                    data: explanation.trim() ? { explanation: explanation.trim() } : {},
                  });
                  toast({
                    title: explanation.trim() ? "Handled — lesson saved" : "Handled",
                    description: explanation.trim()
                      ? `The agent will apply this to future ${resolving.vendorName} email`
                      : undefined,
                  });
                  setResolving(null);
                  await refresh();
                } catch (e) {
                  toast({ title: "Failed", description: String(e), variant: "destructive" });
                }
              }}
            >
              {explanation.trim() ? "Mark handled & teach the agent" : "Mark handled"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Lessons the agent has learned from resolved flags — visible and removable. */
function AgentLessonsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useGetPoAgentQueue({
    query: { queryKey: getGetPoAgentQueueQueryKey(), staleTime: 30_000 },
  });
  const remove = useDeleteAgentLesson();
  const lessons = data?.lessons ?? [];
  if (lessons.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">What the agent has learned</CardTitle>
        <p className="text-xs text-muted-foreground">
          Vendor conventions you approved when resolving flags. The classifier honors these on every future email —
          remove one and the agent goes back to flagging it.
        </p>
      </CardHeader>
      <CardContent className="space-y-1.5 text-xs">
        {lessons.map((l) => (
          <div key={l.id} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
            <div className="min-w-0">
              <Badge variant="outline" className="mr-2">
                {l.vendorName ?? "All vendors"}
              </Badge>
              {l.lesson}
              <span className="text-muted-foreground"> · {new Date(l.createdAt).toLocaleDateString()}</span>
            </div>
            <button
              type="button"
              className="text-muted-foreground hover:text-red-600 shrink-0"
              title="Forget this lesson"
              onClick={async () => {
                await remove.mutateAsync({ id: l.id }).catch(() => {});
                await queryClient.invalidateQueries({ queryKey: getGetPoAgentQueueQueryKey() });
                toast({ title: "Lesson removed" });
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Everything that happened around a PO's email conversation, plus captured vendor documents. */
function PoActivityDialog({ po, onClose }: { po: MaterialPo; onClose: () => void }) {
  const { data, isLoading } = useGetPoTimeline(po.id, {
    query: { queryKey: getGetPoTimelineQueryKey(po.id) },
  });
  const kindLabel: Record<string, string> = {
    sent: "Sent",
    follow_up: "Follow-up",
    ack: "Acknowledged",
    ship_notice: "Ship notice",
    delay: "Delay",
    question: "Question",
    ooo_or_auto: "Auto-reply",
    other: "Email",
    state_change: "Status",
    note: "Note",
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">
            Activity — {po.vendorName}
            {po.ltPoNumbers ? ` · PO ${po.ltPoNumbers}` : ""}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Email conversation and agent updates for this purchase order.
          </DialogDescription>
        </DialogHeader>
        {isLoading && <Skeleton className="h-40 rounded-md" />}
        {data && (
          <div className="space-y-3 text-xs max-h-[24rem] overflow-y-auto pr-1">
            {(data.attachments?.length ?? 0) > 0 && (
              <div className="rounded-md border px-3 py-2 space-y-1">
                <div className="font-medium">Vendor documents</div>
                {data.attachments!.map((a) => (
                  <div key={a.id} className="flex items-center gap-2">
                    <Printer className="w-3 h-3 text-muted-foreground" />
                    <button
                      type="button"
                      onClick={() => void openAuthorizedUrl(`/api/demand/pos/${po.id}/attachments/${a.id}`, a.filename)}
                      className="text-primary hover:underline"
                    >
                      {a.filename}
                    </button>
                    <span className="text-muted-foreground">
                      {(a.sizeBytes / 1024).toFixed(0)} KB · {new Date(a.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-1.5">
              {(data.events ?? []).map((e) => (
                <div key={e.id} className="flex items-start gap-2">
                  <span className="text-muted-foreground whitespace-nowrap tabular-nums">
                    {new Date(e.at).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                  <Badge variant="outline" className="shrink-0">
                    {kindLabel[e.kind] ?? e.kind}
                  </Badge>
                  <div className="min-w-0">
                    <div>{e.summary}</div>
                    {e.fromAddr && e.direction === "inbound" && (
                      <div className="text-muted-foreground truncate">{e.fromAddr}</div>
                    )}
                    {e.preview && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-primary hover:underline">
                          Read the message
                        </summary>
                        <div className="mt-1 whitespace-pre-wrap rounded bg-muted/40 p-2 leading-relaxed max-h-48 overflow-y-auto">
                          {e.subject && <div className="font-medium mb-1">{e.subject}</div>}
                          {e.preview}
                        </div>
                      </details>
                    )}
                  </div>
                </div>
              ))}
              {(data.events?.length ?? 0) === 0 && (
                <div className="text-muted-foreground">No activity recorded yet.</div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Stocks sitting below their Min on the shelf but NOT suggested for reorder,
 * because inbound POs already cover the gap. The reorder engine works on
 * position (on hand + on order) so it never double-buys what's already
 * inbound — this card makes that reasoning visible instead of leaving the
 * buyer wondering why a below-Min stock isn't in the list.
 */
function CoveredByInboundCard({
  rows,
  purch,
}: {
  rows: DemandStockMetrics[];
  purch: { items: PurchasingItem[] } | undefined;
}) {
  const purchByStock = React.useMemo(() => new Map((purch?.items ?? []).map((i) => [i.stockId, i])), [purch]);
  const covered = rows.filter(
    (r) =>
      !r.inactive &&
      !r.discontinued &&
      r.reorderPointFootage > 0 &&
      r.onHandFootage < r.reorderPointFootage &&
      !r.belowMin &&
      r.suggestedOrderRolls === 0 &&
      r.openPoFootage > 0,
  );
  if (covered.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <PackageCheck className="w-4 h-4 text-muted-foreground" />
          Below Min on hand — covered by inbound POs
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          On-hand is under the reorder point, but available stock (on hand + on order − open-ticket requirements)
          still clears the Min, so ordering again would double-buy. A stock reappears in Suggested POs the moment
          available drops below its Min.
        </p>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {covered.map((r) => {
          const available = r.availableFootage;
          const pos = purchByStock.get(r.stockId)?.openPos ?? [];
          return (
            <div key={r.stockId} className="rounded-md border px-3 py-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span>
                  <span className="font-medium">#{r.stockId}</span>{" "}
                  <span className="text-muted-foreground">{(r.description ?? "").slice(0, 44)}</span>
                </span>
                <span className="font-mono text-muted-foreground">
                  {fmt(r.onHandFootage)} ft on hand · Min {fmt(r.reorderPointFootage)}
                </span>
              </div>
              <div className="mt-1 text-muted-foreground">
                {pos.length > 0
                  ? pos
                      .map(
                        (p) =>
                          `PO ${p.poNumber}: ${fmt(p.totalFootage)} ft${
                            p.promisedDeliveryDate ? `, promised ${p.promisedDeliveryDate}` : ""
                          }`,
                      )
                      .join(" · ")
                  : `${fmt(r.openPoFootage)} ft on order`}
                {r.openTicketFootage > 0 ? ` − ${fmt(r.openTicketFootage)} ft booked` : ""}
                {" → available "}
                <span className="font-mono text-foreground">{fmt(available)} ft</span>
                {" ≥ Min. "}
                <span title="Available must fall below Min to trigger a suggestion">
                  To force another order now, set Min above {fmt(available)} ft.
                </span>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
