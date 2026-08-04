/**
 * Forward Material Demand — live from HubSpot pre-order support. READ ONLY.
 *
 * Scope, fixed deliberately (see @workspace/hubspot-preorder for the why):
 *   • INTERNAL ONLY (`location = Internal`). External jobs are vendor-made and
 *     consume none of our roll stock.
 *   • Estimating pipeline from IN PROGRESS onward: In Progress → Quote Completed
 *     → Quote Accepted → Quote Rejected.
 *   • Spoilage from the real LT curves: ABGA (plain labels), ABG3 (any
 *     embellishment), flexpack laminator. Nothing here is tunable — change it in
 *     LabelTraxx and this follows.
 *
 * Nothing is ever written back to HubSpot.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Database,
  Factory,
  Layers,
  Lock,
  RefreshCw,
} from "lucide-react";

import { Layout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FootageFlowSankey, type SankeyStage } from "@/components/footage-flow-sankey";

/* ------------------------------------------------------------------- types */

interface Footage {
  goodFt: number;
  spoilageFt: number;
  requiredFt: number;
  spoilagePct: number;
  spoilageBracketPct: number;
  spoilageFloored: boolean;
  spoilageOutOfRange: boolean;
  machineCode: string;
  noAcross: number;
  repeatIn: number;
  swapped: boolean;
}

interface Line {
  id: string;
  itemName: string;
  kind: "LABEL" | "FLEXPACK";
  stageId: string;
  stageLabel: string;
  outcome: string;
  probability: number;
  qty: number | null;
  widthIn: number | null;
  heightIn: number | null;
  embellishment: string | null;
  machineCode: string;
  substrateRaw: string | null;
  substrateStockId: number | null;
  laminateStockId: number | null;
  copyPosition: string | null;
  copyPositionAssumed: boolean;
  dueDate: string | null;
  footage: Footage | null;
  weightedFt: number;
}

interface Stock {
  ltStockId: number;
  description: string;
  kind: string;
  role: string;
  byStage: Record<string, number>;
  rawFt: number;
  weightedFt: number;
  lineCount: number;
}

interface Forecast {
  generatedAt: string;
  source: { object: string; pipeline: string; stages: { id: string; label: string }[] };
  totals: {
    hubspotTotal: number; forecastable: number; inReview: number; outOfScope: number;
    rawFt: number; weightedFt: number;
  };
  stages: SankeyStage[];
  stocks: Stock[];
  lines: Line[];
  review: { job: { id: string; itemName: string; kind: string; stageLabel: string }; blockers: string[] }[];
}

/* -------------------------------------------------------------- formatting */

const mono = "font-mono tabular-nums";
const ft = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));

/* ------------------------------------------------------------------ ledger */

type SortKey = "requiredFt" | "weightedFt" | "qty" | "ftPerUnit" | "spoilagePct" | "itemName" | "stage";
type SortDir = "asc" | "desc";

const SORTS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "requiredFt", label: "Footage required", numeric: true },
  { key: "weightedFt", label: "Weighted footage", numeric: true },
  { key: "qty", label: "Quantity", numeric: true },
  { key: "ftPerUnit", label: "Feet / unit", numeric: true },
  { key: "spoilagePct", label: "Spoilage %", numeric: true },
  { key: "stage", label: "Stage", numeric: false },
  { key: "itemName", label: "Job", numeric: false },
];

function sortValue(l: Line, key: SortKey): number | string {
  const f = l.footage;
  switch (key) {
    case "requiredFt": return f?.requiredFt ?? 0;
    case "weightedFt": return l.weightedFt;
    case "qty": return l.qty ?? 0;
    // feet of stock consumed per finished unit — the efficiency measure
    case "ftPerUnit": return f && l.qty ? f.requiredFt / l.qty : 0;
    case "spoilagePct": return f?.spoilagePct ?? 0;
    case "stage": return l.stageLabel;
    case "itemName": return l.itemName;
  }
}

