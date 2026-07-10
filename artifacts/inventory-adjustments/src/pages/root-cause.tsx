import * as React from "react";
import { Layout } from "@/components/layout";
import { DatePickerWithRange } from "@/components/date-range-picker";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useGetAdjustmentsRootCause,
  getGetAdjustmentsRootCauseQueryKey,
  setVarianceInvestigation,
  type RootCauseItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Link } from "wouter";
import { ArrowRight, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

type InvStatus = "open" | "root_cause_id" | "closed";
type CaStatus = "not_started" | "in_progress" | "complete";
type RootCauseCategory =
  | "missing_from_system"
  | "missing_from_floor"
  | "data_error"
  | "consumed_without_po"
  | "in_use"
  | "damage"
  | "other";

const INV_STATUS_LABELS: Record<InvStatus, string> = {
  open: "Open / Active",
  root_cause_id: "Root Cause ID'd",
  closed: "Closed",
};

const INV_STATUS_BADGE: Record<InvStatus, string> = {
  open: "bg-amber-100 text-amber-900 border border-amber-300",
  root_cause_id: "bg-sky-100 text-sky-900 border border-sky-300",
  closed: "bg-emerald-100 text-emerald-900 border border-emerald-300",
};

const CA_STATUS_LABELS: Record<CaStatus, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  complete: "Complete",
};

const CA_STATUS_BADGE: Record<CaStatus, string> = {
  not_started: "bg-slate-100 text-slate-700 border border-slate-300",
  in_progress: "bg-amber-100 text-amber-900 border border-amber-300",
  complete: "bg-emerald-100 text-emerald-900 border border-emerald-300",
};

const ROOT_CAUSE_OPTIONS: ReadonlyArray<{
  value: RootCauseCategory;
  label: string;
  defaultOwner: "SC" | "Prod/SC" | "Prod" | "Prod/Ops" | "—";
  timeline: string;
}> = [
  { value: "missing_from_system", label: "Missing from System", defaultOwner: "SC", timeline: "1–2 days" },
  { value: "missing_from_floor", label: "Missing from Floor", defaultOwner: "SC", timeline: "1–2 days" },
  { value: "data_error", label: "Data Error", defaultOwner: "SC", timeline: "1–2 days" },
  { value: "consumed_without_po", label: "Consumed without PO", defaultOwner: "Prod/SC", timeline: "2–3 days" },
  { value: "in_use", label: "In-Use", defaultOwner: "Prod", timeline: "1 day" },
  { value: "damage", label: "Damage", defaultOwner: "Prod/Ops", timeline: "2–3 days" },
  { value: "other", label: "Other", defaultOwner: "—", timeline: "—" },
];

const ROOT_CAUSE_LABEL: Record<RootCauseCategory, string> = Object.fromEntries(
  ROOT_CAUSE_OPTIONS.map((o) => [o.value, o.label]),
) as Record<RootCauseCategory, string>;

// Investigation thresholds (per WI-INV-025): a variance only requires
// investigation if the absolute net dollar impact exceeds $1,000 OR the
// absolute % of on-hand value exceeds 0.5%.
const NET_DOLLAR_THRESHOLD = 1000;
const PCT_THRESHOLD = 0.5;

function requiresInvestigation(item: RootCauseItem): boolean {
  if (Math.abs(item.netDollars) > NET_DOLLAR_THRESHOLD) return true;
  const pct = item.pctOfOnHand ?? null;
  if (pct != null && Math.abs(pct) > PCT_THRESHOLD) return true;
  return false;
}

function defaultFrom(): Date {
  const now = new Date();
  const apr15 = new Date(now.getFullYear(), 3, 15);
  return now >= apr15 ? apr15 : new Date(now.getFullYear() - 1, 3, 15);
}

function defaultTo(): Date {
  const now = new Date();
  const d = new Date(now);
  d.setDate(d.getDate() + 30);
  return d;
}

function formatFt(n: number): string {
  return `${Math.round(n).toLocaleString()} ft`;
}

