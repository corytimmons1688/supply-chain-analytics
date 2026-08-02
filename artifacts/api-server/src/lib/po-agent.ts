import { db, materialPoTable, materialPoLineTable, vendorContactTable, ltPoTable, poEmailEventTable, poAgentDraftTable, poAttachmentTable, agentLessonTable } from "@workspace/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  gmailConfigured,
  gmailConnection,
  scopeSupportsRead,
  fetchThreadMessages,
  fetchMessage,
  searchMessageIds,
  fetchAttachment,
  attachmentParts,
  bodyText,
  header,
  type GmailMessage,
} from "./gmail";
import { logger } from "./logger";

/**
 * PO follow-up agent, phase 1 (draft mode).
 *
 * A cron-driven state machine over emailed POs: watches the Gmail thread of
 * each send AND searches the mailbox for out-of-thread vendor messages citing
 * the PO number (many vendors' ERPs mail acknowledgements from a noreply
 * address that never joins our thread). New inbound mail is classified with
 * the Claude API; acknowledgements flip state and capture the promised date +
 * attached documents; anything odd flags the PO for a human.
 *
 * OUTBOUND IS DRAFT-ONLY: the agent never sends email. It inserts rows into
 * po_agent_draft; Cory reviews (and can edit) each one in the dashboard.
 */

const ACK_NUDGE_AFTER_BUSINESS_DAYS = 2;
const MAX_ACK_NUDGES = 2;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const BODY_PREVIEW_CHARS = 1200;
// PDFs handed to the classifier (order acknowledgements are structured PDFs —
// the promised date/quantity often exist ONLY there, not in the email body).
const MAX_CLASSIFY_PDFS = 3;
const MAX_CLASSIFY_PDF_BYTES = 4 * 1024 * 1024;
const ACTIVE_STATES = ["awaiting_ack", "acknowledged", "shipped"] as const;

