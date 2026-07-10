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
import { Plus, Trash2, Download, CheckCircle2, GitBranch, Pencil, ArrowRightCircle } from "lucide-react";
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

type AslSegment = "raw_materials" | "finished_goods";
type AslStatus = "identified" | "in_progress" | "onboarded";

const STATUS_OPTIONS: { value: AslStatus; label: string }[] = [
  { value: "identified", label: "Identified" },
  { value: "in_progress", label: "In progress" },
  { value: "onboarded", label: "Onboarded" },
];

const STATUS_STYLES: Record<string, string> = {
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

type Col = {
  key: string;
  header: string;
  /** width hint applied to the cell wrapper, e.g. "min-w-[12rem]" */
  width?: string;
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
  { key: "tier", header: "Tier", width: "min-w-[5rem]", render: (r) => txt(r.vendor.tier) },
  { key: "category", header: "Category", width: "min-w-[11rem]", render: (r) => txt(r.vendor.category) },
  { key: "subCategory", header: "Sub Category", width: "min-w-[10rem]", render: (r) => txt(r.vendor.subCategory) },
  { key: "stage", header: "Stage", width: "min-w-[6rem]", render: (r) => txt(r.vendor.stage) },
  { key: "capabilities", header: "Capabilities", width: "min-w-[16rem]", render: (r) => txt(r.vendor.capabilities) },
  { key: "locations", header: "Locations", width: "min-w-[10rem]", render: (r) => txt(r.vendor.locations) },
  { key: "documents", header: "Documents", width: "min-w-[8rem]", render: (r) => txt(r.vendor.documents) },
  { key: "calyxPoc", header: "Calyx POC", width: "min-w-[9rem]", render: (r) => txt(r.vendor.calyxPoc) },
  { key: "vendorPoc", header: "Vendor POC", width: "min-w-[9rem]", render: (r) => txt(r.vendor.vendorPoc) },
  { key: "vendorPocPhone", header: "POC Phone", width: "min-w-[9rem]", render: (r) => txt(r.vendor.vendorPocPhone) },
  { key: "vendorPocEmail", header: "POC Email", width: "min-w-[13rem]", render: (r) => txt(r.vendor.vendorPocEmail) },
];

// Columns for the Flex Sourcing pipeline tracker (not-yet-onboarded candidates).
const PIPELINE_COLUMNS: Col[] = [
  { key: "status", header: "Status", width: "min-w-[7rem]", render: (r) => (
    <Badge variant="outline" className={cn("whitespace-nowrap", STATUS_STYLES[r.entry.status])}>
      {statusLabel(r.entry.status)}
    </Badge>
  ) },
  { key: "externalId", header: "Vendor ID", width: "min-w-[7rem]", render: (r) => txt(r.vendor.externalId) },
  { key: "printMethod", header: "Print Method", width: "min-w-[9rem]", render: (r) => txt(r.vendor.printMethod) },
  { key: "pipelineStatus", header: "Pipeline Status", width: "min-w-[10rem]", render: (r) => txt(r.vendor.pipelineStatus) },
  { key: "track", header: "Track", width: "min-w-[7rem]", render: (r) => txt(r.vendor.track) },
  { key: "country", header: "Country", width: "min-w-[7rem]", render: (r) => txt(r.vendor.country) },
  { key: "cluster", header: "Cluster", width: "min-w-[9rem]", render: (r) => txt(r.vendor.cluster) },
  { key: "category", header: "Category", width: "min-w-[11rem]", render: (r) => txt(r.vendor.category) },
  { key: "subCapability", header: "Sub Capability", width: "min-w-[14rem]", render: (r) => txt(r.vendor.subCapability) },
  { key: "tier", header: "Tier", width: "min-w-[5rem]", render: (r) => txt(r.vendor.tier) },
  { key: "primarySecondary", header: "Primary/Secondary", width: "min-w-[9rem]", render: (r) => txt(r.vendor.primarySecondary) },
  { key: "stage", header: "Stage", width: "min-w-[6rem]", render: (r) => txt(r.vendor.stage) },
  { key: "owner", header: "Owner", width: "min-w-[8rem]", render: (r) => txt(r.vendor.owner) },
  { key: "waveSprint", header: "Wave/Sprint", width: "min-w-[7rem]", render: (r) => txt(r.vendor.waveSprint) },
  { key: "website", header: "Website", width: "min-w-[12rem]", render: (r) =>
    r.vendor.website ? (
      <a href={r.vendor.website} target="_blank" rel="noreferrer" className="block truncate text-primary hover:underline" title={r.vendor.website}>
        {r.vendor.website.replace(/^https?:\/\//, "")}
      </a>
    ) : (
      <span className="text-muted-foreground/50">—</span>
    ),
  },
  { key: "ndaDate", header: "NDA Date", width: "min-w-[8rem]", render: (r) => txt(r.vendor.ndaDate) },
  { key: "msaDate", header: "MSA Date", width: "min-w-[8rem]", render: (r) => txt(r.vendor.msaDate) },
  { key: "capabilityVerified", header: "Capability Verified", width: "min-w-[9rem]", render: (r) => txt(r.vendor.capabilityVerified) },
  { key: "factoryTourDate", header: "Factory Tour", width: "min-w-[8rem]", render: (r) => txt(r.vendor.factoryTourDate) },
  { key: "rfqSent", header: "RFQ Sent", width: "min-w-[8rem]", render: (r) => txt(r.vendor.rfqSent) },
  { key: "quoteReceived", header: "Quote Received", width: "min-w-[8rem]", render: (r) => txt(r.vendor.quoteReceived) },
  { key: "quotedPrice", header: "Quoted Price", width: "min-w-[8rem]", render: (r) => txt(r.vendor.quotedPrice) },
  { key: "targetPrice", header: "Target Price", width: "min-w-[8rem]", render: (r) => txt(r.vendor.targetPrice) },
  { key: "priceVsTargetPct", header: "Price vs Target %", width: "min-w-[8rem]", render: (r) => txt(r.vendor.priceVsTargetPct) },
  { key: "moq", header: "MOQ", width: "min-w-[6rem]", render: (r) => txt(r.vendor.moq) },
  { key: "depositPct", header: "Deposit %", width: "min-w-[7rem]", render: (r) => txt(r.vendor.depositPct) },
  { key: "leadTimeDays", header: "Lead Time (days)", width: "min-w-[8rem]", render: (r) => txt(r.vendor.leadTimeDays) },
  { key: "aqlStandard", header: "AQL Standard", width: "min-w-[8rem]", render: (r) => txt(r.vendor.aqlStandard) },
  { key: "psiStatus", header: "PSI Status", width: "min-w-[8rem]", render: (r) => txt(r.vendor.psiStatus) },
  { key: "trialOrderNo", header: "Trial Order #", width: "min-w-[8rem]", render: (r) => txt(r.vendor.trialOrderNo) },
  { key: "trialResult", header: "Trial Result", width: "min-w-[9rem]", render: (r) => txt(r.vendor.trialResult) },
  { key: "commandIntegrated", header: "Command Integrated", width: "min-w-[9rem]", render: (r) => txt(r.vendor.commandIntegrated) },
  { key: "packosHandoff", header: "PackOS Handoff", width: "min-w-[9rem]", render: (r) => txt(r.vendor.packosHandoff) },
  { key: "ipClause", header: "IP Clause", width: "min-w-[8rem]", render: (r) => txt(r.vendor.ipClause) },
  { key: "nonCompete24mo", header: "Non-Compete 24mo", width: "min-w-[9rem]", render: (r) => txt(r.vendor.nonCompete24mo) },
  { key: "statusRag", header: "Status RAG", width: "min-w-[7rem]", render: (r) => txt(r.vendor.statusRag) },
  { key: "nextAction", header: "Next Action", width: "min-w-[14rem]", render: (r) => txt(r.vendor.nextAction) },
  { key: "nextActionDue", header: "Next Action Due", width: "min-w-[8rem]", render: (r) => txt(r.vendor.nextActionDue) },
];

type VendorKey = keyof Omit<Vendor, "id" | "name">;
type EditField = { key: VendorKey; label: string; multiline?: boolean };

// Editable vendor fields for the current Approved Supplier List table.
const ASL_EDIT_FIELDS: EditField[] = [
  { key: "tier", label: "Tier" },
  { key: "category", label: "Category" },
  { key: "subCategory", label: "Sub Category" },
  { key: "stage", label: "Stage" },
  { key: "capabilities", label: "Capabilities", multiline: true },
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
  { key: "waveSprint", label: "Wave/Sprint" },
  { key: "website", label: "Website" },
  { key: "ndaDate", label: "NDA Date" },
  { key: "msaDate", label: "MSA Date" },
  { key: "capabilityVerified", label: "Capability Verified" },
  { key: "factoryTourDate", label: "Factory Tour" },
  { key: "rfqSent", label: "RFQ Sent" },
  { key: "quoteReceived", label: "Quote Received" },
  { key: "quotedPrice", label: "Quoted Price" },
  { key: "targetPrice", label: "Target Price" },
  { key: "priceVsTargetPct", label: "Price vs Target %" },
  { key: "moq", label: "MOQ" },
  { key: "depositPct", label: "Deposit %" },
  { key: "leadTimeDays", label: "Lead Time (days)" },
  { key: "aqlStandard", label: "AQL Standard" },
  { key: "psiStatus", label: "PSI Status" },
  { key: "trialOrderNo", label: "Trial Order #" },
  { key: "trialResult", label: "Trial Result" },
  { key: "commandIntegrated", label: "Command Integrated" },
  { key: "packosHandoff", label: "PackOS Handoff" },
  { key: "ipClause", label: "IP Clause" },
  { key: "nonCompete24mo", label: "Non-Compete 24mo" },
  { key: "statusRag", label: "Status RAG" },
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
          onboardedOn: new Date().toISOString().slice(0, 10),
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
          <FullTable
            title="Flex Sourcing Pipeline"
            description="Candidate suppliers not yet onboarded, with the full sourcing tracker."
            icon={GitBranch}
            columns={PIPELINE_COLUMNS}
            rows={pipeline}
            emptyText="No pipeline candidates yet — use “Load tracker”."
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
                        <div className={cn("max-w-[18rem]", c.width)}>{c.render(r)}</div>
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
  const [status, setStatus] = React.useState<AslStatus>("identified");

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
          onboardedOn: status === "onboarded" ? onboardedOn || new Date().toISOString().slice(0, 10) : null,
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
              <div key={f.key} className={cn(f.multiline && "sm:col-span-2")}>
                <Label>{f.label}</Label>
                {f.multiline ? (
                  <Textarea
                    rows={2}
                    value={vendorFields[f.key] ?? ""}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                ) : (
                  <Input
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
