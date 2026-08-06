/**
 * Per-order material distribution inside one deal stage.
 *
 * A stage total is ambiguous on its own: 1.54M ft across 69 estimates could be
 * one dominant job or seventy even ones, and those call for opposite decisions.
 * One big order is a single customer's choice — if it dies the whole stage moves.
 * Seventy small ones pool, and the total is far more dependable.
 *
 * So this shows the ordered distribution plus the cumulative curve, and states
 * the shape in words rather than leaving it to be read off the bars.
 */

import * as React from "react";

export interface StageDistributionOrder {
  id: string;
  itemName: string;
  customer: string | null;
  /** The value the bar is sized by. */
  requiredFt: number;
  /** Probability, shown as context for the classification — never a multiplier. */
  probability?: number;
}

export interface StageDistributionProps {
  stageLabel: string;
  probability: number;
  orders: StageDistributionOrder[];
  /**
   * "requirement" for a stage; "contribution" for the disposition columns. Both
   * are full order footage — the distinction is only whether the set was chosen
   * by stage or by expected/not-expected classification.
   */
  valueNoun?: "requirement" | "contribution";
  /** Called when a bar is clicked, to open that line's spec → feet build-up. */
  onPickOrder?: (id: string) => void;
}

const mono = "font-mono tabular-nums";

const fmt = (v: number) =>
  Math.abs(v) >= 1_000_000
    ? `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`
    : Math.abs(v) >= 1000
      ? `${Math.round(v / 1000)}k`
      : String(Math.round(v));

/** How many orders make up the first `share` of the total. */
function ordersToReach(sorted: number[], total: number, share: number): number {
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i]!;
    if (acc / total >= share) return i + 1;
  }
  return sorted.length;
}

