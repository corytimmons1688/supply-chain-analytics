import {
  db,
  materialPoTable,
  materialPoLineTable,
  poEmailEventTable,
  poAgentDraftTable,
  poAttachmentTable,
  agentLessonTable,
  agentChatMessageTable,
  vendorContactTable,
  ltPoTable,
  ltStockTable,
  ltRollTable,
} from "@workspace/db";
import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import { runPoAgent } from "./po-agent";
import { logger } from "./logger";

/**
 * Conversational control surface for the PO follow-up agent. The buyer asks
 * questions ("which POs are late?") and gives directions ("set 2595's promised
 * date to 8/12", "stop nudging Mactac", "draft a reply asking for tracking").
 *
 * Claude runs a tool loop over the same tables the cron agent uses, so chat
 * actions and autonomous actions are the same data and show up in the same
 * timeline. Deliberately NO tool that sends email: outbound vendor mail stays
 * behind the existing draft→approve queue, so the agent can compose but a
 * human always releases. Every tool call is logged to agent_chat_message.
 */

const MAX_TURNS = 8;
const HISTORY_TURNS = 24;

export interface ChatToolCall {
  tool: string;
  input: Record<string, unknown>;
  result: string;
}
export interface ChatReply {
  ok: boolean;
  reply: string;
  toolCalls: ChatToolCall[];
  /** Set when the turn couldn't run at all (no API key, upstream error). */
  error?: string;
}

// --- helpers ------------------------------------------------------------------

const isoDate = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? v.trim() : null;
};

/** Resolve "2595", "PO 2595" or a material_po id prefix to one tracked PO. */
async function findPo(ref: unknown): Promise<typeof materialPoTable.$inferSelect | null> {
  const raw = String(ref ?? "").trim().replace(/^PO\s*/i, "");
  if (!raw) return null;
  const byLt = await db.select().from(materialPoTable).where(like(materialPoTable.ltPoNumbers, `%${raw}%`));
  const exact = byLt.find((p) =>
    (p.ltPoNumbers ?? "").split(",").map((n) => n.trim()).includes(raw),
  );
  if (exact) return exact;
  if (byLt[0]) return byLt[0];
  const byId = await db.select().from(materialPoTable).where(like(materialPoTable.id, `${raw}%`)).limit(1);
  return byId[0] ?? null;
}

