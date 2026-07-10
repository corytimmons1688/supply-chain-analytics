import * as React from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Network, ChevronDown, ChevronRight, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGetAsl } from "@workspace/api-client-react";
import type { AslRow } from "@workspace/api-client-react";
import { CAPABILITY_TAXONOMY, capabilityTag, parseCapabilities } from "@/lib/capability-taxonomy";

type VendorLite = {
  id: string;
  name: string;
  onboarded: boolean;
  country: string | null;
};

/**
 * Dynamic vendor network: product categories → primary capabilities →
 * vendors covering each capability, driven live by the capability tags on
 * every vendor (ASL + Flex Sourcing pipeline). Capabilities with no coverage
 * render as sourcing gaps, mirroring the Calyx Supply Web.
 */
export default function VendorNetwork() {
  const { data, isLoading } = useGetAsl();
  const [open, setOpen] = React.useState<Set<string>>(new Set());

  // One vendor entry per unique vendor across both tables.
  const vendors = React.useMemo(() => {
    const rows: AslRow[] = [...(data?.aslSuppliers ?? []), ...(data?.pipeline ?? [])];
    const byId = new Map<string, { v: VendorLite; tags: Set<string> }>();
    for (const r of rows) {
      const existing = byId.get(r.vendor.id);
      const onboarded = r.entry.status === "onboarded";
      const tags = new Set(parseCapabilities(r.vendor.capabilities));
      if (existing) {
        existing.v.onboarded = existing.v.onboarded || onboarded;
        for (const t of tags) existing.tags.add(t);
      } else {
        byId.set(r.vendor.id, {
          v: { id: r.vendor.id, name: r.vendor.name, onboarded, country: r.vendor.country ?? null },
          tags,
        });
      }
    }
    return [...byId.values()];
  }, [data]);

  // capability tag -> vendors covering it. Legacy unqualified values match
  // any capability with the same bare name so old data still shows up.
  const coverage = React.useMemo(() => {
    const map = new Map<string, VendorLite[]>();
    for (const cat of CAPABILITY_TAXONOMY) {
      for (const cap of cat.capabilities) {
        const tag = capabilityTag(cat.category, cap);
        const covering = vendors
          .filter(({ tags }) => tags.has(tag) || tags.has(cap))
          .map(({ v }) => v)
          .sort((a, b) => Number(b.onboarded) - Number(a.onboarded) || a.name.localeCompare(b.name));
        map.set(tag, covering);
      }
    }
    return map;
  }, [vendors]);

  const toggle = (category: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });

  const taggedVendorCount = vendors.filter(({ tags }) => tags.size > 0).length;

  return (
    <Layout>
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Network className="w-6 h-6 text-muted-foreground" /> Vendor Network
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Product categories → primary capabilities → covering vendors, live from the capability
          tags on the Approved Supplier List and Flex Sourcing pipeline. Amber capabilities are
          sourcing gaps.
        </p>
        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" /> Onboarded supplier
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-zinc-400" /> Pipeline candidate
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CircleAlert className="w-3.5 h-3.5 text-amber-500" /> Sourcing gap
          </span>
          <span className="ml-auto">{taggedVendorCount} vendors tagged with capabilities</span>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
          {CAPABILITY_TAXONOMY.map((cat) => {
            const isOpen = open.has(cat.category);
            const caps = cat.capabilities.map((cap) => ({
              cap,
              vendors: coverage.get(capabilityTag(cat.category, cap)) ?? [],
            }));
            const covered = caps.filter((c) => c.vendors.length > 0).length;
            const vendorIds = new Set(caps.flatMap((c) => c.vendors.map((v) => v.id)));
            const gaps = cat.capabilities.length - covered;
            return (
              <Card
                key={cat.category}
                className={cn("cursor-pointer transition-colors", !isOpen && "hover:border-primary/40")}
                onClick={() => toggle(cat.category)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm flex items-center gap-1.5">
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                      )}
                      {cat.category}
                    </CardTitle>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {gaps > 0 && (
                        <Badge
                          variant="outline"
                          className="text-[10px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40"
                        >
                          {gaps} gap{gaps > 1 ? "s" : ""}
                        </Badge>
                      )}
                      <Badge variant="secondary" className="text-[10px]">
                        {vendorIds.size} vendor{vendorIds.size === 1 ? "" : "s"}
                      </Badge>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {covered} / {cat.capabilities.length} capabilities covered
                  </p>
                </CardHeader>
                {isOpen && (
                  <CardContent className="pt-0 space-y-2" onClick={(e) => e.stopPropagation()}>
                    {caps.map(({ cap, vendors: covering }) => (
                      <div key={cap} className="rounded-md border px-2.5 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium">{cap}</span>
                          {covering.length === 0 && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                              <CircleAlert className="w-3 h-3" /> sourcing gap
                            </span>
                          )}
                        </div>
                        {covering.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {covering.map((v) => (
                              <Badge
                                key={v.id}
                                variant="outline"
                                title={`${v.name}${v.country ? ` · ${v.country}` : ""} · ${v.onboarded ? "onboarded" : "pipeline"}`}
                                className={cn(
                                  "text-[10px] font-normal",
                                  v.onboarded
                                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/40"
                                    : "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-400/40",
                                )}
                              >
                                {v.name}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </Layout>
  );
}
