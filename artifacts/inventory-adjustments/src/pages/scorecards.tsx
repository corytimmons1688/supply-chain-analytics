import * as React from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  RadialBarChart,
  RadialBar,
  PolarAngleAxis,
} from "recharts";
import {
  AlertCircle,
  Plus,
  Trash2,
  Download,
  ClipboardCheck,
  Check,
  ChevronsUpDown,
  RefreshCw,
  Truck,
  ExternalLink,
  X,
  CheckCircle2,
  DollarSign,
  Clock,
  Package,
  PackageCheck,
  Link2,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetVendorScorecards,
  getGetVendorScorecardsQueryKey,
  useGetVendorTrend,
  getGetVendorTrendQueryKey,
  useGetVendorLeadTimes,
  getListVendorsQueryKey,
  useCreateVendor,
  useCreateVendorAlias,
  useListVendorAliases,
  getListVendorAliasesQueryKey,
  useUpdateVendorAlias,
  useDeleteVendorAlias,
  useSeedVendors,
  useSyncNetsuiteShipments,
  useSyncNetsuiteQualityCases,
  useSyncLabeltraxxLeadTimes,
  useUpsertVendorMetric,
  useListVendorShipments,
  getListVendorShipmentsQueryKey,
  useListQualityCases,
  getListQualityCasesQueryKey,
  useListQualityIssues,
  getListQualityIssuesQueryKey,
  useCreateQualityIssue,
  useDeleteQualityIssue,
  useListPricingReviews,
  getListPricingReviewsQueryKey,
  useCreatePricingReview,
  useDeletePricingReview,
  useListImprovementProjects,
  getListImprovementProjectsQueryKey,
  useCreateImprovementProject,
  useDeleteImprovementProject,
} from "@workspace/api-client-react";
import type {
  ScorecardView,
  Scorecard,
  VendorShipment,
  QualityCase,
  LeadTime,
  VendorAliasEntry,
} from "@workspace/api-client-react";

const VIEWS: { value: ScorecardView; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "qtd", label: "QTD" },
  { value: "ytd", label: "YTD" },
];

const TREND_MONTHS = [
  { value: "6", label: "6 mo" },
  { value: "12", label: "12 mo" },
  { value: "24", label: "24 mo" },
];

const GRADE_STYLES: Record<string, string> = {
  A: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/40",
  B: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/40",
  C: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40",
  D: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/40",
  F: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/40",
};

function pct(n: number | null | undefined): string {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}
function dollars(n: number | null | undefined): string {
  if (n == null) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}