export function StageDistribution({
  stageLabel,
  probability,
  orders,
  valueNoun = "requirement",
  onPickOrder,
}: StageDistributionProps) {
  const model = React.useMemo(() => {
    const ord = [...orders].filter((o) => o.requiredFt > 0).sort((a, b) => b.requiredFt - a.requiredFt);
    const total = ord.reduce((a, o) => a + o.requiredFt, 0);
    const fts = ord.map((o) => o.requiredFt);
    const max = fts[0] ?? 1;
    const n = ord.length;
    const median = n === 0 ? 0 : n % 2 ? fts[(n - 1) / 2]! : (fts[n / 2 - 1]! + fts[n / 2]!) / 2;
    const topShare = total > 0 ? (max / total) * 100 : 0;
    const n50 = total > 0 ? ordersToReach(fts, total, 0.5) : 0;
    const n80 = total > 0 ? ordersToReach(fts, total, 0.8) : 0;
    // Running cumulative share, for the overlay curve.
    let acc = 0;
    const cum = ord.map((o) => {
      acc += o.requiredFt;
      return total > 0 ? acc / total : 0;
    });
    return { ord, total, max, median, topShare, n50, n80, cum, n };
  }, [orders]);

  const { ord, total, max, median, topShare, n50, n80, cum, n } = model;

  if (n === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No orders with a computed footage requirement in {stageLabel}.
      </p>
    );
  }

  // Verdict: concentration is what changes the decision, so say it plainly.
  const verdict =
    topShare >= 50
      ? {
          tone: "text-rose-700 dark:text-rose-400",
          bg: "border-rose-500/40 bg-rose-500/5",
          text: `Dominated by one order — the largest single estimate is ${topShare.toFixed(0)}% of this stage. Treat the stage total as that one customer's decision, not a trend: if it dies, most of this footage goes with it.`,
        }
      : n50 <= Math.max(2, Math.ceil(n * 0.1))
        ? {
            tone: "text-amber-700 dark:text-amber-400",
            bg: "border-amber-500/40 bg-amber-500/5",
            text: `Top-heavy — just ${n50} of ${n} orders make up half the footage. The total is only as reliable as those few.`,
          }
        : {
            tone: "text-emerald-700 dark:text-emerald-400",
            bg: "border-emerald-500/40 bg-emerald-500/5",
            text: `Well spread — it takes ${n50} of ${n} orders to reach half the footage and ${n80} to reach 80%. Demand pools here, so the stage total is comparatively dependable.`,
          };

  const CHART_H = 132;

  return (
    <div className="flex flex-col gap-3">
      {/* headline stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { k: "Orders", v: String(n), s: `p=${probability}` },
          { k: "Total", v: `${fmt(total)} ft`, s: "roll stock required" },
          { k: "Largest", v: `${fmt(max)} ft`, s: `${topShare.toFixed(0)}% of stage` },
          { k: "Median", v: `${fmt(median)} ft`, s: max > 0 ? `${(max / Math.max(1, median)).toFixed(0)}× smaller than largest` : "" },
        ].map((t) => (
          <div key={t.k} className="rounded-md border p-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t.k}</div>
            <div className={`mt-0.5 text-lg font-semibold ${mono}`}>{t.v}</div>
            <div className="text-[10px] text-muted-foreground">{t.s}</div>
          </div>
        ))}
      </div>

      {/* verdict */}
      <div className={`rounded-md border p-2.5 text-xs ${verdict.bg}`}>
        <span className={`font-semibold ${verdict.tone}`}>Shape: </span>
        <span className="text-muted-foreground">{verdict.text}</span>
      </div>

      {valueNoun === "contribution" && (
        <div className="rounded-md border border-sky-500/40 bg-sky-500/5 p-2.5 text-xs text-muted-foreground">
          <strong className="text-foreground">Every bar is a full order.</strong> Nothing here is scaled by a
          probability. An order runs or it does not, so each one is classified into exactly one column at its
          whole footage — never split, never halved. The probability is shown next to each order as context for
          the classification, not as a multiplier. The total is therefore a real quantity: the footage you need
          if these orders run.
        </div>
      )}

      {/* pareto: bars + cumulative curve */}
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-xs font-semibold">Material required per order, largest first</span>
          <span className="text-[10px] text-muted-foreground">line = cumulative share of stage</span>
        </div>
        <div className="overflow-x-auto rounded-md border bg-card p-2">
          <svg
            viewBox={`0 0 ${Math.max(320, n * 14)} ${CHART_H + 22}`}
            width="100%"
            style={{ minWidth: Math.min(760, Math.max(320, n * 14)) }}
            role="img"
            aria-label={`Distribution of material requirement across ${n} orders in ${stageLabel}. Largest is ${topShare.toFixed(0)} percent of the stage.`}
          >
            {/* 50% / 80% cumulative guides */}
            {[0.5, 0.8].map((g) => (
              <g key={g}>
                <line x1={0} y1={CHART_H * (1 - g)} x2={Math.max(320, n * 14)} y2={CHART_H * (1 - g)}
                  stroke="hsl(var(--border))" strokeDasharray="3 3" strokeWidth={1} />
                <text x={2} y={CHART_H * (1 - g) - 2} fontSize={8} fill="hsl(var(--muted-foreground))">
                  {g * 100}% cumulative
                </text>
              </g>
            ))}

            {/* bars */}
            {ord.map((o, i) => {
              const bw = Math.max(2, Math.min(12, (Math.max(320, n * 14) / n) - 2));
              const x = i * (bw + 2);
              const h = Math.max(1, (o.requiredFt / max) * CHART_H);
              return (
                <rect
                  key={o.id}
                  x={x}
                  y={CHART_H - h}
                  width={bw}
                  height={h}
                  rx={1.5}
                  fill={i === 0 && topShare >= 50 ? "var(--ffs-lost, #e34948)" : "var(--ffs-open-2, #2a78d6)"}
                  fillOpacity={i === 0 ? 0.95 : 0.62}
                  style={onPickOrder ? { cursor: "pointer" } : undefined}
                  onClick={onPickOrder ? () => onPickOrder(o.id) : undefined}
                >
                  <title>{`${o.customer ?? "unknown customer"}\n${o.itemName}\n${fmt(o.requiredFt)} ft · ${((o.requiredFt / total) * 100).toFixed(1)}% of stage · rank ${i + 1} of ${n}`}</title>
                </rect>
              );
            })}

            {/* cumulative curve */}
            <path
              d={cum
                .map((c, i) => {
                  const bw = Math.max(2, Math.min(12, (Math.max(320, n * 14) / n) - 2));
                  const x = i * (bw + 2) + bw / 2;
                  return `${i === 0 ? "M" : "L"}${x},${CHART_H * (1 - c)}`;
                })
                .join(" ")}
              fill="none"
              stroke="hsl(var(--foreground))"
              strokeOpacity={0.55}
              strokeWidth={1.4}
            />
          </svg>
        </div>
        {onPickOrder && (
          <p className="mt-1 text-[10px] text-muted-foreground">Click a bar for that order&rsquo;s spec → feet build-up.</p>
        )}
      </div>

      {/* top orders table */}
      <div>
        <div className="mb-1 text-xs font-semibold">Largest orders</div>
        <div className="max-h-52 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <tbody>
              {ord.slice(0, 15).map((o, i) => (
                <tr
                  key={o.id}
                  className={`border-b last:border-0 ${onPickOrder ? "cursor-pointer hover:bg-accent/40" : ""}`}
                  onClick={onPickOrder ? () => onPickOrder(o.id) : undefined}
                >
                  <td className={`w-8 px-2 py-1.5 text-right ${mono} text-muted-foreground`}>{i + 1}</td>
                  <td className="px-2 py-1.5">
                    <div className="truncate">{o.customer ?? <span className="text-muted-foreground">unknown customer</span>}</div>
                    <div className="max-w-[380px] truncate text-[10px] text-muted-foreground">{o.itemName}</div>
                  </td>
                  {valueNoun === "contribution" && (
                    <td className={`w-20 px-2 py-1.5 text-right ${mono} text-muted-foreground`}>
                      {o.probability != null ? `p=${o.probability.toFixed(2)}` : "—"}
                    </td>
                  )}
                  <td className={`px-2 py-1.5 text-right font-semibold ${mono}`}>{fmt(o.requiredFt)} ft</td>
                  <td className={`w-14 px-2 py-1.5 text-right ${mono} text-muted-foreground`}>
                    {((o.requiredFt / total) * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {n > 15 && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            Showing the 15 largest of {n}. The remaining {n - 15} account for{" "}
            {(100 - (ord.slice(0, 15).reduce((a, o) => a + o.requiredFt, 0) / total) * 100).toFixed(1)}% of the stage.
          </p>
        )}
      </div>
    </div>
  );
}

export default StageDistribution;
