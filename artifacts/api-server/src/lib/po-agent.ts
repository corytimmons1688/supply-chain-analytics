import { db, materialPoTable, materialPoLineTable, vendorContactTable, ltPoTable, poEmailEventTable, poAgentDraftTable, poAttachmentTable } from "@workspace/db";
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
      promised_date: { type: ["string", "null"], description: "Vendor-committed ship or delivery date, YYYY-MM-DD" },
      tracking: {
        type: "array",
        items: {
          type: "object",
          required: ["carrier", "number"],
          properties: { carrier: { type: "string" }, number: { type: "string" } },
        },
      },
      confirmed_quantity: { type: ["string", "null"], description: "Quantity the vendor confirmed, verbatim" },
      summary: { type: "string", description: "One factual sentence for the PO timeline" },
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
}): Promise<ClassifyResult> {
  const apiKey = process.env["ANTHROPIC_API_KEY"]?.trim();
  if (!apiKey) return { ok: false, reason: "ANTHROPIC_API_KEY is not set on this deployment" };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      // No sampling params: Claude 5 models reject non-default temperature/
      // top_p/top_k with a 400. Classification is a simple task → low effort.
      body: JSON.stringify({
        model: process.env["ANTHROPIC_MODEL"]?.trim() || "claude-opus-5",
        max_tokens: 2000,
        output_config: { effort: "low" },
        system:
          "You classify emails from label-stock vendors about purchase orders for Calyx Containers' buyer. " +
          "Be literal: only call something an acknowledgement if the vendor confirms the order or provides an order/sales-order confirmation. " +
          "Dates must come from the email, never invented. Treat marketing mail and unrelated threads as 'other'.",
        messages: [
          {
            role: "user",
            content:
              `Purchase order context:\n` +
              `- PO reference: ${input.poRef}\n` +
              `- Vendor: ${input.vendorName}\n` +
              `- Material: ${input.stockLine}\n` +
              `- Requested delivery: ${input.requestedDelivery ?? "unspecified"}\n` +
              `- Current tracking state: ${input.agentState}\n\n` +
              `Email received:\n` +
              `From: ${input.from}\nDate: ${input.date}\nSubject: ${input.subject}\n` +
              `Attachments: ${input.attachmentNames.join(", ") || "(none)"}\n\n` +
              `${input.body.slice(0, 5000)}`,
          },
        ],
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
  skipped?: string;
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

  // Every emailed PO for an enabled vendor. agentState null means it was sent
  // before the agent existed (or before the vendor was enabled) — adopt it.
  const pos = (
    await db.select().from(materialPoTable).where(isNotNull(materialPoTable.emailedAt))
  ).filter((po) => vendorByName.has(po.vendorName) && (po.agentState == null || (ACTIVE_STATES as readonly string[]).includes(po.agentState)));
  if (pos.length === 0) return zero;

  const lines = await db
    .select()
    .from(materialPoLineTable)
    .where(inArray(materialPoLineTable.poId, pos.map((p) => p.id)));
  const lineByPo = new Map(lines.map((l) => [l.poId, l]));

  const result = { ...zero };

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

    const classifyMsg = (msg: GmailMessage): Promise<ClassifyResult> =>
      classifyVendorEmail({
        vendorName: po.vendorName,
        poRef: ref,
        stockLine: line ? `Stock #${line.stockId} — ${line.description ?? ""} (${line.rolls} rolls)` : "unknown",
        requestedDelivery: po.requestedDeliveryDate,
        agentState: state,
        from: header(msg, "From") ?? "",
        subject: header(msg, "Subject") ?? "",
        date: header(msg, "Date") ?? "",
        body: bodyText(msg),
        attachmentNames: attachmentParts(msg).map((a) => a.filename),
      });

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
        if (selfEmail && from.toLowerCase().includes(selfEmail)) {
          // Our own message (original send from before events existed, or a
          // manual reply Cory sent) — record it so we never re-fetch it.
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
