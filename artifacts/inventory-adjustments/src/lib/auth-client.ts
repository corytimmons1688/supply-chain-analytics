import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";

/**
 * Client for the shared self-hosted Better Auth server, reached through THIS
 * app's own /api/auth reverse proxy (same-origin — never direct, the auth
 * server 403s untrusted browser Origins). Sessions ride a bearer token from
 * the `set-auth-token` response header, persisted in localStorage, because
 * the auth cookie belongs to the auth server's origin, not ours.
 */

const AUTH_TOKEN_KEY = "sca-auth-token";
let authToken: string | null = localStorage.getItem(AUTH_TOKEN_KEY);

export function getAuthToken(): string | null {
  return authToken;
}

export function clearAuthToken(): void {
  authToken = null;
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

export const authClient = createAuthClient({
  // Same-origin base URL — goes through this app's proxy. Includes the Vite
  // base path in case the app is ever served under one.
  baseURL: `${window.location.origin}${import.meta.env.BASE_URL}api/auth`,
  fetchOptions: {
    credentials: "include",
    auth: { type: "Bearer", token: () => authToken ?? undefined },
    onSuccess(ctx) {
      const token = ctx.response.headers.get("set-auth-token");
      if (token) {
        authToken = token;
        localStorage.setItem(AUTH_TOKEN_KEY, token);
      }
    },
  },
  plugins: [
    inferAdditionalFields({
      user: { role: { type: "string", input: false } },
    }),
  ],
});

/** Sign out on the server, drop the token, land on the login page. */
export async function signOutEverywhere(): Promise<void> {
  try {
    await authClient.signOut();
  } catch {
    // Auth server unreachable — still drop the local session.
  }
  clearAuthToken();
  window.location.assign(`${import.meta.env.BASE_URL}login`);
}

/** fetch() with the bearer token attached — for the few non-orval API calls. */
export function authorizedFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (authToken && !headers.has("authorization")) headers.set("authorization", `Bearer ${authToken}`);
  return fetch(input, { ...init, headers });
}

/**
 * Download/open a protected API URL. Plain <a href> can't carry an
 * Authorization header, so fetch as a blob and hand the browser an object URL.
 */
export async function openAuthorizedUrl(url: string, filename?: string): Promise<void> {
  const res = await authorizedFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  if (filename) a.download = filename;
  else a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
