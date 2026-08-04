/**
 * Forward footage flow — a Sankey of material footage moving through deal stages.
 *
 * Driven by two numbers per material: `enterFt` (all open footage in the pipeline)
 * and `committedFt` (weighted by stage probability). The attrition between them is
 * split into named exits so the flow conserves at every node. Shape is illustrative;
 * magnitudes are the material's own ledger totals.
 *
 * Hand-rendered SVG (no chart lib dependency). Theme-aware via a scoped style block
 * whose custom properties flip under the app's `.dark` variant. The categorical
 * palette is validated (dataviz validator, adjacent + all-pairs).
 */

import * as React from "react";

export interface ForwardFootageSankeyProps {
  title: string;
  subtitle?: string;
  enterFt: number;
  committedFt: number;
}

type NodeKey = "fb" | "ae" | "rej" | "nr" | "neg" | "lost" | "com" | "dec";

interface LaidNode {
  key: NodeKey;
  x: number;
  y: number;
  h: number;
  val: number;
  colorVar: string;
  label: string;
  sub: string;
  kind: "src" | "flow" | "exit" | "sink";
}
interface LaidLink {
  s: NodeKey;
  t: NodeKey;
  v: number;
  xs: number;
  s0: number;
  s1: number;
  xt: number;
  t0: number;
  t1: number;
}

const COLX: Record<number, number> = { 0: 150, 1: 404, 2: 652, 3: 852 };
const NW = 12;
const TP = 34;
const GAP = 15;

const fmtFt = (v: number) =>
  v >= 1_000_000
    ? `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`
    : v >= 1000
      ? `${Math.round(v / 1000)}k`
      : `${Math.round(v)}`;

function ribbonPath(xs: number, s0: number, s1: number, xt: number, t0: number, t1: number) {
  const cx = (xs + xt) / 2;
  return `M${xs},${s0} C${cx},${s0} ${cx},${t0} ${xt},${t0} L${xt},${t1} C${cx},${t1} ${cx},${s1} ${xs},${s1} Z`;
}

