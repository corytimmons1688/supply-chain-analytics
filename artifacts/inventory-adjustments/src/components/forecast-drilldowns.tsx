/**
 * Drill-downs for the quote-stage forecast.
 *
 *  PositionBar   — the stock position bar, rescaled so it is actually readable.
 *  PoInFlight    — lead time against POs in flight, for ONE stock.
 *  SpecToFeet    — "spec → feet of stock" build-up for ONE demand line.
 *
 * Why PositionBar exists: the first version scaled the bar to
 * max(onHand, SS, ROP, |projected|). When projected was large (e.g. 406k against
 * 14k on hand) the on-hand segment collapsed to a 3% sliver and the whole card
 * read as broken. Scale now excludes `projected` — the bar answers "what is in the
 * building and on the water, against the thresholds", and projected is stated as
 * its own number with an explicit comparison.
 */

import * as React from "react";
import { ArrowRight, Clock, Ruler, Truck } from "lucide-react";

const mono = "font-mono tabular-nums";
const ft = (n: number) =>
  Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`
    : Math.abs(n) >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));

const DAY = 86_400_000;
const parse = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).getTime() : null);
const fmtDate = (iso: string | null) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";

/* ------------------------------------------------------------- position bar */

export interface PositionBarProps {
  onHandFt: number;
  openPoFt: number;
  safetyStockFt: number;
  reorderPointFt: number;
  projectedFt: number;
  tone: string; // tailwind bg class for the on-hand segment
}

export function PositionBar(p: PositionBarProps) {
  // Scale to supply + thresholds ONLY. Projected is reported separately.
  const scale = Math.max(p.onHandFt + p.openPoFt, p.reorderPointFt, p.safetyStockFt, 1);
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  return (
    <div>
      <div className="relative mt-2 h-3 rounded-full bg-muted" title="on hand + open PO against safety stock and reorder point">
        <div className={`absolute inset-y-0 left-0 rounded-l-full ${p.tone}`} style={{ width: pct(p.onHandFt) }} />
        <div
          className="absolute inset-y-0 opacity-45"
          style={{
            left: pct(p.onHandFt),
            width: pct(p.openPoFt),
            backgroundImage:
              "repeating-linear-gradient(45deg, currentColor 0 3px, transparent 3px 6px)",
          }}
          title="open PO (on the water)"
        />
        {p.safetyStockFt > 0 && (
          <div className="absolute inset-y-[-3px] w-0.5 bg-rose-500" style={{ left: pct(p.safetyStockFt) }} title={`safety stock ${ft(p.safetyStockFt)} ft`} />
        )}
        {p.reorderPointFt > 0 && (
          <div className="absolute inset-y-[-3px] w-0.5 bg-amber-500" style={{ left: pct(p.reorderPointFt) }} title={`reorder point ${ft(p.reorderPointFt)} ft`} />
        )}
      </div>
    </div>
  );
}

/** One shared legend, so each card doesn't have to re-explain itself. */
export function PositionLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
      <span className="font-semibold uppercase tracking-wide">How to read a card</span>
      <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-4 rounded-sm bg-emerald-500" />on hand (in the building)</span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2 w-4 rounded-sm opacity-45" style={{ backgroundImage: "repeating-linear-gradient(45deg, currentColor 0 3px, transparent 3px 6px)" }} />
        open PO (on the water)
      </span>
      <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-0.5 bg-rose-500" />safety stock</span>
      <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-0.5 bg-amber-500" />reorder point</span>
      <span><strong className="text-foreground">projected</strong> = on hand + open PO − firm − weighted quotes</span>
      <span className="text-foreground">Click a card for its flow and PO timeline.</span>
    </div>
  );
}

/* ------------------------------------------------- lead time / POs in flight */

export interface PoRow {
  poNumber: string;
  orderedIso: string | null;
  promisedIso: string | null;
  footageFt: number;
  rolls: number;
  status: "confirmed" | "unconfirmed";
  daysOpen: number | null;
}

/**
 * One lane per PO, ordered date → promised arrival, plus a dashed lane showing
 * where an order placed TODAY would land given the measured lead time. If the
 * dashed lane ends after you need the material, ordering now is already too late.
 */
export function PoInFlight({
  pos, leadTimeDays, leadTimeSource,
}: { pos: PoRow[]; leadTimeDays: number; leadTimeSource: string }) {
  const now = Date.now();
  const todayFloor = now - (now % DAY);
  const orderTodayLands = todayFloor + Math.max(0, leadTimeDays) * DAY;

  const stamps = [
    todayFloor,
    orderTodayLands,
    ...pos.flatMap((p) => [parse(p.orderedIso), parse(p.promisedIso)].filter((n): n is number => n != null)),
  ];
  const min = Math.min(...stamps);
  const max = Math.max(...stamps);
  const span = Math.max(max - min, DAY * 14);
  const x = (t: number) => `${((t - min) / span) * 100}%`;

  if (pos.length === 0 && !(leadTimeDays > 0)) {
    return (
      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        No open POs for this stock, and no measured lead time — nothing to plot.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* ruler */}
      <div className="relative h-4 text-[10px] text-muted-foreground">
        <span className="absolute left-0">{fmtDate(new Date(min).toISOString())}</span>
        <span className="absolute -translate-x-1/2 font-semibold text-foreground" style={{ left: x(todayFloor) }}>today</span>
        <span className="absolute right-0">{fmtDate(new Date(max).toISOString())}</span>
      </div>

      {pos.map((p) => {
        const o = parse(p.orderedIso) ?? todayFloor;
        const a = parse(p.promisedIso) ?? orderTodayLands;
        const left = x(Math.min(o, a));
        const w = `${Math.max(1.5, ((Math.abs(a - o)) / span) * 100)}%`;
        return (
          <div key={p.poNumber} className="grid grid-cols-[7.5rem_1fr] items-center gap-2">
            <div className="min-w-0 text-[11px]">
              <span className={`font-semibold ${mono}`}>{p.poNumber}</span>
              <div className="text-[10px] text-muted-foreground">{ft(p.footageFt)} ft · {p.rolls} rolls</div>
            </div>
            <div className="relative h-7 rounded bg-muted/40">
              <div className="absolute inset-y-0 w-px bg-foreground/50" style={{ left: x(todayFloor) }} />
              <div
                className={`absolute top-1 flex h-5 items-center rounded-sm border text-[9px] ${
                  p.status === "unconfirmed"
                    ? "border-amber-500/60 bg-amber-500/25"
                    : "border-emerald-500/60 bg-emerald-500/25"
                }`}
                style={{ left, width: w }}
                title={`${p.poNumber}: ordered ${fmtDate(p.orderedIso)} → promised ${fmtDate(p.promisedIso)} (${p.status})`}
              >
                <span className="truncate px-1">{fmtDate(p.orderedIso)} → {fmtDate(p.promisedIso)}</span>
              </div>
            </div>
          </div>
        );
      })}

      {/* if ordered today */}
      <div className="grid grid-cols-[7.5rem_1fr] items-center gap-2">
        <div className="min-w-0 text-[11px]">
          <span className="font-semibold">If ordered today</span>
          <div className="text-[10px] text-muted-foreground">
            {leadTimeDays > 0 ? `${Math.round(leadTimeDays)}d` : "no lead time"}
          </div>
        </div>
        <div className="relative h-7 rounded bg-muted/40">
          <div className="absolute inset-y-0 w-px bg-foreground/50" style={{ left: x(todayFloor) }} />
          {leadTimeDays > 0 && (
            <div
              className="absolute top-1 h-5 rounded-sm border border-dashed border-foreground/50 bg-foreground/5"
              style={{ left: x(todayFloor), width: `${((orderTodayLands - todayFloor) / span) * 100}%` }}
              title={`An order placed today lands ${fmtDate(new Date(orderTodayLands).toISOString())}`}
            />
          )}
        </div>
      </div>

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm border border-emerald-500/60 bg-emerald-500/25" />PO with a promised date</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm border border-amber-500/60 bg-amber-500/25" />ordered, not confirmed</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm border border-dashed border-foreground/50" />lead time if ordered today</span>
        <span>lead time source: <strong className="text-foreground">{leadTimeSource.replace(/_/g, " ")}</strong></span>
      </div>
    </div>
  );
}

/* ------------------------------------------------- spec → feet of stock */

export interface PassRow {
  code: string; label: string; linearFt: number; spoilageFt: number; setupFt: number;
  totalFt: number; spoilagePct: number | null; spoilageBracketPct: number | null;
  spoilageFloored: boolean; spoilageOutOfRange: boolean; incomplete: boolean;
}
export interface SpecLine {
  itemName: string;
  kind: "LABEL" | "FLEXPACK";
  qty: number | null;
  widthIn: number | null;
  heightIn: number | null;
  copyPosition?: string | null;
  copyPositionAssumed?: boolean;
  embellishment: string | null;
  substrateStockId: number | null;
  laminateStockId: number | null;
  extraStockIds: number[];
  footage: {
    goodFt: number; requiredFt: number; drivingPass: string; passes: PassRow[];
    noAcross: number; repeatIn: number; swapped: boolean; machineCode: string;
    makeReadyFt: number; upliftVsGood: number;
  } | null;
}

function Step({ n, title, value, children }: {
  n: string; title: string; value?: string; children?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border p-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span className={`${mono} text-foreground`}>{n}</span>{title}
        </div>
        {value && <span className={`text-sm font-semibold ${mono}`}>{value}</span>}
      </div>
      {children && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</div>}
    </div>
  );
}
const Arrow = () => (
  <div className="flex justify-center py-0.5 text-muted-foreground"><ArrowRight className="h-3.5 w-3.5 rotate-90" /></div>
);

export function SpecToFeet({ line }: { line: SpecLine }) {
  const f = line.footage;
  if (!f) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No requirement can be derived for this line — it is missing quantity or dimensions.
      </div>
    );
  }
  const isLabel = line.kind === "LABEL";
  return (
    <div className="flex flex-col">
      <Step n="1" title="Spec as entered" value={`${line.widthIn}" × ${line.heightIn}"`}>
        qty <span className={mono}>{line.qty?.toLocaleString()}</span>
        {isLabel && (
          <> · <span className={mono}>copy_position = {line.copyPosition ?? "—"}</span>
            {line.copyPositionAssumed && <strong className="text-amber-600 dark:text-amber-400"> (assumed — HubSpot blank)</strong>}</>
        )}
        {line.embellishment && line.embellishment !== "None" && (
          <> · embellishment <strong className="text-foreground">{line.embellishment}</strong></>
        )}
      </Step>
      <Arrow />
      {isLabel ? (
        <Step n="2" title="Orientation" value={f.swapped ? "rotated 90°" : "as entered"}>
          {f.swapped
            ? <span className="text-amber-600 dark:text-amber-400">LEFT/RIGHT copy position — dimensions <strong>swapped</strong>, so the other edge runs down-web. Worth up to 37% of the footage.</span>
            : <>TOP/BTM copy position — dimensions used as-is.</>}
        </Step>
      ) : (
        <Step n="2" title="Pouch geometry" value="rowSpace = 0">
          Flexpack carries its down-web dimension in the pouch height, and real LT flexpack
          products have <span className={mono}>rowSpace = 0.0</span> — no label-style gap is added.
        </Step>
      )}
      <Arrow />
      <Step n="3" title="Layout" value={`${f.noAcross}-across · ${f.repeatIn.toFixed(3)}" repeat`}>
        {isLabel
          ? <>Derived from the spec and the stock&rsquo;s master width, with 0.125&quot; column/row spacing.</>
          : <>One pouch across the web; the pitch is the pouch height.</>}
      </Step>
      <Arrow />
      <Step n="4" title="Good length (sellable web)" value={`${ft(f.goodFt)} ft`}>
        <span className={mono}>ceil({line.qty?.toLocaleString()} / {f.noAcross}) × {f.repeatIn.toFixed(3)} / 12</span> — the floor,
        before any spoilage or make-ready.
      </Step>
      <Arrow />
      <div className="rounded-md border border-sky-500/40 bg-sky-500/5 p-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-400">
          <Ruler className="h-3 w-3" /><span className={mono}>5</span> Machine passes (real LT curves)
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="pb-1 font-medium">Pass</th>
                <th className="pb-1 text-right font-medium">Linear</th>
                <th className="pb-1 text-right font-medium">Spoilage</th>
                <th className="pb-1 text-right font-medium">Make-ready</th>
                <th className="pb-1 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {f.passes.map((p) => (
                <tr key={p.code} className={p.code === f.drivingPass ? "font-semibold" : undefined}>
                  <td className="py-0.5">{p.label}</td>
                  <td className={`py-0.5 text-right ${mono}`}>{Math.round(p.linearFt)}</td>
                  <td className={`py-0.5 text-right ${mono}`}>
                    {Math.round(p.spoilageFt)}
                    {p.spoilagePct != null && (
                      <span className="text-muted-foreground"> ({p.spoilagePct}%
                        {p.spoilageFloored && <span className="text-amber-600 dark:text-amber-400"> floor</span>})</span>
                    )}
                    {p.spoilagePct == null && <span className="text-rose-600 dark:text-rose-400"> curve n/a</span>}
                  </td>
                  <td className={`py-0.5 text-right ${mono}`}>
                    {Math.round(p.setupFt)}
                    {p.setupFt === 0 && <span className="text-rose-600 dark:text-rose-400"> ✗</span>}
                  </td>
                  <td className={`py-0.5 text-right ${mono}`}>{Math.round(p.totalFt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          <strong className="text-foreground">✗ = make-ready not sourced</strong> for that machine, so it
          contributes 0 ft and this total is a floor. HP make-ready is {f.makeReadyFt} ft.
        </p>
      </div>
      <Arrow />
      <Step
        n="6"
        title={isLabel ? "Requirement = max(passes)" : "Requirement = compounded"}
        value={`${ft(f.requiredFt)} ft`}
      >
        {isLabel
          ? <>One web through every station, so you buy for the hungriest pass — <strong className="text-foreground">{f.drivingPass}</strong>. Not the sum.</>
          : <>Flexpack converting steps compound, <span className={mono}>Π(1 + sᵢ)</span>, because each step spoils what the previous one already spoiled.</>}
        <div className="mt-1 text-sm font-semibold text-amber-700 dark:text-amber-400">
          +{(f.upliftVsGood * 100).toFixed(0)}% above good length
        </div>
      </Step>
      <Arrow />
      <Step n="7" title="Charged to these stocks">
        <span className={mono}>
          #{line.substrateStockId ?? "—"}
          {line.laminateStockId ? ` + #${line.laminateStockId}` : ""}
          {line.extraStockIds.length ? ` + ${line.extraStockIds.map((i) => `#${i}`).join(" + ")}` : ""}
        </span>
        <br />
        Footage is broadcast identically to every stock in the construction — film, laminate
        and zipper all run the same web length and differ only in width.
      </Step>
    </div>
  );
}

export const DrilldownIcons = { Clock, Truck };
