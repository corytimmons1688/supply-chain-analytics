import * as React from "react";
import {
  useUpdateDemandConfig,
  useGetMrp,
  getGetMrpQueryKey,
  getGetDemandPurchasingQueryKey,
  type MrpRow,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { X, ArrowUp, ArrowDown, Plus } from "lucide-react";

/**
 * The settings behind one row of the purchase plan.
 *
 * These used to live in popovers scattered across the Stock-by-stock plan, which
 * made it hard to see why a number was what it was — you had to know which knob
 * to hunt for. Here every driver is in one place with its computed value beside
 * it, so an override reads as a deliberate departure from the calculation rather
 * than an unexplained figure.
 *
 * Overrides are per STOCK (that's the grain stock_goal stores), even though the
 * plan is per stock × width. The panel says so rather than implying otherwise.
 */

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

/** A blank input means "use the calculated value", so "" and null are the same. */
function numOrNull(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ordered substitute list.
 *
 * Order is meaningful — it's the sequence the floor should try, so first choice
 * has to be expressible. The stored value stays a comma-separated string (the
 * existing column and endpoint), but a comma-separated text box can't express
 * intent, hence add/remove/reorder.
 */
function AlternatesEditor({
  value,
  onChange,
  selfStockId,
  availability,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  selfStockId: string;
  /** On-hand at the width of the row this panel opened from. */
  availability: Map<string, number>;
}) {
  const [draft, setDraft] = React.useState("");
  const add = () => {
    const id = draft.trim().replace(/^#/, "");
    if (!id) return;
    if (id === selfStockId) {
      setDraft("");
      return; // a stock can't substitute for itself
    }
    if (!value.includes(id)) onChange([...value, id]);
    setDraft("");
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="space-y-1.5">
      {value.length === 0 && (
        <div className="text-muted-foreground">None. Add a stock number that can run in place of this one.</div>
      )}
      {value.map((id, i) => {
        const ft = availability.get(id);
        return (
          <div key={id} className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground w-4 tabular-nums">{i + 1}.</span>
            <span className="font-medium">#{id}</span>
            <span
              className={cn(
                "tabular-nums text-[11px]",
                ft && ft > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
              )}
              title="On hand at this row's width — a substitute at a different width is no help"
            >
              {ft && ft > 0 ? `${fmt(ft)} ft` : "none at this width"}
            </span>
            <div className="ml-auto flex items-center gap-0.5">
              <Button size="sm" variant="ghost" className="h-5 w-5 p-0" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="w-3 h-3" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-5 w-5 p-0"
                disabled={i === value.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="w-3 h-3" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-5 w-5 p-0"
                onClick={() => onChange(value.filter((v) => v !== id))}
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-1.5 pt-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="stock number"
          className="h-7 w-32 text-xs"
        />
        <Button size="sm" variant="outline" className="h-7 px-2" onClick={add}>
          <Plus className="w-3 h-3 mr-1" /> Add
        </Button>
        <span className="text-[10px] text-muted-foreground">first is tried first</span>
      </div>
    </div>
  );
}

/** One labelled field with the calculated value shown beside the override. */
function Field({
  label,
  hint,
  auto,
  children,
}: {
  label: string;
  hint?: string;
  auto?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1 block">
      <span className="text-muted-foreground" title={hint}>
        {label}
      </span>
      {children}
      {auto && <span className="block text-[10px] text-muted-foreground">{auto}</span>}
    </label>
  );
}

export function StockConfigPanel({ row, onClose }: { row: MrpRow; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const save = useUpdateDemandConfig();
  const { data: mrp } = useGetMrp(undefined, { query: { queryKey: getGetMrpQueryKey(), enabled: false } });

  const d = row.drivers;
  const [vendorName, setVendorName] = React.useState(row.vendorName ?? "");
  const [leadTimeDays, setLeadTimeDays] = React.useState(d.leadTimeOverridden ? String(d.leadTimeDays) : "");
  const [rollFootage, setRollFootage] = React.useState(
    d.typicalRollFootageOverridden ? String(d.typicalRollFootage) : "",
  );
  const [orderQty, setOrderQty] = React.useState(
    d.orderQuantityRolls != null ? String(d.orderQuantityRolls) : "",
  );
  const [reorderPoint, setReorderPoint] = React.useState("");
  const [maxFootage, setMaxFootage] = React.useState("");
  const [discontinued, setDiscontinued] = React.useState(d.discontinued);
  const [alternates, setAlternates] = React.useState<string[]>(d.alternates.map((a) => a.stockId));

  /**
   * Substitute availability at THIS row's width, for every stock the panel might
   * show — including ones just added, which the row's own drivers don't know
   * about. Read from the plan, which already computes per-width on-hand.
   */
  const availability = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const a of d.alternates) m.set(a.stockId, a.onHandFootage);
    for (const r of mrp?.rows ?? []) {
      if (r.widthKey === row.widthKey && !m.has(r.stockId)) m.set(r.stockId, r.openingOnHand);
    }
    return m;
  }, [d.alternates, mrp, row.widthKey]);

  const submit = async () => {
    try {
      await save.mutateAsync({
        stockId: row.stockId,
        data: {
          vendorName: vendorName.trim() || null,
          leadTimeDays: numOrNull(leadTimeDays),
          typicalRollFootage: numOrNull(rollFootage),
          orderQuantityRolls: numOrNull(orderQty),
          reorderPointFootage: numOrNull(reorderPoint),
          maxFootage: numOrNull(maxFootage),
          discontinued,
          alternateStockIds: alternates.length ? alternates.join(",") : null,
        },
      });
      // The plan is derived entirely from these settings, so it has to refetch —
      // and so does purchasing, which shares the vendor and alternates.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetMrpQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDemandPurchasingQueryKey() }),
      ]);
      toast({ title: `#${row.stockId} settings saved`, description: "Plan recalculated" });
      onClose();
    } catch (e) {
      toast({ title: "Save failed", description: String(e), variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base">
            #{row.stockId} settings <span className="text-muted-foreground font-normal">{row.widthLabel}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            {row.description ?? ""} — these drive the purchase plan. Leave a field blank to use the calculated value.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-xs">
          {/* What the plan currently concludes, so an edit has a starting point. */}
          <div className="rounded-md border bg-muted/30 px-3 py-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">On hand</div>
              <div className="tabular-nums">{fmt(row.openingOnHand)} ft</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Reorder point</div>
              <div className="tabular-nums">{fmt(d.reorderPointFootage)} ft</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Max</div>
              <div className="tabular-nums">{fmt(d.maxFootage)} ft</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Planned buy</div>
              <div className="tabular-nums">{fmt(row.plannedTotalFootage)} ft</div>
            </div>
          </div>

          <div className="rounded-md border px-3 py-2 text-muted-foreground">
            The reorder point above is{" "}
            {d.reorderBasis === "history" ? (
              <>
                measured from <strong>{d.observations} rolls</strong> of consumption at {row.widthLabel}.
              </>
            ) : d.reorderBasis === "apportioned" ? (
              <>
                <span className="text-amber-700 dark:text-amber-400 font-medium">apportioned</span> — there isn&apos;t
                enough consumption history at {row.widthLabel} to size one, so the stock-level figure was split by this
                width&apos;s share of committed demand. It&apos;s an estimate; a manual reorder point below will beat it.
              </>
            ) : (
              <>
                <span className="text-amber-700 dark:text-amber-400 font-medium">not computable</span> — no usable
                demand signal at {row.widthLabel}. Set one manually if this width needs stocking.
              </>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field label="Vendor" hint="Overrides the Label Traxx supplier for purchasing">
              <Input value={vendorName} onChange={(e) => setVendorName(e.target.value)} className="h-8 text-xs" />
            </Field>
            <Field
              label="Lead time (days)"
              hint="Blank uses observed PO placed → received history"
              auto={`auto ${d.leadTimeDays}d from ${d.leadTimeSource}`}
            >
              <Input
                type="number"
                value={leadTimeDays}
                onChange={(e) => setLeadTimeDays(e.target.value)}
                placeholder={String(d.leadTimeDays)}
                className="h-8 text-xs"
              />
            </Field>
            <Field label="Footage per roll" auto={`auto ${fmt(d.typicalRollFootage)} ft`}>
              <Input
                type="number"
                value={rollFootage}
                onChange={(e) => setRollFootage(e.target.value)}
                placeholder={String(d.typicalRollFootage)}
                className="h-8 text-xs"
              />
            </Field>
            <Field
              label="Order qty (rolls)"
              hint="Fixed batch per PO, overriding the economic quantity. Master ROLLS, not footage."
              auto={row.orderQuantityIgnored != null ? `ignored: ${fmt(row.orderQuantityIgnored)} is not a roll count` : "blank = economic quantity"}
            >
              <Input
                type="number"
                value={orderQty}
                onChange={(e) => setOrderQty(e.target.value)}
                className={cn("h-8 text-xs", row.orderQuantityIgnored != null && "border-red-500/60")}
              />
            </Field>
            <Field label="Reorder point (ft)" hint="Manual reorder point; blank uses the calculated one" auto={`calculated ${fmt(d.reorderPointFootage)} ft`}>
              <Input
                type="number"
                value={reorderPoint}
                onChange={(e) => setReorderPoint(e.target.value)}
                placeholder={String(Math.round(d.reorderPointFootage))}
                className="h-8 text-xs"
              />
            </Field>
            <Field label="Max (ft)" hint="Manual order-up-to level; blank uses the calculated one" auto={`calculated ${fmt(d.maxFootage)} ft`}>
              <Input
                type="number"
                value={maxFootage}
                onChange={(e) => setMaxFootage(e.target.value)}
                placeholder={String(Math.round(d.maxFootage))}
                className="h-8 text-xs"
              />
            </Field>
          </div>

          <div className="space-y-1">
            <div className="text-muted-foreground">Can run instead — in preference order</div>
            <AlternatesEditor
              value={alternates}
              onChange={setAlternates}
              selfStockId={row.stockId}
              availability={availability}
            />
          </div>

          <label className="flex items-center gap-2">
            <Checkbox checked={discontinued} onCheckedChange={(v) => setDiscontinued(v === true)} />
            <span>
              End of life — keep showing on-hand to sell through, never plan a reorder
            </span>
          </label>

          <p className="text-muted-foreground">
            These settings are stored per <strong>stock</strong>, so they apply to every width of #{row.stockId} — the
            plan is per width, but Label Traxx has no per-width stock record to hang them on.{" "}
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
              service level {Math.round(d.serviceLevel * 100)}%
            </Badge>{" "}
            is set globally under Setup.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={save.isPending} onClick={submit}>
            {save.isPending ? "Saving…" : "Save & recalculate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
