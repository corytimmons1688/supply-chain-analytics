/**
 * Footage flow — where forward material footage SITS by deal stage, and where
 * it is going.
 *
 * Honest about the data: HubSpot gives a SNAPSHOT (each estimate is in exactly
 * one stage), not a transition log. So this is not a stage→stage transition
 * Sankey — it is
 *
 *     Forward book  →  Deal stage (where the footage sits)  →  Disposition
 *
 * which is what the question "how heavy is it across stages, and where is it
 * going" actually asks. Ribbon width is feet of roll stock throughout.
 *
 * Two things the earlier version got wrong and this fixes:
 *  1. NO TEXT OVERLAP — labels are laid out in reserved gutters and run through
 *     a collision pass (`resolveLabelPositions`) that pushes them apart to a
 *     minimum gap instead of letting them stack on top of each other.
 *  2. STAGE SECTIONS ARE OUTLINED — each stage is a titled, outlined section so
 *     the columns read as discrete pipeline stages rather than loose bars.
 */

import * as React from "react";

export interface SankeyStage {
  stageId: string;
  label: string;
  /** OPEN · WON · LOST — drives the colour family. */
  outcome: string;
  probability: number;
  rawFt: number;
  weightedFt: number;
  lineCount: number;
}

export interface FootageFlowSankeyProps {
  stages: SankeyStage[];
  title?: string;
  subtitle?: string;
}

const VB_W = 1120;
const NODE_W = 13;
const COL_BOOK = 128;
const COL_STAGE = 468;
const COL_DISP = 890;
const TOP = 52;
const MIN_LABEL_GAP = 46;
const PLOT_H = 400;

const fmt = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v));

/**
 * Push desired label centres apart until every neighbour is at least `gap`
 * apart, then clamp back inside the band. Single forward pass + backward pass —
 * enough for a monotonically ordered column, and it never reorders labels.
 */
function resolveLabelPositions(desired: number[], gap: number, lo: number, hi: number): number[] {
  const y = [...desired];
  for (let i = 1; i < y.length; i++) if (y[i]! - y[i - 1]! < gap) y[i] = y[i - 1]! + gap;
  const overflow = y.length ? y[y.length - 1]! - hi : 0;
  if (overflow > 0) for (let i = 0; i < y.length; i++) y[i] = y[i]! - overflow;
  for (let i = y.length - 2; i >= 0; i--) if (y[i + 1]! - y[i]! < gap) y[i] = y[i + 1]! - gap;
  return y.map((v) => Math.max(lo, Math.min(hi, v)));
}

function ribbon(xs: number, s0: number, s1: number, xt: number, t0: number, t1: number) {
  const cx = (xs + xt) / 2;
  return `M${xs},${s0} C${cx},${s0} ${cx},${t0} ${xt},${t0} L${xt},${t1} C${cx},${t1} ${cx},${s1} ${xs},${s1} Z`;
}

/** Colour token per outcome. Semantic, not decorative. */
function colourFor(outcome: string, i: number): string {
  if (outcome === "WON") return "var(--ffs-won)";
  if (outcome === "LOST") return "var(--ffs-lost)";
  return i === 0 ? "var(--ffs-open-1)" : "var(--ffs-open-2)";
}

