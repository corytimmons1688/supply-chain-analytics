import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { PoDocument } from "./po-document";

/**
 * Renders a PO into a single-page (or paginated, for long roll lists) PDF that
 * mirrors the Label Traxx stock-PO print layout — the same document the Print
 * button shows, so a vendor gets an identical paper trail either way.
 *
 * pdf-lib is used rather than a headless browser: it's pure JS, bundles into the
 * serverless function with no binary, and the layout is a fixed grid.
 */

const PAGE = { w: 612, h: 792 }; // US Letter, 72dpi
const M = 40; // page margin
const INK = rgb(0.07, 0.07, 0.07);
const MUTED = rgb(0.42, 0.42, 0.42);
const RULE = rgb(0.72, 0.72, 0.72);
const SHADE = rgb(0.94, 0.94, 0.94);
const DRAFT = rgb(0.71, 0.33, 0.04);

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

interface Ctx {
  page: PDFPage;
  reg: PDFFont;
  bold: PDFFont;
}

function text(
  ctx: Ctx,
  s: string,
  x: number,
  y: number,
  opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; maxWidth?: number } = {},
): void {
  const size = opts.size ?? 9;
  const font = opts.bold ? ctx.bold : ctx.reg;
  let value = s;
  // Standard PDF fonts are WinAnsi — anything outside it (em dash, curly quotes
  // from LT descriptions) has to be folded down or drawText throws.
  value = value
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[•]/g, "*")
    .replace(/[^\x20-\xFF]/g, "");
  if (opts.maxWidth != null) {
    const limit = opts.maxWidth;
    if (font.widthOfTextAtSize(value, size) > limit) {
      while (value.length > 1 && font.widthOfTextAtSize(`${value}..`, size) > limit) value = value.slice(0, -1);
      value = `${value}..`;
    }
  }
  ctx.page.drawText(value, { x, y, size, font, color: opts.color ?? INK });
}

function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, thickness = 0.5, color = RULE): void {
  ctx.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
}

function box(ctx: Ctx, x: number, y: number, w: number, h: number, fill?: ReturnType<typeof rgb>): void {
  ctx.page.drawRectangle({ x, y, width: w, height: h, borderColor: RULE, borderWidth: 0.5, ...(fill ? { color: fill } : {}) });
}

/** Label above value, the pattern used for the header and address blocks. */
function field(ctx: Ctx, label: string, value: string, x: number, y: number, maxWidth?: number): void {
  text(ctx, label.toUpperCase(), x, y, { size: 6, color: MUTED, bold: true });
  text(ctx, value, x, y - 10, { size: 9, ...(maxWidth ? { maxWidth } : {}) });
}

