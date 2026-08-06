/**
 * Estimating pipeline as a funnel, with the per-order distribution at each stage.
 *
 * The Sankey and this answer different questions and neither replaces the other:
 *
 *   Sankey — where footage SITS right now, and how it splits into expected vs not.
 *   Funnel — the pipeline in stage order, how much sits at each step, and how
 *            concentrated each step is.
 *
 * HubSpot is a snapshot, so this is emphatically NOT stage-to-stage conversion:
 * the bars are current occupancy, in pipeline order. A wide "Quote Completed"
 * band means a lot is parked there today, not that everything flowed through it.
 * Labelling it a conversion funnel would be a lie, so the caption says so.
 */

import * as React from "react";

export interface FunnelStage {
  stageId: string;
  label: string;
  outcome: string;
  probability: number;
  rawFt: number;
  lineCount: number;
  topSharePct?: number;
  orders?: { id: string; itemName: string; customer: string | null; requiredFt: number }[];
}

export interface FootageFunnelProps {
  stages: FunnelStage[];
  onStageClick?: (stageId: string) => void;
}

const mono = "font-mono tabular-nums";

const fmt = (v: number) =>
  Math.abs(v) >= 1_000_000
    ? `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`
    : Math.abs(v) >= 1000
      ? `${Math.round(v / 1000)}k`
      : String(Math.round(v));

/** Pipeline order, so the funnel reads top-to-bottom as the process runs. */
const STAGE_ORDER = [
  "1213197073", // Request Que
  "1213197074", // Pending Information
  "1213427979", // In Progress
  "1213427980", // Quote Completed
  "1213427981", // Quote Accepted
  "1213427982", // Quote Rejected
  "FIRM",
];

function tone(outcome: string, stageId: string): { bar: string; text: string } {
  if (stageId === "FIRM" || outcome === "WON") return { bar: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" };
  if (outcome === "LOST") return { bar: "bg-rose-500", text: "text-rose-700 dark:text-rose-400" };
  return { bar: "bg-sky-500", text: "text-sky-700 dark:text-sky-400" };
}

export function FootageFunnel({ stages, onStageClick }: FootageFunnelProps) {
  const ordered = React.useMemo(() => {
    const withFt = stages.filter((s) => s.rawFt > 0);
    return [...withFt].sort((a, b) => {
      const ia = STAGE_ORDER.indexOf(a.stageId);
      const ib = STAGE_ORDER.indexOf(b.stageId);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [stages]);

  const max = Math.max(...ordered.map((s) => s.rawFt), 1);
  const total = ordered.reduce((a, s) => a + s.rawFt, 0);

  if (ordered.length === 0) {
    return <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No footage in any stage.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {ordered.map((s) => {
        const t = tone(s.outcome, s.stageId);
        const widthPct = (s.rawFt / max) * 100;
        const sharePct = total > 0 ? (s.rawFt / total) * 100 : 0;
        const ord = [...(s.orders ?? [])].sort((a, b) => b.requiredFt - a.requiredFt);
        const clickable = Boolean(onStageClick);
        return (
          <button
            key={s.stageId}
            type="button"
            disabled={!clickable}
            onClick={clickable ? () => onStageClick!(s.stageId) : undefined}
            className={`rounded-md border p-2.5 text-left transition-colors ${clickable ? "hover:bg-accent/40" : "cursor-default"}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-semibold">{s.label}</span>
              <span className={`text-xs ${mono} text-muted-foreground`}>
                <span className={`font-semibold ${t.text}`}>{fmt(s.rawFt)} ft</span>
                {" · "}{s.lineCount} order{s.lineCount === 1 ? "" : "s"}
                {" · "}{sharePct.toFixed(0)}% of book
                {s.stageId !== "FIRM" && ` · p=${s.probability}`}
              </span>
            </div>

            {/* the funnel bar, subdivided per order so one dominant job is visible */}
            <div className="mt-1.5 h-5 w-full rounded bg-muted/50">
              <div className={`relative h-5 rounded ${t.bar}`} style={{ width: `${Math.max(1.5, widthPct)}%` }}>
                {ord.length > 1 && (() => {
                  const tot = ord.reduce((a, o) => a + o.requiredFt, 0) || 1;
                  let left = 0;
                  return ord.map((o) => {
                    const w = (o.requiredFt / tot) * 100;
                    const seg = (
                      <span
                        key={o.id}
                        className="absolute inset-y-0 border-r border-background/70"
                        style={{ left: `${left}%`, width: `${w}%` }}
                        title={`${o.customer ?? o.itemName}\n${fmt(o.requiredFt)} ft · ${((o.requiredFt / tot) * 100).toFixed(1)}% of ${s.label}`}
                      />
                    );
                    left += w;
                    return seg;
                  });
                })()}
              </div>
            </div>

            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 text-[10px] text-muted-foreground">
              {s.topSharePct != null && (
                <span className={(s.topSharePct ?? 0) >= 60 ? "text-rose-600 dark:text-rose-400" : undefined}>
                  {(s.topSharePct ?? 0) >= 60 ? "⚠ " : ""}largest order = {Math.round(s.topSharePct)}% of stage
                </span>
              )}
              {ord[0] && (
                <span className="truncate">
                  biggest: {ord[0].customer ?? ord[0].itemName} · {fmt(ord[0].requiredFt)} ft
                </span>
              )}
              {clickable && <span className="ml-auto">click for full distribution</span>}
            </div>
          </button>
        );
      })}

      <p className="text-[11px] leading-snug text-muted-foreground">
        Bars are <strong className="text-foreground">current occupancy</strong> in pipeline order, not
        stage-to-stage conversion. HubSpot stores only today&rsquo;s state, so a wide band means a lot is parked
        at that step right now — it does not mean everything flowed through it. Each bar is segmented per order.
      </p>
    </div>
  );
}

export default FootageFunnel;