function businessDaysBetween(from: Date, to: Date): number {
  let days = 0;
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

/** Vendor mail domains from the contact record — never our own. */
function vendorDomains(toEmails: string | null, ccEmails: string | null): string[] {
  const all = `${toEmails ?? ""},${ccEmails ?? ""}`
    .split(/[,;\s]+/)
    .map((e) => e.split("@")[1]?.toLowerCase().trim())
    .filter((d): d is string => Boolean(d) && d !== "calyxcontainers.com");
  return [...new Set(all)];
}

/** The number a vendor would quote back: the LT PO number, else the DRAFT marker on the PDF. */
function poReference(po: { ltPoNumbers: string | null; id: string }): string {
  const lt = (po.ltPoNumbers ?? "").split(",").map((n) => n.trim()).filter(Boolean)[0];
  return lt ?? `DRAFT-${po.id.slice(0, 6).toUpperCase()}`;
}

// --- classification -----------------------------------------------------------

export interface Classification {
  kind: "ack" | "ship_notice" | "delay" | "question" | "ooo_or_auto" | "other";
  promisedDate: string | null;
  tracking: { carrier: string; number: string }[];
  confirmedQuantity: string | null;
  /** Vendor's own order / sales-order number from the ACK (e.g. "22414417"). */
  vendorOrderNumber: string | null;
  /** Differences between the acknowledgement and our PO — quantity, width, price, dates. */
  discrepancies: string | null;
  summary: string;
  needsHuman: boolean;
  needsHumanReason: string | null;
}

type ClassifyResult = { ok: true; c: Classification } | { ok: false; reason: string };

const CLASSIFY_TOOL = {
  name: "record_classification",
  description: "Record the classification of a vendor email about a purchase order.",
  input_schema: {
    type: "object",
    required: ["kind", "summary", "needs_human"],
    properties: {
      kind: {
        type: "string",
        enum: ["ack", "ship_notice", "delay", "question", "ooo_or_auto", "other"],
        description:
          "ack = order confirmed/acknowledged; ship_notice = shipped or tracking provided; delay = date pushed out; question = vendor needs an answer from us; ooo_or_auto = out-of-office or generic auto-reply",
      },
      promised_date: {
        type: ["string", "null"],
        description:
          "Vendor-committed ship or delivery date, YYYY-MM-DD — from the email body OR an attached acknowledgement document. Prefer a delivery/arrival date over a ship date when both are given.",
      },
      tracking: {
        type: "array",
        items: {
          type: "object",
          required: ["carrier", "number"],
          properties: { carrier: { type: "string" }, number: { type: "string" } },
        },
      },
      confirmed_quantity: { type: ["string", "null"], description: "Quantity the vendor confirmed, verbatim (check attached documents)" },
      vendor_order_number: {
        type: ["string", "null"],
        description: "The vendor's own order / sales-order / confirmation number, e.g. '22414417'",
      },
      discrepancies: {
        type: ["string", "null"],
        description:
          "Differences between the acknowledgement and our PO — quantity, width, price, or a promised date later than our requested delivery. Null when everything matches.",
      },
      summary: { type: "string", description: "One factual sentence for the PO timeline, including key figures from attached documents" },
      needs_human: { type: "boolean", description: "True if a buyer should look at this message" },
      needs_human_reason: { type: ["string", "null"] },
    },
  },
} as const;

/**
 * Classify one vendor email with the Claude API. Failures return the actual
 * reason so the dashboard can show WHY a message wasn't classified — an
 * earlier version collapsed every failure into "not configured", which sent
 * the buyer hunting for a missing key when the real problem was a 400.
 */
export async function classifyVendorEmail(input: {
  vendorName: string;
  poRef: string;
  stockLine: string;
  requestedDelivery: string | null;
  agentState: string;
  from: string;
  subject: string;
  date: string;
  body: string;
  attachmentNames: string[];
  /** PDF attachments (base64) passed to the model as documents — order
   * acknowledgements usually carry the real dates/quantities here. */
  pdfs?: { filename: string; data: string }[];
  /** Buyer-approved vendor conventions ("their system rounds width to one
   * decimal") — known quirks that must NOT be reported as discrepancies. */
  buyerNotes?: string[];
}): Promise<ClassifyResult> {
  const apiKey = process.env["ANTHROPIC_API_KEY"]?.trim();
  if (!apiKey) return { ok: false, reason: "ANTHROPIC_API_KEY is not set on this deployment" };
  try {
    const pdfs = input.pdfs ?? [];
    const content: unknown[] = [
      // Documents go before the text block (per API guidance).
      ...pdfs.map((p) => ({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: p.data },
        title: p.filename,
      })),
      {
        type: "text",
        text:
          `Purchase order context:\n` +
          `- PO reference: ${input.poRef}\n` +
          `- Vendor: ${input.vendorName}\n` +
          `- Material: ${input.stockLine}\n` +
          `- Requested delivery: ${input.requestedDelivery ?? "unspecified"}\n` +
          `- Current tracking state: ${input.agentState}\n` +
          (input.buyerNotes?.length
            ? `\nBuyer-approved conventions for this vendor — treat these as normal, do NOT report them as discrepancies and do NOT flag them for review:\n${input.buyerNotes
                .map((n) => `- ${n}`)
                .join("\n")}\n`
            : "") +
          `\n` +
          `Email received:\n` +
          `From: ${input.from}\nDate: ${input.date}\nSubject: ${input.subject}\n` +
          `Attachments: ${input.attachmentNames.join(", ") || "(none)"}` +
          (pdfs.length
            ? `\n(The PDF attachment${pdfs.length === 1 ? "" : "s"} ${pdfs.map((p) => p.filename).join(", ")} ${
                pdfs.length === 1 ? "is" : "are"
              } provided above — read ${pdfs.length === 1 ? "it" : "them"} for order details.)`
            : "") +
          `\n\n${input.body.slice(0, 5000)}`,
      },
    ];
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      // No sampling params: Claude 5 models reject non-default temperature/
      // top_p/top_k with a 400. Classification is a simple task → low effort.
      // Sonnet 5 per Cory (2026-07-28) to cut API spend — ~40-60% cheaper than
      // Opus 5 and fully capable for schema-forced email classification.
      // ANTHROPIC_MODEL env overrides without a code change.
      body: JSON.stringify({
        model: process.env["ANTHROPIC_MODEL"]?.trim() || "claude-sonnet-5",
        max_tokens: 2000,
        output_config: { effort: "low" },
        system:
          "You classify emails from label-stock vendors about purchase orders for Calyx Containers' buyer. " +
          "Be literal: only call something an acknowledgement if the vendor confirms the order or provides an order/sales-order confirmation. " +
          "When an order acknowledgement PDF is attached, extract the promised/estimated delivery date, confirmed quantity, and the vendor's order number from it, and compare quantity, width, price, and dates against our PO context — report real differences in `discrepancies`. " +
          "Dates must come from the email or its documents, never invented. Treat marketing mail and unrelated threads as 'other'.",
        messages: [{ role: "user", content }],
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: "tool", name: "record_classification" },
      }),
    });
    const json = (await res.json()) as {
      content?: { type: string; input?: Record<string, unknown> }[];
      stop_reason?: string;
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    const call = json.content?.find((c) => c.type === "tool_use");
    if (!call) throw new Error(`no tool_use in response (stop_reason=${json.stop_reason ?? "?"})`);
    const i = (call.input ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      c: {
        kind: (i["kind"] as Classification["kind"]) ?? "other",
        promisedDate: typeof i["promised_date"] === "string" ? i["promised_date"] : null,
        tracking: Array.isArray(i["tracking"])
          ? (i["tracking"] as { carrier?: string; number?: string }[])
              .filter((t) => t?.number)
              .map((t) => ({ carrier: String(t.carrier ?? ""), number: String(t.number) }))
          : [],
        confirmedQuantity: typeof i["confirmed_quantity"] === "string" ? i["confirmed_quantity"] : null,
        vendorOrderNumber: typeof i["vendor_order_number"] === "string" ? i["vendor_order_number"] : null,
        discrepancies: typeof i["discrepancies"] === "string" && i["discrepancies"].trim() ? i["discrepancies"] : null,
        summary: String(i["summary"] ?? "Vendor email received"),
        needsHuman: Boolean(i["needs_human"]),
        needsHumanReason: typeof i["needs_human_reason"] === "string" ? i["needs_human_reason"] : null,
      },
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    logger.warn({ err: reason }, "Email classification failed");
    return { ok: false, reason };
  }
}