async function poSummaryLine(po: typeof materialPoTable.$inferSelect): Promise<string> {
  const lines = await db.select().from(materialPoLineTable).where(eq(materialPoLineTable.poId, po.id));
  const mat = lines
    .map((l) => `#${l.stockId}${l.width ? ` @${l.width}"` : ""} ${l.rolls} rolls${l.footage ? ` (${Math.round(l.footage).toLocaleString()} ft)` : ""}`)
    .join("; ");
  return (
    `PO ${po.ltPoNumbers ?? `draft ${po.id.slice(0, 8)}`} · ${po.vendorName} · ${mat || "no lines"} · ` +
    `state=${po.agentState ?? "not tracked"} · requested=${po.requestedDeliveryDate ?? "—"} · promised=${po.promisedDate ?? "—"}` +
    (po.needsAttention ? ` · NEEDS ATTENTION: ${po.attentionReason ?? "(no reason)"}` : "") +
    (po.emailedAt ? ` · emailed ${po.emailedAt.toISOString().slice(0, 10)}${po.emailedTo ? "" : " (created in Label Traxx)"}` : " · never emailed")
  );
}

/** Timeline note so chat-driven changes are visible in the PO's activity. */
async function note(poId: string, summary: string): Promise<void> {
  await db.insert(poEmailEventTable).values({ poId, direction: "system", kind: "note", summary });
}

/**
 * Resolve a loosely-typed vendor name to the exact vendor_contact name.
 * Lessons are matched to POs by EXACT vendorName, so "Reynolds Brands" would
 * silently never apply to "Reynolds Brands (Fresh Lock)" — canonicalize first.
 */
async function canonicalVendor(name: string): Promise<string | null> {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const all = await db.select({ v: vendorContactTable.vendorName }).from(vendorContactTable);
  return (
    all.find((r) => r.v.toLowerCase() === n)?.v ??
    all.find((r) => r.v.toLowerCase().includes(n) || n.includes(r.v.toLowerCase()))?.v ??
    null
  );
}

// --- tools --------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_pos",
    description:
      "List purchase orders the agent tracks, newest first. Use filter to narrow: 'needs_attention' (flagged for a human), 'awaiting_ack' (no acknowledgement yet), 'acknowledged', 'shipped', 'late' (promised date in the past, not received), or 'all'.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["all", "needs_attention", "awaiting_ack", "acknowledged", "shipped", "late"] },
        vendor: { type: "string", description: "Optional vendor name substring." },
      },
    },
  },
  {
    name: "get_po",
    description:
      "Full detail for one PO: materials, dates, agent state, the whole email/activity timeline, pending drafts, and captured vendor documents. Use before answering questions about a specific PO.",
    input_schema: {
      type: "object",
      properties: { po: { type: "string", description: "LT PO number (e.g. '2595') or material_po id prefix." } },
      required: ["po"],
    },
  },
  {
    name: "get_stock",
    description:
      "Inventory and supply picture for one stock number: description, supplier, on-hand footage by width, and open POs. Use when asked whether an order is needed or whether a late delivery hurts.",
    input_schema: {
      type: "object",
      properties: { stock_id: { type: "string" } },
      required: ["stock_id"],
    },
  },
  {
    name: "list_vendors",
    description: "Vendor PO contacts and whether the follow-up agent is enabled for each.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_lessons",
    description: "The buyer-approved conventions the agent has learned (injected into every classification).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_promised_date",
    description:
      "Record the vendor's promised/confirmed delivery date on a PO. Use an ISO date (YYYY-MM-DD). Say where the date came from in `source`.",
    input_schema: {
      type: "object",
      properties: {
        po: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD, or empty string to clear." },
        source: { type: "string", description: "Where this date came from, e.g. 'buyer instruction in chat'." },
      },
      required: ["po", "date"],
    },
  },
  {
    name: "add_po_note",
    description: "Append a note to a PO's notes field and its activity timeline (tracking numbers, call outcomes, context).",
    input_schema: {
      type: "object",
      properties: { po: { type: "string" }, text: { type: "string" } },
      required: ["po", "text"],
    },
  },
  {
    name: "resolve_attention",
    description:
      "Clear a PO's needs-attention flag. If the flag was a false alarm caused by a vendor system quirk, pass `lesson` to teach the agent so it stops flagging that pattern for this vendor.",
    input_schema: {
      type: "object",
      properties: {
        po: { type: "string" },
        explanation: { type: "string", description: "Why it's handled — recorded on the timeline." },
        lesson: { type: "string", description: "Optional durable convention to remember for this vendor." },
      },
      required: ["po"],
    },
  },
  {
    name: "flag_attention",
    description: "Flag a PO for human attention with a reason (e.g. the buyer wants to chase it).",
    input_schema: {
      type: "object",
      properties: { po: { type: "string" }, reason: { type: "string" } },
      required: ["po", "reason"],
    },
  },
  {
    name: "add_lesson",
    description:
      "Teach the agent a durable convention so it stops misreading a vendor's habits. Omit vendor to apply to all vendors.",
    input_schema: {
      type: "object",
      properties: { lesson: { type: "string" }, vendor: { type: "string" } },
      required: ["lesson"],
    },
  },
  {
    name: "delete_lesson",
    description: "Forget a lesson by its id (from list_lessons).",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "set_vendor_agent",
    description:
      "Turn the follow-up agent on or off for a vendor. Off means the agent stops watching that vendor's POs and stops drafting nudges.",
    input_schema: {
      type: "object",
      properties: { vendor: { type: "string" }, enabled: { type: "boolean" } },
      required: ["vendor", "enabled"],
    },
  },
  {
    name: "draft_reply",
    description:
      "Compose an email to the vendor and put it in the approval queue. IT IS NOT SENT — the buyer reviews, edits and approves it in the dashboard. Write the body as the buyer (Calyx Containers purchasing), plain text, no signature block.",
    input_schema: {
      type: "object",
      properties: {
        po: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        kind: { type: "string", enum: ["ack_nudge", "checkin", "tracking_request"] },
      },
      required: ["po", "subject", "body"],
    },
  },
  {
    name: "dismiss_draft",
    description: "Discard a pending draft from the approval queue by its id (from get_po).",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "revise_price",
    description:
      "Apply a vendor-confirmed unit price to a PO: updates the PO line, our stock cost override, and the Label Traxx stock master (CostMSI). Use when the buyer tells you a vendor confirmed a new price, or asks you to match a price from an acknowledgement. Label Traxx has no PO-edit API, so the PO's own dollar total still has to be revised by hand in LT — say so in your reply.",
    input_schema: {
      type: "object",
      properties: {
        po: { type: "string" },
        unit_price: { type: "number", description: "Confirmed price as a number, e.g. 0.5963" },
        unit: { type: "string", description: "Basis — 'MSI' applies automatically; anything else is reported back for manual conversion." },
        source: { type: "string", description: "Where the price came from, e.g. 'Mactac ACK 22414417' — recorded on the timeline." },
      },
      required: ["po", "unit_price"],
    },
  },
  {
    name: "run_agent",
    description:
      "Run the follow-up agent now: adopt new Label Traxx POs, pull vendor replies from Gmail, classify them, update states and queue nudge drafts. Takes ~10-60s. Use when the buyer asks to check for new vendor mail.",
    input_schema: { type: "object", properties: {} },
  },
] as const;

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  switch (name) {
    case "list_pos": {
      const filter = String(input["filter"] ?? "all");
      const vendor = String(input["vendor"] ?? "").trim().toLowerCase();
      let pos = await db.select().from(materialPoTable).orderBy(desc(materialPoTable.createdAt));
      if (vendor) pos = pos.filter((p) => p.vendorName.toLowerCase().includes(vendor));
      if (filter === "needs_attention") pos = pos.filter((p) => p.needsAttention);
      else if (filter === "late")
        pos = pos.filter((p) => p.promisedDate != null && p.promisedDate < today && p.agentState !== "closed");
      else if (filter !== "all") pos = pos.filter((p) => p.agentState === filter);
      if (pos.length === 0) return "No POs match.";
      const out: string[] = [];
      for (const p of pos.slice(0, 40)) out.push(await poSummaryLine(p));
      return `${pos.length} PO(s)${pos.length > 40 ? " (showing 40)" : ""}:\n${out.join("\n")}`;
    }
    case "get_po": {
      const po = await findPo(input["po"]);
      if (!po) return `No tracked PO matches ${JSON.stringify(input["po"])}. Try list_pos.`;
      const events = await db
        .select()
        .from(poEmailEventTable)
        .where(eq(poEmailEventTable.poId, po.id))
        .orderBy(asc(poEmailEventTable.at));
      const drafts = await db.select().from(poAgentDraftTable).where(eq(poAgentDraftTable.poId, po.id));
      const atts = await db.select().from(poAttachmentTable).where(eq(poAttachmentTable.poId, po.id));
      const [lt] = po.ltPoNumbers
        ? await db.select().from(ltPoTable).where(eq(ltPoTable.poNumber, po.ltPoNumbers.split(",")[0]!.trim())).limit(1)
        : [];
      return [
        await poSummaryLine(po),
        po.notes ? `Notes: ${po.notes}` : "Notes: (none)",
        lt ? `Label Traxx: dueDate=${lt.dueDate ?? "—"} received=${lt.receivedDate ?? "not received"} closed=${lt.closed}` : "",
        `Timeline (${events.length}):`,
        ...events.map((e) => {
          const ex = (e.extracted ?? {}) as Record<string, unknown>;
          return (
            `  ${e.at.toISOString().slice(0, 16).replace("T", " ")} ${e.direction}/${e.kind}` +
            (e.fromAddr ? ` from ${e.fromAddr}` : "") +
            (e.subject ? ` — "${e.subject}"` : "") +
            (e.summary ? `: ${e.summary}` : "") +
            (ex["discrepancies"] ? ` [discrepancies: ${String(ex["discrepancies"])}]` : "")
          );
        }),
        drafts.length
          ? `Drafts:\n${drafts.map((d) => `  id=${d.id.slice(0, 8)} ${d.status} ${d.kind} "${d.subject}"`).join("\n")}`
          : "Drafts: (none)",
        atts.length ? `Documents: ${atts.map((a) => a.filename).join(", ")}` : "Documents: (none)",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "get_stock": {
      const id = String(input["stock_id"] ?? "").trim().replace(/^#/, "");
      const [st] = await db.select().from(ltStockTable).where(eq(ltStockTable.stockId, id)).limit(1);
      if (!st) return `No stock #${id} in the Label Traxx mirror.`;
      const rolls = await db
        .select({ w: ltRollTable.width, ft: sql<number>`sum(${ltRollTable.length})`, n: sql<number>`count(*)` })
        .from(ltRollTable)
        .where(and(eq(ltRollTable.stockId, id), eq(ltRollTable.used, false)))
        .groupBy(ltRollTable.width);
      // lt_stock carries no description — it lives on the rolls.
      const [descRow] = await db
        .select({ d: ltRollTable.description })
        .from(ltRollTable)
        .where(eq(ltRollTable.stockId, id))
        .limit(1);
      const openPos = await db
        .select()
        .from(ltPoTable)
        .where(and(eq(ltPoTable.stockNum, id), eq(ltPoTable.closed, false)));
      return [
        `Stock #${id}: ${descRow?.d ?? ([st.faceStock, st.adhesive].filter(Boolean).join(" / ") || "(no description)")}`,
        `Supplier: ${st.supplierName ?? "—"} · master width ${st.masterWidth ?? "?"}" · CostMSI ${st.costMsi ?? "?"} · lead time ${st.estimatedDeliveryTime ?? "?"} days · ${st.inactive ? "INACTIVE in LT" : "active"}`,
        `On hand by width: ${rolls.map((r) => `${r.w ?? "?"}" ${Math.round(Number(r.ft)).toLocaleString()} ft (${r.n} rolls)`).join(" | ") || "(none)"}`,
        `Open POs: ${
          openPos
            .filter((p) => !p.receivedDate)
            .map((p) => `${p.poNumber} ${p.supplierName ?? ""} qty ${p.quantity ?? "?"} due ${p.dueDate ?? "—"} requested ${p.requestedDeliveryDate ?? "—"}`)
            .join(" | ") || "(none)"
        }`,
      ].join("\n");
    }
    case "list_vendors": {
      const vs = await db.select().from(vendorContactTable).orderBy(asc(vendorContactTable.vendorName));
      return vs.length
        ? vs.map((v) => `${v.vendorName}: agent=${v.agentEnabled ? "ON" : "off"} to=${v.toEmails ?? "—"} cc=${v.ccEmails ?? "—"}`).join("\n")
        : "No vendor contacts configured.";
    }
    case "list_lessons": {
      const ls = await db.select().from(agentLessonTable).orderBy(desc(agentLessonTable.createdAt));
      return ls.length
        ? ls.map((l) => `id=${l.id.slice(0, 8)} [${l.vendorName ?? "all vendors"}] ${l.lesson}`).join("\n")
        : "No lessons recorded yet.";
    }
    case "set_promised_date": {
      const po = await findPo(input["po"]);
      if (!po) return `No tracked PO matches ${JSON.stringify(input["po"])}.`;
      const raw = String(input["date"] ?? "").trim();
      if (raw && !isoDate(raw)) return `"${raw}" is not a YYYY-MM-DD date — ask the buyer to confirm the exact date.`;
      const date = raw ? isoDate(raw) : null;
      await db
        .update(materialPoTable)
        .set({ promisedDate: date, updatedAt: new Date() })
        .where(eq(materialPoTable.id, po.id));
      const src = String(input["source"] ?? "buyer instruction in chat");
      await note(po.id, date ? `Promised date set to ${date} (${src})` : `Promised date cleared (${src})`);
      return `PO ${po.ltPoNumbers ?? po.id.slice(0, 8)}: promised date ${date ? `set to ${date}` : "cleared"}.`;
    }
    case "add_po_note": {
      const po = await findPo(input["po"]);
      if (!po) return `No tracked PO matches ${JSON.stringify(input["po"])}.`;
      const text = String(input["text"] ?? "").trim();
      if (!text) return "Nothing to add — note text was empty.";
      const notes = po.notes ? `${po.notes}\n${text}` : text;
      await db.update(materialPoTable).set({ notes, updatedAt: new Date() }).where(eq(materialPoTable.id, po.id));
      await note(po.id, `Note added: ${text}`);
      return `Note added to PO ${po.ltPoNumbers ?? po.id.slice(0, 8)}.`;
    }
    case "resolve_attention": {
      const po = await findPo(input["po"]);
      if (!po) return `No tracked PO matches ${JSON.stringify(input["po"])}.`;
      const explanation = String(input["explanation"] ?? "").trim();
      const lesson = String(input["lesson"] ?? "").trim();
      await db
        .update(materialPoTable)
        .set({ needsAttention: false, attentionReason: null, updatedAt: new Date() })
        .where(eq(materialPoTable.id, po.id));
      await note(po.id, `Flag resolved via chat${explanation ? `: ${explanation}` : ""}`);
      if (lesson) {
        await db.insert(agentLessonTable).values({ vendorName: po.vendorName, lesson, poId: po.id });
      }
      return `Cleared the flag on PO ${po.ltPoNumbers ?? po.id.slice(0, 8)}${lesson ? ` and recorded the lesson for ${po.vendorName}.` : "."}`;
    }
    case "flag_attention": {
      const po = await findPo(input["po"]);
      if (!po) return `No tracked PO matches ${JSON.stringify(input["po"])}.`;
      const reason = String(input["reason"] ?? "Flagged by the buyer").trim();
      await db
        .update(materialPoTable)
        .set({ needsAttention: true, attentionReason: reason, updatedAt: new Date() })
        .where(eq(materialPoTable.id, po.id));
      await note(po.id, `Flagged for attention via chat: ${reason}`);
      return `Flagged PO ${po.ltPoNumbers ?? po.id.slice(0, 8)}: ${reason}`;
    }
    case "add_lesson": {
      const lesson = String(input["lesson"] ?? "").trim();
      if (!lesson) return "No lesson text provided.";
      const asked = String(input["vendor"] ?? "").trim();
      let vendorName: string | null = null;
      if (asked) {
        vendorName = await canonicalVendor(asked);
        if (!vendorName)
          return `No vendor contact matches "${asked}" — lessons only apply on an exact vendor name. Use list_vendors and retry with the exact name, or omit vendor to apply to all.`;
      }
      await db.insert(agentLessonTable).values({ vendorName, lesson });
      return `Recorded for ${vendorName ?? "all vendors"}: ${lesson}`;
    }
    case "delete_lesson": {
      const id = String(input["id"] ?? "").trim();
      const ls = await db.select().from(agentLessonTable).where(like(agentLessonTable.id, `${id}%`)).limit(1);
      if (!ls[0]) return `No lesson with id starting ${id}.`;
      await db.delete(agentLessonTable).where(eq(agentLessonTable.id, ls[0].id));
      return `Deleted lesson: ${ls[0].lesson}`;
    }
    case "set_vendor_agent": {
      const name = String(input["vendor"] ?? "").trim();
      const enabled = input["enabled"] === true;
      const all = await db.select().from(vendorContactTable);
      const match =
        all.find((v) => v.vendorName.toLowerCase() === name.toLowerCase()) ??
        all.find((v) => v.vendorName.toLowerCase().includes(name.toLowerCase()));
      if (!match) return `No vendor contact matches "${name}". Use list_vendors to see the exact names.`;
      await db
        .update(vendorContactTable)
        .set({ agentEnabled: enabled, updatedAt: new Date() })
        .where(eq(vendorContactTable.vendorName, match.vendorName));
      return `Agent ${enabled ? "enabled" : "disabled"} for ${match.vendorName}.`;
    }
    case "draft_reply": {
      const po = await findPo(input["po"]);
      if (!po) return `No tracked PO matches ${JSON.stringify(input["po"])}.`;
      const subject = String(input["subject"] ?? "").trim();
      const body = String(input["body"] ?? "").trim();
      if (!subject || !body) return "A draft needs both a subject and a body.";
      const [vc] = await db
        .select()
        .from(vendorContactTable)
        .where(eq(vendorContactTable.vendorName, po.vendorName))
        .limit(1);
      const to = vc?.toEmails ?? po.vendorEmails;
      if (!to) return `No email address on file for ${po.vendorName} — add one on the Email tab first.`;
      const [row] = await db
        .insert(poAgentDraftTable)
        .values({
          poId: po.id,
          kind: String(input["kind"] ?? "checkin"),
          toEmails: to,
          ccEmails: vc?.ccEmails ?? null,
          subject,
          body,
          status: "pending",
        })
        .returning({ id: poAgentDraftTable.id });
      await note(po.id, `Draft composed via chat (awaiting approval): "${subject}"`);
      return `Draft queued for approval (id=${row?.id.slice(0, 8)}) to ${to}. NOT sent — it's in the approval queue on the Email tab for review.`;
    }
    case "dismiss_draft": {
      const id = String(input["id"] ?? "").trim();
      const ds = await db.select().from(poAgentDraftTable).where(like(poAgentDraftTable.id, `${id}%`)).limit(1);
      if (!ds[0]) return `No draft with id starting ${id}.`;
      if (ds[0].status !== "pending") return `That draft is already ${ds[0].status}.`;
      await db.update(poAgentDraftTable).set({ status: "dismissed" }).where(eq(poAgentDraftTable.id, ds[0].id));
      return `Dismissed draft "${ds[0].subject}".`;
    }
    case "revise_price": {
      const po = await findPo(input["po"]);
      if (!po) return `No tracked PO matches ${JSON.stringify(input["po"])}.`;
      const price = Number(input["unit_price"]);
      if (!Number.isFinite(price) || price <= 0) return "unit_price must be a positive number.";
      const { applyConfirmedPrice } = await import("./po-price-revision");
      const r = await applyConfirmedPrice({
        poId: po.id,
        confirmedUnitPrice: price,
        priceUnit: typeof input["unit"] === "string" ? input["unit"] : "MSI",
        source: String(input["source"] ?? "buyer instruction in chat"),
      });
      return r.detail;
    }
    case "run_agent": {
      const r = await runPoAgent();
      return r.skipped
        ? `Agent did not run: ${r.skipped}`
        : `Agent run complete — POs checked ${r.posChecked}, adopted ${r.adopted ?? 0}, inbound processed ${r.inboundProcessed}, reclassified ${r.reclassified}, acks detected ${r.acksDetected}, prices revised ${r.pricesRevised}, drafts queued ${r.draftsCreated}, closed ${r.closed}, flagged ${r.flagged}.`;
    }
    default:
      return `Unknown tool ${name}.`;
  }
}

// --- conversation -------------------------------------------------------------

function systemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return (
    `You are the purchasing agent inside Calyx Containers' Supply Chain Analytics dashboard, talking with the buyer. ` +
    `Today is ${today}.\n\n` +
    `You manage material purchase orders for label stock: watching vendor email for acknowledgements, capturing promised delivery dates and tracking numbers, and flagging problems. ` +
    `Use your tools to answer from real data — never guess a PO number, date, quantity or vendor. If a tool says no match, say so and offer what you did find.\n\n` +
    `Domain facts you can rely on:\n` +
    `- Stock is bought as master rolls and measured in feet. A PO is always one material.\n` +
    `- Availability = on hand + on order − footage committed to open production tickets, compared against the stock's Min.\n` +
    `- Widths up to 14" are interchangeable (they slit down); the dashboard labels that pooled bucket ≤13". Wider widths (e.g. 30") net separately.\n` +
    `- "Requested" delivery is what Calyx asked for; "promised" is what the vendor confirmed. Promised later than requested is worth flagging.\n` +
    `- Material cost is quoted per MSI (thousand square inches). When a vendor confirms a different price, the PO line, our stock cost, and the Label Traxx stock master can all be updated — but Label Traxx has no PO-edit API, so a PO's own dollar total is always a manual edit in LT.\n` +
    `- Dazpak runs a make-and-hold program: they produce rolls and hold them in their warehouse until Calyx calls for release (~5 business days).\n\n` +
    `Rules:\n` +
    `- You CANNOT send email. draft_reply only queues a draft for the buyer to review and approve. Never say or imply you sent something.\n` +
    `- Before a write, be sure you have the right PO — look it up if there's any ambiguity, and prefer asking a short clarifying question over guessing.\n` +
    `- Dates must be exact. If the buyer says "next Friday" or a date you can't pin down, ask for YYYY-MM-DD rather than inferring.\n` +
    `- Report what you actually did, including anything that failed. Be brief and concrete — this is a working chat, not a report. Plain sentences, no headers.`
  );
}

/**
 * One conversational turn: persists the buyer's message, runs the tool loop,
 * persists and returns the agent's reply plus what it did.
 */
export async function chatWithAgent(userEmail: string, message: string): Promise<ChatReply> {
  const apiKey = process.env["ANTHROPIC_API_KEY"]?.trim();
  const email = userEmail.toLowerCase();
  if (!apiKey) {
    return { ok: false, reply: "", toolCalls: [], error: "ANTHROPIC_API_KEY is not set on this deployment." };
  }
  await db.insert(agentChatMessageTable).values({ userEmail: email, role: "user", content: message });

  // Recent history as plain turns (tool detail stays in the log, not the prompt).
  const history = (
    await db
      .select()
      .from(agentChatMessageTable)
      .where(eq(agentChatMessageTable.userEmail, email))
      .orderBy(desc(agentChatMessageTable.createdAt))
      .limit(HISTORY_TURNS)
  ).reverse();

  const messages: { role: string; content: unknown }[] = history.map((h) => ({
    role: h.role === "user" ? "user" : "assistant",
    content: h.content || "(no reply)",
  }));

  const toolCalls: ChatToolCall[] = [];
  let reply = "";

  try {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        // No sampling params — Claude 5 models 400 on non-default values.
        body: JSON.stringify({
          model: process.env["ANTHROPIC_MODEL"]?.trim() || "claude-sonnet-5",
          max_tokens: 4000,
          system: systemPrompt(),
          messages,
          tools: TOOLS,
        }),
      });
      const json = (await res.json()) as {
        content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
        stop_reason?: string;
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      const blocks = json.content ?? [];
      const text = blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!.trim())
        .join("\n\n");
      if (text) reply = text;
      const uses = blocks.filter((b) => b.type === "tool_use" && b.name);

      if (uses.length === 0) break;

      messages.push({ role: "assistant", content: blocks });
      const results: unknown[] = [];
      for (const u of uses) {
        const input = u.input ?? {};
        let result: string;
        try {
          result = await runTool(u.name!, input);
        } catch (e) {
          result = `Tool failed: ${e instanceof Error ? e.message : String(e)}`;
          logger.warn({ tool: u.name, err: result }, "Agent chat tool failed");
        }
        toolCalls.push({ tool: u.name!, input, result });
        results.push({ type: "tool_result", tool_use_id: u.id, content: result });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error({ err: error }, "Agent chat failed");
    await db.insert(agentChatMessageTable).values({
      userEmail: email,
      role: "assistant",
      content: `I couldn't complete that: ${error}`,
      toolLog: toolCalls.length ? toolCalls : null,
    });
    return { ok: false, reply: "", toolCalls, error };
  }

  if (!reply) reply = toolCalls.length ? "Done — see the actions above." : "I don't have a reply for that.";
  await db.insert(agentChatMessageTable).values({
    userEmail: email,
    role: "assistant",
    content: reply,
    toolLog: toolCalls.length ? toolCalls : null,
  });
  return { ok: true, reply, toolCalls };
}

export async function getChatHistory(userEmail: string, limit = 60) {
  const rows = await db
    .select()
    .from(agentChatMessageTable)
    .where(eq(agentChatMessageTable.userEmail, userEmail.toLowerCase()))
    .orderBy(desc(agentChatMessageTable.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function clearChatHistory(userEmail: string): Promise<void> {
  await db.delete(agentChatMessageTable).where(eq(agentChatMessageTable.userEmail, userEmail.toLowerCase()));
}
