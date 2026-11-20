// Linking an X account to a minted agent: OAuth 2.0 authorization code with PKCE. The owner
// signs in at X and approves; we keep the tokens encrypted (AES-256-GCM, key from the
// environment) so the agent can post as that account when the operator turns posting on.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_API = "https://api.x.com";
export const X_SCOPES = ["tweet.read", "users.read", "tweet.write", "offline.access"];

export interface XTokens {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms. */
  expiresAt: number;
}

export interface XApp {
  clientId: string;
  /** Set for a confidential client; a public client sends only the client id. */
  clientSecret?: string;
  redirectUri: string;
}

const b64url = (b: Buffer) => b.toString("base64url");

export const newVerifier = () => b64url(randomBytes(32));
export const challengeOf = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

export function authorizeUrl(app: XApp, state: string, verifier: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    scope: X_SCOPES.join(" "),
    state,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
  });
  return `${X_AUTHORIZE_URL}?${q.toString()}`;
}

async function tokenRequest(app: XApp, form: Record<string, string>, fetcher: typeof fetch, now: number): Promise<XTokens> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const body = new URLSearchParams(form);
  if (app.clientSecret) headers.authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
  else body.set("client_id", app.clientId);
  const res = await fetcher(`${X_API}/2/oauth2/token`, { method: "POST", headers, body: body.toString() });
  if (!res.ok) throw new Error(`X token request failed (${res.status})`);
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("X returned no access token");
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: now + (j.expires_in ?? 7200) * 1000 };
}

export const exchangeCode = (app: XApp, code: string, verifier: string, fetcher: typeof fetch = fetch, now = Date.now()) =>
  tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: app.redirectUri, code_verifier: verifier }, fetcher, now);

export const refreshTokens = (app: XApp, refreshToken: string, fetcher: typeof fetch = fetch, now = Date.now()) =>
  tokenRequest(app, { grant_type: "refresh_token", refresh_token: refreshToken }, fetcher, now);

/** The account behind an access token. */
export async function xMe(accessToken: string, fetcher: typeof fetch = fetch): Promise<{ id: string; handle: string }> {
  const res = await fetcher(`${X_API}/2/users/me`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`X account lookup failed (${res.status})`);
  const j = (await res.json()) as { data?: { id?: string; username?: string } };
  if (!j.data?.id || !j.data.username) throw new Error("X returned no account");
  return { id: j.data.id, handle: j.data.username };
}

export async function xPost(accessToken: string, text: string, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(`${X_API}/2/tweets`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 280) }) });
  if (!res.ok) throw new Error(`X post failed (${res.status})`);
  const j = (await res.json()) as { data?: { id?: string } };
  return j.data?.id ?? "";
}

/** Best effort: tells X to forget a token when an owner unlinks. */
export async function xRevoke(app: XApp, token: string, fetcher: typeof fetch = fetch): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const body = new URLSearchParams({ token });
  if (app.clientSecret) headers.authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
  else body.set("client_id", app.clientId);
  await fetcher(`${X_API}/2/oauth2/revoke`, { method: "POST", headers, body: body.toString() }).catch(() => {});
}

const keyOf = (secret: string) => createHash("sha256").update(secret).digest();

/** iv.tag.ciphertext, each base64url. */
export function seal(secret: string, value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map(b64url).join(".");
}

export function unseal<T>(secret: string, sealed: string): T {
  const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !data) throw new Error("malformed sealed value");
  const d = createDecipheriv("aes-256-gcm", keyOf(secret), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8")) as T;
}