// --- the watcher ---------------------------------------------------------------

export interface AgentRunResult {
  posChecked: number;
  inboundProcessed: number;
  reclassified: number;
  acksDetected: number;
  draftsCreated: number;
  closed: number;
  flagged: number;
  /** LT-created POs adopted into tracking this run. */
  adopted?: number;
  skipped?: string;
}

/** Don't adopt LT POs older than this — their email trail is stale history. */
const ADOPT_MAX_AGE_DAYS = 60;

/**
 * POs typed directly into Label Traxx (or emailed outside the dashboard) have
 * no material_po row, so the watcher never saw them — e.g. PO 2595, whose
 * proforma with a promised date sat unread in the mailbox. For agent-enabled
 * vendors, create a tracking record for every open LT stock PO we don't
 * already track. emailedAt is set to the LT PO date: it's the tracking start
 * for the vendor-domain mail search, not a claim that the dashboard sent it
 * (emailedTo stays null — the UI distinguishes on that).
 */
async function adoptLtPos(vendorByName: Map<string, { toEmails: string | null }>): Promise<number> {
  const tracked = new Set<string>();
  for (const po of await db.select({ lt: materialPoTable.ltPoNumbers }).from(materialPoTable)) {
    for (const n of (po.lt ?? "").split(",").map((s) => s.trim()).filter(Boolean)) tracked.add(n);
  }
  const cutoff = new Date(Date.now() - ADOPT_MAX_AGE_DAYS * 864e5).toISOString().slice(0, 10);
  const ltPos = await db.select().from(ltPoTable).where(and(eq(ltPoTable.poType, "Stock"), eq(ltPoTable.closed, false)));
  let adopted = 0;
  for (const lt of ltPos) {
    if (lt.receivedDate) continue;
    if (!lt.poDate || lt.poDate < cutoff) continue;
    if (tracked.has(lt.poNumber)) continue;
    const vendor = lt.supplierName ? vendorByName.get(lt.supplierName) : undefined;
    if (!vendor) continue;
    const [row] = await db
      .insert(materialPoTable)
      .values({
        vendorName: lt.supplierName!,
        vendorEmails: vendor.toEmails,
        status: "submitted_lt",
        ltPoNumbers: lt.poNumber,
        requestedDeliveryDate: lt.requestedDeliveryDate,
        emailedAt: new Date(`${lt.poDate}T12:00:00Z`),
      })
      .returning({ id: materialPoTable.id });
    if (!row) continue;
    const footage =
      lt.orderedMsi && lt.masterWidth && lt.masterWidth > 0 ? (lt.orderedMsi * 1000) / (12 * lt.masterWidth) : null;
    await db.insert(materialPoLineTable).values({
      poId: row.id,
      stockId: lt.stockNum ?? "?",
      description: lt.description,
      rolls: Math.round(lt.quantity ?? 0),
      footage,
      width: lt.masterWidth,
    });
    await db.insert(poEmailEventTable).values({
      poId: row.id,
      direction: "system",
      kind: "note",
      summary: `Adopted from Label Traxx (PO ${lt.poNumber}, created ${lt.poDate}) — the PO was created outside the dashboard; the agent will watch for vendor emails citing this number.`,
    });
    adopted += 1;
    logger.info({ ltPo: lt.poNumber, vendor: lt.supplierName }, "Adopted LT-created PO for agent tracking");
  }
  return adopted;
}

