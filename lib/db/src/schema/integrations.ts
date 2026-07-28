import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * OAuth refresh tokens for outbound integrations, one row per provider.
 *
 * Only the long-lived refresh token is stored — access tokens are minted per
 * request and never persisted. The client id/secret stay in env vars so the
 * database never holds enough on its own to mint a token.
 */
export const oauthCredentialTable = pgTable("oauth_credential", {
  provider: text("provider").primaryKey(), // "gmail"
  refreshToken: text("refresh_token").notNull(),
  /** The mailbox that consented — shown in Configuration so it's clear who PO email comes from. */
  accountEmail: text("account_email"),
  /** Granted scopes as returned by Google, for diagnosing a partial consent. */
  scope: text("scope"),
  connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type OauthCredentialRow = typeof oauthCredentialTable.$inferSelect;
