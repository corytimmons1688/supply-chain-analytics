import crypto from "node:crypto";
import { db, oauthCredentialTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Gmail sending for vendor purchase orders.
 *
 * Sends as the mailbox that granted consent (Cory's Workspace account), so POs
 * land in his Sent folder and vendor replies come straight back to him — the
 * same as if he'd hit send in Gmail. Scope is `gmail.send` only: this
 * integration can send mail and cannot read a single message.
 *
 * The client id/secret live in env; only the refresh token is persisted
 * (`oauth_credential`). Access tokens are minted per request and cached in
 * module scope for the life of the serverless instance.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const PROVIDER = "gmail";

/**
 * `openid email` names the connected mailbox in Configuration. gmail.readonly
 * is required by the PO follow-up agent to see vendor replies and out-of-thread
 * ERP acknowledgements. NOTE: the token could technically read the whole
 * mailbox — the agent code only ever fetches PO threads and PO-number searches,
 * but that is a code promise, not a scope promise (gmail.metadata can't read
 * bodies/attachments, so it can't do this job). Cory approved the tradeoff.
 */
export const GMAIL_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

/** True when the stored grant predates the readonly scope — reconnect needed for the agent. */
export function scopeSupportsRead(scope: string | null | undefined): boolean {
  return Boolean(scope?.includes("gmail.readonly"));
}

function clientId(): string | undefined {
  return process.env["GOOGLE_OAUTH_CLIENT_ID"]?.trim() || undefined;
}
function clientSecret(): string | undefined {
  return process.env["GOOGLE_OAUTH_CLIENT_SECRET"]?.trim() || undefined;
}

/**
 * Public origin of this deployment, used to build the OAuth redirect URI. Must
 * match a redirect URI registered on the Google OAuth client exactly.
 */
export function appBaseUrl(): string {
  const explicit = process.env["APP_BASE_URL"]?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  // VERCEL_URL is per-deployment and changes on every push, which would break a
  // registered redirect URI — prefer the stable production domain, and set
  // APP_BASE_URL explicitly when the app is served from a custom alias.
  const stable = process.env["VERCEL_PROJECT_PRODUCTION_URL"]?.trim();
  if (stable) return `https://${stable}`;
  const vercel = process.env["VERCEL_URL"]?.trim();
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

export function redirectUri(): string {
  return `${appBaseUrl()}/api/integrations/gmail/callback`;
}

/** True when the OAuth client is configured — i.e. connecting is even possible. */
export function gmailConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

export interface GmailConnection {
  accountEmail: string | null;
  scope: string | null;
  connectedAt: Date;
}

export async function gmailConnection(): Promise<GmailConnection | null> {
  const [row] = await db
    .select()
    .from(oauthCredentialTable)
    .where(eq(oauthCredentialTable.provider, PROVIDER))
    .limit(1);
  if (!row) return null;
  return { accountEmail: row.accountEmail, scope: row.scope, connectedAt: row.connectedAt };
}

export async function disconnectGmail(): Promise<void> {
  await db.delete(oauthCredentialTable).where(eq(oauthCredentialTable.provider, PROVIDER));
  cachedAccess = null;
}

// --- consent flow -----------------------------------------------------------

/**
 * The callback has no session to compare against (single serverless function,
 * no cookie store), so `state` is an HMAC of a timestamp keyed by the client
 * secret. That's enough to prove the callback follows a redirect we issued and
 * that it's recent.
 */
export function signState(): string {
  const issued = Date.now().toString(36);
  const mac = crypto.createHmac("sha256", clientSecret() ?? "").update(issued).digest("base64url").slice(0, 24);
  return `${issued}.${mac}`;
}

export function verifyState(state: string | undefined): boolean {
  const [issued, mac] = (state ?? "").split(".");
  if (!issued || !mac) return false;
  const expected = crypto.createHmac("sha256", clientSecret() ?? "").update(issued).digest("base64url").slice(0, 24);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  const age = Date.now() - parseInt(issued, 36);
  return age >= 0 && age < 15 * 60 * 1000;
}

export function consentUrl(): string {
  const params = new URLSearchParams({
    client_id: clientId() ?? "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GMAIL_SCOPES,
    // offline + consent so Google actually returns a refresh token; without
    // prompt=consent a re-authorization returns only an access token.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: signState(),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(
      `Google token request failed (${res.status}): ${json.error ?? ""} ${json.error_description ?? ""}`.trim(),
    );
  }
  return json;
}

/** Pull the `email` claim out of an id_token. It came straight from Google's
 * token endpoint over TLS, so the signature needs no separate verification. */
function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}

/** Exchange the consent code for a refresh token and store it. */
export async function completeConsent(code: string): Promise<{ accountEmail: string | null }> {
  const tokens = await tokenRequest({
    code,
    client_id: clientId() ?? "",
    client_secret: clientSecret() ?? "",
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Remove this app's access at myaccount.google.com/permissions and connect again.",
    );
  }
  if (!tokens.scope?.includes("gmail.send")) {
    throw new Error("The send-email permission was not granted — connect again and leave the send checkbox ticked.");
  }
  const accountEmail = emailFromIdToken(tokens.id_token);
  await db
    .insert(oauthCredentialTable)
    .values({
      provider: PROVIDER,
      refreshToken: tokens.refresh_token,
      accountEmail,
      scope: tokens.scope ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: oauthCredentialTable.provider,
      set: {
        refreshToken: tokens.refresh_token,
        accountEmail,
        scope: tokens.scope ?? null,
        connectedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  if (cachedAccess) cachedAccess = null;
  return { accountEmail };
}

let cachedAccess: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedAccess && cachedAccess.expiresAt > Date.now() + 60_000) return cachedAccess.token;
  const [row] = await db
    .select()
    .from(oauthCredentialTable)
    .where(eq(oauthCredentialTable.provider, PROVIDER))
    .limit(1);
  if (!row) throw new Error("Gmail is not connected — connect it in Demand Planning → Configuration.");
  const tokens = await tokenRequest({
    client_id: clientId() ?? "",
    client_secret: clientSecret() ?? "",
    refresh_token: row.refreshToken,
    grant_type: "refresh_token",
  });
  if (!tokens.access_token) throw new Error("Google returned no access token");
  cachedAccess = {
    token: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
  return cachedAccess.token;
}

// --- MIME -------------------------------------------------------------------

/** RFC 2047 encode a header value when it isn't plain ASCII (our subjects use em dashes). */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Fold base64 to 76-char lines as required for MIME transport. */
function wrapBase64(buf: Buffer): string {
  return (buf.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

export interface Attachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: Attachment[];
  /** Address to show as From/Reply-To; defaults to the connected mailbox. */
  from?: string | null;
  /** Gmail thread to send inside — keeps follow-ups in the PO's conversation. */
  threadId?: string | null;
  /** RFC 822 Message-ID being replied to, so the VENDOR's client threads it too. */
  inReplyTo?: string | null;
}

/**
 * Build an RFC 2822 message: multipart/mixed wrapping a multipart/alternative
 * text+html body plus any attachments. Gmail wants this base64url encoded.
 */
export function buildMime(mail: OutgoingMail): string {
  const boundaryMixed = `mixed_${crypto.randomBytes(12).toString("hex")}`;
  const boundaryAlt = `alt_${crypto.randomBytes(12).toString("hex")}`;
  const headers = [
    mail.from ? `From: ${mail.from}` : null,
    `To: ${mail.to.join(", ")}`,
    mail.cc?.length ? `Cc: ${mail.cc.join(", ")}` : null,
    `Subject: ${encodeHeader(mail.subject)}`,
    mail.inReplyTo ? `In-Reply-To: ${mail.inReplyTo}` : null,
    mail.inReplyTo ? `References: ${mail.inReplyTo}` : null,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
  ].filter(Boolean);

  const parts: string[] = [
    headers.join("\r\n"),
    "",
    `--${boundaryMixed}`,
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    "",
    `--${boundaryAlt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(mail.text, "utf8")),
  ];
  if (mail.html) {
    parts.push(
      "",
      `--${boundaryAlt}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(mail.html, "utf8")),
    );
  }
  parts.push("", `--${boundaryAlt}--`);

  for (const a of mail.attachments ?? []) {
    parts.push(
      "",
      `--${boundaryMixed}`,
      `Content-Type: ${a.mimeType}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(a.content),
    );
  }
  parts.push("", `--${boundaryMixed}--`, "");
  return parts.join("\r\n");
}

/**
 * Send one message through the Gmail API as the connected mailbox. Returns the
 * Gmail message + thread ids so a send can be traced back in the Sent folder.
 */
export async function sendMail(mail: OutgoingMail): Promise<{ id: string; threadId: string }> {
  if (mail.to.length === 0) throw new Error("No recipient — add vendor To addresses in Configuration.");
  const token = await accessToken();
  const raw = Buffer.from(buildMime(mail), "utf8").toString("base64url");
  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(mail.threadId ? { raw, threadId: mail.threadId } : { raw }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    threadId?: string;
    error?: { message?: string };
  };
  if (!res.ok) {
    const detail = json.error?.message ?? `HTTP ${res.status}`;
    logger.error({ status: res.status, detail }, "Gmail send failed");
    throw new Error(`Gmail rejected the message: ${detail}`);
  }
  return { id: json.id ?? "", threadId: json.threadId ?? "" };
}

// --- reading (PO follow-up agent) --------------------------------------------
// These are the ONLY reads this codebase performs: PO threads by id, and
// PO-number searches scoped to a vendor's domains. Nothing else in the mailbox
// is ever fetched.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmailGet<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const token = await accessToken();
  const qs = params
    ? "?" +
      Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const res = await fetch(`${API}${path}${qs}`, { headers: { authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Gmail read failed (${res.status}): ${json.error?.message ?? path}`);
  return json;
}

interface GmailPayloadPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPayloadPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: GmailPayloadPart;
}

export function header(msg: GmailMessage, name: string): string | null {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

/** Best-effort plain text of a message: text/plain part, else de-tagged HTML. */
export function bodyText(msg: GmailMessage): string {
  const chunks: { mime: string; text: string }[] = [];
  const walk = (p?: GmailPayloadPart): void => {
    if (!p) return;
    if (p.body?.data && (p.mimeType === "text/plain" || p.mimeType === "text/html")) {
      chunks.push({ mime: p.mimeType, text: Buffer.from(p.body.data, "base64url").toString("utf8") });
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(msg.payload);
  const plain = chunks.find((c) => c.mime === "text/plain")?.text;
  if (plain) return plain;
  const html = chunks.find((c) => c.mime === "text/html")?.text ?? "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** File attachments on a message (skips inline images without filenames). */
export function attachmentParts(msg: GmailMessage): { filename: string; mimeType: string; attachmentId: string; size: number }[] {
  const out: { filename: string; mimeType: string; attachmentId: string; size: number }[] = [];
  const walk = (p?: GmailPayloadPart): void => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      out.push({
        filename: p.filename,
        mimeType: p.mimeType ?? "application/octet-stream",
        attachmentId: p.body.attachmentId,
        size: p.body.size ?? 0,
      });
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(msg.payload);
  return out;
}

export async function fetchThreadMessages(threadId: string): Promise<GmailMessage[]> {
  const t = await gmailGet<{ messages?: GmailMessage[] }>(`/threads/${threadId}`, { format: "full" });
  return t.messages ?? [];
}

export async function fetchMessage(id: string): Promise<GmailMessage> {
  return gmailGet<GmailMessage>(`/messages/${id}`, { format: "full" });
}

/** Gmail search — used only with PO-number + vendor-domain queries. */
export async function searchMessageIds(q: string, maxResults = 20): Promise<{ id: string; threadId: string }[]> {
  const r = await gmailGet<{ messages?: { id: string; threadId: string }[] }>(`/messages`, { q, maxResults });
  return r.messages ?? [];
}

export async function fetchAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
  const r = await gmailGet<{ data?: string }>(`/messages/${messageId}/attachments/${attachmentId}`);
  return Buffer.from(r.data ?? "", "base64url");
}
