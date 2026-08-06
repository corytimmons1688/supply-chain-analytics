/**
 * Big hitters and unclear quantities.
 *
 * Two lists that both answer "what should a human look at before we buy":
 *
 *  1. ACCEPTED AND LARGE — quotes the customer has accepted that carry enough
 *     footage to move a stock on their own. These are the closest thing to
 *     committed demand before NetSuite sees them, so they should never be a
 *     surprise.
 *
 *  2. QUANTITY UNCLEAR — the quoted quantity divided by the stated monthly
 *     release rate spans more than ~1.5 months, so the quote is a blanket total
 *     rather than material needed now. Measured 2026-08-06: this covers 51% of
 *     all open quoted units, median 2.0× and up to 19.2×. Buying against the
 *     blanket is the single largest overstatement in the model.
 *
 * Nothing here is auto-corrected. A blanket total is not wrong — it is just not a
 * near-term requirement — and only the person who owns the deal knows which.
 */

import * as React from "react";

export interface BigHitterLine {
  id: string;
  itemName: string;
  customer: string | null;
  stageLabel: string;
  probability: number;
  qty: number | null;
  projectedMonthlyDemand: number | null;
  releaseSpanMonths: number | null;
  qtyNeedsClarification: boolean;
  requiredFt: number;
  substrateStockId: number | null;
  laminateStockId: number | null;
}

export interface BigHittersProps {
  lines: BigHitterLine[];
  /** Footage at which one order can move a stock on its own. */
  bigFt?: number;
  onPickLine?: (id: string) => void;
}

const mono = "font-mono tabular-nums";

const fmt = (v: number) =>
  Math.abs(v) >= 1_000_000
    ? `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`
    : Math.abs(v) >= 1000
      ? `${Math.round(v / 1000)}k`
      : String(Math.round(v));

function Row({
  l,
  onPick,
  right,
}: {
  l: BigHitterLine;
  onPick?: (id: string) => void;
  right: React.ReactNode;
}) {
  return (
    <tr
      className={`border-b last:border-0 ${onPick ? "cursor-pointer hover:bg-accent/40" : ""}`}
      onClick={onPick ? () => onPick(l.id) : undefined}
    >
      <td className="px-2 py-1.5">
        <div className="truncate text-xs font-medium">
          {l.customer ?? <span className="text-muted-foreground">unknown customer</span>}
        </div>
        <div className="max-w-[360px] truncate text-[10px] text-muted-foreground">{l.itemName}</div>
      </td>
      <td className="px-2 py-1.5 text-[11px] text-muted-foreground">
        {l.stageLabel}
        <div className={`text-[10px] ${mono}`}>
          {[l.substrateStockId, l.laminateStockId].filter(Boolean).map((s) => `#${s}`).join(" + ") || "—"}
        </div>
      </td>
      {right}
    </tr>
  );
}

export function BigHitters({ lines, bigFt = 20_000, onPickLine }: BigHittersProps) {
  const { accepted, unclear } = React.useMemo(() => {
    const acc = lines
      .filter((l) => /accepted/i.test(l.stageLabel) && l.requiredFt >= bigFt)
      .sort((a, b) => b.requiredFt - a.requiredFt);
    const unc = lines
      .filter((l) => l.qtyNeedsClarification)
      .sort((a, b) => (b.releaseSpanMonths ?? 0) - (a.releaseSpanMonths ?? 0));
    return { accepted: acc, unclear: unc };
  }, [lines, bigFt]);

  const unclearFt = unclear.reduce((a, l) => a + l.requiredFt, 0);
  // What the requirement looks like if only ONE release is needed in the horizon.
  const unclearFirstReleaseFt = unclear.reduce(
    (a, l) => a + (l.releaseSpanMonths && l.releaseSpanMonths > 0 ? l.requiredFt / l.releaseSpanMonths : l.requiredFt),
    0,
  );
  const acceptedFt = accepted.reduce((a, l) => a + l.requiredFt, 0);

  return (
    <div className="flex flex-col gap-4">
      {/* ---------------------------------------------------- accepted + large */}
      <div>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-semibold">
            Accepted and large — {accepted.length} order{accepted.length === 1 ? "" : "s"}
          </span>
          <span className={`text-xs ${mono} text-muted-foreground`}>
            {fmt(acceptedFt)} ft · ≥{fmt(bigFt)} ft each
          </span>
        </div>
        <p className="mb-1.5 text-[11px] text-muted-foreground">
          The customer has accepted these. Closest thing to committed demand before a NetSuite order exists —
          none of these should be a surprise.
        </p>
        {accepted.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            No accepted quote currently reaches {fmt(bigFt)} ft on its own.
          </p>
        ) : (
          <div className="max-h-64 overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <tbody>
                {accepted.map((l) => (
                  <Row
                    key={l.id}
                    l={l}
                    onPick={onPickLine}
                    right={
                      <td className={`w-28 px-2 py-1.5 text-right ${mono}`}>
                        <div className="font-semibold">{fmt(l.requiredFt)} ft</div>
                        <div className="text-[10px] text-muted-foreground">
                          {l.qty != null ? `${l.qty.toLocaleString()} units` : "qty —"}
                        </div>
                      </td>
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------ qty unclear */}
      <div>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-semibold">
            Quantity unclear — {unclear.length} order{unclear.length === 1 ? "" : "s"}
          </span>
          <span className={`text-xs ${mono} text-muted-foreground`}>
            {fmt(unclearFt)} ft booked vs ~{fmt(unclearFirstReleaseFt)} ft for one release
          </span>
        </div>
        <p className="mb-1.5 text-[11px] text-muted-foreground">
          Quoted quantity divided by the stated monthly release spans more than 1.5 months, so this is a blanket
          total rather than material needed now. The forecast currently counts the <em>whole</em> quantity — if
          these are monthly releases, it is overstating by the difference above.
        </p>
        {unclear.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            Nothing flagged. Either quantities match their release rate, or{" "}
            <span className={mono}>projected_monthly_demand</span> is blank — it is filled on about two thirds of
            records, so a blank is not a clean bill of health.
          </p>
        ) : (
          <div className="max-h-72 overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <tbody>
                {unclear.map((l) => {
                  const span = l.releaseSpanMonths ?? 0;
                  const severe = span >= 6;
                  return (
                    <Row
                      key={l.id}
                      l={l}
                      onPick={onPickLine}
                      right={
                        <td className="w-52 px-2 py-1.5 text-right">
                          <div className={`text-[11px] ${mono}`}>
                            <span className="font-semibold">{l.qty?.toLocaleString() ?? "—"}</span>
                            <span className="text-muted-foreground"> quoted</span>
                          </div>
                          <div className={`text-[11px] ${mono} text-muted-foreground`}>
                            {l.projectedMonthlyDemand?.toLocaleString() ?? "—"} / month
                          </div>
                          <div
                            className={`text-[10px] font-semibold ${severe ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400"}`}
                          >
                            {severe ? "⚠ " : ""}
                            spans {span.toFixed(1)} months · {fmt(l.requiredFt)} ft booked
                          </div>
                        </td>
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default BigHitters;