function formatPct(p: number | null): string {
  if (p == null) return "—";
  return `${p > 0 ? "+" : ""}${p.toFixed(2)}%`;
}

export default function RootCause() {
  const [range, setRange] = React.useState<{ from: Date; to: Date }>({
    from: defaultFrom(),
    to: defaultTo(),
  });
  const [requiresOnly, setRequiresOnly] = React.useState(true);

  const fromIso = format(range.from, "yyyy-MM-dd");
  const toIso = format(range.to, "yyyy-MM-dd");

  const { data, isLoading, isError, error } = useGetAdjustmentsRootCause({
    from: fromIso,
    to: toIso,
  });

  const allItems = data?.items ?? [];
  // When the toggle is on, hide rows that are already closed in addition to
  // rows below the variance threshold — closed investigations don't need
  // further attention even if their numbers still exceed the threshold.
  const needsAttention = (it: RootCauseItem) =>
    requiresInvestigation(it) && it.status !== "closed";
  const requiresCount = allItems.filter(needsAttention).length;
  const items = requiresOnly ? allItems.filter(needsAttention) : allItems;
  const errorMsg = error instanceof Error ? error.message : "Unable to load variance data.";

  return (
    <Layout>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Root Cause</h1>
          <p className="text-sm text-muted-foreground">
            Investigate stock-level variances per WI-INV-025. Threshold:
            &gt;{" "}
            <span className="font-mono">±0.5%</span> of on-hand or{" "}
            <span className="font-mono">±$1,000</span> net.
          </p>
        </div>
        <DatePickerWithRange
          date={{ from: range.from, to: range.to }}
          setDate={(v) => {
            if (v?.from && v?.to) setRange({ from: v.from, to: v.to });
          }}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div>
              <CardTitle>Variances by Stock</CardTitle>
              <CardDescription>
                {isLoading
                  ? "Loading…"
                  : `${requiresCount} of ${allItems.length} stock${allItems.length === 1 ? "" : "s"} need attention (above threshold and not closed) — ${fromIso} → ${toIso}.`}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="requires-only"
                checked={requiresOnly}
                onCheckedChange={setRequiresOnly}
              />
              <Label htmlFor="requires-only" className="text-sm cursor-pointer">
                Show only items requiring investigation
              </Label>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          {isLoading ? (
            <div className="space-y-2 px-6 sm:px-0">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : isError ? (
            <p className="px-6 sm:px-0 text-sm text-red-700">
              Failed to load variances: {errorMsg}
            </p>
          ) : items.length === 0 ? (
            <p className="px-6 sm:px-0 text-sm text-muted-foreground">
              {requiresOnly && allItems.length > 0
                ? "No variances exceed the investigation threshold in this date range."
                : "No CC-coded inventory adjustments found in this date range."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[150px]">Stock</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Net Footage</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Net $</TableHead>
                    <TableHead className="text-right whitespace-nowrap">% of On-Hand</TableHead>
                    <TableHead className="min-w-[320px]">Investigation</TableHead>
                    <TableHead className="min-w-[320px]">Corrective Action</TableHead>
                    <TableHead className="w-[1%]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <RootCauseRow
                      key={item.stockId}
                      item={item}
                      fromIso={fromIso}
                      toIso={toIso}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}

interface RowProps {
  item: RootCauseItem;
  fromIso: string;
  toIso: string;
}

function RootCauseRow({ item, fromIso, toIso }: RowProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const needsInvestigation = requiresInvestigation(item);

  const initial = React.useMemo(
    () => ({
      status: (item.status as InvStatus | null) ?? null,
      category: (item.rootCauseCategory as RootCauseCategory | null) ?? null,
      notes: item.rootCause ?? "",
      owner: item.investigationOwner ?? "",
      caStatus: (item.correctiveActionStatus as CaStatus | null) ?? null,
      caAction: item.correctiveAction ?? "",
      caOwner: item.correctiveActionOwner ?? "",
    }),
    [item],
  );

  const [status, setStatus] = React.useState<InvStatus | null>(initial.status);
  const [category, setCategory] = React.useState<RootCauseCategory | null>(initial.category);
  const [notes, setNotes] = React.useState<string>(initial.notes);
  const [owner, setOwner] = React.useState<string>(initial.owner);
  const [caStatus, setCaStatus] = React.useState<CaStatus | null>(initial.caStatus);
  const [caAction, setCaAction] = React.useState<string>(initial.caAction);
  const [caOwner, setCaOwner] = React.useState<string>(initial.caOwner);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setStatus(initial.status);
    setCategory(initial.category);
    setNotes(initial.notes);
    setOwner(initial.owner);
    setCaStatus(initial.caStatus);
    setCaAction(initial.caAction);
    setCaOwner(initial.caOwner);
  }, [initial]);

  const dirty =
    status !== initial.status ||
    category !== initial.category ||
    notes !== initial.notes ||
    owner !== initial.owner ||
    caStatus !== initial.caStatus ||
    caAction !== initial.caAction ||
    caOwner !== initial.caOwner;

  async function handleSave() {
    setSaving(true);
    try {
      await setVarianceInvestigation(item.stockId, {
        status,
        rootCauseCategory: category,
        rootCause: notes.trim() ? notes : null,
        investigationOwner: owner.trim() ? owner : null,
        correctiveActionStatus: caStatus,
        correctiveAction: caAction.trim() ? caAction : null,
        correctiveActionOwner: caOwner.trim() ? caOwner : null,
      });
      await queryClient.invalidateQueries({
        queryKey: getGetAdjustmentsRootCauseQueryKey({ from: fromIso, to: toIso }),
      });
      toast({ title: "Saved", description: `Updated #${item.stockId}` });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Save failed";
      toast({ title: "Save failed", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const netFt = item.netFootage;
  const netDollars = item.netDollars;
  const pct = item.pctOfOnHand ?? null;
  const ftClass = netFt > 0 ? "text-emerald-700" : netFt < 0 ? "text-red-700" : "text-foreground";
  const dolClass =
    netDollars > 0 ? "text-emerald-700" : netDollars < 0 ? "text-red-700" : "text-foreground";
  const pctClass =
    pct == null
      ? "text-muted-foreground"
      : pct > 0
        ? "text-emerald-700"
        : pct < 0
          ? "text-red-700"
          : "text-foreground";

  return (
    <TableRow className={cn("align-top", !needsInvestigation && "bg-muted/30")}>
      <TableCell className="font-mono text-sm">
        <div className="flex items-center gap-1.5">
          <span className="font-medium">#{item.stockId}</span>
          {needsInvestigation ? (
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600" aria-label="Requires investigation" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" aria-label="Below threshold" />
          )}
        </div>
        {item.description && (
          <div className="text-xs text-muted-foreground font-sans line-clamp-2 mt-0.5">
            {item.description}
          </div>
        )}
        <div className="text-xs text-muted-foreground font-sans mt-1">
          {item.addedCount} added · {item.removedCount} removed
        </div>
      </TableCell>
      <TableCell className={cn("text-right font-mono text-sm whitespace-nowrap", ftClass)}>
        {netFt > 0 ? "+" : ""}
        {formatFt(netFt)}
      </TableCell>
      <TableCell className={cn("text-right font-mono text-sm whitespace-nowrap", dolClass)}>
        {netDollars > 0 ? "+" : ""}
        {formatCurrency(netDollars)}
      </TableCell>
      <TableCell
        className={cn("text-right font-mono text-sm tabular-nums whitespace-nowrap", pctClass)}
        title={
          item.onHandValue > 0
            ? `On-hand value: ${formatCurrency(item.onHandValue)}`
            : "No on-hand inventory"
        }
      >
        {formatPct(pct)}
      </TableCell>

      {/* Investigation column */}
      <TableCell>
        {!needsInvestigation ? (
          <BelowThresholdNote />
        ) : (
          <div className="space-y-2 min-w-[300px]">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Status
                </Label>
                <Select
                  value={status ?? "__none__"}
                  onValueChange={(v) =>
                    setStatus(v === "__none__" ? null : (v as InvStatus))
                  }
                >
                  <SelectTrigger className="h-8 text-xs mt-0.5">
                    <SelectValue placeholder="Select…">
                      {status ? (
                        <span
                          className={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium",
                            INV_STATUS_BADGE[status],
                          )}
                        >
                          {INV_STATUS_LABELS[status]}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">Not triaged</span>
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not triaged</SelectItem>
                    <SelectItem value="open">Open / Active</SelectItem>
                    <SelectItem value="root_cause_id">Root Cause ID'd</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Root Cause
                </Label>
                <Select
                  value={category ?? "__none__"}
                  onValueChange={(v) =>
                    setCategory(v === "__none__" ? null : (v as RootCauseCategory))
                  }
                >
                  <SelectTrigger className="h-8 text-xs mt-0.5">
                    <SelectValue placeholder="Select…">
                      {category ? ROOT_CAUSE_LABEL[category] : (
                        <span className="text-muted-foreground text-xs">Select…</span>
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— None —</SelectItem>
                    {ROOT_CAUSE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        <div className="flex flex-col">
                          <span>{o.label}</span>
                          <span className="text-[10px] text-muted-foreground">
                            Owner: {o.defaultOwner} · {o.timeline}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Owner
              </Label>
              <Input
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="Investigator name / initials"
                className="h-8 text-xs mt-0.5"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Evidence / Notes
              </Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Photo refs, count sheet #, explanation…"
                rows={2}
                className="text-xs mt-0.5"
              />
            </div>
          </div>
        )}
      </TableCell>

      {/* Corrective Action column */}
      <TableCell>
        {!needsInvestigation ? (
          <span className="text-xs text-muted-foreground italic">No action required</span>
        ) : (
          <div className="space-y-2 min-w-[300px]">
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                CA Status
              </Label>
              <Select
                value={caStatus ?? "__none__"}
                onValueChange={(v) =>
                  setCaStatus(v === "__none__" ? null : (v as CaStatus))
                }
              >
                <SelectTrigger className="h-8 text-xs mt-0.5">
                  <SelectValue placeholder="Select…">
                    {caStatus ? (
                      <span
                        className={cn(
                          "inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium",
                          CA_STATUS_BADGE[caStatus],
                        )}
                      >
                        {CA_STATUS_LABELS[caStatus]}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">— Pending —</span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— Pending —</SelectItem>
                  <SelectItem value="not_started">Not Started</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="complete">Complete</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Action Required
              </Label>
              <Textarea
                value={caAction}
                onChange={(e) => setCaAction(e.target.value)}
                placeholder="Recount, data correction, scrap…"
                rows={2}
                className="text-xs mt-0.5"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                CA Owner
              </Label>
              <Input
                value={caOwner}
                onChange={(e) => setCaOwner(e.target.value)}
                placeholder="Executor name / initials"
                className="h-8 text-xs mt-0.5"
              />
            </div>
          </div>
        )}
      </TableCell>

      <TableCell className="whitespace-nowrap">
        <div className="flex flex-col gap-1.5 items-stretch">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!dirty || saving || !needsInvestigation}
            className="h-8"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
          </Button>
          <Link href={`/stock/${encodeURIComponent(item.stockId)}`}>
            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 w-full">
              Details <ArrowRight className="w-3 h-3" />
            </Button>
          </Link>
        </div>
      </TableCell>
    </TableRow>
  );
}

function BelowThresholdNote() {
  return (
    <div className="text-xs text-muted-foreground italic flex items-start gap-1.5 max-w-[300px]">
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-0.5 flex-shrink-0" />
      <span>
        Below threshold (≤ ±$1,000 and ≤ ±0.5% of on-hand). No investigation required.
      </span>
    </div>
  );
}
