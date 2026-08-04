/**
 * Forward Material Demand — the holistic tab.
 *
 * Rolls the whole open pipeline up into feet of roll stock by material and by month,
 * so purchasing can see the next quarter in one view. Raw = every open estimate at
 * full quantity; Weighted = each scaled by its stage probability. Clicking a material
 * opens its footage-flow Sankey.
 *
 * Aggregated from the SAME resolved ledger the quote-stage tab uses (resolveAll), so
 * the double-count guard already applies — only counted requirements are summed.
 */

import * as React from "react";
import { Workflow, Package, AlertTriangle } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { resolveAll, STOCKS, type Resolved } from "./forecasting-v2-data";
import { ForwardFootageSankey } from "./ForwardFootageSankey";

const mono = "font-mono tabular-nums";
const fmtFt = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`
    : v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`;

/** requiredWeek (0 = this week, today ≈ Aug 3 2026) → one of four columns. */
const MONTHS = ["Aug '26", "Sep '26", "Oct '26", "Nov+ '26"] as const;
type MonthCol = (typeof MONTHS)[number];
function monthOf(week: number): MonthCol {
  if (week <= 4) return "Aug '26";
  if (week <= 8) return "Sep '26";
  if (week <= 13) return "Oct '26";
  return "Nov+ '26";
}

interface Row {
  stockId: string;
  description: string;
  raw: Record<MonthCol, number>;
  wtd: Record<MonthCol, number>;
  rawTot: number; // 90-day (first three columns)
  wtdTot: number;
  records: number;
}

const emptyMonths = (): Record<MonthCol, number> => ({ "Aug '26": 0, "Sep '26": 0, "Oct '26": 0, "Nov+ '26": 0 });