function DemandLedger({ lines }: { lines: Line[] }) {
  const [sortKey, setSortKey] = React.useState<SortKey>("requiredFt");
  const [sortDir, setSortDir] = React.useState<SortDir>("desc");
  const [kind, setKind] = React.useState<"ALL" | "LABEL" | "FLEXPACK">("ALL");

  const rows = React.useMemo(() => {
    const filtered = kind === "ALL" ? lines : lines.filter((l) => l.kind === kind);
    const sorted = [...filtered].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [lines, sortKey, sortDir, kind]);

  const toggle = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      // numeric columns are most useful biggest-first
      setSortDir(SORTS.find((s) => s.key === k)?.numeric ? "desc" : "asc");
    }
  };

  const Th = ({ k, children, align = "right" }: { k: SortKey; children: React.ReactNode; align?: "left" | "right" }) => (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <button type="button" onClick={() => toggle(k)}
        className={`inline-flex items-center gap-1 hover:text-foreground transition-colors ${sortKey === k ? "text-foreground font-semibold" : ""}`}>
        {children}
        {sortKey === k && (sortDir === "desc" ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </TableHead>
  );

  const totalShown = rows.reduce((a, r) => a + (r.footage?.requiredFt ?? 0), 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Demand ledger</CardTitle>
            <CardDescription>
              Every internal estimate, ranked. Click a column to re-rank — default is
              heaviest footage first. <strong className="text-foreground">Feet / unit</strong> ranks
              by how much stock each finished piece costs, which finds the wasteful jobs a raw
              footage sort hides.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border bg-muted/40 p-0.5 text-xs font-semibold">
              {(["ALL", "LABEL", "FLEXPACK"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setKind(k)}
                  className={`rounded px-2.5 py-1 transition-colors ${kind === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                  {k === "ALL" ? "All" : k === "LABEL" ? "Labels" : "Flexpack"}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {rows.length} jobs · <span className={mono}>{ft(totalShown)} ft</span> required
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[560px] overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <Th k="itemName" align="left">Job</Th>
                <Th k="stage" align="left">Stage</Th>
                <Th k="qty">Qty</Th>
                <Th k="requiredFt">Required ft</Th>
                <Th k="ftPerUnit">ft / unit</Th>
                <Th k="spoilagePct">Spoilage</Th>
                <Th k="weightedFt">Weighted ft</Th>
                <TableHead>Stock</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((l, i) => {
                const f = l.footage;
                const perUnit = f && l.qty ? f.requiredFt / l.qty : null;
                return (
                  <TableRow key={l.id} className={l.outcome === "LOST" ? "opacity-55" : undefined}>
                    <TableCell className="max-w-[280px]">
                      <div className="flex items-center gap-1.5">
                        <span className={`${mono} text-[10px] text-muted-foreground`}>#{i + 1}</span>
                        <span className="truncate text-xs font-medium">{l.itemName}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className={`rounded px-1 font-semibold ${l.kind === "LABEL" ? "bg-sky-500/10 text-sky-700 dark:text-sky-400" : "bg-violet-500/10 text-violet-700 dark:text-violet-400"}`}>
                          {l.kind}
                        </span>
                        <span className={mono}>{l.machineCode}</span>
                        {l.embellishment && l.embellishment !== "None" && (
                          <span className="text-amber-600 dark:text-amber-400">{l.embellishment}</span>
                        )}
                        {f?.swapped && <span title="Copy position rotated the label 90°">rotated</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-[11px]">{l.stageLabel}</div>
                      <div className={`text-[10px] text-muted-foreground ${mono}`}>p={l.probability}</div>
                    </TableCell>
                    <TableCell className={`text-right text-xs ${mono}`}>{l.qty?.toLocaleString() ?? "—"}</TableCell>
                    <TableCell className={`text-right font-semibold ${mono}`}>
                      {f ? ft(f.requiredFt) : "—"}
                      {f && <div className="text-[10px] font-normal text-muted-foreground">good {ft(f.goodFt)}</div>}
                    </TableCell>
                    <TableCell className={`text-right text-xs ${mono}`}>
                      {perUnit != null ? perUnit.toFixed(3) : "—"}
                    </TableCell>
                    <TableCell className={`text-right text-xs ${mono}`}>
                      {f ? `${f.spoilagePct}%` : "—"}
                      {f?.spoilageFloored && (
                        <div className="text-[10px] text-amber-600 dark:text-amber-400">floor ({f.spoilageBracketPct}%)</div>
                      )}
                      {f?.spoilageOutOfRange && (
                        <div className="text-[10px] text-rose-600 dark:text-rose-400">past curve</div>
                      )}
                    </TableCell>
                    <TableCell className={`text-right text-xs ${mono} text-muted-foreground`}>{ft(l.weightedFt)}</TableCell>
                    <TableCell className="text-xs">
                      {l.substrateStockId ? (
                        <span className={mono}>
                          #{l.substrateStockId}
                          {l.laminateStockId ? <> + #{l.laminateStockId}</> : null}
                        </span>
                      ) : <span className="text-rose-600 dark:text-rose-400">none</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------- page */

export default function ForwardMaterialDemand() {
  const { data, isLoading, error, refetch, isFetching } = useQuery<Forecast>({
    queryKey: ["forecasting", "preorder"],
    queryFn: () => customFetch<Forecast>("/api/forecasting/preorder", { responseType: "json" }),
    staleTime: 5 * 60 * 1000,
  });

  const convertPct = data && data.totals.rawFt > 0
    ? Math.round((data.totals.weightedFt / data.totals.rawFt) * 100) : 0;
  const flooredCount = data?.lines.filter((l) => l.footage?.spoilageFloored).length ?? 0;
  const pastCurve = data?.lines.filter((l) => l.footage?.spoilageOutOfRange).length ?? 0;

  return (
    <Layout>
      <div className="flex flex-col gap-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">Forward material demand</h1>
              <Badge variant="outline" className="gap-1 font-mono text-[10px]">
                <Lock className="h-3 w-3" />HUBSPOT · READ ONLY
              </Badge>
              <Badge variant="outline" className="font-mono text-[10px]">INTERNAL ONLY</Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Open estimates from the HubSpot estimating pipeline, converted to feet of LabelTraxx
              roll stock through the PackOS geometry and the real ABGA / ABG3 / flexpack spoilage
              curves. In Progress onward; internal jobs only.
            </p>
          </div>
          <button type="button" onClick={() => void refetch()} disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold hover:bg-accent disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            {isFetching ? "Pulling…" : "Refresh from HubSpot"}
          </button>
        </div>

        {isLoading && (
          <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
            Pulling the estimating pipeline from HubSpot…
          </CardContent></Card>
        )}

        {error && (
          <Card className="border-l-4 border-l-rose-500">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400" />
                Could not reach HubSpot
              </CardTitle>
              <CardDescription>
                {(error as Error).message}. Check that <span className={mono}>HUBSPOT_TOKEN</span> is
                set on the API server with CRM read scopes.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {data && (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card><CardContent className="p-4">
                <div className="text-[11px] font-semibold text-muted-foreground">Raw forward footage</div>
                <div className={`mt-1 text-2xl font-semibold ${mono}`}>{ft(data.totals.rawFt)}<span className="ml-1 text-sm text-muted-foreground">ft</span></div>
                <div className="text-[11px] text-muted-foreground">{data.totals.forecastable} forecastable jobs</div>
              </CardContent></Card>
              <Card><CardContent className="p-4">
                <div className="text-[11px] font-semibold text-muted-foreground">Expected to convert</div>
                <div className={`mt-1 text-2xl font-semibold ${mono}`} style={{ color: "#0ca30c" }}>
                  {ft(data.totals.weightedFt)}<span className="ml-1 text-sm text-muted-foreground">ft</span>
                </div>
                <div className="text-[11px] text-muted-foreground">{convertPct}% of raw · buy against this</div>
              </CardContent></Card>
              <Card><CardContent className="p-4">
                <div className="text-[11px] font-semibold text-muted-foreground">Roll stocks touched</div>
                <div className={`mt-1 text-2xl font-semibold ${mono}`}>{data.stocks.length}</div>
                <div className="text-[11px] text-muted-foreground">substrate + laminate</div>
              </CardContent></Card>
              <Card><CardContent className="p-4">
                <div className="text-[11px] font-semibold text-muted-foreground">Needs review</div>
                <div className={`mt-1 text-2xl font-semibold ${mono}`} style={{ color: "#b7791f" }}>{data.totals.inReview}</div>
                <div className="text-[11px] text-muted-foreground">excluded until fixed</div>
              </CardContent></Card>
            </div>

            {/* the flow */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Layers className="h-4 w-4" />Footage flow by deal stage
                </CardTitle>
                <CardDescription>
                  How heavy the material requirement is at each stage of the estimating pipeline, and
                  how much of it is expected to become a real purchase.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FootageFlowSankey stages={data.stages} />
              </CardContent>
            </Card>

            {/* stock rollup */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Factory className="h-4 w-4" />Feet by roll stock
                </CardTitle>
                <CardDescription>
                  LT stock construction IDs — what a PO would actually be raised against. Heaviest first.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>LT stock</TableHead>
                        <TableHead>Role</TableHead>
                        {data.source.stages.map((s) => (
                          <TableHead key={s.id} className="text-right">{s.label}</TableHead>
                        ))}
                        <TableHead className="text-right">Raw ft</TableHead>
                        <TableHead className="text-right">Weighted ft</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.stocks.map((s) => (
                        <TableRow key={s.ltStockId}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className={`font-semibold ${mono}`}>#{s.ltStockId}</span>
                              <span className={`rounded px-1 text-[10px] font-semibold ${s.kind === "LABEL" ? "bg-sky-500/10 text-sky-700 dark:text-sky-400" : "bg-violet-500/10 text-violet-700 dark:text-violet-400"}`}>
                                {s.kind}
                              </span>
                            </div>
                            <div className="max-w-[260px] truncate text-[11px] text-muted-foreground">{s.description}</div>
                          </TableCell>
                          <TableCell className="text-[11px] text-muted-foreground">{s.role}</TableCell>
                          {data.source.stages.map((st) => (
                            <TableCell key={st.id} className={`text-right text-xs ${mono} ${!s.byStage[st.id] ? "text-muted-foreground/50" : ""}`}>
                              {s.byStage[st.id] ? ft(s.byStage[st.id]!) : "·"}
                            </TableCell>
                          ))}
                          <TableCell className={`text-right font-semibold ${mono}`}>{ft(s.rawFt)}</TableCell>
                          <TableCell className={`text-right text-xs ${mono} text-muted-foreground`}>{ft(s.weightedFt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <DemandLedger lines={data.lines} />

            {/* assumptions + review */}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Database className="h-4 w-4" />Spoilage assumptions in force
                  </CardTitle>
                  <CardDescription>
                    From the LabelTraxx Press Speeds &amp; Spoilage records. Not adjustable here.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-xs">
                  <div className="rounded-md border p-2.5">
                    <div className="font-semibold">ABGA — plain labels (laminating only)</div>
                    <div className={`mt-1 text-[11px] text-muted-foreground ${mono}`}>
                      0–50: 20% · 51–101: 6% · 101–3k: 5% · 3k–4k: 4% · 4k–5k: 3% · 5k–10k: 3% · 10k–12.5k: 2.5% · 12.5k–100k: 2.25%
                    </div>
                  </div>
                  <div className="rounded-md border p-2.5">
                    <div className="font-semibold">ABG3 — labels with any embellishment</div>
                    <div className={`mt-1 text-[11px] text-muted-foreground ${mono}`}>
                      0–100: 100% · 101–200: 50% · 201–1k: 8% · 1k–2.5k: 6% · 2.5k–5k: 5% · 5k+: 4%
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      Flat / Tactile Spot UV, Cold Foil, Cast &amp; Cure, or peel-and-reveal route here instead of ABGA.
                    </div>
                  </div>
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
                    <div className="font-semibold">Flexpack laminator</div>
                    <div className={`mt-1 text-[11px] text-muted-foreground ${mono}`}>
                      0–500: 3% · 501–2.5k: 1% · 2.5k–5k: 1% · 5k+: 1%
                    </div>
                    <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                      Min floor is 2%, so the 1% brackets never apply — effective spoilage above 500 ft
                      is <strong>2%</strong>. {flooredCount} jobs hit that floor.
                    </div>
                  </div>
                  {pastCurve > 0 && (
                    <div className="rounded-md border border-rose-500/40 bg-rose-500/5 p-2.5 text-[11px]">
                      <strong className="text-foreground">{pastCurve} job(s) run past the top bracket</strong> of
                      their curve (ABGA stops at 100,000 ft). The last bracket is applied and the row is
                      flagged &ldquo;past curve&rdquo; — extend the LT curve if these are real.
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="border-l-4 border-l-amber-500">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Needs review · {data.totals.inReview}</CardTitle>
                  <CardDescription>
                    Excluded from the forecast until fixed in HubSpot — never silently dropped.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex max-h-[380px] flex-col gap-2 overflow-auto">
                  {data.review.slice(0, 40).map((r) => (
                    <div key={r.job.id} className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
                      <div className="truncate font-medium">{r.job.itemName}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {r.job.stageLabel} · {r.blockers.join(" · ")}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>

            <p className="pb-6 text-xs text-muted-foreground">
              Pulled live from HubSpot object <span className={mono}>{data.source.object}</span>, pipeline{" "}
              <span className={mono}>{data.source.pipeline}</span> ·{" "}
              {data.totals.hubspotTotal} internal records ({data.totals.forecastable} forecastable,{" "}
              {data.totals.inReview} in review, {data.totals.outOfScope} out of scope) ·
              generated {new Date(data.generatedAt).toLocaleString()}. Phase 1 = HubSpot only;
              NetSuite is next. <strong className="text-foreground">This page never writes to HubSpot.</strong>
            </p>
          </>
        )}
      </div>
    </Layout>
  );
}
