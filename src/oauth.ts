import type { Context } from "hono";

import { clearCookie, getCookie, setCookie } from "./cookies";
import type { Account, AppEnv, Session, TokenResponse } from "./types";

const STATE_COOKIE = "cf_oauth_state";
const SESSION_COOKIE = "gsv_deploy_session";
const STATE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 60;

export type TokenAuthMethod = "client_secret_post" | "client_secret_basic";

export async function startLogin(c: Context<AppEnv>): Promise<Response> {
  const state = randomToken();
  await c.env.SESSIONS.put(`oauth-state:${state}`, "1", {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const url = new URL("https://dash.cloudflare.com/oauth2/auth");
  url.searchParams.set("client_id", c.env.CF_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl(c));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", c.env.OAUTH_SCOPES);
  url.searchParams.set("state", state);

  return redirectWithCookies(url.toString(), [
    setCookie(STATE_COOKIE, state, STATE_TTL_SECONDS),
  ]);
}

export async function handleCallback(c: Context<AppEnv>): Promise<Response> {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieState = getCookie(c.req.raw, STATE_COOKIE);

  if (!code || !state || !cookieState || state !== cookieState) {
    return textWithCookies("Invalid OAuth callback.", 400, [clearCookie(STATE_COOKIE)]);
  }

  const storedState = await c.env.SESSIONS.get(`oauth-state:${state}`);
  if (!storedState) {
    return textWithCookies("Expired OAuth state.", 400, [clearCookie(STATE_COOKIE)]);
  }

  await c.env.SESSIONS.delete(`oauth-state:${state}`);

  let token: TokenResponse;
  try {
    token = await exchangeCode(c, code);
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        message: "OAuth token exchange failed",
      }),
    );
    return textWithCookies("OAuth token exchange failed. Check Worker logs for details.", 502, [
      clearCookie(STATE_COOKIE),
    ]);
  }

  const sessionId = randomToken();
  const session: Session = { createdAt: new Date().toISOString(), token };
  await c.env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  const cookieValue = await signSessionId(c.env.SESSION_SECRET, sessionId);
  return redirectWithCookies("/deploy", [
    clearCookie(STATE_COOKIE),
    setCookie(SESSION_COOKIE, cookieValue, SESSION_TTL_SECONDS),
  ]);
}

export async function getSessionWithId(
  c: Context<AppEnv>,
): Promise<{ sessionId: string; session: Session } | null> {
  const cookieValue = getCookie(c.req.raw, SESSION_COOKIE);
  if (!cookieValue) return null;

  const sessionId = await verifySessionCookie(c.env.SESSION_SECRET, cookieValue);
  if (!sessionId) return null;

  const raw = await c.env.SESSIONS.get(`session:${sessionId}`);
  if (!raw) return null;

  try {
    return { sessionId, session: JSON.parse(raw) as Session };
  } catch {
    return null;
  }
}

export async function requireSession(c: Context<AppEnv>): Promise<{
  sessionId: string;
  session: Session;
}> {
  const session = await getSessionWithId(c);
  if (!session) throw new Error("AUTH_REQUIRED");
  return session;
}

export async function logout(c: Context<AppEnv>): Promise<Response> {
  const current = await getSessionWithId(c);
  if (current) {
    await revokeToken(current.session.token.access_token);
    await c.env.SESSIONS.delete(`session:${current.sessionId}`);
  }
  return redirectWithCookies("/", [clearCookie(SESSION_COOKIE)]);
}

export async function fetchAccounts(accessToken: string): Promise<Account[]> {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return [];

  const body = (await response.json()) as { success?: boolean; result?: Account[] };
  return body.success && Array.isArray(body.result) ? body.result : [];
}

function callbackUrl(c: Context<AppEnv>): string {
  return `${c.env.APP_ORIGIN.replace(/\/$/, "")}/oauth/callback`;
}

function redirectWithCookies(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function textWithCookies(body: string, status: number, cookies: string[]): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(body, { status, headers });
}

async function exchangeCode(c: Context<AppEnv>, code: string): Promise<TokenResponse> {
  const request = buildTokenRequest({
    clientId: c.env.CF_OAUTH_CLIENT_ID,
    clientSecret: c.env.CF_OAUTH_CLIENT_SECRET,
    code,
    method: resolveTokenAuthMethod(c.env.OAUTH_TOKEN_AUTH_METHOD),
    redirectUri: callbackUrl(c),
  });

  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: request.headers,
    body: request.body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OAuth token exchange failed with ${response.status}: ${errorBody.slice(0, 500)}`);
  }

  return response.json<TokenResponse>();
}

export function resolveTokenAuthMethod(value: string | undefined): TokenAuthMethod {
  return value === "client_secret_basic" ? "client_secret_basic" : "client_secret_post";
}

export function buildTokenRequest(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  method: TokenAuthMethod;
  redirectUri: string;
}): { body: URLSearchParams; headers: Record<string, string> } {
  const body = new URLSearchParams({
    code: params.code,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (params.method === "client_secret_basic") {
    headers.Authorization = basicAuthHeader(params.clientId, params.clientSecret);
  } else {
    body.set("client_id", params.clientId);
    body.set("client_secret", params.clientSecret);
  }

  return { body, headers };
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const encoded = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${btoa(encoded)}`;
}

async function revokeToken(token: string): Promise<void> {
  await fetch("https://dash.cloudflare.com/oauth2/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function signSessionId(secret: string, sessionId: string): Promise<string> {
  const signature = await hmac(secret, sessionId);
  return `${sessionId}.${signature}`;
}

async function verifySessionCookie(secret: string, cookieValue: string): Promise<string | null> {
  const separator = cookieValue.lastIndexOf(".");
  if (separator <= 0) return null;

  const sessionId = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  const expected = await hmac(secret, sessionId);

  return timingSafeEqual(signature, expected) ? sessionId : null;
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64url(signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function base64url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