export async function runPoAgent(): Promise<AgentRunResult> {
  const zero: AgentRunResult = { posChecked: 0, inboundProcessed: 0, reclassified: 0, acksDetected: 0, draftsCreated: 0, closed: 0, flagged: 0 };
  if (!gmailConfigured()) return { ...zero, skipped: "gmail not configured" };
  const connection = await gmailConnection();
  if (!connection) return { ...zero, skipped: "gmail not connected" };
  if (!scopeSupportsRead(connection.scope)) return { ...zero, skipped: "gmail grant lacks gmail.readonly — reconnect" };
  const selfEmail = connection.accountEmail?.toLowerCase() ?? "";

  const enabledVendors = await db.select().from(vendorContactTable).where(eq(vendorContactTable.agentEnabled, true));
  const vendorByName = new Map(enabledVendors.map((v) => [v.vendorName, v]));
  if (vendorByName.size === 0) return { ...zero, skipped: "no vendors enabled" };

  // Pull in LT-created POs first so this same run processes their mail.
  const adopted = await adoptLtPos(vendorByName);

  // Buyer-approved conventions, injected into every classification for the
  // matching vendor (null vendorName = applies everywhere).
  const allLessons = await db.select().from(agentLessonTable);

  // Every emailed PO for an enabled vendor. agentState null means it was sent
  // before the agent existed (or before the vendor was enabled) — adopt it.
  const pos = (
    await db.select().from(materialPoTable).where(isNotNull(materialPoTable.emailedAt))
  ).filter((po) => vendorByName.has(po.vendorName) && (po.agentState == null || (ACTIVE_STATES as readonly string[]).includes(po.agentState)));
  if (pos.length === 0) return { ...zero, adopted };

  const lines = await db
    .select()
    .from(materialPoLineTable)
    .where(inArray(materialPoLineTable.poId, pos.map((p) => p.id)));
  const lineByPo = new Map(lines.map((l) => [l.poId, l]));

  const result = { ...zero, adopted };

  for (const po of pos) {
    result.posChecked += 1;
    const vendor = vendorByName.get(po.vendorName)!;
    const line = lineByPo.get(po.id);
    const ref = poReference(po);
    let state = po.agentState ?? "awaiting_ack";
    let promisedDate = po.promisedDate;
    let needsAttention = po.needsAttention;
    let attentionReason = po.attentionReason;
    let ackAt = po.ackAt;
    let notes = po.notes;

    /** Classification effects, shared by fresh messages and reclassification. */
    const applyEffects = async (c: Classification, msg: GmailMessage): Promise<void> => {
      // Save vendor documents on substantive messages (the ACK PDF etc.).
      if (["ack", "ship_notice", "delay"].includes(c.kind)) {
        const already = await db
          .select({ id: poAttachmentTable.id })
          .from(poAttachmentTable)
          .where(and(eq(poAttachmentTable.poId, po.id), eq(poAttachmentTable.gmailMessageId, msg.id)));
        if (already.length === 0) {
          for (const a of attachmentParts(msg)) {
            if (a.size > MAX_ATTACHMENT_BYTES) continue;
            try {
              const content = await fetchAttachment(msg.id, a.attachmentId);
              await db.insert(poAttachmentTable).values({
                poId: po.id,
                filename: a.filename,
                mimeType: a.mimeType,
                contentBase64: content.toString("base64"),
                sizeBytes: content.length,
                gmailMessageId: msg.id,
              });
            } catch (e) {
              logger.warn({ poId: po.id, file: a.filename, err: String(e) }, "Attachment capture failed");
            }
          }
        }
      }

      if (c.promisedDate) promisedDate = c.promisedDate;
      if (c.kind === "ack" && state === "awaiting_ack") {
        state = "acknowledged";
        ackAt = new Date(Number(msg.internalDate ?? Date.now()));
        result.acksDetected += 1;
      }
      if (c.kind === "ship_notice") state = "shipped";
      if (c.tracking.length) {
        const stamp = new Date().toISOString().slice(0, 10);
        const lineTxt = c.tracking.map((t) => `${t.carrier} ${t.number}`.trim()).join("; ");
        notes = `${notes?.trim() ? `${notes.trim()}\n` : ""}Tracking: ${lineTxt} (from vendor email ${stamp})`;
      }
      if (c.discrepancies) {
        needsAttention = true;
        attentionReason = `ACK discrepancy: ${c.discrepancies.slice(0, 200)}`;
      }
      if (c.kind === "delay") {
        needsAttention = true;
        attentionReason = `Vendor announced a delay${c.promisedDate ? ` — new date ${c.promisedDate}` : ""}`;
      }
      if (c.kind === "question") {
        needsAttention = true;
        attentionReason = "Vendor asked a question — reply needed";
      }
      if (c.needsHuman && !needsAttention) {
        needsAttention = true;
        attentionReason = c.needsHumanReason ?? "Flagged by classifier";
      }
    };

    const classifyMsg = async (msg: GmailMessage): Promise<ClassifyResult> => {
      // Hand PDF attachments to the model — order acknowledgements are
      // structured PDFs and the promised date/quantity often exist only there.
      const parts = attachmentParts(msg);
      const pdfs: { filename: string; data: string }[] = [];
      for (const p of parts.filter((a) => a.mimeType === "application/pdf" && a.size <= MAX_CLASSIFY_PDF_BYTES)) {
        if (pdfs.length >= MAX_CLASSIFY_PDFS) break;
        try {
          pdfs.push({ filename: p.filename, data: (await fetchAttachment(msg.id, p.attachmentId)).toString("base64") });
        } catch (e) {
          logger.warn({ poId: po.id, file: p.filename, err: String(e) }, "Could not fetch PDF for classification");
        }
      }
      return classifyVendorEmail({
        vendorName: po.vendorName,
        poRef: ref,
        stockLine: line
          ? `Stock #${line.stockId} — ${line.description ?? ""} (${line.rolls} rolls` +
            (line.width ? ` @ ${line.width}" wide` : "") +
            (line.footage ? `, ${Math.round(line.footage).toLocaleString("en-US")} ft total` : "") +
            `)`
          : "unknown",
        requestedDelivery: po.requestedDeliveryDate,
        agentState: state,
        from: header(msg, "From") ?? "",
        subject: header(msg, "Subject") ?? "",
        date: header(msg, "Date") ?? "",
        body: bodyText(msg),
        attachmentNames: parts.map((a) => a.filename),
        pdfs,
        buyerNotes: allLessons
          .filter((l) => !l.vendorName || l.vendorName === po.vendorName)
          .map((l) => l.lesson),
      });
    };

    try {
      if (po.agentState == null) {
        await appendEvent(po.id, {
          direction: "system",
          kind: "state_change",
          summary: "Agent started tracking this PO (awaiting acknowledgement)",
        });
      }

      // 1. Receipt closes the loop — the LT mirror refreshes every 15 min.
      const ltNum = (po.ltPoNumbers ?? "").split(",").map((n) => n.trim()).filter(Boolean)[0];
      if (ltNum) {
        const [ltPo] = await db.select().from(ltPoTable).where(eq(ltPoTable.poNumber, ltNum)).limit(1);
        if (ltPo?.receivedDate) {
          await db
            .update(materialPoTable)
            .set({ agentState: "closed", needsAttention: false, attentionReason: null, updatedAt: new Date() })
            .where(eq(materialPoTable.id, po.id));
          await appendEvent(po.id, {
            direction: "system",
            kind: "state_change",
            summary: `Received in Label Traxx ${ltPo.receivedDate} — tracking closed`,
          });
          result.closed += 1;
          continue;
        }
      }

      // 2. What have we already seen?
      const events = await db.select().from(poEmailEventTable).where(eq(poEmailEventTable.poId, po.id));
      const seenMessageIds = new Set(events.map((e) => e.gmailMessageId).filter(Boolean) as string[]);
      const trackedThreads = new Set<string>();
      if (po.gmailThreadId) trackedThreads.add(po.gmailThreadId);
      for (const e of events) if (e.gmailThreadId) trackedThreads.add(e.gmailThreadId);

      // 2b. Heal earlier failures: inbound events recorded without a
      // classification (extracted.kind missing) get re-classified now — e.g.
      // the batch flagged while the classifier was rejecting every call.
      for (const e of events) {
        if (e.direction !== "inbound" || !e.gmailMessageId) continue;
        const extracted = (e.extracted ?? {}) as Record<string, unknown>;
        if (extracted["kind"]) continue; // already classified
        const msg = await fetchMessage(e.gmailMessageId).catch(() => null);
        if (!msg) continue;
        const r = await classifyMsg(msg);
        if (!r.ok) continue; // still failing — leave for the next run
        await db
          .update(poEmailEventTable)
          .set({
            kind: r.c.kind,
            summary: r.c.summary,
            extracted: { ...r.c, bodyPreview: bodyText(msg).slice(0, BODY_PREVIEW_CHARS) },
          })
          .where(eq(poEmailEventTable.id, e.id));
        await applyEffects(r.c, msg);
        // The flag existed only because classification was failing.
        if (needsAttention && attentionReason && /classif/i.test(attentionReason)) {
          needsAttention = false;
          attentionReason = null;
        }
        result.reclassified += 1;
      }

      // 3. Collect new messages: replies in tracked threads…
      const fresh: GmailMessage[] = [];
      for (const threadId of trackedThreads) {
        const msgs = await fetchThreadMessages(threadId).catch(() => []);
        for (const m of msgs) if (!seenMessageIds.has(m.id)) fresh.push(m);
      }
      // …and out-of-thread vendor mail citing the PO number (ERP-generated
      // acknowledgements never join our thread).
      const domains = vendorDomains(vendor.toEmails, vendor.ccEmails);
      if (domains.length && po.emailedAt) {
        const after = po.emailedAt.toISOString().slice(0, 10).replace(/-/g, "/");
        const q = `from:(${domains.join(" OR ")}) "${ref}" after:${after}`;
        const hits = await searchMessageIds(q).catch(() => []);
        for (const h of hits) {
          if (seenMessageIds.has(h.id) || fresh.some((m) => m.id === h.id)) continue;
          const m = await fetchMessage(h.id).catch(() => null);
          if (m) fresh.push(m);
        }
      }

      // 4. Process inbound, oldest first.
      fresh.sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
      let sawInbound = events.some((e) => e.direction === "inbound");
      for (const msg of fresh) {
        const from = header(msg, "From") ?? "";
        if ((selfEmail && from.toLowerCase().includes(selfEmail)) || from.toLowerCase().includes("@calyxcontainers.com")) {
          // Our own side of the conversation (the original send, a manual
          // reply Cory sent, or an internal colleague like AP replying on the
          // thread) — record it so we never re-fetch it, never classify it.
          await appendEvent(po.id, {
            direction: "outbound",
            kind: "sent",
            gmailMessageId: msg.id,
            gmailThreadId: msg.threadId,
            rfc822MessageId: header(msg, "Message-ID"),
            fromAddr: from,
            subject: header(msg, "Subject"),
            summary: "Message from us",
          });
          continue;
        }

        result.inboundProcessed += 1;
        sawInbound = true;
        const r = await classifyMsg(msg);
        const preview = bodyText(msg).slice(0, BODY_PREVIEW_CHARS);

        await appendEvent(po.id, {
          direction: "inbound",
          kind: r.ok ? r.c.kind : "other",
          gmailMessageId: msg.id,
          gmailThreadId: msg.threadId,
          rfc822MessageId: header(msg, "Message-ID"),
          fromAddr: from,
          subject: header(msg, "Subject"),
          summary: r.ok ? r.c.summary : `Vendor reply received (classification failed: ${r.reason})`,
          extracted: r.ok ? { ...r.c, bodyPreview: preview } : { bodyPreview: preview },
        });

        if (!r.ok) {
          needsAttention = true;
          attentionReason = `Vendor replied — automatic classification failed (${r.reason.slice(0, 120)}); review the message`;
          continue;
        }
        await applyEffects(r.c, msg);
      }

      // 5. Nudge when the vendor has gone quiet (draft only — nothing sends).
      if (state === "awaiting_ack" && !sawInbound && po.emailedAt) {
        const nudges = events.filter((e) => e.kind === "follow_up");
        const drafts = await db
          .select()
          .from(poAgentDraftTable)
          .where(and(eq(poAgentDraftTable.poId, po.id), eq(poAgentDraftTable.status, "pending")));
        const lastOutbound = nudges.length
          ? new Date(Math.max(...nudges.map((e) => e.at.getTime())))
          : po.emailedAt;
        const quietDays = businessDaysBetween(lastOutbound, new Date());
        if (drafts.length === 0 && nudges.length < MAX_ACK_NUDGES && quietDays >= ACK_NUDGE_AFTER_BUSINESS_DAYS) {
          const stockRef = line ? `Stock #${line.stockId}` : "";
          await db.insert(poAgentDraftTable).values({
            poId: po.id,
            kind: "ack_nudge",
            toEmails: vendor.toEmails ?? po.vendorEmails ?? "",
            ccEmails: vendor.ccEmails,
            subject: `Re: Calyx Containers PO ${ref} — ${po.vendorName} — ${stockRef}`,
            body:
              `Hi All,\n\nFollowing up on purchase order ${ref} sent ${po.emailedAt.toISOString().slice(0, 10)}` +
              `${nudges.length ? " (second follow-up)" : ""} — could you confirm receipt and the expected ship date?\n\n` +
              `Thank you,\nCalyx Containers Supply Chain`,
          });
          result.draftsCreated += 1;
        } else if (nudges.length >= MAX_ACK_NUDGES && quietDays >= ACK_NUDGE_AFTER_BUSINESS_DAYS && !needsAttention) {
          needsAttention = true;
          attentionReason = `No vendor response after ${nudges.length} follow-ups`;
        }
      }

      if (needsAttention && !po.needsAttention) result.flagged += 1;
      await db
        .update(materialPoTable)
        .set({ agentState: state, promisedDate, ackAt, needsAttention, attentionReason, notes, updatedAt: new Date() })
        .where(eq(materialPoTable.id, po.id));
    } catch (e) {
      logger.error({ poId: po.id, err: e instanceof Error ? e.message : String(e) }, "PO agent failed for PO");
    }
  }

  logger.info(result, "PO agent run complete");
  return result;
}

async function appendEvent(
  poId: string,
  e: {
    direction: string;
    kind: string;
    summary: string;
    gmailMessageId?: string | null;
    gmailThreadId?: string | null;
    rfc822MessageId?: string | null;
    fromAddr?: string | null;
    subject?: string | null;
    extracted?: unknown;
  },
): Promise<void> {
  await db.insert(poEmailEventTable).values({
    poId,
    direction: e.direction,
    kind: e.kind,
    summary: e.summary,
    gmailMessageId: e.gmailMessageId ?? null,
    gmailThreadId: e.gmailThreadId ?? null,
    rfc822MessageId: e.rfc822MessageId ?? null,
    fromAddr: e.fromAddr ?? null,
    subject: e.subject ?? null,
    extracted: e.extracted ?? null,
  });
}

export { appendEvent as appendPoEvent };