function days(n: number | null | undefined): string {
  return n == null ? "—" : `${n.toFixed(1)} d`;
}
function todayMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "warn";
}) {
  const valueClass =
    tone === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground";
  return (
    <div className="flex flex-col rounded-lg border bg-card p-3">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`mt-0.5 text-lg font-semibold tabular-nums ${valueClass}`}>{value}</span>
      {hint && <span className="mt-0.5 text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

const GAUGE_COLORS = {
  good: "hsl(142 71% 45%)",
  warn: "hsl(38 92% 50%)",
  bad: "hsl(0 72% 51%)",
  none: "hsl(var(--muted-foreground))",
} as const;

function gaugeColor(
  value: number | null | undefined,
  good: number,
  warn: number,
): string {
  if (value == null) return GAUGE_COLORS.none;
  if (value >= good) return GAUGE_COLORS.good;
  if (value >= warn) return GAUGE_COLORS.warn;
  return GAUGE_COLORS.bad;
}

function Gauge({
  label,
  value,
  good,
  warn,
  hint,
  max = 100,
}: {
  label: string;
  value: number | null | undefined;
  good: number;
  warn: number;
  hint?: string;
  max?: number;
}) {
  const has = value != null && Number.isFinite(value);
  const clamped = has ? Math.max(0, Math.min(max, value as number)) : 0;
  const color = gaugeColor(value, good, warn);
  const data = [{ name: label, value: clamped, fill: color }];
  const config: ChartConfig = { value: { label, color } };
  return (
    <div className="flex flex-col items-center rounded-lg border bg-card p-3">
      <span className="self-start text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="relative mt-1 h-28 w-full">
        <ChartContainer config={config} className="h-28 w-full">
          <RadialBarChart
            data={data}
            startAngle={210}
            endAngle={-30}
            innerRadius="68%"
            outerRadius="100%"
            barSize={12}
          >
            <PolarAngleAxis type="number" domain={[0, max]} tick={false} axisLine={false} />
            <RadialBar
              dataKey="value"
              background={{ fill: "hsl(var(--muted))" }}
              cornerRadius={8}
              isAnimationActive={false}
            />
          </RadialBarChart>
        </ChartContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-bold tabular-nums" style={{ color: has ? color : undefined }}>
            {has ? `${(value as number).toFixed(0)}` : "—"}
          </span>
          {has && <span className="text-[10px] text-muted-foreground">of {max}</span>}
        </div>
      </div>
      {hint && <span className="mt-1 text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

// Top-line stat card (mirrors the reference dashboard: one filled accent card,
// the rest light with a tinted icon chip). Brand colors preserved.
function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  accent = false,
  tint = "primary",
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: boolean;
  tint?: "primary" | "emerald" | "amber" | "sky";
}) {
  const tintChip: Record<string, string> = {
    primary: "bg-primary/10 text-primary",
    emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    sky: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  };
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-xl border p-4 shadow-sm",
        accent ? "border-primary bg-primary text-primary-foreground" : "bg-card",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={cn(
            "text-[11px] font-medium uppercase tracking-wide",
            accent ? "text-primary-foreground/80" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        <span
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full",
            accent ? "bg-primary-foreground/15 text-primary-foreground" : tintChip[tint],
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <span className="mt-2 text-3xl font-bold tabular-nums leading-tight">{value}</span>
      {hint && (
        <span className={cn("mt-1 text-[11px]", accent ? "text-primary-foreground/70" : "text-muted-foreground")}>
          {hint}
        </span>
      )}
    </div>
  );
}

// Donut ring for the overall score (reference dashboard's center-percentage
// ring). Uses the brand primary for the value arc.
function ScoreDonut({ score, grade }: { score: number | null | undefined; grade: string | null | undefined }) {
  const has = score != null && Number.isFinite(score);
  const clamped = has ? Math.max(0, Math.min(100, score as number)) : 0;
  const config: ChartConfig = { value: { label: "Score", color: "hsl(var(--primary))" } };
  const data = [{ name: "score", value: clamped, fill: "hsl(var(--primary))" }];
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border bg-card p-4">
      <span className="self-start text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Overall score
      </span>
      <div className="relative mt-1 h-40 w-40">
        <ChartContainer config={config} className="h-40 w-40">
          <RadialBarChart
            data={data}
            startAngle={90}
            endAngle={-270}
            innerRadius="72%"
            outerRadius="100%"
            barSize={14}
          >
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
            <RadialBar dataKey="value" background={{ fill: "hsl(var(--muted))" }} cornerRadius={10} isAnimationActive={false} />
          </RadialBarChart>
        </ChartContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold tabular-nums text-foreground">{has ? `${(score as number).toFixed(0)}` : "—"}</span>
          <span className="text-xs text-muted-foreground">{grade ? `Grade ${grade}` : "no grade"}</span>
        </div>
      </div>
    </div>
  );
}

type DataCategory = NonNullable<Scorecard["dataCategory"]> | null;
function categoryLabel(cat: DataCategory): string {
  if (cat === "materials") return "Materials";
  if (cat === "finished_goods") return "Finished Goods";
  if (cat === "both") return "Materials + Finished Goods";
  return "—";
}

type UnmatchedResult = {
  source: string;
  kind: "netsuite" | "quality" | "labeltraxx";
  matched: number;
  names: { name: string; count: number | null }[];
};

export default function Scorecards() {
  const [view, setView] = React.useState<ScorecardView>("monthly");
  const [month, setMonth] = React.useState<string>(todayMonth());
  const [trendMonths, setTrendMonths] = React.useState<string>("12");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [comboOpen, setComboOpen] = React.useState(false);
  const [addVendorOpen, setAddVendorOpen] = React.useState(false);
  const [manageMappingsOpen, setManageMappingsOpen] = React.useState(false);
  const [unmatchedResult, setUnmatchedResult] = React.useState<UnmatchedResult | null>(null);
  const anchor = `${month}-01`;

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useGetVendorScorecards({ view, anchor });
  const seed = useSeedVendors();
  const syncNs = useSyncNetsuiteShipments();
  const syncQc = useSyncNetsuiteQualityCases();
  const syncLt = useSyncLabeltraxxLeadTimes();

  const items = React.useMemo(() => data?.items ?? [], [data]);

  // Auto-select first vendor once data arrives.
  React.useEffect(() => {
    if (!selectedId && items.length > 0) setSelectedId(items[0]!.vendor.id);
  }, [items, selectedId]);

  const selected: Scorecard | undefined = React.useMemo(
    () => items.find((i) => i.vendor.id === selectedId),
    [items, selectedId],
  );

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetVendorScorecardsQueryKey({ view, anchor }) }),
      queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() }),
      selectedId
        ? queryClient.invalidateQueries({
            queryKey: getGetVendorTrendQueryKey({ vendorId: selectedId, months: Number(trendMonths), anchor }),
          })
        : Promise.resolve(),
    ]);
  };

  const handleSeed = async () => {
    try {
      const r = await seed.mutateAsync();
      await invalidateAll();
      toast({ title: "Tracker loaded", description: `${r.created} added, ${r.skipped} already present` });
    } catch (e) {
      toast({ title: "Seed failed", description: String(e), variant: "destructive" });
    }
  };

  const handleSyncNetsuite = async () => {
    try {
      const r = await syncNs.mutateAsync();
      await invalidateAll();
      if (selectedId) {
        await queryClient.invalidateQueries({ queryKey: getListVendorShipmentsQueryKey({ vendorId: selectedId }) });
      }
      setUnmatchedResult({
        source: "NetSuite shipments",
        kind: "netsuite",
        matched: r.upserted,
        names: (r.unmatchedVendors ?? []).map((name) => ({ name, count: null })),
      });
      toast({ title: "NetSuite synced", description: `${r.upserted} shipments updated · ${r.unmatched} unmatched` });
    } catch (e) {
      toast({ title: "NetSuite sync failed", description: String(e), variant: "destructive" });
    }
  };

  const handleSyncQualityCases = async () => {
    try {
      const r = await syncQc.mutateAsync();
      await invalidateAll();
      if (selectedId) {
        await queryClient.invalidateQueries({ queryKey: getListQualityCasesQueryKey({ vendorId: selectedId }) });
      }
      setUnmatchedResult({
        source: "NetSuite quality cases",
        kind: "quality",
        matched: r.upserted,
        names: (r.unmatchedVendors ?? []).map((name) => ({ name, count: null })),
      });
      toast({ title: "Quality cases synced", description: `${r.upserted} cases attributed · ${r.unmatched} unmatched` });
    } catch (e) {
      toast({ title: "Quality case sync failed", description: String(e), variant: "destructive" });
    }
  };

  const handleSyncLeadTimes = async () => {
    try {
      const r = await syncLt.mutateAsync({});
      await invalidateAll();
      setUnmatchedResult({
        source: "Label Traxx lead times",
        kind: "labeltraxx",
        matched: r.upserted,
        names: (r.unmatchedSuppliers ?? []).map((s) => ({ name: s.name, count: s.count })),
      });
      toast({ title: "Lead times synced", description: `${r.upserted} POs matched · ${r.unmatched} unmatched` });
    } catch (e) {
      toast({ title: "Lead-time sync failed", description: String(e), variant: "destructive" });
    }
  };

  return (
    <Layout>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Vendor Score Cards</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Single-vendor performance — on-time shipment, lead time, quality, pricing & continuous improvement.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => setAddVendorOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Vendor
          </Button>
          <Button variant="outline" size="sm" onClick={() => setManageMappingsOpen(true)}>
            <Link2 className="w-4 h-4 mr-1" /> Name mappings
          </Button>
          <Button variant="outline" size="sm" onClick={handleSeed} disabled={seed.isPending}>
            <Download className="w-4 h-4 mr-1" /> Load tracker
          </Button>
          <Button variant="outline" size="sm" onClick={handleSyncNetsuite} disabled={syncNs.isPending}>
            <RefreshCw className={cn("w-4 h-4 mr-1", syncNs.isPending && "animate-spin")} /> Sync NetSuite
          </Button>
          <Button variant="outline" size="sm" onClick={handleSyncQualityCases} disabled={syncQc.isPending}>
            <RefreshCw className={cn("w-4 h-4 mr-1", syncQc.isPending && "animate-spin")} /> Sync quality cases
          </Button>
          <Button variant="outline" size="sm" onClick={handleSyncLeadTimes} disabled={syncLt.isPending}>
            <Truck className={cn("w-4 h-4 mr-1", syncLt.isPending && "animate-spin")} /> Sync lead times
          </Button>
        </div>
      </div>

      {data && !data.netsuiteConnected && (
        <ConnectionBanner
          title="NetSuite not connected yet."
          body="On-time shipment % will populate once the NetSuite connection is authorized and synced. Until then you can enter on-time manually per month."
        />
      )}
      {data && !data.labeltraxxConnected && (
        <ConnectionBanner
          title="No Label Traxx lead-time data yet."
          body="Click “Sync lead times” to pull purchase-order lead time (PO date → received) from Label Traxx, attributed per vendor. This is read-only."
        />
      )}

      {unmatchedResult && (
        <UnmatchedPanel
          result={unmatchedResult}
          vendors={items.map((sc) => ({ id: sc.vendor.id, name: sc.vendor.name }))}
          onResync={async () => {
            if (unmatchedResult.kind === "netsuite") await handleSyncNetsuite();
            else if (unmatchedResult.kind === "quality") await handleSyncQualityCases();
            else await handleSyncLeadTimes();
          }}
          onDismiss={() => setUnmatchedResult(null)}
        />
      )}

      {/* Vendor picker + period controls */}
      <Card>
        <CardContent className="pt-5 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1 min-w-[260px]">
            <Label className="text-xs">Vendor</Label>
            <Popover open={comboOpen} onOpenChange={setComboOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={comboOpen}
                  className="w-full justify-between font-normal"
                  disabled={items.length === 0}
                >
                  <span className="truncate">
                    {selected ? selected.vendor.name : items.length === 0 ? "No vendors yet" : "Select a vendor…"}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[320px] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search vendors…" />
                  <CommandList>
                    <CommandEmpty>No vendor found.</CommandEmpty>
                    <CommandGroup>
                      {items.map((sc) => (
                        <CommandItem
                          key={sc.vendor.id}
                          value={sc.vendor.name}
                          onSelect={() => {
                            setSelectedId(sc.vendor.id);
                            setComboOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              selectedId === sc.vendor.id ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <span className="flex-1 truncate">{sc.vendor.name}</span>
                          {sc.grade && (
                            <Badge variant="outline" className={cn("ml-2 text-[10px]", GRADE_STYLES[sc.grade])}>
                              {sc.grade}
                            </Badge>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-xs">Period view</Label>
            <Select value={view} onValueChange={(v) => setView(v as ScorecardView)}>
              <SelectTrigger className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VIEWS.map((v) => (
                  <SelectItem key={v.value} value={v.value}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-xs">Anchor month</Label>
            <Input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value || todayMonth())}
              className="w-[150px]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-xs">Trend window</Label>
            <Select value={trendMonths} onValueChange={setTrendMonths}>
              <SelectTrigger className="w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TREND_MONTHS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-72 rounded-lg" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <ClipboardCheck className="w-8 h-8 mx-auto mb-3 opacity-40" />
            <p>No vendors yet. Click “Load tracker” to pre-load the Flex Sourcing supplier list, or add a vendor.</p>
          </CardContent>
        </Card>
      ) : selected ? (
        <>
          <VendorScorecard scorecard={selected} periodLabel={data?.periodLabel ?? ""} />
          <VendorTrends
            vendorId={selected.vendor.id}
            months={Number(trendMonths)}
            anchor={anchor}
          />
          {(selected.dataCategory === "materials" || selected.dataCategory === "both") && (
            <MaterialsPoTable
              vendorId={selected.vendor.id}
              periodStart={data?.periodStart ?? ""}
              periodEnd={data?.periodEnd ?? ""}
              periodLabel={data?.periodLabel ?? ""}
            />
          )}
          {(selected.dataCategory === "finished_goods" ||
            selected.dataCategory === "both" ||
            selected.dataCategory == null) && (
            <VendorPoTable
              vendorId={selected.vendor.id}
              periodStart={data?.periodStart ?? ""}
              periodEnd={data?.periodEnd ?? ""}
              periodLabel={data?.periodLabel ?? ""}
            />
          )}
          <VendorQualityCases
            vendorId={selected.vendor.id}
            periodStart={data?.periodStart ?? ""}
            periodEnd={data?.periodEnd ?? ""}
            periodLabel={data?.periodLabel ?? ""}
          />
          <VendorEditors
            scorecard={selected}
            month={month}
            onChanged={invalidateAll}
          />
        </>
      ) : null}

      <AddVendorDialog
        open={addVendorOpen}
        onClose={() => setAddVendorOpen(false)}
        onChanged={invalidateAll}
      />

      <ManageMappingsDialog
        open={manageMappingsOpen}
        onClose={() => setManageMappingsOpen(false)}
        vendors={items.map((sc) => ({ id: sc.vendor.id, name: sc.vendor.name }))}
        onChanged={invalidateAll}
      />
    </Layout>
  );
}

// ---------------------------------------------------------------------
function ConnectionBanner({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
      <div>
        <span className="font-medium text-amber-800 dark:text-amber-300">{title}</span>{" "}
        <span className="text-muted-foreground">{body}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Mirrors `normAliasName` in artifacts/api-server/src/routes/vendors.ts so the
// closest-vendor suggestions use the exact same normalization as alias matching:
// lowercase, "&" -> "and", collapse punctuation/whitespace.
function normAliasName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein edit distance between two strings.
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

// Similarity score in [0,1] between two normalized names, combining whole-string
// edit-distance ratio with token (word) overlap so reordered/extra words still
// score well (e.g. "Acme Inc" vs "Acme Incorporated").
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  const editRatio = maxLen === 0 ? 0 : 1 - editDistance(a, b) / maxLen;
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  const tokenRatio = union === 0 ? 0 : inter / union;
  return Math.max(editRatio, tokenRatio);
}

// Top 1-3 vendors most similar to a raw unmatched name, above a confidence
// threshold so weak/irrelevant matches are not surfaced.
function suggestVendors(
  name: string,
  vendors: { id: string; name: string }[],
): { id: string; name: string; score: number }[] {
  const target = normAliasName(name);
  if (!target) return [];
  return vendors
    .map((v) => ({ ...v, score: similarity(target, normAliasName(v.name)) }))
    .filter((v) => v.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function UnmatchedPanel({
  result,
  vendors,
  onResync,
  onDismiss,
}: {
  result: UnmatchedResult;
  vendors: { id: string; name: string }[];
  onResync: () => Promise<void>;
  onDismiss: () => void;
}) {
  const { source, matched, names } = result;
  const allMatched = names.length === 0;
  const { toast } = useToast();
  const createAlias = useCreateVendorAlias();
  const createVendor = useCreateVendor();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [pickOpen, setPickOpen] = React.useState<string | null>(null);

  // Map a raw unmatched name to an existing vendor, then re-sync so the now
  // matchable rows flow in and the name drops off the list.
  const mapTo = async (name: string, vendorId: string, vendorName: string) => {
    setBusy(name);
    setPickOpen(null);
    try {
      await createAlias.mutateAsync({ data: { name, vendorId } });
      await onResync();
      toast({ title: "Name mapped", description: `“${name}” → ${vendorName}` });
    } catch (e) {
      toast({ title: "Mapping failed", description: String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  // Create a brand-new vendor from the unmatched name, save an alias so it keeps
  // matching, then re-sync.
  const createFrom = async (name: string) => {
    setBusy(name);
    try {
      const v = await createVendor.mutateAsync({ data: { name } });
      await createAlias.mutateAsync({ data: { name, vendorId: v.id } });
      await onResync();
      toast({ title: "Vendor created", description: name });
    } catch (e) {
      toast({ title: "Create failed", description: String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-sm",
        allMatched
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <div className="flex items-start gap-3">
        {allMatched ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
        ) : (
          <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          {allMatched ? (
            <span className="font-medium text-emerald-800 dark:text-emerald-300">
              {source}: all names matched a scorecard vendor ({matched} updated).
            </span>
          ) : (
            <>
              <span className="font-medium text-amber-800 dark:text-amber-300">
                {source}: {names.length} name{names.length === 1 ? "" : "s"} couldn’t be matched
              </span>{" "}
              <span className="text-muted-foreground">
                ({matched} matched). Map each name to a vendor or create one — it’s saved and re-synced automatically.
              </span>
              <div className="mt-2 max-h-72 overflow-y-auto rounded-md border bg-background/50">
                <ul className="divide-y">
                  {names.map((n, i) => {
                    const isBusy = busy === n.name;
                    const suggestions = suggestVendors(n.name, vendors);
                    return (
                      <li
                        key={`${n.name}-${i}`}
                        className="px-3 py-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                        <span className="truncate flex-1 min-w-0">{n.name || "(blank)"}</span>
                        {n.count != null && (
                          <Badge variant="secondary" className="shrink-0">
                            {n.count} PO{n.count === 1 ? "" : "s"}
                          </Badge>
                        )}
                        <div className="flex items-center gap-1 shrink-0">
                          <Popover
                            open={pickOpen === n.name}
                            onOpenChange={(o) => setPickOpen(o ? n.name : null)}
                          >
                            <PopoverTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7"
                                disabled={isBusy || busy != null || !n.name || vendors.length === 0}
                              >
                                {isBusy ? (
                                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <>Map to…</>
                                )}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[280px] p-0" align="end">
                              <Command>
                                <CommandInput placeholder="Search vendors…" />
                                <CommandList>
                                  <CommandEmpty>No vendor found.</CommandEmpty>
                                  <CommandGroup>
                                    {vendors.map((v) => (
                                      <CommandItem
                                        key={v.id}
                                        value={v.name}
                                        onSelect={() => mapTo(n.name, v.id, v.name)}
                                      >
                                        <span className="flex-1 truncate">{v.name}</span>
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7"
                            disabled={isBusy || busy != null || !n.name}
                            onClick={() => createFrom(n.name)}
                          >
                            <Plus className="w-3.5 h-3.5 mr-1" /> Create
                          </Button>
                        </div>
                        </div>
                        {suggestions.length > 0 && (
                          <div className="mt-1 flex items-center gap-1.5 flex-wrap pl-0.5">
                            <span className="text-xs text-muted-foreground shrink-0">Likely:</span>
                            {suggestions.map((sug) => (
                              <Button
                                key={sug.id}
                                variant="secondary"
                                size="sm"
                                className="h-6 px-2 text-xs font-normal"
                                disabled={isBusy || busy != null}
                                onClick={() => mapTo(n.name, sug.id, sug.name)}
                                title={`${Math.round(sug.score * 100)}% match`}
                              >
                                <span className="max-w-[180px] truncate">{sug.name}</span>
                                <span className="ml-1.5 text-muted-foreground tabular-nums">
                                  {Math.round(sug.score * 100)}%
                                </span>
                              </Button>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 -mr-1 -mt-1"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Review & undo saved vendor-name mappings (raw source name -> mapped vendor).
// Lists every alias, lets the user re-point one to a different vendor or delete
// it so it no longer auto-resolves on future syncs.
function ManageMappingsDialog({
  open,
  onClose,
  vendors,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  vendors: { id: string; name: string }[];
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useListVendorAliases({
    query: { enabled: open } as never,
  });
  const updateAlias = useUpdateVendorAlias();
  const deleteAlias = useDeleteVendorAlias();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [pickOpen, setPickOpen] = React.useState<string | null>(null);

  const aliases: VendorAliasEntry[] = React.useMemo(() => data?.items ?? [], [data]);

  // Human-friendly "X days ago" for the last sync where the mapping resolved a
  // name. Returns null when the alias has never matched a sync.
  const lastUsedLabel = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return null;
    const days = Math.floor((Date.now() - t) / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months > 1 ? "s" : ""} ago`;
    const years = Math.floor(days / 365);
    return `${years} year${years > 1 ? "s" : ""} ago`;
  };

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: getListVendorAliasesQueryKey() });
    await onChanged();
  };

  const repoint = async (alias: VendorAliasEntry, vendorId: string, vendorName: string) => {
    setBusy(alias.id);
    setPickOpen(null);
    try {
      await updateAlias.mutateAsync({ id: alias.id, data: { vendorId } });
      await refresh();
      toast({ title: "Mapping updated", description: `“${alias.alias}” → ${vendorName}` });
    } catch (e) {
      toast({ title: "Update failed", description: String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (alias: VendorAliasEntry) => {
    setBusy(alias.id);
    try {
      await deleteAlias.mutateAsync({ id: alias.id });
      await refresh();
      toast({ title: "Mapping removed", description: alias.alias });
    } catch (e) {
      toast({ title: "Delete failed", description: String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Vendor name mappings</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Saved mappings resolve a raw NetSuite / Label Traxx name to a vendor on every sync.
          Each one shows when it last matched a sync so you can prune stale ones. Re-point a
          wrong mapping or remove it entirely.
        </p>
        {isLoading ? (
          <div className="space-y-2 py-2">
            <Skeleton className="h-10 rounded-md" />
            <Skeleton className="h-10 rounded-md" />
            <Skeleton className="h-10 rounded-md" />
          </div>
        ) : aliases.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Link2 className="w-8 h-8 mx-auto mb-3 opacity-40" />
            <p>No saved mappings yet. Map an unmatched name after a sync to create one.</p>
          </div>
        ) : (
          <div className="max-h-[26rem] overflow-y-auto rounded-md border">
            <ul className="divide-y">
              {aliases.map((a) => {
                const isBusy = busy === a.id;
                const used = lastUsedLabel(a.lastUsedAt);
                const neverUsed = !a.lastUsedAt;
                return (
                  <li
                    key={a.id}
                    className={cn(
                      "flex items-center justify-between gap-2 px-3 py-2",
                      neverUsed && "bg-amber-50/60",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{a.alias}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        → {a.vendorName}
                      </span>
                      {neverUsed ? (
                        <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                          <AlertTriangle className="w-3 h-3" />
                          Never matched a sync — safe to remove
                        </span>
                      ) : (
                        <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="w-3 h-3" />
                          Last used {used}
                          {a.lastHitCount > 0
                            ? ` · ${a.lastHitCount} ${a.lastHitCount === 1 ? "row" : "rows"} last sync`
                            : ""}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Popover
                        open={pickOpen === a.id}
                        onOpenChange={(o) => setPickOpen(o ? a.id : null)}
                      >
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            disabled={isBusy || busy != null || vendors.length === 0}
                          >
                            {isBusy ? (
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <>Re-point…</>
                            )}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[280px] p-0" align="end">
                          <Command>
                            <CommandInput placeholder="Search vendors…" />
                            <CommandList>
                              <CommandEmpty>No vendor found.</CommandEmpty>
                              <CommandGroup>
                                {vendors.map((v) => (
                                  <CommandItem
                                    key={v.id}
                                    value={v.name}
                                    onSelect={() => repoint(a, v.id, v.name)}
                                  >
                                    <Check
                                      className={cn(
                                        "mr-2 h-4 w-4",
                                        v.id === a.vendorId ? "opacity-100" : "opacity-0",
                                      )}
                                    />
                                    <span className="flex-1 truncate">{v.name}</span>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        disabled={isBusy || busy != null}
                        onClick={() => remove(a)}
                        aria-label="Delete mapping"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------
function VendorScorecard({ scorecard, periodLabel }: { scorecard: Scorecard; periodLabel: string }) {
  const sc = scorecard;
  const cat = (sc.dataCategory ?? null) as DataCategory;
  const showMaterials = cat === "materials" || cat === "both";
  const showFinished = cat === "finished_goods" || cat === "both";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-xl truncate">{sc.vendor.name}</CardTitle>
            <p className="text-sm text-muted-foreground truncate">
              {[sc.vendor.country].filter(Boolean).join(" · ") || "—"}
              {periodLabel ? ` · ${periodLabel}` : ""}
            </p>
          </div>
          {cat && (
            <Badge variant="outline" className="shrink-0 bg-primary/5 text-primary border-primary/30">
              {categoryLabel(cat)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Top-line stat cards — first one filled (brand navy) per the reference. */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="Overall score"
            value={sc.score != null ? sc.score.toFixed(0) : "—"}
            hint={sc.grade ? `Grade ${sc.grade}` : "no grade yet"}
            icon={PackageCheck}
            accent
          />
          <StatCard
            label="On-time"
            value={pct(sc.onTimePct)}
            hint={(sc.totalShipments ?? 0) > 0 ? `${sc.onTimeShipments}/${sc.totalShipments} shipments` : "NetSuite"}
            icon={Truck}
            tint="emerald"
          />
          <StatCard
            label="Total spend"
            value={dollars(sc.totalSpend)}
            hint={(sc.purchaseCount ?? 0) > 0 ? `${sc.purchaseCount} bills · NetSuite` : "NetSuite bills"}
            icon={DollarSign}
            tint="sky"
          />
          <StatCard
            label="Avg lead time"
            value={days(showMaterials ? sc.avgLeadDays : sc.avgNsLeadDays)}
            hint={
              showMaterials
                ? (sc.leadPoCount ?? 0) > 0
                  ? `${sc.leadPoCount} POs · Label Traxx`
                  : "Label Traxx"
                : (sc.nsLeadPoCount ?? 0) > 0
                  ? `${sc.nsLeadPoCount} POs · NetSuite`
                  : "NetSuite"
            }
            icon={Clock}
            tint="amber"
          />
        </div>

        {/* Donut + category-gated gauges. */}
        <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-3">
          <ScoreDonut score={sc.score} grade={sc.grade} />
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <Gauge
              label="On-time"
              value={sc.onTimePct}
              good={95}
              warn={85}
              hint={(sc.totalShipments ?? 0) > 0 ? `${sc.onTimeShipments}/${sc.totalShipments}` : "NetSuite"}
            />
            {showMaterials && (
              <Gauge
                label="Fill rate (materials)"
                value={sc.materialsFillRatePct}
                good={98}
                warn={90}
                hint={
                  (sc.materialsRollsOrdered ?? 0) > 0
                    ? `${sc.materialsRollsReceived}/${sc.materialsRollsOrdered} rolls`
                    : "Label Traxx rolls"
                }
              />
            )}
          </div>
        </div>

        {/* Secondary metric tiles. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {showMaterials && (
            <Metric
              label="Materials fill rate"
              value={pct(sc.materialsFillRatePct)}
              hint={
                (sc.materialsRollsOrdered ?? 0) > 0
                  ? `${sc.materialsRollsReceived}/${sc.materialsRollsOrdered} rolls · Label Traxx`
                  : "Label Traxx"
              }
            />
          )}
          {showFinished && (
            <Metric label="Finished-goods fill rate" value={pct(sc.fillRatePct)} hint="NetSuite qty" />
          )}
          <Metric label="PPV / savings" value={dollars(sc.ppvSavings)} />
          <Metric
            label="Quality issues"
            value={String(sc.qualityIssueCount)}
            hint={(sc.openQualityIssueCount ?? 0) > 0 ? `${sc.openQualityIssueCount} open` : undefined}
          />
          <Metric label="Pricing reviews" value={String(sc.pricingReviewCount)} />
          <Metric
            label="CI projects"
            value={String(sc.improvementProjectCount)}
            hint={(sc.activeImprovementProjectCount ?? 0) > 0 ? `${sc.activeImprovementProjectCount} active` : undefined}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------
function VendorTrends({ vendorId, months, anchor }: { vendorId: string; months: number; anchor: string }) {
  const { data, isLoading } = useGetVendorTrend({ vendorId, months, anchor });
  const points = (data?.points ?? []).map((p) => ({
    label: p.label,
    onTimePct: p.onTimePct,
    avgLeadDays: p.avgLeadDays,
    score: p.score,
  }));

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-56 rounded-lg" />
        ))}
      </div>
    );
  }

  const hasAny = points.some((p) => p.onTimePct != null || p.avgLeadDays != null || p.score != null);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Trends</CardTitle>
        <p className="text-xs text-muted-foreground">Monthly history over the selected trend window.</p>
      </CardHeader>
      <CardContent>
        {!hasAny ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No trend data for this vendor yet. Sync NetSuite and lead times, or add monthly metrics below.
          </p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <TrendChart
              title="On-time %"
              data={points}
              dataKey="onTimePct"
              color="hsl(142 71% 45%)"
              domain={[0, 100]}
              unit="%"
            />
            <TrendChart
              title="Avg lead time (days)"
              data={points}
              dataKey="avgLeadDays"
              color="hsl(221 83% 53%)"
              unit=" d"
            />
            <TrendChart
              title="Overall score"
              data={points}
              dataKey="score"
              color="hsl(38 92% 50%)"
              domain={[0, 100]}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TrendChart({
  title,
  data,
  dataKey,
  color,
  domain,
  unit,
}: {
  title: string;
  data: { label: string }[];
  dataKey: string;
  color: string;
  domain?: [number, number];
  unit?: string;
}) {
  const config: ChartConfig = { [dataKey]: { label: title, color } };
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-2">{title}</p>
      <ChartContainer config={config} className="h-48 w-full">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            fontSize={11}
            interval="preserveStartEnd"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={48}
            fontSize={11}
            domain={domain ?? ["auto", "auto"]}
            allowDecimals={false}
            tickFormatter={(v) => `${v}${unit ?? ""}`}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Line
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={2}
            dot={{ r: 2 }}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
    </div>
  );
}

// ---------------------------------------------------------------------
function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(t)) return d;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------------
// Label Traxx purchase orders for materials vendors. Fill rate here is
// roll-based: rolls received ÷ rolls ordered (NOT MSI).
function MaterialsPoTable({
  vendorId,
  periodStart,
  periodEnd,
  periodLabel,
}: {
  vendorId: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
}) {
  const { data, isLoading } = useGetVendorLeadTimes({ vendorId });
  const allRows: LeadTime[] = data?.items ?? [];
  const rows = React.useMemo(
    () =>
      allRows.filter((r) => {
        const d = r.receivedDate ?? r.placedDate;
        return d != null && d >= periodStart && d <= periodEnd;
      }),
    [allRows, periodStart, periodEnd],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Package className="w-4 h-4 text-primary" /> Materials purchase orders (Label Traxx)
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Label Traxx POs received in {periodLabel || "the selected period"}, with lead time and roll-based fill rate
          (rolls received ÷ rolls ordered). Read-only.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-40 w-full rounded-lg" />
        ) : allRows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No Label Traxx POs synced for this vendor yet. Click “Sync lead times” above.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No Label Traxx POs for this vendor in {periodLabel || "the selected period"}. Adjust the date filters above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">PO</th>
                  <th className="py-2 px-3 font-medium">Placed</th>
                  <th className="py-2 px-3 font-medium">Received</th>
                  <th className="py-2 px-3 font-medium text-right">Lead (d)</th>
                  <th className="py-2 px-3 font-medium text-right">Rolls ordered</th>
                  <th className="py-2 px-3 font-medium text-right">Rolls received</th>
                  <th className="py-2 pl-3 font-medium text-right">Fill %</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{r.poNumber}</td>
                    <td className="py-2 px-3 text-muted-foreground">{fmtDate(r.placedDate)}</td>
                    <td className="py-2 px-3 text-muted-foreground">{fmtDate(r.receivedDate)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{r.leadDays}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{r.orderedRolls ?? "—"}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{r.receivedRolls ?? "—"}</td>
                    <td className="py-2 pl-3 text-right tabular-nums">
                      {r.fillRatePct != null ? `${r.fillRatePct}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function VendorPoTable({
  vendorId,
  periodStart,
  periodEnd,
  periodLabel,
}: {
  vendorId: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
}) {
  const { data, isLoading } = useListVendorShipments({ vendorId });
  const allRows: VendorShipment[] = data?.items ?? [];
  const rows = React.useMemo(
    () =>
      allRows.filter((r) => {
        const d = r.actualShipDate ?? r.customerDate;
        return d != null && d >= periodStart && d <= periodEnd;
      }),
    [allRows, periodStart, periodEnd],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Purchase orders</CardTitle>
        <p className="text-xs text-muted-foreground">
          NetSuite POs shipping in {periodLabel || "the selected period"}, with on-time status, lead time and fill rate.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-40 w-full rounded-lg" />
        ) : allRows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No POs synced for this vendor yet. Click “Sync NetSuite” above.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No POs for this vendor in {periodLabel || "the selected period"}. Adjust the date filters above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Order</th>
                  <th className="py-2 px-3 font-medium">PO date</th>
                  <th className="py-2 px-3 font-medium">Due</th>
                  <th className="py-2 px-3 font-medium">Shipped</th>
                  <th className="py-2 px-3 font-medium">On-time</th>
                  <th className="py-2 px-3 font-medium text-right">Lead (d)</th>
                  <th className="py-2 px-3 font-medium text-right">Ordered</th>
                  <th className="py-2 px-3 font-medium text-right">Shipped qty</th>
                  <th className="py-2 pl-3 font-medium text-right">Fill %</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{r.orderNo}</td>
                    <td className="py-2 px-3 text-muted-foreground">{fmtDate(r.poDate)}</td>
                    <td className="py-2 px-3 text-muted-foreground">{fmtDate(r.customerDate)}</td>
                    <td className="py-2 px-3 text-muted-foreground">{fmtDate(r.actualShipDate)}</td>
                    <td className="py-2 px-3">
                      {r.onTime == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : r.onTime ? (
                        <Badge variant="outline" className="border-green-600/40 text-green-700 dark:text-green-400">
                          On time
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-red-600/40 text-red-700 dark:text-red-400">
                          Late
                        </Badge>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{r.nsLeadDays ?? "—"}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{r.qtyOrdered ?? "—"}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{r.qtyShipped ?? "—"}</td>
                    <td className="py-2 pl-3 text-right tabular-nums">
                      {r.fillPct != null ? `${r.fillPct}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function VendorQualityCases({
  vendorId,
  periodStart,
  periodEnd,
  periodLabel,
}: {
  vendorId: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
}) {
  const { data, isLoading } = useListQualityCases({ vendorId });
  const allRows: QualityCase[] = data?.items ?? [];
  const rows = React.useMemo(
    () =>
      allRows.filter(
        (r) => r.startDate == null || (r.startDate >= periodStart && r.startDate <= periodEnd),
      ),
    [allRows, periodStart, periodEnd],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Quality cases (NetSuite)</CardTitle>
        <p className="text-xs text-muted-foreground">
          Support cases opened in {periodLabel || "the selected period"}, linked to this vendor via their special-order / drop-ship POs. Read-only from NetSuite.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-32 w-full rounded-lg" />
        ) : allRows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No NetSuite quality cases for this vendor. Click “Sync quality cases” above.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No quality cases for this vendor in {periodLabel || "the selected period"}. Adjust the date filters above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Case</th>
                  <th className="py-2 px-3 font-medium">Subject</th>
                  <th className="py-2 px-3 font-medium">Status</th>
                  <th className="py-2 px-3 font-medium">SO</th>
                  <th className="py-2 pl-3 font-medium text-right">Link</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium whitespace-nowrap">{r.caseNumber}</td>
                    <td className="py-2 px-3 max-w-md truncate" title={r.subject ?? ""}>
                      {r.subject || <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-2 px-3">
                      <Badge
                        variant="outline"
                        className={cn(
                          r.openCase
                            ? "border-amber-600/40 text-amber-700 dark:text-amber-400"
                            : "border-muted-foreground/30 text-muted-foreground",
                        )}
                      >
                        {r.statusName || (r.openCase ? "Open" : "Closed")}
                      </Badge>
                    </td>
                    <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">{r.soTranid ?? "—"}</td>
                    <td className="py-2 pl-3 text-right">
                      {r.caseUrl ? (
                        <a
                          href={r.caseUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          Open <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------
function AddVendorDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const create = useCreateVendor();
  const [name, setName] = React.useState("");
  const [country, setCountry] = React.useState("");
  const [category, setCategory] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setName("");
      setCountry("");
      setCategory("");
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return;
    try {
      await create.mutateAsync({ data: { name: name.trim(), country: country.trim() || null, category: category.trim() || null } });
      await onChanged();
      toast({ title: "Vendor added", description: name.trim() });
      onClose();
    } catch (e) {
      toast({ title: "Failed", description: String(e), variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add vendor</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Vendor name" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Country</Label>
              <Input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="USA" />
            </div>
            <div>
              <Label>Category</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Flexible packaging" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || !name.trim()}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------
function VendorEditors({
  scorecard,
  month,
  onChanged,
}: {
  scorecard: Scorecard;
  month: string;
  onChanged: () => Promise<void>;
}) {
  const vendorId = scorecard.vendor.id;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: qiData } = useListQualityIssues({ vendorId });
  const { data: prData } = useListPricingReviews({ vendorId });
  const { data: ipData } = useListImprovementProjects({ vendorId });

  const upsertMetric = useUpsertVendorMetric();
  const createQi = useCreateQualityIssue();
  const delQi = useDeleteQualityIssue();
  const createPr = useCreatePricingReview();
  const delPr = useDeletePricingReview();
  const createIp = useCreateImprovementProject();
  const delIp = useDeleteImprovementProject();

  const [onTime, setOnTime] = React.useState("");
  const [ppv, setPpv] = React.useState("");
  const [fill, setFill] = React.useState("");

  const refreshLists = async (kind: "qi" | "pr" | "ip") => {
    if (kind === "qi") await queryClient.invalidateQueries({ queryKey: getListQualityIssuesQueryKey({ vendorId }) });
    if (kind === "pr") await queryClient.invalidateQueries({ queryKey: getListPricingReviewsQueryKey({ vendorId }) });
    if (kind === "ip") await queryClient.invalidateQueries({ queryKey: getListImprovementProjectsQueryKey({ vendorId }) });
    await onChanged();
  };

  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  const saveMetric = async () => {
    try {
      await upsertMetric.mutateAsync({
        data: {
          vendorId,
          period: month,
          onTimePct: num(onTime),
          ppvSavings: num(ppv),
          fillRatePct: num(fill),
        },
      });
      await onChanged();
      toast({ title: "Metrics saved", description: `${scorecard.vendor.name} · ${month}` });
    } catch (e) {
      toast({ title: "Save failed", description: String(e), variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Manage vendor data</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="metrics">
          <TabsList className="grid grid-cols-4 w-full max-w-md">
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
            <TabsTrigger value="quality">Quality</TabsTrigger>
            <TabsTrigger value="pricing">Pricing</TabsTrigger>
            <TabsTrigger value="projects">CI</TabsTrigger>
          </TabsList>

          <TabsContent value="metrics" className="space-y-3 pt-3">
            <p className="text-xs text-muted-foreground">
              Manual monthly metrics for <span className="font-medium">{month}</span>. On-time auto-fills from NetSuite
              and avg lead time from Label Traxx when synced; enter values here to override or supplement.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">On-time % (0–100)</Label>
                <Input value={onTime} onChange={(e) => setOnTime(e.target.value)} type="number" placeholder="e.g. 95" />
              </div>
              <div>
                <Label className="text-xs">Fill rate / accuracy %</Label>
                <Input value={fill} onChange={(e) => setFill(e.target.value)} type="number" placeholder="e.g. 98" />
              </div>
              <div>
                <Label className="text-xs">PPV / cost savings ($)</Label>
                <Input value={ppv} onChange={(e) => setPpv(e.target.value)} type="number" placeholder="e.g. 1200" />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={saveMetric} disabled={upsertMetric.isPending}>
                Save metrics
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="quality" className="pt-3">
            <DatedListEditor
              kind="Quality issue"
              items={(qiData?.items ?? []).map((i) => ({
                id: i.id,
                date: i.occurredOn,
                title: i.title,
                meta: `${i.severity} · ${i.status}`,
              }))}
              extraField={{ label: "Severity", placeholder: "medium" }}
              onAdd={async (date, title, extra) => {
                await createQi.mutateAsync({ data: { vendorId, occurredOn: date, title, severity: extra || "medium" } });
                await refreshLists("qi");
              }}
              onDelete={async (id) => {
                await delQi.mutateAsync({ id });
                await refreshLists("qi");
              }}
            />
          </TabsContent>

          <TabsContent value="pricing" className="pt-3">
            <DatedListEditor
              kind="Pricing review"
              items={(prData?.items ?? []).map((i) => ({
                id: i.id,
                date: i.reviewedOn,
                title: i.title,
                meta: i.outcome ?? undefined,
              }))}
              extraField={{ label: "Outcome", placeholder: "3% reduction" }}
              onAdd={async (date, title, extra) => {
                await createPr.mutateAsync({ data: { vendorId, reviewedOn: date, title, outcome: extra || null } });
                await refreshLists("pr");
              }}
              onDelete={async (id) => {
                await delPr.mutateAsync({ id });
                await refreshLists("pr");
              }}
            />
          </TabsContent>

          <TabsContent value="projects" className="pt-3">
            <DatedListEditor
              kind="CI project"
              dateLabel="Start"
              items={(ipData?.items ?? []).map((i) => ({
                id: i.id,
                date: i.startedOn ?? "",
                title: i.title,
                meta: i.status,
              }))}
              extraField={{ label: "Status", placeholder: "in_progress" }}
              onAdd={async (date, title, extra) => {
                await createIp.mutateAsync({
                  data: { vendorId, title, startedOn: date || null, status: extra || "not_started" },
                });
                await refreshLists("ip");
              }}
              onDelete={async (id) => {
                await delIp.mutateAsync({ id });
                await refreshLists("ip");
              }}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------
function DatedListEditor({
  kind,
  items,
  extraField,
  dateLabel = "Date",
  onAdd,
  onDelete,
}: {
  kind: string;
  items: { id: string; date: string; title: string; meta?: string }[];
  extraField: { label: string; placeholder: string };
  dateLabel?: string;
  onAdd: (date: string, title: string, extra: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const { toast } = useToast();
  const [date, setDate] = React.useState<string>(new Date().toISOString().slice(0, 10));
  const [title, setTitle] = React.useState("");
  const [extra, setExtra] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await onAdd(date, title.trim(), extra.trim());
      setTitle("");
      setExtra("");
      toast({ title: `${kind} added` });
    } catch (e) {
      toast({ title: "Failed", description: String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[120px_1fr_120px_auto] gap-2 items-end">
        <div>
          <Label className="text-xs">{dateLabel}</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs">Title</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${kind} title`} />
        </div>
        <div>
          <Label className="text-xs">{extraField.label}</Label>
          <Input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={extraField.placeholder} />
        </div>
        <Button size="sm" onClick={add} disabled={busy || !title.trim()}>
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">No {kind.toLowerCase()}s logged.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="text-xs text-muted-foreground w-20 shrink-0">{it.date || "—"}</span>
              <span className="flex-1 min-w-0 truncate">{it.title}</span>
              {it.meta && <span className="text-xs text-muted-foreground shrink-0">{it.meta}</span>}
              <button
                type="button"
                className="text-muted-foreground hover:text-red-600 shrink-0"
                onClick={() => onDelete(it.id)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