export default function ForwardMaterialDemand() {
  const { resolved } = React.useMemo(() => resolveAll(), []);
  const [mode, setMode] = React.useState<"raw" | "wtd">("wtd");
  const [openStock, setOpenStock] = React.useState<string | null>(null);

  const { rows, exceptions } = React.useMemo(() => {
    const acc: Record<string, Row> = {};
    const ensure = (id: string): Row => {
      if (!acc[id]) {
        acc[id] = {
          stockId: id,
          description: STOCKS[id]?.description ?? id,
          raw: emptyMonths(), wtd: emptyMonths(), rawTot: 0, wtdTot: 0, records: 0,
        };
      }
      return acc[id]!;
    };
    const exceptions: { r: Resolved; why: string }[] = [];

    for (const r of resolved) {
      if (!r.counted) continue;
      // needs-review cases are excluded from the roll-up and surfaced separately
      if (!r.footage || r.faceStockId == null) {
        exceptions.push({ r, why: r.rec.qty == null ? "quantity blank" : r.faceStockId == null ? "no stock mapped" : "no requirement derivable" });
        continue;
      }
      const m = monthOf(r.rec.requiredWeek);
      const ft = r.footage.requiredFt;
      // face + laminate both consume the web length
      const targets = [r.faceStockId, r.laminateStockId].filter(Boolean) as string[];
      for (const id of targets) {
        const row = ensure(id);
        row.raw[m] += ft;
        row.wtd[m] += ft * r.p;
        row.records += 1;
      }
    }
    const rows = Object.values(acc);
    for (const row of rows) {
      row.rawTot = row.raw["Aug '26"] + row.raw["Sep '26"] + row.raw["Oct '26"];
      row.wtdTot = row.wtd["Aug '26"] + row.wtd["Sep '26"] + row.wtd["Oct '26"];
    }
    rows.sort((a, b) => b.rawTot - a.rawTot);
    return { rows, exceptions };
  }, [resolved]);

  const active = mode === "raw" ? (r: Row) => r.raw : (r: Row) => r.wtd;
  const activeTot = mode === "raw" ? (r: Row) => r.rawTot : (r: Row) => r.wtdTot;

  const maxCell = React.useMemo(() => {
    let m = 0;
    for (const r of rows) for (const mo of ["Aug '26", "Sep '26", "Oct '26"] as MonthCol[]) m = Math.max(m, active(r)[mo]);
    return m || 1;
  }, [rows, mode]);

  const totals = React.useMemo(() => {
    const raw = rows.reduce((a, r) => a + r.rawTot, 0);
    const wtd = rows.reduce((a, r) => a + r.wtdTot, 0);
    const recs = rows.reduce((a, r) => a + r.records, 0);
    return { raw, wtd, recs };
  }, [rows]);

  const openRow = rows.find((r) => r.stockId === openStock) ?? null;

  return (
    <div className="fmd flex flex-col gap-5">
      <style>{`
        .fmd .heat{background-color:rgba(14,124,123,var(--a,0));}
        .dark .fmd .heat{background-color:rgba(47,182,174,var(--a,0));}
      `}</style>

      <div>
        <h2 className="text-xl font-semibold tracking-tight">Forward material demand</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          The whole open pipeline rolled up to <strong className="text-foreground">feet of roll stock</strong> by
          material and month — one view of the next quarter. Click any material for its footage flow across deal stages.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card><CardContent className="p-4">
          <div className="text-[11px] font-semibold text-muted-foreground">Weighted forward footage · 90d</div>
          <div className={`mt-1 text-2xl font-semibold ${mono}`} style={{ color: "#0ca30c" }}>{fmtFt(totals.wtd)}<span className="ml-1 text-sm text-muted-foreground">ft</span></div>
          <div className="text-[11px] text-muted-foreground">across {rows.length} roll stocks</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-[11px] font-semibold text-muted-foreground">Raw footage · all open</div>
          <div className={`mt-1 text-2xl font-semibold ${mono}`}>{fmtFt(totals.raw)}<span className="ml-1 text-sm text-muted-foreground">ft</span></div>
          <div className="text-[11px] text-muted-foreground">ceiling if every quote lands</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-[11px] font-semibold text-muted-foreground">Demand lines in scope</div>
          <div className={`mt-1 text-2xl font-semibold ${mono}`}>{totals.recs}</div>
          <div className="text-[11px] text-muted-foreground">counted · double-count guard applied</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-[11px] font-semibold text-muted-foreground">Needs review</div>
          <div className={`mt-1 text-2xl font-semibold ${mono}`} style={{ color: "#b7791f" }}>{exceptions.length}</div>
          <div className="text-[11px] text-muted-foreground">missing qty or stock</div>
        </CardContent></Card>
      </div>

      {/* matrix */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Feet of roll stock by month</CardTitle>
              <CardDescription>Click a material row to open its footage flow. Cell shading scales to the busiest cell.</CardDescription>
            </div>
            <div className="inline-flex rounded-md border bg-muted/40 p-0.5 text-xs font-semibold">
              {(["raw", "wtd"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)}
                  className={`rounded px-3 py-1.5 transition-colors ${mode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                  {m === "raw" ? "Raw" : "Stage-weighted"}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">Roll stock</th>
                  {MONTHS.map((m) => (
                    <th key={m} className={`px-4 py-2 text-right font-medium ${m === "Nov+ '26" ? "text-muted-foreground/70" : ""}`}>{m}</th>
                  ))}
                  <th className="border-l px-4 py-2 text-right font-medium">90-day</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const v = active(r);
                  return (
                    <tr key={r.stockId} onClick={() => setOpenStock(r.stockId)}
                      className="cursor-pointer border-b transition-colors hover:bg-accent/40">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <span className={`font-semibold ${mono}`}>#{r.stockId}</span>
                          <Workflow className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
                        <div className="max-w-[240px] truncate text-[11px] text-muted-foreground">{r.description}</div>
                      </td>
                      {MONTHS.map((m) => {
                        const val = v[m];
                        const tail = m === "Nov+ '26";
                        const a = tail ? 0 : Math.min(0.9, (val / maxCell) * 0.92);
                        return (
                          <td key={m} className="px-0 py-0">
                            <div className={`heat px-4 py-2 text-right ${mono} ${val === 0 ? "text-muted-foreground/60" : ""} ${tail ? "opacity-60" : ""}`}
                              style={{ "--a": String(a) } as React.CSSProperties}>
                              {val === 0 ? "·" : fmtFt(val)}
                            </div>
                          </td>
                        );
                      })}
                      <td className={`border-l px-4 py-2 text-right font-semibold ${mono}`}>{fmtFt(activeTot(r))}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="text-sm font-semibold">
                  <td className="px-4 py-2.5">
                    All stocks
                    <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3" />visibility thins after Oct
                    </span>
                  </td>
                  {MONTHS.map((m) => (
                    <td key={m} className={`px-4 py-2.5 text-right ${mono}`}>
                      {fmtFt(rows.reduce((a, r) => a + active(r)[m], 0))}
                    </td>
                  ))}
                  <td className={`border-l px-4 py-2.5 text-right ${mono}`}>{fmtFt(rows.reduce((a, r) => a + activeTot(r), 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* exceptions */}
      {exceptions.length > 0 && (
        <Card className="border-l-4 border-l-amber-500">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="h-4 w-4" />Needs review · {exceptions.length}
            </CardTitle>
            <CardDescription>Excluded from the roll-up until fixed — not silently dropped.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {exceptions.slice(0, 6).map(({ r, why }) => (
              <div key={r.rec.id} className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
                <span className="font-medium">{r.rec.itemName}</span>
                <span className="text-muted-foreground">{r.rec.customer}</span>
                <span className="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">{why}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <p className="pb-2 text-xs text-muted-foreground">
        Aggregated from the resolved demand ledger (double-count guard applied). Footage from the PackOS geometry ·
        weighting from stage probability. Read-only — HubSpot is never written.
      </p>

      {/* per-material footage-flow dialog */}
      <Dialog open={openStock !== null} onOpenChange={(o) => !o && setOpenStock(null)}>
        <DialogContent className="max-w-[960px]">
          <DialogHeader>
            <DialogTitle>Footage flow — #{openRow?.stockId} {openRow?.description}</DialogTitle>
          </DialogHeader>
          {openRow && (
            <ForwardFootageSankey
              title={`Stock #${openRow.stockId} — ${openRow.description}`}
              subtitle="Open pipeline footage across deal stages"
              enterFt={openRow.rawTot}
              committedFt={openRow.wtdTot}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
