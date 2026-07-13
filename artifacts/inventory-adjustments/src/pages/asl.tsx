import * as React from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus,
  Trash2,
  Download,
  CheckCircle2,
  GitBranch,
  Pencil,
  ArrowRightCircle,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Check,
  ChevronDown,
  Clock,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FilterX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAsl,
  getGetAslQueryKey,
  useCreateAslEntry,
  useUpdateAslEntry,
  useDeleteAslEntry,
  useSetAslGoal,
  useListVendors,
  getListVendorsQueryKey,
  useSeedVendors,
  useSeedCurrentAsl,
  useCreateVendor,
  useUpdateVendor,
} from "@workspace/api-client-react";
import type { AslRow, Vendor } from "@workspace/api-client-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CAPABILITY_TAXONOMY,
  capabilityTag,
  parseCapabilities,
  serializeCapabilities,
} from "@/lib/capability-taxonomy";

type AslSegment = "raw_materials" | "finished_goods";
type AslStatus = "none" | "identified" | "in_progress" | "onboarded";

const STATUS_OPTIONS: { value: AslStatus; label: string }[] = [
  { value: "none", label: "—" },
  { value: "identified", label: "Identified" },
  { value: "in_progress", label: "In progress" },
  { value: "onboarded", label: "Onboarded" },
];

const STATUS_STYLES: Record<string, string> = {
  none: "text-muted-foreground/60 border-border",
  identified: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-400/40",
  in_progress: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40",
  onboarded: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/40",
};

const SEGMENT_LABEL: Record<string, string> = {
  raw_materials: "Raw Materials",
  finished_goods: "Finished Goods",
};

function statusLabel(s: string): string {
  return STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s;
}

// =====================================================================
// 45-day sourcing SLA (spec in → PO-ready; see the sourcing Gantt).
// Day 0 = Spec in · Day 11 = NDA executed · Day 28 = supplier selected ·
// Day 35 = full MSA / commercial · Day 45 = PO-ready (SLA deadline).
// =====================================================================
const SLA_TOTAL_DAYS = 45;
// Amber "approaching SLA" threshold (MSA target day).
const SLA_WARN_DAY = 35;

function parseIsoDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(t) ? null : new Date(t);
}

function addDaysIso(start: Date, days: number): string {
  const d = new Date(start);
  d.setDate(d.getDate() + days);
  // Format in local time — toISOString() reports the UTC date, which is off
  // by one for local-midnight dates in positive-offset timezones.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Days elapsed on the SLA clock. The clock freezes at PO-ready (the SLA
 * endpoint) or, failing that, at onboarding. Null = clock not started.
 */
function slaDaysElapsed(r: AslRow): number | null {
  const start = slaAnchor(r);
  if (!start) return null;
  const end =
    parseIsoDate(r.vendor.poReadyDate) ??
    (r.entry.status === "onboarded" ? parseIsoDate(r.entry.onboardedOn) : null) ??
    new Date();
  // Count calendar days from local date components — raw ms division loses an
  // hour across DST and undercounts by one day.
  const dayNum = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  const days = dayNum(end) - dayNum(start);
  // Negative = inverted dates (typo) or a future spec-in; treat as not started
  // rather than reporting a false green "Day 0".
  return days < 0 ? null : days;
}

function slaDone(r: AslRow): boolean {
  return !!r.vendor.poReadyDate || r.entry.status === "onboarded";
}