export function ForwardFootageSankey({ title, subtitle, enterFt, committedFt }: ForwardFootageSankeyProps) {
  const { nodes, links, vbH } = React.useMemo(() => {
    const E = Math.max(enterFt, 1);
    const C = Math.max(0, Math.min(committedFt, E * 0.92));
    const X = E - C;
    // exits sum to X; advancing chain derived so every node conserves
    const dec = X * 0.16;
    const lost = X * 0.3;
    const rej = X * 0.35;
    const nr = X * 0.19;
    const neg = C + dec;
    const ae = neg + lost;

    const vals: Record<NodeKey, number> = { fb: E, ae, rej, nr, neg, lost, com: C, dec };
    const meta: Record<NodeKey, { col: number; color: string; label: string; sub: string; kind: LaidNode["kind"] }> = {
      fb: { col: 0, color: "var(--fs-adv0)", label: "Forward book", sub: "all open estimates", kind: "src" },
      ae: { col: 1, color: "var(--fs-adv1)", label: "Active estimating", sub: "quoting · confirm", kind: "flow" },
      rej: { col: 1, color: "var(--fs-rej)", label: "Rejected quote", sub: "customer passed", kind: "exit" },
      nr: { col: 1, color: "var(--fs-nr)", label: "No response / stale", sub: "aged out", kind: "exit" },
      neg: { col: 2, color: "var(--fs-adv2)", label: "Negotiation", sub: "reorder pending", kind: "flow" },
      lost: { col: 2, color: "var(--fs-lost)", label: "Lost / dropped", sub: "no fit · walked", kind: "exit" },
      com: { col: 3, color: "var(--fs-com)", label: "Committed", sub: "buy this material", kind: "sink" },
      dec: { col: 3, color: "var(--fs-dec)", label: "Declined late", sub: "lost after offer", kind: "exit" },
    };
    const order: Record<number, NodeKey[]> = { 0: ["fb"], 1: ["ae", "rej", "nr"], 2: ["neg", "lost"], 3: ["com", "dec"] };

    // scale so the tallest column fits ~340px
    const colHeight = (ks: NodeKey[]) => ks.reduce((a, k) => a + vals[k], 0);
    const tallest = Math.max(...Object.values(order).map(colHeight));
    const PXF = 336 / tallest;

    const nodes: Record<NodeKey, LaidNode> = {} as Record<NodeKey, LaidNode>;
    let maxBottom = 0;
    for (const c of Object.keys(order)) {
      let y = TP;
      for (const k of order[+c]!) {
        const h = vals[k] * PXF;
        nodes[k] = { key: k, x: COLX[+c]!, y, h, val: vals[k], colorVar: meta[k].color, label: meta[k].label, sub: meta[k].sub, kind: meta[k].kind };
        y += h + GAP;
        maxBottom = Math.max(maxBottom, y);
      }
    }

    const LINKDEF: [NodeKey, NodeKey, number][] = [
      ["fb", "ae", ae], ["fb", "rej", rej], ["fb", "nr", nr],
      ["ae", "neg", neg], ["ae", "lost", lost],
      ["neg", "com", C], ["neg", "dec", dec],
    ];
    const oc: Record<string, number> = {};
    const ic: Record<string, number> = {};
    for (const k in nodes) { oc[k] = nodes[k as NodeKey].y; ic[k] = nodes[k as NodeKey].y; }
    const links: LaidLink[] = LINKDEF.map(([s, t, v]) => {
      const th = v * PXF;
      const s0 = oc[s]!, s1 = s0 + th; oc[s] = s1;
      const t0 = ic[t]!, t1 = t0 + th; ic[t] = t1;
      return { s, t, v, xs: nodes[s].x + NW, s0, s1, xt: nodes[t].x, t0, t1 };
    });

    return { nodes, links, vbH: maxBottom + 26 };
  }, [enterFt, committedFt]);

  const pct = Math.round((committedFt / Math.max(enterFt, 1)) * 100);
  const nodeArr = Object.values(nodes);

  const bigText = (x: number, y: number, s: string, anchor: "start" | "end", fill = "hsl(var(--foreground))") =>
    <text x={x} y={y} textAnchor={anchor} fontSize={19} fontWeight={680} fill={fill} style={{ letterSpacing: "-0.5px" }}>{s}</text>;
  const smText = (x: number, y: number, s: string, anchor: "start" | "end", muted = false, weight = 400) =>
    <text x={x} y={y} textAnchor={anchor} fontSize={11.5} fontWeight={weight} fill={muted ? "hsl(var(--muted-foreground))" : "hsl(var(--foreground))"}>{s}</text>;

  const legend: [string, string][] = [
    ["var(--fs-adv1)", "Advancing"], ["var(--fs-com)", "Committed → buy"], ["var(--fs-rej)", "Rejected"],
    ["var(--fs-lost)", "Lost / dropped"], ["var(--fs-dec)", "Declined"], ["var(--fs-nr)", "No response"],
  ];

  return (
    <div className="fwd-sankey">
      <style>{`
        .fwd-sankey{--fs-adv0:#5598e7;--fs-adv1:#2a78d6;--fs-adv2:#1c5cab;--fs-com:#0ca30c;
          --fs-rej:#e34948;--fs-nr:#8a8a83;--fs-lost:#eb6834;--fs-dec:#4a3aa7;}
        .dark .fwd-sankey{--fs-adv0:#6da7ec;--fs-adv1:#3987e5;--fs-adv2:#256abf;--fs-com:#0ca30c;
          --fs-rej:#e66767;--fs-nr:#9a9a92;--fs-lost:#d95926;--fs-dec:#9085e9;}
        .fwd-sankey .rib{fill-opacity:.42;transition:fill-opacity .12s;}
        .fwd-sankey .rib:hover{fill-opacity:.62;}
      `}</style>

      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">{title}</div>
          {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="font-mono font-semibold text-foreground">{fmtFt(enterFt)} ft</span> in ·{" "}
          <span className="font-mono font-semibold" style={{ color: "var(--fs-com)" }}>{fmtFt(committedFt)} ft</span>{" "}
          committed <span className="font-mono">({pct}%)</span>
        </div>
      </div>

      <svg viewBox={`0 0 1040 ${vbH}`} width="100%" role="img"
        aria-label={`Footage flow for ${title}: ${fmtFt(enterFt)} feet entering, ${fmtFt(committedFt)} committed`}>
        {links.map((l, i) => (
          <path key={i} className="rib" d={ribbonPath(l.xs, l.s0, l.s1, l.xt, l.t0, l.t1)} fill={nodes[l.t].colorVar}>
            <title>{`${nodes[l.s].label} → ${nodes[l.t].label}: ${fmtFt(l.v)} ft (${Math.round((l.v / nodes[l.s].val) * 100)}% of ${nodes[l.s].label})`}</title>
          </path>
        ))}
        {nodeArr.map((n) => (
          <rect key={n.key} x={n.x} y={n.y} width={NW} height={n.h} rx={2.5} fill={n.colorVar}>
            <title>{`${n.label}: ${fmtFt(n.val)} ft`}</title>
          </rect>
        ))}

        {/* forward book — left */}
        {(() => { const n = nodes.fb, cy = n.y + n.h / 2; return (
          <g key="lbl-fb">
            {bigText(n.x - 12, cy - 1, fmtFt(n.val), "end")}
            {smText(n.x - 12, cy + 15, "Forward book", "end", false, 600)}
            {smText(n.x - 12, cy + 30, "all open estimates", "end", true)}
          </g>
        ); })()}

        {/* advancing panels ae, neg */}
        {(["ae", "neg"] as NodeKey[]).map((k) => {
          const n = nodes[k], px = n.x + NW + 11, py = n.y + 2;
          return (
            <g key={`lbl-${k}`}>
              <rect x={px - 8} y={py - 4} width={148} height={54} rx={9}
                fill="hsl(var(--card))" fillOpacity={0.82} stroke="hsl(var(--border))" />
              {bigText(px, py + 15, fmtFt(n.val), "start")}
              {smText(px, py + 31, n.label, "start", false, 600)}
              {smText(px, py + 45, n.sub, "start", true)}
            </g>
          );
        })}

        {/* committed — right */}
        {(() => { const n = nodes.com, lx = n.x + NW + 12; return (
          <g key="lbl-com">
            {bigText(lx, n.y + 15, fmtFt(n.val), "start", "var(--fs-com)")}
            {smText(lx, n.y + 31, "Committed — buy", "start", false, 700)}
            {smText(lx, n.y + 45, "sales order in NS", "start", true)}
          </g>
        ); })()}

        {/* exits */}
        {(["rej", "nr", "lost", "dec"] as NodeKey[]).map((k) => {
          const n = nodes[k], cy = n.y + n.h / 2, lx = n.x + NW + 12;
          return (
            <g key={`lbl-${k}`}>
              {bigText(lx, cy - 1, fmtFt(n.val), "start", n.colorVar)}
              {smText(lx, cy + 15, n.label, "start", false, 600)}
              {smText(lx, cy + 29, n.sub, "start", true)}
            </g>
          );
        })}
      </svg>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {legend.map(([c, t]) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ background: c }} />{t}
          </span>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Ribbon width is feet of roll stock. Magnitudes are this material&rsquo;s ledger totals; the
        attrition shape between stages is illustrative. Read-only — HubSpot is never written.
      </p>
    </div>
  );
}

export default ForwardFootageSankey;