export async function renderPoPdf(d: PoDocument): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Purchase Order ${d.poNumber} — ${d.supplier.company}`);
  pdf.setAuthor("Calyx Containers");
  pdf.setSubject(`Stock #${d.material.stockId}`);
  pdf.setProducer("Calyx Supply Chain Dashboard");

  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const newPage = (): Ctx => ({ page: pdf.addPage([PAGE.w, PAGE.h]), reg, bold });

  let ctx = newPage();
  let y = PAGE.h - M;

  // --- title + header grid --------------------------------------------------
  text(ctx, "PURCHASE ORDER", M, y - 12, { size: 17, bold: true });
  text(ctx, "Calyx Containers", M, y - 26, { size: 10, color: MUTED });
  if (d.isDraft) text(ctx, "DRAFT - not yet in Label Traxx", M, y - 38, { size: 8, bold: true, color: DRAFT });

  const hx = PAGE.w - M - 250;
  const hRow = 16;
  const hdr: [string, string][] = [
    ["Order Date", d.orderedDate],
    ["P.O. Number", d.poNumber],
    ["Req. Delivery", d.requestedDeliveryDate ?? "-"],
    ["Type", d.type],
    ["Terms", d.supplier.terms ?? "-"],
    ["Stock No.", d.material.stockId],
  ];
  for (let i = 0; i < hdr.length; i += 2) {
    const top = y - (i / 2) * hRow;
    for (const [col, idx] of [
      [0, i],
      [1, i + 1],
    ] as const) {
      const cell = hdr[idx];
      if (!cell) continue;
      const x = hx + col * 125;
      box(ctx, x, top - hRow, 60, hRow, SHADE);
      box(ctx, x + 60, top - hRow, 65, hRow);
      text(ctx, cell[0].toUpperCase(), x + 3, top - hRow + 5, { size: 5.5, bold: true, color: MUTED });
      text(ctx, cell[1], x + 63, top - hRow + 5, { size: 7.5, maxWidth: 60 });
    }
  }
  y -= 3 * hRow + 18;

  // --- supplier / ship-to ---------------------------------------------------
  const blockW = (PAGE.w - 2 * M - 16) / 2;
  const blockH = 84;
  const supAddr = [
    d.supplier.address1,
    d.supplier.address2,
    [d.supplier.city, d.supplier.state, d.supplier.zip].filter(Boolean).join(", "),
    d.supplier.country,
  ].filter((v): v is string => Boolean(v));
  const contact = [d.supplier.phone ? `Ph. ${d.supplier.phone}` : null, d.supplier.fax ? `Fax ${d.supplier.fax}` : null]
    .filter(Boolean)
    .join("  ");

  box(ctx, M, y - blockH, blockW, blockH);
  text(ctx, "SUPPLIER", M + 8, y - 14, { size: 6, bold: true, color: MUTED });
  text(ctx, d.supplier.company, M + 8, y - 27, { size: 10, bold: true, maxWidth: blockW - 16 });
  let sy = y - 39;
  if (d.supplier.customerId) {
    text(ctx, `Customer ID: ${d.supplier.customerId}`, M + 8, sy, { size: 8, color: MUTED });
    sy -= 11;
  }
  for (const l of supAddr) {
    text(ctx, l, M + 8, sy, { size: 8, maxWidth: blockW - 16 });
    sy -= 11;
  }
  if (contact) text(ctx, contact, M + 8, sy, { size: 8, color: MUTED, maxWidth: blockW - 16 });

  const sx = M + blockW + 16;
  box(ctx, sx, y - blockH, blockW, blockH);
  text(ctx, "SHIP TO", sx + 8, y - 14, { size: 6, bold: true, color: MUTED });
  text(ctx, d.shipTo.name, sx + 8, y - 27, { size: 10, bold: true });
  text(ctx, d.shipTo.address1, sx + 8, y - 39, { size: 8 });
  text(ctx, `${d.shipTo.city}, ${d.shipTo.state} ${d.shipTo.zip}`, sx + 8, y - 50, { size: 8 });
  text(ctx, d.shipTo.country, sx + 8, y - 61, { size: 8 });
  text(ctx, d.shipTo.phone, sx + 8, y - 72, { size: 8, color: MUTED });
  y -= blockH + 20;

  // --- material spec --------------------------------------------------------
  const m = d.material;
  const col = (PAGE.w - 2 * M) / 3;
  const specRows: [string, string][][] = [
    [
      ["Our Stock No.", m.stockId],
      ["MFG Spec. No.", m.mfgSpecNum ?? "-"],
      ["Vendor Part No.", m.vendorPartNum ?? "-"],
    ],
    [
      ["Face Stock", m.description ?? "-"],
      ["Master Width", m.masterWidth ? `${m.masterWidth}"` : "-"],
      ["Cost Per MSI", m.costMsi ? `$${m.costMsi.toFixed(5)}` : "-"],
    ],
    [
      ["Color", m.color ?? "-"],
      ["Adhesive", m.adhesive ?? "-"],
      ["Top Coating", m.topCoat ?? "None"],
    ],
  ];
  for (const row of specRows) {
    row.forEach(([label, value], i) => field(ctx, label, value, M + i * col, y, col - 12));
    y -= 26;
  }
  y -= 2;

  // --- roll / slitting table ------------------------------------------------
  const headers: [string, number][] = [
    ["Roll", 34],
    ["Ordered (ft)", 66],
    ["Received", 50],
    ["No.", 30],
    ["1st Cut", 50],
    ["No.", 30],
    ["2nd Cut", 50],
    ["No.", 30],
    ["3rd Cut", 50],
    ["O'Cut", 40],
  ];
  const tableW = headers.reduce((s, [, w]) => s + w, 0);
  const rowH = 13;

  const drawTableHead = (): void => {
    let x = M;
    for (const [label, w] of headers) {
      box(ctx, x, y - rowH, w, rowH, SHADE);
      text(ctx, label.toUpperCase(), x + 3, y - rowH + 4, { size: 5.5, bold: true, color: MUTED, maxWidth: w - 6 });
      x += w;
    }
    y -= rowH;
  };
  drawTableHead();

  for (const r of d.rolls) {
    if (y - rowH < M + 90) {
      ctx = newPage();
      y = PAGE.h - M;
      text(ctx, `Purchase Order ${d.poNumber} (continued)`, M, y - 10, { size: 9, bold: true });
      y -= 26;
      drawTableHead();
    }
    const cells = [String(r.no), num(r.footage), "0", "1", r.width ? String(r.width) : "-", "0", "", "0", "", "0"];
    let x = M;
    cells.forEach((c, i) => {
      const w = headers[i]![1];
      box(ctx, x, y - rowH, w, rowH);
      text(ctx, c, x + 3, y - rowH + 4, { size: 7.5, maxWidth: w - 6 });
      x += w;
    });
    y -= rowH;
  }

  // --- totals ---------------------------------------------------------------
  y -= 12;
  line(ctx, M, y, M + tableW, y, 1.2, INK);
  y -= 16;
  // Weight is deliberately absent: Label Traxx's PO record carries no weight
  // field, and the figure we derived from AreaToWeightFactor came out ~7x too
  // heavy for a film roll. Better no number than a wrong one on a vendor PO.
  const totals: [string, string][] = [
    ["Master Rolls", String(d.totals.rolls)],
    ["Area (MSI)", num(d.totals.areaMsi)],
    ["Purchase Price", money(d.totals.purchasePrice)],
  ];
  let tx = M;
  for (const [label, value] of totals) {
    text(ctx, label.toUpperCase(), tx, y, { size: 6, bold: true, color: MUTED });
    text(ctx, value, tx, y - 12, { size: 11, bold: true });
    tx += 118;
  }

  text(
    ctx,
    "Cuts are in inches - Area in MSI - Generated by the Calyx Supply Chain Dashboard - ctimmons@calyxcontainers.com",
    M,
    M - 8,
    { size: 6.5, color: MUTED },
  );

  return Buffer.from(await pdf.save());
}

/** `PO-2598-Stock-6.pdf` — recognizable in a vendor's inbox and on disk. */
export function poPdfFilename(d: PoDocument): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `PO-${safe(d.poNumber)}-Stock-${safe(d.material.stockId)}.pdf`;
}