function SlaCell({ r }: { r: AslRow }) {
  const days = slaDaysElapsed(r);
  if (days == null) {
    return (
      <span
        className="text-muted-foreground/50"
        title="Set the Vendor identified date (click the step in the expanded row) to start the 45-day clock"
      >
        —
      </span>
    );
  }
  if (slaDone(r)) {
    const ok = days <= SLA_TOTAL_DAYS;
    return (
      <Badge
        variant="outline"
        className={cn(
          "whitespace-nowrap",
          ok ? STATUS_STYLES["onboarded"] : "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/40",
        )}
        title={r.vendor.poReadyDate ? `PO-ready ${r.vendor.poReadyDate}` : "Onboarded"}
      >
        Done · {days}d
      </Badge>
    );
  }
  const over = days > SLA_TOTAL_DAYS;
  const warn = !over && days > SLA_WARN_DAY;
  const pct = Math.min(100, (days / SLA_TOTAL_DAYS) * 100);
  return (
    <div
      className="min-w-[6.5rem]"
      title={`Identified ${r.vendor.specInDate ?? "—"} · MSA target day ${SLA_WARN_DAY} · PO-ready / SLA day ${SLA_TOTAL_DAYS}`}
    >
      <div
        className={cn(
          "text-xs font-medium tabular-nums",
          over && "text-red-600 dark:text-red-400",
          warn && "text-amber-600 dark:text-amber-400",
        )}
      >
        {over ? `+${days - SLA_TOTAL_DAYS}d over SLA` : `Day ${days} / ${SLA_TOTAL_DAYS}`}
      </div>
      <div className="h-1 rounded bg-muted mt-1 overflow-hidden">
        <div
          className={cn("h-full rounded", over ? "bg-red-500" : warn ? "bg-amber-500" : "bg-emerald-500")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Inline SLA milestone editor (expanded row). Each step has an editable
// completed date + evidence link that save on blur — no dialog needed.
// ---------------------------------------------------------------------

function InlineDate({
  value,
  onSave,
  disabled,
}: {
  value: string | null | undefined;
  onSave: (v: string | null) => void;
  disabled?: boolean;
}) {
  const [v, setV] = React.useState(value ?? "");
  // Tracks the last value we saved (or received) so the unmount flush never
  // re-sends a value the blur commit already sent.
  const committedRef = React.useRef<string | null>(value ?? null);
  React.useEffect(() => {
    setV(value ?? "");
    committedRef.current = value ?? null;
  }, [value]);
  const commit = () => {
    const next = v || null;
    if (next !== committedRef.current) {
      committedRef.current = next;
      onSave(next);
    }
  };
  // Radix unmounts the popover content without blurring the focused input
  // (Escape / Safari outside-clicks), so flush any dirty edit on unmount.
  const commitRef = React.useRef(commit);
  commitRef.current = commit;
  React.useEffect(() => () => commitRef.current(), []);
  return (
    <Input
      type="date"
      className="h-7 w-[9.5rem] text-xs"
      value={v}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function InlineLink({
  value,
  onSave,
  disabled,
}: {
  value: string | null | undefined;
  onSave: (v: string | null) => void;
  disabled?: boolean;
}) {
  const [v, setV] = React.useState(value ?? "");
  const committedRef = React.useRef<string | null>(value ?? null);
  React.useEffect(() => {
    setV(value ?? "");
    committedRef.current = value ?? null;
  }, [value]);
  const commit = () => {
    const trimmed = v.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next !== committedRef.current) {
      committedRef.current = next;
      onSave(next);
    }
  };
  // Flush dirty edits when the popover unmounts without blurring (Escape).
  const commitRef = React.useRef(commit);
  commitRef.current = commit;
  React.useEffect(() => () => commitRef.current(), []);
  const href = value && /^https?:\/\//.test(value) ? value : value ? `https://${value}` : null;
  return (
    <div className="flex items-center gap-1 min-w-0">
      <Input
        type="url"
        placeholder="Paste doc link…"
        className="h-7 text-xs flex-1 min-w-0"
        value={v}
        disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={href}
          className="text-primary hover:text-primary/80 shrink-0 p-1"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      )}
    </div>
  );
}

/** Grouped capability checkboxes (shared by the dialog and cell popovers). */
function CapabilityChecklist({
  selectedSet,
  toggle,
}: {
  selectedSet: Set<string>;
  toggle: (tag: string) => void;
}) {
  return (
    <div className="max-h-72 overflow-y-auto p-2">
      {CAPABILITY_TAXONOMY.map((cat) => (
        <div key={cat.category} className="mb-2 last:mb-0">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 px-1.5 py-1">
            {cat.category}
          </div>
          {cat.capabilities.map((cap) => {
            const tag = capabilityTag(cat.category, cap);
            return (
              <label
                key={tag}
                className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-accent cursor-pointer text-xs"
              >
                <Checkbox checked={selectedSet.has(tag)} onCheckedChange={() => toggle(tag)} />
                {cap}
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Flat product-category checkboxes (shared by the dialog and cell popovers). */
function CategoryChecklist({
  selectedSet,
  toggle,
}: {
  selectedSet: Set<string>;
  toggle: (tag: string) => void;
}) {
  return (
    <div className="max-h-72 overflow-y-auto p-2">
      {CAPABILITY_TAXONOMY.map((cat) => (
        <label
          key={cat.category}
          className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-accent cursor-pointer text-xs"
        >
          <Checkbox checked={selectedSet.has(cat.category)} onCheckedChange={() => toggle(cat.category)} />
          {cat.category}
        </label>
      ))}
    </div>
  );
}

/**
 * Multi-select for vendor capabilities, grouped by product category from the
 * supply-web taxonomy. Values are stored as qualified "Category: Capability"
 * tags; legacy free-text values are preserved and shown as removable tags.
 */
function CapabilityMultiSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const selected = parseCapabilities(value);
  const selectedSet = new Set(selected);
  const known = new Set(
    CAPABILITY_TAXONOMY.flatMap((c) => c.capabilities.map((cap) => capabilityTag(c.category, cap))),
  );
  const legacy = selected.filter((t) => !known.has(t));

  const toggle = (tag: string) => {
    const next = selectedSet.has(tag) ? selected.filter((t) => t !== tag) : [...selected, tag];
    onChange(serializeCapabilities(next) ?? "");
  };

  return (
    <div className="space-y-1.5">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="w-full justify-between font-normal h-9">
            <span className="truncate text-left">
              {selected.length === 0 ? (
                <span className="text-muted-foreground">Select capabilities…</span>
              ) : (
                `${selected.length} selected`
              )}
            </span>
            <ChevronDown className="w-3.5 h-3.5 opacity-60 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <CapabilityChecklist selectedSet={selectedSet} toggle={toggle} />
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((tag) => (
            <Badge
              key={tag}
              variant="outline"
              className={cn(
                "text-[10px] cursor-pointer hover:bg-destructive/10",
                legacy.includes(tag) && "border-amber-500/50 text-amber-700 dark:text-amber-400",
              )}
              title={legacy.includes(tag) ? "Legacy free-text value — click to remove" : "Click to remove"}
              onClick={() => toggle(tag)}
            >
              {tag} ✕
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/** Multi-select over the 16 supply-web product categories. */
function CategoryMultiSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const selected = parseCapabilities(value);
  const selectedSet = new Set(selected);
  const toggle = (cat: string) => {
    const next = selectedSet.has(cat) ? selected.filter((t) => t !== cat) : [...selected, cat];
    onChange(serializeCapabilities(next) ?? "");
  };
  return (
    <div className="space-y-1.5">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="w-full justify-between font-normal h-9">
            <span className="truncate text-left">
              {selected.length === 0 ? (
                <span className="text-muted-foreground">Select product categories…</span>
              ) : (
                `${selected.length} selected`
              )}
            </span>
            <ChevronDown className="w-3.5 h-3.5 opacity-60 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <CategoryChecklist selectedSet={selectedSet} toggle={toggle} />
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((tag) => (
            <Badge
              key={tag}
              variant="outline"
              className="text-[10px] cursor-pointer hover:bg-destructive/10"
              title="Click to remove"
              onClick={() => toggle(tag)}
            >
              {tag} ✕
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shared save hook for click-to-edit vendor fields (partial PUT). */
function useVendorFieldSave(r: AslRow, onChanged: () => Promise<void>) {
  const { toast } = useToast();
  const update = useUpdateVendor();
  const save = async (patch: Partial<Record<VendorKey, string | null>>) => {
    try {
      await update.mutateAsync({
        vendorId: r.vendor.id,
        data: { name: r.vendor.name, ...patch } as never,
      });
      await onChanged();
    } catch (e) {
      toast({ title: "Save failed", description: String(e), variant: "destructive" });
    }
  };
  return { save, pending: update.isPending };
}

/** Click the value → input appears → Enter/blur saves, Escape cancels. */
function InlineEditableText({
  value,
  onSave,
  multiline,
  display,
}: {
  value: string | null | undefined;
  onSave: (v: string | null) => void;
  multiline?: boolean;
  display?: React.ReactNode;
}) {
  const [editing, setEditing] = React.useState(false);
  const [v, setV] = React.useState(value ?? "");
  React.useEffect(() => setV(value ?? ""), [value]);
  const commit = () => {
    setEditing(false);
    const next = v.trim() === "" ? null : v.trim();
    if (next !== ((value ?? "").trim() || null)) onSave(next);
  };
  const cancel = () => {
    setEditing(false);
    setV(value ?? "");
  };
  if (!editing) {
    return (
      <button
        type="button"
        title="Click to edit"
        className="block w-full text-left text-xs rounded px-1 -mx-1 py-0.5 hover:bg-accent/60 cursor-text min-h-[1.4rem]"
        onClick={() => setEditing(true)}
      >
        {display ?? (value ? <span className="block truncate">{value}</span> : <span className="text-muted-foreground/50">—</span>)}
      </button>
    );
  }
  if (multiline) {
    return (
      <Textarea
        autoFocus
        rows={2}
        className="text-xs"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
        }}
      />
    );
  }
  return (
    <Input
      autoFocus
      className="h-7 text-xs"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") cancel();
      }}
    />
  );
}

/** Renders the right inline editor for a column's `editor` kind. */
function EditableValue({
  col,
  r,
  save,
}: {
  col: Col;
  r: AslRow;
  save: (patch: Partial<Record<VendorKey, string | null>>) => Promise<void>;
}) {
  const key = col.key as VendorKey;
  const raw = (r.vendor as unknown as Record<string, string | null | undefined>)[col.key] ?? null;
  if (col.editor === "capabilities" || col.editor === "categories") {
    const selected = parseCapabilities(raw);
    const Checklist = col.editor === "capabilities" ? CapabilityChecklist : CategoryChecklist;
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Click to edit"
            className="block w-full text-left text-xs rounded px-1 -mx-1 py-0.5 hover:bg-accent/60 min-h-[1.4rem]"
          >
            {selected.length ? (
              <span className="flex flex-wrap gap-1">
                {selected.slice(0, 3).map((t) => (
                  <Badge key={t} variant="outline" className="text-[10px] font-normal">
                    {t}
                  </Badge>
                ))}
                {selected.length > 3 && (
                  <span className="text-[10px] text-muted-foreground">+{selected.length - 3} more</span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground/50">—</span>
            )}
          </button>
        </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start">
          <Checklist
            selectedSet={new Set(selected)}
            toggle={(tag) => {
              const next = selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag];
              void save({ [key]: serializeCapabilities(next) });
            }}
          />
        </PopoverContent>
      </Popover>
    );
  }
  if (col.editor === "text" || col.editor === "multiline") {
    return (
      <InlineEditableText
        value={raw}
        multiline={col.editor === "multiline"}
        onSave={(v) => void save({ [key]: v })}
        display={col.key === "website" ? (raw ? col.render(r) : undefined) : undefined}
      />
    );
  }
  return <>{col.render(r)}</>;
}

type SlaStep = {
  label: string;
  day: number;
  dateKey: VendorKey;
  linkKey: VendorKey;
};

// Every task row from the 45-day sourcing Gantt, in schedule order. The first
// step ("Vendor identified", Day 0) anchors the 45-day clock.
const SLA_STEPS: SlaStep[] = [
  { label: "Vendor identified", day: 0, dateKey: "specInDate", linkKey: "specInLink" },
  { label: "NDA execution", day: 11, dateKey: "ndaDate", linkKey: "ndaLink" },
  { label: "Assessment + initial samples", day: 25, dateKey: "assessmentDate", linkKey: "assessmentLink" },
  { label: "Quality Agreement", day: 28, dateKey: "qualityAgreementDate", linkKey: "qualityAgreementLink" },
  { label: "Review samples & select", day: 28, dateKey: "supplierSelectedDate", linkKey: "supplierSelectedLink" },
  { label: "Factory audit (3rd-party)", day: 35, dateKey: "factoryTourDate", linkKey: "factoryAuditLink" },
  { label: "NetSuite setup", day: 35, dateKey: "netsuiteSetupDate", linkKey: "netsuiteSetupLink" },
  { label: "Full MSA / commercial", day: SLA_WARN_DAY, dateKey: "msaDate", linkKey: "msaLink" },
  { label: "PO-ready", day: SLA_TOTAL_DAYS, dateKey: "poReadyDate", linkKey: "poReadyLink" },
];

const CREDIT_CHECK_STEP: SlaStep = {
  label: "Credit check (intl)",
  day: 8,
  dateKey: "creditCheckDate",
  linkKey: "creditCheckLink",
};

/** Day-0 anchor for the SLA clock: the Vendor-identified date (manual). */
function slaAnchor(r: AslRow): Date | null {
  return parseIsoDate(r.vendor.specInDate);
}

/** Completed date for a step (all steps are set manually, incl. Vendor identified). */
function stepDate(r: AslRow, s: SlaStep): string | null {
  return (r.vendor[s.dateKey] as string | null | undefined) ?? null;
}

/** SLA steps for a vendor — international vendors get a Credit check step. */
function slaStepsFor(r: AslRow): SlaStep[] {
  if ((r.vendor.track ?? "").toLowerCase() !== "international") return SLA_STEPS;
  const steps = [...SLA_STEPS];
  steps.splice(1, 0, CREDIT_CHECK_STEP); // right after Vendor identified
  return steps;
}

/** The next outstanding SLA task — shown in the Pipeline Status column. */
function nextOutstanding(r: AslRow): { label: string; index: number } {
  if (r.entry.status === "onboarded") return { label: "Onboarded", index: 98 };
  const steps = slaStepsFor(r);
  const idx = steps.findIndex((s) => !stepDate(r, s));
  if (idx === -1) return { label: "All steps complete", index: 97 };
  return { label: steps[idx]!.label, index: idx };
}

type StepState = "done" | "late" | "overdue" | "pending";

function stepState(r: AslRow, s: SlaStep, start: Date | null): StepState {
  const actual = parseIsoDate(stepDate(r, s));
  const target = start ? addDaysIso(start, s.day) : null;
  const targetEnd = target ? Date.parse(`${target}T23:59:59`) : null;
  if (actual) return targetEnd != null && actual.getTime() > targetEnd ? "late" : "done";
  if (targetEnd != null && Date.now() > targetEnd && !slaDone(r)) return "overdue";
  return "pending";
}

// Local-timezone date — toISOString() would roll to tomorrow during the
// evening for US users because it reports the UTC date.
function localDateIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayIso(): string {
  return localDateIso(new Date());
}


/**
 * Interactive SLA stepper: one node per Gantt step on a progress rail.
 * Clicking a node opens a popover to set the completed date (with a Today
 * shortcut) and the evidence link — the always-on input wall is gone.
 */
function SlaStepper({ r, onChanged }: { r: AslRow; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const update = useUpdateVendor();
  const start = slaAnchor(r);

  const save = async (patch: Partial<Record<VendorKey, string | null>>) => {
    try {
      await update.mutateAsync({
        vendorId: r.vendor.id,
        data: { name: r.vendor.name, ...patch } as never,
      });
      await onChanged();
    } catch (e) {
      toast({ title: "Save failed", description: String(e), variant: "destructive" });
    }
  };

  const steps = slaStepsFor(r);
  const doneCount = steps.filter((s) => stepDate(r, s)).length;
  const days = slaDaysElapsed(r);
  const nextStep = steps.find((s) => !stepDate(r, s));

  return (
    <div className="rounded-md border bg-background/60 px-4 pt-3 pb-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <div className="text-xs">
          <span className="font-semibold">
            {doneCount} / {steps.length} steps complete
          </span>
          {days != null && (
            <span className={cn("text-muted-foreground", days > SLA_TOTAL_DAYS && !slaDone(r) && "text-red-600 dark:text-red-400 font-medium")}>
              {" "}· Day {days} of {SLA_TOTAL_DAYS}
            </span>
          )}
          {start && nextStep && (
            <span className="text-muted-foreground">
              {" "}· next: <span className="font-medium text-foreground">{nextStep.label}</span> due{" "}
              {addDaysIso(start, nextStep.day)}
            </span>
          )}
        </div>
        {!start ? (
          <span className="text-[11px] text-amber-600 dark:text-amber-400">
            Click the Vendor identified node to set Day 0 and start the 45-day clock
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">Click a step to edit its date &amp; link</span>
        )}
      </div>

      <div className="overflow-x-auto">
        <div className="flex" style={{ minWidth: `${steps.length * 6.5}rem` }}>
          {steps.map((s, i) => {
            const state = stepState(r, s, start);
            const actualRaw = stepDate(r, s);
            const linkRaw = (r.vendor[s.linkKey] as string | null | undefined) ?? null;
            const target = start ? addDaysIso(start, s.day) : null;
            const isNext = start != null && nextStep?.label === s.label && state !== "overdue";
            const prevDone = i > 0 && !!stepDate(r, steps[i - 1]!);
            const href = linkRaw && /^https?:\/\//.test(linkRaw) ? linkRaw : linkRaw ? `https://${linkRaw}` : null;
            return (
              <div key={s.label} className="flex-1 min-w-0 flex flex-col items-center">
                <div className="flex items-center w-full">
                  <div className={cn("h-0.5 flex-1", i === 0 ? "bg-transparent" : prevDone ? "bg-emerald-500/70" : "bg-border")} />
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        title={`${s.label} — ${
                          actualRaw
                            ? `completed ${actualRaw}${state === "late" ? ` (late, target ${target})` : ""}`
                            : target
                              ? `${state === "overdue" ? "overdue — " : ""}target ${target}`
                              : "click to edit"
                        }`}
                        className={cn(
                          "w-7 h-7 rounded-full border-2 flex items-center justify-center shrink-0 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                          state === "done" && "bg-emerald-500 border-emerald-500 text-white",
                          state === "late" && "bg-amber-500 border-amber-500 text-amber-900",
                          state === "overdue" && "bg-red-500/15 border-red-500 text-red-600 dark:text-red-400",
                          state === "pending" && "bg-background border-muted-foreground/30 text-muted-foreground",
                          isNext && "border-dashed border-primary",
                        )}
                      >
                        {state === "done" ? (
                          <Check className="w-3.5 h-3.5" strokeWidth={3} />
                        ) : state === "late" ? (
                          <Clock className="w-3.5 h-3.5" strokeWidth={2.5} />
                        ) : state === "overdue" ? (
                          <CircleAlert className="w-4 h-4" />
                        ) : (
                          <span className="text-[10px] font-semibold">D{s.day}</span>
                        )}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72" align="center">
                      <div className="space-y-2.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-medium">{s.label}</span>
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                            target {target ?? "—"} · D{s.day}
                          </span>
                        </div>
                        <div>
                          <Label className="text-xs">Completed</Label>
                          <div className="flex items-center gap-1.5 mt-1">
                            <InlineDate value={actualRaw} onSave={(v) => save({ [s.dateKey]: v })} disabled={update.isPending} />
                            {!actualRaw ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs px-2"
                                disabled={update.isPending}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => save({ [s.dateKey]: todayIso() })}
                              >
                                Today
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                title="Clear completed date"
                                className="h-7 px-2 text-muted-foreground hover:text-red-600"
                                disabled={update.isPending}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                  if (
                                    s.dateKey === "poReadyDate" &&
                                    r.entry.status === "onboarded" &&
                                    !window.confirm(
                                      "This vendor is onboarded: clearing PO-ready re-anchors the 45-day SLA to the onboarded date. Clear anyway?",
                                    )
                                  ) {
                                    return;
                                  }
                                  save({ [s.dateKey]: null });
                                }}
                              >
                                Clear
                              </Button>
                            )}
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs">Evidence link</Label>
                          <div className="mt-1">
                            <InlineLink value={linkRaw} onSave={(v) => save({ [s.linkKey]: v })} disabled={update.isPending} />
                          </div>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <div className={cn("h-0.5 flex-1", i === steps.length - 1 ? "bg-transparent" : actualRaw ? "bg-emerald-500/70" : "bg-border")} />
                </div>
                <div
                  className="text-[10px] font-medium text-center leading-tight mt-1.5 px-0.5 line-clamp-2 h-[2.5em]"
                  title={s.label}
                >
                  {s.label}
                </div>
                <div
                  className={cn(
                    "text-[10px] tabular-nums mt-0.5",
                    state === "done" && "text-emerald-600 dark:text-emerald-400",
                    state === "late" && "text-amber-600 dark:text-amber-400",
                    state === "overdue" && "text-red-600 dark:text-red-400 font-medium",
                    state === "pending" && "text-muted-foreground",
                  )}
                >
                  {state === "late" ? `${actualRaw} · late` : (actualRaw ?? target ?? "—")}
                </div>
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    title={href}
                    aria-label={`Open evidence for ${s.label}`}
                    className="mt-0.5 p-1.5 text-primary hover:text-primary/80"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Tracker detail grid: empty fields hidden by default, click a value to edit. */
function VendorDetailGrid({
  r,
  cols,
  onChanged,
}: {
  r: AslRow;
  cols: Col[];
  onChanged: () => Promise<void>;
}) {
  const { save } = useVendorFieldSave(r, onChanged);
  const [showAll, setShowAll] = React.useState(false);
  const populated = cols.filter((c) => {
    const v = (r.vendor as unknown as Record<string, unknown>)[c.key];
    return v != null && v !== "";
  });
  const shown = showAll ? cols : populated;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          Tracker details · {populated.length} of {cols.length} filled
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] text-muted-foreground"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Show filled only" : "Show all fields"}
        </Button>
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1">
          No tracker details filled in yet — use the row&apos;s Edit action to add them.
        </p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-2">
          {shown.map((c) => (
            <div key={c.key} className="min-w-0">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{c.header}</div>
              <div className="text-xs">
                <EditableValue col={c} r={r} save={save} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Col = {
  key: string;
  header: string;
  /** width hint applied to the cell wrapper, e.g. "min-w-[12rem]" */
  width?: string;
  /**
   * Click-to-edit behavior for this vendor field. "text"/"multiline" swap in
   * an input on click; "capabilities"/"categories" open the multi-selects.
   * Absent = read-only (entry-level or computed cells).
   */
  editor?: "text" | "multiline" | "capabilities" | "categories";
  render: (r: AslRow) => React.ReactNode;
};

// Plain text cell, single line, with full text on hover.
function txt(v: string | null | undefined, opts?: { multiline?: boolean }) {
  if (v == null || v === "") return <span className="text-muted-foreground/50">—</span>;
  const firstLine = opts?.multiline ? v : v.split("\n")[0];
  return (
    <span className="block truncate" title={v}>
      {firstLine}
    </span>
  );
}

// Columns for the current Approved Supplier List (already-onboarded suppliers).
const ASL_COLUMNS: Col[] = [
  { key: "status", header: "Status", width: "min-w-[7rem]", render: (r) => (
    <Badge variant="outline" className={cn("whitespace-nowrap", STATUS_STYLES[r.entry.status])}>
      {statusLabel(r.entry.status)}
    </Badge>
  ) },
  { key: "segment", header: "Segment", width: "min-w-[8rem]", render: (r) => txt(SEGMENT_LABEL[r.entry.segment] ?? r.entry.segment) },
  { key: "tier", header: "Tier", width: "min-w-[5rem]", editor: "text", render: (r) => txt(r.vendor.tier) },
  { key: "category", header: "Category", width: "min-w-[11rem]", editor: "text", render: (r) => txt(r.vendor.category) },
  { key: "subCategory", header: "Sub Category", width: "min-w-[10rem]", editor: "text", render: (r) => txt(r.vendor.subCategory) },
  { key: "stage", header: "Stage", width: "min-w-[6rem]", editor: "text", render: (r) => txt(r.vendor.stage) },
  { key: "vendorPoc", header: "Vendor POC", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.vendorPoc) },
  { key: "vendorPocPhone", header: "POC Phone", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.vendorPocPhone) },
  { key: "vendorPocEmail", header: "POC Email", width: "min-w-[13rem]", editor: "text", render: (r) => txt(r.vendor.vendorPocEmail) },
  { key: "productCategories", header: "Product Categories", width: "min-w-[12rem]", editor: "categories", render: (r) => txt(r.vendor.productCategories) },
  { key: "capabilities", header: "Capabilities", width: "min-w-[16rem]", editor: "capabilities", render: (r) => txt(r.vendor.capabilities) },
  { key: "locations", header: "Locations", width: "min-w-[10rem]", editor: "multiline", render: (r) => txt(r.vendor.locations) },
  { key: "documents", header: "Documents", width: "min-w-[8rem]", editor: "text", render: (r) => txt(r.vendor.documents) },
  { key: "calyxPoc", header: "Calyx POC", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.calyxPoc) },
  { key: "vendorPoc", header: "Vendor POC", width: "min-w-[9rem]", editor: "multiline", render: (r) => txt(r.vendor.vendorPoc) },
  { key: "vendorPocPhone", header: "POC Phone", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.vendorPocPhone) },
  { key: "vendorPocEmail", header: "POC Email", width: "min-w-[13rem]", editor: "text", render: (r) => txt(r.vendor.vendorPocEmail) },
];

// Columns for the Flex Sourcing pipeline tracker (not-yet-onboarded candidates).
const PIPELINE_COLUMNS: Col[] = [
  { key: "status", header: "Status", width: "min-w-[7rem]", render: (r) => (
    <Badge variant="outline" className={cn("whitespace-nowrap", STATUS_STYLES[r.entry.status])}>
      {statusLabel(r.entry.status)}
    </Badge>
  ) },
  { key: "externalId", header: "Vendor ID", width: "min-w-[7rem]", editor: "text", render: (r) => txt(r.vendor.externalId) },
  { key: "printMethod", header: "Print Method", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.printMethod) },
  { key: "pipelineStatus", header: "Pipeline Status", width: "min-w-[10rem]", editor: "text", render: (r) => txt(r.vendor.pipelineStatus) },
  { key: "track", header: "Track", width: "min-w-[7rem]", editor: "text", render: (r) => txt(r.vendor.track) },
  { key: "country", header: "Country", width: "min-w-[7rem]", editor: "text", render: (r) => txt(r.vendor.country) },
  { key: "cluster", header: "Cluster", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.cluster) },
  { key: "category", header: "Category", width: "min-w-[11rem]", editor: "text", render: (r) => txt(r.vendor.category) },
  { key: "subCapability", header: "Sub Capability", width: "min-w-[14rem]", editor: "multiline", render: (r) => txt(r.vendor.subCapability) },
  { key: "tier", header: "Tier", width: "min-w-[5rem]", editor: "text", render: (r) => txt(r.vendor.tier) },
  { key: "primarySecondary", header: "Primary/Secondary", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.primarySecondary) },
  { key: "stage", header: "Stage", width: "min-w-[6rem]", editor: "text", render: (r) => txt(r.vendor.stage) },
  { key: "owner", header: "Owner", width: "min-w-[8rem]", editor: "text", render: (r) => txt(r.vendor.owner) },
  { key: "website", header: "Website", width: "min-w-[12rem]", render: (r) =>
    r.vendor.website ? (
      <a href={r.vendor.website} target="_blank" rel="noreferrer" className="block truncate text-primary hover:underline" title={r.vendor.website}>
        {r.vendor.website.replace(/^https?:\/\//, "")}
      </a>
    ) : (
      <span className="text-muted-foreground/50">—</span>
    ),
  },
  { key: "vendorPoc", header: "Vendor POC", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.vendorPoc) },
  { key: "vendorPocPhone", header: "POC Phone", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.vendorPocPhone) },
  { key: "vendorPocEmail", header: "POC Email", width: "min-w-[13rem]", editor: "text", render: (r) => txt(r.vendor.vendorPocEmail) },
  { key: "productCategories", header: "Product Categories", width: "min-w-[12rem]", editor: "categories", render: (r) => txt(r.vendor.productCategories) },
  { key: "capabilities", header: "Capabilities", width: "min-w-[14rem]", editor: "capabilities", render: (r) => txt(r.vendor.capabilities) },
  { key: "capabilityVerified", header: "Capability Verified", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.capabilityVerified) },
  { key: "quotedPrice", header: "Quoted Price", width: "min-w-[8rem]", editor: "text", render: (r) => txt(r.vendor.quotedPrice) },
  { key: "targetPrice", header: "Target Price", width: "min-w-[8rem]", editor: "text", render: (r) => txt(r.vendor.targetPrice) },
  { key: "priceVsTargetPct", header: "Price vs Target %", width: "min-w-[8rem]", editor: "text", render: (r) => txt(r.vendor.priceVsTargetPct) },
  { key: "depositPct", header: "Deposit %", width: "min-w-[7rem]", editor: "text", render: (r) => txt(r.vendor.depositPct) },
  { key: "leadTimeDays", header: "Lead Time (days)", width: "min-w-[8rem]", editor: "text", render: (r) => txt(r.vendor.leadTimeDays) },
  { key: "trialOrderNo", header: "Trial Order #", width: "min-w-[8rem]", editor: "text", render: (r) => txt(r.vendor.trialOrderNo) },
  { key: "trialResult", header: "Trial Result", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.trialResult) },
  { key: "commandIntegrated", header: "Command Integrated", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.commandIntegrated) },
  { key: "packosHandoff", header: "PackOS Handoff", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.packosHandoff) },
  { key: "nonCompete24mo", header: "Non-Compete 24mo", width: "min-w-[9rem]", editor: "text", render: (r) => txt(r.vendor.nonCompete24mo) },
  { key: "nextAction", header: "Next Action", width: "min-w-[14rem]", editor: "multiline", render: (r) => txt(r.vendor.nextAction) },
  { key: "nextActionDue", header: "Next Action Due", width: "min-w-[8rem]", editor: "text", render: (r) => txt(r.vendor.nextActionDue) },
];

type VendorKey = keyof Omit<Vendor, "id" | "name">;
type EditField = {
  key: VendorKey;
  label: string;
  multiline?: boolean;
  date?: boolean;
  /** Render as the capability multi-select instead of a text input. */
  capabilities?: boolean;
  /** Render as the product-category multi-select instead of a text input. */
  categories?: boolean;
};

// Editable vendor fields for the current Approved Supplier List table.
const ASL_EDIT_FIELDS: EditField[] = [
  { key: "tier", label: "Tier" },
  { key: "category", label: "Category" },
  { key: "subCategory", label: "Sub Category" },
  { key: "stage", label: "Stage" },
  { key: "productCategories", label: "Product Categories", categories: true },
  { key: "capabilities", label: "Capabilities", capabilities: true },
  { key: "locations", label: "Locations", multiline: true },
  { key: "documents", label: "Documents" },
  { key: "calyxPoc", label: "Calyx POC" },
  { key: "vendorPoc", label: "Vendor POC", multiline: true },
  { key: "vendorPocPhone", label: "POC Phone" },
  { key: "vendorPocEmail", label: "POC Email" },
  { key: "notes", label: "Notes", multiline: true },
];

// Editable vendor fields for the Flex Sourcing pipeline tracker table.
const PIPELINE_EDIT_FIELDS: EditField[] = [
  { key: "externalId", label: "Vendor ID" },
  { key: "printMethod", label: "Print Method" },
  { key: "pipelineStatus", label: "Pipeline Status" },
  { key: "track", label: "Track" },
  { key: "country", label: "Country" },
  { key: "cluster", label: "Cluster" },
  { key: "category", label: "Category" },
  { key: "subCapability", label: "Sub Capability", multiline: true },
  { key: "tier", label: "Tier" },
  { key: "primarySecondary", label: "Primary/Secondary" },
  { key: "stage", label: "Stage" },
  { key: "owner", label: "Owner" },
  { key: "website", label: "Website" },
  { key: "vendorPoc", label: "Vendor POC" },
  { key: "vendorPocPhone", label: "POC Phone" },
  { key: "vendorPocEmail", label: "POC Email" },
  { key: "productCategories", label: "Product Categories", categories: true },
  { key: "capabilities", label: "Capabilities", capabilities: true },
  { key: "capabilityVerified", label: "Capability Verified" },
  { key: "quotedPrice", label: "Quoted Price" },
  { key: "targetPrice", label: "Target Price" },
  { key: "priceVsTargetPct", label: "Price vs Target %" },
  { key: "depositPct", label: "Deposit %" },
  { key: "leadTimeDays", label: "Lead Time (days)" },
  { key: "trialOrderNo", label: "Trial Order #" },
  { key: "trialResult", label: "Trial Result" },
  { key: "commandIntegrated", label: "Command Integrated" },
  { key: "packosHandoff", label: "PackOS Handoff" },
  { key: "nonCompete24mo", label: "Non-Compete 24mo" },
  { key: "nextAction", label: "Next Action", multiline: true },
  { key: "nextActionDue", label: "Next Action Due" },
  { key: "notes", label: "Notes", multiline: true },
];

type Variant = "asl" | "pipeline";

export default function Asl() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetAsl();
  const seed = useSeedVendors();
  const seedAsl = useSeedCurrentAsl();

  const [addOpen, setAddOpen] = React.useState(false);
  const [editEntry, setEditEntry] = React.useState<{ row: AslRow; variant: Variant } | null>(null);
  const [goalOpen, setGoalOpen] = React.useState(false);
  const moveEntry = useUpdateAslEntry();

  const handleMoveToAsl = async (r: AslRow) => {
    try {
      await moveEntry.mutateAsync({
        id: r.entry.id,
        data: {
          vendorId: r.entry.vendorId,
          segment: r.entry.segment as AslSegment,
          status: "onboarded",
          onboardedOn: todayIso(),
        },
      });
      await invalidate();
      toast({ title: "Moved to ASL", description: `${r.vendor.name} is now an approved supplier` });
    } catch (e) {
      toast({ title: "Failed", description: String(e), variant: "destructive" });
    }
  };

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetAslQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() }),
    ]);
  };

  const handleSeed = async () => {
    try {
      const r = await seed.mutateAsync();
      await invalidate();
      toast({
        title: "Tracker loaded",
        description: `${r.created} added, ${r.updated} updated, ${r.skipped} skipped`,
      });
    } catch (e) {
      toast({ title: "Seed failed", description: String(e), variant: "destructive" });
    }
  };

  const handleSeedAsl = async () => {
    try {
      const r = await seedAsl.mutateAsync();
      await invalidate();
      toast({ title: "Current ASL loaded", description: `${r.created} added, ${r.updated} updated` });
    } catch (e) {
      toast({ title: "Load failed", description: String(e), variant: "destructive" });
    }
  };

  const goal = data?.goal ?? 50;
  const onboarded = data?.onboardedCount ?? 0;
  const total = data?.totalCount ?? 0;
  const progress = goal > 0 ? Math.min(100, (onboarded / goal) * 100) : 0;

  const aslSuppliers = data?.aslSuppliers ?? [];
  const pipeline = data?.pipeline ?? [];

  // Vendors already present per segment (for the Add dialog filter).
  const allRows = [...(data?.rawMaterials ?? []), ...(data?.finishedGoods ?? [])];
  const bySegment: Record<AslSegment, Set<string>> = {
    raw_materials: new Set(allRows.filter((r) => r.entry.segment === "raw_materials").map((r) => r.vendor.id)),
    finished_goods: new Set(allRows.filter((r) => r.entry.segment === "finished_goods").map((r) => r.vendor.id)),
  };

  return (
    <Layout>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Approved Supplier List</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Current approved suppliers and the Flex Sourcing pipeline — tracking toward the EOY onboarding goal.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleSeedAsl} disabled={seedAsl.isPending}>
            <Download className="w-4 h-4 mr-1" /> Load current ASL
          </Button>
          <Button variant="outline" size="sm" onClick={handleSeed} disabled={seed.isPending}>
            <Download className="w-4 h-4 mr-1" /> Load tracker
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">EOY Onboarding Goal</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setGoalOpen(true)}>
              <Pencil className="w-3.5 h-3.5 mr-1" /> Edit goal
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-end justify-between mb-2">
            <div>
              <span className="text-3xl font-bold">{onboarded}</span>
              <span className="text-muted-foreground"> / {goal} onboarded</span>
            </div>
            <span className="text-sm text-muted-foreground">{total} total on list</span>
          </div>
          <Progress value={progress} className="h-2" />
          <p className="text-xs text-muted-foreground mt-2">
            {goal - onboarded > 0 ? `${goal - onboarded} more to reach goal` : "Goal reached 🎉"}
          </p>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      ) : (
        <>
          <FullTable
            title="Current Approved Suppliers"
            description="Onboarded suppliers with their full ASL detail."
            icon={CheckCircle2}
            columns={ASL_COLUMNS}
            rows={aslSuppliers}
            emptyText="No approved suppliers yet — use “Load current ASL”."
            onAdd={() => setAddOpen(true)}
            onEdit={(row) => setEditEntry({ row, variant: "asl" })}
            onChanged={invalidate}
          />
          <PipelineTable
            rows={pipeline}
            onAdd={() => setAddOpen(true)}
            onEdit={(row) => setEditEntry({ row, variant: "pipeline" })}
            onMoveToAsl={handleMoveToAsl}
            onChanged={invalidate}
          />
        </>
      )}

      {addOpen && (
        <AddEntryDialog bySegment={bySegment} onClose={() => setAddOpen(false)} onChanged={invalidate} />
      )}
      {editEntry && (
        <EditEntryDialog
          entry={editEntry.row}
          variant={editEntry.variant}
          onClose={() => setEditEntry(null)}
          onChanged={invalidate}
        />
      )}
      {goalOpen && (
        <GoalDialog current={goal} onClose={() => setGoalOpen(false)} onChanged={invalidate} />
      )}
    </Layout>
  );
}