export function FootageFlowSankey({ stages, title, subtitle }: FootageFlowSankeyProps) {
  const model = React.useMemo(() => {
    const withFt = stages.filter((s) => s.rawFt > 0);
    const totalRaw = withFt.reduce((a, s) => a + s.rawFt, 0) || 1;
    const totalWtd = withFt.reduce((a, s) => a + s.weightedFt, 0);
    const gap = 18;
    const usable = PLOT_H - gap * Math.max(0, withFt.length - 1);
    const pxf = usable / totalRaw;

    let y = TOP;
    const nodes = withFt.map((s, i) => {
      const h = Math.max(3, s.rawFt * pxf);
      const node = { ...s, y, h, colour: colourFor(s.outcome, i), idx: i };
      y += h + gap;
      return node;
    });
    const bookH = totalRaw * pxf + gap * Math.max(0, withFt.length - 1);
    // disposition: committed (weighted) vs not expected (raw − weighted)
    const dispH = { committed: totalWtd * pxf, notExpected: (totalRaw - totalWtd) * pxf };
    return { nodes, totalRaw, totalWtd, pxf, bookH, dispH, gap };
  }, [stages]);

  const { nodes, totalRaw, totalWtd, bookH, dispH } = model;
  const bookY = TOP;
  const vbH = Math.max(TOP + bookH, TOP + PLOT_H) + 42;

  // ribbons: book → stage
  let bookCursor = bookY;
  const inbound = nodes.map((n) => {
    const s0 = bookCursor;
    const s1 = bookCursor + n.h;
    bookCursor = s1;
    return { n, s0, s1 };
  });

  // ribbons: stage → disposition
  let commCursor = bookY;
  let neCursor = bookY + dispH.committed;
  const outbound = nodes.map((n) => {
    const commFt = n.weightedFt;
    const neFt = n.rawFt - n.weightedFt;
    const commH = commFt * model.pxf;
    const neH = neFt * model.pxf;
    const c = { t0: commCursor, t1: commCursor + commH };
    const e = { t0: neCursor, t1: neCursor + neH };
    commCursor = c.t1;
    neCursor = e.t1;
    return { n, comm: c, ne: e, commH, neH };
  });

  // label gutters, collision-resolved
  const stageLabelY = resolveLabelPositions(
    nodes.map((n) => n.y + n.h / 2),
    MIN_LABEL_GAP,
    TOP + 16,
    TOP + PLOT_H + 10,
  );

  return (
    <div className="ffs">
      <style>{`
        .ffs{--ffs-open-1:#5598e7;--ffs-open-2:#2a78d6;--ffs-won:#0ca30c;--ffs-lost:#e34948;
             --ffs-ne:#8a8a83;--ffs-sec:rgba(11,11,11,.14);}
        .dark .ffs{--ffs-open-1:#6da7ec;--ffs-open-2:#3987e5;--ffs-won:#0ca30c;--ffs-lost:#e66767;
             --ffs-ne:#9a9a92;--ffs-sec:rgba(255,255,255,.18);}
        .ffs .rb{fill-opacity:.38;transition:fill-opacity .12s;}
        .ffs .rb:hover{fill-opacity:.6;}
      `}</style>

      {(title || subtitle) && (
        <div className="mb-2">
          {title && <div className="text-sm font-semibold">{title}</div>}
          {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        </div>
      )}

      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${VB_W} ${vbH}`} width="100%" style={{ minWidth: 720 }} role="img"
          aria-label={`Footage by deal stage: ${fmt(totalRaw)} feet in the forward book, ${fmt(totalWtd)} feet expected to convert`}>

          {/* column headers */}
          <text x={COL_BOOK + NODE_W / 2} y={22} textAnchor="middle" fontSize={10.5} fontWeight={700}
            letterSpacing="1.1" fill="hsl(var(--muted-foreground))">FORWARD BOOK</text>
          <text x={COL_STAGE + 78} y={22} textAnchor="middle" fontSize={10.5} fontWeight={700}
            letterSpacing="1.1" fill="hsl(var(--muted-foreground))">DEAL STAGE</text>
          <text x={COL_DISP + 60} y={22} textAnchor="middle" fontSize={10.5} fontWeight={700}
            letterSpacing="1.1" fill="hsl(var(--muted-foreground))">DISPOSITION</text>
          <line x1={40} y1={31} x2={VB_W - 40} y2={31} stroke="hsl(var(--border))" strokeWidth={1} />

          {/* inbound ribbons */}
          {inbound.map(({ n, s0, s1 }) => (
            <path key={`in-${n.stageId}`} className="rb" fill={n.colour}
              d={ribbon(COL_BOOK + NODE_W, s0, s1, COL_STAGE, n.y, n.y + n.h)}>
              <title>{`${fmt(n.rawFt)} ft sits in ${n.label} (${n.lineCount} estimates)`}</title>
            </path>
          ))}

          {/* outbound ribbons */}
          {outbound.map(({ n, comm, ne, commH, neH }) => (
            <React.Fragment key={`out-${n.stageId}`}>
              {commH > 0.4 && (
                <path className="rb" fill="var(--ffs-won)"
                  d={ribbon(COL_STAGE + NODE_W, n.y, n.y + commH, COL_DISP, comm.t0, comm.t1)}>
                  <title>{`${n.label} → expected to convert: ${fmt(n.weightedFt)} ft (p=${n.probability})`}</title>
                </path>
              )}
              {neH > 0.4 && (
                <path className="rb" fill="var(--ffs-ne)"
                  d={ribbon(COL_STAGE + NODE_W, n.y + commH, n.y + n.h, COL_DISP, ne.t0, ne.t1)}>
                  <title>{`${n.label} → not expected: ${fmt(n.rawFt - n.weightedFt)} ft`}</title>
                </path>
              )}
            </React.Fragment>
          ))}

          {/* forward-book node + label */}
          <rect x={COL_BOOK} y={bookY} width={NODE_W} height={bookH} rx={3} fill="var(--ffs-open-1)" />
          <text x={COL_BOOK - 12} y={bookY + bookH / 2 - 3} textAnchor="end" fontSize={19} fontWeight={700}
            fill="hsl(var(--foreground))" style={{ letterSpacing: "-0.4px" }}>{fmt(totalRaw)}</text>
          <text x={COL_BOOK - 12} y={bookY + bookH / 2 + 13} textAnchor="end" fontSize={11}
            fill="hsl(var(--muted-foreground))">ft · internal, open</text>

          {/* stage nodes + OUTLINED SECTIONS (collision-resolved labels) */}
          {nodes.map((n, i) => {
            const ly = stageLabelY[i]!;
            const boxTop = ly - 19;
            return (
              <g key={`st-${n.stageId}`}>
                <rect x={COL_STAGE} y={n.y} width={NODE_W} height={n.h} rx={3} fill={n.colour} />
                {/* connector from bar to its section, so pushed-apart labels stay attributable */}
                <path d={`M${COL_STAGE + NODE_W + 2},${n.y + n.h / 2} L${COL_STAGE + 24},${ly}`}
                  stroke="hsl(var(--border))" strokeWidth={1} fill="none" />
                {/* the outlined stage section */}
                <rect x={COL_STAGE + 24} y={boxTop} width={196} height={38} rx={7}
                  fill="hsl(var(--card))" stroke="var(--ffs-sec)" strokeWidth={1} />
                <rect x={COL_STAGE + 24} y={boxTop} width={3.5} height={38} rx={1.75} fill={n.colour} />
                <text x={COL_STAGE + 34} y={boxTop + 16} fontSize={12} fontWeight={650}
                  fill="hsl(var(--foreground))">{n.label}</text>
                <text x={COL_STAGE + 34} y={boxTop + 30} fontSize={10.5}
                  fill="hsl(var(--muted-foreground))">
                  {fmt(n.rawFt)} ft · {n.lineCount} est · p={n.probability}
                </text>
              </g>
            );
          })}

          {/* disposition nodes */}
          {dispH.committed > 0.4 && (
            <>
              <rect x={COL_DISP} y={bookY} width={NODE_W} height={dispH.committed} rx={3} fill="var(--ffs-won)" />
              <text x={COL_DISP + NODE_W + 12} y={bookY + Math.min(dispH.committed / 2, 24) + 2}
                fontSize={17} fontWeight={700} fill="var(--ffs-won)">{fmt(totalWtd)}</text>
              <text x={COL_DISP + NODE_W + 12} y={bookY + Math.min(dispH.committed / 2, 24) + 17}
                fontSize={11} fontWeight={600} fill="hsl(var(--foreground))">Expected to convert</text>
              <text x={COL_DISP + NODE_W + 12} y={bookY + Math.min(dispH.committed / 2, 24) + 31}
                fontSize={10.5} fill="hsl(var(--muted-foreground))">buy against this</text>
            </>
          )}
          {dispH.notExpected > 0.4 && (
            <>
              <rect x={COL_DISP} y={bookY + dispH.committed} width={NODE_W} height={dispH.notExpected} rx={3}
                fill="var(--ffs-ne)" />
              <text x={COL_DISP + NODE_W + 12} y={bookY + dispH.committed + Math.min(dispH.notExpected / 2, 30)}
                fontSize={17} fontWeight={700} fill="hsl(var(--muted-foreground))">
                {fmt(totalRaw - totalWtd)}
              </text>
              <text x={COL_DISP + NODE_W + 12} y={bookY + dispH.committed + Math.min(dispH.notExpected / 2, 30) + 15}
                fontSize={11} fontWeight={600} fill="hsl(var(--foreground))">Not expected</text>
              <text x={COL_DISP + NODE_W + 12} y={bookY + dispH.committed + Math.min(dispH.notExpected / 2, 30) + 29}
                fontSize={10.5} fill="hsl(var(--muted-foreground))">rejected + risk-adjusted</text>
            </>
          )}
        </svg>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {[["var(--ffs-open-2)", "Open (In Progress / Quote Completed)"],
          ["var(--ffs-won)", "Accepted → expected to convert"],
          ["var(--ffs-lost)", "Rejected (contributes 0)"],
          ["var(--ffs-ne)", "Not expected"]].map(([c, t]) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ background: c }} />{t}
          </span>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Ribbon width is feet of roll stock (good length + LT spoilage). HubSpot is a snapshot, so this
        shows where footage <em>sits</em> by stage — not stage-to-stage transitions. Internal jobs only.
      </p>
    </div>
  );
}

export default FootageFlowSankey;