/** Table-cell wrapper that owns the save hook for one row (hooks per cell row). */
function EditableCell({ col, r, onChanged }: { col: Col; r: AslRow; onChanged: () => Promise<void> }) {
  const { save } = useVendorFieldSave(r, onChanged);
  return <EditableValue col={col} r={r} save={save} />;
}

function FullTable({
  title,
  description,
  icon: Icon,
  columns,
  rows,
  emptyText,
  onAdd,
  onEdit,
  onMoveToAsl,
  onChanged,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  columns: Col[];
  rows: AslRow[];
  emptyText: string;
  onAdd: () => void;
  onEdit: (e: AslRow) => void;
  onMoveToAsl?: (e: AslRow) => void;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const del = useDeleteAslEntry();
  const onboarded = rows.filter((r) => r.entry.status === "onboarded").length;

  const remove = async (e: AslRow) => {
    try {
      await del.mutateAsync({ id: e.entry.id });
      await onChanged();
      toast({ title: "Removed from list", description: e.vendor.name });
    } catch (err) {
      toast({ title: "Failed", description: String(err), variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Icon className="w-4 h-4 text-muted-foreground" />
              {title}
              <Badge variant="secondary" className="ml-1">
                {rows.length}
              </Badge>
              <span className="text-xs font-normal text-muted-foreground">{onboarded} onboarded</span>
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onAdd}>
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">{emptyText}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-20 bg-muted/95 min-w-[14rem]">Vendor</TableHead>
                  {columns.map((c) => (
                    <TableHead key={c.key} className={cn("whitespace-nowrap text-xs", c.width)}>
                      {c.header}
                    </TableHead>
                  ))}
                  <TableHead className="sticky right-0 z-20 bg-muted/95 w-20 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.entry.id}>
                    <TableCell className="sticky left-0 z-10 bg-background font-medium min-w-[14rem] max-w-[18rem]">
                      <span className="block truncate" title={r.vendor.name}>
                        {r.vendor.name}
                      </span>
                    </TableCell>
                    {columns.map((c) => (
                      <TableCell key={c.key} className={cn("text-xs text-muted-foreground align-top", c.width)}>
                        <div className={cn("max-w-[18rem]", c.width)}>
                          <EditableCell col={c} r={r} onChanged={onChanged} />
                        </div>
                      </TableCell>
                    ))}
                    <TableCell className="sticky right-0 z-10 bg-background w-20">
                      <div className="flex items-center gap-1 justify-end">
                        {onMoveToAsl && (
                          <button
                            type="button"
                            title="Move to Approved Supplier List"
                            className="text-muted-foreground hover:text-emerald-600 p-1"
                            onClick={() => onMoveToAsl(r)}
                          >
                            <ArrowRightCircle className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          title="Edit"
                          className="text-muted-foreground hover:text-foreground p-1"
                          onClick={() => onEdit(r)}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Remove"
                          className="text-muted-foreground hover:text-red-600 p-1"
                          onClick={() => remove(r)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// =====================================================================
// Flex Sourcing Pipeline table — curated columns that fit without endless
// horizontal scrolling, sortable headers, a filter toolbar, and an
// expandable per-row panel with the full tracker detail + SLA timeline.
// =====================================================================

// Keys shown as core columns (everything else lives in the expanded panel).
const PIPELINE_CORE_KEYS = new Set([
  "status",
  "externalId",
  "pipelineStatus",
  "track",
  "country",
  "category",
  "tier",
  "owner",
  "nextActionDue",
]);

type SortState = { key: string; dir: 1 | -1 } | null;

const STATUS_SORT_RANK: Record<string, number> = { in_progress: 0, identified: 1, none: 2, onboarded: 3 };

const PIPELINE_SORT_ACCESSORS: Record<string, (r: AslRow) => string | number> = {
  vendor: (r) => r.vendor.name.toLowerCase(),
  // Group by status priority; within a group, most days elapsed first.
  status: (r) => (STATUS_SORT_RANK[r.entry.status] ?? 9) * 10_000 - (slaDaysElapsed(r) ?? -1),
  sla: (r) => slaDaysElapsed(r) ?? -1,
  pipelineStatus: (r) => nextOutstanding(r).index,
  externalId: (r) => (r.vendor.externalId ?? "").toLowerCase(),
  track: (r) => (r.vendor.track ?? "").toLowerCase(),
  country: (r) => (r.vendor.country ?? "").toLowerCase(),
  category: (r) => (r.vendor.category ?? "").toLowerCase(),
  tier: (r) => (r.vendor.tier ?? "").toLowerCase(),
  owner: (r) => (r.vendor.owner ?? "").toLowerCase(),
  nextActionDue: (r) => r.vendor.nextActionDue ?? "",
};

function FilterSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className={cn("h-8 w-auto min-w-[7.5rem] text-xs", value !== "all" && "border-primary/60 text-foreground")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{label}: All</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PipelineTable({
  rows,
  onAdd,
  onEdit,
  onMoveToAsl,
  onChanged,
}: {
  rows: AslRow[];
  onAdd: () => void;
  onEdit: (e: AslRow) => void;
  onMoveToAsl: (e: AslRow) => void;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const del = useDeleteAslEntry();

  const [q, setQ] = React.useState("");
  const [fStatus, setFStatus] = React.useState("all");
  const [fPipeline, setFPipeline] = React.useState("all");
  const [fTrack, setFTrack] = React.useState("all");
  const [fCountry, setFCountry] = React.useState("all");
  const [fCategory, setFCategory] = React.useState("all");
  const [fOwner, setFOwner] = React.useState("all");
  const [sort, setSort] = React.useState<SortState>({ key: "status", dir: 1 });
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const distinct = (get: (r: AslRow) => string | null | undefined) =>
    Array.from(new Set(rows.map(get).filter((v): v is string => !!v)))
      .sort()
      .map((v) => ({ value: v, label: v }));

  const pipelineOptions = React.useMemo(() => distinct((r) => nextOutstanding(r).label), [rows]);
  const trackOptions = React.useMemo(() => distinct((r) => r.vendor.track), [rows]);
  const countryOptions = React.useMemo(() => distinct((r) => r.vendor.country), [rows]);
  const categoryOptions = React.useMemo(() => distinct((r) => r.vendor.category), [rows]);
  const ownerOptions = React.useMemo(() => distinct((r) => r.vendor.owner), [rows]);

  const hasFilters =
    q !== "" ||
    fStatus !== "all" ||
    fPipeline !== "all" ||
    fTrack !== "all" ||
    fCountry !== "all" ||
    fCategory !== "all" ||
    fOwner !== "all";

  const clearFilters = () => {
    setQ("");
    setFStatus("all");
    setFPipeline("all");
    setFTrack("all");
    setFCountry("all");
    setFCategory("all");
    setFOwner("all");
  };

  const visible = React.useMemo(() => {
    const qn = q.trim().toLowerCase();
    const filtered = rows.filter(
      (r) =>
        (qn === "" ||
          r.vendor.name.toLowerCase().includes(qn) ||
          (r.vendor.externalId ?? "").toLowerCase().includes(qn)) &&
        (fStatus === "all" || r.entry.status === fStatus) &&
        (fPipeline === "all" || nextOutstanding(r).label === fPipeline) &&
        (fTrack === "all" || r.vendor.track === fTrack) &&
        (fCountry === "all" || r.vendor.country === fCountry) &&
        (fCategory === "all" || r.vendor.category === fCategory) &&
        (fOwner === "all" || r.vendor.owner === fOwner),
    );
    if (!sort) return filtered;
    const acc = PIPELINE_SORT_ACCESSORS[sort.key];
    if (!acc) return filtered;
    return [...filtered].sort((a, b) => {
      const av = acc(a);
      const bv = acc(b);
      if (av === bv) return a.vendor.name.localeCompare(b.vendor.name);
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return cmp * sort.dir;
    });
  }, [rows, q, fStatus, fPipeline, fTrack, fCountry, fCategory, fOwner, sort]);

  const toggleSort = (key: string) =>
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = async (e: AslRow) => {
    try {
      await del.mutateAsync({ id: e.entry.id });
      await onChanged();
      toast({ title: "Removed from list", description: e.vendor.name });
    } catch (err) {
      toast({ title: "Failed", description: String(err), variant: "destructive" });
    }
  };

  const Th = ({ k, children, className }: { k: string; children: React.ReactNode; className?: string }) => (
    <TableHead
      className={cn("whitespace-nowrap text-xs cursor-pointer select-none", className)}
      onClick={() => toggleSort(k)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sort?.key === k ? (
          sort.dir === 1 ? (
            <ArrowUp className="w-3 h-3" />
          ) : (
            <ArrowDown className="w-3 h-3" />
          )
        ) : (
          <ArrowUpDown className="w-3 h-3 opacity-30" />
        )}
      </span>
    </TableHead>
  );

  const detailCols = PIPELINE_COLUMNS.filter((c) => !PIPELINE_CORE_KEYS.has(c.key));
  const colSpan = 13;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-muted-foreground" />
              Flex Sourcing Pipeline
              <Badge variant="secondary" className="ml-1">
                {hasFilters ? `${visible.length} / ${rows.length}` : rows.length}
              </Badge>
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Candidate suppliers tracked against the 45-day sourcing SLA (spec in → PO-ready by day
              35, SLA at day 45). Expand a row for the full tracker.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onAdd}>
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        </div>
        <div className="flex items-center gap-2 flex-wrap mt-3">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search vendor or ID…"
            className="h-8 w-52 text-xs"
          />
          <FilterSelect
            value={fStatus}
            onChange={setFStatus}
            label="Status"
            options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <FilterSelect value={fPipeline} onChange={setFPipeline} label="Next Task" options={pipelineOptions} />
          <FilterSelect value={fTrack} onChange={setFTrack} label="Track" options={trackOptions} />
          <FilterSelect value={fCountry} onChange={setFCountry} label="Country" options={countryOptions} />
          <FilterSelect value={fCategory} onChange={setFCategory} label="Category" options={categoryOptions} />
          <FilterSelect value={fOwner} onChange={setFOwner} label="Owner" options={ownerOptions} />
          {hasFilters && (
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={clearFilters}>
              <FilterX className="w-3.5 h-3.5 mr-1" /> Clear
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No pipeline candidates yet — use “Load tracker”.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <Th k="vendor" className="min-w-[11rem]">Vendor</Th>
                  <Th k="status">Status</Th>
                  <Th k="sla">SLA (45d)</Th>
                  <Th k="pipelineStatus">Next Task</Th>
                  <Th k="externalId">Vendor ID</Th>
                  <Th k="track">Track</Th>
                  <Th k="country">Country</Th>
                  <Th k="category">Category</Th>
                  <Th k="tier">Tier</Th>
                  <Th k="owner">Owner</Th>
                  <Th k="nextActionDue">Next Due</Th>
                  <TableHead className="w-20 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={colSpan} className="text-center text-sm text-muted-foreground py-6">
                      No vendors match the current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((r) => {
                    const isOpen = expanded.has(r.entry.id);
                    return (
                      <React.Fragment key={r.entry.id}>
                        <TableRow className={cn(isOpen && "border-b-0 bg-muted/20")}>
                          <TableCell className="w-8 pr-0">
                            <button
                              type="button"
                              title={isOpen ? "Collapse" : "Expand full tracker detail"}
                              className="text-muted-foreground hover:text-foreground p-1"
                              onClick={() => toggleExpanded(r.entry.id)}
                            >
                              {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            </button>
                          </TableCell>
                          <TableCell className="font-medium max-w-[14rem]">
                            <span className="block truncate" title={r.vendor.name}>
                              {r.vendor.name}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn("whitespace-nowrap", STATUS_STYLES[r.entry.status])}>
                              {statusLabel(r.entry.status)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <SlaCell r={r} />
                          </TableCell>
                          <TableCell className="text-xs max-w-[11rem]">
                            <span
                              className={cn(
                                "block truncate",
                                nextOutstanding(r).index >= 97 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                              )}
                              title="Next outstanding onboarding task"
                            >
                              {nextOutstanding(r).label}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {txt(r.vendor.externalId)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{txt(r.vendor.track)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[7rem]">
                            {txt(r.vendor.country)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[10rem]">
                            {txt(r.vendor.category)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{txt(r.vendor.tier)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[8rem]">
                            {txt(r.vendor.owner)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {txt(r.vendor.nextActionDue)}
                          </TableCell>
                          <TableCell className="w-20">
                            <div className="flex items-center gap-1 justify-end">
                              <button
                                type="button"
                                title="Move to Approved Supplier List"
                                className="text-muted-foreground hover:text-emerald-600 p-1"
                                onClick={() => onMoveToAsl(r)}
                              >
                                <ArrowRightCircle className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                title="Edit"
                                className="text-muted-foreground hover:text-foreground p-1"
                                onClick={() => onEdit(r)}
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                title="Remove"
                                className="text-muted-foreground hover:text-red-600 p-1"
                                onClick={() => remove(r)}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell colSpan={colSpan} className="pt-0 pb-4 px-6">
                              <div className="space-y-3 sticky left-0 max-w-[calc(100vw-10rem)]">
                                <SlaStepper r={r} onChanged={onChanged} />
                                <VendorDetailGrid r={r} cols={detailCols} onChanged={onChanged} />
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AddEntryDialog({
  bySegment,
  onClose,
  onChanged,
}: {
  bySegment: Record<AslSegment, Set<string>>;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const { data: vendorsData } = useListVendors();
  const createEntry = useCreateAslEntry();
  const createVendor = useCreateVendor();

  const [mode, setMode] = React.useState<"existing" | "new">("existing");
  const [segment, setSegment] = React.useState<AslSegment>("finished_goods");
  const [vendorId, setVendorId] = React.useState<string>("");
  const [newName, setNewName] = React.useState("");
  const [status, setStatus] = React.useState<AslStatus>("none");

  const available = (vendorsData?.items ?? []).filter((v) => !bySegment[segment].has(v.id));

  const submit = async () => {
    try {
      let vid = vendorId;
      if (mode === "new") {
        if (!newName.trim()) return;
        const v = await createVendor.mutateAsync({ data: { name: newName.trim() } });
        vid = v.id;
      }
      if (!vid) return;
      await createEntry.mutateAsync({ data: { vendorId: vid, segment, status } });
      await onChanged();
      toast({ title: "Added to list" });
      onClose();
    } catch (e) {
      toast({ title: "Failed", description: String(e), variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add supplier</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Segment</Label>
            <Select value={segment} onValueChange={(v) => setSegment(v as AslSegment)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="raw_materials">Raw Materials</SelectItem>
                <SelectItem value="finished_goods">Finished Goods</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-2">
            <Button variant={mode === "existing" ? "default" : "outline"} size="sm" onClick={() => setMode("existing")}>
              Existing vendor
            </Button>
            <Button variant={mode === "new" ? "default" : "outline"} size="sm" onClick={() => setMode("new")}>
              New vendor
            </Button>
          </div>

          {mode === "existing" ? (
            <div>
              <Label>Vendor</Label>
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger>
                  <SelectValue placeholder={available.length ? "Select a vendor" : "No vendors available"} />
                </SelectTrigger>
                <SelectContent>
                  {available.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Vendors already in this segment are hidden. A vendor can also belong to the other segment.
              </p>
            </div>
          ) : (
            <div>
              <Label>New vendor name</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Vendor name" />
            </div>
          )}

          <div>
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as AslStatus)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              createEntry.isPending ||
              createVendor.isPending ||
              (mode === "existing" ? !vendorId : !newName.trim())
            }
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditEntryDialog({
  entry,
  variant,
  onClose,
  onChanged,
}: {
  entry: AslRow;
  variant: Variant;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const updateEntry = useUpdateAslEntry();
  const updateVendor = useUpdateVendor();

  const fields = variant === "asl" ? ASL_EDIT_FIELDS : PIPELINE_EDIT_FIELDS;

  const [name, setName] = React.useState<string>(entry.vendor.name ?? "");
  const [vendorFields, setVendorFields] = React.useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) {
      const raw = entry.vendor[f.key];
      init[f.key] = raw == null ? "" : String(raw);
    }
    return init;
  });
  const [segment, setSegment] = React.useState<AslSegment>(entry.entry.segment as AslSegment);
  const [status, setStatus] = React.useState<AslStatus>(entry.entry.status as AslStatus);
  const [onboardedOn, setOnboardedOn] = React.useState<string>(entry.entry.onboardedOn ?? "");

  const setField = (key: string, val: string) =>
    setVendorFields((prev) => ({ ...prev, [key]: val }));

  const submit = async () => {
    try {
      // Build the vendor payload: every editable column plus required name.
      const vendorPayload: Record<string, string | null> = { name: name.trim() || entry.vendor.name };
      for (const f of fields) {
        const v = vendorFields[f.key]?.trim() ?? "";
        vendorPayload[f.key] = v === "" ? null : v;
      }
      await updateVendor.mutateAsync({
        vendorId: entry.entry.vendorId,
        data: vendorPayload as never,
      });
      await updateEntry.mutateAsync({
        id: entry.entry.id,
        data: {
          vendorId: entry.entry.vendorId,
          segment,
          status,
          onboardedOn: status === "onboarded" ? onboardedOn || todayIso() : null,
        },
      });
      await onChanged();
      toast({ title: "Updated", description: name.trim() || entry.vendor.name });
      onClose();
    } catch (e) {
      toast({ title: "Failed", description: String(e), variant: "destructive" });
    }
  };

  const pending = updateVendor.isPending || updateEntry.isPending;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {entry.vendor.name}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-y-auto pr-1 space-y-3">
          <div>
            <Label>Vendor name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Segment</Label>
              <Select value={segment} onValueChange={(val) => setSegment(val as AslSegment)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="raw_materials">Raw Materials</SelectItem>
                  <SelectItem value="finished_goods">Finished Goods</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={status} onValueChange={(val) => setStatus(val as AslStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {status === "onboarded" && (
            <div>
              <Label>Onboarded date</Label>
              <Input type="date" value={onboardedOn} onChange={(e) => setOnboardedOn(e.target.value)} />
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {fields.map((f) => (
              <div key={f.key} className={cn((f.multiline || f.capabilities) && "sm:col-span-2")}>
                <Label>{f.label}</Label>
                {f.capabilities ? (
                  <CapabilityMultiSelect
                    value={vendorFields[f.key] ?? ""}
                    onChange={(v) => setField(f.key, v)}
                  />
                ) : f.categories ? (
                  <CategoryMultiSelect
                    value={vendorFields[f.key] ?? ""}
                    onChange={(v) => setField(f.key, v)}
                  />
                ) : f.multiline ? (
                  <Textarea
                    rows={2}
                    value={vendorFields[f.key] ?? ""}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                ) : (
                  <Input
                    type={f.date ? "date" : "text"}
                    value={vendorFields[f.key] ?? ""}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GoalDialog({
  current,
  onClose,
  onChanged,
}: {
  current: number;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const setGoal = useSetAslGoal();
  const [val, setVal] = React.useState(String(current));

  const submit = async () => {
    const n = Math.round(Number(val));
    if (!Number.isFinite(n) || n < 0) return;
    try {
      await setGoal.mutateAsync({ data: { goal: n } });
      await onChanged();
      toast({ title: "Goal updated", description: `${n} vendors` });
      onClose();
    } catch (e) {
      toast({ title: "Failed", description: String(e), variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>EOY onboarding goal</DialogTitle>
        </DialogHeader>
        <div>
          <Label>Target number of onboarded vendors</Label>
          <Input type="number" value={val} onChange={(e) => setVal(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={setGoal.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
